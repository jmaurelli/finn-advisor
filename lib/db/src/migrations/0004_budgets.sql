CREATE TABLE budget_plans (
  category_id TEXT PRIMARY KEY NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0)
) STRICT;
CREATE TRIGGER budget_plans_eligible BEFORE INSERT ON budget_plans
WHEN NOT EXISTS (SELECT 1 FROM categories WHERE id = NEW.category_id AND system_kind IS NULL AND archived_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'budget requires an active expense category'); END;
CREATE TRIGGER budget_plans_preserve_identity BEFORE UPDATE ON budget_plans
WHEN NEW.category_id <> OLD.category_id OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'budget identity cannot be changed'); END;
CREATE TRIGGER budget_plans_no_delete BEFORE DELETE ON budget_plans
BEGIN SELECT RAISE(ABORT, 'budget plans must be stopped, not deleted'); END;

CREATE TABLE budget_schedule (
  category_id TEXT NOT NULL REFERENCES budget_plans (category_id) ON DELETE RESTRICT,
  month TEXT NOT NULL CHECK (month || '-01' IS strftime('%Y-%m-%d', month || '-01') AND month BETWEEN '1900-01' AND '2999-12'),
  state TEXT NOT NULL CHECK (state IN ('amount', 'stopped')),
  amount_cents INTEGER,
  PRIMARY KEY (category_id, month),
  CHECK ((state = 'amount' AND amount_cents IS NOT NULL AND amount_cents >= 0 AND amount_cents < 100000000000)
    OR (state = 'stopped' AND amount_cents IS NULL))
) STRICT;
CREATE TABLE budget_exceptions (
  category_id TEXT NOT NULL REFERENCES budget_plans (category_id) ON DELETE RESTRICT,
  month TEXT NOT NULL CHECK (month || '-01' IS strftime('%Y-%m-%d', month || '-01') AND month BETWEEN '1900-01' AND '2999-12'),
  state TEXT NOT NULL CHECK (state IN ('amount', 'skip')),
  amount_cents INTEGER,
  PRIMARY KEY (category_id, month),
  CHECK ((state = 'amount' AND amount_cents IS NOT NULL AND amount_cents >= 0 AND amount_cents < 100000000000)
    OR (state = 'skip' AND amount_cents IS NULL))
) STRICT;

-- Archive impact has a tighter bound (1,000) than budget previews (1,200).
-- At capacity the final regular entry must already stop recurrence, so every
-- subsequent archive can stop without needing an additional retained marker.
CREATE TRIGGER budget_schedule_capacity AFTER INSERT ON budget_schedule
WHEN (SELECT COUNT(*) FROM budget_schedule WHERE category_id = NEW.category_id)
  + (SELECT COUNT(*) FROM budget_exceptions WHERE category_id = NEW.category_id) >
  CASE WHEN (SELECT state FROM budget_schedule WHERE category_id = NEW.category_id ORDER BY month DESC LIMIT 1) = 'stopped' THEN 1000 ELSE 999 END
BEGIN SELECT RAISE(ABORT, 'budget configuration capacity exceeded'); END;
CREATE TRIGGER budget_exceptions_capacity AFTER INSERT ON budget_exceptions
WHEN (SELECT COUNT(*) FROM budget_schedule WHERE category_id = NEW.category_id)
  + (SELECT COUNT(*) FROM budget_exceptions WHERE category_id = NEW.category_id) >
  CASE WHEN (SELECT state FROM budget_schedule WHERE category_id = NEW.category_id ORDER BY month DESC LIMIT 1) = 'stopped' THEN 1000 ELSE 999 END
BEGIN SELECT RAISE(ABORT, 'budget configuration capacity exceeded'); END;
CREATE TRIGGER budget_schedule_update_capacity AFTER UPDATE ON budget_schedule
WHEN (SELECT COUNT(*) FROM budget_schedule WHERE category_id = NEW.category_id)
  + (SELECT COUNT(*) FROM budget_exceptions WHERE category_id = NEW.category_id) >
  CASE WHEN (SELECT state FROM budget_schedule WHERE category_id = NEW.category_id ORDER BY month DESC LIMIT 1) = 'stopped' THEN 1000 ELSE 999 END
BEGIN SELECT RAISE(ABORT, 'budget configuration capacity exceeded'); END;
CREATE TRIGGER budget_exceptions_update_capacity AFTER UPDATE ON budget_exceptions
WHEN (SELECT COUNT(*) FROM budget_schedule WHERE category_id = NEW.category_id)
  + (SELECT COUNT(*) FROM budget_exceptions WHERE category_id = NEW.category_id) >
  CASE WHEN (SELECT state FROM budget_schedule WHERE category_id = NEW.category_id ORDER BY month DESC LIMIT 1) = 'stopped' THEN 1000 ELSE 999 END
