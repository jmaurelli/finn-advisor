import { assertYearMonth, nextMonthStart } from "./dates.js";
import { absolute, assertWithin, STORED_BOUND } from "./money.js";

export type BudgetAmount = { state: "amount"; amount: bigint };
export type RegularBudgetEntry = { month: string } & (BudgetAmount | { state: "stopped"; amount: null });
export type MonthlyBudgetEntry = { month: string } & (BudgetAmount | { state: "skip"; amount: null });
export interface BudgetConfiguration {
  regular: readonly RegularBudgetEntry[];
  monthly: readonly MonthlyBudgetEntry[];
}
export type BudgetChange =
  | { change: "set_regular"; fromMonth: string; amount: bigint }
  | { change: "set_month"; month: string; amount: bigint }
  | { change: "skip_month"; month: string }
  | { change: "stop"; fromMonth: string };
export type EffectiveBudget =
  | { state: "amount"; amount: bigint; source: "regular" | "monthly" }
  | { state: "absent"; amount: null; source: null };
export type RemovedBudgetEntry =
  | { kind: "regular"; entry: RegularBudgetEntry }
  | { kind: "monthly"; entry: MonthlyBudgetEntry };

export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetValidationError";
  }
}

export const BUDGET_ENTRY_LIMIT = 1000;

export function requireBudgetCapacity(plan: BudgetConfiguration): void {
  const latest = [...plan.regular].sort(byMonth).at(-1);
  const reservation = latest?.state === "stopped" ? 0 : 1;
  if (plan.regular.length + plan.monthly.length + reservation > BUDGET_ENTRY_LIMIT) {
    throw new BudgetValidationError("A budget supports 1,000 combined entries, including room to stop it when archived.");
  }
}

export function simulateBudgetArchive(plan: BudgetConfiguration, cutoffMonth: string, currentMonth: string) {
  const result = simulateBudgetChange(plan, { change: "stop", fromMonth: cutoffMonth }, currentMonth);
  const prior = result.plan.regular.filter(entry => entry.month < cutoffMonth).at(-1);
  // Keep an existing permanent stop rather than accumulating a marker on each
  // archive/reactivate cycle. Future exceptions are still removed in full.
  if (prior?.state === "stopped") result.plan.regular = result.plan.regular.filter(entry => entry.month !== cutoffMonth);
  // A stop marker already at the cutoff is removed and re-added unchanged. It
  // is still there afterwards, so reporting it as removed would show a review
  // a phantom change.
  result.removed = result.removed.filter(({ kind, entry }) => !(kind === "regular" && result.plan.regular
    .some(kept => kept.month === entry.month && kept.state === entry.state && kept.amount === entry.amount)));
  requireBudgetCapacity(result.plan);
  return result;
}

function absent(): EffectiveBudget {
  return { state: "absent", amount: null, source: null };
}

function validateAmount(amount: bigint): void {
  assertWithin(amount, STORED_BOUND);
  if (amount < 0n) throw new BudgetValidationError("A budget amount cannot be negative.");
}

export function validateBudgetConfiguration(plan: BudgetConfiguration): void {
  for (const entries of [plan.regular, plan.monthly]) {
    const seen = new Set<string>();
    for (const entry of entries) {
      assertYearMonth(entry.month);
      if (seen.has(entry.month)) throw new BudgetValidationError("Duplicate budget month.");
      seen.add(entry.month);
      if (entry.state === "amount") validateAmount(entry.amount);
      else if (entry.amount !== null) throw new BudgetValidationError("Absent entries must not have an amount.");
    }
  }
}

