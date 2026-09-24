/**
 * The four budget operations over real HTTP.
 *
 * Every budget here is created the way an owner would create one - preview,
 * review, apply - rather than by seeding configuration directly, so these are
 * claims about the running service and not about a storage helper.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";

import { startTestServer, type TestResponse, type TestServer } from "./harness.js";
import { createAccount, postThroughService, postTransaction, uuid, INCOME_CATEGORY, UNCATEGORIZED } from "./finance-harness.js";
import { easternDate } from "../src/domain/dates.js";
import { applyBudgetChange } from "../src/services/budget-changes.js";
import { requireCategory } from "../src/services/categories.js";
import { financeRevision } from "../src/services/ledger.js";

let api: TestServer;
let accountId: string;
const GROCERIES = uuid(10, "30000000");
const DINING = uuid(11, "30000000");

const context = () => ({ db: api.db, now: api.clock.now(), today: easternDate(api.clock.now()), newId: api.deps.newId });
const category = (id: string, name: string) =>
  api.request("/api/categories", { method: "POST", body: { id, name, color: "#112233" } });
const plan = (id = GROCERIES) => api.request(`/api/budget-plans/${id}`);
const budgets = (month: string) => api.request(`/api/budgets?month=${month}`);
const preview = (body: unknown, id = GROCERIES) =>
  api.request(`/api/budget-plans/${id}/preview-change`, { method: "POST", body });
const apply = (previewId: string, id = GROCERIES) =>
  api.request(`/api/budget-plans/${id}/apply-change`, { method: "POST", body: { previewId } });
const previewId = (response: TestResponse) => (response.body as { id: string }).id;
const usd = (amountMinor: string) => ({ amountMinor, currency: "USD" as const });
const spend = (input: { categoryId: string; postedDate: string; amountMinor: string; kind?: "purchase" | "refund" }) =>
  postThroughService(api, { accountId, postedDate: input.postedDate, merchant: "SYNTHETIC SHOP",
    kind: input.kind ?? "purchase", money: usd(input.amountMinor),
    category: { mode: "category", categoryId: input.categoryId } });
/** The owner's session idles out in 30 minutes, so a test that moves the clock signs in again. */
const signInAgain = async () => { api.clearThrottles(); expect((await api.login()).status).toBe(200); };
const snapshot = () => Object.fromEntries([
  "budget_plans", "budget_schedule", "budget_exceptions", "categories", "transactions", "accounts",
  "audit_events", "ledger_metadata",
].map(table => [table, api.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));

/** Creates a budget the owner's way: preview it, then apply exactly that review. */
async function setBudget(body: unknown, id = GROCERIES): Promise<TestResponse> {
  const review = await preview(body, id);
  expect(review.status).toBe(201);
  return apply(previewId(review), id);
}

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  accountId = (await createAccount(api, { trackingStartDate: "2026-01-01", openingMinor: "500000" })).id;
  expect((await category(GROCERIES, "Groceries")).status).toBe(201);
  expect((await category(DINING, "Dining")).status).toBe(201);
});
afterEach(async () => { await api.close(); });

