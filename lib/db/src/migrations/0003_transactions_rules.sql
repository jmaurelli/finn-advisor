-- Existing rule-origin rows have no recoverable attribution in schema 2.
-- Refuse the upgrade rather than invent a rule or silently remove attribution.
CREATE TABLE stage3_attribution_gate (
  unrecoverable_rule_assignments INTEGER NOT NULL
    CONSTRAINT stage3_requires_recoverable_rule_attribution CHECK (unrecoverable_rule_assignments = 0)
) STRICT;
INSERT INTO stage3_attribution_gate SELECT COUNT(*) FROM transactions WHERE assignment_origin = 'rule';
DROP TABLE stage3_attribution_gate;

-- Lowercasing can expand a valid 60-character name. Bound the source, not its key.
CREATE TABLE categories_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  display_name TEXT NOT NULL CHECK (codepoint_length(display_name) BETWEEN 1 AND 60 AND trim(display_name) <> ''),
  normalized_name TEXT NOT NULL UNIQUE CHECK (codepoint_length(normalized_name) > 0),
  description TEXT CHECK (description IS NULL OR codepoint_length(description) <= 280),
  color TEXT NOT NULL CHECK (color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  system_kind TEXT CHECK (system_kind IS NULL OR system_kind IN ('income', 'uncategorized')),
  protected INTEGER NOT NULL CHECK (protected IN (0, 1)),
  archived_at INTEGER CHECK (archived_at IS NULL OR archived_at > 0),
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  creation_digest TEXT CHECK (creation_digest IS NULL OR length(creation_digest) = 64),
  archive_cutoff_month TEXT CHECK (archive_cutoff_month IS NULL OR (
    archive_cutoff_month || '-01' IS strftime('%Y-%m-%d', archive_cutoff_month || '-01')
    AND archive_cutoff_month BETWEEN '1900-01' AND '2999-12'
  )),
  CHECK ((protected = 1) = (system_kind IS NOT NULL)),
  CHECK (protected = 0 OR archived_at IS NULL)
) STRICT;
INSERT INTO categories_new (
  id, display_name, normalized_name, description, color, system_kind, protected,
  archived_at, version, created_at, updated_at
) SELECT id, display_name, normalized_name, description, color, system_kind, protected,
  archived_at, version, created_at, updated_at FROM categories;
DROP TRIGGER categories_protected_no_delete;
DROP TABLE categories;
ALTER TABLE categories_new RENAME TO categories;
CREATE UNIQUE INDEX categories_system_kind ON categories (system_kind) WHERE system_kind IS NOT NULL;
CREATE TRIGGER categories_protected_no_update BEFORE UPDATE ON categories
WHEN OLD.protected = 1 AND (
  NEW.id <> OLD.id OR NEW.display_name <> OLD.display_name OR NEW.normalized_name <> OLD.normalized_name
  OR NEW.system_kind IS NOT OLD.system_kind OR NEW.protected <> OLD.protected
  OR NEW.archived_at IS NOT OLD.archived_at
)
BEGIN SELECT RAISE(ABORT, 'protected category cannot be renamed, re-identified, archived or unprotected'); END;
CREATE TRIGGER categories_protected_no_delete BEFORE DELETE ON categories WHEN OLD.protected = 1
BEGIN SELECT RAISE(ABORT, 'protected category cannot be deleted'); END;