/** A cutoff is active only while archived; reactivation never removes stop markers. */
export function resolveBudget(plan: BudgetConfiguration, month: string,
  lifecycle: { archived: boolean; cutoffMonth: string | null } = { archived: false, cutoffMonth: null }): EffectiveBudget {
  assertYearMonth(month);
  if (lifecycle.cutoffMonth !== null) assertYearMonth(lifecycle.cutoffMonth);
  if (lifecycle.archived && lifecycle.cutoffMonth !== null && month >= lifecycle.cutoffMonth) return absent();
  const monthly = plan.monthly.find(entry => entry.month === month);
  if (monthly !== undefined) return monthly.state === "skip" ? absent()
    : { state: "amount", amount: monthly.amount, source: "monthly" };
  let latest: RegularBudgetEntry | undefined;
  for (const entry of plan.regular) {
    if (entry.month <= month && (latest === undefined || entry.month > latest.month)) latest = entry;
  }
  return latest === undefined || latest.state === "stopped" ? absent()
    : { state: "amount", amount: latest.amount, source: "regular" };
}

export function budgetChangeMonth(change: BudgetChange): string {
  return assertYearMonth("fromMonth" in change ? change.fromMonth : change.month);
}

export function validateBudgetChange(change: BudgetChange, currentMonth: string): void {
  const month = budgetChangeMonth(change);
  assertYearMonth(currentMonth);
  if ((change.change === "set_regular" || change.change === "stop") && month < currentMonth) {
    throw new BudgetValidationError("Regular changes and stops cannot change past months.");
  }
  if ("amount" in change) validateAmount(change.amount);
}

function byMonth(left: { month: string }, right: { month: string }): number {
  return left.month < right.month ? -1 : left.month > right.month ? 1 : 0;
}

/** No capacity admission here: archive and owner commands have different reservation needs. */
export function simulateBudgetChange(plan: BudgetConfiguration, change: BudgetChange, currentMonth: string) {
  validateBudgetConfiguration(plan);
  validateBudgetChange(change, currentMonth);
  const month = budgetChangeMonth(change);
  let regular = plan.regular.map(entry => ({ ...entry }));
  let monthly = plan.monthly.map(entry => ({ ...entry }));
  const removed: RemovedBudgetEntry[] = [];
  switch (change.change) {
    case "set_regular":
      regular = regular.filter(entry => entry.month !== month);
      regular.push({ month, state: "amount", amount: change.amount });
      break;
    case "set_month":
    case "skip_month":
      monthly = monthly.filter(entry => entry.month !== month);
      monthly.push(change.change === "set_month" ? { month, state: "amount", amount: change.amount }
        : { month, state: "skip", amount: null });
      break;
    case "stop":
      for (const entry of regular) if (entry.month >= month) removed.push({ kind: "regular", entry });
      for (const entry of monthly) if (entry.month >= month) removed.push({ kind: "monthly", entry });
      regular = regular.filter(entry => entry.month < month);
      monthly = monthly.filter(entry => entry.month < month);
      regular.push({ month, state: "stopped", amount: null });
      break;
  }
  removed.sort((left, right) => byMonth(left.entry, right.entry)
    || (left.kind === right.kind ? 0 : left.kind === "regular" ? -1 : 1));
  return { plan: { regular: regular.sort(byMonth), monthly: monthly.sort(byMonth) }, removed };
}

export function budgetTimeline(before: BudgetConfiguration, after: BudgetConfiguration, startMonth: string) {
  assertYearMonth(startMonth);
  const timeline = [];
  let month = startMonth;
  for (let index = 0; index < 12; index++) {
    assertYearMonth(month);
    timeline.push({ month, before: resolveBudget(before, month), after: resolveBudget(after, month) });
    month = nextMonthStart(month).slice(0, 7);
  }
  return timeline;
}

/** Display only: nearest integer, ties away from zero, never an unsafe JSON integer. */
export function budgetPercentUsed(net: bigint, limit: bigint): number | null {
  if (limit < 0n) throw new BudgetValidationError("A budget limit cannot be negative.");
  if (limit === 0n) return null;
  const numerator = absolute(net) * 100n;
  const rounded = (numerator * 2n + limit) / (limit * 2n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BudgetValidationError("Budget percentage exceeds the safe display integer range.");
  }
  return Number(net < 0n ? -rounded : rounded);
}
