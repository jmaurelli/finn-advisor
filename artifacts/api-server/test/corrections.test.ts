import { withWriteTransaction } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { easternDate } from "../src/domain/dates.js";
import type { PostingInput } from "../src/lib/transaction-schemas.js";
import { categorizeTransaction, type NewRuleInput } from "../src/services/corrections.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, INCOME_CATEGORY, postThroughService, UNCATEGORIZED, uuid } from "./finance-harness.js";

let api: TestServer;
let accountId: string;
const FOOD = "abcdef00-0000-4000-8000-000000000001";
const HOME = "abcdef00-0000-4000-8000-000000000002";
const rule = (n: number) => uuid(n, "60000000");

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  accountId = (await createAccount(api, { id: uuid(1), openingMinor: "200000" })).id;
  for (const [id, name] of [[FOOD, "Food"], [HOME, "Home"]]) {
    expect((await api.request("/api/categories", { method: "POST", body: { id, name, color: "#123456" } })).status).toBe(201);
  }
});
afterEach(async () => { await api.close(); });

const post = (patch: Partial<PostingInput> = {}) => postThroughService(api, {
  accountId, postedDate: "2026-04-02", merchant: "SYNTHETIC MARKET", kind: "purchase",
  money: { amountMinor: "-8000", currency: "USD" }, ...patch,
});
const categorize = (id: string, version: number | null, body: unknown) => api.request(`/api/transactions/${id}/categorize`,
  { method: "POST", headers: version === null ? {} : { "if-match": `"${version}"` }, body });
const returnToRules = (id: string, version: number) => api.request(`/api/transactions/${id}/return-to-rules`,
  { method: "POST", headers: { "if-match": `"${version}"` } });
const setNote = (id: string, version: number, note: unknown) => api.request(`/api/transactions/${id}/note`,
  { method: "PATCH", headers: { "if-match": `"${version}"` }, body: { note } });
const createRule = (n: number, body: Record<string, unknown> = {}) => api.request("/api/rules", { method: "POST",
  body: { id: rule(n), matchType: "contains", pattern: "synthetic market", categoryId: FOOD, ...body } });
const history = async (id: string) =>
  ((await api.request(`/api/transactions/${id}/history`)).body as { items: Record<string, unknown>[] }).items;
const snapshot = () => ({
  transactions: api.db.prepare("SELECT * FROM transactions ORDER BY id").all(),
  events: api.db.prepare("SELECT * FROM assignment_events ORDER BY id").all(),
  audit: api.db.prepare("SELECT * FROM audit_events ORDER BY id").all(),
  rules: api.db.prepare("SELECT * FROM rules ORDER BY id").all(),
  revisions: api.db.prepare("SELECT * FROM rule_revisions ORDER BY rule_id, revision").all(),
  accounts: api.db.prepare("SELECT * FROM accounts ORDER BY id").all(),
  metadata: api.db.prepare("SELECT * FROM ledger_metadata").get(),
});
const newRule = (n: number, patch: Record<string, unknown> = {}): NewRuleInput => ({ id: rule(n), matchType: "contains",
  pattern: "synthetic market", appliesTo: "purchases_and_refunds", accountId: null, ...patch });

