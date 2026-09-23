import type { SqliteDatabase } from "@workspace/db";
import { z } from "zod";
import { evaluateAssignment, normalizeMerchantText, UNCATEGORIZED_ID } from "../domain/assignment.js";
import { isCalendarDate, monthStart, nextMonthStart } from "../domain/dates.js";
import { nextCounter } from "../domain/versions.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import { RuleRunRow, type RuleRun, type RuleRunScope } from "../lib/rule-run-schemas.js";
import type { CommandContext } from "./accounts.js";
import { loadAssignmentRules } from "./assignment.js";
import { bumpFinanceRevision } from "./ledger.js";
import { ruleSetRevision } from "./rules.js";
import type { TransactionRow } from "./transactions.js";

interface Candidate extends TransactionRow { account_version: bigint }
interface Proposal {
  row: RuleRunRow;
  accountId: string;
  archiveCount: string;
  beforeName: string;
  afterName: string;
}
interface PreparedRow { version: bigint; accountVersion: bigint; proposal: Proposal; changed: boolean }
interface StoredRun {
  id: string; preview_json: string; rule_set_revision: bigint; expires_at: bigint;
  applied_at: bigint | null; result_json: string | null;
}

export function ruleRunSnapshot<T>(db: SqliteDatabase, read: () => T): T {
  db.exec("BEGIN");
  try { const result = read(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

function invalidScope(detail: string): never {
  throw problem({ status: 422, code: "validation_failed", title: "Invalid rule-run scope", detail,
    fieldErrors: [{ path: "/scope", code: "invalid_value", message: detail }] });
}

function scopeQuery(scope: RuleRunScope) {
  if (scope.month !== null && (scope.from !== null || scope.to !== null)) invalidScope("Choose a month or a date range, not both.");
  if ([scope.from, scope.to].some(date => date !== null && !isCalendarDate(date))) invalidScope("Choose real calendar dates.");
  if (scope.from !== null && scope.to !== null && scope.from >= scope.to) invalidScope("The end date must be after the start date.");
  const clauses = ["a.archived_at IS NULL", "t.lifecycle = 'active'", "t.kind IN ('purchase', 'refund')"];
  const values: string[] = [];
  for (const [column, value] of [["t.account_id", scope.accountId], ["t.category_id", scope.categoryId]] as const) {
    if (value !== null) { clauses.push(`${column} = ?`); values.push(value.toLowerCase()); }
  }
  const from = scope.month === null ? scope.from : monthStart(scope.month);
  const to = scope.month === null ? scope.to : nextMonthStart(scope.month);
  if (from !== null) { clauses.push("t.posted_date >= ?"); values.push(from); }
  if (to !== null) { clauses.push("t.posted_date < ?"); values.push(to); }
  return { sql: clauses.join(" AND "), values };
}

function archiveCounts(db: SqliteDatabase): Map<string, string> {
  return new Map((db.prepare(`SELECT entity_id AS id, COUNT(*) AS n FROM audit_events
    WHERE entity_type = 'account' AND event_type = 'account_archived' GROUP BY entity_id`)
    .all() as { id: string; n: bigint }[]).map(row => [row.id, String(row.n)]));
}

/** Capture one read snapshot, then evaluate without holding the ledger write lock. */
export function prepareRuleRun(context: CommandContext, input: RuleRunScope) {
  const { db, now } = context;
  const scope = { ...input, accountId: input.accountId?.toLowerCase() ?? null, categoryId: input.categoryId?.toLowerCase() ?? null };
  const filter = scopeQuery(scope);
  const captured = ruleRunSnapshot(db, () => {
    for (const [table, id] of [["accounts", scope.accountId], ["categories", scope.categoryId]] as const) {
      if (id !== null && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) === undefined) invalidScope("Choose an existing account and category.");
    }
    const candidates = db.prepare(`SELECT t.*, a.version AS account_version FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE ${filter.sql} AND t.assignment_origin <> 'manual' ORDER BY t.id LIMIT 25001`).all(...filter.values) as Candidate[];
    if (candidates.length > 25000) throw problem({ status: 422, code: "scope_too_large", title: "Narrow the rule-run scope",
      detail: "A run can review at most 25,000 candidates. Choose a smaller scope; nothing was saved." });
    const manual = db.prepare(`SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE ${filter.sql} AND t.assignment_origin = 'manual'`).get(...filter.values) as { n: bigint };
    const names = new Map((db.prepare("SELECT id, display_name FROM categories").all() as { id: string; display_name: string }[])
      .map(row => [row.id, row.display_name]));
    return { candidates, manual: Number(manual.n), names, archives: archiveCounts(db), rules: loadAssignmentRules(db), revision: ruleSetRevision(db) };
  });
  const rows: PreparedRow[] = captured.candidates.map(candidate => {
    const next = evaluateAssignment({ accountId: candidate.account_id, kind: candidate.kind,
      normalizedMerchant: normalizeMerchantText(candidate.merchant_text) }, captured.rules);
    const row = RuleRunRow.parse({ transactionId: candidate.id, postedDate: candidate.posted_date,
      merchant: candidate.merchant_text, money: { amountMinor: String(candidate.amount_cents), currency: "USD" },
      before: { categoryId: candidate.category_id, origin: candidate.assignment_origin, ruleId: candidate.rule_id,
        ruleRevision: candidate.rule_revision === null ? null : String(candidate.rule_revision) },
      after: { categoryId: next.categoryId, origin: next.origin, ruleId: next.ruleId,
        ruleRevision: next.ruleRevision === null ? null : String(next.ruleRevision) } });
    return { version: candidate.version, accountVersion: candidate.account_version,
      changed: JSON.stringify(row.before) !== JSON.stringify(row.after),
      proposal: { row, accountId: candidate.account_id, archiveCount: captured.archives.get(candidate.account_id) ?? "0",
        beforeName: captured.names.get(row.before.categoryId)!, afterName: captured.names.get(row.after.categoryId)! } };
  });
  const preview: RuleRun = { id: context.newId().toLowerCase(), status: "ready", scope, ruleSetRevision: String(captured.revision),
    counts: { candidates: rows.length, changes: rows.filter(row => row.changed).length,
      toUncategorized: rows.filter(row => row.changed && row.proposal.row.after.categoryId === UNCATEGORIZED_ID).length,
      manualSkipped: captured.manual }, createdAt: isoTimestamp(now), expiresAt: isoTimestamp(now + 86_400_000),
    appliedAt: null, changedCount: null };
  return { preview, rows };
}

function preparedStillCurrent(db: SqliteDatabase, prepared: ReturnType<typeof prepareRuleRun>): boolean {
  if (ruleSetRevision(db) !== BigInt(prepared.preview.ruleSetRevision)) return false;
  for (const [table, id] of [["accounts", prepared.preview.scope.accountId], ["categories", prepared.preview.scope.categoryId]] as const) {
    if (id !== null && db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) === undefined) return false;
  }
  const archives = archiveCounts(db);
  const read = db.prepare(`SELECT t.version, a.archived_at FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.id = ?`);
  return prepared.rows.every(({ proposal, version }) => {
    const current = read.get(proposal.row.transactionId) as { version: bigint; archived_at: bigint | null } | undefined;
    return current !== undefined && current.version === version && current.archived_at === null
      && (archives.get(proposal.accountId) ?? "0") === proposal.archiveCount;
  });
}

/** Caller owns the write transaction, including response validation and publication. */
export function publishRuleRun(context: CommandContext, prepared: ReturnType<typeof prepareRuleRun>, check: (body: unknown) => unknown) {
  const { db } = context;
  if (!preparedStillCurrent(db, prepared)) throw problem({ status: 503, code: "service_busy", title: "The scope changed during preview",
    detail: "Try creating the preview again. Nothing was saved.", retryAfterSeconds: 1 });
  const { preview, rows } = prepared;
  const body = check(preview);
  db.prepare(`INSERT INTO rule_runs (id, preview_json, rule_set_revision, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(preview.id, JSON.stringify(body), BigInt(preview.ruleSetRevision), Date.parse(preview.createdAt), Date.parse(preview.expiresAt));
  const insert = db.prepare(`INSERT INTO rule_run_rows (run_id, transaction_id, transaction_version, account_version,
    before_category_id, after_category_id, row_json, changed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) insert.run(preview.id, row.proposal.row.transactionId, row.version, row.accountVersion,
    row.proposal.row.before.categoryId, row.proposal.row.after.categoryId, JSON.stringify(row.proposal), row.changed ? 1 : 0);
  return { id: preview.id, body };
}

function requireRun(db: SqliteDatabase, id: string): StoredRun {
  const saved = db.prepare("SELECT * FROM rule_runs WHERE id = ?").get(id.toLowerCase()) as StoredRun | undefined;
  if (saved === undefined) throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no rule run with that id." });
  return saved;
}

function status(db: SqliteDatabase, saved: StoredRun, now: number): RuleRun["status"] {
  if (saved.applied_at !== null) return "applied";
  if (BigInt(now) >= saved.expires_at) return "expired";
  if (ruleSetRevision(db) !== saved.rule_set_revision) return "stale";
  const changed = db.prepare(`SELECT 1 FROM rule_run_rows r JOIN transactions t ON t.id = r.transaction_id
    JOIN accounts a ON a.id = t.account_id WHERE r.run_id = ? AND (t.version <> r.transaction_version OR a.archived_at IS NOT NULL) LIMIT 1`).get(saved.id);
  if (changed !== undefined) return "stale";
  // Archive counts also catch archive/reactivate cycles, without staling on account renames or new postings.
  const archives = archiveCounts(db);
  const accounts = db.prepare(`SELECT DISTINCT json_extract(row_json, '$.accountId') AS id,
    json_extract(row_json, '$.archiveCount') AS count FROM rule_run_rows WHERE run_id = ?`)
    .all(saved.id) as { id: string; count: string }[];
  if (accounts.some(account => (archives.get(account.id) ?? "0") !== account.count)) return "stale";
  return "ready";
}

export function getRuleRun(db: SqliteDatabase, id: string, now: number): RuleRun {
  const saved = requireRun(db, id);
  if (saved.result_json !== null) return (JSON.parse(saved.result_json) as { ruleRun: RuleRun }).ruleRun;
  return { ...JSON.parse(saved.preview_json) as RuleRun, status: status(db, saved, now) };
}

function expired(): never {
  throw problem({ status: 410, code: "preview_expired", title: "Preview expired", detail: "Create a new preview and review it again." });
}

const APPLY_BATCH = 200;
const tuples = (count: number, tuple: string) => Array.from({ length: count }, () => tuple).join(", ");
function applyStatements(db: SqliteDatabase, count: number) {
  return {
    update: db.prepare(`UPDATE transactions SET category_id = v.column3, assignment_origin = v.column4, rule_id = v.column5,
      rule_revision = v.column6, assigned_at = ?, version = v.column7, updated_at = ?
      FROM (VALUES ${tuples(count, "(?, ?, ?, ?, ?, ?, ?)")}) AS v WHERE transactions.id = v.column1 AND transactions.version = v.column2`),
    history: db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source,
      before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json)
      VALUES ${tuples(count, "(?, ?, ?, 'category_changed', 'rule_run', ?, ?, ?, ?, ?, ?, ?)")}`),
    audit: db.prepare(`INSERT INTO audit_events (id, command_id, entity_type, entity_id, account_id, event_type,
      origin, before_json, after_json, occurred_at) VALUES ${tuples(count, "(?, ?, 'transaction', ?, ?, 'category_changed', 'rule_run', ?, ?, ?)")}`),
  };
}

export function applyRuleRun(context: CommandContext, id: string, check: (body: unknown) => unknown): unknown {
  const { db, now } = context;
  const saved = requireRun(db, id);
  if (saved.result_json !== null) return check(JSON.parse(saved.result_json));
  const current = status(db, saved, now);
  if (current === "expired") expired();
  if (current !== "ready") throw problem({ status: 409, code: "preview_stale", title: "Preview changed",
    detail: "The rules, a candidate or an account lifecycle changed. Create a new preview. Nothing was saved." });
  const rows = db.prepare("SELECT row_json, transaction_version FROM rule_run_rows WHERE run_id = ? AND changed = 1 ORDER BY transaction_id")
    .all(saved.id) as { row_json: string; transaction_version: bigint }[];
  // Flat parameter lists for multi-row statements, all inside this one transaction:
  // per-statement overhead dominated a 25,000-row apply.
  const related = JSON.stringify([saved.id]);
  const updates: unknown[] = [], history: unknown[] = [], audit: unknown[] = [];
  for (const stored of rows) {
    const { row, accountId, beforeName, afterName } = JSON.parse(stored.row_json) as Proposal;
    const next = row.after;
    const revision = next.ruleRevision === null ? null : BigInt(next.ruleRevision);
    const before = JSON.stringify({ categoryId: row.before.categoryId, categoryName: beforeName, assignmentOrigin: row.before.origin });
    const after = JSON.stringify({ categoryId: next.categoryId, categoryName: afterName, assignmentOrigin: next.origin });
    updates.push(row.transactionId, stored.transaction_version, next.categoryId, next.origin, next.ruleId, revision, nextCounter(stored.transaction_version));
    history.push(context.newId().toLowerCase(), row.transactionId, now, before, after, row.before.categoryId, next.categoryId, next.ruleId, revision, related);
    audit.push(context.newId().toLowerCase(), saved.id, row.transactionId, accountId, before, after, now);
  }
  const statements = new Map<number, ReturnType<typeof applyStatements>>();
  for (let start = 0; start < rows.length; start += APPLY_BATCH) {
    const end = Math.min(start + APPLY_BATCH, rows.length);
    let prepared = statements.get(end - start);
    if (prepared === undefined) statements.set(end - start, prepared = applyStatements(db, end - start));
    const updated = prepared.update.run(now, now, ...updates.slice(start * 7, end * 7));
    // status() already verified every version; a mismatch here must never become a partial apply.
    if (Number(updated.changes) !== end - start) throw new Error("rule run candidate changed during apply");
    prepared.history.run(...history.slice(start * 10, end * 10));
    prepared.audit.run(...audit.slice(start * 7, end * 7));
  }
  const revision = bumpFinanceRevision(db);
  const preview = JSON.parse(saved.preview_json) as RuleRun;
  const body = check({ ruleRun: { ...preview, status: "applied", appliedAt: isoTimestamp(now), changedCount: rows.length }, financeRevision: String(revision) });
  db.prepare("UPDATE rule_runs SET applied_at = ?, result_json = ? WHERE id = ?").run(now, JSON.stringify(body), saved.id);
  return body;
}

const cursorSchema = z.object({ v: z.literal(1), run: z.string().uuid(), id: z.string().uuid() }).strict();
function invalidCursor(): never {
  throw problem({ status: 400, code: "invalid_cursor", title: "Invalid list position", detail: "Reload the list from the first page." });
}

export function listRuleRunRows(db: SqliteDatabase, id: string, now: number, query: Record<string, unknown>) {
  const saved = requireRun(db, id);
  if (saved.applied_at === null && BigInt(now) >= saved.expires_at) expired();
  const limit = query["limit"] ?? "50";
  if (Object.keys(query).some(key => !["limit", "cursor"].includes(key)) || typeof limit !== "string"
    || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 200) throw problem({ status: 400, code: "invalid_request",
    title: "Invalid page query", detail: "Choose a page size from 1 to 200 and use only supported parameters." });
  let last = "";
  if (query["cursor"] !== undefined) {
    const encoded = query["cursor"];
    if (typeof encoded !== "string" || encoded.length > 512 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalidCursor();
    let cursor: z.infer<typeof cursorSchema>;
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) invalidCursor();
      cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch { invalidCursor(); }
    if (cursor.run.toLowerCase() !== saved.id) throw problem({ status: 400, code: "cursor_filter_mismatch",
      title: "This cursor belongs to another run", detail: "Reload the list from the first page." });
    last = cursor.id.toLowerCase();
  }
  const rows = db.prepare(`SELECT transaction_id, row_json FROM rule_run_rows WHERE run_id = ? AND changed = 1
    AND transaction_id > ? ORDER BY transaction_id LIMIT ?`).all(saved.id, last, Number(limit) + 1) as { transaction_id: string; row_json: string }[];
  const page = rows.slice(0, Number(limit));
  return { items: page.map(row => (JSON.parse(row.row_json) as Proposal).row),
    nextCursor: rows.length <= Number(limit) ? null : Buffer.from(JSON.stringify({ v: 1, run: saved.id, id: page.at(-1)!.transaction_id })).toString("base64url") };
}
