import type { SqliteDatabase } from "@workspace/db";
import {
  requireBudgetCapacity, resolveBudget, simulateBudgetArchive, validateBudgetConfiguration,
  type BudgetConfiguration, type MonthlyBudgetEntry, type RegularBudgetEntry, type RemovedBudgetEntry,
} from "../domain/budgets.js";
import { assertYearMonth, monthOf, nextMonthStart } from "../domain/dates.js";
import { money } from "../domain/money.js";
import { nextCounter } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import type { CommandContext } from "./accounts.js";
import type { CategoryRow } from "./categories.js";
import { writeAudit } from "./ledger.js";

export const LAST_SUPPORTED_MONTH = "2999-12";

export function budgetPlanVersion(db: SqliteDatabase, categoryId: string): bigint | null {
  const row = db.prepare("SELECT version FROM budget_plans WHERE category_id = ?").get(categoryId) as { version: bigint } | undefined;
  return row?.version ?? null;
}

export function budgetConfiguration(db: SqliteDatabase, categoryId: string): BudgetConfiguration {
  return {
    regular: db.prepare("SELECT month, state, amount_cents AS amount FROM budget_schedule WHERE category_id = ? ORDER BY month")
      .all(categoryId) as RegularBudgetEntry[],
    monthly: db.prepare("SELECT month, state, amount_cents AS amount FROM budget_exceptions WHERE category_id = ? ORDER BY month")
      .all(categoryId) as MonthlyBudgetEntry[],
  };
}

export function budgetPlanDto(db: SqliteDatabase, category: CategoryRow) {
  const plan = budgetConfiguration(db, category.id);
  return {
    categoryId: category.id, version: budgetPlanVersion(db, category.id)?.toString() ?? null,
    regularSchedule: plan.regular.map(entry => ({ effectiveMonth: entry.month, state: entry.state,
      amount: entry.amount === null ? null : money(entry.amount) })),
    monthlyEntries: plan.monthly.map(entry => ({ month: entry.month, state: entry.state,
      amount: entry.amount === null ? null : money(entry.amount) })),
    archiveCutoffMonth: category.archived_at === null ? null : category.archive_cutoff_month,
  };
}

export function removedBudgetEntriesDto(entries: readonly RemovedBudgetEntry[]) {
  return entries.map(({ kind, entry }) => ({ entryType: kind, month: entry.month, state: entry.state,
    amount: entry.amount === null ? null : money(entry.amount) }));
}

/** Caller owns the write transaction, audit and finance revision. */
export function writeBudgetConfiguration(context: CommandContext, categoryId: string, plan: BudgetConfiguration): void {
  if (!context.db.inTransaction) throw new Error("Budget writes require a transaction.");
  validateBudgetConfiguration(plan);
  requireBudgetCapacity(plan);
  const version = budgetPlanVersion(context.db, categoryId);
  if (version === null) {
    context.db.prepare("INSERT INTO budget_plans (category_id, version, created_at, updated_at) VALUES (?, 1, ?, ?)")
      .run(categoryId, context.now, context.now);
  } else {
    context.db.prepare("UPDATE budget_plans SET version = ?, updated_at = ? WHERE category_id = ?")
      .run(nextCounter(version), context.now, categoryId);
  }
  context.db.prepare("DELETE FROM budget_exceptions WHERE category_id = ?").run(categoryId);
  context.db.prepare("DELETE FROM budget_schedule WHERE category_id = ?").run(categoryId);
  const regular = context.db.prepare("INSERT INTO budget_schedule (category_id, month, state, amount_cents) VALUES (?, ?, ?, ?)");
  // Install the final stop first so SQL capacity admission has its reservation.
  for (const entry of [...plan.regular].sort((a, b) => b.month.localeCompare(a.month))) {
    regular.run(categoryId, entry.month, entry.state, entry.amount);
  }
  const monthly = context.db.prepare("INSERT INTO budget_exceptions (category_id, month, state, amount_cents) VALUES (?, ?, ?, ?)");
  for (const entry of plan.monthly) monthly.run(categoryId, entry.month, entry.state, entry.amount);
}

/**
 * Archiving keeps this month and stops from the next one, which the archived
 * category then stores. In the final supported month there is no next month to
 * name, so archiving is refused rather than wrapped into an unrepresentable
 * one. The refusal is a conflict when reviewing the impact and a validation
 * failure when commanding the archive, which is what each operation declares.
 */
function requireRepresentableCutoff(currentMonth: string, status: 409 | 422): void {
  if (currentMonth < LAST_SUPPORTED_MONTH) return;
  throw problem({ status, code: "validation_failed", title: "The supported calendar ends here",
    detail: "A category cannot be archived in the last supported month, because its budget would have to stop after 2999-12." });
}

export function budgetArchiveImpact(db: SqliteDatabase, category: CategoryRow, today: string, status: 409 | 422 = 422) {
  const currentMonth = monthOf(today);
  requireRepresentableCutoff(currentMonth, status);
  // An archived category already has its cutoff; only an active one is asking
  // what archiving now would do.
  const cutoffMonth = category.archived_at !== null && category.archive_cutoff_month !== null
    ? category.archive_cutoff_month
    : assertYearMonth(nextMonthStart(currentMonth).slice(0, 7));
  const plan = budgetConfiguration(db, category.id);
  const version = budgetPlanVersion(db, category.id);
  const effective = resolveBudget(plan, currentMonth, {
    archived: category.archived_at !== null, cutoffMonth: category.archive_cutoff_month,
  });
  return { planVersion: version?.toString() ?? null, cutoffMonth,
    currentMonthLimit: effective.amount === null ? null : money(effective.amount),
    removedEntries: version === null || category.archived_at !== null ? []
      : removedBudgetEntriesDto(simulateBudgetArchive(plan, cutoffMonth, currentMonth).removed) };
}

/** Entry amounts are `bigint`, so this compares them directly rather than through JSON. */
function sameConfiguration(left: BudgetConfiguration, right: BudgetConfiguration): boolean {
  const same = (a: readonly { month: string; state: string; amount: bigint | null }[],
    b: readonly { month: string; state: string; amount: bigint | null }[]) =>
    a.length === b.length && a.every((entry, index) =>
      entry.month === b[index]?.month && entry.state === b[index].state && entry.amount === b[index].amount);
  return same(left.regular, right.regular) && same(left.monthly, right.monthly);
}

export function stopBudgetForArchive(context: CommandContext, category: CategoryRow, cutoff: string): void {
  if (budgetPlanVersion(context.db, category.id) === null) return;
  const before = budgetPlanDto(context.db, category);
  const configuration = budgetConfiguration(context.db, category.id);
  const result = simulateBudgetArchive(configuration, cutoff, monthOf(context.today));
  // An already-stopped budget with nothing after the cutoff is left exactly as
  // it is: its history would otherwise record a stop that changed nothing, and
  // its version would move without the configuration moving. (A pending review
  // is staled either way, by the category version the archive does bump.)
  if (sameConfiguration(result.plan, configuration)) return;
  writeBudgetConfiguration(context, category.id, result.plan);
  writeAudit(context.db, context.newId, context.now, { entityType: "budget", entityId: category.id,
    eventType: "budget_stopped", reason: "category archived", before,
    after: { plan: budgetPlanDto(context.db, { ...category, archived_at: BigInt(context.now), archive_cutoff_month: cutoff }),
      removedEntries: removedBudgetEntriesDto(result.removed) } });
}
