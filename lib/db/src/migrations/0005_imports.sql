-- Migration 0005: bank imports.
--
-- Two kinds of record live here and they must not be confused.
--
-- Preview state (`import_rows`, `uploads`) is working material. It is deleted
-- when an attempt is abandoned, expires, or has its uploaded copy cleaned up.
--
-- Financial evidence (`import_source_records`, `import_postings`,
-- `source_identities`) is history. Once a row has posted a transaction, the
-- evidence behind it outlives the preview it came from, the raw file, a later
-- void or unlink, and the deletion of the row copy itself. That is why posting
-- claims are not cascade-deleted with preview rows, and why a posted row
-- cannot be purged.
--
-- Amounts are integer cents; dates are calendar date strings; times are
-- integer milliseconds since the Unix epoch, UTC - the same conventions as
-- every earlier migration.

-- One attempt to import one file into one account.
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  -- The adapter that read the file, pinned: a later adapter version must not
  -- silently change how an existing preview was interpreted.
  format_id TEXT NOT NULL CHECK (
    length(format_id) BETWEEN 1 AND 64
    AND NOT format_id GLOB '*[^a-z0-9-]*'
    AND NOT format_id GLOB '-*'
  ),
  format_version INTEGER NOT NULL CHECK (format_version >= 1 AND format_version < 1000000000),
  -- Display only, and never a path: no separator, no directory reference.
  filename TEXT NOT NULL CHECK (
    codepoint_length(filename) BETWEEN 1 AND 255
    AND filename NOT GLOB '*[/\]*'
    AND filename NOT IN ('.', '..')
  ),
  status TEXT NOT NULL CHECK (status IN (
    'receiving', 'parsing', 'preview', 'committed', 'cancelled', 'expired', 'failed'
  )),
  -- Set for a follow-up preview of a completed import's excluded rows.
  parent_import_id TEXT REFERENCES import_batches (id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  last_reviewed_at INTEGER NOT NULL CHECK (last_reviewed_at >= created_at),
  -- Thirty days after the last saved review activity while open; NULL once terminal.
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at > created_at),
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  -- What the suggestions were computed against. A change makes the preview
  -- stale and requires a refresh before commit.
  captured_ledger_revision INTEGER NOT NULL CHECK (
    captured_ledger_revision >= 0 AND captured_ledger_revision < 1000000000000000000
  ),
  captured_rule_set_revision INTEGER NOT NULL CHECK (
    captured_rule_set_revision >= 0 AND captured_rule_set_revision < 1000000000000000000
  ),
  captured_account_archived INTEGER NOT NULL CHECK (captured_account_archived IN (0, 1)),
  -- A safe failure: a code the contract declares and a message that never
  -- contains a value from the file.
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'unreadable_file', 'unsupported_encoding', 'malformed_csv', 'header_mismatch',
    'limit_exceeded', 'upload_incomplete', 'pending_records_unsupported'
  )),
  failure_message TEXT CHECK (failure_message IS NULL OR codepoint_length(failure_message) BETWEEN 1 AND 300),
  -- Immutable completion counts. `result_added` counts rows posted by a
  -- tracking-start extension and rows posted by the final commit once each.
  result_rows INTEGER CHECK (result_rows IS NULL OR (result_rows >= 0 AND result_rows <= 25000)),
  result_added INTEGER CHECK (result_added IS NULL OR (result_added >= 0 AND result_added <= 25000)),
  result_excluded INTEGER CHECK (result_excluded IS NULL OR (result_excluded >= 0 AND result_excluded <= 25000)),
  result_paired_transfers INTEGER CHECK (
    result_paired_transfers IS NULL OR (result_paired_transfers >= 0 AND result_paired_transfers <= 25000)
  ),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
  -- When the stored upload copy is due for deletion: 30 days after completion.
  upload_retained_until INTEGER CHECK (upload_retained_until IS NULL OR upload_retained_until > 0),
  -- Fingerprint of the creating request, so a retried follow-up returns the
  -- same preview instead of making a second one.
  creation_digest TEXT NOT NULL CHECK (length(creation_digest) = 64),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  -- An open batch has a review deadline; a finished one never does.
  CHECK ((status IN ('committed', 'cancelled', 'expired', 'failed')) = (expires_at IS NULL)),
  -- A recorded outcome belongs to a completed import and nothing else.
  CHECK ((status = 'committed') = (result_json IS NOT NULL)),
  CHECK ((result_json IS NULL) = (result_rows IS NULL)),
  CHECK ((result_json IS NULL) = (result_added IS NULL)),
  CHECK ((result_json IS NULL) = (result_excluded IS NULL)),
  CHECK ((result_json IS NULL) = (result_paired_transfers IS NULL)),
  CHECK ((result_json IS NULL) = (completed_at IS NULL)),
  CHECK (result_rows IS NULL OR result_added + result_excluded <= result_rows),
  CHECK (result_paired_transfers IS NULL OR result_paired_transfers <= result_added),
  -- A failure explanation belongs to a failed import and nothing else.
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK ((failure_code IS NULL) = (failure_message IS NULL)),
  -- Only a completed import retains a copy to delete later.
  CHECK (upload_retained_until IS NULL OR status = 'committed'),
  -- A follow-up is never its own parent.
  CHECK (parent_import_id IS NULL OR parent_import_id <> id)
) STRICT;

