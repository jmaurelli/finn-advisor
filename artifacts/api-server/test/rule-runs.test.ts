import { withWriteTransaction } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { easternDate } from "../src/domain/dates.js";
import { RuleRunResult, type RuleRun, type RuleRunRow, type RuleRunScope } from "../src/lib/rule-run-schemas.js";
import { checkedResponse } from "../src/lib/respond.js";
import type { PostingInput } from "../src/lib/transaction-schemas.js";
import { applyRuleRun, prepareRuleRun, publishRuleRun } from "../src/services/rule-runs.js";
import { createAccount, postThroughService, UNCATEGORIZED, uuid } from "./finance-harness.js";
import { startTestServer, type TestServer } from "./harness.js";

let api: TestServer;
let accountId: string;
const categoryId = uuid(10, "abcdef00");
const ruleId = uuid(11, "abcdef00");
const scope: RuleRunScope = { accountId: null, categoryId: null, month: null, from: null, to: null };
const usd = (amountMinor: string) => ({ amountMinor, currency: "USD" as const });
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  accountId = (await createAccount(api)).id;
  expect((await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Food", color: "#123456" } })).status).toBe(201);
});
afterEach(async () => { await api.close(); });
const post = (patch: Partial<PostingInput> = {}) => postThroughService(api, {
  accountId, postedDate: "2026-04-02", merchant: "SYNTHETIC MARKET", kind: "purchase", money: usd("-100"), ...patch,
});
async function rule() {
  const response = await api.request("/api/rules", { method: "POST", body: { id: ruleId, matchType: "contains", pattern: "market", categoryId } });
  expect(response.status, response.text).toBe(201);
}
const create = (patch: Partial<RuleRunScope> = {}) => api.request("/api/rule-runs", { method: "POST", body: { scope: { ...scope, ...patch } } });
async function preview(patch: Partial<RuleRunScope> = {}) {
  const response = await create(patch);
  expect(response.status, response.text).toBe(201);
  const p = response.body as RuleRun;
  expect(response.headers.get("location")).toBe(`/api/rule-runs/${p.id}`);
  return p;
}
const get = (id: string) => api.request(`/api/rule-runs/${id.toUpperCase()}`);
const apply = (id: string) => api.request(`/api/rule-runs/${id.toUpperCase()}/apply`, { method: "POST" });
const page = (id: string, query = "") => api.request(`/api/rule-runs/${id.toUpperCase()}/rows${query}`);
const context = () => ({ db: api.db, now: api.clock.now(), today: easternDate(api.clock.now()), newId: api.deps.newId });
const snapshot = () => Object.fromEntries(["transactions", "accounts", "assignment_events", "audit_events", "rule_runs", "rule_run_rows", "ledger_metadata"]
  .map(table => [table, api.db.prepare(`SELECT * FROM ${table}`).all()]));
async function note(id: string, version = "1") {
  const response = await api.request(`/api/transactions/${id}/note`, { method: "PATCH", headers: { "if-match": `"${version}"` }, body: { note: "Changed" } });
  expect(response.status, response.text).toBe(200);
}
async function lifecycle(action: string, version: string) {
  const response = await api.request(`/api/accounts/${accountId}/${action}`, { method: "POST", headers: { "if-match": `"${version}"` } });
  expect(response.status, response.text).toBe(200);
}

