/**
 * Reviewing and applying one budget change.
 *
 * A preview is a durable record of exactly what the owner was shown: the
 * request, twelve months of before and after, every entry the change would
 * remove, and the plan and category state it was computed from. Applying it
 * writes that reviewed change and nothing else, inside one transaction, and
 * keeps the response it returned. Re-applying returns that saved response
 * rather than rebuilding one from whatever the plan looks like later.
 *
 * Previewing changes no financial configuration: it saves a review, not a
 * plan. A category with no plan can be previewed, and until an apply succeeds
 * it still has no plan.
 */

import type { SqliteDatabase } from "@workspace/db";

import {
  BudgetValidationError, budgetChangeMonth, budgetTimeline, requireBudgetCapacity, simulateBudgetChange,
  validateBudgetChange, type BudgetChange, type BudgetConfiguration, type EffectiveBudget,
} from "../domain/budgets.js";
import { assertYearMonth, monthOf } from "../domain/dates.js";
import { money, MoneyFormatError, parseMoney } from "../domain/money.js";
import type { BudgetChangeBody, BudgetChangePreview } from "../lib/budget-schemas.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import type { CommandContext } from "./accounts.js";
import {
  budgetConfiguration, budgetPlanDto, budgetPlanVersion, removedBudgetEntriesDto, writeBudgetConfiguration,
} from "./budget-plans.js";
import { requireCategory, type CategoryRow } from "./categories.js";
import { bumpFinanceRevision, financeRevision, writeAudit } from "./ledger.js";

export const PREVIEW_TTL_MS = 86_400_000;

/** The last month a twelve-month timeline can start in and still be representable. */
export const LAST_PREVIEW_START_MONTH = "2999-01";

interface StoredPreview {
  id: string;
  category_id: string;
  preview_json: string;
  dependencies_json: string;
  created_at: bigint;
  expires_at: bigint;
  applied_at: bigint | null;
  result_json: string | null;
}

/**
 * What a review depends on.
 *
 * The plan version alone cannot see an archive and reactivation of a category
 * that never had a plan, so the category's own version is captured too. That
 * is deliberately conservative: renaming or recoloring a category also stales
 * a pending budget review, and the owner previews again.
 */
function dependencies(db: SqliteDatabase, category: CategoryRow) {
  return {
    planVersion: budgetPlanVersion(db, category.id)?.toString() ?? null,
    categoryVersion: String(category.version),
  };
}

export function requireBudgetEligibleCategory(row: CategoryRow): void {
  if (row.system_kind !== null || row.protected === 1n) {
    throw problem({ status: 422, code: "budget_ineligible_category", title: "No budget for this category",
      detail: "Budgets are for expense categories, not Income or Uncategorized." });
  }
  if (row.archived_at !== null) {
    throw problem({ status: 409, code: "category_archived", title: "Category is archived",
      detail: "Reactivate this category before changing its budget." });
  }
}

function invalid(detail: string, path = "/change"): never {
  throw problem({ status: 422, code: "validation_failed", title: "Cannot make this budget change",
    detail, fieldErrors: [{ path, code: "invalid_value", message: detail }] });
}

function monthInPast(): never {
  throw problem({ status: 422, code: "month_in_past", title: "That month has passed",
    detail: "A repeating budget can start, or stop, no earlier than the current month." });
}

/** Domain refusals become the contract's failures; nothing else is swallowed. */
function translate<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof BudgetValidationError || error instanceof MoneyFormatError) invalid(error.message);
    throw error;
  }
}

function toChange(request: BudgetChangeBody): BudgetChange {
  return translate((): BudgetChange => {
    switch (request.change) {
      case "set_regular":
        return { change: "set_regular", fromMonth: assertYearMonth(request.fromMonth), amount: parseMoney(request.amount) };
      case "set_month":
        return { change: "set_month", month: assertYearMonth(request.month), amount: parseMoney(request.amount) };
      case "skip_month":
        return { change: "skip_month", month: assertYearMonth(request.month) };
      case "stop":
        return { change: "stop", fromMonth: assertYearMonth(request.fromMonth) };
    }
  });
}

function effectiveDto(value: EffectiveBudget) {
  return { state: value.state, amount: value.amount === null ? null : money(value.amount), source: value.source };
}

/**
 * The reviewed change, checked against the calendar and the plan's capacity.
 *
 * Both preview and apply run this, so a month that became past, or a plan that
 * can no longer hold the change, is refused at execution and not only at
 * review time.
 */
