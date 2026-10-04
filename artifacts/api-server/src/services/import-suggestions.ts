/**
 * What the ledger says about a preview's rows: which of them may already be
 * recorded, which may be one side of a transfer, and which category the rules
 * would propose.
 *
 * Three rules shape this module.
 *
 * Nothing collapses on its own. A matching date, amount and description is
 * evidence for the owner to decide about, never a reason to drop a row. Only a
 * bank's own identifier for a record already imported is treated as settled,
 * and even then the row is left out rather than silently discarded.
 *
 * Every match is found, and at most twenty are shown. Consent to include a row
 * is consent to the whole evidence, so a fingerprint covers all of it, not
 * only the part that fits on the screen.
 *
 * The work is grouped, not per row. Rows are compared with the ledger and with
 * each other by indexed joins over the values being compared, so a
 * 25,000-row file does not read the ledger 25,000 times or compare every pair.
 */
import type { SqliteDatabase } from "@workspace/db";

import {
  evaluateAssignment, normalizeMerchantText, INCOME_CATEGORY_ID,
  type Assignment, type AssignmentRule,
} from "../domain/assignment.js";
import { addDays } from "../domain/dates.js";
import {
  deriveImportRowState, deriveRowIssues, importIssueDto, isMoneyIssue, isValidationIssue,
  type RowIssueCode,
} from "../domain/imports.js";
import { creationDigest } from "../domain/digest.js";
import { money } from "../domain/money.js";
import { formatCounter } from "../domain/versions.js";
import { loadAssignmentRules } from "./assignment.js";
import type { ImportBatchRow } from "./imports.js";

/** The seven-day window the ledger's own transfer suggestions use. */
export const TRANSFER_WINDOW_DAYS = 7;
/** The contract shows at most this many matches; detection is not limited to them. */
export const DISPLAYED_MATCHES = 20;

/** A suggestion a refresh changed, named so acknowledging one does not cover another. */
export type ChangedSuggestion = "kind" | "assignment" | "duplicate" | "transfer";

export type DuplicateReason = "bank_id" | "same_date_amount_description" | "within_file" | "matches_voided";

export interface DuplicateEvidence {
  transactionId: string | null;
  rowId: string | null;
  lifecycle: "active" | "void" | null;
  reason: DuplicateReason;
}

export interface TransferSuggestion {
  transactionId: string;
  accountId: string;
  counterpartKind: "purchase" | "refund" | "income" | "transfer";
  counterpartVersion: string;
  requiresKindChange: boolean;
  eligible: boolean;
  ineligibleReason: "already_paired" | "reactivation_required" | "voided" | "refund_links_present" | null;
  postedDate: string;
  money: { amountMinor: string; currency: string };
  daysApart: number;
}

export interface RowSuggestion {
  assignment: Assignment | null;
  duplicateStatus: "none" | "suspected" | "confirmed";
  /** At most twenty, in a stable order. */
  displayedMatches: DuplicateEvidence[];
  /** Every match found, including those beyond the twenty displayed. */
  matchCount: number;
  /** A fingerprint of all of the evidence, not only what is displayed. */
  evidenceDigest: string | null;
  transfer: TransferSuggestion | null;
}

/** The row values the suggestions are computed from. */
export interface SuggestionRow {
  id: string;
  source_row_number: bigint;
  posted_date: string | null;
  merchant_text: string | null;
  normalized_text: string | null;
  amount_cents: bigint | null;
  kind: "purchase" | "refund" | "income" | "transfer" | null;
  bank_identity_namespace: string | null;
  bank_transaction_id: string | null;
  excluded: bigint;
  posted_transaction_id: string | null;
}

const REASON_ORDER: readonly DuplicateReason[] = [
  "bank_id", "same_date_amount_description", "matches_voided", "within_file",
];

