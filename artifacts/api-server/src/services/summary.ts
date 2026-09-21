/**
 * The month summary.
 *
 * Spending is purchases minus refunds by posted month. Income counts only
 * income rows. Transfers move money between owned accounts and are not
 * spending, so they affect balances only - which is what stops a card payment
 * being counted as a second purchase. Voided rows are excluded everywhere.
 */

import type { SqliteDatabase } from "@workspace/db";

import { aggregateMoney } from "../domain/money.js";
import { balanceAt } from "../domain/balances.js";
import {
  compareDates,
  easternDate,
  monthEnd,
  monthStart,
  nextMonthStart,
} from "../domain/dates.js";
import { accountReconciliation } from "../domain/reconciliation.js";
import { baselineOf, financeRevision, type AccountRow } from "./ledger.js";
import { listAccounts } from "./accounts.js";

const UNCATEGORIZED = "30000000-0000-4000-8000-000000000000";

interface TotalsRow {
  purchases: bigint;
  refunds: bigint;
  income: bigint;
}

export function monthSummary(db: SqliteDatabase, month: string, nowMs: number): unknown {
  const today = easternDate(nowMs);
  const from = monthStart(month);
  const to = nextMonthStart(month);

  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'purchase' THEN -amount_cents ELSE 0 END), 0) AS purchases,
         COALESCE(SUM(CASE WHEN kind = 'refund'   THEN  amount_cents ELSE 0 END), 0) AS refunds,
         COALESCE(SUM(CASE WHEN kind = 'income'   THEN  amount_cents ELSE 0 END), 0) AS income
       FROM transactions
       WHERE lifecycle = 'active' AND posted_date >= ? AND posted_date < ?`,
    )
    .get(from, to) as TotalsRow;

  const categories = db
    .prepare(
      `SELECT category_id AS categoryId,
         COALESCE(SUM(CASE WHEN kind = 'purchase' THEN -amount_cents ELSE 0 END), 0) AS purchases,
         COALESCE(SUM(CASE WHEN kind = 'refund'   THEN  amount_cents ELSE 0 END), 0) AS refunds,
         COUNT(*) AS transactionCount
       FROM transactions
       WHERE lifecycle = 'active' AND posted_date >= ? AND posted_date < ?
         AND kind IN ('purchase', 'refund')
       GROUP BY category_id
       ORDER BY category_id`,
    )
    .all(from, to) as {
    categoryId: string;
    purchases: bigint;
    refunds: bigint;
    transactionCount: bigint;
  }[];

  const uncategorized = categories.find((row) => row.categoryId === UNCATEGORIZED);

  // The last day of the month, or today when the month has not ended - the
  // current month or a future one: a summary should never claim a month-end
  // balance that has not happened.
  const balanceDate = compareDates(monthEnd(month), today) > 0 ? today : monthEnd(month);
  const accounts = listAccounts(db, "all").map((row: AccountRow) => {
    const { balance, coverage } = balanceAt(db, baselineOf(row), balanceDate);
    return {
      accountId: row.id,
      balance: balance === null ? null : aggregateMoney(balance),
      coverage,
    };
  });

  return {
    month,
    asOf: today,
    spending: {
      purchases: aggregateMoney(totals.purchases),
      refunds: aggregateMoney(totals.refunds),
      net: aggregateMoney(totals.purchases - totals.refunds),
    },
    income: aggregateMoney(totals.income),
    categories: categories.map((row) => ({
      categoryId: row.categoryId,
      purchases: aggregateMoney(row.purchases),
      refunds: aggregateMoney(row.refunds),
      net: aggregateMoney(row.purchases - row.refunds),
      transactionCount: Number(row.transactionCount),
    })),
    uncategorized: {
      net: aggregateMoney(
        uncategorized === undefined ? 0n : uncategorized.purchases - uncategorized.refunds,
      ),
      transactionCount: uncategorized === undefined ? 0 : Number(uncategorized.transactionCount),
    },
    accounts,
    review: reviewCounts(db),
    financeRevision: String(financeRevision(db)),
  };
}

/**
 * Counts for the review badges.
 *
 * Three of these have no data to count yet: imports arrive in stage 5 and
 * transfer pairs in stage 3. They report 0, and each is declared in
 * `pending-stages.ts` with the table that will make it real, guarded by a test
 * that fails the moment that table exists.
 */
function reviewCounts(db: SqliteDatabase): Record<string, number> {
  const uncategorizedCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions
       WHERE lifecycle = 'active' AND kind IN ('purchase', 'refund') AND category_id = ?`,
    )
    .get(UNCATEGORIZED) as { n: bigint };

  let needsRecheckCount = 0;
  let differenceCount = 0;
  for (const account of listAccounts(db, "all")) {
    const summary = accountReconciliation(db, baselineOf(account));
    needsRecheckCount += summary.needsRecheckCount;
    differenceCount += summary.differenceCount;
  }

  return {
    uncategorizedCount: Number(uncategorizedCount.n),
    openImportCount: 0,
    heldImportRowCount: 0,
    needsRecheckCount,
    differenceCount,
    unmatchedTransferCount: 0,
  };
}
