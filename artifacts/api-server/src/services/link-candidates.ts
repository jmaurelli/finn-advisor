/**
 * Transfer and refund candidates. Reads only: nothing here links anything.
 *
 * Transfer suggestions (TDD section 6): without filters, active transactions
 * in other accounts with the equal and opposite amount, posted within seven
 * calendar days, nearest first. The window is a suggestion, not a rule, so
 * explicit `from`/`to`/`accountId` filters replace it and may list rows that
 * cannot be paired, each with the reason. Eligible, equal-and-opposite rows
 * always rank first.
 *
 * Refund candidates have no automatic matching: the owner searches active
 * purchases in any account, archived ones included, with the transaction
 * list's own filters and keyset cursor.
 */
import type { SqliteDatabase } from "@workspace/db";
import { addDays, isCalendarDate } from "../domain/dates.js";
import { creationDigest } from "../domain/digest.js";
import { aggregateMoney } from "../domain/money.js";
import { ProblemError, problem } from "../lib/problem.js";
import { financeRevision } from "./ledger.js";
import { linkedRefundTotal, pairIneligibility } from "./links.js";
import { pageTransactions, parseTransactionQuery } from "./transaction-list.js";
import { requireTransaction, transactionDto, type TransactionRow } from "./transactions.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SUGGESTION_WINDOW_DAYS = 7;
const MAX_TRANSFER_CANDIDATES = 50;

function badQuery(detail: string): never {
  throw problem({ status: 400, code: "invalid_request", title: "Invalid list filter", detail });
}

function onlyParameters(query: Record<string, unknown>, allowed: string[]): Record<string, string> {
  const text: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key)) badQuery("A filter in this request is not supported.");
    if (typeof value !== "string") badQuery(`Give ${key} once, as plain text.`);
    text[key] = value;
  }
  return text;
}

function daysBetween(left: string, right: string): number {
  return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
}

export function transferCandidates(db: SqliteDatabase, id: string, query: Record<string, unknown>) {
  const text = onlyParameters(query, ["accountId", "from", "to"]);
  if (text["accountId"] !== undefined && !UUID.test(text["accountId"])) badQuery("The accountId filter is not a valid id.");
  for (const key of ["from", "to"]) {
    const value = text[key];
    if (value !== undefined && !isCalendarDate(value)) badQuery(`Use a real calendar date for ${key}.`);
  }
  if (text["from"] !== undefined && text["to"] !== undefined && text["from"] >= text["to"]) {
    badQuery("The end date is exclusive, so it must come after the start date.");
  }
  const source = requireTransaction(db, id);
  const explicit = Object.keys(text).length > 0;
  const clauses = ["t.id <> ?"];
  const params: unknown[] = [source.id];
  if (explicit) {
    if (text["accountId"] !== undefined) { clauses.push("t.account_id = ?"); params.push(text["accountId"].toLowerCase()); }
    if (text["from"] !== undefined) { clauses.push("t.posted_date >= ?"); params.push(text["from"]); }
    if (text["to"] !== undefined) { clauses.push("t.posted_date < ?"); params.push(text["to"]); }
  } else {
    clauses.push("t.account_id <> ?", "t.lifecycle = 'active'", "t.amount_cents = ?",
      "t.posted_date BETWEEN ? AND ?");
    params.push(source.account_id, -source.amount_cents, addDays(source.posted_date, -SUGGESTION_WINDOW_DAYS),
      addDays(source.posted_date, SUGGESTION_WINDOW_DAYS));
  }
  // Rank rows that could actually pair first, then nearest date, then newest.
  const rows = db.prepare(`SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY (t.lifecycle = 'active' AND t.account_id <> ? AND t.amount_cents = ?
        AND NOT EXISTS (SELECT 1 FROM transfer_legs l WHERE l.transaction_id = t.id)
        AND (t.kind = 'transfer' OR a.archived_at IS NULL)) DESC,
      abs(julianday(t.posted_date) - julianday(?)), t.posted_date DESC, t.id DESC
    LIMIT ?`).all(...params, source.account_id, -source.amount_cents, source.posted_date,
      MAX_TRANSFER_CANDIDATES) as TransactionRow[];
  return {
    items: rows.map(row => {
      const daysApart = daysBetween(source.posted_date, row.posted_date);
      const reason = pairIneligibility(db, source, row);
      return { transaction: transactionDto(db, row), daysApart,
        withinSuggestionWindow: daysApart <= SUGGESTION_WINDOW_DAYS,
        // Pairing changes whichever of the two is not already a transfer.
        requiresKindChange: source.kind !== "transfer" || row.kind !== "transfer",
        eligible: reason === null, ineligibleReason: reason };
    }),
    financeRevision: String(financeRevision(db)),
  };
}

export function refundCandidates(db: SqliteDatabase, id: string, query: Record<string, unknown>) {
  onlyParameters(query, ["accountId", "from", "to", "q", "cursor", "limit"]);
  let parsed: ReturnType<typeof parseTransactionQuery>;
  try {
    parsed = parseTransactionQuery(query);
  } catch (error) {
    // This operation's contract has no 422: an empty range or blank search is a bad query here.
    if (error instanceof ProblemError && error.problem.status === 422) badQuery(error.problem.detail);
    throw error;
  }
  const source = requireTransaction(db, id);
  const filters = { ...parsed.filters, kind: "purchase", lifecycle: "active" };
  const scope = creationDigest({ list: "refund-candidates", transactionId: source.id, ...filters });
  const page = pageTransactions(db, filters, scope, parsed.limit, parsed.cursor);
  // Only a positive amount can be a refund; anything else adds nothing to the warning.
  const refundAmount = source.amount_cents > 0n ? source.amount_cents : 0n;
  return {
    items: page.rows.map(row => {
      const total = linkedRefundTotal(db, row.id);
      const others = linkedRefundTotal(db, row.id, source.id);
      return { transaction: transactionDto(db, row), linkedRefundTotal: aggregateMoney(total),
        wouldExceedPurchase: others + refundAmount > -row.amount_cents };
    }),
    nextCursor: page.nextCursor,
  };
}