CREATE TABLE rules (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  position INTEGER UNIQUE CHECK (position > 0),
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision < 1000000000000000000),
  archived_at INTEGER CHECK (archived_at IS NULL OR archived_at > 0),
  creation_digest TEXT NOT NULL CHECK (length(creation_digest) = 64),
  creation_result_json TEXT CHECK (creation_result_json IS NULL OR json_valid(creation_result_json)),
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK ((archived_at IS NULL) = (position IS NOT NULL)),
  FOREIGN KEY (id, revision) REFERENCES rule_revisions (rule_id, revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE rule_revisions (
  rule_id TEXT NOT NULL REFERENCES rules (id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision < 1000000000000000000),
  change TEXT NOT NULL CHECK (change IN ('created', 'edited', 'enabled', 'disabled', 'retargeted', 'archived')),
  match_type TEXT NOT NULL CHECK (match_type IN ('contains', 'exact')),
  pattern TEXT NOT NULL CHECK (codepoint_length(pattern) BETWEEN 1 AND 256 AND trim(pattern) <> ''),
  normalized_pattern TEXT NOT NULL CHECK (codepoint_length(normalized_pattern) > 0),
  account_id TEXT REFERENCES accounts (id) ON DELETE RESTRICT,
  applies_to TEXT NOT NULL CHECK (applies_to IN ('purchases_and_refunds', 'purchases', 'refunds')),
  category_id TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  category_name TEXT NOT NULL CHECK (codepoint_length(category_name) BETWEEN 1 AND 60),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  changed_at INTEGER NOT NULL CHECK (changed_at > 0),
  PRIMARY KEY (rule_id, revision)
) STRICT;

CREATE INDEX rule_revisions_account ON rule_revisions (account_id, rule_id);
CREATE INDEX rule_revisions_category ON rule_revisions (category_id, rule_id);

CREATE TRIGGER rule_revisions_valid_target BEFORE INSERT ON rule_revisions
WHEN NOT EXISTS (
  SELECT 1 FROM categories WHERE id = NEW.category_id AND system_kind IS NULL
    AND (NEW.enabled = 0 OR archived_at IS NULL)
)
BEGIN SELECT RAISE(ABORT, 'rule requires an eligible expense category'); END;

CREATE TRIGGER rules_valid_current_revision BEFORE UPDATE OF revision, archived_at ON rules
WHEN NEW.archived_at IS NULL AND EXISTS (
  SELECT 1 FROM rule_revisions r JOIN categories c ON c.id = r.category_id
  WHERE r.rule_id = NEW.id AND r.revision = NEW.revision AND r.enabled = 1 AND c.archived_at IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'enabled rule cannot target an archived category'); END;

CREATE TRIGGER categories_resolve_rules_before_archive BEFORE UPDATE OF archived_at ON categories
WHEN NEW.archived_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM rules r JOIN rule_revisions v ON v.rule_id = r.id AND v.revision = r.revision
  WHERE r.archived_at IS NULL AND v.enabled = 1 AND v.category_id = NEW.id
)
BEGIN SELECT RAISE(ABORT, 'resolve enabled rules before archiving category'); END;

CREATE TRIGGER rule_revisions_no_update BEFORE UPDATE ON rule_revisions
BEGIN SELECT RAISE(ABORT, 'rule revisions cannot be changed'); END;
CREATE TRIGGER rule_revisions_no_delete BEFORE DELETE ON rule_revisions
BEGIN SELECT RAISE(ABORT, 'rule revisions cannot be removed'); END;

CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  posted_date TEXT NOT NULL CHECK (
    posted_date IS strftime('%Y-%m-%d', posted_date) AND posted_date BETWEEN '1900-01-01' AND '2999-12-31'
  ),
  merchant_text TEXT NOT NULL CHECK (codepoint_length(merchant_text) BETWEEN 1 AND 2000),
  normalized_text TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0 AND amount_cents > -100000000000 AND amount_cents < 100000000000),
  kind TEXT NOT NULL CHECK (kind IN ('purchase', 'refund', 'income', 'transfer')),
  category_id TEXT REFERENCES categories (id) ON DELETE RESTRICT,
  assignment_origin TEXT NOT NULL CHECK (assignment_origin IN ('manual', 'rule', 'unassigned', 'system')),
  assigned_at INTEGER NOT NULL CHECK (assigned_at > 0),
  rule_id TEXT,
  rule_revision INTEGER,
  note TEXT CHECK (note IS NULL OR codepoint_length(note) <= 1000),
  -- Search form of the note, written with it. NULL for legacy rows, which search normalizes on read.
  normalized_note TEXT CHECK (normalized_note IS NULL OR note IS NOT NULL),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'void')),
  voided_at INTEGER CHECK (voided_at IS NULL OR voided_at > 0),
  original_posted_date TEXT NOT NULL CHECK (
    original_posted_date IS strftime('%Y-%m-%d', original_posted_date)
    AND original_posted_date BETWEEN '1900-01-01' AND '2999-12-31'
  ),
  original_amount_cents INTEGER NOT NULL CHECK (
    original_amount_cents <> 0 AND original_amount_cents > -100000000000 AND original_amount_cents < 100000000000
  ),
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  CHECK (kind <> 'purchase' OR amount_cents < 0),
  CHECK (kind <> 'refund' OR amount_cents > 0),
  CHECK (kind <> 'income' OR amount_cents > 0),
  CHECK (kind <> 'transfer' OR (category_id IS NULL AND assignment_origin = 'system')),
  CHECK (kind = 'transfer' OR category_id IS NOT NULL),
  CHECK ((category_id = '30000000-0000-4000-8000-000000000001') = (kind = 'income')),
  CHECK (kind <> 'income' OR assignment_origin = 'system'),
  CHECK (kind NOT IN ('purchase', 'refund') OR assignment_origin IN ('manual', 'rule', 'unassigned')),
  CHECK (assignment_origin <> 'unassigned' OR category_id = '30000000-0000-4000-8000-000000000000'),
  CHECK ((assignment_origin = 'rule' AND rule_id IS NOT NULL AND rule_revision IS NOT NULL)
    OR (assignment_origin <> 'rule' AND rule_id IS NULL AND rule_revision IS NULL)),
  CHECK ((lifecycle = 'void') = (voided_at IS NOT NULL)),
  FOREIGN KEY (rule_id, rule_revision) REFERENCES rule_revisions (rule_id, revision) ON DELETE RESTRICT
) STRICT;