describe("budget plans over HTTP", () => {
  it("returns an empty plan with no version and no ETag until a change is applied", async () => {
    const empty = await plan();
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ categoryId: GROCERIES, version: null, regularSchedule: [],
      monthlyEntries: [], archiveCutoffMonth: null });
    expect(empty.headers.get("etag")).toBeNull();
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM budget_plans").get()).toEqual({ n: 0n });

    expect((await setBudget({ change: "set_regular", fromMonth: "2026-05", amount: usd("10000") })).status).toBe(200);
    const created = await plan();
    expect(created.headers.get("etag")).toBe('"1"');
    expect(created.body).toMatchObject({ version: "1",
      regularSchedule: [{ effectiveMonth: "2026-05", state: "amount", amount: usd("10000") }] });
  });

  it("lists every entry in calendar order and refuses unknown categories and anonymous readers", async () => {
    await setBudget({ change: "set_regular", fromMonth: "2026-07", amount: usd("20000") });
    await setBudget({ change: "set_regular", fromMonth: "2026-05", amount: usd("10000") });
    await setBudget({ change: "set_month", month: "2026-02", amount: usd("3000") });
    await setBudget({ change: "skip_month", month: "2026-06" });
    expect((await plan()).body).toMatchObject({ version: "4",
      regularSchedule: [
        { effectiveMonth: "2026-05", state: "amount", amount: usd("10000") },
        { effectiveMonth: "2026-07", state: "amount", amount: usd("20000") },
      ],
      monthlyEntries: [
        { month: "2026-02", state: "amount", amount: usd("3000") },
        { month: "2026-06", state: "skip", amount: null },
      ] });
    expect((await plan(uuid(99, "30000000"))).status).toBe(404);
    expect((await plan("not-a-uuid")).status).toBe(404);
    api.cookie = undefined;
    expect((await plan()).status).toBe(401);
  });
});

