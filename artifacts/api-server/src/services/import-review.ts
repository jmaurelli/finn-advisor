/**
 * Reading and saving import review work.
 *
 * Reading is not reviewing. A row list never changes a stored value and never
 * extends a review deadline; only an explicit save does.
 *
 * Saving never touches the file. The values the bank wrote are kept exactly as
 * they arrived and a correction changes the normalized value beside them, so
 * the evidence for a decision is still there after the decision is made.
 *
 * Nothing here posts a transaction, changes a balance or advances the finance
 * revision. A preview is working material until commit.
 */
import type { SqliteDatabase } from "@workspace/db";

import {
  evaluateAssignment, normalizeMerchantText, AssignmentTextError, INCOME_CATEGORY_ID, UNCATEGORIZED_ID,
  type Assignment, type TransactionKind,
} from "../domain/assignment.js";
import {
  classifyImportAmount, deriveImportRowState, deriveRowIssues, importIssueDto, isMoneyIssue,
  isValidationIssue, kindAllowsAmount, type RowIssueCode,
} from "../domain/imports.js";
import { MoneyFormatError, parseMoney, STORED_BOUND } from "../domain/money.js";
import { formatCounter } from "../domain/versions.js";
import { versionMismatch } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import type { ImportRowPage } from "../lib/import-schemas.js";
import { loadAssignmentRules } from "./assignment.js";
import { financeRevision, requireAccount } from "./ledger.js";
import { requireManualCategory } from "./transactions.js";
import { IMPORT_REVIEW_MS, importBatchDto, requireBatch, type ImportBatchRow } from "./imports.js";
import { applySuggestions, type ChangedSuggestion } from "./import-suggestions.js";

export type { ChangedSuggestion };

type RowDto = ImportRowPage["items"][number];

interface StoredImportRow {
  id: string;
  import_id: string;
  source_row_number: bigint;
  source_fields_json: string;
  posted_date: string | null;
  merchant_text: string | null;
  normalized_text: string | null;
  amount_cents: bigint | null;
  kind: RowDto["kind"];
  kind_source: RowDto["kindSource"];
  category_id: string | null;
  assignment_origin: NonNullable<RowDto["assignment"]>["origin"] | null;
  rule_id: string | null;
  rule_revision: bigint | null;
  state: RowDto["state"];
  issues_json: string;
  excluded: bigint;
  review_required: bigint;
  changed_suggestions_json: string;
  duplicate_status: RowDto["duplicate"]["status"];
  duplicate_matches_json: string;
  duplicate_match_count: bigint;
  duplicate_evidence_digest: string | null;
  duplicate_decision: RowDto["duplicate"]["decision"];
  transfer_candidate_json: string | null;
  transfer_counterpart_id: string | null;
  transfer_counterpart_version: bigint | null;
  transfer_decision: NonNullable<RowDto["transferCandidate"]>["decision"];
  posted_transaction_id: string | null;
  version: bigint;
}

function rowDto(row: StoredImportRow): RowDto {
  return {
    id: row.id,
    rowNumber: Number(row.source_row_number),
    state: row.state,
    sourceFields: JSON.parse(row.source_fields_json),
    normalized: {
      postedDate: row.posted_date,
      merchant: row.merchant_text,
      money: row.amount_cents === null ? null : { amountMinor: String(row.amount_cents), currency: "USD" },
    },
    issues: JSON.parse(row.issues_json),
    kind: row.kind,
    kindSource: row.kind_source,
    assignment: row.category_id === null ? null : {
      categoryId: row.category_id,
      origin: row.assignment_origin!,
      ruleId: row.rule_id,
      ruleRevision: row.rule_revision === null ? null : formatCounter(row.rule_revision),
    },
    duplicate: {
      status: row.duplicate_status,
      matches: JSON.parse(row.duplicate_matches_json),
      decision: row.duplicate_decision,
    },
    transferCandidate: row.transfer_candidate_json === null ? null : {
      ...JSON.parse(row.transfer_candidate_json), decision: row.transfer_decision,
    },
    excluded: row.excluded === 1n,
    reviewRequired: row.review_required === 1n,
    postedTransactionId: row.posted_transaction_id,
    version: formatCounter(row.version),
  };
}

/**
 * Whether this import still has review contents to show or change at all.
 * Checked at exactly the deadline, so a review cannot continue in the gap
 * before the cleanup sweep runs.
 */
