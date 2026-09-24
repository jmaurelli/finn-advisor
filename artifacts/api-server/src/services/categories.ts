import type { SqliteDatabase } from "@workspace/db";
import { creationDigest } from "../domain/digest.js";
import { nextCounter } from "../domain/versions.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem, type BlockingReference } from "../lib/problem.js";
import type { CommandContext } from "./accounts.js";
import { budgetArchiveImpact, budgetPlanDto, budgetPlanVersion, stopBudgetForArchive } from "./budget-plans.js";
import { bumpFinanceRevision, requireUnusedEntityId, writeAudit } from "./ledger.js";
import {
  activeRules, bumpRuleSetRevision, configOf, requireRevisionRoom, requireRuleSetRevision, requireRuleTarget,
  requireTargetCapacity,
  ruleSetRevision, singleRuleDto, writeRevision, type RuleRow,
} from "./rules.js";

export interface CategoryRow {
  id: string;
  display_name: string;
  normalized_name: string;
  description: string | null;
  color: string;
  system_kind: "income" | "uncategorized" | null;
  protected: bigint;
  archived_at: bigint | null;
  archive_cutoff_month: string | null;
  creation_digest: string | null;
  version: bigint;
  created_at: bigint;
  updated_at: bigint;
}

export function categoryDto(row: CategoryRow) {
  return {
    id: row.id, name: row.display_name, description: row.description, color: row.color,
    systemKind: row.system_kind, protected: row.protected === 1n,
    status: row.archived_at === null ? "active" : "archived",
    archivedAt: row.archived_at === null ? null : isoTimestamp(Number(row.archived_at)),
    version: String(row.version), createdAt: isoTimestamp(Number(row.created_at)),
    updatedAt: isoTimestamp(Number(row.updated_at)),
  };
}

export function requireCategory(db: SqliteDatabase, id: string): CategoryRow {
  const row = db.prepare("SELECT * FROM categories WHERE id = ?").get(id.toLowerCase()) as CategoryRow | undefined;
  if (row === undefined) throw problem({
    status: 404, code: "not_found", title: "Not found", detail: "There is no category with that id.",
  });
  return row;
}

export function requireCustomCategory(row: CategoryRow): void {
  if (row.protected === 1n) throw problem({
    status: 409, code: "category_protected", title: "Protected category",
    detail: "Income and Uncategorized must remain available and cannot be edited or removed.",
  });
}

function nameKey(name: string): string {
  const normalized = name.trim().replace(/\s+/gu, " ").toLowerCase();
  if (normalized.length === 0) throw problem({
    status: 422, code: "validation_failed", title: "Name needed", detail: "Give the category a name.",
    fieldErrors: [{ path: "/name", code: "invalid_value", message: "Enter a name, not only spaces." }],
  });
  return normalized;
}

function requireUniqueName(db: SqliteDatabase, key: string, id: string): void {
  if (db.prepare("SELECT id FROM categories WHERE normalized_name = ? AND id <> ?").get(key, id)) {
    throw problem({
      status: 409, code: "category_name_taken", title: "Name already used",
      detail: "Another category already has that name, including archived categories.",
      fieldErrors: [{ path: "/name", code: "category_name_taken", message: "Choose a different name." }],
    });
  }
}

export interface CreateCategoryInput {
  id: string;
  name: string;
  description?: string | null;
  color: string;
}

export function createCategory(context: CommandContext, input: CreateCategoryInput) {
  const { db, now } = context;
  const id = input.id.toLowerCase();
  const digest = creationDigest({ name: input.name, description: input.description ?? null, color: input.color });
  const existing = db.prepare("SELECT * FROM categories WHERE id = ?").get(id) as CategoryRow | undefined;
  if (existing !== undefined) {
    if (existing.creation_digest === digest) return { status: 200 as const, row: existing };
    throw problem({ status: 409, code: "client_id_conflict", title: "Already used for something else",
      detail: "This category id was already saved with different values. Reload before trying again." });
  }
  requireUnusedEntityId(db, "category", id,
    "This id belonged to a category that was later deleted. Use a new id to create it again.");
  const key = nameKey(input.name);
  requireUniqueName(db, key, id);
  const count = db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: bigint };
  if (count.n >= 1000n) throw problem({
    status: 422, code: "validation_failed", title: "Category limit reached",
    detail: "The complete category list supports 1,000 categories, including archived and built-in categories. Delete an unused custom category before adding another.",
  });
  db.prepare(`INSERT INTO categories (id, display_name, normalized_name, description, color,
    system_kind, protected, archived_at, version, created_at, updated_at, creation_digest)
    VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, 1, ?, ?, ?)`)
    .run(id, input.name, key, input.description ?? null, input.color, now, now, digest);
  const row = requireCategory(db, id);
  writeAudit(db, context.newId, now, { entityType: "category", entityId: id,
    eventType: "category_created", after: categoryDto(row) });
  bumpFinanceRevision(db);
  return { status: 201 as const, row };
}

