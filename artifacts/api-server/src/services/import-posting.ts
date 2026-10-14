import type { SqliteDatabase } from "@workspace/db";
import type { Assignment } from "../domain/assignment.js";
import { formatCounter, nextCounter, requireIfMatch } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import type { CommandContext } from "./accounts.js";
import { loadAssignmentRules } from "./assignment.js";
import { requireOpenPreview, type ReviewOutcome } from "./import-review.js";
import { suggestForBatch, type StoredSuggestionRow } from "./import-suggestions.js";
import { findBatch, findUpload, importBatchDto, requireBatch, UPLOAD_RETENTION_MS, type ImportBatchRow } from "./imports.js";
import { financeRevision, requireAccount, requireActiveAccount, writeAudit, type AccountRow } from "./ledger.js";
import { createTransferPair, invalidatedLinks } from "./links.js";
import { postTransaction } from "./posting.js";
import { requireTransaction } from "./transactions.js";

export interface PostingRow extends StoredSuggestionRow {
  state: "ready" | "held" | "excluded";
  source_fields_json: string;
  source_record_id: string | null;
}

/**
 * Where these rows are being posted from, and therefore which coverage they are
 * checked against and how an unusable one is reported.
 *
 * A baseline extension is the awkward case. Its rows are deliberately held for
 * coverage - that is the whole reason the owner is moving the start - so the
 * one issue the check must forgive is the one the same command is about to fix.
 * It also has a different vocabulary: the baseline operation declares 422 for a
 * selection it cannot use, and must never leak the import endpoints' codes.
 */
export interface PostingScope {
  /** The start these rows must be covered by: the new one during a baseline change. */
  trackingStart: string | null;
  /** True only while a baseline change in this same transaction supplies that start. */
  coverageResolved: boolean;
  /** Which refusal an unresolved row produces, in the calling operation's own terms. */
  unresolved: "held_rows_unresolved" | "validation_failed";
  /**
   * The rows to post, when that is fewer than the whole preview. The other rows
   * are still handed to the checks, because a within-file duplicate or a
   * repeated bank id is a fact about the file rather than about the selection;
   * they are simply left open instead of posted.
   */
  selected: ReadonlySet<string> | null;
}

export const COMMIT_SCOPE: PostingScope = {
  trackingStart: null, coverageResolved: false, unresolved: "held_rows_unresolved", selected: null,
};

function stale(): never {
  throw problem({ status: 409, code: "preview_stale", title: "Review needs refreshing",
    detail: "The inputs to this preview changed. Refresh and review it again. Nothing was added." });
}

function held(scope: PostingScope): never {
  if (scope.unresolved === "validation_failed") {
    const detail = "Some selected rows still need a decision, or do not fit the requested start. "
      + "Nothing was added and the start is unchanged.";
    throw problem({ status: 422, code: "validation_failed", title: "Those rows cannot be added yet",
      detail, fieldErrors: [{ path: "/heldRows/rowIds", code: "invalid_value", message: detail }] });
  }
  throw problem({ status: 409, code: "held_rows_unresolved", title: "Finish reviewing first",
    detail: "Some rows still need a decision or extended tracking coverage. Nothing was added." });
}

function assignmentMatches(row: PostingRow, next: Assignment | null): boolean {
  return row.category_id === (next?.categoryId ?? null)
    && row.assignment_origin === (next?.origin ?? null)
    && row.rule_id === (next?.ruleId ?? null)
    && (row.rule_revision === null ? null : String(row.rule_revision))
      === (next?.ruleRevision == null ? null : String(next.ruleRevision));
}