export function requireAvailableContents(batch: ImportBatchRow, now: number): void {
  if (batch.status === "expired" || (batch.expires_at !== null && batch.expires_at <= BigInt(now))) {
    throw problem({ status: 410, code: "preview_expired", title: "Preview expired",
      detail: "This preview has expired. Upload the file again to start a new review." });
  }
  if (batch.status === "cancelled" || batch.status === "failed") {
    throw problem({ status: 410, code: "import_contents_deleted", title: "Review contents unavailable",
      detail: "This import no longer has review contents." });
  }
}

function rowPosition(raw: string | undefined, importId: string, state: string | undefined): number {
  if (raw === undefined) return 0;
  const invalid = () => problem({ status: 400, code: "invalid_cursor", title: "The list position is not valid",
    detail: "Reload the list from the first page using the same filters." });
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw invalid();
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw invalid();
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.v !== 1 || value.importId !== importId || value.state !== (state ?? null)
      || !Number.isInteger(value.rowNumber) || value.rowNumber < 1 || value.rowNumber > 25000
      || Object.keys(value).sort().join(",") !== "importId,rowNumber,state,v") throw invalid();
    return value.rowNumber;
  } catch {
    throw invalid();
  }
}

export function listImportRows(
  db: SqliteDatabase,
  now: number,
  importId: string,
  query: { state?: RowDto["state"]; cursor?: string; limit: number },
): ImportRowPage {
  const batch = requireBatch(db, importId);
  requireAvailableContents(batch, now);
  const position = rowPosition(query.cursor, importId, query.state);
  const rows = db.prepare(
    `SELECT * FROM import_rows WHERE import_id = ? AND source_row_number > ?
     ${query.state === undefined ? "" : "AND state = ?"}
     ORDER BY source_row_number LIMIT ?`,
  ).all(importId, position, ...(query.state === undefined ? [] : [query.state]), query.limit + 1) as StoredImportRow[];
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(rowDto),
    nextCursor: rows.length <= query.limit || last === undefined ? null : Buffer.from(JSON.stringify({
      v: 1, importId, state: query.state ?? null, rowNumber: Number(last.source_row_number),
    })).toString("base64url"),
    importVersion: formatCounter(batch.version),
  };
}

// ------------------------------------------------------------------ saving

export interface ReviewContext {
  db: SqliteDatabase;
  now: number;
  newId: () => string;
}

export interface ReviewOutcome {
  version: bigint;
  body: unknown;
}

/**
 * The gate every review save passes: the import still has contents, it is
 * still open for review, and the caller is working from the version it
 * actually saw. A stale tab is refused rather than allowed to overwrite.
 */
export function requireOpenPreview(
  db: SqliteDatabase,
  now: number,
  importId: string,
  expected: bigint,
): ImportBatchRow {
  const batch = requireBatch(db, importId);
  requireAvailableContents(batch, now);
  if (batch.status !== "preview") {
    throw problem({ status: 409, code: "import_not_open", title: "This import is not open for review",
      detail: batch.status === "committed"
        ? "This import is finished. Its rows can no longer be changed."
        : "This file is still being read. Wait for its preview and try again." });
  }
  if (batch.version !== expected) throw versionMismatch(batch.version);
  return batch;
}

function requireRow(db: SqliteDatabase, importId: string, rowId: string): StoredImportRow {
  const row = db.prepare("SELECT * FROM import_rows WHERE id = ? AND import_id = ?")
    .get(rowId, importId) as StoredImportRow | undefined;
  if (row === undefined) {
    throw problem({ status: 404, code: "not_found", title: "Not found",
      detail: "There is no row with that id in this import." });
  }
  return row;
}

function unprocessable(title: string, detail: string, path: string, code = "invalid_value"): never {
  throw problem({ status: 422, code: "validation_failed", title, detail,
    fieldErrors: [{ path, code, message: detail }] });
}

export interface RowPatch {
  postedDate?: string;
  money?: { amountMinor: string; currency: string };
  merchant?: string;
  kind?: TransactionKind;
  category?: { mode: "category"; categoryId: string } | { mode: "rules" };
  excluded?: boolean;
  duplicateDecision?: "include" | "exclude";
  transferDecision?: "confirm" | "reject";
}

/** The values a row would have after a save, before anything is written. */
interface NextRowState {
  postedDate: string | null;
  cents: bigint | null;
  merchant: string | null;
  normalizedText: string | null;
  kind: TransactionKind | null;
  kindSource: RowDto["kindSource"];
  assignment: Assignment | null;
  excluded: boolean;
  duplicateDecision: "include" | "exclude" | null;
  transferDecision: "confirm" | "reject" | null;
  issues: RowIssueCode[];
  state: RowDto["state"];
  changedSuggestions: ChangedSuggestion[];
}