export function listCategories(db: SqliteDatabase, status: string): CategoryRow[] {
  const where = status === "all" ? "" : status === "archived"
    ? "WHERE protected = 1 OR archived_at IS NOT NULL" : "WHERE archived_at IS NULL";
  return db.prepare(`SELECT * FROM categories ${where} ORDER BY protected DESC, normalized_name, id`).all() as CategoryRow[];
}

export function updateCategory(context: CommandContext, row: CategoryRow, patch: Partial<Omit<CreateCategoryInput, "id">>) {
  requireCustomCategory(row);
  const name = patch.name ?? row.display_name;
  const key = nameKey(name);
  requireUniqueName(context.db, key, row.id);
  context.db.prepare(`UPDATE categories SET display_name = ?, normalized_name = ?, description = ?,
    color = ?, version = ?, updated_at = ? WHERE id = ?`).run(name, key,
    patch.description === undefined ? row.description : patch.description, patch.color ?? row.color,
    nextCounter(row.version), context.now, row.id);
  const changed = requireCategory(context.db, row.id);
  writeAudit(context.db, context.newId, context.now, { entityType: "category", entityId: row.id,
    eventType: "category_updated", before: categoryDto(row), after: categoryDto(changed) });
  bumpFinanceRevision(context.db);
  return changed;
}

export function categoryReferences(db: SqliteDatabase, id: string): BlockingReference[] {
  const blocking: BlockingReference[] = [];
  if (budgetPlanVersion(db, id) !== null || db.prepare("SELECT 1 FROM budget_previews WHERE category_id = ? LIMIT 1").get(id)) {
    throw problem({ status: 409, code: "category_in_use", title: "Category has budget history",
      detail: "A retained budget plan or review refers to this category. Archive it instead." });
  }
  // History and reviewed proposals retain references even after the current assignment changes.
  const transactions = db.prepare(`SELECT id FROM transactions WHERE category_id = ?
    UNION SELECT transaction_id FROM assignment_events WHERE before_category_id = ? OR after_category_id = ?
    UNION SELECT transaction_id FROM rule_run_rows WHERE before_category_id = ? OR after_category_id = ?
    ORDER BY 1`).all(id, id, id, id, id) as { id: string }[];
  if (transactions.length > 0) blocking.push({ kind: "transaction", count: transactions.length,
    ids: transactions.slice(0, 20).map(row => row.id) });
  const rules = db.prepare("SELECT DISTINCT rule_id AS id FROM rule_revisions WHERE category_id = ? ORDER BY rule_id")
    .all(id) as { id: string }[];
  if (rules.length > 0) blocking.push({ kind: "rule", count: rules.length, ids: rules.slice(0, 20).map(row => row.id) });
  // Repair/run snapshots can retain a category only inside JSON (for example, a saved scope).
  for (const table of ["repair_previews", "rule_runs"] as const) {
    const saved = db.prepare(`SELECT DISTINCT p.id FROM ${table} p, json_tree(p.preview_json) j
      WHERE j.type = 'text' AND lower(j.atom) = ?
      UNION SELECT DISTINCT p.id FROM ${table} p, json_tree(p.result_json) j
      WHERE j.type = 'text' AND lower(j.atom) = ?`).all(id, id);
    if (saved.length > 0) throw problem({ status: 409, code: "category_in_use", title: "Category has saved history",
      detail: "A saved review or result still refers to this category. Archive it instead." });
  }
  return blocking;
}

export function deleteCategory(context: CommandContext, row: CategoryRow): void {
  requireCustomCategory(row);
  const blocking = categoryReferences(context.db, row.id);
  if (blocking.length > 0) throw problem({ status: 409, code: "category_in_use", title: "Category has history",
    detail: "Categories with saved references cannot be deleted. Archive it instead.", blocking });
  context.db.prepare("DELETE FROM categories WHERE id = ?").run(row.id);
  writeAudit(context.db, context.newId, context.now, { entityType: "category", entityId: row.id,
    eventType: "category_deleted", before: categoryDto(row) });
  bumpFinanceRevision(context.db);
}

export function reactivateCategory(context: CommandContext, row: CategoryRow): CategoryRow {
  if (row.archived_at === null) return row;
  context.db.prepare(`UPDATE categories SET archived_at = NULL, archive_cutoff_month = NULL,
    version = ?, updated_at = ? WHERE id = ?`).run(nextCounter(row.version), context.now, row.id);
  const changed = requireCategory(context.db, row.id);
  writeAudit(context.db, context.newId, context.now, { entityType: "category", entityId: row.id,
    eventType: "category_reactivated", before: categoryDto(row), after: categoryDto(changed) });
  bumpFinanceRevision(context.db);
  return changed;
}

function targetingRules(db: SqliteDatabase, id: string): RuleRow[] {
  return activeRules(db).filter(rule => rule.category_id === id);
}

