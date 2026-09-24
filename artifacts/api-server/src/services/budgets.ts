/**
 * One month of budgets.
 *
 * Usage is posted-month purchases minus refunds, exactly as the month summary
 * counts them: income and transfers are not spending, and voided rows are
 * excluded everywhere. Spending stays where it was posted - a March purchase
 * refunded in April lowers April, not March - because a budget is a limit for
 * a month, not a running balance. Nothing rolls over.
 *
 * Spending on an archived account still counts: the money was spent. So does
 * spending in a category archived later in the year, for the months its limit
 * still covers.
 */

import type { SqliteDatabase } from "@workspace/db";

import {
  budgetPercentUsed, resolveBudget, type MonthlyBudgetEntry, type RegularBudgetEntry,
} from "../domain/budgets.js";
import { monthStart, nextMonthStart } from "../domain/dates.js";
import { aggregateMoney, money } from "../domain/money.js";
import { financeRevision } from "./ledger.js";

interface SpendingRow {
  categoryId: string;
  systemKind: "income" | "uncategorized" | null;
  purchases: bigint;
  refunds: bigint;
}

interface PlannedCategory {
  categoryId: string;
  planVersion: bigint;
  archivedAt: bigint | null;
  cutoffMonth: string | null;
}

/**
 * Purchases and refunds for one posted month, per category.
 *
 * Purchases are stored as negative cents and refunds as positive, so each is
 * turned into a positive magnitude here and the net is purchases minus
 * refunds - the same convention the month summary reports.
 */
function spendingByCategory(db: SqliteDatabase, month: string): Map<string, SpendingRow> {
  const rows = db.prepare(
    `SELECT t.category_id AS categoryId, c.system_kind AS systemKind,
       COALESCE(SUM(CASE WHEN t.kind = 'purchase' THEN -t.amount_cents ELSE 0 END), 0) AS purchases,
       COALESCE(SUM(CASE WHEN t.kind = 'refund'   THEN  t.amount_cents ELSE 0 END), 0) AS refunds
     FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE t.lifecycle = 'active' AND t.kind IN ('purchase', 'refund')
       AND t.posted_date >= ? AND t.posted_date < ?
     GROUP BY t.category_id
     ORDER BY t.category_id`,
  ).all(monthStart(month), nextMonthStart(month)) as SpendingRow[];
  return new Map(rows.map(row => [row.categoryId, row]));
}

/**
 * Only the entries that can decide this month: the month's own exception and
 * the latest regular entry at or before it. The decision itself stays in the
 * pure resolver, so one month read and a whole plan cannot disagree.
 */
function effectiveEntries(db: SqliteDatabase, month: string) {
  const monthly = db.prepare(
    `SELECT category_id AS categoryId, month, state, amount_cents AS amount
     FROM budget_exceptions WHERE month = ?`,
  ).all(month) as ({ categoryId: string } & MonthlyBudgetEntry)[];
  const regular = db.prepare(
    `SELECT category_id AS categoryId, month, state, amount_cents AS amount
     FROM budget_schedule s WHERE s.month <= ?
       AND s.month = (SELECT MAX(x.month) FROM budget_schedule x
                      WHERE x.category_id = s.category_id AND x.month <= ?)`,
  ).all(month, month) as ({ categoryId: string } & RegularBudgetEntry)[];
  return {
    monthly: new Map(monthly.map(({ categoryId, ...entry }) => [categoryId, entry])),
    regular: new Map(regular.map(({ categoryId, ...entry }) => [categoryId, entry])),
  };
}

export function budgetMonth(db: SqliteDatabase, month: string): unknown {
  const planned = db.prepare(
    `SELECT p.category_id AS categoryId, p.version AS planVersion,
       c.archived_at AS archivedAt, c.archive_cutoff_month AS cutoffMonth
     FROM budget_plans p JOIN categories c ON c.id = p.category_id
     ORDER BY p.category_id`,
  ).all() as PlannedCategory[];
  const entries = effectiveEntries(db, month);
  const spending = spendingByCategory(db, month);

  const items = [];
  let totalLimit = 0n;
  let budgetedNet = 0n;
  const budgeted = new Set<string>();
  for (const plan of planned) {
    const regular = entries.regular.get(plan.categoryId);
    const monthly = entries.monthly.get(plan.categoryId);
    const effective = resolveBudget(
      { regular: regular === undefined ? [] : [regular], monthly: monthly === undefined ? [] : [monthly] },
      month,
      { archived: plan.archivedAt !== null, cutoffMonth: plan.cutoffMonth },
    );
    if (effective.state !== "amount") continue;
    const row = spending.get(plan.categoryId);
    const purchases = row?.purchases ?? 0n;
    const refunds = row?.refunds ?? 0n;
    const net = purchases - refunds;
    budgeted.add(plan.categoryId);
    totalLimit += effective.amount;
    budgetedNet += net;
    items.push({
      categoryId: plan.categoryId, limit: money(effective.amount), source: effective.source,
      purchases: aggregateMoney(purchases), refunds: aggregateMoney(refunds),
      net: aggregateMoney(net), remaining: aggregateMoney(effective.amount - net),
      percentUsed: budgetPercentUsed(net, effective.amount), planVersion: String(plan.planVersion),
    });
  }

  let unbudgetedNet = 0n;
  let uncategorizedNet = 0n;
  for (const row of spending.values()) {
    const net = row.purchases - row.refunds;
    if (row.systemKind === "uncategorized") uncategorizedNet += net;
    // Income is not expense spending, and a budgeted category is already
    // counted once in the totals above.
    else if (row.systemKind === null && !budgeted.has(row.categoryId)) unbudgetedNet += net;
  }

  return {
    month, items,
    totals: {
      limit: aggregateMoney(totalLimit), net: aggregateMoney(budgetedNet),
      remaining: aggregateMoney(totalLimit - budgetedNet),
      percentUsed: budgetPercentUsed(budgetedNet, totalLimit),
    },
    unbudgetedNet: aggregateMoney(unbudgetedNet), uncategorizedNet: aggregateMoney(uncategorizedNet),
    financeRevision: String(financeRevision(db)),
  };
}