/** The money issue already recorded, which a null amount cannot reproduce on its own. */
function retainedMoneyIssue(row: StoredImportRow): RowIssueCode | null {
  const codes = (JSON.parse(row.issues_json) as { code: string }[]).map(issue => issue.code);
  return (codes.find(isMoneyIssue) as RowIssueCode | undefined) ?? null;
}

/**
 * Rules evaluated in the caller's snapshot. A manual choice is passed through
 * as the current assignment, so evaluating rules again cannot quietly take a
 * category the owner picked. The account's own state is deliberately not
 * checked here: an archived account makes the preview stale and blocks commit,
 * which is where that belongs, and correcting a row meanwhile is harmless.
 */
function suggestAssignment(
  db: SqliteDatabase,
  accountId: string,
  kind: TransactionKind,
  normalizedMerchant: string,
  current: Assignment | undefined,
): Assignment {
  return evaluateAssignment({ accountId, kind, normalizedMerchant, current }, loadAssignmentRules(db));
}

/**
 * True when the category this action would write is rule-derived and is not the
 * one the row already stored, so the owner has not seen it.
 */
function adoptsUnacknowledgedCategory(row: StoredImportRow, next: Assignment | null): boolean {
  if (next === null || next.origin !== "rule") return false;
  return row.category_id !== next.categoryId
    || row.assignment_origin !== "rule"
    || row.rule_id !== next.ruleId
    || (row.rule_revision === null ? null : String(row.rule_revision))
      !== (next.ruleRevision == null ? null : String(next.ruleRevision));
}

function currentAssignment(row: StoredImportRow): Assignment | undefined {
  if (row.assignment_origin === null || row.category_id === null) return undefined;
  if (row.assignment_origin === "manual") {
    return { origin: "manual", categoryId: row.category_id, ruleId: null, ruleRevision: null };
  }
  return undefined;
}

function normalizedOf(merchant: string | null, path: string): string | null {
  if (merchant === null) return null;
  try {
    return normalizeMerchantText(merchant);
  } catch (error) {
    if (error instanceof AssignmentTextError) unprocessable("Unusable description", error.message, path);
    throw error;
  }
}

/**
 * Works out what one row becomes, refusing anything the contract does not
 * allow before a single value is written.
 */
