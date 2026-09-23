/**
 * Simple transaction corrections: manual category, return to rules and notes.
 *
 * None of these changes money, so none advances an account's ledger revision
 * or affects reconciliation (TDD section 4). Category and note edits are
 * allowed on archived accounts; returning to rules re-runs rules and is not.
 * A command that would leave the assignment or note exactly as it is writes
 * nothing: no version, no history, no revision.
 */
import type { SqliteDatabase } from "@workspace/db";
import { normalizeMatchText, type Assignment, type TransactionKind } from "../domain/assignment.js";
import { creationDigest } from "../domain/digest.js";
import { nextCounter } from "../domain/versions.js";
import type { ClassifyInput } from "../lib/link-schemas.js";
import { problem } from "../lib/problem.js";
import type { CommandContext } from "./accounts.js";
import { assignByRules } from "./assignment.js";
import { requireCategory } from "./categories.js";
import { bumpFinanceRevision, financeRevision, requireAccount, requireActiveAccount, writeAudit } from "./ledger.js";
import { invalidatedLinks, requireConfirmedUnlinks, unlinkAll, writeKindChange } from "./links.js";
import { createRule, findRule, ruleOverlaps, ruleSetRevision, singleRuleDto, type RuleRow } from "./rules.js";
import { requireManualCategory, requireTransaction, transactionDto, type TransactionRow } from "./transactions.js";

export interface NewRuleInput {
  id: string;
  matchType: "contains" | "exact";
  pattern: string;
  appliesTo: "purchases_and_refunds" | "purchases" | "refunds";
  accountId: string | null;
}

export interface CategorizeInput {
  categoryId: string;
  newRule?: NewRuleInput;
}

export interface CommandOutcome {
  version: bigint;
  body: unknown;
}

function assignmentSnapshot(db: SqliteDatabase, row: Pick<TransactionRow, "category_id" | "assignment_origin">) {
  return {
    categoryId: row.category_id,
    categoryName: row.category_id === null ? null : requireCategory(db, row.category_id).display_name,
    assignmentOrigin: row.assignment_origin,
  };
}

function sameAssignment(row: TransactionRow, next: Assignment): boolean {
  return row.assignment_origin === next.origin && row.category_id === next.categoryId
    && row.rule_id === next.ruleId && row.rule_revision === next.ruleRevision;
}