CREATE INDEX import_batches_account_recent ON import_batches (account_id, status, created_at DESC, id DESC);
CREATE INDEX import_batches_recent ON import_batches (created_at DESC, id DESC);
-- Expiry and retention sweeps scan by deadline, not by scanning every batch.
CREATE INDEX import_batches_expiry ON import_batches (status, expires_at);
CREATE INDEX import_batches_retention ON import_batches (upload_retained_until) WHERE upload_retained_until IS NOT NULL;
CREATE INDEX import_batches_parent ON import_batches (parent_import_id) WHERE parent_import_id IS NOT NULL;
CREATE UNIQUE INDEX import_batches_follow_up_digest ON import_batches (parent_import_id, creation_digest)
  WHERE parent_import_id IS NOT NULL;

CREATE TRIGGER import_batches_preserve_identity BEFORE UPDATE ON import_batches
WHEN NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id
  OR NEW.format_id <> OLD.format_id OR NEW.format_version <> OLD.format_version
  OR NEW.filename <> OLD.filename OR NEW.created_at <> OLD.created_at
  OR NEW.creation_digest <> OLD.creation_digest
  OR NEW.parent_import_id IS NOT OLD.parent_import_id
BEGIN SELECT RAISE(ABORT, 'import identity and pinned format cannot be changed'); END;

-- Only these moves make sense. Anything else - reopening a finished import,
-- going back to receiving, committing something that was never a preview - is
-- refused rather than recorded.
CREATE TRIGGER import_batches_valid_transition BEFORE UPDATE ON import_batches
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'receiving' AND NEW.status IN ('parsing', 'preview', 'cancelled', 'expired', 'failed'))
  OR (OLD.status = 'parsing' AND NEW.status IN ('preview', 'cancelled', 'expired', 'failed'))
  OR (OLD.status = 'preview' AND NEW.status IN ('committed', 'cancelled', 'expired', 'failed'))
)
BEGIN SELECT RAISE(ABORT, 'that import status change is not allowed'); END;

CREATE TRIGGER import_batches_preserve_result BEFORE UPDATE ON import_batches
WHEN OLD.result_json IS NOT NULL AND (
  NEW.result_json IS NOT OLD.result_json OR NEW.result_rows IS NOT OLD.result_rows
  OR NEW.result_added IS NOT OLD.result_added OR NEW.result_excluded IS NOT OLD.result_excluded
  OR NEW.result_paired_transfers IS NOT OLD.result_paired_transfers
  OR NEW.completed_at IS NOT OLD.completed_at
)
BEGIN SELECT RAISE(ABORT, 'a completed import outcome cannot be changed'); END;

CREATE TRIGGER import_batches_version_forward BEFORE UPDATE ON import_batches
WHEN NEW.version < OLD.version
BEGIN SELECT RAISE(ABORT, 'import version cannot go backward'); END;

-- Abandoning an import deletes its contents, never its entry: the owner must
-- still be able to see that the file was handled and how it ended.
CREATE TRIGGER import_batches_no_delete BEFORE DELETE ON import_batches
BEGIN SELECT RAISE(ABORT, 'import history cannot be removed'); END;

