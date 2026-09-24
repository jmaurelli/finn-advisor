/**
 * Live responses checked against the contract itself.
 *
 * The handlers already validate against the generated zod schemas, but those
 * are a translation. This file compiles `openapi.yaml` directly with Ajv, the
 * same way the contract's own check script does, so a response is measured
 * against the document the owner approved rather than against a derivative.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { writeBudgetConfiguration } from "../src/services/budget-plans.js";

import { startTestServer, TEST_PASSWORD, type TestResponse, type TestServer } from "./harness.js";
import { createAccount, postTransaction, postThroughService, uuid } from "./finance-harness.js";

const specPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../lib/api-spec/openapi.yaml",
);
const doc = YAML.parse(readFileSync(specPath, "utf8"), { maxAliasCount: -1 }) as Record<
  string,
  unknown
>;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addFormat("binary", true);
ajv.addFormat("password", true);
ajv.addKeyword("discriminator");
ajv.addKeyword("example");
ajv.addSchema(doc, "https://money-desk.invalid/openapi.json");

function validateAgainst(schemaName: string, value: unknown): void {
  const validate = ajv.getSchema(`https://money-desk.invalid/openapi.json#/components/schemas/${schemaName}`) ??
    ajv.compile({ $ref: `https://money-desk.invalid/openapi.json#/components/schemas/${schemaName}` });
  if (!validate(value)) {
    throw new Error(`${schemaName}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
});

afterEach(async () => {
  await api.close();
});

function expectProblem(response: TestResponse, code: string): void {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  validateAgainst("Problem", response.body);
  expect((response.body as { code: string }).code).toBe(code);
}

describe("finance responses match the contract", () => {
  it("returns the complete maximum-size budget archive impact and actual changed plan", async () => {
    await api.login();
    const categoryId = uuid(90);
    expect((await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Food", color: "#123456" } })).status).toBe(201);
    withWriteTransaction(api.db, () => writeBudgetConfiguration({ db: api.db, now: api.clock.now(), today: "2026-05-02", newId: api.deps.newId }, categoryId, {
      regular: [{ month: "2999-12", state: "stopped", amount: null }],
      monthly: Array.from({ length: 999 }, (_, i) => ({ month: `${2027 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`,
        state: "amount" as const, amount: BigInt(i) })),
    }));
    const impact = await api.request(`/api/categories/${categoryId}/archive-impact`);
    expect(impact.status).toBe(200);
    validateAgainst("CategoryArchiveImpact", impact.body);
    expect((impact.body as { budget: { removedEntries: unknown[] } }).budget.removedEntries).toHaveLength(1000);
    const result = await api.request(`/api/categories/${categoryId}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { budgetPlanVersion: "1", ruleSetRevision: "0", ruleResolutions: [] } });
    expect(result.status).toBe(200);
    validateAgainst("ArchiveCategoryResult", result.body);
    expect(result.body).toMatchObject({ budgetPlan: { version: "2", monthlyEntries: [],
      regularSchedule: [{ effectiveMonth: "2026-06", state: "stopped", amount: null }] } });
  });
  it("budget reads, a maximum-size review and its applied result match the approved OpenAPI", async () => {
    await api.login();
    const { id: accountId } = await createAccount(api);
    const categoryId = uuid(92);
    expect((await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Food", color: "#123456" } })).status).toBe(201);
    postThroughService(api, { accountId, postedDate: "2026-05-04", merchant: "SYNTHETIC SHOP",
      kind: "purchase", money: { amountMinor: "-2500", currency: "USD" },
      category: { mode: "category", categoryId } });
    withWriteTransaction(api.db, () => writeBudgetConfiguration({ db: api.db, now: api.clock.now(), today: "2026-05-02", newId: api.deps.newId }, categoryId, {
      regular: [{ month: "2026-05", state: "amount", amount: 10000n }, { month: "2999-12", state: "stopped", amount: null }],
      monthly: Array.from({ length: 998 }, (_, i) => ({ month: `${2027 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`,
        state: "amount" as const, amount: BigInt(i) })),
    }));
    const month = await api.request("/api/budgets?month=2026-05");
    expect(month.status).toBe(200);
    validateAgainst("BudgetMonth", month.body);
    expect(month.body).toMatchObject({ items: [{ categoryId, limit: { amountMinor: "10000", currency: "USD" },
      source: "regular", net: { amountMinor: "2500", currency: "USD" }, percentUsed: 25 }] });
    const plan = await api.request(`/api/budget-plans/${categoryId}`);
    expect(plan.status).toBe(200);
    validateAgainst("BudgetPlan", plan.body);

    const review = await api.request(`/api/budget-plans/${categoryId}/preview-change`, {
      method: "POST", body: { change: "stop", fromMonth: "2026-06" } });
    expect(review.status, review.text).toBe(201);
    validateAgainst("BudgetChangePreview", review.body);
    expect((review.body as { removedEntries: unknown[] }).removedEntries).toHaveLength(999);
    const result = await api.request(`/api/budget-plans/${categoryId}/apply-change`, {
      method: "POST", body: { previewId: (review.body as { id: string }).id } });
    expect(result.status, result.text).toBe(200);
    validateAgainst("BudgetChangeApplyResult", result.body);
    expect(result.body).toMatchObject({ plan: { version: "2", monthlyEntries: [], regularSchedule: [
      { effectiveMonth: "2026-05", state: "amount", amount: { amountMinor: "10000", currency: "USD" } },
      { effectiveMonth: "2026-06", state: "stopped", amount: null }] } });
    expectProblem(await api.request(`/api/budget-plans/${categoryId}/preview-change`, {
      method: "POST", body: { change: "set_regular", fromMonth: "2026-04", amount: { amountMinor: "100", currency: "USD" } } }), "month_in_past");
    expectProblem(await api.request("/api/budget-plans/30000000-0000-4000-8000-000000000000/preview-change", {
      method: "POST", body: { change: "skip_month", month: "2026-06" } }), "budget_ineligible_category");
  });
  it("rule-run previews, rows, results and refusals match the approved OpenAPI", async () => {
    await api.login();
    const { id: accountId } = await createAccount(api);
    const merchant = String.fromCodePoint(0x1f600).repeat(2000);
    const row = postThroughService(api, { accountId, postedDate: "2026-04-02", merchant,
      kind: "purchase", money: { amountMinor: "-100", currency: "USD" } });
    const categoryId = uuid(90);
    expect((await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Food", color: "#123456" } })).status).toBe(201);
    expect((await api.request("/api/rules", { method: "POST", body: { id: uuid(91), categoryId, pattern: String.fromCodePoint(0x1f600), matchType: "contains" } })).status).toBe(201);
    const scope = { accountId: accountId.toUpperCase(), categoryId: null, month: "2026-04", from: null, to: null };
    const create = () => api.request("/api/rule-runs", { method: "POST", body: { scope } });
    const response = await create();
    expect(response.status).toBe(201);
    validateAgainst("RuleRun", response.body);
    const id = (response.body as { id: string }).id;
    validateAgainst("RuleRun", (await api.request(`/api/rule-runs/${id}`)).body);
    const rows = await api.request(`/api/rule-runs/${id}/rows`);
    expect(rows.status).toBe(200);
    validateAgainst("RuleRunRowPage", rows.body);
    expect(rows.body).toMatchObject({ items: [{ merchant }] });
    const stale = (await create()).body as { id: string };
    const result = await api.request(`/api/rule-runs/${id}/apply`, { method: "POST" });
    expect(result.status).toBe(200);
    validateAgainst("RuleRunApplyResult", result.body);
    validateAgainst("HistoryPage", (await api.request(`/api/transactions/${row.id}/history`)).body);
    expectProblem(await api.request(`/api/rule-runs/${stale.id}/apply`, { method: "POST" }), "preview_stale");
    expectProblem(await api.request(`/api/rule-runs/${id}/rows?cursor=bad`), "invalid_cursor");
    expectProblem(await api.request("/api/rule-runs", { method: "POST", body: { scope: { ...scope, from: "2026-04-01" } } }), "validation_failed");
    api.clock.advance(86_400_000);
    await api.login();
    validateAgainst("RuleRun", (await api.request(`/api/rule-runs/${stale.id}`)).body);
    expectProblem(await api.request(`/api/rule-runs/${stale.id}/apply`, { method: "POST" }), "preview_expired");
    expect((await api.request(`/api/rule-runs/${id}/apply`, { method: "POST" })).body).toEqual(result.body);
  });
  it("repair previews, results, history and refusals match the approved OpenAPI", async () => {
    await api.login();
    const { id: accountId } = await createAccount(api);
    const row = postThroughService(api, { accountId, postedDate: "2026-04-02", merchant: "SYNTHETIC",
      kind: "purchase", money: { amountMinor: "-100", currency: "USD" } });
    const response = await api.request(`/api/transactions/${row.id}/repair-previews`, { method: "POST", body: {
      action: "correct", reason: String.fromCodePoint(0x1f600).repeat(500),
      money: { amountMinor: "-200", currency: "USD" }, postedDate: "2026-05-01",
    } });
    expect(response.status).toBe(201);
    validateAgainst("RepairPreview", response.body);
    const id = (response.body as { id: string }).id;
    validateAgainst("RepairPreview", (await api.request(`/api/transaction-repairs/${id}`)).body);
    const result = await api.request(`/api/transaction-repairs/${id}/apply`, { method: "POST", body: { confirmUnlinking: false } });
    expect(result.status).toBe(200);
    validateAgainst("RepairApplyResult", result.body);
    validateAgainst("HistoryPage", (await api.request(`/api/transactions/${row.id}/history`)).body);
    expectProblem(await api.request(`/api/transactions/${row.id}/repair-previews`, { method: "POST", body: {
      action: "correct", reason: "Synthetic", money: { amountMinor: "1", currency: "USD" },
    } }), "kind_sign_mismatch");
    const expiring = await api.request(`/api/transactions/${row.id}/repair-previews`, { method: "POST", body: { action: "void", reason: "Synthetic" } });
    const expireId = (expiring.body as { id: string }).id;
    api.clock.advance(86_400_000);
    await api.login();
    const expired = await api.request(`/api/transaction-repairs/${expireId}`);
    validateAgainst("RepairPreview", expired.body);
    expectProblem(await api.request(`/api/transaction-repairs/${expireId}/apply`, { method: "POST", body: { confirmUnlinking: true } }), "preview_expired");
  });
  it("real posting, transaction detail and retained history match approved OpenAPI code-point limits", async () => {
    await api.login();
    const { id: accountId } = await createAccount(api);
    const emoji = String.fromCodePoint(0x1f600);
    const categoryId = uuid(90);
    expect((await api.request("/api/categories", { method: "POST", body: {
      id: categoryId, name: emoji.repeat(60), color: "#123456",
    } })).status).toBe(201);
    const posted = postThroughService(api, { accountId, postedDate: "2026-04-02", kind: "purchase",
      money: { amountMinor: "-100", currency: "USD" }, merchant: emoji.repeat(2000), note: emoji.repeat(1000),
      category: { mode: "category", categoryId } });
    validateAgainst("Transaction", posted);
    const detail = await api.request(`/api/transactions/${posted.id}`);
    expect(detail.status).toBe(200);
    validateAgainst("Transaction", detail.body);
    const history = await api.request(`/api/transactions/${posted.id}/history`);
    expect(history.status).toBe(200);
    validateAgainst("HistoryPage", history.body);
    expectProblem(await api.request(`/api/transactions/${posted.id}/history?cursor=bad`), "invalid_cursor");
    expectProblem(await api.request(`/api/transactions/${uuid(999)}`), "not_found");
    expectProblem(await api.request(`/api/transactions/${posted.id}`, { omitCookie: true }), "not_authenticated");
  });

  it("transaction lists, corrections, correction-plus-rule and their refusals", async () => {
    await api.login();
    const { id: accountId } = await createAccount(api);
    const emoji = String.fromCodePoint(0x1f600);
    const categoryId = uuid(90);
    expect((await api.request("/api/categories", { method: "POST", body: {
      id: categoryId, name: "Food", color: "#123456",
    } })).status).toBe(201);
    const rows = [1, 2, 3].map(() => postThroughService(api, { accountId, postedDate: "2026-04-02", kind: "purchase",
      money: { amountMinor: "-100", currency: "USD" }, merchant: emoji.repeat(2000) }));
    const search = encodeURIComponent(emoji.repeat(200));
    const page = await api.request(`/api/transactions?limit=2&q=${search}`);
    expect(page.status).toBe(200);
    validateAgainst("TransactionPage", page.body);
    const next = (page.body as { nextCursor: string }).nextCursor;
    validateAgainst("TransactionPage", (await api.request(`/api/transactions?limit=2&q=${search}&cursor=${next}`)).body);
    expectProblem(await api.request(`/api/transactions?cursor=${next}`), "cursor_filter_mismatch");
    expectProblem(await api.request("/api/transactions?cursor=bad"), "invalid_cursor");
    expectProblem(await api.request("/api/transactions?month=2026-04&to=2026-05-01"), "invalid_request");
    expectProblem(await api.request("/api/transactions?q=%20"), "validation_failed");

    const categorized = await api.request(`/api/transactions/${rows[0]!.id}/categorize`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { categoryId, newRule: { id: uuid(60), matchType: "contains",
        pattern: emoji.repeat(256), appliesTo: "purchases", accountId } } });
    expect(categorized.status).toBe(200);
    validateAgainst("CategorizeResult", categorized.body);
    const plain = await api.request(`/api/transactions/${rows[1]!.id}/categorize`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { categoryId } });
    validateAgainst("CategorizeResult", plain.body);
    const note = await api.request(`/api/transactions/${rows[1]!.id}/note`, { method: "PATCH",
      headers: { "if-match": '"2"' }, body: { note: emoji.repeat(1000) } });
    expect(note.status).toBe(200);
    validateAgainst("TransactionResult", note.body);
    const returned = await api.request(`/api/transactions/${rows[1]!.id}/return-to-rules`, { method: "POST",
      headers: { "if-match": '"3"' } });
    expect(returned.status).toBe(200);
    validateAgainst("TransactionResult", returned.body);
    validateAgainst("HistoryPage", (await api.request(`/api/transactions/${rows[1]!.id}/history`)).body);
    const rule = (id: string, pattern: string) => ({ id, matchType: "exact", pattern, appliesTo: "purchases", accountId: null });
    expectProblem(await api.request(`/api/transactions/${rows[2]!.id}/categorize`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { categoryId, newRule: rule(uuid(60), "x") } }), "client_id_conflict");
    expectProblem(await api.request(`/api/transactions/${rows[2]!.id}/categorize`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { categoryId: "30000000-0000-4000-8000-000000000000", newRule: rule(uuid(61), "x") } }),
    "rule_target_ineligible");
    expectProblem(await api.request(`/api/transactions/${rows[2]!.id}/note`, { method: "PATCH",
      headers: { "if-match": '"9"' }, body: { note: null } }), "version_mismatch");
    expectProblem(await api.request(`/api/transactions/${rows[2]!.id}/note`, { method: "PATCH",
      body: { note: null } }), "precondition_required");
    expectProblem(await api.request(`/api/transactions/${rows[2]!.id}/note`, { method: "PATCH",
      headers: { "if-match": '"1"' }, body: { note: " " } }), "validation_failed");
  });

  it("type changes, transfer pairs, refund links, candidates and their refusals", async () => {
    await api.login();
    const checking = (await createAccount(api, { id: uuid(1) })).id;
    const card = (await createAccount(api, { id: uuid(2), kind: "credit_card", openingMinor: "0" })).id;
    const emoji = String.fromCodePoint(0x1f600);
    const post = (accountId: string, kind: "purchase" | "refund" | "income" | "transfer", amount: string) =>
      postThroughService(api, { accountId, postedDate: "2026-04-20", kind, merchant: emoji.repeat(2000),
        note: emoji.repeat(1000), money: { amountMinor: amount, currency: "USD" } });
    const payment = post(checking, "purchase", "-8000");
    const received = post(card, "transfer", "8000");
    const purchase = post(checking, "purchase", "-10000");
    const refund = post(card, "refund", "3000");

    const suggestions = await api.request(`/api/transactions/${received.id}/transfer-candidates`);
    expect(suggestions.status).toBe(200);
    validateAgainst("TransferCandidateList", suggestions.body);
    validateAgainst("TransferCandidateList",
      (await api.request(`/api/transactions/${received.id}/transfer-candidates?from=2026-04-01&to=2026-05-01`)).body);
    const candidates = await api.request(`/api/transactions/${refund.id}/refund-candidates?limit=1&q=${encodeURIComponent(emoji)}`);
    expect(candidates.status).toBe(200);
    validateAgainst("RefundCandidatePage", candidates.body);
    expectProblem(await api.request(`/api/transactions/${refund.id}/refund-candidates?kind=refund`), "invalid_request");

    const body = { id: uuid(1, "90000000"), confirmKindChanges: false,
      legs: [{ transactionId: payment.id, version: "1" }, { transactionId: received.id, version: "1" }] };
    expectProblem(await api.request("/api/transfer-pairs", { method: "POST", body }), "kind_change_confirmation_required");
    const paired = await api.request("/api/transfer-pairs", { method: "POST", body: { ...body, confirmKindChanges: true } });
    expect(paired.status).toBe(201);
    validateAgainst("TransferPairResult", paired.body);
    const replay = await api.request("/api/transfer-pairs", { method: "POST", body: { ...body, confirmKindChanges: true } });
    expect(replay.status).toBe(200);
    validateAgainst("TransferPairResult", replay.body);
    expectProblem(await api.request("/api/transfer-pairs", { method: "POST", body }), "client_id_conflict");
    expectProblem(await api.request("/api/transfer-pairs", { method: "POST", body: { ...body, id: uuid(2, "90000000"),
      legs: [{ transactionId: payment.id, version: "2" }, { transactionId: received.id, version: "2" }] } }),
    "transfer_pair_linked");
    validateAgainst("TransferPair", (await api.request(`/api/transfer-pairs/${uuid(1, "90000000")}`)).body);

    const linked = await api.request("/api/refund-links", { method: "POST",
      body: { id: uuid(1, "91000000"), refundId: refund.id, purchaseId: purchase.id } });
    expect(linked.status).toBe(201);
    validateAgainst("RefundLinkResult", linked.body);
    validateAgainst("RefundLink", (await api.request(`/api/refund-links/${uuid(1, "91000000")}`)).body);
    expectProblem(await api.request("/api/refund-links", { method: "POST",
      body: { id: uuid(2, "91000000"), refundId: refund.id, purchaseId: purchase.id } }), "refund_already_linked");

    expectProblem(await api.request(`/api/transactions/${purchase.id}/classify`, { method: "POST",
      headers: { "if-match": '"2"' }, body: { kind: "income" } }), "kind_sign_mismatch");
    const unlinkRequired = await api.request(`/api/transactions/${purchase.id}/classify`, { method: "POST",
      headers: { "if-match": '"2"' }, body: { kind: "transfer" } });
    expectProblem(unlinkRequired, "unlink_confirmation_required");
    expect(unlinkRequired.body).toMatchObject({ requiredUnlinks: { transferPairIds: [], refundLinkIds: [uuid(1, "91000000")] } });
    const classified = await api.request(`/api/transactions/${purchase.id}/classify`, { method: "POST",
      headers: { "if-match": '"2"' }, body: { kind: "transfer",
        confirmUnlink: { transferPairIds: [], refundLinkIds: [uuid(1, "91000000")] } } });
    expect(classified.status).toBe(200);
    validateAgainst("ClassifyResult", classified.body);

    const unpaired = await api.request(`/api/transfer-pairs/${uuid(1, "90000000")}`, { method: "DELETE",
      headers: { "if-match": '"1"' } });
    expect(unpaired.status).toBe(200);
    validateAgainst("UnlinkResult", unpaired.body);
    expectProblem(await api.request(`/api/transfer-pairs/${uuid(1, "90000000")}`, { method: "DELETE",
      headers: { "if-match": '"1"' } }), "not_found");
    const second = await api.request("/api/refund-links", { method: "POST",
      body: { id: uuid(3, "91000000"), refundId: refund.id, purchaseId: post(checking, "purchase", "-500").id } });
    expect(second.status).toBe(201);
    expectProblem(await api.request(`/api/refund-links/${uuid(3, "91000000")}`, { method: "DELETE" }), "precondition_required");
    expectProblem(await api.request(`/api/refund-links/${uuid(3, "91000000")}`, { method: "DELETE",
      headers: { "if-match": '"2"' } }), "version_mismatch");
    const removed = await api.request(`/api/refund-links/${uuid(3, "91000000")}`, { method: "DELETE",
      headers: { "if-match": '"1"' } });
    expect(removed.status).toBe(200);
    validateAgainst("UnlinkResult", removed.body);
    validateAgainst("HistoryPage", (await api.request(`/api/transactions/${purchase.id}/history`)).body);
  });

  it("category creation, replay, read, patch, reactivation, lists and refusals", async () => {
    await api.login();
    const input = { id: uuid(91), name: "\u{1f600}".repeat(60), description: "\u{1f600}".repeat(280), color: "#123456" };
    for (const status of [201, 200]) {
      const response = await api.request("/api/categories", { method: "POST", body: input });
      expect(response.status).toBe(status);
      validateAgainst("CategoryResult", response.body);
    }
    const path = `/api/categories/${input.id}`;
    const read = await api.request(path);
    expect(read.status).toBe(200);
    validateAgainst("Category", read.body);
    const patch = await api.request(path, { method: "PATCH", headers: { "if-match": '"1"' }, body: { description: "Changed" } });
    expect(patch.status).toBe(200);
    validateAgainst("CategoryResult", patch.body);
    const reactivate = await api.request(`${path}/reactivate`, { method: "POST", headers: { "if-match": '"2"' } });
    expect(reactivate.status).toBe(200);
    validateAgainst("CategoryResult", reactivate.body);
    for (const status of ["active", "archived", "all"]) {
      const list = await api.request(`/api/categories?status=${status}`);
      expect(list.status).toBe(200);
      validateAgainst("CategoryList", list.body);
    }
    expectProblem(await api.request("/api/categories", { method: "POST", body: { ...input, id: uuid(92) } }), "category_name_taken");
    expectProblem(await api.request("/api/categories", { method: "POST", body: { ...input, name: "Changed" } }), "client_id_conflict");
    expectProblem(await api.request("/api/categories", { method: "POST", body: { ...input, id: uuid(92), name: "\t" } }), "validation_failed");
    expect((await api.request(path, { method: "DELETE", headers: { "if-match": '"2"' } })).status).toBe(204);
  });
  it("rules, rule history, reorder, archive and category archive impact/archive", async () => {
    await api.login();
    const food = uuid(93);
    const home = uuid(94);
    for (const [id, name] of [[food, "Food"], [home, "Home"]]) {
      expect((await api.request("/api/categories", { method: "POST", body: { id, name, color: "#123456" } })).status).toBe(201);
    }
    const rule = (n: number) => uuid(n, "60000000");
    const body = (n: number, extra: Record<string, unknown> = {}) =>
      ({ id: rule(n), matchType: "contains", pattern: "\u{1f600}".repeat(256), categoryId: food, ...extra });
    for (const status of [201, 200]) {
      const response = await api.request("/api/rules", { method: "POST", body: body(1) });
      expect(response.status).toBe(status);
      validateAgainst("RuleResult", response.body);
    }
    const second = await api.request("/api/rules", { method: "POST", body: body(2, { matchType: "exact", appliesTo: "refunds" }) });
    validateAgainst("RuleResult", second.body);
    expect((second.body as { overlaps: unknown[] }).overlaps).toHaveLength(1);
    const read = await api.request(`/api/rules/${rule(1)}`);
    validateAgainst("Rule", read.body);
    const patch = await api.request(`/api/rules/${rule(1)}`, { method: "PATCH", headers: { "if-match": '"1"' }, body: { enabled: false } });
    expect(patch.status).toBe(200);
    validateAgainst("RuleResult", patch.body);
    const reorder = await api.request("/api/rules/reorder", { method: "POST",
      body: { ruleSetRevision: "3", orderedRuleIds: [rule(2), rule(1)] } });
    expect(reorder.status).toBe(200);
    validateAgainst("RuleList", reorder.body);
    const impact = await api.request(`/api/categories/${food}/archive-impact`);
    expect(impact.status).toBe(200);
    validateAgainst("CategoryArchiveImpact", impact.body);
    expectProblem(await api.request(`/api/categories/${food}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "3", budgetPlanVersion: null, ruleResolutions: [] } }), "rule_set_changed");
    expectProblem(await api.request(`/api/categories/${food}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "4", budgetPlanVersion: "1", ruleResolutions: [] } }), "preview_stale");
    expectProblem(await api.request(`/api/categories/${food}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "4", budgetPlanVersion: null, ruleResolutions: [] } }), "validation_failed");
    const archived = await api.request(`/api/categories/${food}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "4", budgetPlanVersion: null,
        ruleResolutions: [{ ruleId: rule(2), action: "retarget", targetCategoryId: home }] } });
    expect(archived.status).toBe(200);
    validateAgainst("ArchiveCategoryResult", archived.body);
    expectProblem(await api.request("/api/rules", { method: "POST", body: body(3) }), "category_archived");
    expectProblem(await api.request("/api/rules", { method: "POST", body: body(3, { categoryId: uuid(0, "30000000") }) }), "rule_target_ineligible");
    expectProblem(await api.request("/api/rules", { method: "POST", body: body(1, { pattern: "other" }) }), "client_id_conflict");
    expectProblem(await api.request("/api/rules", { method: "POST", body: body(3, { pattern: "\u3000" }) }), "validation_failed");
    const retired = await api.request(`/api/rules/${rule(2)}/archive`, { method: "POST", headers: { "if-match": '"3"' } });
    expect(retired.status).toBe(200);
    validateAgainst("RuleResult", retired.body);
    const history = await api.request(`/api/rules/${rule(2)}/history`);
    validateAgainst("RuleHistory", history.body);
    expect((history.body as { revisions: unknown[] }).revisions).toHaveLength(3);
    for (const status of ["active", "archived", "all"]) {
      const list = await api.request(`/api/rules?status=${status}`);
      expect(list.status).toBe(200);
      validateAgainst("RuleList", list.body);
    }
  });
  it("accounts, balances, baselines, checkpoints and the summary", async () => {
    await api.login();

    const { id, etag, response } = await createAccount(api);
    validateAgainst("AccountResult", response.body);
    validateAgainst("AccountList", (await api.request("/api/accounts")).body);
    validateAgainst("Account", (await api.request(`/api/accounts/${id}`)).body);

    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    validateAgainst(
      "AccountBalance",
      (await api.request(`/api/accounts/${id}/balance?asOf=2026-04-30`)).body,
    );
    // The uncovered shape is a different branch of the schema: balance null.
    validateAgainst(
      "AccountBalance",
      (await api.request(`/api/accounts/${id}/balance?asOf=2020-01-01`)).body,
    );

    const checkpoint = await api.request(`/api/accounts/${id}/checkpoints`, {
      method: "POST",
      body: {
        id: uuid(1, "70000000"),
        closingDate: "2026-04-30",
        statementBalance: { amountMinor: "117000", currency: "USD" },
      },
    });
    validateAgainst("CheckpointResult", checkpoint.body);
    validateAgainst("CheckpointList", (await api.request(`/api/accounts/${id}/checkpoints`)).body);
    validateAgainst(
      "CheckpointHistory",
      (await api.request(`/api/accounts/${id}/checkpoints/${uuid(1, "70000000")}/history`)).body,
    );

    api.clock.advance(60_000);
    validateAgainst(
      "CheckpointResult",
      (
        await api.request(`/api/accounts/${id}/checkpoints/${uuid(1, "70000000")}/recheck`, {
          method: "POST",
          headers: { "if-match": '"1"' },
        })
      ).body,
    );

    validateAgainst(
      "BaselineChangeResult",
      (
        await api.request(`/api/accounts/${id}/baseline`, {
          method: "POST",
          headers: { "if-match": etag },
          body: {
            mode: "correct_opening_balance",
            openingBalance: { amountMinor: "130000", currency: "USD" },
          },
        })
      ).body,
    );

    validateAgainst("MonthSummary", (await api.request("/api/summary?month=2026-04")).body);
    validateAgainst("MonthSummary", (await api.request("/api/summary?month=2026-05")).body);
  });

  it("every finance refusal is a valid problem document", async () => {
    await api.login();
    const { id, etag } = await createAccount(api);

    expectProblem(
      await api.request(`/api/accounts/${uuid(99)}`),
      "not_found",
    );
    expectProblem(
      (await createAccount(api, { displayName: "Different" })).response,
      "client_id_conflict",
    );
    expectProblem(
      await api.request(`/api/accounts/${id}`, {
        method: "PATCH",
        body: { displayName: "No version" },
      }),
      "precondition_required",
    );
    expectProblem(
      await api.request(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "if-match": '"42"' },
        body: { displayName: "Stale" },
      }),
      "version_mismatch",
    );

    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    expectProblem(
      await api.request(`/api/accounts/${id}`, { method: "DELETE", headers: { "if-match": etag } }),
      "account_in_use",
    );
    expectProblem(
      await api.request(`/api/accounts/${id}/baseline`, {
        method: "POST",
        headers: { "if-match": etag },
        body: {
          mode: "move_start_later",
          trackingStartDate: "2026-04-20",
          openingBalance: { amountMinor: "1", currency: "USD" },
        },
      }),
      "active_transactions_before_start",
    );

    await api.request(`/api/accounts/${id}/archive`, {
      method: "POST",
      headers: { "if-match": etag },
    });
    expectProblem(
      await api.request(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "if-match": '"2"' },
        body: { displayName: "While archived" },
      }),
      "reactivation_required",
    );
  });
});

describe("responses match the contract", () => {
  it("healthz, readyz and the signed-out session", async () => {
    validateAgainst("HealthStatus", (await api.request("/api/healthz")).body);
    validateAgainst("ReadinessStatus", (await api.request("/api/readyz")).body);
    validateAgainst("SessionState", (await api.request("/api/session")).body);
  });

  it("sign-in, session state, activity and preferences", async () => {
    validateAgainst("SignedInSession", (await api.login()).body);
    validateAgainst("SessionState", (await api.request("/api/session")).body);
    validateAgainst(
      "SignedInSession",
      (await api.request("/api/session/activity", { method: "POST" })).body,
    );

    const preferences = await api.request("/api/preferences");
    validateAgainst("Preferences", preferences.body);

    const updated = await api.request("/api/preferences", {
      method: "PATCH",
      body: { displayName: "Household" },
      headers: { "if-match": preferences.headers.get("etag")! },
    });
    validateAgainst("Preferences", updated.body);
  });

  it("every error response is a valid problem document with no-store", async () => {
    expectProblem(await api.request("/api/preferences"), "not_authenticated");
    expectProblem(await api.request("/api/nothing-here"), "not_found");
    expectProblem(await api.login("wrong-password"), "invalid_credentials");
    expectProblem(
      await api.request("/api/session/login", {
        method: "POST",
        body: { password: TEST_PASSWORD },
        headers: { origin: "https://evil.example" },
      }),
      "origin_rejected",
    );
    expectProblem(
      await api.request("/api/session/login", {
        method: "POST",
        rawBody: "password=x",
        contentType: "application/x-www-form-urlencoded",
      }),
      "unsupported_media_type",
    );
    expectProblem(
      await api.request("/api/session/login", { method: "POST", body: { nope: 1 } }),
      "validation_failed",
    );

    await api.login();
    expectProblem(
      await api.request("/api/session/activity", { method: "POST", csrfToken: null }),
      "csrf_invalid",
    );
    expectProblem(
      await api.request("/api/preferences", { method: "PATCH", body: { density: "compact" } }),
      "precondition_required",
    );
    await api.request("/api/preferences", {
      method: "PATCH",
      body: { density: "compact" },
      headers: { "if-match": '"1"' },
    });
    expectProblem(
      await api.request("/api/preferences", {
        method: "PATCH",
        body: { density: "standard" },
        headers: { "if-match": '"1"' },
      }),
      "version_mismatch",
    );
  });
});
