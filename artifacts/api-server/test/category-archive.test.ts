import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, INCOME_CATEGORY, postTransaction, UNCATEGORIZED, uuid } from "./finance-harness.js";
import { assignByRules } from "../src/services/assignment.js";

let api: TestServer;
const FOOD = "abcdef00-0000-4000-8000-000000000001";
const HOME = "abcdef00-0000-4000-8000-000000000002";
const SPARE = "abcdef00-0000-4000-8000-000000000003";
const rule = (n: number) => uuid(n, "60000000");

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  for (const [id, name] of [[FOOD, "Food"], [HOME, "Home"], [SPARE, "Spare"]]) {
    expect((await api.request("/api/categories", { method: "POST", body: { id, name, color: "#123456" } })).status).toBe(201);
  }
});
afterEach(async () => { await api.close(); });

const createRule = (n: number, body: Record<string, unknown> = {}) =>
  api.request("/api/rules", { method: "POST", body: { id: rule(n), matchType: "contains", pattern: `p${n}`, categoryId: FOOD, ...body } });
const impact = (id = FOOD) => api.request(`/api/categories/${id}/archive-impact`);
const archive = (body: Record<string, unknown>, version = 1, id = FOOD) =>
  api.request(`/api/categories/${id}/archive`, { method: "POST", headers: { "if-match": `"${version}"` },
    body: { ruleSetRevision: "0", budgetPlanVersion: null, ruleResolutions: [], ...body } });
const disable = (n: number) => ({ ruleId: rule(n), action: "disable", targetCategoryId: null });
const retarget = (n: number, target: string) => ({ ruleId: rule(n), action: "retarget", targetCategoryId: target });
const snapshot = () => ({
  rules: api.db.prepare("SELECT * FROM rules ORDER BY id").all(),
  revisions: api.db.prepare("SELECT * FROM rule_revisions ORDER BY rule_id, revision").all(),
  categories: api.db.prepare("SELECT * FROM categories ORDER BY id").all(),
  transactions: api.db.prepare("SELECT * FROM transactions ORDER BY id").all(),
  audit: api.db.prepare("SELECT * FROM audit_events ORDER BY id").all(),
  metadata: api.db.prepare("SELECT * FROM ledger_metadata").get(),
});

/** Rules 1 and 3 (enabled) and 2 (disabled) target Food; rule 4 targets Home. */
async function setup(): Promise<void> {
  for (const n of [1, 2, 3]) expect((await createRule(n)).status).toBe(201);
  expect((await createRule(4, { categoryId: HOME })).status).toBe(201);
  expect((await api.request(`/api/rules/${rule(2)}`, { method: "PATCH", headers: { "if-match": '"1"' },
    body: { enabled: false } })).status).toBe(200);
}

