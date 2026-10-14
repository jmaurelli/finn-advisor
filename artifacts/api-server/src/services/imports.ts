/**
 * Import batches: reading them, and publishing a parsed preview atomically.
 *
 * Two rules shape everything here.
 *
 * A preview becomes visible all at once or not at all. Parsing collects rows
 * outside any transaction and publishes them in a single write, so a file that
 * fails half way through leaves a failed batch with no rows rather than a
 * partial preview the owner might act on.
 *
 * Nothing financial happens. Creating, parsing, failing and abandoning a
 * preview never post a transaction, never change a balance and never advance
 * the finance revision. Posting arrives with commit, in its own stage.
 */
import type { SqliteDatabase } from "@workspace/db";

import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import { formatCounter } from "../domain/versions.js";
import { normalizeMerchantText } from "../domain/assignment.js";
import { importIssueDto } from "../domain/imports.js";
import { applySuggestions } from "./import-suggestions.js";
import type { AdapterRow, ImportAdapter } from "../imports/adapters.js";
import { ImportFormatError, matchHeader, normalizeRow, type ColumnIndex } from "../imports/adapters.js";
import { ImportCsvError, readImportCsv } from "../lib/import-csv.js";
import { financeRevision } from "./ledger.js";

/** Thirty days of inactivity ends an unfinished review. */
export const IMPORT_REVIEW_MS = 30 * 24 * 60 * 60 * 1000;
/** A completed import keeps its stored copy for thirty days. */
export const UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ImportStatus =
  "receiving" | "parsing" | "preview" | "committed" | "cancelled" | "expired" | "failed";

const TERMINAL: ReadonlySet<string> = new Set(["committed", "cancelled", "expired", "failed"]);

export interface ImportBatchRow {
  id: string;
  account_id: string;
  format_id: string;
  format_version: bigint;
  filename: string;
  status: ImportStatus;
  parent_import_id: string | null;
  created_at: bigint;
  last_reviewed_at: bigint;
  expires_at: bigint | null;
  version: bigint;
  captured_ledger_revision: bigint;
  captured_rule_set_revision: bigint;
  captured_account_archived: bigint;
  failure_code: string | null;
  failure_message: string | null;
  result_rows: bigint | null;
  result_added: bigint | null;
  result_excluded: bigint | null;
  result_paired_transfers: bigint | null;
  result_json: string | null;
  completed_at: bigint | null;
  upload_retained_until: bigint | null;
  creation_digest: string;
  updated_at: bigint;
}

export interface UploadRow {
  storage_key: string;
  import_id: string;
  byte_size: bigint | null;
  sha256: string | null;
  state: "receiving" | "available" | "deletion_pending" | "deleted";
  retention_deadline: bigint | null;
  created_at: bigint;
  updated_at: bigint;
}

export interface ImportContext {
  db: SqliteDatabase;
  now: number;
  newId: () => string;
}

export function findBatch(db: SqliteDatabase, id: string): ImportBatchRow | undefined {
  return db.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as ImportBatchRow | undefined;
}

export function requireBatch(db: SqliteDatabase, id: string): ImportBatchRow {
  const row = findBatch(db, id);
  if (row === undefined) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no import with that id." });
  }
  return row;
}

export function findUpload(db: SqliteDatabase, importId: string): UploadRow | undefined {
  return db.prepare("SELECT * FROM uploads WHERE import_id = ?").get(importId) as UploadRow | undefined;
}

/** Which live or completed batch already owns this exact file for this account. */
export function findFileClaim(db: SqliteDatabase, accountId: string, sha256: string): string | undefined {
  const row = db.prepare("SELECT import_id FROM import_file_claims WHERE account_id = ? AND sha256 = ?")
    .get(accountId, sha256) as { import_id: string } | undefined;
  return row?.import_id;
}

export interface RowCounts { total: number; ready: number; held: number; excluded: number }

export function rowCounts(db: SqliteDatabase, importId: string): RowCounts {
  const rows = db.prepare("SELECT state, COUNT(*) AS n FROM import_rows WHERE import_id = ? GROUP BY state")
    .all(importId) as { state: string; n: bigint }[];
  const counts: RowCounts = { total: 0, ready: 0, held: 0, excluded: 0 };
  for (const row of rows) {
    const n = Number(row.n);
    counts.total += n;
    if (row.state === "ready") counts.ready += n;
    else if (row.state === "held") counts.held += n;
    else counts.excluded += n;
  }
  return counts;
}