describe("one month of budgets", () => {
  it("counts purchases minus refunds in the month they posted, and nowhere else", async () => {
    await setBudget({ change: "set_month", month: "2026-03", amount: usd("10000") });
    await setBudget({ change: "set_month", month: "2026-04", amount: usd("10000") });
    spend({ categoryId: GROCERIES, postedDate: "2026-03-08", amountMinor: "-10000" });
    spend({ categoryId: GROCERIES, postedDate: "2026-04-03", amountMinor: "3000", kind: "refund" });

    const march = await budgets("2026-03");
    expect(march.status).toBe(200);
    expect(march.headers.get("cache-control")).toBe("no-store");
    expect(march.body).toMatchObject({ month: "2026-03", items: [{ categoryId: GROCERIES, limit: usd("10000"),
      source: "monthly", purchases: usd("10000"), refunds: usd("0"), net: usd("10000"),
      remaining: usd("0"), percentUsed: 100, planVersion: "2" }],
      totals: { limit: usd("10000"), net: usd("10000"), remaining: usd("0"), percentUsed: 100 },
      unbudgetedNet: usd("0"), uncategorizedNet: usd("0") });
    expect((await budgets("2026-04")).body).toMatchObject({ items: [{ purchases: usd("0"), refunds: usd("3000"),
      net: usd("-3000"), remaining: usd("13000"), percentUsed: -30 }],
      totals: { net: usd("-3000"), remaining: usd("13000"), percentUsed: -30 } });
  });

  it("reports budgeted, unbudgeted and Uncategorized spending separately and agrees with the month summary", async () => {
    await setBudget({ change: "set_month", month: "2026-03", amount: usd("10000") });
    spend({ categoryId: GROCERIES, postedDate: "2026-03-08", amountMinor: "-9000" });
    spend({ categoryId: DINING, postedDate: "2026-03-09", amountMinor: "-2500" });
    spend({ categoryId: UNCATEGORIZED, postedDate: "2026-03-10", amountMinor: "-8000" });
    postThroughService(api, { accountId, postedDate: "2026-03-11", merchant: "SYNTHETIC PAY",
      kind: "income", money: usd("300000") });

    const month = await budgets("2026-03");
    expect(month.body).toMatchObject({ items: [{ categoryId: GROCERIES, net: usd("9000"), percentUsed: 90 }],
      totals: { limit: usd("10000"), net: usd("9000"), remaining: usd("1000"), percentUsed: 90 },
      unbudgetedNet: usd("2500"), uncategorizedNet: usd("8000") });
    const summary = await api.request("/api/summary?month=2026-03");
    const body = month.body as { totals: { net: { amountMinor: string } };
      unbudgetedNet: { amountMinor: string }; uncategorizedNet: { amountMinor: string } };
    const combined = BigInt(body.totals.net.amountMinor) + BigInt(body.unbudgetedNet.amountMinor) +
      BigInt(body.uncategorizedNet.amountMinor);
    expect(String(combined)).toBe((summary.body as { spending: { net: { amountMinor: string } } }).spending.net.amountMinor);
  });

  it("keeps a zero limit as a line, reports no budgets as an empty month, and refuses a missing month", async () => {
    expect((await budgets("2026-05")).body).toMatchObject({ month: "2026-05", items: [],
      totals: { limit: usd("0"), net: usd("0"), remaining: usd("0"), percentUsed: null },
      unbudgetedNet: usd("0"), uncategorizedNet: usd("0") });
    await setBudget({ change: "set_month", month: "2026-05", amount: usd("0") });
    spend({ categoryId: GROCERIES, postedDate: "2026-05-01", amountMinor: "-1300" });
    expect((await budgets("2026-05")).body).toMatchObject({ items: [{ limit: usd("0"), net: usd("1300"),
      remaining: usd("-1300"), percentUsed: null }], totals: { percentUsed: null } });
    // A skipped month is no limit at all, so its spending is unbudgeted.
    await setBudget({ change: "skip_month", month: "2026-05" });
    expect((await budgets("2026-05")).body).toMatchObject({ items: [], unbudgetedNet: usd("1300") });
    for (const month of ["", "?month=2026-13", "?month=notamonth"]) {
      expect((await api.request(`/api/budgets${month}`)).status).toBe(400);
    }
  });

  it("keeps spending on archived accounts and excludes voided rows, transfers and income", async () => {
    await setBudget({ change: "set_month", month: "2026-03", amount: usd("10000") });
    const voided = spend({ categoryId: GROCERIES, postedDate: "2026-03-02", amountMinor: "-4000" });
    spend({ categoryId: GROCERIES, postedDate: "2026-03-03", amountMinor: "-2000" });
    postThroughService(api, { accountId, postedDate: "2026-03-04", merchant: "SYNTHETIC MOVE",
      kind: "transfer", money: usd("-5000") });
    const review = await api.request(`/api/transactions/${voided.id}/repair-previews`, {
      method: "POST", body: { action: "void", reason: "duplicate charge" } });
    expect(review.status).toBe(201);
    expect((await api.request(`/api/transaction-repairs/${previewId(review)}/apply`, { method: "POST", body: { confirmUnlinking: true } })).status).toBe(200);
    // Income cannot carry a budgeted category and a transfer cannot carry any
    // category, so a budget line can never be fed by either.
    expect(() => postTransaction(api.db, { accountId, categoryId: GROCERIES, kind: "income", origin: "system",
      postedDate: "2026-03-05", amountMinor: "70000" })).toThrow(/CHECK constraint/);
    expect(() => postTransaction(api.db, { accountId, categoryId: GROCERIES, kind: "transfer", origin: "system",
      postedDate: "2026-03-05", amountMinor: "-70000" })).toThrow(/CHECK constraint/);
    expect((await budgets("2026-03")).body).toMatchObject({ items: [{ net: usd("2000") }],
      unbudgetedNet: usd("0"), uncategorizedNet: usd("0") });
    expect((await api.request(`/api/accounts/${accountId}/archive`, { method: "POST",
      headers: { "if-match": '"1"' } })).status).toBe(200);
    expect((await budgets("2026-03")).body).toMatchObject({ items: [{ net: usd("2000") }] });
  });
});