describe("category archive", () => {
  it("reports active targeting rules and the truthful no-budget impact", async () => {
    await setup();
    const response = await impact(FOOD.toUpperCase());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body).toEqual({
      categoryId: FOOD, categoryVersion: "1", ruleSetRevision: "5",
      activeRules: [
        { ruleId: rule(1), position: 1, matchType: "contains", pattern: "p1", enabled: true, version: "1" },
        { ruleId: rule(2), position: 2, matchType: "contains", pattern: "p2", enabled: false, version: "2" },
        { ruleId: rule(3), position: 3, matchType: "contains", pattern: "p3", enabled: true, version: "1" },
      ],
      // The test clock is May 2, 2026 Eastern; this category has no plan.
      budget: { planVersion: null, cutoffMonth: "2026-06", currentMonthLimit: null, removedEntries: [] },
    });
    for (const id of [INCOME_CATEGORY, UNCATEGORIZED]) {
      expect((await impact(id)).body).toMatchObject({ code: "category_protected" });
    }
    expect((await impact(uuid(404))).status).toBe(404);
  });

  it("disables and retargets enabled rules and archives the category in one change", async () => {
    await setup();
    const response = await archive({ ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, HOME.toUpperCase())] });
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"2"');
    expect(response.body).toMatchObject({
      category: { id: FOOD, status: "archived", version: "2" },
      rulesChanged: [
        { id: rule(1), enabled: false, categoryId: FOOD, revision: "2", version: "2" },
        { id: rule(3), enabled: true, categoryId: HOME, revision: "2", version: "2" },
      ],
      ruleSetRevision: "6", budgetPlan: null,
    });
    expect(api.db.prepare("SELECT archive_cutoff_month FROM categories WHERE id = ?").get(FOOD))
      .toEqual({ archive_cutoff_month: "2026-06" });
    const history = (await api.request(`/api/rules/${rule(3)}/history`)).body as { revisions: unknown[] };
    expect(history.revisions).toMatchObject([
      { change: "retargeted", categoryId: HOME, categoryNameAtRevision: "Home" },
      { change: "created", categoryId: FOOD, categoryNameAtRevision: "Food" },
    ]);
    // The disabled rule keeps its retained target and needs nothing.
    expect((await api.request(`/api/rules/${rule(2)}`)).body).toMatchObject({ categoryId: FOOD, enabled: false, version: "2" });
    const account = await createAccount(api);
    expect(assignByRules(api.db, { accountId: account.id, kind: "purchase", merchantText: "p3" }))
      .toMatchObject({ origin: "rule", ruleId: rule(3), categoryId: HOME });
    expect(assignByRules(api.db, { accountId: account.id, kind: "purchase", merchantText: "p1" }))
      .toMatchObject({ origin: "unassigned" });
  });

  it("does not advance the rule-set revision when no rule changes", async () => {
    expect((await createRule(1)).status).toBe(201);
    expect((await api.request(`/api/rules/${rule(1)}`, { method: "PATCH", headers: { "if-match": '"1"' },
      body: { enabled: false } })).status).toBe(200);
    const response = await archive({ ruleSetRevision: "2" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ rulesChanged: [], ruleSetRevision: "2" });
    // Repeating it with the current version changes nothing.
    const before = snapshot();
    const again = await archive({ ruleSetRevision: "2" }, 2);
    expect(again.status).toBe(200);
    expect(again.headers.get("etag")).toBe('"2"');
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ["stale rule set", { ruleSetRevision: "4", ruleResolutions: [disable(1), disable(3)] }, 409, "rule_set_changed"],
    ["a budget plan that does not exist", { ruleSetRevision: "5", budgetPlanVersion: "1", ruleResolutions: [disable(1), disable(3)] }, 409, "preview_stale"],
    ["a missing resolution", { ruleSetRevision: "5", ruleResolutions: [disable(1)] }, 422, "validation_failed"],
    ["a disabled rule", { ruleSetRevision: "5", ruleResolutions: [disable(1), disable(2), disable(3)] }, 422, "validation_failed"],
    ["another category's rule", { ruleSetRevision: "5", ruleResolutions: [disable(1), disable(3), disable(4)] }, 422, "validation_failed"],
    ["a duplicate", { ruleSetRevision: "5", ruleResolutions: [disable(1), disable(3), { ...disable(3), ruleId: rule(3).toUpperCase() }] }, 422, "validation_failed"],
    ["retarget without a category", { ruleSetRevision: "5", ruleResolutions: [disable(1), { ruleId: rule(3), action: "retarget", targetCategoryId: null }] }, 422, "validation_failed"],
    ["disable naming a category", { ruleSetRevision: "5", ruleResolutions: [disable(1), { ...disable(3), targetCategoryId: HOME }] }, 422, "validation_failed"],
    ["retarget to itself", { ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, FOOD)] }, 422, "rule_target_ineligible"],
    ["retarget to Income", { ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, INCOME_CATEGORY)] }, 422, "rule_target_ineligible"],
    ["retarget to Uncategorized", { ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, UNCATEGORIZED)] }, 422, "rule_target_ineligible"],
    ["retarget to a missing category", { ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, uuid(404))] }, 422, "rule_target_ineligible"],
    ["unknown fields", { ruleSetRevision: "5", extra: true }, 422, "validation_failed"],
  ])("refuses %s without any change", async (_label, body, status, code) => {
    await setup();
    const before = snapshot();
    const response = await archive(body);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
    expect(snapshot()).toEqual(before);
  });

  it("refuses retargeting to an archived category and protected or stale requests", async () => {
    await setup();
    expect((await archive({ ruleSetRevision: "5" }, 1, SPARE)).status).toBe(200);
    const before = snapshot();
    expect((await archive({ ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, SPARE)] })).body)
      .toMatchObject({ code: "category_archived" });
    for (const id of [INCOME_CATEGORY, UNCATEGORIZED]) {
      expect((await archive({ ruleSetRevision: "5" }, 1, id)).body).toMatchObject({ code: "category_protected" });
    }
    for (const [headers, status] of [[{}, 428], [{ "if-match": "1" }, 400], [{ "if-match": '"2"' }, 412]] as const) {
      expect((await api.request(`/api/categories/${FOOD}/archive`, { method: "POST", headers,
        body: { ruleSetRevision: "5", budgetPlanVersion: null, ruleResolutions: [disable(1), disable(3)] } })).status).toBe(status);
    }
    expect((await api.request(`/api/categories/${FOOD}/archive`, { method: "POST", headers: { "if-match": '"1"' }, csrfToken: null,
      body: { ruleSetRevision: "5", budgetPlanVersion: null, ruleResolutions: [disable(1), disable(3)] } })).status).toBe(403);
    expect(snapshot()).toEqual(before);
  });

  it("rolls back rule changes and the archive together when a later write fails", async () => {
    await setup();
    const before = snapshot();
    api.db.exec(`CREATE TRIGGER fail_category_archive BEFORE INSERT ON audit_events WHEN NEW.event_type = 'category_archived'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect((await archive({ ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, HOME)] })).status).toBe(500);
    expect(snapshot()).toEqual(before);
    api.db.exec("DROP TRIGGER fail_category_archive");
    api.deps.config.environment = "production";
    api.db.exec(`CREATE TRIGGER invalidate_archive_result AFTER UPDATE OF archived_at ON categories BEGIN
      UPDATE categories SET display_name = char(9) WHERE id = NEW.id; END`);
    expect((await archive({ ruleSetRevision: "5", ruleResolutions: [disable(1), retarget(3, HOME)] })).status).toBe(500);
    expect(snapshot()).toEqual(before);
  });

  it("reactivation restores eligibility without enabling rules; new rules can target it again", async () => {
    await setup();
    expect((await archive({ ruleSetRevision: "5", ruleResolutions: [disable(1), disable(3)] })).status).toBe(200);
    const account = await createAccount(api);
    postTransaction(api.db, { accountId: account.id, postedDate: "2026-04-02", amountMinor: "-100", categoryId: FOOD, origin: "manual" });
    const reactivated = await api.request(`/api/categories/${FOOD}/reactivate`, { method: "POST", headers: { "if-match": '"2"' } });
    expect(reactivated.status).toBe(200);
    for (const n of [1, 2, 3]) expect((await api.request(`/api/rules/${rule(n)}`)).body).toMatchObject({ enabled: false });
    expect(assignByRules(api.db, { accountId: account.id, kind: "purchase", merchantText: "p1" })).toMatchObject({ origin: "unassigned" });
    expect((await api.request(`/api/rules/${rule(1)}`, { method: "PATCH", headers: { "if-match": '"2"' },
      body: { enabled: true } })).status).toBe(200);
    expect((await createRule(9)).status).toBe(201);
    expect(assignByRules(api.db, { accountId: account.id, kind: "purchase", merchantText: "p1" })).toMatchObject({ ruleId: rule(1) });
    // The category keeps its references, so it still cannot be deleted.
    expect((await api.request(`/api/categories/${FOOD}`, { method: "DELETE", headers: { "if-match": '"3"' } })).status).toBe(409);
  });
});
