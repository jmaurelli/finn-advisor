-- Migration 0002: accounts, categories, transactions, reconciliation, audit.
--
-- This is the first migration with foreign keys, so it is also the first time
-- the runner's enforcement handling matters in production. Deletion of
-- anything financial is RESTRICTed: history must never disappear as a side
-- effect of removing something that references it.
--
-- Date columns use the validated pattern from the design: `IS`, not `=`. A
-- SQLite CHECK is satisfied when its expression is NULL, and strftime returns
-- NULL for an unparseable date, so `=` would silently accept '2026-13-01' and
-- 'not-a-date'. NOT NULL is load-bearing for the same reason.
--
-- Money is exact integer cents, bounded below 10^11 as a stored value.

CREATE TABLE accounts (
  id                  TEXT    PRIMARY KEY CHECK (length(id) = 36),
  kind                TEXT    NOT NULL CHECK (kind IN ('checking', 'savings', 'credit_card')),
  provider_key        TEXT    NOT NULL CHECK (provider_key IN (
                        'chase', 'campus_usa', 'bank_of_america', 'citibank',
                        'american_express', 'capital_one', 'discover',
                        'wells_fargo', 'other'
                      )),
  display_name        TEXT    NOT NULL CHECK (
                        length(display_name) BETWEEN 1 AND 80 AND trim(display_name) <> ''
                      ),
  -- Last four digits only: a full account number is never needed and never
  -- stored, so it cannot leak from a backup or an export.
  masked_suffix       TEXT             CHECK (
                        masked_suffix IS NULL OR masked_suffix GLOB '[0-9][0-9][0-9][0-9]'
                      ),
  tracking_start_date TEXT    NOT NULL CHECK (
                        tracking_start_date IS strftime('%Y-%m-%d', tracking_start_date)
                        AND tracking_start_date BETWEEN '1900-01-01' AND '2999-12-31'
                      ),
  -- The closing balance of the day before tracking_start_date.
  opening_cents       INTEGER NOT NULL CHECK (
                        opening_cents > -100000000000 AND opening_cents < 100000000000
                      ),
  archived_at         INTEGER          CHECK (archived_at IS NULL OR archived_at > 0),
  -- Fingerprint of the creating request: the same id with the same content is
  -- a retry and returns this record; with different content it is a conflict.
  creation_digest     TEXT    NOT NULL CHECK (length(creation_digest) = 64),
  version             INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  -- Advances when a posting, void, restore, amount/date repair or baseline
  -- change affects this account. Category and note edits do not touch it.
  ledger_revision     INTEGER NOT NULL CHECK (ledger_revision >= 0 AND ledger_revision < 1000000000000000000),
  created_at          INTEGER NOT NULL CHECK (created_at > 0),
  updated_at          INTEGER NOT NULL CHECK (updated_at > 0)
) STRICT;

CREATE INDEX accounts_archived_at ON accounts (archived_at);

-- Categories arrive here, ahead of their own management commands, because the
-- transaction constraints below refer to them. Only the two protected rows
-- exist in this stage.
CREATE TABLE categories (
  id              TEXT    PRIMARY KEY CHECK (length(id) = 36),
  display_name    TEXT    NOT NULL CHECK (
                    length(display_name) BETWEEN 1 AND 60 AND trim(display_name) <> ''
                  ),
  -- Trimmed, space-collapsed, lower-cased: uniqueness ignores those.
  normalized_name TEXT    NOT NULL UNIQUE CHECK (length(normalized_name) BETWEEN 1 AND 60),
  description     TEXT             CHECK (description IS NULL OR length(description) <= 280),
  color           TEXT    NOT NULL CHECK (color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  system_kind     TEXT             CHECK (system_kind IS NULL OR system_kind IN ('income', 'uncategorized')),
  protected       INTEGER NOT NULL CHECK (protected IN (0, 1)),
  archived_at     INTEGER          CHECK (archived_at IS NULL OR archived_at > 0),
  version         INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at > 0),
  -- A protected category is exactly a system one, and is never archived.
  CHECK ((protected = 1) = (system_kind IS NOT NULL)),
  CHECK (protected = 0 OR archived_at IS NULL)
) STRICT;