/**
 * What changed under the preview since its suggestions were computed. A
 * category rename or a note edit elsewhere is deliberately not a ledger
 * change, so it does not make a preview stale.
 */
function staleReasons(db: SqliteDatabase, row: ImportBatchRow): string[] {
  if (TERMINAL.has(row.status)) return [];
  const reasons: string[] = [];
  const account = db.prepare("SELECT ledger_revision, archived_at FROM accounts WHERE id = ?")
    .get(row.account_id) as { ledger_revision: bigint; archived_at: bigint | null } | undefined;
  const ruleSet = db.prepare("SELECT rule_set_revision FROM ledger_metadata WHERE id = 1")
    .get() as { rule_set_revision: bigint };
  if (account !== undefined && account.ledger_revision !== row.captured_ledger_revision) reasons.push("ledger_changed");
  if (ruleSet.rule_set_revision !== row.captured_rule_set_revision) reasons.push("rules_changed");
  // An archive, or an archive-and-reactivate cycle, both require a refresh:
  // the preview must not quietly become current again.
  const archivedNow = account !== undefined && account.archived_at !== null;
  if (archivedNow || Number(row.captured_account_archived) === 1) reasons.push("account_archived");
  return reasons;
}

function commitBlockers(row: ImportBatchRow, counts: RowCounts, stale: readonly string[]): string[] {
  const blockers: string[] = [];
  if (TERMINAL.has(row.status)) blockers.push("not_open");
  if (row.status === "receiving" || row.status === "parsing") blockers.push("parsing");
  if (counts.held > 0) blockers.push("held_rows");
  if (stale.includes("ledger_changed") || stale.includes("rules_changed")) blockers.push("needs_refresh");
  if (stale.includes("account_archived")) blockers.push("account_archived");
  return blockers;
}

export function importBatchDto(db: SqliteDatabase, row: ImportBatchRow): Record<string, unknown> {
  const counts = ["cancelled", "expired", "failed"].includes(row.status)
    ? { total: 0, ready: 0, held: 0, excluded: 0 } : rowCounts(db, row.id);
  const stale = staleReasons(db, row);
  return {
    id: row.id,
    accountId: row.account_id,
    formatId: row.format_id,
    formatVersion: Number(row.format_version),
    filename: row.filename,
    status: row.status,
    parentImportId: row.parent_import_id,
    createdAt: isoTimestamp(Number(row.created_at)),
    lastReviewedAt: isoTimestamp(Number(row.last_reviewed_at)),
    expiresAt: row.expires_at === null ? null : isoTimestamp(Number(row.expires_at)),
    version: formatCounter(row.version),
    rowCounts: counts,
    staleReasons: stale,
    commitBlockers: commitBlockers(row, counts, stale),
    result: row.result_json === null ? null : {
      rows: Number(row.result_rows),
      added: Number(row.result_added),
      excluded: Number(row.result_excluded),
      pairedTransfers: Number(row.result_paired_transfers),
      completedAt: isoTimestamp(Number(row.completed_at)),
    },
    failure: row.failure_code === null ? null
      : { code: row.failure_code, message: row.failure_message },
    uploadRetainedUntil: row.upload_retained_until === null
      ? null : isoTimestamp(Number(row.upload_retained_until)),
  };
}

export function importCreateResult(
  db: SqliteDatabase,
  row: ImportBatchRow,
  disposition: "created" | "existing_preview" | "existing_completed",
): Record<string, unknown> {
  return {
    disposition,
    import: importBatchDto(db, row),
    financeRevision: formatCounter(financeRevision(db)),
  };
}

export interface CreateBatchInput {
  accountId: string;
  adapter: ImportAdapter;
  filename: string;
  sha256: string;
  byteSize: number;
  storageKey: string;
  creationDigest: string;
}

/**
 * Records a received upload as a batch that has bytes but no preview yet.
 * Written in one transaction with its stored-upload row so a crash can never
 * leave bytes nobody knows about, or a batch whose bytes were never saved.
 */
