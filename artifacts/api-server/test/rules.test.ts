import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, INCOME_CATEGORY, postTransaction, UNCATEGORIZED, uuid } from "./finance-harness.js";
import { assignByRules } from "../src/services/assignment.js";
import { createRule, requireRule, updateRule } from "../src/services/rules.js";

let api: TestServer;
const FOOD = "abcdef00-0000-4000-8000-000000000001";
const HOME = "abcdef00-0000-4000-8000-000000000002";
const rule = (n: number) => uuid(n, "60000000");
const base = { matchType: "contains", pattern: "Synthetic Market", categoryId: FOOD };

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  for (const [id, name] of [[FOOD, "Food"], [HOME, "Home"]]) {
    expect((await api.request("/api/categories", { method: "POST", body: { id, name, color: "#123456" } })).status).toBe(201);
  }
});
afterEach(async () => { await api.close(); });

const create = (n: number, body: Record<string, unknown> = {}) =>
  api.request("/api/rules", { method: "POST", body: { id: rule(n), ...base, ...body } });
const patch = (n: number, version: number, body: unknown) =>
  api.request(`/api/rules/${rule(n)}`, { method: "PATCH", headers: { "if-match": `"${version}"` }, body });
const archive = (n: number, version: number) =>
  api.request(`/api/rules/${rule(n)}/archive`, { method: "POST", headers: { "if-match": `"${version}"` } });
const list = async (status = "active") =>
  (await api.request(`/api/rules?status=${status}`)).body as { items: Record<string, unknown>[]; ruleSetRevision: string };
const history = async (n: number) =>
  ((await api.request(`/api/rules/${rule(n)}/history`)).body as { revisions: Record<string, unknown>[] }).revisions;
const snapshot = () => ({
  rules: api.db.prepare("SELECT * FROM rules ORDER BY id").all(),
  revisions: api.db.prepare("SELECT * FROM rule_revisions ORDER BY rule_id, revision").all(),
  categories: api.db.prepare("SELECT * FROM categories ORDER BY id").all(),
  transactions: api.db.prepare("SELECT * FROM transactions ORDER BY id").all(),
  audit: api.db.prepare("SELECT * FROM audit_events ORDER BY id").all(),
  metadata: api.db.prepare("SELECT * FROM ledger_metadata").get(),
});
const context = () => ({ db: api.db, now: api.clock.now(), today: "2026-05-02", newId: api.deps.newId });