/** Read every claim before posting any row; all checks use the caller's write snapshot. */
export function validateImportPostingRows(context: CommandContext, batch: ImportBatchRow,
  rows: readonly PostingRow[], scope: PostingScope = COMMIT_SCOPE): void {
  const { db } = context;
  if (!db.inTransaction) throw new Error("Import posting requires the caller's write transaction");
  const account = requireAccount(db, batch.account_id);
  requireActiveAccount(account);
  const revisions = db.prepare("SELECT rule_set_revision FROM ledger_metadata WHERE id = 1")
    .get() as { rule_set_revision: bigint };
  if (account.ledger_revision !== batch.captured_ledger_revision || batch.captured_account_archived !== 0n
    || revisions.rule_set_revision !== batch.captured_rule_set_revision) stale();
  // During a baseline extension this is the requested start, read before the
  // account is updated: the check must not be told the answer it is verifying.
  const trackingStart = scope.trackingStart ?? account.tracking_start_date;
  const suggestions = suggestForBatch(db, batch, rows);
  const counterparts = new Set<string>();
  const identities = new Set<string>();
  const sources = new Set<string>();
  for (const row of rows) {
    if (row.posted_transaction_id !== null || row.state === "excluded") continue;
    if (scope.selected !== null && !scope.selected.has(row.id)) continue;
    // Coverage is the one issue a baseline extension forgives, because the same
    // command supplies the start that resolves it. Every other reason a row is
    // held still holds it, and a row held for nothing but coverage is otherwise
    // ready, so the states below stay in step with the issues.
    const issues = (JSON.parse(row.issues_json) as { code: string }[]).map(issue => issue.code)
      .filter(code => !(scope.coverageResolved && code === "before_tracking_start"));
    const settled = row.state === "ready" || (scope.coverageResolved && row.state === "held");
    if (!settled || row.review_required !== 0n || issues.length !== 0
      || row.posted_date === null || row.amount_cents === null || row.merchant_text === null || row.kind === null
      || row.posted_date < trackingStart) held(scope);
    const next = suggestions.get(row.id)!;
    if (next.duplicateStatus === "confirmed" || next.evidenceDigest !== row.duplicate_evidence_digest
      || (next.duplicateStatus === "suspected" && row.duplicate_decision !== "include")) stale();
    if (row.assignment_origin === "manual") {
      const category = db.prepare("SELECT archived_at, system_kind FROM categories WHERE id = ?")
        .get(row.category_id) as { archived_at: bigint | null; system_kind: string | null } | undefined;
      if (category === undefined || category.archived_at !== null || category.system_kind === "income") stale();
    } else if (!assignmentMatches(row, next.assignment)) stale();

    if (row.bank_transaction_id !== null) {
      const key = JSON.stringify([row.bank_identity_namespace, row.bank_transaction_id]);
      if (identities.has(key)) stale();
      identities.add(key);
    }
    const source = existingSource(db, batch, row);
    if (source !== undefined) {
      if (sources.has(source) || db.prepare("SELECT 1 FROM import_postings WHERE source_record_id = ?").get(source)) stale();
      sources.add(source);
    }

    // New or changed suggestions require review even when the old choice was rejection.
    if (row.transfer_decision === "confirm" && row.transfer_counterpart_id !== null) {
      const counterpart = requireTransaction(db, row.transfer_counterpart_id);
      if (counterpart.kind !== "transfer") requireActiveAccount(requireAccount(db, counterpart.account_id));
    }
    if (JSON.stringify(next.transfer) !== JSON.stringify(row.transfer_candidate_json === null
      ? null : JSON.parse(row.transfer_candidate_json))) stale();
    if (next.transfer !== null && row.transfer_decision === null) held(scope);
    if (row.transfer_decision !== "confirm") continue;
    const id = row.transfer_counterpart_id;
    if (id === null || counterparts.has(id) || row.kind !== "transfer") stale();
    counterparts.add(id);
    const counterpart = requireTransaction(db, id);
    if (counterpart.version !== row.transfer_counterpart_version || counterpart.lifecycle !== "active"
      || counterpart.account_id === batch.account_id || counterpart.amount_cents !== -row.amount_cents
      || db.prepare("SELECT 1 FROM transfer_legs WHERE transaction_id = ?").get(id)) stale();
    if (counterpart.kind !== "transfer") {
      requireActiveAccount(requireAccount(db, counterpart.account_id));
      const invalid = invalidatedLinks(db, counterpart,
        { kind: "transfer", lifecycle: "active", amountCents: counterpart.amount_cents });
      if (invalid.refundLinkIds.length > 0 || invalid.transferPairIds.length > 0) stale();
    }
    if (next.transfer?.eligible !== true) stale();
  }
}

function existingSource(db: SqliteDatabase, batch: ImportBatchRow, row: PostingRow): string | undefined {
  if (row.source_record_id !== null) return row.source_record_id;
  return (db.prepare("SELECT id FROM import_source_records WHERE origin_import_id = ? AND origin_row_number = ?")
    .get(batch.id, row.source_row_number) as { id: string } | undefined)?.id;
}