-- The stored copy of the uploaded bytes. One per batch at most.
CREATE TABLE uploads (
  -- Randomly generated by this application. Never a name the client supplied,
  -- and restricted so it cannot express a path or a directory reference.
  storage_key TEXT PRIMARY KEY CHECK (
    length(storage_key) = 32 AND NOT storage_key GLOB '*[^0-9a-f]*'
  ),
  import_id TEXT NOT NULL UNIQUE REFERENCES import_batches (id) ON DELETE RESTRICT,
  byte_size INTEGER CHECK (byte_size IS NULL OR (byte_size >= 0 AND byte_size <= 10485760)),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND NOT sha256 GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK (state IN ('receiving', 'available', 'deletion_pending', 'deleted')),
  -- When the bytes become due for deletion. Set once the import completes.
  retention_deadline INTEGER CHECK (retention_deadline IS NULL OR retention_deadline > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  -- Size and fingerprint are only known once the bytes are all in.
  CHECK ((state = 'receiving') = (byte_size IS NULL)),
  CHECK ((byte_size IS NULL) = (sha256 IS NULL))
) STRICT;

-- The cleanup sweep asks for work by state and deadline.
CREATE INDEX uploads_pending_deletion ON uploads (state, retention_deadline);

CREATE TRIGGER uploads_preserve_identity BEFORE UPDATE ON uploads
WHEN NEW.storage_key <> OLD.storage_key OR NEW.import_id <> OLD.import_id
  OR NEW.created_at <> OLD.created_at
  OR (OLD.sha256 IS NOT NULL AND NEW.sha256 IS NOT OLD.sha256)
  OR (OLD.byte_size IS NOT NULL AND NEW.byte_size IS NOT OLD.byte_size)
BEGIN SELECT RAISE(ABORT, 'stored upload identity and fingerprint cannot be changed'); END;

-- Bytes may only move forward through their lifecycle. In particular, an
-- upload that has been marked for deletion cannot quietly become available
-- again after a restart.
CREATE TRIGGER uploads_valid_transition BEFORE UPDATE ON uploads
WHEN NEW.state <> OLD.state AND NOT (
  (OLD.state = 'receiving' AND NEW.state IN ('available', 'deletion_pending'))
  OR (OLD.state = 'available' AND NEW.state = 'deletion_pending')
  OR (OLD.state = 'deletion_pending' AND NEW.state = 'deleted')
)
BEGIN SELECT RAISE(ABORT, 'that stored upload state change is not allowed'); END;

-- The row survives the bytes. Deleting it would lose the record that a file
-- is still on disk waiting to be removed, which is exactly what has to
-- survive a restart.
CREATE TRIGGER uploads_no_delete BEFORE DELETE ON uploads
BEGIN SELECT RAISE(ABORT, 'mark a stored upload deleted rather than removing its record'); END;

-- "This account has already seen this exact file." Keyed by content, not by
-- adapter version, so re-reading the same file with a newer adapter is still
-- recognised. An unsuccessful attempt releases its claim; a completed one
-- keeps it after the stored copy is gone.
CREATE TABLE import_file_claims (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND NOT sha256 GLOB '*[^0-9a-f]*'),
  import_id TEXT NOT NULL REFERENCES import_batches (id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (account_id, sha256)
) STRICT;

CREATE INDEX import_file_claims_import ON import_file_claims (import_id);

CREATE TRIGGER import_file_claims_no_reassign BEFORE UPDATE ON import_file_claims
BEGIN SELECT RAISE(ABORT, 'release a file claim rather than moving it'); END;

-- Durable evidence of one source row, kept for as long as anything financial
-- depends on it. This is the root identity a posting claims, and it outlives
-- the preview row that was copied from it.
CREATE TABLE import_source_records (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  -- Where this evidence originally came from. A follow-up copy points back
  -- here rather than claiming a new origin.
  origin_import_id TEXT NOT NULL REFERENCES import_batches (id) ON DELETE RESTRICT,
  origin_row_number INTEGER NOT NULL CHECK (origin_row_number >= 1 AND origin_row_number <= 25000),
  source_fields_json TEXT NOT NULL CHECK (json_valid(source_fields_json)),
  normalized_json TEXT NOT NULL CHECK (json_valid(normalized_json)),
  -- The category and rule this evidence referred to, kept so the history
  -- still resolves after either is archived.
  category_id TEXT REFERENCES categories (id) ON DELETE RESTRICT,
  rule_id TEXT,
  rule_revision INTEGER,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  CHECK ((rule_id IS NULL) = (rule_revision IS NULL)),
  FOREIGN KEY (rule_id, rule_revision) REFERENCES rule_revisions (rule_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX import_source_records_origin ON import_source_records (origin_import_id, origin_row_number);
CREATE INDEX import_source_records_account ON import_source_records (account_id, id);

CREATE TRIGGER import_source_records_no_update BEFORE UPDATE ON import_source_records
BEGIN SELECT RAISE(ABORT, 'retained source evidence cannot be changed'); END;

-- Evidence with no posting and no live row may be cleaned up; evidence a
-- posting claims may not.
CREATE TRIGGER import_source_records_claimed_no_delete BEFORE DELETE ON import_source_records
WHEN EXISTS (SELECT 1 FROM import_postings WHERE source_record_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'posted source evidence cannot be removed'); END;

-- One row of one file became one transaction. Recorded once, never rewritten.
-- Survives voiding, unlinking, deletion of the preview row, cleanup of the
-- raw file, and abandonment of the rest of the import.
CREATE TABLE import_postings (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  -- A source may be posted once and once only, no matter how many follow-up
  -- previews offer it.
  source_record_id TEXT NOT NULL UNIQUE REFERENCES import_source_records (id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  -- The batch that actually posted it, which for a follow-up is not the batch
  -- the evidence originated in.
  posting_import_id TEXT NOT NULL REFERENCES import_batches (id) ON DELETE RESTRICT,
  posting_row_number INTEGER NOT NULL CHECK (posting_row_number >= 1 AND posting_row_number <= 25000),
  -- Which path posted it: the final commit, or an earlier tracking-start
  -- extension that posted this row while the preview stayed open.
  posting_path TEXT NOT NULL CHECK (posting_path IN ('commit', 'baseline_extension')),
  posted_at INTEGER NOT NULL CHECK (posted_at > 0),
  -- The counterpart this import paired at posting time. A later unlink does
  -- not erase the fact that this import performed the pairing.
  paired_counterpart_id TEXT REFERENCES transactions (id) ON DELETE RESTRICT,
  CHECK (paired_counterpart_id IS NULL OR paired_counterpart_id <> transaction_id)
) STRICT;

CREATE INDEX import_postings_batch ON import_postings (posting_import_id, posting_row_number);

CREATE TRIGGER import_postings_no_update BEFORE UPDATE ON import_postings
BEGIN SELECT RAISE(ABORT, 'posting history cannot be changed'); END;

CREATE TRIGGER import_postings_no_delete BEFORE DELETE ON import_postings
BEGIN SELECT RAISE(ABORT, 'posting history cannot be removed'); END;

-- A bank's own identifier for a transaction, where the bank supplies one that
-- is actually reliable. Voided transactions stay listed: a void is not
-- permission to import the same bank record again. The adapter version is
-- deliberately not part of the key.
CREATE TABLE source_identities (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  provider_namespace TEXT NOT NULL CHECK (
    length(provider_namespace) BETWEEN 1 AND 64 AND NOT provider_namespace GLOB '*[^a-z0-9_-]*'
  ),
  bank_transaction_id TEXT NOT NULL CHECK (codepoint_length(bank_transaction_id) BETWEEN 1 AND 255),
  transaction_id TEXT NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (account_id, provider_namespace, bank_transaction_id)
) STRICT;

CREATE INDEX source_identities_transaction ON source_identities (transaction_id);

CREATE TRIGGER source_identities_no_update BEFORE UPDATE ON source_identities
BEGIN SELECT RAISE(ABORT, 'a bank identity cannot be reassigned'); END;

-- Refusing the update alone left two ways to reach the same result: delete the
-- claim, or INSERT OR REPLACE over it. Both are refused here. The connection
-- runs with recursive_triggers ON, so the delete a REPLACE performs fires this
-- trigger too.
CREATE TRIGGER source_identities_no_delete BEFORE DELETE ON source_identities
BEGIN SELECT RAISE(ABORT, 'a bank identity cannot be removed'); END;

-- That REPLACE protection holds only while `recursive_triggers` is on, which
-- is a property of the connection rather than of the schema: `open.ts` sets and
-- asserts it, but anything opening this file another way - a shell, a backup
-- tool, a future script - would not. This refuses the clobber directly, so the
-- claim is append-only in the file itself and not merely on our connections.
CREATE TRIGGER source_identities_no_clobber BEFORE INSERT ON source_identities
WHEN EXISTS (
  SELECT 1 FROM source_identities
  WHERE account_id = NEW.account_id AND provider_namespace = NEW.provider_namespace
    AND bank_transaction_id = NEW.bank_transaction_id
)
BEGIN SELECT RAISE(ABORT, 'a bank identity cannot be replaced'); END;

-- Working review state for one row of one preview. Deleted when the attempt is
-- abandoned - unless it posted something, in which case its evidence and
-- posting survive it.
CREATE TABLE import_rows (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  import_id TEXT NOT NULL REFERENCES import_batches (id) ON DELETE RESTRICT,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 1 AND source_row_number <= 25000),
  -- The allowlisted values the adapter retained, exactly as the bank wrote
  -- them. Never edited: a correction changes the normalized value beside it.
  source_fields_json TEXT NOT NULL CHECK (json_valid(source_fields_json)),
  -- The durable evidence this row was copied from, where one exists. A
  -- follow-up row shares its parent's record rather than duplicating it.
  source_record_id TEXT REFERENCES import_source_records (id) ON DELETE RESTRICT,
  -- The bank's own identifier for this record, with the namespace it belongs
  -- to, where the format declares one that is actually reliable. Stored with
  -- the row rather than looked up from the adapter, so matching never depends
  -- on which format versions happen to be loaded. Never a check number, a
  -- running balance, an amount or a description.
  bank_identity_namespace TEXT CHECK (
    bank_identity_namespace IS NULL OR (
      length(bank_identity_namespace) BETWEEN 1 AND 64
      AND NOT bank_identity_namespace GLOB '*[^a-z0-9_-]*'
    )
  ),
  bank_transaction_id TEXT CHECK (
    bank_transaction_id IS NULL OR codepoint_length(bank_transaction_id) BETWEEN 1 AND 255
  ),
  -- Normalized values. Nullable, because an invalid value is held for the
  -- owner to correct rather than rounded, dropped or guessed at.
  posted_date TEXT CHECK (
    posted_date IS NULL OR (
      posted_date IS strftime('%Y-%m-%d', posted_date) AND posted_date BETWEEN '1900-01-01' AND '2999-12-31'
    )
  ),
  merchant_text TEXT CHECK (merchant_text IS NULL OR codepoint_length(merchant_text) BETWEEN 1 AND 2000),
  normalized_text TEXT CHECK ((normalized_text IS NULL) = (merchant_text IS NULL)),
  amount_cents INTEGER CHECK (
    amount_cents IS NULL OR (amount_cents > -100000000000 AND amount_cents < 100000000000)
  ),
  kind TEXT CHECK (kind IS NULL OR kind IN ('purchase', 'refund', 'income', 'transfer')),
  kind_source TEXT CHECK (
    kind_source IS NULL OR kind_source IN ('bank', 'transfer_candidate', 'default', 'owner')
  ),
  category_id TEXT REFERENCES categories (id) ON DELETE RESTRICT,
  assignment_origin TEXT CHECK (
    assignment_origin IS NULL OR assignment_origin IN ('manual', 'rule', 'unassigned', 'system')
  ),
  rule_id TEXT,
  rule_revision INTEGER,
  state TEXT NOT NULL CHECK (state IN ('ready', 'held', 'excluded')),
  issues_json TEXT NOT NULL CHECK (json_valid(issues_json)),
  excluded INTEGER NOT NULL CHECK (excluded IN (0, 1)),
  -- Set when a refresh changed this row's suggestions; cleared by an explicit
  -- save that acknowledges them.
  review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
  -- Which suggestions changed, not merely that something did. A bulk type
  -- choice acknowledges the type change on a row and nothing else, so
  -- acknowledgement has to be able to name what it covers.
  changed_suggestions_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(changed_suggestions_json) AND json_type(changed_suggestions_json) = 'array'
  ),
  duplicate_status TEXT NOT NULL CHECK (duplicate_status IN ('none', 'suspected', 'confirmed')),
  -- At most the twenty matches the contract displays.
  duplicate_matches_json TEXT NOT NULL CHECK (json_valid(duplicate_matches_json)),
  -- How many matches were actually found, which may exceed the twenty shown,
  -- and a fingerprint of all of them. A decision to include is consent to the
  -- whole evidence, so it is compared against the whole evidence.
  duplicate_match_count INTEGER NOT NULL DEFAULT 0 CHECK (
    duplicate_match_count >= 0 AND duplicate_match_count <= 100000
  ),
  duplicate_evidence_digest TEXT CHECK (
    duplicate_evidence_digest IS NULL OR (
      length(duplicate_evidence_digest) = 64 AND NOT duplicate_evidence_digest GLOB '*[^0-9a-f]*'
    )
  ),
  duplicate_decision TEXT CHECK (duplicate_decision IS NULL OR duplicate_decision IN ('include', 'exclude')),
  transfer_candidate_json TEXT CHECK (transfer_candidate_json IS NULL OR json_valid(transfer_candidate_json)),
  transfer_counterpart_id TEXT REFERENCES transactions (id) ON DELETE RESTRICT,
  transfer_counterpart_version INTEGER CHECK (
    transfer_counterpart_version IS NULL
    OR (transfer_counterpart_version >= 1 AND transfer_counterpart_version < 1000000000000000000)
  ),
  transfer_decision TEXT CHECK (transfer_decision IS NULL OR transfer_decision IN ('confirm', 'reject')),
  -- Set when this row was posted by a tracking-start extension while the
  -- preview stayed open. Such a row is finished and can never post again.
  posted_transaction_id TEXT UNIQUE REFERENCES transactions (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1 AND version < 1000000000000000000),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  -- An identifier and the namespace it is unique within travel together.
  CHECK ((bank_identity_namespace IS NULL) = (bank_transaction_id IS NULL)),
  -- A type and where it came from travel together.
  CHECK ((kind IS NULL) = (kind_source IS NULL)),
  -- A proposed category needs an origin, and a rule origin needs its revision.
  -- `IS` rather than `=`, here and below: `=` yields NULL against a NULL
  -- column, and a CHECK that evaluates to NULL passes, which would leave these
  -- pairings unenforced exactly when a value is missing.
  CHECK ((category_id IS NULL) = (assignment_origin IS NULL)),
  CHECK ((assignment_origin IS 'rule') = (rule_id IS NOT NULL)),
  CHECK ((rule_id IS NULL) = (rule_revision IS NULL)),
  -- The flag and the list of changed suggestions cannot disagree.
  CHECK (review_required = (json_array_length(changed_suggestions_json) > 0)),
  -- Matches, their count and their fingerprint travel together.
  CHECK ((duplicate_status = 'none') = (duplicate_match_count = 0)),
  CHECK ((duplicate_match_count = 0) = (duplicate_evidence_digest IS NULL)),
  CHECK (json_array_length(duplicate_matches_json) <= 20),
  CHECK (json_array_length(duplicate_matches_json) <= duplicate_match_count),
  -- A confirmed duplicate can only be left out. Including it is refused here,
  -- not merely discouraged in the service.
  CHECK (NOT (duplicate_status = 'confirmed' AND duplicate_decision = 'include')),
  -- A decision about a duplicate requires a duplicate to decide about.
  CHECK (duplicate_decision IS NULL OR duplicate_status <> 'none'),
  -- A transfer decision requires a candidate to decide about.
  CHECK (transfer_decision IS NULL OR transfer_candidate_json IS NOT NULL),
  CHECK ((transfer_candidate_json IS NULL) = (transfer_counterpart_id IS NULL)),
  CHECK ((transfer_counterpart_id IS NULL) = (transfer_counterpart_version IS NULL)),
  -- The stored state must agree with the reasons for it.
  CHECK ((state = 'excluded') = (excluded = 1 OR duplicate_decision IS 'exclude')),
  -- A row already posted is settled: nothing is left to decide or exclude.
  CHECK (posted_transaction_id IS NULL OR (state = 'ready' AND excluded = 0 AND review_required = 0)),
  FOREIGN KEY (rule_id, rule_revision) REFERENCES rule_revisions (rule_id, revision) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX import_rows_source_order ON import_rows (import_id, source_row_number);
CREATE INDEX import_rows_state ON import_rows (import_id, state, source_row_number);
CREATE INDEX import_rows_source_record ON import_rows (source_record_id) WHERE source_record_id IS NOT NULL;
-- Duplicate detection groups by the values it compares instead of scanning
-- every row against every other row.
CREATE INDEX import_rows_candidates ON import_rows (import_id, posted_date, amount_cents, normalized_text);
-- Bank identities are matched by their own key, not by scanning the file.
CREATE INDEX import_rows_bank_identity
  ON import_rows (import_id, bank_identity_namespace, bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

-- Suggestions look up postings by exactly the values they compare. Without
-- these, a 25,000-row file would read the ledger once per row.
CREATE INDEX transactions_import_candidates
  ON transactions (account_id, posted_date, amount_cents, normalized_text);
CREATE INDEX transactions_transfer_candidates
  ON transactions (amount_cents, posted_date) WHERE lifecycle = 'active';

CREATE TRIGGER import_rows_preserve_source BEFORE UPDATE ON import_rows
WHEN NEW.id <> OLD.id OR NEW.import_id <> OLD.import_id
  OR NEW.source_row_number <> OLD.source_row_number
  OR NEW.source_fields_json <> OLD.source_fields_json
  OR NEW.created_at <> OLD.created_at
  OR NEW.source_record_id IS NOT OLD.source_record_id
  OR NEW.bank_identity_namespace IS NOT OLD.bank_identity_namespace
  OR NEW.bank_transaction_id IS NOT OLD.bank_transaction_id
BEGIN SELECT RAISE(ABORT, 'a row''s original source values cannot be changed'); END;

-- Once a row has posted, it is history. Reviewing it again, re-including it,
-- or pointing it at a second transaction is refused.
CREATE TRIGGER import_rows_posted_immutable BEFORE UPDATE ON import_rows
WHEN OLD.posted_transaction_id IS NOT NULL AND (
  NEW.posted_transaction_id IS NOT OLD.posted_transaction_id
  OR NEW.state <> OLD.state OR NEW.excluded <> OLD.excluded
  OR NEW.posted_date IS NOT OLD.posted_date OR NEW.amount_cents IS NOT OLD.amount_cents
  OR NEW.merchant_text IS NOT OLD.merchant_text
  OR NEW.kind IS NOT OLD.kind OR NEW.kind_source IS NOT OLD.kind_source
  OR NEW.category_id IS NOT OLD.category_id
  OR NEW.duplicate_decision IS NOT OLD.duplicate_decision
  OR NEW.transfer_decision IS NOT OLD.transfer_decision
  OR NEW.review_required <> OLD.review_required
  OR NEW.changed_suggestions_json <> OLD.changed_suggestions_json
)
BEGIN SELECT RAISE(ABORT, 'a row that already posted cannot be reviewed or posted again'); END;

CREATE TRIGGER import_rows_version_forward BEFORE UPDATE ON import_rows
WHEN NEW.version < OLD.version
BEGIN SELECT RAISE(ABORT, 'import row version cannot go backward'); END;

-- Rows may not be added to a finished import, whichever way it finished.
CREATE TRIGGER import_rows_open_batch_only BEFORE INSERT ON import_rows
WHEN (SELECT status FROM import_batches WHERE id = NEW.import_id)
  IN ('committed', 'cancelled', 'expired', 'failed')
BEGIN SELECT RAISE(ABORT, 'a finished import cannot gain rows'); END;

-- Abandoning a preview purges unfinished rows only. A row that posted a
-- transaction stays, so the owner can still see where that transaction came
-- from. Its evidence and posting record are protected separately.
CREATE TRIGGER import_rows_posted_no_delete BEFORE DELETE ON import_rows
WHEN OLD.posted_transaction_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a row that already posted cannot be purged'); END;

-- Audit events can now be about an import.
CREATE TABLE audit_events_new (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  command_id TEXT CHECK (command_id IS NULL OR length(command_id) = 36),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('account', 'transaction', 'category', 'checkpoint', 'rule', 'rule_run', 'repair', 'transfer_pair', 'refund_link', 'budget', 'import')),
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

UPDATE ledger_metadata SET schema_version = 5 WHERE id = 1;