describe("previewing a budget change", () => {
  it("shows twelve months and saves a review without creating a plan or touching the ledger", async () => {
    const before = snapshot();
    const revision = financeRevision(api.db);
    const review = await preview({ change: "set_regular", fromMonth: "2026-06", amount: usd("45000") });
    expect(review.status).toBe(201);
    expect(review.headers.get("cache-control")).toBe("no-store");
    expect(review.body).toMatchObject({ categoryId: GROCERIES, status: "ready", capturedPlanVersion: null,
      removedEntries: [], appliedAt: null,
      request: { change: "set_regular", fromMonth: "2026-06", amount: usd("45000") } });
    const body = review.body as { timeline: { month: string; before: unknown; after: unknown }[];
      createdAt: string; expiresAt: string };
    expect(body.timeline).toHaveLength(12);
    expect(body.timeline[0]).toEqual({ month: "2026-06", before: { state: "absent", amount: null, source: null },
      after: { state: "amount", amount: usd("45000"), source: "regular" } });
    expect(body.timeline[11]?.month).toBe("2027-05");
    expect(Date.parse(body.expiresAt) - Date.parse(body.createdAt)).toBe(86_400_000);
    expect(snapshot()).toEqual(before);
    expect(financeRevision(api.db)).toBe(revision);
    expect((await plan()).body).toMatchObject({ version: null, regularSchedule: [] });
    // The review itself survives a restart, exactly as it was shown.
    await api.restart();
    expect((await apply(previewId(review))).status).toBe(200);
  });

  it("keeps later scheduled changes and monthly entries, and lists every entry a stop removes", async () => {
    await setBudget({ change: "set_regular", fromMonth: "2026-05", amount: usd("10000") });
    await setBudget({ change: "set_regular", fromMonth: "2027-01", amount: usd("50000") });
    await setBudget({ change: "set_month", month: "2026-12", amount: usd("60000") });
    const regular = await preview({ change: "set_regular", fromMonth: "2026-10", amount: usd("45000") });
    const timeline = (regular.body as { timeline: { month: string; after: { amount: unknown } }[] }).timeline;
    expect(timeline.map(entry => entry.after.amount)).toEqual([
      usd("45000"), usd("45000"), usd("60000"), usd("50000"), usd("50000"), usd("50000"),
      usd("50000"), usd("50000"), usd("50000"), usd("50000"), usd("50000"), usd("50000"),
    ]);
    expect((regular.body as { removedEntries: unknown[] }).removedEntries).toEqual([]);

    const stop = await preview({ change: "stop", fromMonth: "2026-11" });
    expect((stop.body as { removedEntries: unknown[] }).removedEntries).toEqual([
      { entryType: "monthly", month: "2026-12", state: "amount", amount: usd("60000") },
      { entryType: "regular", month: "2027-01", state: "amount", amount: usd("50000") },
    ]);
    expect((stop.body as { timeline: { after: { state: string } }[] }).timeline.slice(1)
      .every(entry => entry.after.state === "absent")).toBe(true);
  });

  it.each([
    ["a repeating budget in a past month", { change: "set_regular", fromMonth: "2026-04", amount: { amountMinor: "100", currency: "USD" } }, 422, "month_in_past"],
    ["a stop in a past month", { change: "stop", fromMonth: "2026-04" }, 422, "month_in_past"],
    ["a negative amount", { change: "set_month", month: "2026-05", amount: { amountMinor: "-100", currency: "USD" } }, 422, "validation_failed"],
    ["another currency", { change: "set_month", month: "2026-05", amount: { amountMinor: "100", currency: "EUR" } }, 422, "validation_failed"],
    ["an unknown field", { change: "skip_month", month: "2026-05", note: "hello" }, 422, "validation_failed"],
    ["an impossible month", { change: "skip_month", month: "2026-13" }, 422, "validation_failed"],
    ["a timeline past the supported calendar", { change: "set_month", month: "2999-02", amount: { amountMinor: "100", currency: "USD" } }, 422, "validation_failed"],
  ])("refuses %s", async (_name, body, status, code) => {
    const response = await preview(body);
    expect(response.status).toBe(status);
    expect((response.body as { code: string }).code).toBe(code);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM budget_previews").get()).toEqual({ n: 0n });
  });

  it("accepts a past month for a one-month change and the last representable timeline start", async () => {
    expect((await preview({ change: "set_month", month: "2026-01", amount: usd("100") })).status).toBe(201);
    expect((await preview({ change: "skip_month", month: "2020-01" })).status).toBe(201);
    const last = await preview({ change: "set_month", month: "2999-01", amount: usd("100") });
    expect(last.status).toBe(201);
    expect((last.body as { timeline: { month: string }[] }).timeline.at(-1)?.month).toBe("2999-12");
  });

  it.each([
    ["Uncategorized", UNCATEGORIZED, 422, "budget_ineligible_category"],
    ["Income", INCOME_CATEGORY, 422, "budget_ineligible_category"],
  ])("refuses a budget for %s", async (_name, id, status, code) => {
    const response = await preview({ change: "set_month", month: "2026-05", amount: usd("100") }, id);
    expect(response.status).toBe(status);
    expect((response.body as { code: string }).code).toBe(code);
  });

  it("refuses an archived category and every unauthenticated or cross-origin attempt", async () => {
    expect((await api.request(`/api/categories/${GROCERIES}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "0", budgetPlanVersion: null, ruleResolutions: [] } })).status).toBe(200);
    const archived = await preview({ change: "set_month", month: "2026-05", amount: usd("100") });
    expect(archived.status).toBe(409);
    expect((archived.body as { code: string }).code).toBe("category_archived");

    const body = { change: "set_month", month: "2026-05", amount: usd("100") };
    expect((await api.request(`/api/budget-plans/${DINING}/preview-change`, { method: "POST", body, csrfToken: null })).status).toBe(403);
    expect((await api.request(`/api/budget-plans/${DINING}/preview-change`, { method: "POST", body, csrfToken: "wrong" })).status).toBe(403);
    expect((await api.request(`/api/budget-plans/${DINING}/preview-change`, { method: "POST", body, omitCookie: true })).status).toBe(401);
  });
});

describe("applying a budget change", () => {
  it("writes the reviewed change, its audit and one finance revision, then replays the saved result", async () => {
    const revision = financeRevision(api.db);
    const review = await preview({ change: "set_regular", fromMonth: "2026-06", amount: usd("45000") });
    const applied = await apply(previewId(review));
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      preview: { id: previewId(review), status: "applied", capturedPlanVersion: null },
      plan: { categoryId: GROCERIES, version: "1",
        regularSchedule: [{ effectiveMonth: "2026-06", state: "amount", amount: usd("45000") }],
        monthlyEntries: [], archiveCutoffMonth: null },
      financeRevision: String(revision + 1n) });
    expect((applied.body as { preview: { appliedAt: string } }).preview.appliedAt).not.toBeNull();
    const audit = api.db.prepare("SELECT * FROM audit_events WHERE entity_type = 'budget'").all();
    expect(audit).toHaveLength(1);

    const again = await apply(previewId(review));
    expect(again.status).toBe(200);
    expect(again.body).toEqual(applied.body);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_type = 'budget'").get()).toEqual({ n: 1n });
    expect(financeRevision(api.db)).toBe(revision + 1n);
    await api.restart();
    expect((await apply(previewId(review))).body).toEqual(applied.body);
  });

  it("refuses a review whose plan or category moved on, including a second first-ever budget", async () => {
    const first = await preview({ change: "set_month", month: "2026-05", amount: usd("100") });
    const second = await preview({ change: "set_month", month: "2026-05", amount: usd("200") });
    expect((await apply(previewId(first))).status).toBe(200);
    const stale = await apply(previewId(second));
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe("preview_stale");
    expect((await plan()).body).toMatchObject({ version: "1",
      monthlyEntries: [{ month: "2026-05", amount: usd("100") }] });

    const pending = await preview({ change: "set_month", month: "2026-07", amount: usd("300") });
    expect((await api.request(`/api/categories/${GROCERIES}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "0", budgetPlanVersion: "1", ruleResolutions: [] } })).status).toBe(200);
    const archived = await apply(previewId(pending));
    expect(archived.status).toBe(409);
    expect((archived.body as { code: string }).code).toBe("category_archived");
    expect((await api.request(`/api/categories/${GROCERIES}/reactivate`, { method: "POST",
      headers: { "if-match": '"2"' } })).status).toBe(200);
    const reactivated = await apply(previewId(pending));
    expect(reactivated.status).toBe(409);
    expect((reactivated.body as { code: string }).code).toBe("preview_stale");
  });

  it("refuses an expired review at the boundary, another category's review and an unknown id", async () => {
    const review = await preview({ change: "set_month", month: "2026-05", amount: usd("100") });
    expect((await apply(previewId(review), DINING)).status).toBe(404);
    expect((await apply(uuid(77, "32000000"))).status).toBe(404);
    api.clock.advance(86_400_000 - 1);
    await signInAgain();
    expect((await apply(previewId(review))).status).toBe(200);

    const second = await preview({ change: "set_month", month: "2026-08", amount: usd("100") });
    api.clock.advance(86_400_000);
    await signInAgain();
    const expired = await apply(previewId(second));
    expect(expired.status).toBe(410);
    expect((expired.body as { code: string }).code).toBe("preview_expired");
    // A completed change still replays after its own review would have expired.
    expect((await apply(previewId(review))).status).toBe(200);
  });

  it("refuses a repeating change whose month became the past while the review waited", async () => {
    // Late on the last Eastern evening of May, reviewed for May; applied after
    // Eastern midnight, when May is the past.
    api.clock.set(Date.UTC(2026, 4, 31, 23, 50, 0));
    await signInAgain();
    const review = await preview({ change: "set_regular", fromMonth: "2026-05", amount: usd("100") });
    api.clock.set(Date.UTC(2026, 5, 1, 4, 10, 0));
    await signInAgain();
    const late = await apply(previewId(review));
    expect(late.status).toBe(422);
    expect((late.body as { code: string }).code).toBe("month_in_past");
    expect((await plan()).body).toMatchObject({ version: null });
    // A one-month change keeps its approved historical behavior.
    const monthly = await preview({ change: "set_month", month: "2026-05", amount: usd("100") });
    expect((await apply(previewId(monthly))).status).toBe(200);
  });

  it("rolls back everything when the response cannot be sent", async () => {
    const review = await preview({ change: "set_month", month: "2026-05", amount: usd("100") });
    const before = snapshot();
    const revision = financeRevision(api.db);
    expect(() => withWriteTransaction(api.db, () => applyBudgetChange(context(), requireCategory(api.db, GROCERIES),
      previewId(review), () => { throw new Error("injected response failure"); }))).toThrow("injected response failure");
    expect(snapshot()).toEqual(before);
    expect(financeRevision(api.db)).toBe(revision);
    expect((await plan()).body).toMatchObject({ version: null });
    expect((await apply(previewId(review))).status).toBe(200);
  });

  it("changes no balance, ledger revision or reconciliation", async () => {
    spend({ categoryId: GROCERIES, postedDate: "2026-05-01", amountMinor: "-2500" });
    const balance = await api.request(`/api/accounts/${accountId}/balance?asOf=2026-05-31`);
    const account = await api.request(`/api/accounts/${accountId}`);
    await setBudget({ change: "set_regular", fromMonth: "2026-05", amount: usd("10000") });
    expect((await api.request(`/api/accounts/${accountId}/balance?asOf=2026-05-31`)).body).toEqual(balance.body);
    expect((await api.request(`/api/accounts/${accountId}`)).body).toEqual(account.body);
  });
});