/** Writes a changed assignment with its history and audit; never touches money or the account. */
function writeAssignment(context: CommandContext, row: TransactionRow, next: Assignment,
  event: "category_changed" | "returned_to_rules", relatedIds: string[]): TransactionRow {
  const { db, now } = context;
  db.prepare(`UPDATE transactions SET category_id = ?, assignment_origin = ?, assigned_at = ?, rule_id = ?,
    rule_revision = ?, version = ?, updated_at = ? WHERE id = ?`).run(next.categoryId, next.origin, now,
    next.ruleId, next.ruleRevision, nextCounter(row.version), now, row.id);
  const changed = requireTransaction(db, row.id);
  const before = assignmentSnapshot(db, row);
  const after = assignmentSnapshot(db, changed);
  db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source, reason,
    before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json)
    VALUES (?, ?, ?, ?, 'owner', NULL, ?, ?, ?, ?, ?, ?, ?)`).run(context.newId().toLowerCase(), row.id, now, event,
    JSON.stringify(before), JSON.stringify(after), row.category_id, changed.category_id, next.ruleId,
    next.ruleRevision, JSON.stringify(relatedIds));
  writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "transaction", entityId: row.id,
    accountId: row.account_id, eventType: event, before, after });
  bumpFinanceRevision(db);
  return changed;
}

/** A category the owner chose: unknown is a 422, archived a 409, Income a 422. */
function requireChosenCategory(db: SqliteDatabase, id: string, path: string): string {
  if (db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id.toLowerCase()) === undefined) {
    throw problem({ status: 422, code: "validation_failed", title: "Unknown category",
      detail: "Choose an existing category.",
      fieldErrors: [{ path, code: "invalid_value", message: "Choose an existing category." }] });
  }
  return requireManualCategory(db, id);
}

function requireCurrentVersion(row: TransactionRow, expected: bigint): void {
  if (row.version === expected) return;
  throw problem({ status: 412, code: "version_mismatch", title: "Someone else changed this first",
    detail: "This transaction changed since you loaded it. Reload and try again.",
    currentVersion: String(row.version) });
}

/** The combined command's fingerprint: the new rule's client ID is its retry token. */
function categorizeDigest(transactionId: string, input: CategorizeInput): string {
  const rule = input.newRule!;
  return creationDigest({ command: "categorize", transactionId, categoryId: input.categoryId.toLowerCase(),
    newRule: { ...rule, id: rule.id.toLowerCase(), accountId: rule.accountId?.toLowerCase() ?? null } });
}

/**
 * A completed correction-plus-rule saves its checked result on the rule. A
 * retry with the same rule ID and request returns that result, even after
 * later edits made its If-Match stale; anything else under that ID conflicts.
 */
function recordedCategorize(db: SqliteDatabase, transactionId: string, input: CategorizeInput): CommandOutcome | undefined {
  if (input.newRule === undefined) return undefined;
  const existing = findRule(db, input.newRule.id);
  if (existing === undefined) return undefined;
  const recorded = db.prepare("SELECT creation_result_json AS json FROM rules WHERE id = ?")
    .get(existing.id) as { json: string | null };
  const result = recorded.json === null ? undefined
    : JSON.parse(recorded.json) as { digest: string; version: string; body: unknown };
  if (result?.digest !== categorizeDigest(transactionId, input)) throw problem({ status: 409,
    code: "client_id_conflict", title: "Already used for something else",
    detail: "This rule id was already saved with different values. Reload before trying again." });
  return { version: BigInt(result.version), body: result.body };
}

/**
 * Manual category, optionally with a new rule saved in the same transaction.
 * `check` validates the complete response inside the caller's transaction.
 */
export function categorizeTransaction(context: CommandContext, id: string, expected: bigint,
  input: CategorizeInput, check: (body: unknown) => unknown): CommandOutcome {
  const { db } = context;
  const row = requireTransaction(db, id);
  const replay = recordedCategorize(db, row.id, input);
  if (replay !== undefined) return replay;
  requireCurrentVersion(row, expected);
  if (row.kind !== "purchase" && row.kind !== "refund") throw problem({ status: 422, code: "validation_failed",
    title: "Only purchases and refunds have a chosen category",
    detail: "Income uses Income and transfers have no category. Change the type first.",
    fieldErrors: [{ path: "/categoryId", code: "invalid_value", message: "Change the type before choosing a category." }] });
  const categoryId = requireChosenCategory(db, input.categoryId, "/categoryId");
  let rule: RuleRow | null = null;
  if (input.newRule !== undefined) {
    rule = createRule(context, { ...input.newRule, categoryId, enabled: true }).row;
  }
  const next: Assignment = { origin: "manual", categoryId, ruleId: null, ruleRevision: null };
  const saved = sameAssignment(row, next) ? row
    : writeAssignment(context, row, next, "category_changed", rule === null ? [] : [rule.id]);
  const body = check({
    transaction: transactionDto(db, saved),
    rule: rule === null ? null : singleRuleDto(db, rule),
    ruleOverlaps: rule === null ? [] : ruleOverlaps(db, rule),
    ruleSetRevision: String(ruleSetRevision(db)), financeRevision: String(financeRevision(db)),
  });
  if (rule !== null) {
    db.prepare("UPDATE rules SET creation_result_json = ? WHERE id = ?").run(JSON.stringify({
      digest: categorizeDigest(row.id, input), version: String(saved.version), body,
    }), rule.id);
  }
  return { version: saved.version, body };
}

/** Drops manual protection and lets the current rules decide now. Refused on archived accounts. */
export function returnTransactionToRules(context: CommandContext, id: string, expected: bigint,
  check: (body: unknown) => unknown): CommandOutcome {
  const { db } = context;
  const row = requireTransaction(db, id);
  requireCurrentVersion(row, expected);
  requireActiveAccount(requireAccount(db, row.account_id));
  // Income and transfers keep their system assignment, so for them nothing changes.
  const next = assignByRules(db, { accountId: row.account_id, kind: row.kind, merchantText: row.merchant_text });
  const saved = sameAssignment(row, next) ? row : writeAssignment(context, row, next, "returned_to_rules", []);
  return { version: saved.version,
    body: check({ transaction: transactionDto(db, saved), financeRevision: String(financeRevision(db)) }) };
}

/** Sets or clears a note. Allowed on archived accounts. */
export function updateTransactionNote(context: CommandContext, id: string, expected: bigint,
  note: string | null, check: (body: unknown) => unknown): CommandOutcome {
  const { db, now } = context;
  const row = requireTransaction(db, id);
  requireCurrentVersion(row, expected);
  let saved = row;
  if (row.note !== note) {
    db.prepare("UPDATE transactions SET note = ?, normalized_note = ?, version = ?, updated_at = ? WHERE id = ?")
      .run(note, note === null ? null : normalizeMatchText(note), nextCounter(row.version), now, row.id);
    saved = requireTransaction(db, row.id);
    db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source, reason,
      before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json)
      VALUES (?, ?, ?, 'note_changed', 'owner', NULL, ?, ?, NULL, NULL, NULL, NULL, '[]')`)
      .run(context.newId().toLowerCase(), row.id, now, JSON.stringify({ note: row.note }), JSON.stringify({ note }));
    writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "transaction", entityId: row.id,
      accountId: row.account_id, eventType: "note_changed", before: { note: row.note }, after: { note } });
    bumpFinanceRevision(db);
  }
  return { version: saved.version,
    body: check({ transaction: transactionDto(db, saved), financeRevision: String(financeRevision(db)) }) };
}

