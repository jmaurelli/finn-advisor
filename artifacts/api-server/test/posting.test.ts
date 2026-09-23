import { withWriteTransaction } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { easternDate } from "../src/domain/dates.js";
import { financeRevision, requireAccount } from "../src/services/ledger.js";
import { postTransaction } from "../src/services/posting.js";
import type { PostingInput } from "../src/lib/transaction-schemas.js";
import { startTestServer, type TestServer } from "./harness.js";
import { balanceOf, createAccount, postThroughService, uuid, UNCATEGORIZED, INCOME_CATEGORY } from "./finance-harness.js";

let api: TestServer;
let accountId: string;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  accountId = (await createAccount(api, { id: "abcdefab-0000-4000-8000-000000000001", openingMinor: "200000" })).id;
});
afterEach(async () => { await api.close(); });

const context = () => ({ db: api.db, now: api.clock.now(), today: easternDate(api.clock.now()), newId: api.deps.newId });
const movement = (patch: Partial<PostingInput> = {}): PostingInput => ({
  accountId, postedDate: "2026-04-02", merchant: "SYNTHETIC SHOP", kind: "purchase",
  money: { amountMinor: "-10000", currency: "USD" }, ...patch,
});
const count = (table: string) => (api.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: bigint }).n;
const state = () => ({ transactions: count("transactions"), history: count("assignment_events"),
  audit: count("audit_events"), finance: financeRevision(api.db), account: requireAccount(api.db, accountId) });

