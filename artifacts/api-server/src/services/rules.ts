/**
 * Rule commands. A rule row holds lifecycle and order; its configuration lives
 * in immutable revisions, so an earlier assignment keeps the explanation it
 * was made with. Rule changes affect future assignments only: nothing here
 * touches a transaction.
 */
import type { SqliteDatabase } from "@workspace/db";

import {
  AssignmentTextError,
  normalizeRulePattern,
  type RuleAppliesTo,
  type RuleMatchType,
} from "../domain/assignment.js";
import { creationDigest } from "../domain/digest.js";
import { formatCounter, nextCounter } from "../domain/versions.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import type { CommandContext } from "./accounts.js";
import type { CategoryRow } from "./categories.js";
import { currentRuleAssignmentCount } from "./assignment.js";
import { bumpFinanceRevision, writeAudit } from "./ledger.js";

/** RuleList `maxItems`: the complete list, archived rules included, must stay listable. */
export const MAX_RULES = 2000;
/** Archive impact and resolutions list at most 1,000 rules targeting one category. */
export const MAX_RULES_PER_CATEGORY = 1000n;
/**
 * RuleHistory `maxItems`. Owner edits stop two short, so after they stop one
 * category-archive disable/retarget and a final rule archive still fit.
 */
export const MAX_REVISIONS = 1000n;

export type RuleChange = "created" | "edited" | "enabled" | "disabled" | "retargeted" | "archived";

export interface RuleRow {
  id: string;
  position: bigint | null;
  revision: bigint;
  archived_at: bigint | null;
  creation_digest: string;
  version: bigint;
  created_at: bigint;
  updated_at: bigint;
  change: RuleChange;
  match_type: RuleMatchType;
  pattern: string;
  normalized_pattern: string;
  account_id: string | null;
  applies_to: RuleAppliesTo;
  category_id: string;
  category_name: string;
  enabled: bigint;
}

export interface RuleConfig {
  matchType: RuleMatchType;
  pattern: string;
  accountId: string | null;
  appliesTo: RuleAppliesTo;
  categoryId: string;
  enabled: boolean;
}

const CURRENT = `SELECT r.id, r.position, r.revision, r.archived_at, r.creation_digest, r.version,
  r.created_at, r.updated_at, v.change, v.match_type, v.pattern, v.normalized_pattern, v.account_id,
  v.applies_to, v.category_id, v.category_name, v.enabled
  FROM rules r JOIN rule_revisions v ON v.rule_id = r.id AND v.revision = r.revision`;

export function ruleSetRevision(db: SqliteDatabase): bigint {
  return (db.prepare("SELECT rule_set_revision AS r FROM ledger_metadata WHERE id = 1").get() as { r: bigint }).r;
}

export function bumpRuleSetRevision(db: SqliteDatabase): bigint {
  const next = nextCounter(ruleSetRevision(db));
  db.prepare("UPDATE ledger_metadata SET rule_set_revision = ? WHERE id = 1").run(next);
  return next;
}

export function findRule(db: SqliteDatabase, id: string): RuleRow | undefined {
  return db.prepare(`${CURRENT} WHERE r.id = ?`).get(id.toLowerCase()) as RuleRow | undefined;
}

export function requireRule(db: SqliteDatabase, id: string): RuleRow {
  const row = findRule(db, id);
  if (row === undefined) throw problem({
    status: 404, code: "not_found", title: "Not found", detail: "There is no rule with that id.",
  });
  return row;
}

export function activeRules(db: SqliteDatabase): RuleRow[] {
  return db.prepare(`${CURRENT} WHERE r.archived_at IS NULL ORDER BY r.position`).all() as RuleRow[];
}

export function listRules(db: SqliteDatabase, status: string): RuleRow[] {
  const archived = db.prepare(`${CURRENT} WHERE r.archived_at IS NOT NULL ORDER BY r.archived_at DESC, r.id`)
    .all() as RuleRow[];
  if (status === "archived") return archived;
  return status === "all" ? [...activeRules(db), ...archived] : activeRules(db);
}