/** Negative amounts can be purchases or transfers; positive ones refunds, income or transfers. */
function signAllows(kind: TransactionKind, amount: bigint): boolean {
  if (kind === "transfer") return true;
  return kind === "purchase" ? amount < 0n : amount > 0n;
}

/**
 * Changes a transaction's type, never its amount. Income uses Income and
 * transfers have no category; purchases and refunds need an explicit choice
 * of category or rules. Links the change breaks must be confirmed exactly and
 * are removed in the same transaction. Refused on archived accounts.
 */
export function classifyTransaction(context: CommandContext, id: string, expected: bigint,
  input: ClassifyInput, check: (body: unknown) => unknown): CommandOutcome {
  const { db } = context;
  const row = requireTransaction(db, id);
  requireCurrentVersion(row, expected);
  const { kind } = input;
  if (!signAllows(kind, row.amount_cents)) throw problem({ status: 422, code: "kind_sign_mismatch",
    title: "Type does not fit the amount",
    detail: row.amount_cents < 0n ? "A negative amount can be a purchase or transfer. Nothing was changed."
      : "A positive amount can be a refund, income or transfer. Nothing was changed.",
    fieldErrors: [{ path: "/kind", code: "kind_sign_mismatch",
      message: row.amount_cents < 0n ? "Choose purchase or transfer." : "Choose refund, income or transfer." }] });
  const expense = kind === "purchase" || kind === "refund";
  if (expense !== (input.category !== undefined)) throw problem({ status: 422, code: "validation_failed",
    title: expense ? "Choose a category or rules" : "No category for this type",
    detail: expense ? "Purchases and refunds need a category choice or a return to rules. Nothing was changed."
      : "Income uses Income and transfers have no category. Nothing was changed.",
    fieldErrors: [{ path: "/category", code: expense ? "required" : "not_allowed",
      message: expense ? "Choose a category or rules." : "Leave the category out for this type." }] });
  requireActiveAccount(requireAccount(db, row.account_id));
  const next: Assignment = input.category?.mode === "category"
    ? { origin: "manual", categoryId: requireChosenCategory(db, input.category.categoryId, "/category/categoryId"),
      ruleId: null, ruleRevision: null }
    : assignByRules(db, { accountId: row.account_id, kind, merchantText: row.merchant_text });
  const required = invalidatedLinks(db, row, { kind, lifecycle: row.lifecycle, amountCents: row.amount_cents });
  requireConfirmedUnlinks(required, input.confirmUnlink);
  let saved = row;
  if (kind !== row.kind) {
    unlinkAll(context, required, row.id);
    saved = writeKindChange(context, row, kind, next, []);
    bumpFinanceRevision(db);
  } else if (!sameAssignment(row, next)) {
    saved = writeAssignment(context, row, next, next.origin === "manual" ? "category_changed" : "returned_to_rules", []);
  }
  return { version: saved.version, body: check({ transaction: transactionDto(db, saved),
    unlinked: kind === row.kind ? { transferPairIds: [], refundLinkIds: [] } : required,
    financeRevision: String(financeRevision(db)) }) };
}