-- Schema 2 had no assignment/void event timestamp. updated_at is an explicit
-- legacy backfill, not a reconstructed event. No history event is invented.
INSERT INTO transactions_new (
  id, account_id, posted_date, merchant_text, normalized_text, amount_cents, kind,
  category_id, assignment_origin, assigned_at, note, lifecycle, voided_at,
  original_posted_date, original_amount_cents, version, created_at, updated_at
)
SELECT id, account_id, posted_date, merchant_text, normalized_text, amount_cents, kind,
  category_id, assignment_origin, updated_at, note, lifecycle,
  CASE WHEN lifecycle = 'void' THEN updated_at ELSE NULL END,
  posted_date, amount_cents, version, created_at, updated_at FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX transactions_posted_date ON transactions (posted_date DESC, id DESC);
CREATE INDEX transactions_account_posted ON transactions (account_id, posted_date DESC, id DESC);
CREATE INDEX transactions_category_posted ON transactions (category_id, posted_date DESC, id DESC);
CREATE INDEX transactions_rule ON transactions (rule_id, lifecycle);

CREATE TRIGGER transactions_archived_no_insert BEFORE INSERT ON transactions
WHEN (SELECT archived_at FROM accounts WHERE id = NEW.account_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'archived account: reactivate it before adding transactions'); END;

CREATE TRIGGER transactions_archived_no_financial_change BEFORE UPDATE ON transactions
WHEN (
  (SELECT archived_at FROM accounts WHERE id = OLD.account_id) IS NOT NULL
  OR (SELECT archived_at FROM accounts WHERE id = NEW.account_id) IS NOT NULL
) AND (
  NEW.account_id <> OLD.account_id OR NEW.posted_date <> OLD.posted_date
  OR NEW.amount_cents <> OLD.amount_cents OR NEW.kind <> OLD.kind OR NEW.lifecycle <> OLD.lifecycle
)
BEGIN SELECT RAISE(ABORT, 'archived account: reactivate it before this repair'); END;

CREATE TRIGGER transactions_preserve_evidence BEFORE UPDATE ON transactions
WHEN NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id OR NEW.merchant_text <> OLD.merchant_text
  OR NEW.original_posted_date <> OLD.original_posted_date OR NEW.original_amount_cents <> OLD.original_amount_cents
  OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'transaction identity and original evidence cannot be changed'); END;

CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'transactions must be voided, not deleted'); END;

-- Deferred cyclic references require both slots at COMMIT, not merely at most
-- two legs. Deleting a pair removes its link rows, never its transactions.
CREATE TABLE transfer_pairs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  first_slot INTEGER NOT NULL DEFAULT 1 CHECK (first_slot = 1),
  second_slot INTEGER NOT NULL DEFAULT 2 CHECK (second_slot = 2),
  creation_digest TEXT NOT NULL CHECK (length(creation_digest) = 64),
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  FOREIGN KEY (id, first_slot) REFERENCES transfer_legs (pair_id, slot) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (id, second_slot) REFERENCES transfer_legs (pair_id, slot) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE transfer_legs (
  pair_id TEXT NOT NULL REFERENCES transfer_pairs (id) ON DELETE CASCADE,
  slot INTEGER NOT NULL CHECK (slot IN (1, 2)),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  PRIMARY KEY (pair_id, slot)
) STRICT;

