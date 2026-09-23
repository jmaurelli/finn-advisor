/**
 * Transaction browsing: combined filters, whole-scope totals and keyset paging.
 *
 * Cursors carry the last row's posted date and ID plus a digest of the
 * canonical filters (TDD section 8). They are not tied to any revision, so
 * edits elsewhere never expire Load more; a row edited out of the filters
 * simply drops out. Totals cover every matching row and are read in the
 * caller's snapshot together with the page. Voided rows can be listed but
 * never contribute money.
 */
import type { SqliteDatabase } from "@workspace/db";
import { z } from "zod";
import { normalizeMatchText } from "../domain/assignment.js";
import { isCalendarDate, isYearMonth, monthStart, nextMonthStart } from "../domain/dates.js";
import { creationDigest } from "../domain/digest.js";
import { aggregateMoney } from "../domain/money.js";
import { wellFormed } from "../lib/category-schemas.js";
import { problem } from "../lib/problem.js";
import { financeRevision } from "./ledger.js";
import { transactionDto, type TransactionRow } from "./transactions.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ["purchase", "refund", "income", "transfer"];
const ORIGINS = ["manual", "rule", "unassigned", "system"];
const LIFECYCLES = ["active", "void", "all"];
const PARAMETERS = new Set(["accountId", "categoryId", "kind", "origin", "lifecycle", "month", "from", "to", "q", "cursor", "limit"]);

export interface TransactionFilters {
  accountId?: string;
  categoryId?: string;
  kind?: string;
  origin?: string;
  lifecycle: string;
  from?: string;
  to?: string;
  q?: string;
}

const cursorSchema = z.object({
  v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  date: z.string().refine(isCalendarDate), id: z.string().regex(UUID),
}).strict();

function badQuery(detail: string): never {
  throw problem({ status: 400, code: "invalid_request", title: "Invalid list filter", detail });
}

function invalidCursor(): never {
  throw problem({ status: 400, code: "invalid_cursor", title: "The list position is not valid",
    detail: "Reload the list from the first page." });
}

const matchTextRegistered = new WeakSet<SqliteDatabase>();

/** Legacy notes predate the stored search form; search normalizes them as merchants are. */
function registerMatchText(db: SqliteDatabase): void {
  if (matchTextRegistered.has(db)) return;
  db.function("match_text", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? normalizeMatchText(value) : null);
  matchTextRegistered.add(db);
}

/** Parses the query into canonical filters. Repeated or unknown parameters are malformed. */
export function parseTransactionQuery(query: Record<string, unknown>) {
  const text: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!PARAMETERS.has(key)) badQuery("A filter in this request is not supported.");
    if (typeof value !== "string") badQuery(`Give ${key} once, as plain text.`);
    text[key] = value;
  }
  const oneOf = (key: string, allowed: string[]) => {
    const value = text[key];
    if (value !== undefined && !allowed.includes(value)) badQuery(`Choose a supported ${key}.`);
    return value;
  };
  const id = (key: string) => {
    const value = text[key];
    if (value !== undefined && !UUID.test(value)) badQuery(`The ${key} filter is not a valid id.`);
    return value?.toLowerCase();
  };
  const filters: TransactionFilters = {
    accountId: id("accountId"), categoryId: id("categoryId"), kind: oneOf("kind", KINDS),
    origin: oneOf("origin", ORIGINS), lifecycle: oneOf("lifecycle", LIFECYCLES) ?? "active",
  };
  for (const key of ["from", "to"] as const) {
    const value = text[key];
    if (value !== undefined && (!isCalendarDate(value) || value < "1900-01-01" || value > "2999-12-31")) {
      badQuery(`Use a real calendar date for ${key}.`);
    }
    filters[key] = value;
  }
  if (text["month"] !== undefined) {
    if (filters.from !== undefined || filters.to !== undefined) {
      badQuery("Choose either a month or a from/to range, not both.");
    }
    if (!isYearMonth(text["month"]) || text["month"] < "1900-01") badQuery("Use a month in the form YYYY-MM.");
    filters.from = monthStart(text["month"]);
    filters.to = nextMonthStart(text["month"]);
  } else if (filters.from !== undefined && filters.to !== undefined && filters.from >= filters.to) {
    throw problem({ status: 422, code: "validation_failed", title: "Empty date range",
      detail: "The end date is exclusive, so it must come after the start date.",
      fieldErrors: [{ path: "/to", code: "invalid_value", message: "Choose a date after the start date." }] });
  }
  if (text["q"] !== undefined) {
    const q = text["q"];
    if (q.length === 0 || [...q].length > 200 || !wellFormed(q)) badQuery("Search for 1 to 200 characters.");
    const normalized = normalizeMatchText(q);
    if (normalized.length === 0) throw problem({ status: 422, code: "validation_failed", title: "Search text needed",
      detail: "Enter some text to search for, not only spaces.",
      fieldErrors: [{ path: "/q", code: "invalid_value", message: "Enter text to search for." }] });
    filters.q = normalized;
  }
  const limit = text["limit"] ?? "50";
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 200) badQuery("Choose a page size from 1 to 200.");
  const cursor = text["cursor"];
  if (cursor !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) invalidCursor();
  return { filters, limit: Number(limit), cursor };
}