CREATE UNIQUE INDEX categories_system_kind ON categories (system_kind) WHERE system_kind IS NOT NULL;

INSERT INTO categories (
  id, display_name, normalized_name, description, color, system_kind,
  protected, archived_at, version, created_at, updated_at
) VALUES (
  '30000000-0000-4000-8000-000000000000', 'Uncategorized', 'uncategorized',
  'Purchases and refunds without a specific category', '#8A8578', 'uncategorized',
  1, NULL, 1,
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
), (
  '30000000-0000-4000-8000-000000000001', 'Income', 'income',
  'Income transactions', '#2F7D6D', 'income',
  1, NULL, 1,
  CAST(unixepoch('subsec') * 1000 AS INTEGER), CAST(unixepoch('subsec') * 1000 AS INTEGER)
);

-- The protected rows are protected by the database, not only by the service,
-- so no code path and no direct write can rename, archive or remove them.
CREATE TRIGGER categories_protected_no_update
BEFORE UPDATE ON categories
FOR EACH ROW WHEN OLD.protected = 1 AND (
  -- The transaction constraints name these ids as literals, so a changed id
  -- would make every income row impossible to write.
  NEW.id <> OLD.id
  OR NEW.display_name <> OLD.display_name
  OR NEW.normalized_name <> OLD.normalized_name
  OR NEW.system_kind IS NOT OLD.system_kind
  OR NEW.protected <> OLD.protected
  OR NEW.archived_at IS NOT OLD.archived_at
)
BEGIN
  SELECT RAISE(ABORT, 'protected category cannot be renamed, re-identified, archived or unprotected');
END;

CREATE TRIGGER categories_protected_no_delete
BEFORE DELETE ON categories
FOR EACH ROW WHEN OLD.protected = 1
BEGIN
  SELECT RAISE(ABORT, 'protected category cannot be deleted');
END;

-- Transactions exist from this stage because a balance cannot be computed
-- without them. The commands that create and change them arrive in stage 3;
-- here they are written only by tests.
CREATE TABLE transactions (
  id                TEXT    PRIMARY KEY CHECK (length(id) = 36),
  account_id        TEXT    NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  posted_date       TEXT    NOT NULL CHECK (
                      posted_date IS strftime('%Y-%m-%d', posted_date)
                      AND posted_date BETWEEN '1900-01-01' AND '2999-12-31'
                    ),
  -- Exactly as the bank wrote it; the normalized form is for searching.
  -- 2,000 is the contract's limit for a merchant description (design section 6).
  merchant_text     TEXT    NOT NULL CHECK (length(merchant_text) BETWEEN 1 AND 2000),
  normalized_text   TEXT    NOT NULL CHECK (length(normalized_text) <= 2000),
  amount_cents      INTEGER NOT NULL CHECK (
                      amount_cents <> 0
                      AND amount_cents > -100000000000 AND amount_cents < 100000000000
                    ),
  kind              TEXT    NOT NULL CHECK (kind IN ('purchase', 'refund', 'income', 'transfer')),
  category_id       TEXT             REFERENCES categories (id) ON DELETE RESTRICT,
  assignment_origin TEXT    NOT NULL CHECK (assignment_origin IN ('manual', 'rule', 'unassigned', 'system')),
  note              TEXT             CHECK (note IS NULL OR length(note) <= 1000),
  lifecycle         TEXT    NOT NULL CHECK (lifecycle IN ('active', 'void')),
  version           INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at        INTEGER NOT NULL CHECK (created_at > 0),
  updated_at        INTEGER NOT NULL CHECK (updated_at > 0),

  -- Kind and sign agree: a purchase is money out, a refund and income are
  -- money in, a transfer may go either way but is never zero.
  CHECK (kind <> 'purchase' OR amount_cents < 0),
  CHECK (kind <> 'refund'   OR amount_cents > 0),
  CHECK (kind <> 'income'   OR amount_cents > 0),

  -- A transfer moves money between owned accounts; it is not spending and
  -- carries no category.
  CHECK (kind <> 'transfer' OR (category_id IS NULL AND assignment_origin = 'system')),
  CHECK (kind =  'transfer' OR category_id IS NOT NULL),

  -- Income if and only if the Income category: income rows must use it, and
  -- purchases and refunds can never use it.
  CHECK ((category_id = '30000000-0000-4000-8000-000000000001') = (kind = 'income')),
  CHECK (kind <> 'income' OR assignment_origin = 'system'),

  -- Purchases and refunds are owner-assignable; `unassigned` means exactly
  -- "still sitting in Uncategorized", while a deliberate `manual` choice of
  -- Uncategorized stays protected from rules.
  CHECK (kind NOT IN ('purchase', 'refund') OR assignment_origin IN ('manual', 'rule', 'unassigned')),
  CHECK (assignment_origin <> 'unassigned' OR category_id = '30000000-0000-4000-8000-000000000000')
) STRICT;