CREATE TRIGGER transfer_legs_eligible BEFORE INSERT ON transfer_legs
WHEN NOT EXISTS (SELECT 1 FROM transactions WHERE id = NEW.transaction_id AND kind = 'transfer' AND lifecycle = 'active')
  OR EXISTS (
    SELECT 1 FROM transfer_legs l JOIN transactions other ON other.id = l.transaction_id
    JOIN transactions target ON target.id = NEW.transaction_id
    WHERE l.pair_id = NEW.pair_id AND (other.account_id = target.account_id OR other.amount_cents <> -target.amount_cents)
  )
BEGIN SELECT RAISE(ABORT, 'transfer legs must be active equal opposite transfers in different accounts'); END;

CREATE TRIGGER transfer_legs_no_update BEFORE UPDATE ON transfer_legs
BEGIN SELECT RAISE(ABORT, 'unlink a transfer pair before replacing its legs'); END;
CREATE TRIGGER transfer_pairs_no_update BEFORE UPDATE ON transfer_pairs
BEGIN SELECT RAISE(ABORT, 'transfer pairs cannot be changed; unlink and pair again'); END;

CREATE TRIGGER transactions_preserve_transfer BEFORE UPDATE ON transactions
WHEN EXISTS (SELECT 1 FROM transfer_legs WHERE transaction_id = OLD.id)
  AND (NEW.amount_cents <> OLD.amount_cents OR NEW.kind <> OLD.kind OR NEW.lifecycle <> OLD.lifecycle OR NEW.account_id <> OLD.account_id)
BEGIN SELECT RAISE(ABORT, 'unlink transfer before an invalidating change'); END;

CREATE TABLE refund_links (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  refund_id TEXT NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  purchase_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  creation_digest TEXT NOT NULL CHECK (length(creation_digest) = 64),
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK (refund_id <> purchase_id)
) STRICT;
CREATE INDEX refund_links_purchase ON refund_links (purchase_id);

CREATE TRIGGER refund_links_eligible BEFORE INSERT ON refund_links
WHEN NOT EXISTS (SELECT 1 FROM transactions WHERE id = NEW.refund_id AND kind = 'refund' AND lifecycle = 'active')
  OR NOT EXISTS (SELECT 1 FROM transactions WHERE id = NEW.purchase_id AND kind = 'purchase' AND lifecycle = 'active')
BEGIN SELECT RAISE(ABORT, 'refund link requires an active refund and purchase'); END;
CREATE TRIGGER refund_links_no_update BEFORE UPDATE ON refund_links
BEGIN SELECT RAISE(ABORT, 'refund links cannot be changed; unlink and link again'); END;
CREATE TRIGGER transactions_preserve_refund BEFORE UPDATE ON transactions
WHEN EXISTS (SELECT 1 FROM refund_links WHERE refund_id = OLD.id OR purchase_id = OLD.id)
  AND (NEW.kind <> OLD.kind OR NEW.lifecycle <> OLD.lifecycle)
BEGIN SELECT RAISE(ABORT, 'unlink refunds before an invalidating change'); END;

CREATE TABLE audit_events_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  command_id TEXT CHECK (command_id IS NULL OR length(command_id) = 36),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('account', 'transaction', 'category', 'checkpoint', 'rule', 'rule_run', 'repair', 'transfer_pair', 'refund_link')),
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