BEGIN SELECT RAISE(ABORT, 'budget configuration capacity exceeded'); END;
CREATE TRIGGER budget_schedule_preserve_identity BEFORE UPDATE ON budget_schedule
WHEN NEW.category_id <> OLD.category_id OR NEW.month <> OLD.month
BEGIN SELECT RAISE(ABORT, 'replace budget entries rather than moving them'); END;
CREATE TRIGGER budget_exceptions_preserve_identity BEFORE UPDATE ON budget_exceptions
WHEN NEW.category_id <> OLD.category_id OR NEW.month <> OLD.month
BEGIN SELECT RAISE(ABORT, 'replace budget entries rather than moving them'); END;

CREATE TRIGGER budget_schedule_active_insert BEFORE INSERT ON budget_schedule
WHEN (SELECT archived_at FROM categories WHERE id = NEW.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'archived category budget cannot be changed'); END;
CREATE TRIGGER budget_schedule_active_update BEFORE UPDATE ON budget_schedule
WHEN (SELECT archived_at FROM categories WHERE id = OLD.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'archived category budget cannot be changed'); END;
CREATE TRIGGER budget_schedule_active_delete BEFORE DELETE ON budget_schedule
WHEN (SELECT archived_at FROM categories WHERE id = OLD.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'archived category budget cannot be changed'); END;
CREATE TRIGGER budget_exceptions_active_insert BEFORE INSERT ON budget_exceptions
WHEN (SELECT archived_at FROM categories WHERE id = NEW.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'archived category budget cannot be changed'); END;
CREATE TRIGGER budget_exceptions_active_update BEFORE UPDATE ON budget_exceptions
WHEN (SELECT archived_at FROM categories WHERE id = OLD.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'archived category budget cannot be changed'); END;
CREATE TRIGGER budget_exceptions_active_delete BEFORE DELETE ON budget_exceptions
WHEN (SELECT archived_at FROM categories WHERE id = OLD.category_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'archived category budget cannot be changed'); END;
CREATE TRIGGER categories_stop_budget_before_archive BEFORE UPDATE OF archived_at, archive_cutoff_month ON categories
WHEN NEW.archived_at IS NOT NULL AND EXISTS (SELECT 1 FROM budget_plans WHERE category_id = NEW.id) AND (
  NEW.archive_cutoff_month IS NULL
  OR (SELECT state FROM budget_schedule WHERE category_id = NEW.id AND month <= NEW.archive_cutoff_month ORDER BY month DESC LIMIT 1) = 'amount'
  OR EXISTS (SELECT 1 FROM budget_schedule WHERE category_id = NEW.id AND month > NEW.archive_cutoff_month AND state = 'amount')
  OR EXISTS (SELECT 1 FROM budget_exceptions WHERE category_id = NEW.id AND month >= NEW.archive_cutoff_month)
)
BEGIN SELECT RAISE(ABORT, 'stop budget before archiving category'); END;

CREATE TABLE budget_previews (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  category_id TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json) AND json_type(preview_json) = 'object'),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json) AND json_type(dependencies_json) = 'object'),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400000),
  applied_at INTEGER CHECK (applied_at IS NULL OR applied_at >= created_at),
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND json_type(result_json) = 'object')),
  CHECK ((applied_at IS NULL) = (result_json IS NULL))
) STRICT;
CREATE INDEX budget_previews_category ON budget_previews (category_id, id);
CREATE TRIGGER budget_previews_preserve_review BEFORE UPDATE ON budget_previews
WHEN NEW.id <> OLD.id OR NEW.category_id <> OLD.category_id OR NEW.preview_json <> OLD.preview_json
  OR NEW.dependencies_json <> OLD.dependencies_json OR NEW.created_at <> OLD.created_at
  OR NEW.expires_at <> OLD.expires_at OR OLD.applied_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'budget review and completed result cannot be changed'); END;
CREATE TRIGGER budget_previews_no_delete BEFORE DELETE ON budget_previews
BEGIN SELECT RAISE(ABORT, 'budget reviews cannot be removed'); END;

CREATE TABLE audit_events_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  command_id TEXT CHECK (command_id IS NULL OR length(command_id) = 36),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('account', 'transaction', 'category', 'checkpoint', 'rule', 'rule_run', 'repair', 'transfer_pair', 'refund_link', 'budget')),
  entity_id TEXT NOT NULL CHECK (length(entity_id) = 36),
  account_id TEXT CHECK (account_id IS NULL OR length(account_id) = 36),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 60),
  origin TEXT NOT NULL CHECK (origin IN ('owner', 'import', 'system', 'rule_run')),
  reason TEXT CHECK (reason IS NULL OR codepoint_length(reason) <= 500),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0)
) STRICT;
INSERT INTO audit_events_new SELECT * FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_new RENAME TO audit_events;
CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_account ON audit_events (account_id, occurred_at DESC);
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events cannot be changed'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit events cannot be removed'); END;

UPDATE ledger_metadata SET schema_version = 4 WHERE id = 1;