function nextRowState(
  db: SqliteDatabase,
  batch: ImportBatchRow,
  row: StoredImportRow,
  patch: RowPatch,
): NextRowState {
  const postedDate = patch.postedDate ?? row.posted_date;
  let cents = row.amount_cents;
  if (patch.money !== undefined) {
    try {
      cents = parseMoney(patch.money, STORED_BOUND);
    } catch (error) {
      if (error instanceof MoneyFormatError) unprocessable("Unusable amount", error.message, "/money");
      throw error;
    }
  }
  const merchant = patch.merchant ?? row.merchant_text;
  const normalizedText = normalizedOf(merchant, "/merchant");

  let kind = row.kind;
  let kindSource = row.kind_source;
  if (patch.kind !== undefined) {
    if (cents === null || cents === 0n) {
      unprocessable("Correct the amount first",
        "Correct this row's amount before choosing its type.", "/kind");
    }
    if (!kindAllowsAmount(patch.kind, cents)) {
      throw problem({ status: 422, code: "kind_sign_mismatch", title: "Type does not fit the amount",
        detail: cents < 0n ? "A negative amount can be a purchase or transfer. Nothing was changed."
          : "A positive amount can be a refund, income or transfer. Nothing was changed.",
        fieldErrors: [{ path: "/kind", code: "kind_sign_mismatch",
          message: cents < 0n ? "Choose purchase or transfer." : "Choose refund, income or transfer." }] });
    }
    kind = patch.kind;
    kindSource = "owner";
  } else if (kind !== null && (cents === null || cents === 0n || !kindAllowsAmount(kind, cents))) {
    // A corrected amount can leave the old type impossible. Rather than keep a
    // type the amount contradicts, the row goes back to needing a choice.
    kind = null;
    kindSource = null;
  }
  if (kind === null && patch.money !== undefined && cents !== null && cents !== 0n) {
    const derived = classifyImportAmount(cents);
    kind = derived.kind;
    kindSource = derived.kindSource;
  }

  let transferDecision = row.transfer_decision;
  if (patch.transferDecision !== undefined) {
    if (row.transfer_candidate_json === null) {
      unprocessable("No transfer match to decide",
        "This row has no suggested transfer match.", "/transferDecision");
    }
    const candidate = JSON.parse(row.transfer_candidate_json) as { eligible?: unknown };
    if (patch.transferDecision === "confirm") {
      if (candidate.eligible !== true) {
        unprocessable("That match can no longer be used",
          "This suggested transfer match is no longer available. Refresh and review it again.",
          "/transferDecision");
      }
      kind = "transfer";
      kindSource = "transfer_candidate";
    }
    transferDecision = patch.transferDecision;
  }
  if (transferDecision === "confirm" && kind !== "transfer") {
    unprocessable("This row is a confirmed transfer",
      "Reject the suggested transfer match before giving this row another type.", "/kind");
  }

  let duplicateDecision = row.duplicate_decision;
  if (patch.duplicateDecision !== undefined) {
    if (row.duplicate_status === "none") {
      unprocessable("No duplicate to decide",
        "This row is not a suspected duplicate.", "/duplicateDecision");
    }
    if (row.duplicate_status === "confirmed" && patch.duplicateDecision === "include") {
      throw problem({ status: 409, code: "duplicate_source_identity",
        title: "Your bank says this is already imported",
        detail: "This row matches a record already imported from this account. It can only be left out." });
    }
    duplicateDecision = patch.duplicateDecision;
  }

  const excluded = patch.excluded ?? row.excluded === 1n;
  // Putting a row back in withdraws the exclusion decision that took it out.
  // Without this the decision survives the save, and if its evidence has since
  // changed the rediscover pass promotes it straight back to an exclusion -
  // answering 200 to an instruction it had just reversed.
  if (patch.excluded === false && duplicateDecision === "exclude") duplicateDecision = null;

  // The category follows the type: income uses Income, a transfer has none,
  // and only a purchase or refund can carry an explicit choice.
  let assignment: Assignment | null = currentAssignment(row) ?? null;
  const expense = kind === "purchase" || kind === "refund";
  if (patch.category !== undefined && !expense) {
    unprocessable(kind === null ? "Choose a type first" : "No category for this type",
      kind === null ? "Choose this row's type before choosing a category."
        : "Income uses Income and transfers have no category.", "/category", "not_allowed");
  }
  if (kind === "income") {
    assignment = { origin: "system", categoryId: INCOME_CATEGORY_ID, ruleId: null, ruleRevision: null };
  } else if (kind === "transfer") {
    assignment = null;
  } else if ((kind === "purchase" || kind === "refund") && normalizedText !== null) {
    if (patch.category?.mode === "category") {
      assignment = { origin: "manual", ruleId: null, ruleRevision: null,
        categoryId: requireChosenCategory(db, patch.category.categoryId) };
    } else {
      // An explicit return to rules drops the manual choice; anything else
      // keeps it and only refreshes what the rules would say.
      assignment = suggestAssignment(db, batch.account_id, kind, normalizedText,
        patch.category?.mode === "rules" ? undefined : currentAssignment(row));
    }
  } else if (kind === null) {
    assignment = null;
  }

  const transferPending = row.transfer_candidate_json !== null && transferDecision === null;
  const issues = deriveRowIssues({
    postedDate, cents, merchant, kind,
    trackingStartDate: requireAccount(db, batch.account_id).tracking_start_date,
    retainedMoneyIssue: patch.money === undefined ? retainedMoneyIssue(row) : null,
    duplicateStatus: row.duplicate_status, duplicateDecision, transferPending,
    // An explicit, version-matched save acknowledges the changed suggestions
    // this row was displaying.
    changedSuggestions: [],
  });
  return {
    postedDate, cents, merchant, normalizedText, kind, kindSource, assignment, excluded,
    duplicateDecision, transferDecision, issues, changedSuggestions: [],
    state: deriveImportRowState({
      excluded, hasValidationIssues: issues.some(isValidationIssue), reviewRequired: false,
      duplicateStatus: row.duplicate_status, duplicateDecision, transferReviewPending: transferPending,
    }),
  };
}

function requireChosenCategory(db: SqliteDatabase, id: string): string {
  if (db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id.toLowerCase()) === undefined) {
    unprocessable("Unknown category", "Choose an existing category.", "/category/categoryId");
  }
  return requireManualCategory(db, id);
}