describe("budget reviews as retained history", () => {
  it("blocks deleting a category that has only an unapplied review", async () => {
    expect((await preview({ change: "set_month", month: "2026-05", amount: usd("100") })).status).toBe(201);
    const deleted = await api.request(`/api/categories/${GROCERIES}`, { method: "DELETE", headers: { "if-match": '"1"' } });
    expect(deleted.status).toBe(409);
    expect((deleted.body as { code: string }).code).toBe("category_in_use");
    // A category with neither a plan nor a review is still deletable.
    expect((await api.request(`/api/categories/${DINING}`, { method: "DELETE", headers: { "if-match": '"1"' } })).status).toBe(204);
  });
});

describe("archiving a category that already has a stopped budget", () => {
  it("changes nothing, keeps the plan version and reports the stored cutoff afterwards", async () => {
    await setBudget({ change: "set_regular", fromMonth: "2026-05", amount: usd("10000") });
    await setBudget({ change: "stop", fromMonth: "2026-06" });
    const before = (await plan()).body;
    const pending = await preview({ change: "set_month", month: "2026-04", amount: usd("500") });
    expect(pending.status).toBe(201);
    const archived = await api.request(`/api/categories/${GROCERIES}/archive`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { ruleSetRevision: "0", budgetPlanVersion: "2", ruleResolutions: [] } });
    expect(archived.status).toBe(200);
    expect((archived.body as { budgetPlan: unknown }).budgetPlan)
      .toEqual({ ...(before as object), archiveCutoffMonth: "2026-06" });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE entity_type = 'budget'").get()).toEqual({ n: 2n });
    // The pending review is still staled by the archive: the category version
    // moved even though the budget did not.
    expect((await api.request(`/api/categories/${GROCERIES}/reactivate`, { method: "POST",
      headers: { "if-match": '"2"' } })).status).toBe(200);
    const stale = await apply(previewId(pending));
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe("preview_stale");
    // Archived again months later, the impact read reports this category's own
    // stored cutoff rather than a month computed from today.
    expect((await api.request(`/api/categories/${GROCERIES}/archive`, { method: "POST",
      headers: { "if-match": '"3"' }, body: { ruleSetRevision: "0", budgetPlanVersion: "2", ruleResolutions: [] } })).status).toBe(200);
    api.clock.set(Date.UTC(2026, 7, 10, 12, 0, 0));
    await signInAgain();
    expect((await api.request(`/api/categories/${GROCERIES}/archive-impact`)).body).toMatchObject({
      budget: { planVersion: "2", cutoffMonth: "2026-06", currentMonthLimit: null, removedEntries: [] } });
  });
});