/** Transactions whose current assignment came from the rule, at any retained revision. */
export function assignmentCounts(db: SqliteDatabase): Map<string, bigint> {
  const rows = db.prepare(`SELECT rule_id AS id, COUNT(*) AS n FROM transactions
    WHERE assignment_origin = 'rule' AND lifecycle = 'active' GROUP BY rule_id`).all() as { id: string; n: bigint }[];
  return new Map(rows.map(row => [row.id, row.n]));
}

export function ruleDto(row: RuleRow, count: bigint) {
  return {
    id: row.id, position: row.position === null ? null : Number(row.position),
    revision: formatCounter(row.revision), matchType: row.match_type, pattern: row.pattern,
    accountId: row.account_id, appliesTo: row.applies_to, categoryId: row.category_id,
    enabled: row.enabled === 1n, status: row.archived_at === null ? "active" : "archived",
    currentAssignmentCount: Number(count), version: formatCounter(row.version),
    createdAt: isoTimestamp(Number(row.created_at)), updatedAt: isoTimestamp(Number(row.updated_at)),
  };
}

export function singleRuleDto(db: SqliteDatabase, row: RuleRow) {
  return ruleDto(row, currentRuleAssignmentCount(db, row.id));
}

export function configOf(row: RuleRow): RuleConfig {
  return {
    matchType: row.match_type, pattern: row.pattern, accountId: row.account_id,
    appliesTo: row.applies_to, categoryId: row.category_id, enabled: row.enabled === 1n,
  };
}

function patternKey(pattern: string): string {
  try {
    return normalizeRulePattern(pattern);
  } catch (error) {
    if (!(error instanceof AssignmentTextError)) throw error;
    throw problem({ status: 422, code: "validation_failed", title: "Pattern needed", detail: error.message,
      fieldErrors: [{ path: "/pattern", code: "invalid_value", message: error.message }] });
  }
}

/** New targets must be active expense categories. */
export function requireRuleTarget(db: SqliteDatabase, categoryId: string, path = "/categoryId"): CategoryRow {
  const row = db.prepare("SELECT * FROM categories WHERE id = ?").get(categoryId.toLowerCase()) as CategoryRow | undefined;
  if (row === undefined || row.system_kind !== null) throw problem({
    status: 422, code: "rule_target_ineligible", title: "Rules need an expense category",
    detail: "A rule can only assign an existing expense category, not Income or Uncategorized.",
    fieldErrors: [{ path, code: "rule_target_ineligible", message: "Choose an active expense category." }],
  });
  if (row.archived_at !== null) throw problem({
    status: 409, code: "category_archived", title: "Category is archived",
    detail: `${row.display_name} is archived. Reactivate it or choose another category.`,
  });
  return row;
}