CREATE INDEX transactions_posted_date ON transactions (posted_date DESC, id DESC);
CREATE INDEX transactions_account_posted ON transactions (account_id, posted_date DESC, id DESC);
CREATE INDEX transactions_category_posted ON transactions (category_id, posted_date DESC, id DESC);

-- What the statement said, and every comparison ever made against it. There
-- is deliberately no status column: status is derived on read, so a ledger
-- change of any kind - import, repair, void, baseline edit - can never leave a
-- stale "reconciled" behind.
CREATE TABLE reconciliation_checkpoints (
  id              TEXT    PRIMARY KEY CHECK (length(id) = 36),
  account_id      TEXT    NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  closing_date    TEXT    NOT NULL CHECK (
                    closing_date IS strftime('%Y-%m-%d', closing_date)
                    AND closing_date BETWEEN '1900-01-01' AND '2999-12-31'
                  ),
  -- Entered by the owner, never overwritten by anything the app calculates.
  statement_cents INTEGER NOT NULL CHECK (
                    statement_cents > -100000000000 AND statement_cents < 100000000000
                  ),
  creation_digest TEXT    NOT NULL CHECK (length(creation_digest) = 64),
  version         INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at      INTEGER NOT NULL CHECK (created_at > 0),
  updated_at      INTEGER NOT NULL CHECK (updated_at > 0)
) STRICT;

CREATE INDEX checkpoints_account_closing ON reconciliation_checkpoints (account_id, closing_date DESC);

CREATE TABLE checkpoint_checks (
  id               TEXT    PRIMARY KEY CHECK (length(id) = 36),
  checkpoint_id    TEXT    NOT NULL REFERENCES reconciliation_checkpoints (id) ON DELETE RESTRICT,
  checked_at       INTEGER NOT NULL CHECK (checked_at > 0),
  -- The calculated balance at the moment of this check, kept so a later change
  -- to that balance is detectable.
  calculated_cents INTEGER NOT NULL CHECK (
                     calculated_cents > -1000000000000000000 AND calculated_cents < 1000000000000000000
                   ),
  difference_cents INTEGER NOT NULL CHECK (
                     difference_cents > -1000000000000000000 AND difference_cents < 1000000000000000000
                   ),
  matched          INTEGER NOT NULL CHECK (matched IN (0, 1)),
  -- Matched means exactly "no difference"; the two can never disagree.
  CHECK ((matched = 1) = (difference_cents = 0))
) STRICT;

CREATE INDEX checkpoint_checks_checkpoint ON checkpoint_checks (checkpoint_id, checked_at DESC);

-- Checks are append-only. That keeps the history honest, and it is what lets
-- "the latest check" mean the one recorded last (the highest rowid).
CREATE TRIGGER checkpoint_checks_no_update
BEFORE UPDATE ON checkpoint_checks
BEGIN
  SELECT RAISE(ABORT, 'a recorded check cannot be changed');
END;