describe("rule commands", () => {
  it("appends, replays the current representation and refuses a reused id with different content", async () => {
    const first = await create(1, { id: rule(1).toUpperCase(), categoryId: FOOD.toUpperCase() });
    expect(first.status).toBe(201);
    expect(first.headers.get("etag")).toBe('"1"');
    expect(first.body).toMatchObject({
      rule: { id: rule(1), position: 1, revision: "1", appliesTo: "purchases_and_refunds", accountId: null,
        categoryId: FOOD, enabled: true, status: "active", currentAssignmentCount: 0, version: "1" },
      overlaps: [], ruleSetRevision: "1", financeRevision: "3",
    });
    expect((await create(2, { pattern: "cafe" })).body).toMatchObject({ rule: { position: 2 }, ruleSetRevision: "2" });
    expect((await patch(1, 1, { enabled: false })).status).toBe(200);
    await api.restart();
    const before = snapshot();
    // Omitted defaults and explicit defaults are the same request.
    const replay = await create(1, { appliesTo: "purchases_and_refunds", enabled: true, accountId: null });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("etag")).toBe('"2"');
    expect(replay.body).toMatchObject({ rule: { id: rule(1), enabled: false, revision: "2" }, ruleSetRevision: "3" });
    expect(snapshot()).toEqual(before);
    const conflict = await create(1, { pattern: "Other" });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "client_id_conflict" });
    expect(snapshot()).toEqual(before);
  });

  it.each([
    [{ pattern: " \t\n" }, 422, "validation_failed"],
    [{ pattern: "\u3000\u00a0" }, 422, "validation_failed"],
    [{ pattern: "a".repeat(257) }, 422, "validation_failed"],
    [{ pattern: "\u{1f600}".repeat(257) }, 422, "validation_failed"],
    [{ extra: true }, 422, "validation_failed"],
    [{ matchType: "regex" }, 422, "validation_failed"],
    [{ categoryId: INCOME_CATEGORY }, 422, "rule_target_ineligible"],
    [{ categoryId: UNCATEGORIZED }, 422, "rule_target_ineligible"],
    [{ categoryId: uuid(404) }, 422, "rule_target_ineligible"],
    [{ accountId: uuid(404) }, 422, "validation_failed"],
  ])("refuses %j without writes", async (body, status, code) => {
    const before = snapshot();
    const response = await create(1, body);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
    expect(snapshot()).toEqual(before);
  });

  it("accepts code-point-length patterns, NUL and expanding normalization", async () => {
    for (const [n, pattern] of [[1, "\u{1f600}".repeat(256)], [2, "\u0000"], [3, "\ufdfa".repeat(256)]] as const) {
      const response = await create(n, { pattern });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ rule: { pattern } });
    }
    expect((await api.request("/api/rules")).status).toBe(200);
    expect((await history(3))[0]).toMatchObject({ pattern: "\ufdfa".repeat(256) });
  });

  it("refuses an archived target, including enabling a disabled rule that retained one", async () => {
    expect((await create(1)).status).toBe(201);
    expect((await patch(1, 1, { enabled: false })).status).toBe(200);
    const archived = await api.request(`/api/categories/${FOOD}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "2", budgetPlanVersion: null, ruleResolutions: [] } });
    expect(archived.status).toBe(200);
    const before = snapshot();
    for (const response of [await create(2), await patch(1, 2, { enabled: true }), await patch(1, 2, { enabled: true, pattern: "x" })]) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "category_archived" });
    }
    expect(snapshot()).toEqual(before);
    // A disabled rule may still be edited while it keeps its retained target.
    const edit = await patch(1, 2, { pattern: "Renamed Market" });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ rule: { categoryId: FOOD, enabled: false, revision: "3" } });
  });

  it("partial edits preserve omitted fields, label each revision and keep old explanations", async () => {
    const account = await createAccount(api);
    expect((await create(1, { accountId: account.id.toUpperCase(), appliesTo: "refunds" })).status).toBe(201);
    const steps: [Record<string, unknown>, string][] = [
      [{ pattern: "Synthetic Grocer" }, "edited"],
      [{ enabled: false }, "disabled"],
      [{ enabled: true }, "enabled"],
      [{ categoryId: HOME.toUpperCase() }, "retargeted"],
      [{ accountId: null, matchType: "exact" }, "edited"],
    ];
    for (const [index, [body, change]] of steps.entries()) {
      const response = await patch(1, index + 1, body);
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBe(`"${index + 2}"`);
      expect((await history(1))[0]).toMatchObject({ change, revision: String(index + 2) });
    }
    const current = (await api.request(`/api/rules/${rule(1)}`)).body;
    expect(current).toMatchObject({ appliesTo: "refunds", accountId: null, matchType: "exact",
      pattern: "Synthetic Grocer", categoryId: HOME, enabled: true, revision: "6", version: "6" });
    expect((await api.request(`/api/categories/${FOOD}`, { method: "PATCH", headers: { "if-match": '"1"' },
      body: { name: "Groceries" } })).status).toBe(200);
    const revisions = await history(1);
    expect(revisions.map(entry => entry["revision"])).toEqual(["6", "5", "4", "3", "2", "1"]);
    expect(revisions.at(-1)).toMatchObject({ change: "created", categoryNameAtRevision: "Food", accountId: account.id,
      pattern: "Synthetic Market", appliesTo: "refunds" });
    expect(revisions[0]).toMatchObject({ categoryNameAtRevision: "Home" });
  });

  it("writes nothing for an unchanged patch and enforces preconditions", async () => {
    expect((await create(1)).status).toBe(201);
    const before = snapshot();
    const same = await patch(1, 1, { pattern: base.pattern, enabled: true, categoryId: FOOD.toUpperCase() });
    expect(same.status).toBe(200);
    expect(same.headers.get("etag")).toBe('"1"');
    expect(snapshot()).toEqual(before);
    for (const [headers, status] of [[{}, 428], [{ "if-match": 'W/"1"' }, 400], [{ "if-match": '"2"' }, 412]] as const) {
      expect((await api.request(`/api/rules/${rule(1)}`, { method: "PATCH", headers, body: { enabled: false } })).status).toBe(status);
      expect((await api.request(`/api/rules/${rule(1)}/archive`, { method: "POST", headers })).status).toBe(status);
    }
    for (const body of [{}, { extra: 1 }, { pattern: "\t" }, { categoryId: INCOME_CATEGORY }]) {
      expect((await patch(1, 1, body)).status).toBe(422);
    }
    expect((await api.request(`/api/rules/${rule(1)}`, { method: "PATCH", headers: { "if-match": '"1"' },
      body: { enabled: false }, csrfToken: null })).status).toBe(403);
    expect((await api.request("/api/rules", { omitCookie: true })).status).toBe(401);
    for (const missing of ["nonsense", rule(404)]) {
      expect((await api.request(`/api/rules/${missing}`)).status).toBe(404);
      expect((await api.request(`/api/rules/${missing}/history`)).status).toBe(404);
    }
    expect((await api.request("/api/rules?status=retired")).status).toBe(400);
    expect(snapshot()).toEqual(before);
  });

  it("reorders the complete active set against the rule-set revision, bumping only moved rules", async () => {
    for (const n of [1, 2, 3]) expect((await create(n, { pattern: `p${n}` })).status).toBe(201);
    const reorder = (ruleSetRevision: string, ids: string[]) =>
      api.request("/api/rules/reorder", { method: "POST", body: { ruleSetRevision, orderedRuleIds: ids } });
    const before = snapshot();
    expect((await reorder("2", [rule(3), rule(2), rule(1)])).body).toMatchObject({ code: "rule_set_changed" });
    for (const ids of [[rule(1), rule(2)], [rule(1), rule(2), rule(3), rule(404)], [rule(1), rule(2), rule(2).toUpperCase()]]) {
      const response = await reorder("3", ids);
      expect(response.status).toBe(422);
    }
    expect(snapshot()).toEqual(before);
    const response = await reorder("3", [rule(2).toUpperCase(), rule(1), rule(3)]);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ruleSetRevision: "4", items: [
      { id: rule(2), position: 1, version: "2", revision: "1" },
      { id: rule(1), position: 2, version: "2", revision: "1" },
      { id: rule(3), position: 3, version: "1" },
    ] });
    const unchanged = snapshot();
    expect((await reorder("4", [rule(2), rule(1), rule(3)])).status).toBe(200);
    expect(snapshot()).toEqual(unchanged);
  });

  it("archives out of the order, keeps history and returns unchanged on a repeated archive", async () => {
    for (const n of [1, 2, 3]) expect((await create(n, { pattern: `p${n}` })).status).toBe(201);
    const response = await archive(1, 1);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ rule: { status: "archived", position: null, revision: "2", version: "2",
      enabled: true }, overlaps: [], ruleSetRevision: "4" });
    expect((await list()).items.map(item => [item["id"], item["position"], item["version"]]))
      .toEqual([[rule(2), 1, "2"], [rule(3), 2, "2"]]);
    expect((await list("archived")).items.map(item => item["id"])).toEqual([rule(1)]);
    expect((await list("all")).items.map(item => item["id"])).toEqual([rule(2), rule(3), rule(1)]);
    expect((await history(1)).map(entry => entry["change"])).toEqual(["archived", "created"]);
    const before = snapshot();
    const again = await archive(1, 2);
    expect(again.status).toBe(200);
    expect(again.headers.get("etag")).toBe('"2"');
    expect(snapshot()).toEqual(before);
    expect((await patch(1, 2, { enabled: false })).status).toBe(422);
    expect((await create(4, { pattern: "p4" })).body).toMatchObject({ rule: { position: 3 } });
  });

  it("reports overlaps against enabled active rules by scope, type and literal pattern", async () => {
    const account = await createAccount(api);
    expect((await create(1, { pattern: "synthetic market" })).status).toBe(201);
    const exact = await create(2, { matchType: "exact", pattern: "SYNTHETIC  market return", appliesTo: "refunds" });
    expect(exact.body).toMatchObject({ overlaps: [{ ruleId: rule(1), position: 1, reason: "broader_earlier" }] });
    const same = await create(3, { pattern: " Synthetic\tMarket " });
    expect(same.body).toMatchObject({ overlaps: [{ ruleId: rule(1), reason: "same_match" }] });
    const scoped = await create(4, { pattern: "market", accountId: account.id });
    expect(scoped.body).toMatchObject({ overlaps: [] });
    const broad = await create(5, { pattern: "market" });
    // Narrower earlier rules are the intended specific-first order, so no warning.
    expect((broad.body as { overlaps: unknown[] }).overlaps).toEqual([]);
    // Moving the broad rule first makes every later narrower rule unreachable.
    const order = [rule(5), rule(1), rule(2), rule(3), rule(4)];
    expect((await api.request("/api/rules/reorder", { method: "POST", body: { ruleSetRevision: "5", orderedRuleIds: order } })).status).toBe(200);
    const moved = await patch(5, 2, { pattern: "Market" });
    expect((moved.body as { overlaps: { ruleId: string; reason: string }[] }).overlaps).toEqual([
      { ruleId: rule(1), position: 2, reason: "narrower_later" },
      { ruleId: rule(2), position: 3, reason: "narrower_later" },
      { ruleId: rule(3), position: 4, reason: "narrower_later" },
      { ruleId: rule(4), position: 5, reason: "narrower_later" },
    ]);
    // Disabled rules do not compete (rules 5 and 1 would otherwise be broader and earlier).
    expect((await patch(1, 2, { enabled: false })).status).toBe(200);
    expect((await patch(5, 3, { enabled: false })).status).toBe(200);
    const late = await create(6, { matchType: "exact", pattern: "synthetic market return", appliesTo: "refunds" });
    expect((late.body as { overlaps: unknown[] }).overlaps).toEqual([
      { ruleId: rule(2), position: 3, reason: "same_match" },
      { ruleId: rule(3), position: 4, reason: "broader_earlier" },
    ]);
    // Partial overlaps (some shared merchants, neither containing the other) are not reported.
    expect(((await create(7, { pattern: "market cafe", appliesTo: "purchases" })).body as { overlaps: unknown[] }).overlaps)
      .toEqual([]);
  });

  it("distinguishes transaction types and exact from contains when reporting overlaps", async () => {
    expect((await create(1, { pattern: "market", appliesTo: "purchases" })).status).toBe(201);
    expect(((await create(2, { pattern: "market x", appliesTo: "refunds" })).body as { overlaps: unknown[] }).overlaps).toEqual([]);
    expect(((await create(3, { pattern: "market y", appliesTo: "purchases" })).body as { overlaps: unknown[] }).overlaps)
      .toEqual([{ ruleId: rule(1), position: 1, reason: "broader_earlier" }]);
    expect((await create(4, { matchType: "exact", pattern: "cafe" })).status).toBe(201);
    // An exact rule never covers a contains rule with the same text; the later contains rule is not shadowed.
    expect(((await create(5, { pattern: "cafe" })).body as { overlaps: unknown[] }).overlaps).toEqual([]);
    expect(((await create(6, { pattern: "cafe", accountId: null, appliesTo: "refunds" })).body as { overlaps: unknown[] }).overlaps)
      .toEqual([{ ruleId: rule(5), position: 5, reason: "broader_earlier" }]);
  });

  it("caps overlap warnings at the contract's 100, in position order", async () => {
    withWriteTransaction(api.db, () => {
      createRule(context(), { id: rule(1), matchType: "contains", pattern: "zz", categoryId: FOOD });
      for (let n = 2; n <= 102; n++) createRule(context(), { id: rule(n), matchType: "contains", pattern: `zz${n}`, categoryId: FOOD });
    });
    const response = await patch(1, 1, { pattern: "ZZ" });
    const overlaps = (response.body as { overlaps: { position: number; reason: string }[] }).overlaps;
    expect(overlaps).toHaveLength(100);
    expect(overlaps[0]).toMatchObject({ position: 2, reason: "narrower_later" });
    expect(overlaps.at(-1)).toMatchObject({ position: 101 });
  });

  it("refuses an unknown scope account or malformed Unicode in an edit without writes", async () => {
    expect((await create(1)).status).toBe(201);
    const before = snapshot();
    expect((await patch(1, 1, { accountId: uuid(404) })).body).toMatchObject({ code: "validation_failed" });
    expect((await patch(1, 1, { pattern: "a\ud800" })).body).toMatchObject({ code: "validation_failed" });
    expect((await create(2, { pattern: "\udfffb" })).body).toMatchObject({ code: "validation_failed" });
    expect((await api.request("/api/categories", { method: "POST", body: { id: uuid(9), name: "x\ud800", color: "#123456" } })).status).toBe(422);
    expect(snapshot()).toEqual(before);
  });

  it("limits a category to 1,000 active targeting rules so its archive review stays complete", async () => {
    withWriteTransaction(api.db, () => {
      for (let n = 1; n <= 1000; n++) createRule(context(), { id: rule(n), matchType: "contains", pattern: `p${n}`, categoryId: FOOD });
    });
    expect((await create(1001, { categoryId: HOME })).status).toBe(201);
    const before = snapshot();
    expect((await create(1002)).body).toMatchObject({ code: "validation_failed" });
    expect((await patch(1001, 1, { categoryId: FOOD })).body).toMatchObject({ code: "validation_failed" });
    const retarget = await api.request(`/api/categories/${HOME}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "1001", budgetPlanVersion: null,
        ruleResolutions: [{ ruleId: rule(1001), action: "retarget", targetCategoryId: FOOD }] } });
    expect(retarget.body).toMatchObject({ code: "validation_failed" });
    expect(snapshot()).toEqual(before);
    const impact = await api.request(`/api/categories/${FOOD}/archive-impact`);
    expect(impact.status).toBe(200);
    expect((impact.body as { activeRules: unknown[] }).activeRules).toHaveLength(1000);
    // Archiving a targeting rule frees its place.
    expect((await archive(1, 1)).status).toBe(200);
    expect((await create(1002)).status).toBe(201);
  });

  it("adds up several retargets into one category against its 1,000-rule limit", async () => {
    const third = "abcdef00-0000-4000-8000-000000000003";
    expect((await api.request("/api/categories", { method: "POST", body: { id: third, name: "Third", color: "#123456" } })).status).toBe(201);
    withWriteTransaction(api.db, () => {
      for (let n = 1; n <= 999; n++) createRule(context(), { id: rule(n), matchType: "contains", pattern: `p${n}`, categoryId: HOME });
      for (const n of [1001, 1002]) createRule(context(), { id: rule(n), matchType: "contains", pattern: `p${n}`, categoryId: FOOD });
    });
    const archiveFood = (targets: string[]) => api.request(`/api/categories/${FOOD}/archive`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { ruleSetRevision: "1001", budgetPlanVersion: null,
        ruleResolutions: [1001, 1002].map((n, i) => ({ ruleId: rule(n), action: "retarget", targetCategoryId: targets[i] })) } });
    const before = snapshot();
    expect((await archiveFood([HOME, HOME.toUpperCase()])).body).toMatchObject({ code: "validation_failed" });
    expect(snapshot()).toEqual(before);
    expect((await archiveFood([HOME, third])).status).toBe(200);
  });

  it("accepts a complete 2,000-rule reorder and a 1,000-rule archive resolution; other bodies keep 64 KiB", async () => {
    withWriteTransaction(api.db, () => {
      for (let n = 1; n <= 1000; n++) createRule(context(), { id: rule(n), matchType: "contains", pattern: `p${n}`, categoryId: FOOD });
      for (let n = 1001; n <= 2000; n++) createRule(context(), { id: rule(n), matchType: "contains", pattern: `p${n}`, categoryId: HOME });
    });
    const ids = Array.from({ length: 2000 }, (_, i) => rule(2000 - i).toUpperCase());
    const reorder = await api.request("/api/rules/reorder", { method: "POST", body: { ruleSetRevision: "2000", orderedRuleIds: ids } });
    expect(reorder.status).toBe(200);
    expect((reorder.body as { items: { id: string }[] }).items[0]).toMatchObject({ id: rule(2000), position: 1 });
    const third = "abcdef00-0000-4000-8000-000000000003";
    expect((await api.request("/api/categories", { method: "POST", body: { id: third, name: "Third", color: "#123456" } })).status).toBe(201);
    const resolutions = Array.from({ length: 1000 }, (_, i) => ({ ruleId: rule(i + 1).toUpperCase(), action: "retarget", targetCategoryId: third.toUpperCase() }));
    const archived = await api.request(`/api/categories/${FOOD}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "2001", budgetPlanVersion: null, ruleResolutions: resolutions } });
    expect(archived.status).toBe(200);
    expect(JSON.stringify({ ruleResolutions: resolutions }).length).toBeGreaterThan(100 * 1024);
    expect((archived.body as { rulesChanged: unknown[] }).rulesChanged).toHaveLength(1000);
    const oversized = await api.request("/api/rules", { method: "POST", body: { id: rule(3000), ...base, pattern: "x".repeat(70 * 1024) } });
    expect(oversized.status).toBe(413);
    const tooLarge = await api.request("/api/rules/reorder", { method: "POST", body: { ruleSetRevision: "2002", orderedRuleIds: ids, padding: "x".repeat(260 * 1024) } });
    expect(tooLarge.status).toBe(413);
    // Other spellings Express routes the same way get the same bound; signed-out requests keep 64 KiB.
    const spelled = await api.request("/api/RULES/reorder/", { method: "POST", body: { ruleSetRevision: "2002", orderedRuleIds: ids } });
    expect(spelled.status).toBe(200);
    const signedOut = await api.request("/api/rules/reorder", { method: "POST", omitCookie: true, body: { ruleSetRevision: "2002", orderedRuleIds: ids } });
    expect(signedOut.status).toBe(413);
  });

  it("refuses a second archive resolution that would overfill a rule's history, readably and without writes", async () => {
    const third = "abcdef00-0000-4000-8000-000000000003";
    expect((await create(1)).status).toBe(201);
    withWriteTransaction(api.db, () => {
      for (let n = 0; n < 997; n++) updateRule(context(), requireRule(api.db, rule(1)), { pattern: `p${n % 2}` });
    });
    expect((await api.request(`/api/categories/${FOOD}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "998", budgetPlanVersion: null,
        ruleResolutions: [{ ruleId: rule(1), action: "retarget", targetCategoryId: HOME }] } })).status).toBe(200);
    expect((await api.request("/api/categories", { method: "POST", body: { id: third, name: "Third", color: "#123456" } })).status).toBe(201);
    const before = snapshot();
    const refused = await api.request(`/api/categories/${HOME}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "999", budgetPlanVersion: null, ruleResolutions: [{ ruleId: rule(1), action: "disable", targetCategoryId: null }] } });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "validation_failed", title: "Rule history is full" });
    expect(snapshot()).toEqual(before);
    // Archiving the rule still fits, after which the category can be archived.
    expect((await archive(1, 999)).status).toBe(200);
    expect((await api.request(`/api/categories/${HOME}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "1000", budgetPlanVersion: null, ruleResolutions: [] } })).status).toBe(200);
  });

  it("feeds future assignment in order without changing any existing transaction", async () => {
    const account = await createAccount(api);
    const existing = postTransaction(api.db, { accountId: account.id, postedDate: "2026-04-02", amountMinor: "-100",
      merchant: "SYNTHETIC MARKET 12" });
    const before = api.db.prepare("SELECT * FROM transactions").all();
    expect((await create(1, { pattern: "market", categoryId: HOME })).status).toBe(201);
    expect((await create(2, { pattern: "synthetic market" })).status).toBe(201);
    expect(api.db.prepare("SELECT * FROM transactions").all()).toEqual(before);
    const assign = () => assignByRules(api.db, { accountId: account.id, kind: "purchase", merchantText: "Synthetic Market 12" });
    expect(assign()).toMatchObject({ origin: "rule", ruleId: rule(1), categoryId: HOME });
    expect((await api.request("/api/rules/reorder", { method: "POST", body: { ruleSetRevision: "2", orderedRuleIds: [rule(2), rule(1)] } })).status).toBe(200);
    expect(assign()).toMatchObject({ origin: "rule", ruleId: rule(2), categoryId: FOOD, ruleRevision: 1n });
    expect((await archive(2, 2)).status).toBe(200);
    expect(assign()).toMatchObject({ ruleId: rule(1) });
    expect((await patch(1, 3, { enabled: false })).status).toBe(200);
    expect(assign()).toMatchObject({ origin: "unassigned", categoryId: UNCATEGORIZED });
    expect(api.db.prepare("SELECT * FROM transactions").all()).toEqual(before);
    expect(existing).toBeTypeOf("string");
  });

  it("counts current assignments across retained revisions, excluding void and manual rows", async () => {
    const account = await createAccount(api);
    expect((await create(1)).status).toBe(201);
    expect((await patch(1, 1, { pattern: "Edited" })).status).toBe(200);
    const attribute = (revision: number, lifecycle: "active" | "void" = "active") => {
      const id = postTransaction(api.db, { accountId: account.id, postedDate: "2026-04-02", amountMinor: "-100", lifecycle });
      api.db.prepare(`UPDATE transactions SET assignment_origin = 'rule', rule_id = ?, rule_revision = ?, category_id = ?
        WHERE id = ?`).run(rule(1), revision, FOOD, id);
    };
    attribute(1); attribute(2); attribute(2, "void");
    postTransaction(api.db, { accountId: account.id, postedDate: "2026-04-02", amountMinor: "-100", categoryId: FOOD, origin: "manual" });
    expect((await api.request(`/api/rules/${rule(1)}`)).body).toMatchObject({ currentAssignmentCount: 2 });
    expect((await list()).items[0]).toMatchObject({ currentAssignmentCount: 2 });
    expect((await archive(1, 2)).body).toMatchObject({ rule: { currentAssignmentCount: 2 } });
  });

  it("blocks deleting an account referenced by a rule scope, even after the scope changes", async () => {
    const account = await createAccount(api);
    expect((await create(1, { accountId: account.id })).status).toBe(201);
    expect((await patch(1, 1, { accountId: null })).status).toBe(200);
    const response = await api.request(`/api/accounts/${account.id}`, { method: "DELETE", headers: { "if-match": account.etag } });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "account_in_use", blocking: [{ kind: "rule", ids: [rule(1)] }] });
  });

  it("keeps the complete list within 2,000 rules and allows replay at capacity", async () => {
    withWriteTransaction(api.db, () => {
      for (let n = 1; n < 2000; n++) {
        createRule(context(), { id: rule(n), matchType: "contains", pattern: `p${n}`, categoryId: n <= 1000 ? FOOD : HOME });
      }
    });
    expect((await create(2000, { pattern: "last", categoryId: HOME })).status).toBe(201);
    const before = snapshot();
    expect((await create(2001, { pattern: "extra", categoryId: HOME })).body).toMatchObject({ title: "Rule limit reached" });
    expect((await create(2000, { pattern: "last", categoryId: HOME })).status).toBe(200);
    expect(snapshot()).toEqual(before);
    for (const environment of ["test", "production"] as const) {
      api.deps.config.environment = environment;
      for (const status of ["active", "all"]) expect((await list(status)).items).toHaveLength(2000);
    }
  });

  it("keeps room in the 1,000-revision history for disable, retarget and archive", async () => {
    expect((await create(1)).status).toBe(201);
    withWriteTransaction(api.db, () => {
      for (let n = 0; n < 997; n++) updateRule(context(), requireRule(api.db, rule(1)), { pattern: `p${n % 2}` });
    });
    expect(requireRule(api.db, rule(1)).revision).toBe(998n);
    expect((await patch(1, 998, { pattern: "one more" })).status).toBe(422);
    const archived = await api.request(`/api/categories/${FOOD}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "998", budgetPlanVersion: null, ruleResolutions: [{ ruleId: rule(1), action: "disable", targetCategoryId: null }] } });
    expect(archived.status).toBe(200);
    expect((await archive(1, 999)).status).toBe(200);
    const revisions = await history(1);
    expect(revisions).toHaveLength(1000);
    expect(revisions[0]).toMatchObject({ revision: "1000", change: "archived" });
  });

  it("rolls back everything when a later write fails and checks responses before committing", async () => {
    expect((await create(1)).status).toBe(201);
    const before = snapshot();
    api.db.exec("CREATE TRIGGER fail_rule_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect((await create(2)).status).toBe(500);
    expect((await patch(1, 1, { enabled: false })).status).toBe(500);
    expect((await archive(1, 1)).status).toBe(500);
    expect(snapshot()).toEqual(before);
    api.db.exec("DROP TRIGGER fail_rule_audit");
    api.deps.config.environment = "production";
    // A year-10000 timestamp cannot be expressed in the contract's timestamp form.
    api.db.exec(`CREATE TRIGGER invalidate_rule_result AFTER UPDATE OF revision ON rules BEGIN
      UPDATE rules SET created_at = 253402300800000 WHERE id = NEW.id; END`);
    const snap = snapshot();
    expect((await patch(1, 1, { enabled: false })).status).toBe(500);
    expect(snapshot()).toEqual(snap);
  });
});