describe("reviewed historical rule runs", () => {
  it("protects manual Uncategorized, skips ineligible rows, preserves evidence and changes no balances", async () => {
    const changed = post({ note: "Retained note" });
    const manual = post({ category: { mode: "category", categoryId: UNCATEGORIZED } });
    post({ kind: "income", money: usd("100") });
    post({ kind: "transfer" });
    const voided = post();
    const repair = await api.request(`/api/transactions/${voided.id}/repair-previews`, { method: "POST", body: { action: "void", reason: "Synthetic" } });
    expect((await api.request(`/api/transaction-repairs/${(repair.body as { id: string }).id}/apply`, { method: "POST", body: { confirmUnlinking: false } })).status).toBe(200);
    const other = (await createAccount(api, { id: uuid(2) })).id;
    post({ accountId: other });
    expect((await api.request(`/api/accounts/${other}/archive`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    await rule();
    const unchanged = post();
    const before = snapshot();
    const p = await preview();
    expect(p.counts).toEqual({ candidates: 2, changes: 1, toUncategorized: 0, manualSkipped: 1 });
    expect(snapshot().transactions).toEqual(before.transactions);
    expect(snapshot().ledger_metadata).toEqual(before.ledger_metadata);
    expect((await page(p.id)).body).toMatchObject({ items: [{ transactionId: changed.id, before: { origin: "unassigned" }, after: { origin: "rule", ruleId } }] });
    const result = await apply(p.id);
    expect(result.status, result.text).toBe(200);
    expect(result.body).toMatchObject({ ruleRun: { status: "applied", changedCount: 1 } });
    expect(snapshot().accounts).toEqual(before.accounts);
    expect((await api.request(`/api/transactions/${manual.id}`)).body).toMatchObject({ assignment: { origin: "manual" }, categoryId: UNCATEGORIZED });
    expect((await api.request(`/api/transactions/${unchanged.id}`)).body).toEqual(unchanged);
    expect((await api.request(`/api/transactions/${changed.id}`)).body).toMatchObject({ version: "2", note: "Retained note", money: changed.money, merchant: changed.merchant });
    expect((await api.request(`/api/rules/${ruleId}`)).body).toMatchObject({ currentAssignmentCount: 2 });
    expect((await api.request(`/api/transactions/${changed.id}/history`)).body).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ source: "rule_run", eventType: "category_changed", ruleId, ruleRevision: "1", relatedIds: [p.id] }),
    ]) });
    const after = snapshot();
    expect((await apply(p.id)).body).toEqual(result.body);
    expect(snapshot()).toEqual(after);
  });

  it("distinguishes same-category provenance changes from no-ops and retains old rule explanations", async () => {
    await rule();
    const row = post();
    expect((await api.request(`/api/rules/${ruleId}`, { method: "PATCH", headers: { "if-match": '"1"' }, body: { pattern: "synthetic" } })).status).toBe(200);
    const p = await preview();
    expect(p.counts).toMatchObject({ candidates: 1, changes: 1 });
    expect((await page(p.id)).body).toMatchObject({ items: [{ before: { categoryId, ruleRevision: "1" }, after: { categoryId, ruleRevision: "2" } }] });
    expect((await apply(p.id)).status).toBe(200);
    const before = snapshot();
    const noop = await preview();
    expect(noop.counts.changes).toBe(0);
    expect((await page(noop.id)).body).toEqual({ items: [], nextCursor: null });
    expect((await apply(noop.id)).status).toBe(200);
    expect(snapshot().transactions).toEqual(before.transactions);
    expect(snapshot().assignment_events).toEqual(before.assignment_events);
    expect((await api.request(`/api/rules/${ruleId}/history`)).body).toMatchObject({ revisions: expect.arrayContaining([
      expect.objectContaining({ revision: "1", pattern: "market", categoryNameAtRevision: "Food" }),
    ]) });
    expect((await api.request(`/api/transactions/${row.id}`)).body).toMatchObject({ version: "2" });
  });

  it("returns no-longer-matching rows to unassigned Uncategorized", async () => {
    await rule();
    const row = post();
    expect((await api.request(`/api/rules/${ruleId}/archive`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    const p = await preview();
    expect(p.counts).toMatchObject({ changes: 1, toUncategorized: 1 });
    expect((await apply(p.id)).status).toBe(200);
    expect((await api.request(`/api/transactions/${row.id}`)).body).toMatchObject({ categoryId: UNCATEGORIZED, assignment: { origin: "unassigned", ruleId: null, ruleRevision: null } });
    expect((await api.request(`/api/rules/${ruleId}`)).body).toMatchObject({ currentAssignmentCount: 0 });
  });

  it.each(["candidate", "unchanged", "rule", "archive", "archive-reactivate"])("refuses the entire run after %s changes", async change => {
    const row = post();
    await rule();
    const unchanged = post();
    const p = await preview();
    if (change === "candidate" || change === "unchanged") await note(change === "candidate" ? row.id : unchanged.id);
    if (change === "rule") expect((await api.request(`/api/rules/${ruleId}`, { method: "PATCH", headers: { "if-match": '"1"' }, body: { enabled: false } })).status).toBe(200);
    if (change.startsWith("archive")) await lifecycle("archive", "1");
    if (change === "archive-reactivate") await lifecycle("reactivate", "2");
    const before = snapshot();
    expect((await get(p.id)).body).toMatchObject({ status: "stale" });
    expect((await apply(p.id)).body).toMatchObject({ code: "preview_stale", status: 409 });
    expect(snapshot()).toEqual(before);
  });

  it("allows unrelated notes, postings and account renames without expanding the reviewed set", async () => {
    const candidate = post();
    const unrelated = post({ category: { mode: "category", categoryId: UNCATEGORIZED } });
    await rule();
    const p = await preview();
    await note(unrelated.id);
    const added = post();
    expect((await api.request(`/api/accounts/${accountId}`, { method: "PATCH", headers: { "if-match": '"1"' }, body: { displayName: "Renamed" } })).status).toBe(200);
    const before = snapshot().accounts;
    expect((await get(p.id)).body).toMatchObject({ status: "ready" });
    expect((await apply(p.id)).body).toMatchObject({ ruleRun: { changedCount: 1, counts: { candidates: 1 } } });
    expect((await api.request(`/api/transactions/${candidate.id}`)).body).toMatchObject({ version: "2" });
    expect((await api.request(`/api/transactions/${added.id}`)).body).toEqual(added);
    expect(snapshot().accounts).toEqual(before);
  });

  it("ANDs canonical scope filters with inclusive from and exclusive to", async () => {
    post();
    post({ postedDate: "2026-05-01" });
    post({ category: { mode: "category", categoryId } });
    const other = (await createAccount(api, { id: uuid(2) })).id;
    post({ accountId: other });
    await rule();
    const p = await preview({ accountId: accountId.toUpperCase(), categoryId: UNCATEGORIZED.toUpperCase(), month: "2026-04" });
    expect(p.scope).toMatchObject({ accountId, categoryId: UNCATEGORIZED });
    expect(p.counts).toMatchObject({ candidates: 1, manualSkipped: 0 });
    expect((await preview({ accountId, from: "2026-04-02", to: "2026-05-01" })).counts).toMatchObject({ candidates: 1, manualSkipped: 1 });
  });

  it.each([
    { month: "2026-04", from: "2026-04-01" }, { from: "2026-04-31" }, { from: "2026-04-02", to: "2026-04-02" },
    { from: "2026-05-01", to: "2026-04-01" }, { accountId: uuid(999) }, { categoryId: uuid(999) },
  ])("rejects invalid scopes without saving: %j", async patch => {
    const before = snapshot();
    expect((await create(patch)).status).toBe(422);
    expect(snapshot()).toEqual(before);
  });

  it("keeps empty scope references from being deleted", async () => {
    const p = await preview({ accountId, categoryId });
    expect(p.counts.candidates).toBe(0);
    expect((await api.request(`/api/accounts/${accountId}`, { method: "DELETE", headers: { "if-match": '"1"' } })).body).toMatchObject({ code: "account_in_use" });
    expect((await api.request(`/api/categories/${categoryId}`, { method: "DELETE", headers: { "if-match": '"1"' } })).body).toMatchObject({ code: "category_in_use" });
  });

  it("applies every row of a partial final batch with mixed outcomes, one version, event and audit each", async () => {
    const oldRule = uuid(12, "abcdef00");
    expect((await api.request("/api/rules", { method: "POST", body: { id: oldRule, matchType: "contains", pattern: "old shop", categoryId } })).status).toBe(201);
    const returning = [post({ merchant: "OLD SHOP" }), post({ merchant: "OLD SHOP" }), post({ merchant: "OLD SHOP" })];
    expect((await api.request(`/api/rules/${oldRule}/archive`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    for (let n = 0; n < 202; n++) post();
    await rule();
    const plain = post({ merchant: "PLAIN STORE" });
    const p = await preview();
    expect(p.counts).toEqual({ candidates: 206, changes: 205, toUncategorized: 3, manualSkipped: 0 });
    const first = (await page(p.id, "?limit=200")).body as { items: RuleRunRow[]; nextCursor: string };
    const rows = [...first.items, ...((await page(p.id, `?limit=200&cursor=${first.nextCursor}`)).body as { items: RuleRunRow[] }).items];
    const versions = new Map(rows.map(row => [row.transactionId,
      (api.db.prepare("SELECT version FROM transactions WHERE id = ?").get(row.transactionId) as { version: bigint }).version]));
    const appliedAt = BigInt(api.clock.now());
    expect((await apply(p.id)).status).toBe(200);
    const names: Record<string, string> = { [categoryId]: "Food", [UNCATEGORIZED]: "Uncategorized" };
    const json = (value: RuleRunRow["before"]) => JSON.stringify({ categoryId: value.categoryId, categoryName: names[value.categoryId], assignmentOrigin: value.origin });
    for (const row of rows) {
      const revision = row.after.ruleRevision === null ? null : BigInt(row.after.ruleRevision);
      expect(api.db.prepare(`SELECT category_id, assignment_origin, rule_id, rule_revision, version, assigned_at, updated_at
        FROM transactions WHERE id = ?`).get(row.transactionId)).toEqual({ category_id: row.after.categoryId, assignment_origin: row.after.origin,
        rule_id: row.after.ruleId, rule_revision: revision, version: versions.get(row.transactionId)! + 1n, assigned_at: appliedAt, updated_at: appliedAt });
      expect(api.db.prepare(`SELECT occurred_at, before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json
        FROM assignment_events WHERE transaction_id = ? AND source = 'rule_run'`).all(row.transactionId)).toEqual([{ occurred_at: appliedAt,
        before_json: json(row.before), after_json: json(row.after), before_category_id: row.before.categoryId, after_category_id: row.after.categoryId,
        rule_id: row.after.ruleId, rule_revision: revision, related_ids_json: JSON.stringify([p.id]) }]);
      expect(api.db.prepare("SELECT command_id, account_id, before_json, after_json FROM audit_events WHERE entity_id = ? AND origin = 'rule_run'")
        .all(row.transactionId)).toEqual([{ command_id: p.id, account_id: accountId, before_json: json(row.before), after_json: json(row.after) }]);
    }
    expect(rows.filter(row => returning.some(r => r.id === row.transactionId)).map(row => row.after)).toEqual(
      Array(3).fill({ categoryId: UNCATEGORIZED, origin: "unassigned", ruleId: null, ruleRevision: null }));
    expect((await api.request(`/api/transactions/${plain.id}`)).body).toEqual(plain);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM assignment_events WHERE source = 'rule_run'").get()).toEqual({ n: 205n });
  });

  // The archive-event count and the status version check are the primary guards; these two cases
  // disable each primary path with a direct write so the backstop is exercised on its own.
  it("refuses a run whose account was archived without an archive event", async () => {
    post();
    await rule();
    const p = await preview();
    api.db.prepare("UPDATE accounts SET archived_at = ? WHERE id = ?").run(api.clock.now(), accountId);
    const before = snapshot();
    expect((await get(p.id)).body).toMatchObject({ status: "stale" });
    expect((await apply(p.id)).body).toMatchObject({ code: "preview_stale", status: 409 });
    expect(snapshot()).toEqual(before);
  });

  it("rolls back the whole apply when a candidate changes between batches", async () => {
    for (let n = 0; n < 205; n++) post();
    await rule();
    const p = await preview();
    const last = ((await page(p.id, "?limit=200&cursor=" + ((await page(p.id, "?limit=200")).body as { nextCursor: string }).nextCursor))
      .body as { items: RuleRunRow[] }).items.at(-1)!.transactionId;
    // Fires while the first batch is written, so the second batch meets a version the review never captured.
    api.db.exec(`CREATE TRIGGER change_candidate AFTER INSERT ON assignment_events WHEN NEW.source = 'rule_run'
      AND (SELECT COUNT(*) FROM assignment_events WHERE source = 'rule_run') = 1
      BEGIN UPDATE transactions SET version = version + 1 WHERE id = '${last}'; END`);
    const before = snapshot();
    expect((await apply(p.id)).status).toBe(500);
    api.db.exec("DROP TRIGGER change_candidate");
    expect(snapshot()).toEqual(before);
    expect((await get(p.id)).body).toMatchObject({ status: "ready" });
  });

  it("pages immutable changed rows with run-bound cursors", async () => {
    for (let n = 0; n < 205; n++) post();
    await rule();
    const p = await preview();
    const first = await page(p.id);
    const a = first.body as { items: { transactionId: string }[]; nextCursor: string };
    expect(a.items).toHaveLength(50);
    await note(a.items[0].transactionId);
    const b = (await page(p.id, `?limit=200&cursor=${a.nextCursor}`)).body as typeof a;
    expect(b.items).toHaveLength(155);
    expect(b.nextCursor).toBeNull();
    expect(new Set([...a.items, ...b.items].map(row => row.transactionId)).size).toBe(205);
    expect((await page(p.id)).body).toEqual(first.body);
    const other = await preview();
    expect((await page(other.id, `?cursor=${a.nextCursor}`)).body).toMatchObject({ code: "cursor_filter_mismatch" });
    for (const query of ["?cursor=bad", "?cursor=%", "?cursor=a&cursor=b"]) expect((await page(p.id, query)).body).toMatchObject({ code: "invalid_cursor" });
    for (const query of ["?limit=0", "?limit=201", "?limit=1&limit=2", "?foo=bar"]) expect((await page(p.id, query)).status).toBe(400);
  });

  it("persists unapplied previews and recorded results across restart, later edits and expiry", async () => {
    const row = post();
    await rule();
    const p = await preview();
    const expiring = await preview();
    await api.restart();
    expect((await get(p.id)).body).toEqual(p);
    const first = await apply(p.id);
    expect(first.status, first.text).toBe(200);
    await note(row.id, "2");
    await lifecycle("archive", "1");
    await api.restart();
    api.clock.advance(86_400_000);
    expect((await apply(p.id)).status).toBe(401);
    await api.login();
    const before = snapshot();
    expect((await apply(p.id)).body).toEqual(first.body);
    expect((await get(p.id)).body).toEqual((first.body as { ruleRun: RuleRun }).ruleRun);
    expect((await page(p.id)).status).toBe(200);
    expect((await get(expiring.id)).body).toMatchObject({ status: "expired" });
    expect((await apply(expiring.id)).body).toMatchObject({ code: "preview_expired", status: 410 });
    expect((await page(expiring.id)).status).toBe(410);
    expect(snapshot()).toEqual(before);
  });

  it("requires authentication and CSRF before lookup or replay", async () => {
    const p = await preview();
    expect((await apply(p.id)).status).toBe(200);
    const before = snapshot();
    for (const path of ["/api/rule-runs", `/api/rule-runs/${p.id}/apply`]) {
      expect((await api.request(path, { method: "POST", omitCookie: true, body: {} })).status).toBe(401);
      expect((await api.request(path, { method: "POST", csrfToken: null, body: {} })).status).toBe(403);
    }
    for (const path of [`/api/rule-runs/${p.id}`, `/api/rule-runs/${p.id}/rows`]) expect((await api.request(path, { omitCookie: true })).status).toBe(401);
    expect((await get("bad")).status).toBe(404);
    expect((await get(uuid(999))).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it("rechecks session expiry after computing proposals and before publishing", async () => {
    post();
    await rule();
    const before = snapshot();
    const original = api.deps.newId;
    let calls = 0;
    api.deps.newId = () => {
      calls++;
      if (calls === 2) api.clock.advance(1_800_000);
      return original();
    };
    expect((await create()).body).toMatchObject({ status: 401, code: "session_expired" });
    expect(snapshot()).toEqual(before);
  });

  it("rolls back preview publication when checking its response fails", async () => {
    post();
    await rule();
    const prepared = prepareRuleRun(context(), scope);
    const before = snapshot();
    expect(() => withWriteTransaction(api.db, () => publishRuleRun(context(), prepared, () => {
      throw new Error("Response rejected");
    }))).toThrow("Response rejected");
    expect(snapshot()).toEqual(before);
  });

  it.each(["candidate", "rule", "archive"])("revalidates %s before publishing a computed preview", async change => {
    const row = post();
    const prepared = prepareRuleRun(context(), scope);
    if (change === "candidate") await note(row.id);
    if (change === "rule") await rule();
    if (change === "archive") await lifecycle("archive", "1");
    const before = snapshot();
    expect(() => withWriteTransaction(api.db, () => publishRuleRun(context(), prepared, value => value))).toThrow("Nothing was saved");
    expect(snapshot()).toEqual(before);
  });

  it.each(["midway", "response", "transaction-overflow", "finance-overflow"])("rolls back assignments, history and result after %s failure", async failure => {
    post();
    const second = post();
    await rule();
    if (failure === "transaction-overflow") api.db.prepare("UPDATE transactions SET version = 999999999999999999 WHERE id = ?").run(second.id);
    if (failure === "finance-overflow") api.db.exec("UPDATE ledger_metadata SET finance_revision = 999999999999999999");
    const p = await preview();
    if (failure === "midway") api.db.exec(`CREATE TRIGGER fail_run BEFORE INSERT ON assignment_events
      WHEN NEW.source = 'rule_run' AND NEW.transaction_id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const before = snapshot();
    if (failure === "response") {
      api.deps.config.environment = "production";
      expect(() => withWriteTransaction(api.db, () => applyRuleRun(context(), p.id, value =>
        checkedResponse(RuleRunResult, { ...value as object, financeRevision: "invalid" })))).toThrow();
    } else expect((await apply(p.id)).status).toBe(500);
    expect(snapshot()).toEqual(before);
    expect((await get(p.id)).body).toMatchObject({ status: "ready" });
  });

  it("accepts all 25,000 candidates and refuses 25,001 without truncation", async () => {
    for (let n = 0; n < 25000; n++) post();
    await api.request("/api/health").catch(() => undefined);
    await rule();
    const p = await preview();
    expect(p.counts).toMatchObject({ candidates: 25000, changes: 25000 });
    const accounts = snapshot().accounts;
    const result = await apply(p.id);
    expect(result.status, result.text).toBe(200);
    expect(result.body).toMatchObject({ ruleRun: { changedCount: 25000 } });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM assignment_events WHERE source = 'rule_run'").get()).toEqual({ n: 25000n });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE version = 2 AND rule_id = ?").get(ruleId)).toEqual({ n: 25000n });
    expect(snapshot().accounts).toEqual(accounts);
    post();
    const count = api.db.prepare("SELECT COUNT(*) AS n FROM rule_runs").get();
    expect((await create()).body).toMatchObject({ code: "scope_too_large", status: 422 });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM rule_runs").get()).toEqual(count);
  }, 120000);
});