CREATE TRIGGER checkpoint_checks_no_delete
BEFORE DELETE ON checkpoint_checks
BEGIN
  SELECT RAISE(ABORT, 'a recorded check cannot be removed');
END;

-- The archived-account rule (design section 12), backed by the database where
-- the change is financial. The service refuses these first with a readable
-- 409; these triggers are the backstop against a path that forgets to ask.
-- Category and note edits, and archiving or reactivating itself, stay allowed.
CREATE TRIGGER accounts_archived_no_baseline_change
BEFORE UPDATE OF tracking_start_date, opening_cents ON accounts
FOR EACH ROW WHEN OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT NULL AND (
  NEW.tracking_start_date <> OLD.tracking_start_date
  OR NEW.opening_cents <> OLD.opening_cents
)
BEGIN
  SELECT RAISE(ABORT, 'archived account: reactivate it before changing its baseline');
END;

CREATE TRIGGER transactions_archived_no_insert
BEFORE INSERT ON transactions
FOR EACH ROW WHEN (SELECT archived_at FROM accounts WHERE id = NEW.account_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'archived account: reactivate it before adding transactions');
END;

CREATE TRIGGER transactions_archived_no_financial_change
BEFORE UPDATE ON transactions
FOR EACH ROW WHEN (
  (SELECT archived_at FROM accounts WHERE id = OLD.account_id) IS NOT NULL
  OR (SELECT archived_at FROM accounts WHERE id = NEW.account_id) IS NOT NULL
) AND (
  NEW.account_id <> OLD.account_id
  OR NEW.posted_date <> OLD.posted_date
  OR NEW.amount_cents <> OLD.amount_cents
  OR NEW.kind <> OLD.kind
  OR NEW.lifecycle <> OLD.lifecycle
)
BEGIN
  SELECT RAISE(ABORT, 'archived account: reactivate it before this repair');
END;

CREATE TRIGGER checkpoints_archived_no_insert
BEFORE INSERT ON reconciliation_checkpoints
FOR EACH ROW WHEN (SELECT archived_at FROM accounts WHERE id = NEW.account_id) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'archived account: reactivate it before recording a statement');
END;

CREATE TRIGGER checkpoint_checks_archived_no_insert
BEFORE INSERT ON checkpoint_checks
FOR EACH ROW WHEN (
  SELECT a.archived_at FROM accounts a
  JOIN reconciliation_checkpoints c ON c.account_id = a.id
  WHERE c.id = NEW.checkpoint_id
) IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'archived account: reactivate it before rechecking');
END;

-- History of owner-visible changes.
--
-- entity_id and account_id are recorded strings with NO foreign key, on
-- purpose (design section 12): an account's own creation and edit records must
-- never be what blocks deleting a genuinely unused account, and history must
-- never cascade away with the record it describes. That guarantee is
-- structural here rather than a matter of remembering to write the right
-- query.
CREATE TABLE audit_events (
  id          TEXT    PRIMARY KEY CHECK (length(id) = 36),
  command_id  TEXT             CHECK (command_id IS NULL OR length(command_id) = 36),
  entity_type TEXT    NOT NULL CHECK (entity_type IN ('account', 'transaction', 'category', 'checkpoint')),
  entity_id   TEXT    NOT NULL CHECK (length(entity_id) = 36),
  account_id  TEXT             CHECK (account_id IS NULL OR length(account_id) = 36),
  event_type  TEXT    NOT NULL CHECK (length(event_type) BETWEEN 1 AND 60),
  origin      TEXT    NOT NULL CHECK (origin IN ('owner', 'import', 'system')),
  reason      TEXT             CHECK (reason IS NULL OR length(reason) <= 500),
  before_json TEXT             CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json  TEXT             CHECK (after_json IS NULL OR json_valid(after_json)),
  occurred_at INTEGER NOT NULL CHECK (occurred_at > 0)
) STRICT;

CREATE INDEX audit_events_entity ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_account ON audit_events (account_id, occurred_at DESC);

UPDATE ledger_metadata SET schema_version = 2 WHERE id = 1;