CREATE TABLE assignment_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('imported', 'category_changed', 'returned_to_rules', 'kind_changed', 'note_changed', 'amount_corrected', 'date_corrected', 'voided', 'restored', 'transfer_linked', 'transfer_unlinked', 'refund_linked', 'refund_unlinked')),
  source TEXT NOT NULL CHECK (source IN ('owner', 'rule_run', 'import', 'system')),
  reason TEXT CHECK (reason IS NULL OR codepoint_length(reason) BETWEEN 1 AND 500),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  before_category_id TEXT REFERENCES categories (id) ON DELETE RESTRICT,
  after_category_id TEXT REFERENCES categories (id) ON DELETE RESTRICT,
  rule_id TEXT,
  rule_revision INTEGER,
  related_ids_json TEXT NOT NULL CHECK (json_valid(related_ids_json) AND json_type(related_ids_json) = 'array'),
  CHECK ((rule_id IS NULL) = (rule_revision IS NULL)),
  FOREIGN KEY (rule_id, rule_revision) REFERENCES rule_revisions (rule_id, revision) ON DELETE RESTRICT
) STRICT;
CREATE INDEX assignment_events_transaction ON assignment_events (transaction_id, occurred_at DESC, id DESC);
CREATE TRIGGER assignment_events_no_update BEFORE UPDATE ON assignment_events
BEGIN SELECT RAISE(ABORT, 'transaction history cannot be changed'); END;
CREATE TRIGGER assignment_events_no_delete BEFORE DELETE ON assignment_events
BEGIN SELECT RAISE(ABORT, 'transaction history cannot be removed'); END;

CREATE TABLE repair_previews (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json)),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400000),
  applied_at INTEGER CHECK (applied_at IS NULL OR applied_at > 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK ((applied_at IS NULL) = (result_json IS NULL))
) STRICT;
CREATE TRIGGER repair_previews_preserve_review BEFORE UPDATE ON repair_previews
WHEN NEW.id <> OLD.id OR NEW.transaction_id <> OLD.transaction_id OR NEW.preview_json <> OLD.preview_json
  OR NEW.dependencies_json <> OLD.dependencies_json OR NEW.created_at <> OLD.created_at
  OR NEW.expires_at <> OLD.expires_at OR OLD.applied_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'repair review and completed result cannot be changed'); END;
CREATE TRIGGER repair_previews_no_delete BEFORE DELETE ON repair_previews
BEGIN SELECT RAISE(ABORT, 'repair reviews cannot be removed'); END;

CREATE TABLE rule_runs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  preview_json TEXT NOT NULL CHECK (json_valid(preview_json)),
  rule_set_revision INTEGER NOT NULL CHECK (rule_set_revision >= 0 AND rule_set_revision < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at = created_at + 86400000),
  applied_at INTEGER CHECK (applied_at IS NULL OR applied_at > 0),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK ((applied_at IS NULL) = (result_json IS NULL))
) STRICT;
CREATE TABLE rule_run_rows (
  run_id TEXT NOT NULL REFERENCES rule_runs (id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  transaction_version INTEGER NOT NULL CHECK (transaction_version >= 1 AND transaction_version < 1000000000000000000),
  account_version INTEGER NOT NULL CHECK (account_version >= 1 AND account_version < 1000000000000000000),
  before_category_id TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  after_category_id TEXT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  row_json TEXT NOT NULL CHECK (json_valid(row_json)),
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  PRIMARY KEY (run_id, transaction_id)
) STRICT;
CREATE TRIGGER rule_runs_preserve_review BEFORE UPDATE ON rule_runs
WHEN NEW.id <> OLD.id OR NEW.preview_json <> OLD.preview_json OR NEW.rule_set_revision <> OLD.rule_set_revision
  OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at OR OLD.applied_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'rule review and completed result cannot be changed'); END;
CREATE TRIGGER rule_runs_no_delete BEFORE DELETE ON rule_runs
BEGIN SELECT RAISE(ABORT, 'rule reviews cannot be removed'); END;
CREATE TRIGGER rule_run_rows_no_update BEFORE UPDATE ON rule_run_rows
BEGIN SELECT RAISE(ABORT, 'rule run candidates cannot be changed'); END;
CREATE TRIGGER rule_run_rows_no_delete BEFORE DELETE ON rule_run_rows
BEGIN SELECT RAISE(ABORT, 'rule run candidates cannot be removed'); END;
CREATE TRIGGER rule_run_rows_before_apply BEFORE INSERT ON rule_run_rows
WHEN (SELECT applied_at FROM rule_runs WHERE id = NEW.run_id) IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'completed rule runs cannot gain candidates'); END;

UPDATE ledger_metadata SET schema_version = 3 WHERE id = 1;