function compareEvidence(left: DuplicateEvidence, right: DuplicateEvidence): number {
  const byReason = REASON_ORDER.indexOf(left.reason) - REASON_ORDER.indexOf(right.reason);
  if (byReason !== 0) return byReason;
  const leftKey = `${left.transactionId ?? ""}${left.rowId ?? ""}`;
  const rightKey = `${right.transactionId ?? ""}${right.rowId ?? ""}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

/**
 * Every row of one preview, with the suggestions the current ledger and rules
 * produce for it. Read-only: the caller decides what to keep.
 */
export function suggestForBatch(
  db: SqliteDatabase,
  batch: ImportBatchRow,
  rows: readonly SuggestionRow[],
): Map<string, RowSuggestion> {
  // Rows may be a subset - one edited row - so the other side of a
  // within-file comparison is taken from the whole preview, not from `rows`.
  const target = rows.length === 1 ? rows[0]!.id : null;
  const evidence = collectDuplicateEvidence(db, batch, rows, target);
  const transfers = collectTransferSuggestions(db, batch, rows, target);
  const rules = loadAssignmentRules(db);
  const suggestions = new Map<string, RowSuggestion>();
  for (const row of rows) {
    const found = evidence.get(row.id);
    suggestions.set(row.id, {
      assignment: suggestAssignment(batch, row, rules),
      duplicateStatus: found === undefined || found.count === 0 ? "none"
        : found.confirmed ? "confirmed" : "suspected",
      displayedMatches: found?.displayed ?? [],
      matchCount: found?.count ?? 0,
      evidenceDigest: found?.digest ?? null,
      transfer: transfers.get(row.id) ?? null,
    });
  }
  return suggestions;
}

/**
 * The category the rules would propose. A manual choice is not reconsidered
 * here: the caller passes it through, because rules must never take a category
 * the owner picked.
 */
function suggestAssignment(
  batch: ImportBatchRow,
  row: SuggestionRow,
  rules: readonly AssignmentRule[],
): Assignment | null {
  if (row.kind === null) return null;
  if (row.kind === "transfer") return null;
  if (row.kind === "income") {
    return { origin: "system", categoryId: INCOME_CATEGORY_ID, ruleId: null, ruleRevision: null };
  }
  if (row.merchant_text === null) return null;
  return evaluateAssignment({
    accountId: batch.account_id, kind: row.kind,
    normalizedMerchant: row.normalized_text ?? normalizeMerchantText(row.merchant_text),
  }, rules);
}

interface IdentityMatch { row_id: string; transaction_id: string; lifecycle: "active" | "void" }
interface LedgerMatch { posted_date: string; amount_cents: bigint; normalized_text: string;
  transaction_id: string; lifecycle: "active" | "void" }
interface MemberRow { id: string; posted_date: string | null; amount_cents: bigint | null;
  normalized_text: string | null }

/** One row's evidence: what to show, how much there is, and a fingerprint of all of it. */
interface RowEvidence {
  displayed: DuplicateEvidence[];
  count: number;
  digest: string | null;
  confirmed: boolean;
}

/**
 * The comparison key duplicates are found by. A row missing any part of it
 * cannot match anything on date, amount and description, and has no group.
 */
function comparisonKey(postedDate: string | null, cents: bigint | null, normalized: string | null): string | null {
  if (postedDate === null || cents === null || normalized === null) return null;
  return JSON.stringify([postedDate, String(cents), normalized]);
}

/** Void postings sort after live ones, matching `REASON_ORDER`. */
const LIFECYCLE_RANK = "CASE WHEN t.lifecycle = 'void' THEN 1 ELSE 0 END";

/**
 * Evidence is collected per comparison key, never per pair.
 *
 * Rows that share a date, amount and description are each other's evidence and
 * share the ledger's, so the answer for a group of n rows is one group, not n
 * squared pairs. Collecting pairs is what a file of identical small charges
 * turns into an out-of-memory crash: 2,000 repeats took 43 seconds and 2 GiB,
 * and 4,000 exhausted the heap.
 *
 * Two things still have to be exactly what they were. The displayed matches
 * are the same first twenty in the same order, because each group is read in
 * the order `compareEvidence` sorts by and only the first twenty of each kind
 * can reach that list. The fingerprint still covers every match, because a
 * group's digest is taken over the whole group: adding, removing or voiding
 * any one member changes it for every row in the group, which is precisely
 * what withdrawing consent depends on.
 */
function collectDuplicateEvidence(
  db: SqliteDatabase,
  batch: ImportBatchRow,
  rows: readonly SuggestionRow[],
  target: string | null,
): Map<string, RowEvidence> {
  const only = target === null ? "" : "AND r.id = ?";
  const targetArgs = target === null ? [] : [target];
  // One key when a single edited row is being reconsidered; the whole preview
  // otherwise. Either way the group is read whole: the other side of a
  // within-file match may not be among `rows`.
  const keyFilter = target === null ? "" : `AND (posted_date, amount_cents, normalized_text) IN
      (SELECT posted_date, amount_cents, normalized_text FROM import_rows WHERE id = ?)`;

  // Rows that already posted are history and are never anybody's evidence.
  const members = db.prepare(`
    SELECT id, posted_date, amount_cents, normalized_text FROM import_rows
    WHERE import_id = ? AND posted_transaction_id IS NULL ${keyFilter}
    ORDER BY id
  `).all(batch.id, ...targetArgs) as MemberRow[];
  const groups = new Map<string, string[]>();
  for (const member of members) {
    const key = comparisonKey(member.posted_date, member.amount_cents, member.normalized_text);
    if (key === null) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [member.id]);
    else group.push(member.id);
  }

  // A bank identifier this account has already imported is settled evidence.
  // Voided transactions count: a void is not permission to import the record
  // again. At most one, because that identity is the table's primary key.
  const identities = db.prepare(`
    SELECT r.id AS row_id, t.id AS transaction_id, t.lifecycle
    FROM import_rows r
    JOIN source_identities s ON s.account_id = ? AND s.provider_namespace = r.bank_identity_namespace
      AND s.bank_transaction_id = r.bank_transaction_id
    JOIN transactions t ON t.id = s.transaction_id
    WHERE r.import_id = ? ${only} AND r.bank_transaction_id IS NOT NULL
      AND r.posted_transaction_id IS NULL
    ORDER BY r.source_row_number, t.id
  `).all(batch.account_id, batch.id, ...targetArgs) as IdentityMatch[];
  const byBankId = new Map<string, DuplicateEvidence[]>();
  for (const match of identities) {
    const list = byBankId.get(match.row_id);
    const evidence: DuplicateEvidence = { transactionId: match.transaction_id, rowId: null,
      lifecycle: match.lifecycle, reason: "bank_id" };
    if (list === undefined) byBankId.set(match.row_id, [evidence]);
    else list.push(evidence);
  }

  // One join per distinct key rather than per row. Without the explicit
  // candidate index SQLite can prefer source/date ordering over equality
  // lookup, which on a maximum same-day file is billions of comparisons.
  const ledger = db.prepare(`
    SELECT k.posted_date, k.amount_cents, k.normalized_text, t.id AS transaction_id, t.lifecycle
    FROM (
      SELECT DISTINCT posted_date, amount_cents, normalized_text FROM import_rows
      WHERE import_id = ? AND posted_transaction_id IS NULL ${keyFilter}
        AND posted_date IS NOT NULL AND amount_cents IS NOT NULL AND normalized_text IS NOT NULL
    ) k
    JOIN transactions t INDEXED BY transactions_import_candidates
      ON t.account_id = ? AND t.posted_date = k.posted_date
      AND t.amount_cents = k.amount_cents AND t.normalized_text = k.normalized_text
    ORDER BY k.posted_date, k.amount_cents, k.normalized_text, ${LIFECYCLE_RANK}, t.id
  `).all(batch.id, ...targetArgs, batch.account_id) as LedgerMatch[];
  const ledgerGroups = new Map<string, { transactionId: string; lifecycle: "active" | "void" }[]>();
  for (const match of ledger) {
    const key = comparisonKey(match.posted_date, match.amount_cents, match.normalized_text)!;
    const list = ledgerGroups.get(key);
    const entry = { transactionId: match.transaction_id, lifecycle: match.lifecycle };
    if (list === undefined) ledgerGroups.set(key, [entry]);
    else list.push(entry);
  }

  // A group's fingerprint is taken once and reused by every row in it.
  const groupDigests = new Map<string, string>();
  const digestOf = (kind: string, key: string, value: unknown): string => {
    const cacheKey = `${kind}${key}`;
    let digest = groupDigests.get(cacheKey);
    if (digest === undefined) {
      digest = creationDigest(value);
      groupDigests.set(cacheKey, digest);
    }
    return digest;
  };

  const found = new Map<string, RowEvidence>();
  const considered = new Set(members.map(member => member.id));
  for (const row of rows) {
    if (!considered.has(row.id)) continue;
    const bank = byBankId.get(row.id) ?? [];
    const key = comparisonKey(row.posted_date, row.amount_cents, row.normalized_text);
    const postings = key === null ? [] : ledgerGroups.get(key) ?? [];
    const group = key === null ? [] : groups.get(key) ?? [];
    const count = bank.length + postings.length + group.length - (group.length === 0 ? 0 : 1);
    if (count === 0) {
      found.set(row.id, { displayed: [], count: 0, digest: null, confirmed: bank.length > 0 });
      continue;
    }
    // Only the first twenty of each kind can reach the displayed twenty, since
    // every kind is already in the order the merge sorts by.
    const displayed = [...bank];
    for (const posting of postings.slice(0, DISPLAYED_MATCHES)) {
      displayed.push({ transactionId: posting.transactionId, rowId: null,
        lifecycle: posting.lifecycle,
        reason: posting.lifecycle === "void" ? "matches_voided" : "same_date_amount_description" });
    }
    for (const id of group) {
      if (id === row.id) continue;
      if (displayed.length >= bank.length + 2 * DISPLAYED_MATCHES) break;
      displayed.push({ transactionId: null, rowId: id, lifecycle: null, reason: "within_file" });
    }
    found.set(row.id, {
      displayed: displayed.sort(compareEvidence).slice(0, DISPLAYED_MATCHES),
      count,
      digest: creationDigest({
        row: row.id,
        bankId: bank,
        ledgerGroup: key === null || postings.length === 0 ? null : digestOf("l", key, postings),
        withinFile: key === null || group.length < 2 ? null : digestOf("f", key, group),
      }),
      confirmed: bank.length > 0,
    });
  }
  return found;
}

interface CounterpartRow {
  row_posted_date: string;
  row_amount_cents: bigint;
  id: string;
  account_id: string;
  posted_date: string;
  amount_cents: bigint;
  kind: "purchase" | "refund" | "income" | "transfer";
  lifecycle: "active" | "void";
  version: bigint;
  archived: bigint;
  paired: bigint;
  refund_linked: bigint;
  gap: number;
}

/** A row's transfer candidate depends on its date and amount, and on nothing else about it. */
function transferKey(postedDate: string, cents: bigint): string {
  return JSON.stringify([postedDate, String(cents)]);
}

/**
 * The nearest posted counterpart in another account with the equal and
 * opposite amount, within a week.
 *
 * Asked per distinct date and amount rather than per row, and reduced to the
 * single nearest counterpart inside the query. Rows that share a date and
 * amount get the same answer by definition, so asking once for each is the
 * same answer for far less work: five hundred such rows against a thousand
 * candidates used to hand half a million rows to JavaScript to throw all but
 * five hundred of them away.
 */
function collectTransferSuggestions(
  db: SqliteDatabase,
  batch: ImportBatchRow,
  rows: readonly SuggestionRow[],
  target: string | null,
): Map<string, TransferSuggestion> {
  const eligibleRows = rows.filter(row =>
    row.posted_transaction_id === null && row.posted_date !== null && row.amount_cents !== null
    && row.amount_cents !== 0n);
  if (eligibleRows.length === 0) return new Map();
  const nearest = db.prepare(`
    SELECT row_posted_date, row_amount_cents, id, account_id, posted_date, amount_cents, kind,
      lifecycle, version, archived, paired, refund_linked, gap
    FROM (
      SELECT k.posted_date AS row_posted_date, k.amount_cents AS row_amount_cents,
        t.id, t.account_id, t.posted_date, t.amount_cents, t.kind, t.lifecycle, t.version,
        CASE WHEN a.archived_at IS NULL THEN 0 ELSE 1 END AS archived,
        CASE WHEN EXISTS (SELECT 1 FROM transfer_legs l WHERE l.transaction_id = t.id) THEN 1 ELSE 0 END AS paired,
        CASE WHEN EXISTS (SELECT 1 FROM refund_links l WHERE l.refund_id = t.id)
          OR EXISTS (SELECT 1 FROM refund_links l WHERE l.purchase_id = t.id) THEN 1 ELSE 0 END AS refund_linked,
        abs(julianday(t.posted_date) - julianday(k.posted_date)) AS gap,
        ROW_NUMBER() OVER (
          PARTITION BY k.posted_date, k.amount_cents
          ORDER BY abs(julianday(t.posted_date) - julianday(k.posted_date)),
            t.posted_date DESC, t.id DESC
        ) AS nearest_first
      FROM (
        SELECT DISTINCT posted_date, amount_cents FROM import_rows
        WHERE import_id = ? ${target === null ? "" : "AND id = ?"}
          AND posted_date IS NOT NULL AND amount_cents IS NOT NULL
      ) k
      JOIN transactions t INDEXED BY transactions_transfer_candidates
        ON t.amount_cents = -k.amount_cents AND t.lifecycle = 'active'
        AND t.posted_date BETWEEN ? AND ?
      JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id <> ?
        AND t.posted_date BETWEEN date(k.posted_date, '-7 day') AND date(k.posted_date, '+7 day')
    )
    WHERE nearest_first = 1
  `).all(batch.id, ...(target === null ? [] : [target]),
    windowStart(eligibleRows), windowEnd(eligibleRows), batch.account_id) as CounterpartRow[];

  const byKey = new Map<string, TransferSuggestion>();
  for (const candidate of nearest) {
    const requiresKindChange = candidate.kind !== "transfer";
    const ineligibleReason = candidate.lifecycle !== "active" ? "voided" as const
      : candidate.paired === 1n ? "already_paired" as const
        : requiresKindChange && candidate.archived === 1n ? "reactivation_required" as const
          : requiresKindChange && candidate.refund_linked === 1n ? "refund_links_present" as const : null;
    byKey.set(transferKey(candidate.row_posted_date, candidate.row_amount_cents), {
      transactionId: candidate.id,
      accountId: candidate.account_id,
      counterpartKind: candidate.kind,
      counterpartVersion: formatCounter(candidate.version),
      requiresKindChange,
      eligible: ineligibleReason === null,
      ineligibleReason,
      postedDate: candidate.posted_date,
      money: money(candidate.amount_cents),
      daysApart: Math.round(candidate.gap),
    });
  }

  const suggestions = new Map<string, TransferSuggestion>();
  for (const row of rows) {
    if (row.posted_date === null || row.amount_cents === null) continue;
    const candidate = byKey.get(transferKey(row.posted_date, row.amount_cents));
    if (candidate !== undefined) suggestions.set(row.id, candidate);
  }
  return suggestions;
}

/**
 * An outer date bound for the whole file, so the join can use the posted-date
 * index instead of testing every posting; the exact per-row window is applied
 * inside the query.
 */
function windowStart(rows: readonly SuggestionRow[]): string {
  const earliest = rows.map(row => row.posted_date!).reduce((a, b) => (a < b ? a : b));
  return addDays(earliest, -TRANSFER_WINDOW_DAYS);
}

function windowEnd(rows: readonly SuggestionRow[]): string {
  const latest = rows.map(row => row.posted_date!).reduce((a, b) => (a > b ? a : b));
  return addDays(latest, TRANSFER_WINDOW_DAYS);
}

// ------------------------------------------------------- writing them down

/** Everything a stored row needs to be compared with a fresh suggestion. */
export interface StoredSuggestionRow extends SuggestionRow {
  merchant_text: string | null;
  kind_source: "bank" | "transfer_candidate" | "default" | "owner" | null;
  category_id: string | null;
  assignment_origin: "manual" | "rule" | "unassigned" | "system" | null;
  rule_id: string | null;
  rule_revision: bigint | null;
  issues_json: string;
  duplicate_status: "none" | "suspected" | "confirmed";
  duplicate_match_count: bigint;
  duplicate_evidence_digest: string | null;
  duplicate_decision: "include" | "exclude" | null;
  transfer_candidate_json: string | null;
  transfer_counterpart_id: string | null;
  transfer_counterpart_version: bigint | null;
  transfer_decision: "confirm" | "reject" | null;
  review_required: bigint;
  changed_suggestions_json: string;
}

/**
 * `publish` computes suggestions for rows with no history. `refresh` recomputes
 * them and flags what changed for the owner to acknowledge. `rediscover` runs
 * after an explicit save of one row: the edit may have created a duplicate or a
 * transfer match that nobody has seen, and that candidate is held for its own
 * decision rather than counted as acknowledged by the save that revealed it.
 */
export type SuggestionMode = "publish" | "refresh" | "rediscover";

export interface SuggestionApplyResult {
  /** Rows whose stored suggestions this pass changed. */
  changed: number;
  /** Rows now waiting for the owner to acknowledge a changed suggestion. */
  flagged: number;
}

/**
 * Writes suggestions for every row of one preview, in the caller's write
 * transaction.
 *
 * `publish` computes them for rows that have no history: there is nothing to
 * preserve and nothing to acknowledge, and because this runs inside the same
 * write that makes the preview visible, no caller can see rows whose
 * suggestions are still missing.
 *
 * `refresh` recomputes them against the ledger as it is now, and is bound by
 * one rule: an explicit decision survives unless the evidence it was given for
 * changed. Consent to include a suspected duplicate is consent to the evidence
 * that was shown, so different evidence invalidates it and asks again.
 */
export function applySuggestions(
  context: { db: SqliteDatabase; now: number },
  batch: ImportBatchRow,
  mode: SuggestionMode,
  onlyRowId?: string,
): SuggestionApplyResult {
  const { db, now } = context;
  const rows = db.prepare(
    `SELECT * FROM import_rows WHERE import_id = ? ${onlyRowId === undefined ? "" : "AND id = ?"}
     ORDER BY source_row_number`,
  ).all(batch.id, ...(onlyRowId === undefined ? [] : [onlyRowId])) as StoredSuggestionRow[];
  const suggestions = suggestForBatch(db, batch, rows);
  // Read once: coverage is a property of the account, not of each row, and a
  // refresh after a baseline change is exactly how a held row stops being held.
  const { tracking_start_date: trackingStart } = db.prepare(
    "SELECT tracking_start_date FROM accounts WHERE id = ?",
  ).get(batch.account_id) as { tracking_start_date: string };
  const update = db.prepare(`
    UPDATE import_rows SET category_id = ?, assignment_origin = ?, rule_id = ?, rule_revision = ?,
      duplicate_status = ?, duplicate_matches_json = ?, duplicate_match_count = ?,
      duplicate_evidence_digest = ?, duplicate_decision = ?,
      transfer_candidate_json = ?, transfer_counterpart_id = ?, transfer_counterpart_version = ?,
      transfer_decision = ?, state = ?, issues_json = ?, review_required = ?,
      changed_suggestions_json = ?, excluded = ?, version = version + ?, updated_at = ?
    WHERE id = ?`);

  const result: SuggestionApplyResult = { changed: 0, flagged: 0 };
  for (const row of rows) {
    // A row that already posted is history; it is never re-suggested.
    if (row.posted_transaction_id !== null) continue;
    const next = mergeSuggestion(row, suggestions.get(row.id)!, mode, trackingStart);
    if (!next.changed && mode !== "publish") continue;
    update.run(
      next.assignment?.categoryId ?? null, next.assignment === null ? null : next.assignment.origin,
      next.assignment?.ruleId ?? null,
      next.assignment === null || next.assignment.ruleRevision === null
        ? null : Number(next.assignment.ruleRevision),
      next.duplicateStatus, JSON.stringify(next.displayedMatches), next.matchCount,
      next.evidenceDigest, next.duplicateDecision,
      next.transfer === null ? null : JSON.stringify(next.transfer),
      next.transfer?.transactionId ?? null,
      next.transfer === null ? null : Number(next.transfer.counterpartVersion),
      next.transferDecision, next.state, JSON.stringify(next.issues.map(importIssueDto)),
      next.changedSuggestions.length === 0 ? 0 : 1, JSON.stringify(next.changedSuggestions),
      next.excluded ? 1 : 0,
      // Publication is not a change to a row anybody has seen, and a
      // rediscovery is part of the save that already advanced the row, so
      // only a refresh advances the version here.
      mode === "refresh" ? 1 : 0, now, row.id,
    );
    if (next.changed && mode !== "publish") result.changed += 1;
    if (next.changedSuggestions.length > 0) result.flagged += 1;
  }
  return result;
}

interface MergedRow {
  excluded: boolean;
  assignment: Assignment | null;
  duplicateStatus: "none" | "suspected" | "confirmed";
  displayedMatches: DuplicateEvidence[];
  matchCount: number;
  evidenceDigest: string | null;
  duplicateDecision: "include" | "exclude" | null;
  transfer: TransferSuggestion | null;
  transferDecision: "confirm" | "reject" | null;
  issues: RowIssueCode[];
  state: "ready" | "held" | "excluded";
  changedSuggestions: ChangedSuggestion[];
  changed: boolean;
}

/** One row's stored state merged with a fresh suggestion, deciding what survives. */
function mergeSuggestion(
  row: StoredSuggestionRow,
  suggestion: RowSuggestion,
  mode: SuggestionMode,
  trackingStart: string,
): MergedRow {
  // A save acknowledges the changed suggestions the row was displaying, so a
  // rediscovery starts from none, as publication does.
  const changedSuggestions = new Set<ChangedSuggestion>(
    mode === "refresh" ? (JSON.parse(row.changed_suggestions_json) as ChangedSuggestion[]) : [],
  );
  let changed = mode === "publish";

  // A category the owner chose is not a suggestion and is never recomputed.
  const manual = row.assignment_origin === "manual" && row.category_id !== null;
  let assignment: Assignment | null = manual
    ? { origin: "manual", categoryId: row.category_id!, ruleId: null, ruleRevision: null }
    : suggestion.assignment;
  if (!manual && !sameAssignment(row, assignment)) {
    // Only a refresh asks the owner to look again; a save they just made, and
    // a first publication, simply carry the current suggestion.
    if (mode === "refresh") changedSuggestions.add("assignment");
    changed = true;
  }
  if (mode === "publish") assignment = suggestion.assignment;

  let duplicateDecision = row.duplicate_decision;
  let excluded = row.excluded === 1n;
  if (mode === "publish") duplicateDecision = null;
  else if (suggestion.evidenceDigest !== row.duplicate_evidence_digest) {
    // Inclusion consent is evidence-bound; exclusion intent is not. Preserve
    // it as an explicit exclusion when the old duplicate decision lapses.
    if (duplicateDecision === "exclude") excluded = true;
    // Different evidence, so any consent given for the old evidence lapses.
    // A newly discovered candidate then holds the row on its own account; it
    // is not something the save that revealed it could have approved.
    duplicateDecision = null;
    if (mode === "refresh") changedSuggestions.add("duplicate");
    changed = true;
  }

  let transferDecision = row.transfer_decision;
  if (mode === "publish") {
    transferDecision = null;
  } else {
    const sameCounterpart = (suggestion.transfer?.transactionId ?? null) === row.transfer_counterpart_id
      && (suggestion.transfer === null ? null : suggestion.transfer.counterpartVersion)
        === (row.transfer_counterpart_version === null ? null : formatCounter(row.transfer_counterpart_version));
    if (!sameCounterpart) {
      // A different counterpart, or none, is a different question entirely.
      transferDecision = null;
      if (mode === "refresh" && (row.transfer_decision !== null || suggestion.transfer !== null
        || row.transfer_counterpart_id !== null)) {
        changedSuggestions.add("transfer");
      }
      changed = true;
    } else if (!sameTransferShape(row, suggestion.transfer)) {
      changed = true;
      if (transferDecision === "confirm" && suggestion.transfer?.eligible !== true) {
        transferDecision = null;
        if (mode === "refresh") changedSuggestions.add("transfer");
      }
    }
  }

  const transferPending = suggestion.transfer !== null && transferDecision === null;
  const issues = deriveRowIssues({
    postedDate: row.posted_date, cents: row.amount_cents, merchant: row.merchant_text, kind: row.kind,
    trackingStartDate: trackingStart, retainedMoneyIssue: retainedMoneyIssue(row),
    duplicateStatus: suggestion.duplicateStatus, duplicateDecision, transferPending,
    changedSuggestions: [...changedSuggestions],
  });
  // A refresh recomputes issues, not only suggestions, and coverage is the one
  // that changes because the *account* changed. Without this a row held for a
  // tracking start the owner has since extended would stay held: nothing about
  // its suggestions moved, so nothing would be written.
  if (issues.join(",") !== storedIssueCodes(row).join(",")) changed = true;

  return {
    excluded, assignment, duplicateStatus: suggestion.duplicateStatus,
    displayedMatches: suggestion.displayedMatches, matchCount: suggestion.matchCount,
    evidenceDigest: suggestion.evidenceDigest, duplicateDecision,
    transfer: suggestion.transfer, transferDecision, issues,
    changedSuggestions: [...changedSuggestions].sort(),
    state: deriveImportRowState({
      excluded, hasValidationIssues: issues.some(isValidationIssue),
      reviewRequired: changedSuggestions.size > 0, duplicateStatus: suggestion.duplicateStatus,
      duplicateDecision, transferReviewPending: transferPending,
    }),
    changed: changed || mode === "publish",
  };
}

function sameAssignment(row: StoredSuggestionRow, next: Assignment | null): boolean {
  if (next === null) return row.category_id === null && row.assignment_origin === null;
  return row.category_id === next.categoryId && row.assignment_origin === next.origin
    && row.rule_id === next.ruleId
    && (row.rule_revision === null ? null : formatCounter(row.rule_revision))
      === (next.ruleRevision === null ? null : formatCounter(next.ruleRevision));
}

/** Whether the stored candidate says exactly what the fresh one does. */
function sameTransferShape(row: StoredSuggestionRow, next: TransferSuggestion | null): boolean {
  if (next === null) return row.transfer_candidate_json === null;
  if (row.transfer_candidate_json === null) return false;
  return JSON.stringify(next) === JSON.stringify(JSON.parse(row.transfer_candidate_json));
}

function storedIssueCodes(row: StoredSuggestionRow): string[] {
  return (JSON.parse(row.issues_json) as { code: string }[]).map(issue => issue.code);
}

function retainedMoneyIssue(row: StoredSuggestionRow): RowIssueCode | null {
  return (storedIssueCodes(row).find(isMoneyIssue) as RowIssueCode | undefined) ?? null;
}