describe("manual category corrections", () => {
  it("saves a protected manual category without touching money, the ledger revision or reconciliation", async () => {
    const row = post();
    expect((await api.request(`/api/accounts/${accountId}/checkpoints`, { method: "POST", body: {
      id: uuid(30), closingDate: "2026-04-30", statementBalance: { amountMinor: "192000", currency: "USD" },
    } })).body).toMatchObject({ checkpoint: { status: "reconciled" } });
    const before = snapshot();
    api.clock.advance(60_000);
    const response = await categorize(row.id.toUpperCase(), 1, { categoryId: FOOD.toUpperCase() });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"2"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toMatchObject({ transaction: { categoryId: FOOD, version: "2",
      assignment: { origin: "manual", assignedAt: "2026-05-02T13:56:00Z", ruleId: null, ruleRevision: null },
      money: row.money, postedDate: row.postedDate }, rule: null, ruleOverlaps: [], ruleSetRevision: "0" });
    const finance = (before.metadata as { finance_revision: bigint }).finance_revision;
    expect(response.body).toMatchObject({ financeRevision: String(finance + 1n) });
    expect(snapshot().accounts).toEqual(before.accounts);
    expect((await api.request(`/api/accounts/${accountId}/checkpoints`)).body).toMatchObject({ items: [{ status: "reconciled" }] });
    expect((await history(row.id))[0]).toMatchObject({ eventType: "category_changed", source: "owner", relatedIds: [],
      before: { categoryId: UNCATEGORIZED, categoryName: "Uncategorized", assignmentOrigin: "unassigned" },
      after: { categoryId: FOOD, categoryName: "Food", assignmentOrigin: "manual" }, ruleId: null });
    expect((await api.request(`/api/transactions/${row.id}`)).body).toEqual((response.body as { transaction: unknown }).transaction);
  });

  it("keeps manual Uncategorized protected from rules until returned to rules", async () => {
    const row = post();
    const manual = await categorize(row.id, 1, { categoryId: UNCATEGORIZED });
    expect(manual.body).toMatchObject({ transaction: { categoryId: UNCATEGORIZED, assignment: { origin: "manual" } } });
    expect((await createRule(1)).status).toBe(201);
    const later = post();
    expect(later.assignment).toMatchObject({ origin: "rule", ruleId: rule(1), ruleRevision: "1" });
    expect((await api.request(`/api/transactions/${row.id}`)).body).toMatchObject({ categoryId: UNCATEGORIZED,
      assignment: { origin: "manual" }, version: "2" });
    const returned = await returnToRules(row.id, 2);
    expect(returned.status).toBe(200);
    expect(returned.headers.get("etag")).toBe('"3"');
    expect(returned.body).toMatchObject({ transaction: { categoryId: FOOD,
      assignment: { origin: "rule", ruleId: rule(1), ruleRevision: "1" } } });
    expect((await history(row.id))[0]).toMatchObject({ eventType: "returned_to_rules", ruleId: rule(1), ruleRevision: "1",
      before: { categoryId: UNCATEGORIZED, assignmentOrigin: "manual" }, after: { categoryId: FOOD, assignmentOrigin: "rule" } });
    expect((await api.request(`/api/rules/${rule(1)}`)).body).toMatchObject({ currentAssignmentCount: 2 });
  });

  it("clears rule attribution for a same-category manual choice but writes nothing for a genuine no-op", async () => {
    expect((await createRule(1)).status).toBe(201);
    const row = post();
    expect(row.assignment.origin).toBe("rule");
    const manual = await categorize(row.id, 1, { categoryId: FOOD });
    expect(manual.body).toMatchObject({ transaction: { categoryId: FOOD, version: "2",
      assignment: { origin: "manual", ruleId: null, ruleRevision: null } } });
    expect((await history(row.id))[0]).toMatchObject({ eventType: "category_changed",
      before: { categoryId: FOOD, assignmentOrigin: "rule" }, after: { categoryId: FOOD, assignmentOrigin: "manual" } });
    expect((await api.request(`/api/rules/${rule(1)}`)).body).toMatchObject({ currentAssignmentCount: 0 });
    const before = snapshot();
    const again = await categorize(row.id, 2, { categoryId: FOOD });
    expect(again.status).toBe(200);
    expect(again.headers.get("etag")).toBe('"2"');
    expect(snapshot()).toEqual(before);
    // Returning an unassigned row that rules still leave unassigned is also a no-op.
    const plain = post({ merchant: "UNMATCHED PLACE" });
    const income = post({ kind: "income", money: { amountMinor: "100", currency: "USD" } });
    const beforeReturn = snapshot();
    expect((await returnToRules(plain.id, 1)).headers.get("etag")).toBe('"1"');
    // Income keeps its system assignment: return to rules changes nothing.
    expect((await returnToRules(income.id, 1)).body).toMatchObject({ transaction: { categoryId: INCOME_CATEGORY, version: "1" } });
    expect(snapshot()).toEqual(beforeReturn);
  });

  it("refuses ineligible categories and kinds, writing nothing", async () => {
    const row = post();
    const income = post({ kind: "income", money: { amountMinor: "100", currency: "USD" } });
    const transfer = post({ kind: "transfer", money: { amountMinor: "-100", currency: "USD" } });
    expect((await api.request(`/api/categories/${HOME}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "0", budgetPlanVersion: null, ruleResolutions: [] } })).status).toBe(200);
    const before = snapshot();
    for (const [id, body, status, code] of [
      [row.id, { categoryId: HOME }, 409, "category_archived"],
      [row.id, { categoryId: INCOME_CATEGORY }, 422, "validation_failed"],
      [row.id, { categoryId: uuid(99, "abcdef00") }, 422, "validation_failed"],
      [row.id, { categoryId: "not-a-uuid" }, 422, "validation_failed"],
      [row.id, { categoryId: FOOD, extra: true }, 422, "validation_failed"],
      [income.id, { categoryId: FOOD }, 422, "validation_failed"],
      [transfer.id, { categoryId: FOOD }, 422, "validation_failed"],
      [row.id, { categoryId: UNCATEGORIZED, newRule: newRule(1) }, 422, "rule_target_ineligible"],
      [row.id, { categoryId: FOOD, newRule: newRule(1, { pattern: "   " }) }, 422, "validation_failed"],
      [row.id, { categoryId: FOOD, newRule: newRule(1, { accountId: uuid(77) }) }, 422, "validation_failed"],
      [row.id, { categoryId: FOOD, newRule: newRule(1, { pattern: "\ud800" }) }, 422, "validation_failed"],
    ] as const) {
      const response = await categorize(id, 1, body);
      expect([response.status, (response.body as { code: string }).code]).toEqual([status, code]);
    }
    expect(snapshot()).toEqual(before);
  });

  it("enforces preconditions, CSRF, session and existence", async () => {
    const row = post();
    const before = snapshot();
    expect((await categorize(row.id, null, { categoryId: FOOD })).status).toBe(428);
    expect((await api.request(`/api/transactions/${row.id}/categorize`, { method: "POST",
      headers: { "if-match": "W/\"1\"" }, body: { categoryId: FOOD } })).status).toBe(400);
    const stale = await categorize(row.id, 2, { categoryId: FOOD });
    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ code: "version_mismatch", currentVersion: "1" });
    expect((await api.request(`/api/transactions/${row.id}/categorize`, { method: "POST", csrfToken: null,
      headers: { "if-match": '"1"' }, body: { categoryId: FOOD } })).status).toBe(403);
    expect((await api.request(`/api/transactions/${row.id}/note`, { method: "PATCH", omitCookie: true,
      headers: { "if-match": '"1"' }, body: { note: "x" } })).status).toBe(401);
    expect((await returnToRules(uuid(404, "10000000"), 1)).status).toBe(404);
    expect((await returnToRules(row.id, 7)).status).toBe(412);
    expect((await setNote(row.id, 9, "x")).status).toBe(412);
    expect(snapshot()).toEqual(before);
  });
});

describe("correction plus new rule", () => {
  it("saves both together, appends the rule and changes no other transaction", async () => {
    expect((await createRule(1, { pattern: "market", categoryId: HOME })).status).toBe(201);
    const row = post();
    const other = post();
    const response = await categorize(row.id, 1, { categoryId: FOOD.toUpperCase(),
      newRule: newRule(2, { id: rule(2).toUpperCase(), accountId: accountId.toUpperCase() }) });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transaction: { categoryId: FOOD, assignment: { origin: "manual" }, version: "2" },
      rule: { id: rule(2), position: 2, categoryId: FOOD, accountId, enabled: true, currentAssignmentCount: 0 },
      ruleOverlaps: [{ ruleId: rule(1), position: 1, reason: "broader_earlier" }], ruleSetRevision: "2",
    });
    expect((await history(row.id))[0]).toMatchObject({ eventType: "category_changed", relatedIds: [rule(2)] });
    expect((await api.request(`/api/transactions/${other.id}`)).body).toEqual(other);
  });

  it("replays the recorded result after later edits and a restart, and refuses a reused rule id", async () => {
    const row = post();
    const body = { categoryId: FOOD, newRule: newRule(2) };
    const first = await categorize(row.id, 1, body);
    expect(first.status).toBe(200);
    expect((await setNote(row.id, 2, "later edit")).status).toBe(200);
    expect((await createRule(3, { pattern: "other" })).status).toBe(201);
    const before = snapshot();
    await api.restart();
    const replay = await categorize(row.id, 1, { ...body, categoryId: FOOD.toUpperCase(),
      newRule: { ...newRule(2), id: rule(2).toUpperCase() } });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("etag")).toBe('"2"');
    expect(replay.body).toEqual(first.body);
    expect(snapshot()).toEqual(before);
    for (const changed of [{ ...body, categoryId: HOME }, { ...body, newRule: newRule(2, { matchType: "exact" }) }]) {
      const conflict = await categorize(row.id, 3, changed);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ code: "client_id_conflict" });
    }
    const elsewhere = await categorize(post().id, 1, body);
    expect(elsewhere.body).toMatchObject({ code: "client_id_conflict" });
    // A rule created on its own never recorded a correction; its id cannot be a correction's retry token.
    expect((await categorize(row.id, 3, { categoryId: FOOD, newRule: newRule(3, { pattern: "other" }) })).status).toBe(409);
    expect(snapshot().events).toHaveLength((before.events as unknown[]).length + 1);
  });

  it("rolls back the rule, assignment, history and revisions when the checked response fails", async () => {
    const row = post();
    const before = snapshot();
    const context = { db: api.db, now: api.clock.now(), today: easternDate(api.clock.now()), newId: api.deps.newId };
    expect(() => withWriteTransaction(api.db, () => categorizeTransaction(context, row.id, 1n,
      { categoryId: FOOD, newRule: newRule(2) }, () => { throw new Error("response does not match"); })))
      .toThrow("response does not match");
    expect(snapshot()).toEqual(before);
    expect((await categorize(row.id, 1, { categoryId: FOOD, newRule: newRule(2) })).status).toBe(200);
  });
});

describe("notes and archived accounts", () => {
  it("sets, clears and bounds notes with history, without touching the account", async () => {
    const row = post();
    const accounts = snapshot().accounts;
    const set = await setNote(row.id, 1, "\u{1F600}".repeat(1000));
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ transaction: { note: "\u{1F600}".repeat(1000), version: "2" } });
    const before = snapshot();
    expect((await setNote(row.id, 2, "\u{1F600}".repeat(1000))).headers.get("etag")).toBe('"2"');
    expect(snapshot()).toEqual(before);
    for (const bad of ["\u{1F600}".repeat(1001), "   ", "", "\ud800", 5]) {
      expect((await setNote(row.id, 2, bad)).status).toBe(422);
    }
    expect((await api.request(`/api/transactions/${row.id}/note`, { method: "PATCH", headers: { "if-match": '"2"' },
      body: {} })).status).toBe(422);
    const cleared = await setNote(row.id, 2, null);
    expect(cleared.body).toMatchObject({ transaction: { note: null, version: "3" } });
    expect((await history(row.id)).slice(0, 2)).toMatchObject([
      { eventType: "note_changed", before: { note: "\u{1F600}".repeat(1000) }, after: { note: null } },
      { eventType: "note_changed", before: { note: null }, after: { note: "\u{1F600}".repeat(1000) } },
    ]);
    expect(snapshot().accounts).toEqual(accounts);
  });

  it("allows category and note edits on an archived account but refuses return to rules", async () => {
    const row = post();
    const account = await api.request(`/api/accounts/${accountId}`);
    expect((await api.request(`/api/accounts/${accountId}/archive`, { method: "POST",
      headers: { "if-match": account.headers.get("etag") ?? "" } })).status).toBe(200);
    const accounts = snapshot().accounts;
    expect((await categorize(row.id, 1, { categoryId: FOOD, newRule: newRule(2) })).status).toBe(200);
    expect((await setNote(row.id, 2, "kept for records")).status).toBe(200);
    const before = snapshot();
    const refused = await returnToRules(row.id, 3);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "reactivation_required" });
    expect(snapshot()).toEqual(before);
    expect(snapshot().accounts).toEqual(accounts);
  });
});
