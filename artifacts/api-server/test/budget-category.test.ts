import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, uuid } from "./finance-harness.js";
import { easternDate } from "../src/domain/dates.js";
import { resolveBudget, type BudgetConfiguration } from "../src/domain/budgets.js";
import { budgetConfiguration, budgetPlanDto, writeBudgetConfiguration } from "../src/services/budget-plans.js";
import { requireCategory } from "../src/services/categories.js";

let api: TestServer;
const CATEGORY = uuid(30, "30000000");
const context = () => ({ db: api.db, now: api.clock.now(), today: easternDate(api.clock.now()), newId: api.deps.newId });
const seed = (plan: BudgetConfiguration) => withWriteTransaction(api.db, () => writeBudgetConfiguration(context(), CATEGORY, plan));
const impact = () => api.request(`/api/categories/${CATEGORY}/archive-impact`);
const archive = (categoryVersion = "1", planVersion: string | null = "1", extra = {}) =>
  api.request(`/api/categories/${CATEGORY}/archive`, { method: "POST", headers: { "if-match": `"${categoryVersion}"` },
    body: { budgetPlanVersion: planVersion, ruleSetRevision: "0", ruleResolutions: [], ...extra } });
const reactivate = (version: string) => api.request(`/api/categories/${CATEGORY}/reactivate`, {
  method: "POST", headers: { "if-match": `"${version}"` },
});
const dto = () => budgetPlanDto(api.db, requireCategory(api.db, CATEGORY));
const effective = (month: string) => {
  const category = requireCategory(api.db, CATEGORY);
  return resolveBudget(budgetConfiguration(api.db, CATEGORY), month, {
    archived: category.archived_at !== null, cutoffMonth: category.archive_cutoff_month,
  });
};
const snapshot = () => Object.fromEntries([
  "budget_plans", "budget_schedule", "budget_exceptions", "budget_previews", "categories", "rules", "rule_revisions",
  "accounts", "transactions", "audit_events", "ledger_metadata",
].map(table => [table, api.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
beforeEach(async () => {
  api = await startTestServer(); await api.login();
  expect((await api.request("/api/categories", { method: "POST", body: { id: CATEGORY, name: "Food", color: "#112233" } })).status).toBe(201);
});
afterEach(async () => { await api.close(); });

function populated() {
  seed({ regular: [
    { month: "2026-01", state: "amount", amount: 10000n },
    { month: "2026-07", state: "amount", amount: 20000n },
    { month: "2029-01", state: "stopped", amount: null },
  ], monthly: [
    { month: "2026-04", state: "amount", amount: 7000n },
    { month: "2026-05", state: "amount", amount: 0n },
    { month: "2026-06", state: "skip", amount: null },
    { month: "2028-03", state: "amount", amount: 900n },
  ] });
}

describe("categories with real budget persistence", () => {
  it("reports zero and every removed entry; archives atomically without altering ledger or current/past limits", async () => {
    populated();
    const account = await createAccount(api);
    postTransaction(api.db, { accountId: account.id, categoryId: CATEGORY, origin: "manual", postedDate: "2026-04-02", amountMinor: "-100" });
    const before = snapshot();
    const review = await impact();
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ budget: { planVersion: "1", cutoffMonth: "2026-06", currentMonthLimit: { currency: "USD", amountMinor: "0" },
      removedEntries: [
        { entryType: "monthly", month: "2026-06", state: "skip", amount: null },
        { entryType: "regular", month: "2026-07", state: "amount", amount: { currency: "USD", amountMinor: "20000" } },
        { entryType: "monthly", month: "2028-03", state: "amount", amount: { currency: "USD", amountMinor: "900" } },
        { entryType: "regular", month: "2029-01", state: "stopped", amount: null },
      ] } });
    expect(snapshot()).toEqual(before);
    const result = await archive();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ budgetPlan: { categoryId: CATEGORY, version: "2", archiveCutoffMonth: "2026-06",
      regularSchedule: [
        { effectiveMonth: "2026-01", state: "amount", amount: { currency: "USD", amountMinor: "10000" } },
        { effectiveMonth: "2026-06", state: "stopped", amount: null },
      ], monthlyEntries: [
        { month: "2026-04", state: "amount", amount: { currency: "USD", amountMinor: "7000" } },
        { month: "2026-05", state: "amount", amount: { currency: "USD", amountMinor: "0" } },
      ] } });
    expect(effective("2026-04").amount).toBe(7000n);
    expect(effective("2026-05").amount).toBe(0n);
    expect(effective("2026-06").state).toBe("absent");
    for (const table of ["accounts", "transactions"]) expect(snapshot()[table]).toEqual(before[table]);
    const audit = api.db.prepare("SELECT before_json, after_json FROM audit_events WHERE entity_type = 'budget'").get() as { before_json: string; after_json: string };
    expect(JSON.parse(audit.before_json).regularSchedule).toHaveLength(3);
    expect(JSON.parse(audit.after_json).removedEntries).toHaveLength(4);
    const archived = snapshot();
    expect((await archive("2", "2")).status).toBe(200);
    expect(snapshot()).toEqual(archived);
    expect((await reactivate("2")).status).toBe(200);
    expect(dto().archiveCutoffMonth).toBeNull();
    expect(effective("2028-03").state).toBe("absent");
    expect(effective("2026-05").amount).toBe(0n);
    await api.restart();
    expect(effective("2028-03").state).toBe("absent");
  });

  it.each([null, "2"])("stales archive with submitted plan version %s", async version => {
    populated(); const before = snapshot();
    const response = await archive("1", version);
    expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: "preview_stale" });
    expect(snapshot()).toEqual(before);
  });

  it("does not create a plan for a preview-only category, and blocks deletion before and after restart", async () => {
    const now = api.clock.now();
    api.db.prepare(`INSERT INTO budget_previews (id, category_id, preview_json, dependencies_json, created_at, expires_at)
      VALUES (?, ?, '{}', '{}', ?, ?)`).run(uuid(90), CATEGORY, now, now + 86400000);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(dto().version).toBeNull();
      const response = await api.request(`/api/categories/${CATEGORY}`, { method: "DELETE", headers: { "if-match": '"1"' } });
      expect(response.status).toBe(409); expect(response.body).toMatchObject({ code: "category_in_use" });
      if (attempt === 0) await api.restart();
    }
    expect((await archive("1", null)).body).toMatchObject({ budgetPlan: null });
    expect(dto().version).toBeNull();
  });

  it.each(["monthly-only", "stopped"])("archives a %s plan without inventing an amount", async kind => {
    seed({ regular: kind === "stopped" ? [{ month: "2026-03", state: "stopped", amount: null }] : [],
      monthly: [{ month: "2026-05", state: "amount", amount: 0n }, { month: "2026-08", state: "amount", amount: 300n }] });
    expect((await archive()).status).toBe(200);
    expect(dto().regularSchedule).toEqual([{ effectiveMonth: kind === "stopped" ? "2026-03" : "2026-06", state: "stopped", amount: null }]);
    expect((await reactivate("2")).status).toBe(200);
    expect(effective("2026-08").state).toBe("absent");
    expect((await api.request(`/api/categories/${CATEGORY}`, { method: "DELETE", headers: { "if-match": '"3"' } })).body)
      .toMatchObject({ code: "category_in_use" });
  });

  it.each(["schedule", "audit", "response"])("rolls back rules, budget and category after injected %s failure", async failure => {
    populated();
    const ruleId = uuid(77);
    expect((await api.request("/api/rules", { method: "POST", body: { id: ruleId, matchType: "contains", pattern: "Synthetic", categoryId: CATEGORY } })).status).toBe(201);
    const before = snapshot();
    if (failure === "schedule") api.db.exec(`CREATE TRIGGER fail_budget BEFORE INSERT ON budget_schedule
      BEGIN SELECT RAISE(ABORT, 'injected schedule failure'); END`);
    if (failure === "audit") api.db.exec(`CREATE TRIGGER fail_budget BEFORE INSERT ON audit_events WHEN NEW.event_type = 'category_archived'
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`);
    if (failure === "response") {
      api.deps.config.environment = "production";
      api.db.exec(`CREATE TRIGGER fail_budget AFTER UPDATE OF archived_at ON categories BEGIN
        UPDATE categories SET display_name = char(9) WHERE id = NEW.id; END`);
    }
    expect((await archive("1", "1", { ruleSetRevision: "1", ruleResolutions: [{ ruleId, action: "disable", targetCategoryId: null }] })).status).toBe(500);
    expect(snapshot()).toEqual(before);
  });

  it("refuses plan-version overflow without a partial archive", async () => {
    populated(); api.db.exec("UPDATE budget_plans SET version = 999999999999999999");
    const before = snapshot();
    expect((await archive("1", "999999999999999999")).status).toBe(500);
    expect(snapshot()).toEqual(before);
  });

  it("keeps repeated archive/reactivate cycles within capacity across different months", async () => {
    seed({ regular: [], monthly: Array.from({ length: 999 }, (_, i) => ({
      month: `${1900 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`, state: "amount" as const, amount: 1n,
    })) });
    for (let cycle = 0; cycle < 3; cycle++) {
      api.clock.set(Date.UTC(2026, 4 + cycle, 2, 12)); await api.login();
      const categoryVersion = String(cycle * 2 + 1);
      // Only the first archive changes the budget; later cycles find it
      // already stopped, so the plan version stays where that first stop left it.
      expect((await archive(categoryVersion, cycle === 0 ? "1" : "2")).status).toBe(200);
      expect(dto().regularSchedule).toEqual([{ effectiveMonth: "2026-06", state: "stopped", amount: null }]);
      expect(dto().monthlyEntries).toHaveLength(999);
      expect((await reactivate(String(cycle * 2 + 2))).status).toBe(200);
      expect(effective("2027-01").state).toBe("absent");
    }
    const before = snapshot();
    expect(() => seed({ ...budgetConfiguration(api.db, CATEGORY), regular: [{ month: "2026-08", state: "amount", amount: 1n }] })).toThrow(/1,000/);
    expect(snapshot()).toEqual(before);
  });

  it("uses the Eastern month across UTC midnight and year rollover", async () => {
    seed({ regular: [{ month: "2026-01", state: "amount", amount: 50n }], monthly: [] });
    api.clock.set(Date.UTC(2027, 0, 1, 4, 59, 59)); await api.login();
    expect((await impact()).body).toMatchObject({ budget: { cutoffMonth: "2027-01" } });
    api.clock.set(Date.UTC(2027, 0, 1, 5));
    expect((await impact()).body).toMatchObject({ budget: { cutoffMonth: "2027-02" } });
    expect((await archive()).status).toBe(200);
    expect(effective("2027-01").amount).toBe(50n);
    expect(effective("2027-02").state).toBe("absent");
  });
});