export function createReceivedBatch(context: ImportContext, input: CreateBatchInput): ImportBatchRow {
  const { db, now } = context;
  const id = context.newId();
  const account = db.prepare("SELECT ledger_revision, archived_at FROM accounts WHERE id = ?")
    .get(input.accountId) as { ledger_revision: bigint; archived_at: bigint | null };
  const ruleSet = db.prepare("SELECT rule_set_revision FROM ledger_metadata WHERE id = 1")
    .get() as { rule_set_revision: bigint };

  db.prepare(
    `INSERT INTO import_batches (id, account_id, format_id, format_version, filename, status,
       parent_import_id, created_at, last_reviewed_at, expires_at, version,
       captured_ledger_revision, captured_rule_set_revision, captured_account_archived,
       creation_digest, updated_at)
     VALUES (?, ?, ?, ?, ?, 'receiving', NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.accountId, input.adapter.id, input.adapter.version, input.filename,
    now, now, now + IMPORT_REVIEW_MS,
    account.ledger_revision, ruleSet.rule_set_revision, account.archived_at === null ? 0 : 1,
    input.creationDigest, now,
  );
  db.prepare(
    `INSERT INTO uploads (storage_key, import_id, byte_size, sha256, state, retention_deadline,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'available', NULL, ?, ?)`,
  ).run(input.storageKey, id, input.byteSize, input.sha256, now, now);

  const row = findBatch(db, id);
  if (row === undefined) throw new Error("import batch disappeared immediately after insert");
  return row;
}

export interface ParsedPreview {
  rows: readonly AdapterRow[];
}

/**
 * Reads the stored bytes through the pinned adapter. Rows are collected here,
 * outside any transaction, because the reader can hand over early records and
 * then fail: nothing may be written until the whole file has been read.
 */
export async function parseStoredUpload(
  adapter: ImportAdapter,
  source: AsyncIterable<Uint8Array>,
): Promise<ParsedPreview> {
  const rows: AdapterRow[] = [];
  let columns: ColumnIndex | null = null;
  // The header is the first record after the declared preamble, and row
  // numbers count from it, so a row still points at the same physical line.
  const headerRecord = adapter.preambleLines + 1;
  await readImportCsv(source, (fields, recordNumber) => {
    if (recordNumber < headerRecord) return;
    if (recordNumber === headerRecord) {
      columns = matchHeader(adapter, fields);
      return;
    }
    const row = normalizeRow(adapter, columns!, fields, recordNumber - headerRecord);
    if (row !== null) rows.push(row);
  });
  if (columns === null) throw new ImportCsvError("unreadable_file");
  return { rows };
}

/** The contract's declared failure codes, as this stage can produce them. */
export function importFailureOf(error: unknown): { code: string; message: string } | undefined {
  if (error instanceof ImportCsvError) return { code: error.code, message: error.message };
  if (error instanceof ImportFormatError) return { code: error.code, message: error.message };
  return undefined;
}

/**
 * Publishes a preview unless another attempt for the same account and the same
 * bytes claimed them first, and says which.
 *
 * Two uploads of one file can overlap: both look for a claim before either has
 * parsed, so both can find none. The claim is therefore re-read here, inside
 * the write that would publish, and the later attempt gives way instead of
 * failing on the unique key. Its bytes are redundant, so it ends as a
 * cancelled attempt with its stored copy marked for deletion, and the caller
 * is sent to the one preview that exists.
 *
 * Returns the id of the batch that already owns the file, or null when this
 * batch published its own preview.
 */
export function publishPreviewUnlessClaimed(
  context: ImportContext,
  batch: ImportBatchRow,
  parsed: ParsedPreview,
  sha256: string,
): string | null {
  const current = requireBatch(context.db, batch.id);
  if (["cancelled", "expired", "failed"].includes(current.status)) return current.id;
  const owner = findFileClaim(context.db, batch.account_id, sha256);
  if (owner !== undefined && owner !== batch.id) {
    abandonRedundantAttempt(context, batch);
    return owner;
  }
  publishPreview(context, batch, parsed, sha256);
  return null;
}

/**
 * Ends an attempt whose bytes turned out to be a file this account already
 * has. Not a failure: nothing went wrong with the file, and the owner has a
 * usable preview of it. No claim is released, because this attempt never held
 * one, and no rows are removed, because it never published any.
 */
export function abandonRedundantAttempt(context: ImportContext, batch: ImportBatchRow): void {
  const { db, now } = context;
  db.prepare(
    `UPDATE import_batches SET status = 'cancelled', expires_at = NULL, version = version + 1,
       updated_at = ? WHERE id = ?`,
  ).run(now, batch.id);
  db.prepare(
    "UPDATE uploads SET state = 'deletion_pending', updated_at = ? WHERE import_id = ? AND state = 'available'",
  ).run(now, batch.id);
}

/**
 * Publishes a parsed file as a reviewable preview: every row, the file claim
 * and the status change land in one write, so no caller can observe a preview
 * that is missing some of its evidence.
 */
export function publishPreview(
  context: ImportContext,
  batch: ImportBatchRow,
  parsed: ParsedPreview,
  sha256: string,
): void {
  const { db, now } = context;
  const insert = db.prepare(
    `INSERT INTO import_rows (id, import_id, source_row_number, source_fields_json, source_record_id,
       bank_identity_namespace, bank_transaction_id,
       posted_date, merchant_text, normalized_text, amount_cents, kind, kind_source,
       category_id, assignment_origin, rule_id, rule_revision, state, issues_json, excluded,
       review_required, changed_suggestions_json, duplicate_status, duplicate_matches_json,
       duplicate_match_count, duplicate_evidence_digest, duplicate_decision,
       transfer_candidate_json, transfer_counterpart_id, transfer_counterpart_version,
       transfer_decision, posted_transaction_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0,
       0, '[]', 'none', '[]', 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
  );
  for (const row of parsed.rows) {
    const issues = row.issues.map(importIssueDto);
    insert.run(
      context.newId(), batch.id, row.rowNumber, JSON.stringify(row.sourceFields),
      row.identity?.namespace ?? null, row.identity?.bankTransactionId ?? null,
      row.postedDate, row.merchant, row.merchant === null ? null : normalizeMerchantText(row.merchant),
      row.cents === null ? null : Number(row.cents), row.kind, row.kindSource,
      issues.length === 0 ? "ready" : "held", JSON.stringify(issues), now, now,
    );
  }
  // Rule, duplicate and transfer suggestions are computed in this same write:
  // a preview becomes visible with all of its evidence or not at all, so no
  // caller can act on rows whose duplicate checks had not run yet.
  applySuggestions(context, batch, "publish");
  db.prepare(
    "UPDATE import_batches SET status = 'preview', version = version + 1, updated_at = ? WHERE id = ?",
  ).run(now, batch.id);
  // The claim goes in with the rows: a second upload of the same file must
  // not be able to slip past between publishing and claiming.
  db.prepare("INSERT INTO import_file_claims (account_id, sha256, import_id, created_at) VALUES (?, ?, ?, ?)")
    .run(batch.account_id, sha256, batch.id, now);
}

/** Records that stored bytes intended for deletion are gone. */
export function markUploadDeleted(db: SqliteDatabase, storageKey: string, now: number): void {
  db.prepare(
    `UPDATE uploads SET state = 'deleted', updated_at = ?
     WHERE storage_key = ? AND state = 'deletion_pending'`,
  ).run(now, storageKey);
}

/** Records a safe failure and leaves no rows behind. */
export function failBatch(
  context: ImportContext,
  batch: ImportBatchRow,
  failure: { code: string; message: string },
): void {
  const { db, now } = context;
  if (["cancelled", "expired", "committed", "failed"].includes(requireBatch(db, batch.id).status)) return;
  db.prepare("DELETE FROM import_rows WHERE import_id = ? AND posted_transaction_id IS NULL").run(batch.id);
  db.prepare(
    `UPDATE import_batches SET status = 'failed', expires_at = NULL, failure_code = ?,
       failure_message = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  ).run(failure.code, failure.message.slice(0, 300), now, batch.id);
  // A failed attempt does not keep recognising its file: uploading it again
  // starts a fresh attempt.
  db.prepare("DELETE FROM import_file_claims WHERE import_id = ?").run(batch.id);
  db.prepare("UPDATE uploads SET state = 'deletion_pending', updated_at = ? WHERE import_id = ? AND state = 'available'")
    .run(now, batch.id);
}

export interface ImportPageResult {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  financeRevision: string;
}

/** Newest first, by creation time then id, so the order is total and stable. */
export function listImports(
  db: SqliteDatabase,
  filters: { accountId?: string; status?: string },
  limit: number,
  cursor: { createdAt: number; id: string } | undefined,
): ImportPageResult {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.accountId !== undefined) { where.push("account_id = ?"); params.push(filters.accountId); }
  if (filters.status !== undefined) { where.push("status = ?"); params.push(filters.status); }
  if (cursor !== undefined) { where.push("(created_at, id) < (?, ?)"); params.push(cursor.createdAt, cursor.id); }
  const rows = db.prepare(
    `SELECT * FROM import_batches ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params, limit + 1) as ImportBatchRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(row => importBatchDto(db, row)),
    nextCursor: rows.length <= limit || last === undefined ? null
      : Buffer.from(JSON.stringify({ v: 1, createdAt: Number(last.created_at), id: last.id })).toString("base64url"),
    financeRevision: formatCounter(financeRevision(db)),
  };
}
