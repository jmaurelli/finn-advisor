/**
 * The transaction CSV export.
 *
 * Same filters and same predicate as `listTransactions`, so the file answers
 * the question the screen asked - but over every matching row rather than the
 * loaded page, and from one read snapshot so the file is internally
 * consistent even if a write lands while it is being produced.
 *
 * Two rules shape the output:
 *
 * - **A spreadsheet must not execute it.** A text field starting with `=`,
 *   `+`, `-`, `@` or a control character is prefixed with an apostrophe, which
 *   Excel, LibreOffice and Sheets all treat as "this is text". Numeric and
 *   date columns are left exactly as they are: prefixing an amount would make
 *   the file arithmetically useless to defend against a risk it does not carry.
 * - **It never truncates.** The matching rows are counted before anything is
 *   written, so an oversized export is refused with 413 and an empty body
 *   rather than becoming a plausible-looking file that silently stops.
 */
import type { SqliteDatabase } from "@workspace/db";
import { problem } from "../lib/problem.js";
import { parseExportQuery, transactionPredicate } from "./transaction-list.js";

/**
 * A ten-year ledger for this owner is on the order of 50,000 rows, so this
 * clears two decades of history. It exists to bound the response the service
 * will materialize, not to ration exports: past it the owner is told to narrow
 * the filters, which is a better answer than a 40 MB download that may not
 * finish.
 */
export const MAX_EXPORT_ROWS = 100_000;

/** Exactly the columns the contract names, in order. */
export const EXPORT_COLUMNS = [
  "posted_date", "account_id", "account_name", "merchant", "amount", "kind", "lifecycle",
  "category_id", "category_name", "assignment_origin", "note", "transfer_pair_id",
  "refund_link_purchase_id", "transaction_id",
] as const;

/** The columns whose values come from the owner or their bank, not from us. */
const TEXT_COLUMNS = new Set(["account_name", "merchant", "category_name", "note"]);

interface ExportRow {
  posted_date: string;
  account_id: string;
  account_name: string;
  merchant: string;
  amount_cents: bigint;
  kind: string;
  lifecycle: string;
  category_id: string | null;
  category_name: string | null;
  assignment_origin: string;
  note: string | null;
  transfer_pair_id: string | null;
  refund_link_purchase_id: string | null;
  transaction_id: string;
}

/** Signed exact dollars, as stored: a purchase is already negative in cents. */
export function decimalDollars(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? "-" : ""}${String(whole)}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Neutralizes a value a spreadsheet would otherwise treat as a formula. The
 * leading-whitespace check matters: ` =SUM(A1)` is still a formula to Excel,
 * so the dangerous character is looked for after any spaces, while the
 * original spacing is preserved in the output.
 */
export function neutralizeFormula(value: string): string {
  const firstMeaningful = value.replace(/^[ \t]*/u, "").charAt(0);
  if (firstMeaningful === "") return value;
  const dangerous = "=+-@".includes(firstMeaningful)
    // Control characters: a leading tab or carriage return can also start a
    // formula once a spreadsheet has trimmed it.
    || /[\p{Cc}\p{Cf}]/u.test(firstMeaningful);
  return dangerous ? `'${value}` : value;
}

/** RFC 4180: quote when the value contains a comma, quote, CR or LF. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cell(column: string, row: ExportRow): string {
  const raw = column === "amount" ? decimalDollars(row.amount_cents)
    : column === "merchant" ? row.merchant
      : column === "transaction_id" ? row.transaction_id
        : String((row as unknown as Record<string, unknown>)[column] ?? "");
  return csvField(TEXT_COLUMNS.has(column) ? neutralizeFormula(raw) : raw);
}

/**
 * The matching rows, newest first - the same order as the list, so the file
 * and the screen agree about what "the first row" means.
 *
 * The predicate is applied inside a subquery against the bare `transactions`
 * table, so the shared predicate's unqualified column names cannot become
 * ambiguous against the joined tables.
 */
const ROWS_SQL = `
  SELECT t.posted_date, t.account_id, a.display_name AS account_name,
         t.merchant_text AS merchant, t.amount_cents, t.kind, t.lifecycle,
         t.category_id, c.display_name AS category_name, t.assignment_origin, t.note,
         tl.pair_id AS transfer_pair_id, rl.purchase_id AS refund_link_purchase_id,
         t.id AS transaction_id
  FROM (SELECT * FROM transactions WHERE %PREDICATE%) t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN transfer_legs tl ON tl.transaction_id = t.id
  LEFT JOIN refund_links rl ON rl.refund_id = t.id
  ORDER BY t.posted_date DESC, t.id DESC`;

export interface TransactionCsv {
  filename: string;
  body: string;
}

/**
 * Produces the whole file inside one read transaction, which is what makes it
 * a snapshot. It is materialized rather than streamed because a streamed body
 * would have to release the snapshot to await backpressure; `MAX_EXPORT_ROWS`
 * is what keeps that affordable.
 */
export function exportTransactionsCsv(
  db: SqliteDatabase, query: Record<string, unknown>, today: string,
): TransactionCsv {
  const filters = parseExportQuery(query);
  const where = transactionPredicate(filters);
  return db.transaction((): TransactionCsv => {
    const counted = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where.sql}`)
      .get(...where.params) as { n: bigint };
    if (Number(counted.n) > MAX_EXPORT_ROWS) {
      throw problem({ status: 413, code: "payload_too_large", title: "That export is too large",
        detail: `This export would contain ${String(counted.n)} transactions, over the limit of `
          + `${String(MAX_EXPORT_ROWS)}. Narrow the date range or filters and try again. Nothing was downloaded.` });
    }
    const rows = db.prepare(ROWS_SQL.replace("%PREDICATE%", where.sql)).all(...where.params) as ExportRow[];
    const lines = [EXPORT_COLUMNS.join(",")];
    for (const row of rows) lines.push(EXPORT_COLUMNS.map(column => cell(column, row)).join(","));
    return {
      filename: `money-desk-transactions-${today}.csv`,
      // RFC 4180 wants CRLF, and a trailing newline so the last record is
      // terminated like every other one.
      body: `${lines.join("\r\n")}\r\n`,
    };
  })();
}