/** Keeps every category's archive impact and resolution list within the contract. */
export function requireTargetCapacity(db: SqliteDatabase, categoryId: string, adding: number, path = "/categoryId"): void {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM rules r JOIN rule_revisions v ON v.rule_id = r.id
    AND v.revision = r.revision WHERE r.archived_at IS NULL AND v.category_id = ?`).get(categoryId) as { n: bigint };
  if (row.n + BigInt(adding) <= MAX_RULES_PER_CATEGORY) return;
  throw problem({ status: 422, code: "validation_failed", title: "Too many rules for this category",
    detail: "A category can be the target of at most 1,000 active rules. Archive an unused rule first.",
    fieldErrors: [{ path, code: "invalid_value", message: "Choose a category with fewer rules." }] });
}

function requireScopeAccount(db: SqliteDatabase, accountId: string | null): void {
  if (accountId === null || db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId)) return;
  throw problem({ status: 422, code: "validation_failed", title: "Unknown account",
    detail: "The rule is limited to an account that does not exist.",
    fieldErrors: [{ path: "/accountId", code: "invalid_value", message: "Choose an existing account or all accounts." }] });
}

export function requireRevisionRoom(row: RuleRow, reserve: bigint): void {
  if (row.revision + reserve < MAX_REVISIONS) return;
  throw problem({ status: 422, code: "validation_failed", title: "Rule history is full",
    detail: "This rule has reached its limit of saved revisions. Archive it and create a new rule instead." });
}

/** Writes the next immutable revision and makes it current. */
export function writeRevision(context: CommandContext, row: RuleRow, change: RuleChange, config: RuleConfig,
  lifecycle: { archive?: boolean } = {}): RuleRow {
  const { db, now } = context;
  const revision = nextCounter(row.revision);
  insertRevision(db, row.id, revision, change, config, now);
  db.prepare(`UPDATE rules SET revision = ?, version = ?, updated_at = ?,
    archived_at = ?, position = ? WHERE id = ?`).run(revision, nextCounter(row.version), now,
    lifecycle.archive ? now : row.archived_at, lifecycle.archive ? null : row.position, row.id);
  return requireRule(db, row.id);
}

function insertRevision(db: SqliteDatabase, id: string, revision: bigint, change: RuleChange,
  config: RuleConfig, now: number): void {
  const category = db.prepare("SELECT display_name FROM categories WHERE id = ?").get(config.categoryId) as
    { display_name: string };
  db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern, normalized_pattern,
    account_id, applies_to, category_id, category_name, enabled, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, revision, change, config.matchType, config.pattern,
    normalizeRulePattern(config.pattern), config.accountId, config.appliesTo, config.categoryId,
    category.display_name, config.enabled ? 1 : 0, now);
}

export interface CreateRuleInput {
  id: string;
  matchType: RuleMatchType;
  pattern: string;
  accountId?: string | null;
  appliesTo?: RuleAppliesTo;
  categoryId: string;
  enabled?: boolean;
}

export function canonicalRuleConfig(input: Omit<CreateRuleInput, "id">): RuleConfig {
  return {
    matchType: input.matchType, pattern: input.pattern,
    accountId: input.accountId == null ? null : input.accountId.toLowerCase(),
    appliesTo: input.appliesTo ?? "purchases_and_refunds",
    categoryId: input.categoryId.toLowerCase(), enabled: input.enabled ?? true,
  };
}

/** Creates a rule at the end of the order. Replays return the current representation. */
export function createRule(context: CommandContext, input: CreateRuleInput): { status: 200 | 201; row: RuleRow } {
  const { db, now } = context;
  const id = input.id.toLowerCase();
  const config = canonicalRuleConfig(input);
  patternKey(config.pattern);
  const digest = creationDigest(config);
  const existing = findRule(db, id);
  if (existing !== undefined) {
    if (existing.creation_digest === digest) return { status: 200, row: existing };
    throw problem({ status: 409, code: "client_id_conflict", title: "Already used for something else",
      detail: "This rule id was already saved with different values. Reload before trying again." });
  }
  requireRuleTarget(db, config.categoryId);
  requireScopeAccount(db, config.accountId);
  const counts = db.prepare(`SELECT COUNT(*) AS total, COUNT(position) AS active FROM rules`).get() as
    { total: bigint; active: bigint };
  if (counts.total >= BigInt(MAX_RULES)) throw problem({
    status: 422, code: "validation_failed", title: "Rule limit reached",
    detail: `The complete rule list supports ${MAX_RULES} rules, including archived rules.`,
  });
  requireTargetCapacity(db, config.categoryId, 1);
  db.prepare(`INSERT INTO rules (id, position, revision, archived_at, creation_digest, version, created_at, updated_at)
    VALUES (?, ?, 1, NULL, ?, 1, ?, ?)`).run(id, counts.active + 1n, digest, now, now);
  insertRevision(db, id, 1n, "created", config, now);
  const row = requireRule(db, id);
  writeAudit(db, context.newId, now, { entityType: "rule", entityId: id, eventType: "rule_created",
    after: singleRuleDto(db, row) });
  bumpRuleSetRevision(db);
  bumpFinanceRevision(db);
  return { status: 201, row };
}

export type RulePatch = Partial<Omit<CreateRuleInput, "id">>;

function changeKind(before: RuleConfig, after: RuleConfig): RuleChange | null {
  const changed = (Object.keys(after) as (keyof RuleConfig)[]).filter(key => after[key] !== before[key]);
  if (changed.length === 0) return null;
  if (changed.length === 1 && changed[0] === "enabled") return after.enabled ? "enabled" : "disabled";
  if (changed.length === 1 && changed[0] === "categoryId") return "retargeted";
  return "edited";
}

/** Partial edit: omitted fields keep their current values. An unchanged patch writes nothing. */
export function updateRule(context: CommandContext, row: RuleRow, patch: RulePatch): RuleRow {
  const { db } = context;
  if (row.archived_at !== null) throw problem({ status: 422, code: "validation_failed",
    title: "Rule is archived", detail: "Archived rules are kept for history and cannot be edited. Create a new rule instead." });
  const before = configOf(row);
  const after = canonicalRuleConfig({
    matchType: patch.matchType ?? before.matchType, pattern: patch.pattern ?? before.pattern,
    accountId: patch.accountId === undefined ? before.accountId : patch.accountId,
    appliesTo: patch.appliesTo ?? before.appliesTo, categoryId: patch.categoryId ?? before.categoryId,
    enabled: patch.enabled ?? before.enabled,
  });
  patternKey(after.pattern);
  // A disabled rule may keep a retained target that was archived later; a new or live target must be eligible.
  if (after.categoryId !== before.categoryId || after.enabled) requireRuleTarget(db, after.categoryId);
  if (after.categoryId !== before.categoryId) requireTargetCapacity(db, after.categoryId, 1);
  if (after.accountId !== before.accountId) requireScopeAccount(db, after.accountId);
  const change = changeKind(before, after);
  if (change === null) return row;
  requireRevisionRoom(row, 2n);
  const changed = writeRevision(context, row, change, after);
  writeAudit(db, context.newId, context.now, { entityType: "rule", entityId: row.id, eventType: "rule_updated",
    before: singleRuleDto(db, row), after: singleRuleDto(db, changed) });
  bumpRuleSetRevision(db);
  bumpFinanceRevision(db);
  return changed;
}

/** Retires a rule; later rules move up one place. Already archived rules are returned unchanged. */
export function archiveRule(context: CommandContext, row: RuleRow): RuleRow {
  const { db, now } = context;
  if (row.archived_at !== null) return row;
  requireRevisionRoom(row, 0n);
  const archived = writeRevision(context, row, "archived", configOf(row), { archive: true });
  const later = db.prepare(`${CURRENT} WHERE r.position > ? ORDER BY r.position`).all(row.position) as RuleRow[];
  // Ascending order keeps each target position free under the UNIQUE constraint.
  for (const rule of later) setPosition(context, rule, rule.position! - 1n);
  writeAudit(db, context.newId, now, { entityType: "rule", entityId: row.id, eventType: "rule_archived",
    before: singleRuleDto(db, row), after: singleRuleDto(db, archived) });
  bumpRuleSetRevision(db);
  bumpFinanceRevision(db);
  return archived;
}

function setPosition(context: CommandContext, rule: RuleRow, position: bigint): void {
  context.db.prepare("UPDATE rules SET position = ?, version = ?, updated_at = ? WHERE id = ?")
    .run(position, nextCounter(rule.version), context.now, rule.id);
}

export function requireRuleSetRevision(db: SqliteDatabase, expected: string): void {
  if (BigInt(expected) === ruleSetRevision(db)) return;
  throw problem({ status: 409, code: "rule_set_changed", title: "Rules changed",
    detail: "The rules changed since you opened this screen. Reload and review them again." });
}

/** Sets the complete order of active rules, checked against the rule-set revision. */
export function reorderRules(context: CommandContext, input: { ruleSetRevision: string; orderedRuleIds: string[] }): void {
  const { db, now } = context;
  requireRuleSetRevision(db, input.ruleSetRevision);
  const ordered = input.orderedRuleIds.map(id => id.toLowerCase());
  const current = activeRules(db);
  const known = new Set(current.map(rule => rule.id));
  const complete = new Set(ordered).size === ordered.length && ordered.length === current.length
    && ordered.every(id => known.has(id));
  if (!complete) throw problem({ status: 422, code: "validation_failed", title: "Incomplete order",
    detail: "List every active rule exactly once, then try again.",
    fieldErrors: [{ path: "/orderedRuleIds", code: "invalid_value", message: "Include each active rule once." }] });
  const target = new Map(ordered.map((id, index) => [id, BigInt(index + 1)]));
  const moved = current.filter(rule => target.get(rule.id) !== rule.position);
  if (moved.length === 0) return;
  // Park moved rules above every real position first so no step collides with UNIQUE(position).
  const park = db.prepare("UPDATE rules SET position = ? WHERE id = ?");
  const offset = BigInt(current.length) + 1n;
  for (const rule of moved) park.run(offset + target.get(rule.id)!, rule.id);
  for (const rule of moved) {
    const position = target.get(rule.id)!;
    setPosition(context, rule, position);
    writeAudit(db, context.newId, now, { entityType: "rule", entityId: rule.id, eventType: "rule_reordered",
      before: { position: Number(rule.position) }, after: { position: Number(position) } });
  }
  bumpRuleSetRevision(db);
  bumpFinanceRevision(db);
}

export function ruleHistory(db: SqliteDatabase, row: RuleRow) {
  const revisions = db.prepare(`SELECT * FROM rule_revisions WHERE rule_id = ? ORDER BY revision DESC`)
    .all(row.id) as (Omit<RuleRow, "id" | "position"> & { rule_id: string; changed_at: bigint })[];
  return {
    ruleId: row.id,
    revisions: revisions.map(revision => ({
      revision: formatCounter(revision.revision), change: revision.change,
      changedAt: isoTimestamp(Number(revision.changed_at)), matchType: revision.match_type,
      pattern: revision.pattern, accountId: revision.account_id, appliesTo: revision.applies_to,
      categoryId: revision.category_id, categoryNameAtRevision: revision.category_name,
      enabled: revision.enabled === 1n,
    })),
  };
}

// ------------------------------------------------------------ overlap warnings

export type OverlapReason = "same_match" | "broader_earlier" | "narrower_later";

const KINDS: Record<RuleAppliesTo, readonly string[]> = {
  purchases_and_refunds: ["purchase", "refund"], purchases: ["purchase"], refunds: ["refund"],
};

/** True when every transaction `inner` matches is also matched by `outer`. */
export function covers(outer: RuleRow, inner: RuleRow): boolean {
  if (outer.account_id !== null && outer.account_id !== inner.account_id) return false;
  if (!KINDS[inner.applies_to].every(kind => KINDS[outer.applies_to].includes(kind))) return false;
  if (outer.match_type === "exact") {
    return inner.match_type === "exact" && inner.normalized_pattern === outer.normalized_pattern;
  }
  return inner.normalized_pattern.includes(outer.normalized_pattern);
}

/**
 * Warnings for an active rule against the other enabled active rules:
 * `same_match` (identical matches), `broader_earlier` (an earlier rule catches
 * everything this one would, so it never wins) and `narrower_later` (this rule
 * catches everything a later rule would). Partial overlaps are not reported.
 * Ordered by position and capped at the contract's 100 entries.
 */
export function ruleOverlaps(db: SqliteDatabase, subject: RuleRow) {
  if (subject.position === null) return [];
  const overlaps: { ruleId: string; position: number; reason: OverlapReason }[] = [];
  for (const other of activeRules(db)) {
    if (other.id === subject.id || other.enabled !== 1n) continue;
    const broader = covers(other, subject);
    const narrower = covers(subject, other);
    const reason: OverlapReason | null = broader && narrower ? "same_match"
      : broader && other.position! < subject.position ? "broader_earlier"
        : narrower && other.position! > subject.position ? "narrower_later" : null;
    if (reason !== null) overlaps.push({ ruleId: other.id, position: Number(other.position), reason });
  }
  return overlaps.slice(0, 100);
}