function writeRow(context: ReviewContext, row: StoredImportRow, next: NextRowState): StoredImportRow {
  const { db, now } = context;
  db.prepare(
    `UPDATE import_rows SET posted_date = ?, merchant_text = ?, normalized_text = ?, amount_cents = ?,
       kind = ?, kind_source = ?, category_id = ?, assignment_origin = ?, rule_id = ?, rule_revision = ?,
       state = ?, issues_json = ?, excluded = ?, review_required = ?, changed_suggestions_json = ?,
       duplicate_decision = ?, transfer_decision = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.postedDate, next.merchant, next.normalizedText,
    next.cents === null ? null : Number(next.cents),
    next.kind, next.kindSource,
    next.assignment?.categoryId ?? null, next.assignment === null ? null : next.assignment.origin,
    next.assignment?.ruleId ?? null,
    next.assignment?.ruleRevision === undefined || next.assignment.ruleRevision === null
      ? null : Number(next.assignment.ruleRevision),
    next.state, JSON.stringify(next.issues.map(importIssueDto)), next.excluded ? 1 : 0,
    next.changedSuggestions.length === 0 ? 0 : 1, JSON.stringify(next.changedSuggestions),
    next.duplicateDecision, next.transferDecision, now, row.id,
  );
  return db.prepare("SELECT * FROM import_rows WHERE id = ?").get(row.id) as StoredImportRow;
}

/**
 * A successful explicit save is review activity: the deadline moves to thirty
 * days from now, and the batch version advances so any other tab holding the
 * old one is refused rather than allowed to overwrite this.
 */
function recordReviewActivity(context: ReviewContext, batch: ImportBatchRow): ImportBatchRow {
  const { db, now } = context;
  db.prepare(
    `UPDATE import_batches SET version = version + 1, last_reviewed_at = ?, expires_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(now, now + IMPORT_REVIEW_MS, now, batch.id);
  return db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batch.id) as ImportBatchRow;
}

function requireUnposted(row: StoredImportRow): void {
  if (row.posted_transaction_id === null) return;
  unprocessable("This row is already added",
    "This row was already added to your ledger and can no longer be changed.", "/");
}

/** Saves one row's corrections and decisions. */
export function saveImportRow(
  context: ReviewContext,
  importId: string,
  rowId: string,
  expected: bigint,
  patch: RowPatch,
  check: (body: unknown) => unknown,
): ReviewOutcome {
  const { db, now } = context;
  const batch = requireOpenPreview(db, now, importId, expected);
  const row = requireRow(db, importId, rowId);
  requireUnposted(row);
  writeRow(context, row, nextRowState(db, batch, row, patch));
  // A correction can create a duplicate or a transfer match nobody has seen.
  // It is discovered here, in the same write, and held for its own decision:
  // this save cannot have approved a candidate it just revealed.
  applySuggestions(context, batch, "rediscover", row.id);
  const saved = db.prepare("SELECT * FROM import_rows WHERE id = ?").get(row.id) as StoredImportRow;
  const savedBatch = recordReviewActivity(context, batch);
  return {
    version: savedBatch.version,
    body: check({ row: rowDto(saved), import: importBatchDto(db, savedBatch) }),
  };
}

/**
 * Applies one row's type to every row in this preview with the same normalized
 * description. Only within this preview: it is not a saved rule, and it never
 * reaches a row whose sign contradicts the type or a row already left out.
 */