/** Keep source evidence independently of the working row, including excluded rows for follow-ups. */
export function retainImportSource(context: CommandContext, batch: ImportBatchRow, row: PostingRow): string {
  const existing = existingSource(context.db, batch, row);
  if (existing !== undefined) return existing;
  const id = context.newId().toLowerCase();
  const snapshot = JSON.stringify(row, (_key, value: unknown) => typeof value === "bigint" ? String(value) : value);
  context.db.prepare(`INSERT INTO import_source_records (id, account_id, origin_import_id, origin_row_number,
    source_fields_json, normalized_json, category_id, rule_id, rule_revision, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, batch.account_id, batch.id, row.source_row_number,
    row.source_fields_json, snapshot, row.category_id, row.rule_id, row.rule_revision, context.now);
  return id;
}

/** Called only after all selected rows pass preflight, inside the same write transaction. */
export function postImportRows(context: CommandContext, batch: ImportBatchRow, rows: readonly PostingRow[],
  path: "commit" | "baseline_extension", scope: PostingScope = COMMIT_SCOPE): string[] {
  const { db, now } = context;
  if (!db.inTransaction) throw new Error("Import posting requires the caller's write transaction");
  const posted: string[] = [];
  // Read once for the whole commit rather than once per row: the rule set
  // cannot change inside this transaction, and preflight has already refused
  // the batch if it changed since the preview was captured.
  const rules = loadAssignmentRules(db);
  for (const row of rows) {
    if (row.posted_transaction_id !== null) continue;
    // An unselected row keeps its working state, including its source evidence:
    // it is still part of an open review, not something being disposed of.
    if (scope.selected !== null && !scope.selected.has(row.id)) continue;
    const sourceId = retainImportSource(context, batch, row);
    if (row.state === "excluded") continue;
    const transaction = postTransaction(context, {
      accountId: batch.account_id, postedDate: row.posted_date!, merchant: row.merchant_text!,
      money: { amountMinor: String(row.amount_cents), currency: "USD" }, kind: row.kind!,
      ...(row.assignment_origin === "manual" ? { category: { mode: "category" as const, categoryId: row.category_id! } } : {}),
    }, "import", rules);
    if (row.transfer_decision === "confirm") {
      createTransferPair(context, { id: context.newId().toLowerCase(), confirmKindChanges: true,
        legs: [{ transactionId: transaction.id, version: transaction.version },
          { transactionId: row.transfer_counterpart_id!, version: String(row.transfer_counterpart_version) }] }, body => body);
    }
    db.prepare(`INSERT INTO import_postings (id, source_record_id, transaction_id, posting_import_id,
      posting_row_number, posting_path, posted_at, paired_counterpart_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(context.newId().toLowerCase(), sourceId, transaction.id, batch.id, row.source_row_number, path, now,
        row.transfer_decision === "confirm" ? row.transfer_counterpart_id : null);
    if (row.bank_transaction_id !== null) {
      db.prepare(`INSERT INTO source_identities (account_id, provider_namespace, bank_transaction_id,
        transaction_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(batch.account_id, row.bank_identity_namespace, row.bank_transaction_id, transaction.id, now);
    }
    // A settled row is recorded as ready with no issues, which the schema
    // insists on and which is now simply true: the preflight proved the only
    // issue this row had left was the coverage the new start supplies. The
    // constraint is satisfied by making the row honest, not by relaxing it.
    db.prepare(`UPDATE import_rows SET posted_transaction_id = ?, state = 'ready', issues_json = '[]',
      review_required = 0, changed_suggestions_json = '[]', version = version + 1, updated_at = ?
      WHERE id = ?`).run(transaction.id, now, row.id);
    posted.push(transaction.id);
  }
  return posted;
}

/** Authentication precedes this call; replay precedes every mutable precondition, including If-Match. */
export function commitImport(context: CommandContext, importId: string, ifMatch: string | string[] | undefined,
  check: (body: unknown) => unknown): ReviewOutcome {
  const { db, now } = context;
  if (!db.inTransaction) throw new Error("Import commit requires the caller's write transaction");
  const existing = requireBatch(db, importId);
  if (existing.status === "committed") {
    return { version: existing.version, body: check(JSON.parse(existing.result_json!)) };
  }
  const batch = requireOpenPreview(db, now, importId, requireIfMatch(ifMatch));
  const rows = db.prepare("SELECT * FROM import_rows WHERE import_id = ? ORDER BY source_row_number")
    .all(batch.id) as PostingRow[];
  validateImportPostingRows(context, batch, rows);
  postImportRows(context, batch, rows, "commit");
  const counts = db.prepare(`SELECT COUNT(*) AS added, COUNT(paired_counterpart_id) AS paired
    FROM import_postings WHERE posting_import_id = ?`).get(batch.id) as { added: bigint; paired: bigint };
  const finished: ImportBatchRow = { ...batch, status: "committed", expires_at: null,
    version: nextCounter(batch.version), result_rows: BigInt(rows.length), result_added: counts.added,
    result_excluded: BigInt(rows.filter(row => row.state === "excluded").length), result_paired_transfers: counts.paired,
    result_json: "{}", completed_at: BigInt(now),
    upload_retained_until: findUpload(db, batch.id) === undefined ? null : BigInt(now + UPLOAD_RETENTION_MS),
    updated_at: BigInt(now) };
  const body = check({ import: importBatchDto(db, finished), financeRevision: String(financeRevision(db)) });
  db.prepare(`UPDATE import_batches SET status = 'committed', expires_at = NULL, version = ?, result_rows = ?,
    result_added = ?, result_excluded = ?, result_paired_transfers = ?, result_json = ?, completed_at = ?,
    upload_retained_until = ?, updated_at = ? WHERE id = ?`).run(finished.version, finished.result_rows,
    finished.result_added, finished.result_excluded, finished.result_paired_transfers, JSON.stringify(body), now,
    finished.upload_retained_until, now, batch.id);
  db.prepare("UPDATE uploads SET retention_deadline = ?, updated_at = ? WHERE import_id = ?")
    .run(finished.upload_retained_until, now, batch.id);
  writeAudit(db, context.newId, now, { entityType: "import", entityId: batch.id, accountId: batch.account_id,
    eventType: "import_committed", origin: "import",
    after: { added: Number(counts.added), excluded: Number(finished.result_excluded), pairedTransfers: Number(counts.paired) } });
  return { version: finished.version, body };
}

// ------------------------------------------- posting while extending coverage

export interface HeldRowSelection {
  importId: string;
  importVersion: string;
  rowIds: string[];
}

function selectionInvalid(path: string, detail: string): never {
  throw problem({ status: 422, code: "validation_failed", title: "Those rows cannot be added",
    detail, fieldErrors: [{ path, code: "invalid_value", message: detail }] });
}

/**
 * Posting held rows as part of extending an account's coverage backward.
 *
 * The order here is the whole point. Everything is checked against the account
 * as it still is - old start, captured ledger revision - and only then does the
 * caller apply the new start and call `postImportRows`. Updating the account
 * first would advance its ledger revision and make the very preview being
 * posted look stale to its own command.
 *
 * The refusals speak the baseline operation's language, never the import
 * endpoints': a preview that expired, was discarded, moved on or already posted
 * a selected row is a 409 `preview_stale`, and a selection that does not fit the
 * requested start is a 422. Nothing is posted and no start changes in either
 * case, so a refusal is never a partly applied baseline.
 */
export function prepareHeldRowPosting(context: CommandContext, account: AccountRow, requestedStart: string,
  selection: HeldRowSelection): { batch: ImportBatchRow; rows: PostingRow[]; scope: PostingScope } {
  const { db, now } = context;
  if (!db.inTransaction) throw new Error("Held row posting requires the caller's write transaction");

  // The generated request schema does not enforce `uniqueItems`, so the same row
  // asked for twice is caught here rather than posted twice.
  const rowIds = selection.rowIds.map(id => id.toLowerCase());
  if (new Set(rowIds).size !== rowIds.length) {
    selectionInvalid("/heldRows/rowIds", "The same row is listed more than once.");
  }

  const batch = findBatch(db, selection.importId.toLowerCase());
  if (batch === undefined || batch.account_id !== account.id) {
    selectionInvalid("/heldRows/importId", "There is no import preview with that id for this account.");
  }
  // An import that never reached a preview, or is still being read, is not a
  // review the owner can have selected rows from.
  if (batch.status === "receiving" || batch.status === "parsing") {
    selectionInvalid("/heldRows/importId", "That file is still being read. Wait for its preview.");
  }
  // Expired, discarded, failed or already committed: all the same to this
  // command, and all a conflict rather than a bad request.
  if (batch.status !== "preview" || (batch.expires_at !== null && batch.expires_at <= BigInt(now))) stale();
  if (formatCounter(batch.version) !== selection.importVersion) stale();

  const all = db.prepare("SELECT * FROM import_rows WHERE import_id = ? ORDER BY source_row_number")
    .all(batch.id) as PostingRow[];
  const byId = new Map(all.map(row => [row.id, row]));
  for (const id of rowIds) {
    const row = byId.get(id);
    if (row === undefined) selectionInvalid("/heldRows/rowIds", "One of those rows is not in this preview.");
    // Already posted by an earlier extension: the selection is working from a
    // view of the preview that has moved on.
    if (row.posted_transaction_id !== null) stale();
    if (row.state === "excluded") {
      selectionInvalid("/heldRows/rowIds", "A row left out of the import cannot be added by extending coverage.");
    }
    // Only rows the old start actually excluded belong in this command; a row
    // already inside coverage is ordinary review work, finished by committing.
    if (row.posted_date === null || row.posted_date >= account.tracking_start_date) {
      selectionInvalid("/heldRows/rowIds",
        "That row is not earlier than the current start, so extending coverage does not add it.");
    }
    if (row.posted_date < requestedStart) {
      selectionInvalid("/heldRows/rowIds", "That row is earlier than the start you asked for. "
        + "Choose an earlier start or leave the row for another change.");
    }
  }

  const scope: PostingScope = {
    trackingStart: requestedStart, coverageResolved: true,
    unresolved: "validation_failed", selected: new Set(rowIds),
  };
  validateImportPostingRows(context, batch, all, scope);
  return { batch, rows: all, scope };
}