describe("internal posting and transaction detail", () => {
  it("posts exact money, original evidence and history in the caller's unit of work", async () => {
    const start = state();
    const purchase = postThroughService(api, movement({ accountId: accountId.toUpperCase() }));
    expect(purchase).toMatchObject({ accountId, money: { amountMinor: "-10000", currency: "USD" },
      categoryId: UNCATEGORIZED, assignment: { origin: "unassigned", ruleId: null, ruleRevision: null },
      lifecycle: "active", note: null, importId: null, sourceRowNumber: null, correction: null,
      voidedAt: null, transferPairId: null, refundLink: null, linkedRefundCount: 0, version: "1" });
    expect(purchase.id).not.toBe(accountId);
    const income = postThroughService(api, movement({ kind: "income", money: { amountMinor: "50000", currency: "USD" } }));
    expect(income.categoryId).toBe(INCOME_CATEGORY);
    expect(income.assignment.origin).toBe("system");
    const read = await api.request(`/api/transactions/${purchase.id.toUpperCase()}`);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(purchase);
    expect(read.headers.get("etag")).toBe('"1"');
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(balanceOf(await api.request(`/api/accounts/${accountId}/balance?asOf=2026-04-30`))).toBe("240000");
    expect(state()).toMatchObject({ transactions: 2n, history: 2n, audit: start.audit + 2n,
      finance: start.finance + 2n, account: { version: start.account.version, ledger_revision: 2n } });
    expect(api.db.prepare("SELECT original_posted_date, original_amount_cents FROM transactions WHERE id = ?").get(purchase.id))
      .toEqual({ original_posted_date: "2026-04-02", original_amount_cents: -10000n });
    const history = await api.request(`/api/transactions/${purchase.id}/history`);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ nextCursor: null, items: [{ transactionId: purchase.id,
      eventType: "imported", source: "system", before: null, relatedIds: [],
      after: { categoryId: UNCATEGORIZED, categoryName: "Uncategorized", money: purchase.money } }] });
    await api.restart();
    expect((await api.request(`/api/transactions/${purchase.id}`)).body).toEqual(purchase);
    expect((await api.request(`/api/transactions/${purchase.id}/history`)).body).toEqual(history.body);
  });

  it("posts a whole batch or none without committing independently", () => {
    const start = state();
    expect(() => postTransaction(context(), movement())).toThrow("caller's write transaction");
    expect(() => withWriteTransaction(api.db, () => {
      const first = postTransaction(context(), movement());
      expect(api.db.inTransaction).toBe(true);
      expect(count("transactions")).toBe(1n);
      expect(first.id).toBeTruthy();
      postTransaction(context(), movement({ postedDate: "2026-02-31" }));
    })).toThrow();
    expect(state()).toEqual(start);
    withWriteTransaction(api.db, () => {
      postTransaction(context(), movement());
      postTransaction(context(), movement());
    });
    expect(count("transactions")).toBe(2n);
  });

  it.each([
    ["zero", { money: { amountMinor: "0", currency: "USD" } }],
    ["positive purchase", { money: { amountMinor: "1", currency: "USD" } }],
    ["negative refund", { kind: "refund" }],
    ["negative income", { kind: "income" }],
    ["out of range", { money: { amountMinor: "-100000000000", currency: "USD" } }],
    ["fraction", { money: { amountMinor: "-1.01", currency: "USD" } }],
    ["leading zero", { money: { amountMinor: "-01", currency: "USD" } }],
    ["negative zero", { money: { amountMinor: "-0", currency: "USD" } }],
    ["non USD", { money: { amountMinor: "-1", currency: "EUR" } }],
    ["before coverage", { postedDate: "2026-03-31" }],
    ["impossible date", { postedDate: "2026-04-31" }],
    ["unknown kind", { kind: "other" }],
    ["blank merchant", { merchant: " \t " }],
    ["blank note", { note: " \t " }],
    ["empty note", { note: "" }],
    ["lone surrogate", { merchant: String.fromCharCode(0xd800) }],
    ["note surrogate", { note: String.fromCharCode(0xdc00) }],
    ["long merchant", { merchant: "a".repeat(2001) }],
    ["long note", { note: "a".repeat(1001) }],
    ["caller transaction id", { id: uuid(10) }],
    ["caller provenance", { importId: uuid(10) }],
    ["income category choice", { kind: "income", money: { amountMinor: "1", currency: "USD" }, category: { mode: "rules" } }],
    ["transfer category choice", { kind: "transfer", category: { mode: "category", categoryId: UNCATEGORIZED } }],
    ["Income on purchase", { category: { mode: "category", categoryId: INCOME_CATEGORY } }],
  ])("refuses %s readably without writes", (_label, patch) => {
    const start = state();
    expect(() => postThroughService(api, movement(patch as Partial<PostingInput>))).toThrowError(
      expect.objectContaining({ problem: expect.objectContaining({ status: 422, code: "validation_failed" }) }));
    expect(state()).toEqual(start);
  });

  it("accepts code-point boundary text, NUL, calendar leap days, and future posted dates", async () => {
    const emoji = String.fromCodePoint(0x1f600);
    const merchant = emoji.repeat(2000);
    const note = emoji.repeat(1000);
    const posted = postThroughService(api, movement({ merchant, note, postedDate: "2028-02-29" }));
    expect((await api.request(`/api/transactions/${posted.id}`)).body).toEqual(posted);
    expect((await api.request(`/api/transactions/${posted.id}/history`)).status).toBe(200);
    const nul = postThroughService(api, movement({ merchant: String.fromCharCode(0) + " SHOP", note: String.fromCharCode(0) }));
    expect((await api.request(`/api/transactions/${nul.id}`)).body).toEqual(nul);
    expect(posted.merchant).toBe(merchant);
    expect(posted.note).toBe(note);
  });

  it("uses ordered rules but protects explicit manual Uncategorized", async () => {
    const categoryId = "abcdefab-0000-4000-8000-000000000010";
    expect((await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Food", color: "#123456" } })).status).toBe(201);
    for (const [n, pattern] of [[1, "shop"], [2, "synthetic"]] as const) {
      expect((await api.request("/api/rules", { method: "POST", body: {
        id: uuid(n, "60000000"), matchType: "contains", pattern, categoryId,
      } })).status).toBe(201);
    }
    const matched = postThroughService(api, movement({ merchant: "  SYNTHETIC   SHOP " }));
    expect(matched.assignment).toMatchObject({ origin: "rule", ruleId: uuid(1, "60000000"), ruleRevision: "1" });
    expect(matched.merchant).toBe("  SYNTHETIC   SHOP ");
    expect(matched.categoryId).toBe(categoryId);
    const manual = postThroughService(api, movement({ category: { mode: "category", categoryId: UNCATEGORIZED } }));
    expect(manual.assignment).toMatchObject({ origin: "manual", ruleId: null, ruleRevision: null });
    const explicit = postThroughService(api, movement({ category: { mode: "category", categoryId: categoryId.toUpperCase() } }));
    expect(explicit.categoryId).toBe(categoryId);
    expect(explicit.assignment.origin).toBe("manual");
    expect((await api.request(`/api/rules/${uuid(1, "60000000")}`)).body).toMatchObject({ currentAssignmentCount: 1 });
    const history = await api.request(`/api/transactions/${matched.id}/history`);
    expect(history.body).toMatchObject({ items: [{ ruleId: uuid(1, "60000000"), ruleRevision: "1", after: { categoryName: "Food" } }] });
    await api.request(`/api/categories/${categoryId}`, { method: "PATCH", headers: { "if-match": '"1"' }, body: { name: "Renamed" } });
    expect((await api.request(`/api/transactions/${matched.id}/history`)).body).toEqual(history.body);
  });

  it("posts refunds and both transfer signs without inventing links", () => {
    for (const [kind, cents] of [["refund", "123"], ["transfer", "-123"], ["transfer", "123"]] as const) {
      const row = postThroughService(api, movement({ kind, money: { amountMinor: cents, currency: "USD" } }));
      expect(row.categoryId).toBe(kind === "refund" ? UNCATEGORIZED : null);
      expect(row.transferPairId).toBeNull();
      expect(row.refundLink).toBeNull();
    }
  });

  it("refuses an archived account and an archived category before posting", async () => {
    const categoryId = uuid(20);
    await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Old", color: "#123456" } });
    expect((await api.request(`/api/categories/${categoryId}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "0", budgetPlanVersion: null, ruleResolutions: [] } })).status).toBe(200);
    let start = state();
    expect(() => postThroughService(api, movement({ category: { mode: "category", categoryId } }))).toThrowError(
      expect.objectContaining({ problem: expect.objectContaining({ code: "category_archived" }) }));
    expect(state()).toEqual(start);
    await api.request(`/api/accounts/${accountId}/archive`, { method: "POST", headers: { "if-match": '"1"' } });
    start = state();
    expect(() => postThroughService(api, movement())).toThrowError(
      expect.objectContaining({ problem: expect.objectContaining({ code: "reactivation_required" }) }));
    expect(state()).toEqual(start);
  });

  it("advances the ledger dependency and makes an affected reconciled checkpoint need recheck", async () => {
    const created = await api.request(`/api/accounts/${accountId}/checkpoints`, { method: "POST", body: {
      id: uuid(30), closingDate: "2026-04-30", statementBalance: { amountMinor: "200000", currency: "USD" },
    } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ checkpoint: { status: "reconciled" } });
    postThroughService(api, movement());
    expect((await api.request(`/api/accounts/${accountId}/checkpoints`)).body).toMatchObject({ items: [{ status: "needs_recheck" }] });
    expect((await api.request(`/api/accounts/${accountId}`)).body).toMatchObject({ ledgerRevision: "1", currentBalance: { amountMinor: "190000" } });
  });

  it.each(["ledger_revision", "finance_revision"])("rolls back on %s overflow", column => {
    api.db.exec(column === "ledger_revision"
      ? "UPDATE accounts SET ledger_revision = 999999999999999999"
      : "UPDATE ledger_metadata SET finance_revision = 999999999999999999");
    const start = state();
    expect(() => postThroughService(api, movement())).toThrow();
    expect(state()).toEqual(start);
  });

  it("rolls back history, audit, and revisions when response validation fails in production", () => {
    api.deps.config.environment = "production";
    const start = state();
    let calls = 0;
    const newId = () => { calls += 1; return calls === 1 ? "z".repeat(36) : api.deps.newId(); };
    expect(() => withWriteTransaction(api.db, () => postTransaction({ ...context(), newId }, movement())))
      .toThrow("Response does not match the contract");
    expect(calls).toBe(3);
    expect(state()).toEqual(start);
  });

  it("rolls back a fault after inserting the transaction, and after inserting its history", () => {
    for (const failAt of [2, 3]) {
      const start = state();
      let calls = 0;
      const newId = () => { calls += 1; if (calls === failAt) throw new Error("injected failure"); return api.deps.newId(); };
      expect(() => withWriteTransaction(api.db, () => postTransaction({ ...context(), newId }, movement()))).toThrow("injected failure");
      expect(state()).toEqual(start);
    }
  });

  it("requires authentication for reads and has no public posting route", async () => {
    const row = postThroughService(api, movement());
    for (const suffix of ["", "/history"]) {
      expect((await api.request(`/api/transactions/${row.id}${suffix}`, { omitCookie: true })).status).toBe(401);
      expect((await api.request(`/api/transactions/not-a-uuid${suffix}`)).status).toBe(404);
      expect((await api.request(`/api/transactions/${uuid(999)}${suffix}`)).status).toBe(404);
    }
    const start = state();
    expect((await api.request("/api/transactions", { method: "POST", body: movement() })).status).toBe(404);
    expect(state()).toEqual(start);
  });
});