export function bulkSetRowType(
  context: ReviewContext,
  importId: string,
  expected: bigint,
  input: { rowId: string; kind: TransactionKind },
  check: (body: unknown) => unknown,
): ReviewOutcome {
  const { db, now } = context;
  const batch = requireOpenPreview(db, now, importId, expected);
  const selector = requireRow(db, importId, input.rowId);
  if (selector.normalized_text === null) {
    unprocessable("This row has no description",
      "Add a description to this row before applying its type to matching rows.", "/rowId");
  }
  const candidates = db.prepare(
    "SELECT * FROM import_rows WHERE import_id = ? AND normalized_text = ? ORDER BY source_row_number",
  ).all(importId, selector.normalized_text) as StoredImportRow[];

  const updatedRowIds: string[] = [];
  const skippedRowIds: string[] = [];
  for (const row of candidates) {
    if (!eligibleForBulkType(row, input.kind)) {
      skippedRowIds.push(row.id);
      continue;
    }
    const next = nextRowState(db, batch, row, { kind: input.kind });
    // Re-saving the same expense type must not consume an undiscovered rule
    // change before refresh can ask for acknowledgment.
    const expense = input.kind === "purchase" || input.kind === "refund";
    if (row.kind === input.kind && (row.kind === "purchase" || row.kind === "refund")) {
      if (row.assignment_origin === "rule" && row.category_id !== null
        && row.rule_id !== null && row.rule_revision !== null) {
        next.assignment = { origin: "rule", categoryId: row.category_id,
          ruleId: row.rule_id, ruleRevision: row.rule_revision };
      } else if (row.assignment_origin === "unassigned") {
        next.assignment = { origin: "unassigned", categoryId: UNCATEGORIZED_ID, ruleId: null, ruleRevision: null };
      } else {
        next.assignment = currentAssignment(row) ?? null;
      }
    }
    // Only the type suggestion is acknowledged here; a changed duplicate or
    // transfer suggestion on the same row still needs its own decision.
    next.changedSuggestions = changedSuggestionsOf(row).filter(aspect => aspect !== "kind");
    // Giving a row an expense type it did not have recomputes its category from
    // the rules as they are now, and this action carries that to every matching
    // row - including ones the owner has never opened. A category arrived at
    // that way is a suggestion, not a decision: it is recorded as changed so
    // refresh asks about it, exactly as a same-type action does. Without this,
    // two bulk actions in a row - out of an expense type and back into it -
    // could adopt and commit a rule change nobody acknowledged.
    if (expense && row.kind !== input.kind && adoptsUnacknowledgedCategory(row, next.assignment)
      && !next.changedSuggestions.includes("assignment")) {
      next.changedSuggestions = [...next.changedSuggestions, "assignment"];
    }
    if (next.changedSuggestions.length > 0) {
      next.issues = [...next.issues, "suggestion_changed"];
      next.state = next.state === "excluded" ? "excluded" : "held";
    }
    writeRow(context, row, next);
    updatedRowIds.push(row.id);
  }
  const savedBatch = recordReviewActivity(context, batch);
  return {
    version: savedBatch.version,
    body: check({ updatedRowIds, skippedRowIds, import: importBatchDto(db, savedBatch) }),
  };
}

export function changedSuggestionsOf(row: { changed_suggestions_json: string }): ChangedSuggestion[] {
  return JSON.parse(row.changed_suggestions_json) as ChangedSuggestion[];
}

/**
 * A bulk type choice reaches only rows it can leave consistent: not already
 * left out, not already posted, with a readable amount whose sign the type
 * allows, and not a row whose confirmed transfer match the type would break.
 */
function eligibleForBulkType(row: StoredImportRow, kind: TransactionKind): boolean {
  if (row.state === "excluded" || row.posted_transaction_id !== null) return false;
  if (row.amount_cents === null || row.amount_cents === 0n) return false;
  if (!kindAllowsAmount(kind, row.amount_cents)) return false;
  if (row.transfer_decision === "confirm" && kind !== "transfer") return false;
  return true;
}

/**
 * Recomputes suggestions against the ledger and the rules as they are now.
 *
 * Deliberately not review activity: refreshing does not extend the deadline,
 * so a page that polls cannot keep an abandoned preview alive. Corrections and
 * exclusions are kept; a decision whose evidence changed is not, and the row
 * asks again.
 *
 * The staleness the account's lifecycle causes is cleared here and only here,
 * and only when the account is active again: an archive followed by a
 * reactivation cannot make an old preview look current on its own.
 */
export function refreshImport(
  context: ReviewContext,
  importId: string,
  expected: bigint,
  check: (body: unknown) => unknown,
): ReviewOutcome {
  const { db, now } = context;
  const batch = requireOpenPreview(db, now, importId, expected);
  applySuggestions(context, batch, "refresh");
  const account = db.prepare("SELECT ledger_revision, archived_at FROM accounts WHERE id = ?")
    .get(batch.account_id) as { ledger_revision: bigint; archived_at: bigint | null };
  const ruleSet = db.prepare("SELECT rule_set_revision FROM ledger_metadata WHERE id = 1")
    .get() as { rule_set_revision: bigint };
  db.prepare(
    `UPDATE import_batches SET captured_ledger_revision = ?, captured_rule_set_revision = ?,
       captured_account_archived = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  ).run(account.ledger_revision, ruleSet.rule_set_revision, account.archived_at === null ? 0 : 1,
    now, batch.id);
  const saved = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batch.id) as ImportBatchRow;
  return {
    version: saved.version,
    body: check({ import: importBatchDto(db, saved), financeRevision: formatCounter(financeRevision(db)) }),
  };
}