function predicate(filters: TransactionFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => { clauses.push(sql); params.push(...values); };
  if (filters.accountId !== undefined) add("account_id = ?", filters.accountId);
  if (filters.categoryId !== undefined) add("category_id = ?", filters.categoryId);
  if (filters.kind !== undefined) add("kind = ?", filters.kind);
  if (filters.origin !== undefined) add("assignment_origin = ?", filters.origin);
  if (filters.lifecycle !== "all") add("lifecycle = ?", filters.lifecycle);
  if (filters.from !== undefined) add("posted_date >= ?", filters.from);
  if (filters.to !== undefined) add("posted_date < ?", filters.to);
  // instr() is a literal comparison: %, _ and regex characters have no meaning.
  // Notes use their stored search form; only legacy rows without one are normalized here (CASE is lazy).
  if (filters.q !== undefined) add(`(instr(normalized_text, ?) > 0 OR CASE WHEN normalized_note IS NOT NULL
    THEN instr(normalized_note, ?) > 0 WHEN note IS NOT NULL THEN instr(match_text(note), ?) > 0 ELSE 0 END)`,
  filters.q, filters.q, filters.q);
  return { sql: clauses.length === 0 ? "1" : clauses.join(" AND "), params };
}

/**
 * One keyset page of rows matching the filters, newest first. `scope` binds
 * the cursor to the list and its canonical filters.
 */
export function pageTransactions(db: SqliteDatabase, filters: TransactionFilters, scope: string,
  limit: number, encoded: string | undefined) {
  registerMatchText(db);
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (encoded !== undefined) {
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) invalidCursor();
      cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch { invalidCursor(); }
    if (cursor.scope !== scope) throw problem({ status: 400, code: "cursor_filter_mismatch",
      title: "The list filters changed", detail: "Reload the list from the first page." });
  }
  const where = predicate(filters);
  const rows = db.prepare(`SELECT * FROM transactions WHERE ${where.sql}
    ${cursor === undefined ? "" : "AND (posted_date, id) < (?, ?)"}
    ORDER BY posted_date DESC, id DESC LIMIT ?`).all(...where.params,
      ...(cursor === undefined ? [] : [cursor.date, cursor.id.toLowerCase()]), limit + 1) as TransactionRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    rows: page,
    nextCursor: rows.length <= limit || last === undefined ? null : Buffer.from(JSON.stringify({
      v: 1, scope, date: last.posted_date, id: last.id,
    })).toString("base64url"),
  };
}

/** Call inside a read transaction so the page and totals share one snapshot. */
export function listTransactions(db: SqliteDatabase, query: Record<string, unknown>) {
  registerMatchText(db);
  const { filters, limit, cursor } = parseTransactionQuery(query);
  const scope = creationDigest({ list: "transactions", ...filters });
  const where = predicate(filters);
  const totals = db.prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(CASE WHEN lifecycle = 'active' AND kind = 'purchase' THEN -amount_cents ELSE 0 END), 0) AS purchases,
      COALESCE(SUM(CASE WHEN lifecycle = 'active' AND kind = 'refund' THEN amount_cents ELSE 0 END), 0) AS refunds,
      COALESCE(SUM(CASE WHEN lifecycle = 'active' AND kind = 'income' THEN amount_cents ELSE 0 END), 0) AS income
    FROM transactions WHERE ${where.sql}`).get(...where.params) as
    { n: bigint; purchases: bigint; refunds: bigint; income: bigint };
  const page = pageTransactions(db, filters, scope, limit, cursor);
  return {
    items: page.rows.map(row => transactionDto(db, row)),
    nextCursor: page.nextCursor,
    totals: {
      matchingCount: Number(totals.n), purchases: aggregateMoney(totals.purchases),
      refunds: aggregateMoney(totals.refunds), netSpending: aggregateMoney(totals.purchases - totals.refunds),
      income: aggregateMoney(totals.income),
    },
    financeRevision: String(financeRevision(db)),
  };
}
