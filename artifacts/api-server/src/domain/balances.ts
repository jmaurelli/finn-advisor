/**
 * Balances.
 *
 * An account's balance at the end of date D is its opening balance plus every
 * active movement posted from the tracking start through D. Two rules matter
 * more than the arithmetic:
 *
 *  - Before coverage begins there is no balance, and saying so is the honest
 *    answer. A fabricated zero would look exactly like a real zero balance.
 *  - Voided rows count for nothing, here and in every total.
 *
 * `SUM()` over an integer column is used deliberately. SQLite's `TOTAL()` is
 * defined to return a float and would silently destroy cent exactness;
 * `SUM()` returns an exact integer and raises `integer overflow` rather than
 * wrapping, which is a fault worth reporting, not a total worth showing.
 */

import type { SqliteDatabase } from "@workspace/db";

import { compareDates, dayBefore } from "./dates.js";
import { AGGREGATE_BOUND, assertWithin } from "./money.js";

export type Coverage = "covered" | "outside_coverage";

export interface BalanceResult {
  coverage: Coverage;
  /** Null exactly when the date is outside coverage. */
  balance: bigint | null;
}

export interface AccountBaseline {
  id: string;
  trackingStartDate: string;
  openingCents: bigint;
}

export class BalanceOverflowError extends Error {
  constructor(cause: unknown) {
    super("the balance for this account exceeded the range the ledger can represent");
    this.name = "BalanceOverflowError";
    this.cause = cause;
  }
}

/**
 * `COALESCE` is not decoration: `SUM()` over zero rows returns NULL, so an
 * account with no transactions yet would otherwise report a missing balance
 * instead of its opening one.
 */
const SUM_MOVEMENTS = `
  SELECT COALESCE(SUM(amount_cents), 0) AS total
  FROM transactions
  WHERE account_id = ?
    AND lifecycle = 'active'
    AND posted_date >= ?
    AND posted_date <= ?
`;

export function balanceAt(
  db: SqliteDatabase,
  account: AccountBaseline,
  asOf: string,
): BalanceResult {
  const coverageStart = dayBefore(account.trackingStartDate);
  if (compareDates(asOf, coverageStart) < 0) {
    return { coverage: "outside_coverage", balance: null };
  }

  const row = runSum(db, account.id, account.trackingStartDate, asOf);
  const balance = account.openingCents + row;
  assertWithin(balance, AGGREGATE_BOUND);
  return { coverage: "covered", balance };
}

function runSum(db: SqliteDatabase, accountId: string, from: string, to: string): bigint {
  try {
    const row = db.prepare(SUM_MOVEMENTS).get(accountId, from, to) as { total: bigint | number };
    return typeof row.total === "bigint" ? row.total : BigInt(row.total);
  } catch (error) {
    // SQLite fails loudly on aggregate overflow rather than wrapping or
    // degrading to a float. Overflow depends on row order, so a sequence that
    // ends in range can still fail part-way through; either way this is an
    // internal fault, never a partial or approximate total.
    if (error instanceof Error && /integer overflow/i.test(error.message)) {
      throw new BalanceOverflowError(error);
    }
    throw error;
  }
}

/**
 * The balances at several dates for one account, in a single pass.
 *
 * The derived reconciliation status needs a balance per checkpoint. Asking
 * `balanceAt` once per checkpoint re-scans the account's whole history each
 * time, which measured at about 4 ms per checkpoint - fine for one checkpoint
 * and over the read target for an account list carrying dozens of them.
 *
 * Instead this totals each posted day once and walks the days and the
 * requested dates together, so the work is one scan per account regardless of
 * how many dates are asked for. Every total is still an exact integer from
 * SQLite, accumulated exactly as `bigint`.
 */
export function balancesAt(
  db: SqliteDatabase,
  account: AccountBaseline,
  dates: string[],
): Map<string, bigint | null> {
  const coverageStart = dayBefore(account.trackingStartDate);
  const result = new Map<string, bigint | null>();

  const covered: string[] = [];
  for (const date of dates) {
    if (compareDates(date, coverageStart) < 0) result.set(date, null);
    else covered.push(date);
  }
  if (covered.length === 0) return result;

  const wanted = [...new Set(covered)].sort();
  const latest = wanted[wanted.length - 1];

  let days: { date: string; total: bigint }[];
  try {
    days = db
      .prepare(
        `SELECT posted_date AS date, SUM(amount_cents) AS total
         FROM transactions
         WHERE account_id = ? AND lifecycle = 'active'
           AND posted_date >= ? AND posted_date <= ?
         GROUP BY posted_date
         ORDER BY posted_date`,
      )
      .all(account.id, account.trackingStartDate, latest) as { date: string; total: bigint }[];
  } catch (error) {
    if (error instanceof Error && /integer overflow/i.test(error.message)) {
      throw new BalanceOverflowError(error);
    }
    throw error;
  }

  let running = account.openingCents;
  let index = 0;
  for (const date of wanted) {
    while (index < days.length && compareDates(days[index].date, date) <= 0) {
      running += days[index].total;
      index += 1;
    }
    assertWithin(running, AGGREGATE_BOUND);
    result.set(date, running);
  }
  return result;
}

/** The last posted date actually imported for an account, or null. */
export function lastPostedDate(db: SqliteDatabase, accountId: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(posted_date) AS last FROM transactions
       WHERE account_id = ? AND lifecycle = 'active'`,
    )
    .get(accountId) as { last: string | null };
  return row.last;
}

/**
 * Active transactions on this account posted before a date, used by the
 * baseline command to refuse a change that would drop them out of the balance
 * while they still counted as spending.
 */
export function activeTransactionsBefore(
  db: SqliteDatabase,
  accountId: string,
  date: string,
  limit = 20,
): { ids: string[]; count: number } {
  const count = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE account_id = ? AND lifecycle = 'active' AND posted_date < ?`,
    )
    .get(accountId, date) as { n: bigint };
  const rows = db
    .prepare(
      `SELECT id FROM transactions
       WHERE account_id = ? AND lifecycle = 'active' AND posted_date < ?
       ORDER BY posted_date, id LIMIT ?`,
    )
    .all(accountId, date, limit) as { id: string }[];
  return { ids: rows.map((row) => row.id), count: Number(count.n) };
}