function reviewChange(before: BudgetConfiguration, change: BudgetChange, today: string) {
  const month = budgetChangeMonth(change);
  const currentMonth = monthOf(today);
  if ((change.change === "set_regular" || change.change === "stop") && month < currentMonth) monthInPast();
  if (month > LAST_PREVIEW_START_MONTH) {
    invalid("A twelve-month review has to fit inside the supported calendar, which ends at 2999-12.");
  }
  return translate(() => {
    validateBudgetChange(change, currentMonth);
    const result = simulateBudgetChange(before, change, currentMonth);
    requireBudgetCapacity(result.plan);
    return { ...result, month };
  });
}

export function createBudgetPreview(context: CommandContext, category: CategoryRow, request: BudgetChangeBody,
  check: (body: unknown) => unknown): { id: string; body: unknown } {
  const { db, now } = context;
  requireBudgetEligibleCategory(category);
  const change = toChange(request);
  const before = budgetConfiguration(db, category.id);
  const result = reviewChange(before, change, context.today);
  const preview = {
    id: context.newId().toLowerCase(), categoryId: category.id, request, status: "ready" as const,
    capturedPlanVersion: budgetPlanVersion(db, category.id)?.toString() ?? null,
    timeline: budgetTimeline(before, result.plan, result.month).map(entry => ({
      month: entry.month, before: effectiveDto(entry.before), after: effectiveDto(entry.after),
    })),
    removedEntries: removedBudgetEntriesDto(result.removed),
    createdAt: isoTimestamp(now), expiresAt: isoTimestamp(now + PREVIEW_TTL_MS), appliedAt: null,
  };
  const body = check(preview);
  db.prepare(`INSERT INTO budget_previews (id, category_id, preview_json, dependencies_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(preview.id, category.id, JSON.stringify(body),
    JSON.stringify(dependencies(db, category)), now, now + PREVIEW_TTL_MS);
  return { id: preview.id, body };
}

/** A preview belongs to one category; another category's id is simply not found here. */
function requirePreview(db: SqliteDatabase, categoryId: string, id: string): StoredPreview {
  const row = db.prepare("SELECT * FROM budget_previews WHERE id = ? AND category_id = ?")
    .get(id.toLowerCase(), categoryId) as StoredPreview | undefined;
  if (row === undefined) {
    throw problem({ status: 404, code: "not_found", title: "Not found",
      detail: "There is no budget review with that id for this category." });
  }
  return row;
}

export function applyBudgetChange(context: CommandContext, category: CategoryRow, previewId: string,
  check: (body: unknown) => unknown): unknown {
  const { db, now } = context;
  const saved = requirePreview(db, category.id, previewId);
  // A completed change replays its own recorded response, whatever has
  // happened since - including its own review expiring.
  if (saved.result_json !== null) return check(JSON.parse(saved.result_json));
  if (BigInt(now) >= saved.expires_at) {
    throw problem({ status: 410, code: "preview_expired", title: "Review expired",
      detail: "Preview the change again and review it before applying it." });
  }
  requireBudgetEligibleCategory(category);
  if (JSON.stringify(dependencies(db, category)) !== saved.dependencies_json) {
    throw problem({ status: 409, code: "preview_stale", title: "Budget changed",
      detail: "This budget or category changed since the review. Preview it again. Nothing was saved." });
  }
  const preview = JSON.parse(saved.preview_json) as BudgetChangePreview;
  const before = budgetConfiguration(db, category.id);
  const beforePlan = budgetPlanDto(db, category);
  const result = reviewChange(before, toChange(preview.request), context.today);
  writeBudgetConfiguration(context, category.id, result.plan);
  const plan = budgetPlanDto(db, requireCategory(db, category.id));
  writeAudit(db, context.newId, now, { entityType: "budget", entityId: category.id,
    eventType: "budget_changed", before: beforePlan,
    after: { plan, request: preview.request, removedEntries: preview.removedEntries, previewId: preview.id } });
  bumpFinanceRevision(db);
  const body = check({ preview: { ...preview, status: "applied", appliedAt: isoTimestamp(now) },
    plan, financeRevision: String(financeRevision(db)) });
  db.prepare("UPDATE budget_previews SET applied_at = ?, result_json = ? WHERE id = ?")
    .run(now, JSON.stringify(body), saved.id);
  return body;
}