export function categoryArchiveImpact(db: SqliteDatabase, row: CategoryRow, today: string) {
  requireCustomCategory(row);
  return {
    categoryId: row.id, categoryVersion: String(row.version), ruleSetRevision: String(ruleSetRevision(db)),
    activeRules: targetingRules(db, row.id).map(rule => ({ ruleId: rule.id, position: Number(rule.position),
      matchType: rule.match_type, pattern: rule.pattern, enabled: rule.enabled === 1n, version: String(rule.version) })),
    budget: budgetArchiveImpact(db, row, today, 409),
  };
}

export interface RuleResolution {
  ruleId: string;
  action: "disable" | "retarget";
  targetCategoryId: string | null;
}

function resolutionError(detail: string, path = "/ruleResolutions") {
  return problem({ status: 422, code: "validation_failed", title: "Rule changes do not match",
    detail, fieldErrors: [{ path, code: "invalid_value", message: detail }] });
}

/**
 * Archives a category in one transaction: resolves every enabled active rule
 * targeting it (disable or retarget), stops its budget from next month
 * and archives it. Disabled rules keep their retained target and need nothing.
 * An already archived category is returned unchanged.
 */
export function archiveCategory(context: CommandContext, row: CategoryRow,
  input: { ruleSetRevision: string; budgetPlanVersion: string | null; ruleResolutions: RuleResolution[] }) {
  const { db, now } = context;
  requireCustomCategory(row);
  requireRuleSetRevision(db, input.ruleSetRevision);
  if (input.budgetPlanVersion !== (budgetPlanVersion(db, row.id)?.toString() ?? null)) throw problem({ status: 409, code: "preview_stale",
    title: "Budget changed", detail: "The budget plan changed. Reload the archive review and try again." });
  const required = new Map(targetingRules(db, row.id).filter(rule => rule.enabled === 1n).map(rule => [rule.id, rule]));
  const seen = new Set<string>();
  const plan = input.ruleResolutions.map((resolution, index) => {
    const path = `/ruleResolutions/${index}`;
    const rule = required.get(resolution.ruleId.toLowerCase());
    if (rule === undefined || seen.has(rule.id)) {
      throw resolutionError("Resolve each enabled rule that uses this category exactly once.", `${path}/ruleId`);
    }
    seen.add(rule.id);
    const target = resolution.targetCategoryId?.toLowerCase() ?? null;
    if ((resolution.action === "disable") !== (target === null)) {
      throw resolutionError("Retarget needs a category; disable must not name one.", `${path}/targetCategoryId`);
    }
    if (target === row.id) throw problem({ status: 422, code: "rule_target_ineligible",
      title: "Rules need an active expense category", detail: "Choose a different category for the rule.",
      fieldErrors: [{ path: `${path}/targetCategoryId`, code: "rule_target_ineligible", message: "Choose another category." }] });
    if (target !== null) requireRuleTarget(db, target, `${path}/targetCategoryId`);
    requireRevisionRoom(rule, 1n);
    return { rule, target };
  });
  if (seen.size !== required.size) throw resolutionError("Resolve every enabled rule that uses this category.");
  const retargets = new Map<string, number>();
  for (const { target } of plan) if (target !== null) retargets.set(target, (retargets.get(target) ?? 0) + 1);
  for (const [target, adding] of retargets) requireTargetCapacity(db, target, adding, "/ruleResolutions");
  const retainedPlan = () => budgetPlanVersion(db, row.id) === null ? null : budgetPlanDto(db, requireCategory(db, row.id));
  if (row.archived_at !== null) return { row, rulesChanged: [] as RuleRow[], budgetPlan: retainedPlan() };

  const rulesChanged = plan.map(({ rule, target }) => {
    const changed = target === null
      ? writeRevision(context, rule, "disabled", { ...configOf(rule), enabled: false })
      : writeRevision(context, rule, "retargeted", { ...configOf(rule), categoryId: target });
    writeAudit(db, context.newId, now, { entityType: "rule", entityId: rule.id, eventType: "rule_updated",
      reason: "category archived", before: singleRuleDto(db, rule), after: singleRuleDto(db, changed) });
    return changed;
  });
  if (rulesChanged.length > 0) bumpRuleSetRevision(db);
  const cutoff = budgetArchiveImpact(db, row, context.today).cutoffMonth;
  stopBudgetForArchive(context, row, cutoff);
  db.prepare(`UPDATE categories SET archived_at = ?, archive_cutoff_month = ?, version = ?, updated_at = ?
    WHERE id = ?`).run(now, cutoff, nextCounter(row.version), now, row.id);
  const archived = requireCategory(db, row.id);
  writeAudit(db, context.newId, now, { entityType: "category", entityId: row.id, eventType: "category_archived",
    before: categoryDto(row), after: { ...categoryDto(archived), archiveCutoffMonth: cutoff,
      rulesChanged: rulesChanged.map(rule => rule.id) } });
  bumpFinanceRevision(db);
  return { row: archived, rulesChanged, budgetPlan: retainedPlan() };
}