describe("the ends of the supported calendar", () => {
  it("refuses to archive a category in the final month, when there is no next month to stop from", async () => {
    await setBudget({ change: "set_regular", fromMonth: "2026-05", amount: usd("10000") });
    api.clock.set(Date.UTC(2999, 11, 15, 12, 0, 0));
    await signInAgain();
    const impact = await api.request(`/api/categories/${GROCERIES}/archive-impact`);
    expect(impact.status).toBe(409);
    expect((impact.body as { code: string }).code).toBe("validation_failed");
    const archive = await api.request(`/api/categories/${GROCERIES}/archive`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { ruleSetRevision: "0", budgetPlanVersion: "1", ruleResolutions: [] } });
    expect(archive.status).toBe(422);
    expect((await plan()).body).toMatchObject({ version: "1", archiveCutoffMonth: null });
    expect((await api.request(`/api/categories/${GROCERIES}`)).body).toMatchObject({ status: "active" });
  });

  it("refuses the display percentage rather than emitting an unsafe integer, and keeps the money exact", async () => {
    await setBudget({ change: "set_month", month: "2026-03", amount: usd("1") });
    // 901 purchases just under the stored bound: the cents stay exact, but
    // the rounded percentage no longer fits a safe JSON integer.
    withWriteTransaction(api.db, () => {
      for (let index = 0; index < 901; index++) {
        postTransaction(api.db, { accountId, categoryId: GROCERIES, postedDate: "2026-03-08",
          amountMinor: "-99999999999", origin: "manual" });
      }
    });
    const response = await budgets("2026-03");
    expect(response.status).toBe(500);
    expect((response.body as { code: string }).code).toBe("internal_error");
    expect((await api.request("/api/summary?month=2026-03")).body).toMatchObject({
      spending: { net: { amountMinor: "90099999999099" } } });
    expect((await budgets("2026-04")).status).toBe(200);
  });
});
