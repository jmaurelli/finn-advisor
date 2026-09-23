/**
 * Phase 4 acceptance: type changes, transfer pairs and refund links, through
 * the real posting service and the approved HTTP operations.
 */
import { withWriteTransaction } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { easternDate } from "../src/domain/dates.js";
import type { PostingInput } from "../src/lib/transaction-schemas.js";
import { classifyTransaction } from "../src/services/corrections.js";
import { createTransferPair } from "../src/services/links.js";
import { startTestServer, type TestResponse, type TestServer } from "./harness.js";
import { createAccount, INCOME_CATEGORY, postThroughService, UNCATEGORIZED, uuid } from "./finance-harness.js";

let api: TestServer;
let checking: string;
let card: string;
let savings: string;
const FOOD = "abcdef00-0000-4000-8000-000000000001";
const pairId = (n: number) => uuid(n, "90000000");
const linkId = (n: number) => uuid(n, "91000000");

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  checking = (await createAccount(api, { id: uuid(1), openingMinor: "200000" })).id;
  card = (await createAccount(api, { id: uuid(2), kind: "credit_card", displayName: "Synthetic Card",
    openingMinor: "0" })).id;
  savings = (await createAccount(api, { id: uuid(3), kind: "savings", displayName: "Synthetic Savings",
    openingMinor: "0" })).id;
  expect((await api.request("/api/categories", { method: "POST",
    body: { id: FOOD, name: "Food", color: "#123456" } })).status).toBe(201);
});
afterEach(async () => { await api.close(); });

type Posted = ReturnType<typeof postThroughService>;
const post = (patch: Partial<PostingInput> = {}): Posted => postThroughService(api, {
  accountId: checking, postedDate: "2026-04-20", merchant: "SYNTHETIC CARD PAYMENT", kind: "purchase",
  money: { amountMinor: "-8000", currency: "USD" }, ...patch,
});
const version = async (id: string) => Number(((await api.request(`/api/transactions/${id}`)).body as { version: string }).version);
const detail = async (id: string) => (await api.request(`/api/transactions/${id}`)).body as Record<string, unknown>;
const pair = async (n: number, legs: Posted[], confirmKindChanges = false, versions?: number[]) =>
  api.request("/api/transfer-pairs", { method: "POST", body: { id: pairId(n), confirmKindChanges,
    legs: await Promise.all(legs.map(async (leg, index) => ({ transactionId: leg.id,
      version: String(versions?.[index] ?? await version(leg.id)) }))) } });
const unpair = (n: number, ifMatch: string | null = '"1"') => api.request(`/api/transfer-pairs/${pairId(n)}`,
  { method: "DELETE", headers: ifMatch === null ? {} : { "if-match": ifMatch } });
const link = (n: number, refund: Posted, purchase: Posted) => api.request("/api/refund-links", { method: "POST",
  body: { id: linkId(n), refundId: refund.id, purchaseId: purchase.id } });
const unlink = (n: number, ifMatch = '"1"') => api.request(`/api/refund-links/${linkId(n)}`,
  { method: "DELETE", headers: { "if-match": ifMatch } });
const classify = async (row: Posted, body: unknown, ifMatch?: number) => api.request(
  `/api/transactions/${row.id}/classify`, { method: "POST",
    headers: { "if-match": `"${ifMatch ?? await version(row.id)}"` }, body });
const summary = async (month: string) => (await api.request(`/api/summary?month=${month}`)).body as {
  financeRevision: string;
  spending: { purchases: { amountMinor: string }; refunds: { amountMinor: string }; net: { amountMinor: string } };
  income: { amountMinor: string }; review: { unmatchedTransferCount: number };
  categories: { categoryId: string; net: { amountMinor: string } }[];
  accounts: { accountId: string; balance: { amountMinor: string } | null }[];
};
const net = async (month: string) => (await summary(month)).spending.net.amountMinor;
const unmatched = async () => (await summary("2026-04")).review.unmatchedTransferCount;
const code = (response: TestResponse) => (response.body as { code?: string }).code;
const history = async (id: string) =>
  ((await api.request(`/api/transactions/${id}/history`)).body as { items: Record<string, unknown>[] }).items;
const snapshot = () => ({
  transactions: api.db.prepare("SELECT * FROM transactions ORDER BY id").all(),
  events: api.db.prepare("SELECT * FROM assignment_events ORDER BY id").all(),
  audit: api.db.prepare("SELECT * FROM audit_events ORDER BY id").all(),
  pairs: api.db.prepare("SELECT * FROM transfer_pairs ORDER BY id").all(),
  legs: api.db.prepare("SELECT * FROM transfer_legs ORDER BY pair_id, slot").all(),
  refunds: api.db.prepare("SELECT * FROM refund_links ORDER BY id").all(),
  accounts: api.db.prepare("SELECT * FROM accounts ORDER BY id").all(),
  metadata: api.db.prepare("SELECT * FROM ledger_metadata").get(),
});
async function archive(accountId: string): Promise<void> {
  const account = await api.request(`/api/accounts/${accountId}`);
  expect((await api.request(`/api/accounts/${accountId}/archive`, { method: "POST",
    headers: { "if-match": account.headers.get("etag") ?? "" } })).status).toBe(200);
}
function voidDirectly(id: string): void {
  // Phase 5 owns the void command; this arranges stored state for refusal checks only.
  api.db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ?, version = version + 1 WHERE id = ?")
    .run(api.clock.now(), id);
}

describe("the $80 card payment is counted once", () => {
  for (const order of ["checking first", "card first"] as const) {
    it(`pairing with a confirmed type change removes the double count (${order})`, async () => {
      const cardPurchase = post({ accountId: card, postedDate: "2026-04-02", merchant: "SYNTHETIC MARKET" });
      const postChecking = () => post();
      const postCard = () => post({ accountId: card, postedDate: "2026-04-21", merchant: "SYNTHETIC PAYMENT THANK YOU",
        kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
      const [payment, received] = order === "checking first"
        ? [postChecking(), postCard()] : (() => { const c = postCard(); return [postChecking(), c]; })();
      expect(cardPurchase.kind).toBe("purchase");
      // Without bank evidence the checking payment defaults to a purchase: $160 until corrected.
      expect(await net("2026-04")).toBe("16000");
      expect(await unmatched()).toBe(1);
      const balances = (await summary("2026-04")).accounts;

      const refused = await pair(1, [payment, received]);
      expect(refused.status).toBe(409);
      expect(code(refused)).toBe("kind_change_confirmation_required");
      expect(await net("2026-04")).toBe("16000");

      const paired = await pair(1, [payment, received], true);
      expect(paired.status).toBe(201);
      expect(paired.headers.get("etag")).toBe('"1"');
      expect(paired.body).toMatchObject({ transferPair: { id: pairId(1), version: "1", legs: [
        { transactionId: payment.id, accountId: checking, postedDate: "2026-04-20", money: { amountMinor: "-8000" } },
        { transactionId: received.id, accountId: card, postedDate: "2026-04-21", money: { amountMinor: "8000" } },
      ] }, transactions: [
        { id: payment.id, kind: "transfer", categoryId: null, transferPairId: pairId(1), version: "2",
          assignment: { origin: "system", ruleId: null } },
        { id: received.id, kind: "transfer", transferPairId: pairId(1), version: "2" },
      ] });
      expect(await net("2026-04")).toBe("8000");
      expect(await unmatched()).toBe(0);
      // Linking and the type change move no money.
      expect((await summary("2026-04")).accounts).toEqual(balances);
      expect((await history(payment.id)).map(event => event["eventType"]).slice(0, 2))
        .toEqual(expect.arrayContaining(["kind_changed", "transfer_linked"]));
      expect((await history(payment.id)).find(event => event["eventType"] === "kind_changed")).toMatchObject({
        before: { kind: "purchase", categoryId: UNCATEGORIZED, assignmentOrigin: "unassigned" },
        after: { kind: "transfer", categoryId: null, assignmentOrigin: "system" }, relatedIds: [pairId(1)] });
    });
  }

  it("classifying first leaves an unmatched transfer, excluded from spending, until it is paired", async () => {
    post({ accountId: card, postedDate: "2026-04-02", merchant: "SYNTHETIC MARKET" });
    const payment = post();
    const received = post({ accountId: card, postedDate: "2026-04-21", kind: "transfer",
      money: { amountMinor: "8000", currency: "USD" } });
    const classified = await classify(payment, { kind: "transfer" }, 1);
    expect(classified.status).toBe(200);
    expect(classified.headers.get("etag")).toBe('"2"');
    expect(classified.body).toMatchObject({ transaction: { kind: "transfer", categoryId: null, transferPairId: null },
      unlinked: { transferPairIds: [], refundLinkIds: [] } });
    expect(await net("2026-04")).toBe("8000");
    expect(await unmatched()).toBe(2);
    expect((await pair(1, [payment, received])).status).toBe(201);
    expect(await unmatched()).toBe(0);
    expect(await net("2026-04")).toBe("8000");
  });
});

describe("transfer pairs", () => {
  it("refuses same-account, duplicate-leg, unequal, already-paired and voided pairs, writing nothing", async () => {
    const out = post({ kind: "transfer" });
    const sameAccount = post({ kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const unequal = post({ accountId: card, kind: "transfer", money: { amountMinor: "7999", currency: "USD" } });
    const good = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const other = post({ accountId: savings, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const voided = post({ accountId: savings, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    voidDirectly(voided.id);
    const before = snapshot();
    const cases: [Posted[], number, string, string?][] = [
      [[out, sameAccount], 422, "validation_failed", "same_account"],
      [[out, out], 422, "validation_failed"],
      [[out, unequal], 422, "validation_failed", "amount_mismatch"],
      [[out, voided], 422, "validation_failed", "voided"],
    ];
    for (const [legs, status, problemCode, fieldCode] of cases) {
      const response = await pair(1, legs, true);
      expect(response.status).toBe(status);
      expect(code(response)).toBe(problemCode);
      if (fieldCode !== undefined) {
        expect((response.body as { fieldErrors: { code: string }[] }).fieldErrors[0]!.code).toBe(fieldCode);
      }
    }
    expect(snapshot()).toEqual(before);
    expect((await pair(1, [out, good])).status).toBe(201);
    const again = await pair(2, [out, other]);
    expect(again.status).toBe(409);
    expect(code(again)).toBe("transfer_pair_linked");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transfer_pairs").get()).toEqual({ n: 1n });
  });

  it("pairs outside the seven-day suggestion window, which is never a validity rule", async () => {
    const out = post({ kind: "transfer", postedDate: "2026-04-01" });
    const late = post({ accountId: savings, kind: "transfer", postedDate: "2026-04-25",
      money: { amountMinor: "8000", currency: "USD" } });
    const suggestions = await api.request(`/api/transactions/${out.id}/transfer-candidates`);
    expect(suggestions.body).toMatchObject({ items: [] });
    const explicit = await api.request(`/api/transactions/${out.id}/transfer-candidates?from=2026-04-01&to=2026-05-01`);
    expect(explicit.body).toMatchObject({ items: [{ transaction: { id: late.id }, daysApart: 24,
      withinSuggestionWindow: false, requiresKindChange: false, eligible: true, ineligibleReason: null }] });
    expect((await pair(1, [out, late])).status).toBe(201);
  });

  it("checks both leg versions and replays by client ID without pairing twice", async () => {
    const out = post({ kind: "transfer" });
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const stale = await pair(1, [out, into], false, [1, 2]);
    expect(stale.status).toBe(409);
    expect(code(stale)).toBe("preview_stale");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transfer_pairs").get()).toEqual({ n: 0n });

    const body = { id: pairId(1).toUpperCase(), confirmKindChanges: false, legs: [
      { transactionId: out.id.toUpperCase(), version: "1" }, { transactionId: into.id, version: "1" }] };
    const first = await api.request("/api/transfer-pairs", { method: "POST", body });
    expect(first.status).toBe(201);
    const before = snapshot();
    api.clock.advance(60_000);
    const replay = await api.request("/api/transfer-pairs", { method: "POST", body });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("etag")).toBe('"1"');
    expect(replay.body).toEqual(first.body);
    expect(snapshot()).toEqual(before);
    const swapped = await api.request("/api/transfer-pairs", { method: "POST",
      body: { ...body, legs: [{ transactionId: into.id.toUpperCase(), version: "1" }, { transactionId: out.id, version: "1" }] } });
    expect(swapped.status).toBe(200);
    expect(swapped.body).toEqual(first.body);
    for (const changed of [{ ...body, confirmKindChanges: true },
      { ...body, legs: [{ transactionId: out.id, version: "2" }, { transactionId: into.id, version: "2" }] }]) {
      const conflict = await api.request("/api/transfer-pairs", { method: "POST", body: changed });
      expect(conflict.status).toBe(409);
      expect(code(conflict)).toBe("client_id_conflict");
    }

    // After unlinking, the same retry cannot silently pair again: the id is used up.
    expect((await unpair(1)).status).toBe(200);
    const late = await api.request("/api/transfer-pairs", { method: "POST", body });
    expect(late.status).toBe(409);
    expect(code(late)).toBe("client_id_conflict");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transfer_pairs").get()).toEqual({ n: 0n });
  });

  it("unlinks with a strong If-Match, keeping both legs as unmatched transfers", async () => {
    const out = post({ kind: "transfer" });
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    expect((await pair(1, [out, into])).status).toBe(201);
    expect((await api.request(`/api/transfer-pairs/${pairId(1)}`)).body).toMatchObject({ id: pairId(1), version: "1" });
    expect((await unpair(1, null)).status).toBe(428);
    expect((await unpair(1, '"2"')).status).toBe(412);
    const balances = (await summary("2026-04")).accounts;
    const revision = BigInt((await summary("2026-04")).financeRevision);
    const removed = await unpair(1);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ transactionIds: [out.id, into.id], financeRevision: String(revision + 1n) });
    for (const id of [out.id, into.id]) {
      expect(await detail(id)).toMatchObject({ kind: "transfer", transferPairId: null, version: "3",
        money: id === out.id ? out.money : into.money, postedDate: "2026-04-20" });
      expect((await history(id))[0]).toMatchObject({ eventType: "transfer_unlinked", relatedIds: [pairId(1),
        id === out.id ? into.id : out.id] });
    }
    expect(await unmatched()).toBe(2);
    expect((await summary("2026-04")).accounts).toEqual(balances);
    expect((await unpair(1)).status).toBe(404);
    expect((await api.request(`/api/transfer-pairs/${pairId(1)}`)).status).toBe(404);
    const reused = await pair(1, [out, into]);
    expect(reused.status).toBe(409);
    expect(code(reused)).toBe("client_id_conflict");
    expect(await unmatched()).toBe(2);
  });

  it("allows only the approved archived-account exceptions", async () => {
    const out = post({ kind: "transfer" });
    const archivedTransfer = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const other = post({ accountId: savings, kind: "transfer", postedDate: "2026-04-21" });
    const archivedIncome = post({ accountId: card, kind: "income", money: { amountMinor: "8000", currency: "USD" },
      postedDate: "2026-04-22" });
    await archive(card);
    const cardRows = () => api.db.prepare(`SELECT id, kind, amount_cents, posted_date, lifecycle, category_id
      FROM transactions WHERE account_id = ? ORDER BY id`).all(card);
    const frozen = cardRows();
    const needsChange = await pair(1, [other, archivedIncome], true);
    expect(needsChange.status).toBe(409);
    expect(code(needsChange)).toBe("reactivation_required");
    const candidates = await api.request(`/api/transactions/${other.id}/transfer-candidates?accountId=${card}`);
    expect(candidates.body).toMatchObject({ items: [
      { transaction: { id: archivedTransfer.id }, eligible: true, ineligibleReason: null, requiresKindChange: false },
      { transaction: { id: archivedIncome.id }, eligible: false, ineligibleReason: "reactivation_required",
        requiresKindChange: true }] });
    expect((await pair(2, [out, archivedTransfer])).status).toBe(201);
    expect((await unpair(2)).status).toBe(200);
    expect(cardRows()).toEqual(frozen);
    // Explicit category choices bypass the rule evaluator's own archived check, so each needs the command's.
    for (const body of [{ kind: "transfer" }, { kind: "refund", category: { mode: "category", categoryId: FOOD } },
      { kind: "income" }]) {
      const reclassify = await classify(archivedIncome, body);
      expect(reclassify.status).toBe(409);
      expect(code(reclassify)).toBe("reactivation_required");
    }
    expect(cardRows()).toEqual(frozen);
  });

  it("refuses to pair a leg whose type change would break its refund links", async () => {
    const purchase = post({ merchant: "SYNTHETIC MARKET" });
    const refund = post({ accountId: card, kind: "refund", money: { amountMinor: "8000", currency: "USD" } });
    const transfer = post({ accountId: savings, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    expect((await link(1, refund, purchase)).status).toBe(201);
    const before = snapshot();
    const refused = await pair(1, [purchase, transfer], true);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "unlink_confirmation_required",
      requiredUnlinks: { transferPairIds: [], refundLinkIds: [linkId(1)] } });
    expect(snapshot()).toEqual(before);
  });

  it("suggests equal and opposite transfers in other accounts, nearest first, and never writes", async () => {
    const source = post({ kind: "transfer", postedDate: "2026-04-15" });
    const make = (accountId: string, postedDate: string, amount = "8000", patch: Partial<PostingInput> = {}) =>
      post({ accountId, postedDate, kind: "transfer", money: { amountMinor: amount, currency: "USD" }, ...patch });
    const far = make(card, "2026-04-22");
    const near = make(savings, "2026-04-14");
    const purchaseLike = make(card, "2026-04-16", "8000", { kind: "income" });
    make(card, "2026-04-23");
    make(checking, "2026-04-15");
    make(card, "2026-04-15", "8001");
    const voided = make(savings, "2026-04-15");
    voidDirectly(voided.id);
    const before = snapshot();
    const response = await api.request(`/api/transactions/${source.id.toUpperCase()}/transfer-candidates`);
    expect(response.status).toBe(200);
    const items = (response.body as { items: { transaction: { id: string }; daysApart: number;
      requiresKindChange: boolean }[] }).items;
    expect(items.map(item => [item.transaction.id, item.daysApart, item.requiresKindChange])).toEqual([
      // Equal distance: the newer date first.
      [purchaseLike.id, 1, true], [near.id, 1, false], [far.id, 7, false]]);
    expect(snapshot()).toEqual(before);
    const purchaseSource = post({ accountId: savings, postedDate: "2026-04-15",
      money: { amountMinor: "8000", currency: "USD" }, kind: "refund" });
    const fromRefund = await api.request(`/api/transactions/${purchaseSource.id}/transfer-candidates`);
    expect(fromRefund.body).toMatchObject({ items: [{ transaction: { id: source.id }, requiresKindChange: true,
      eligible: true }] });
    const refused = await api.request(`/api/transactions/${source.id}/transfer-candidates?limit=5`);
    expect(refused.status).toBe(400);
    expect((await api.request(`/api/transactions/${source.id}/transfer-candidates?from=2026-04-10&to=2026-04-10`)).status)
      .toBe(400);
    expect((await api.request(`/api/transactions/${uuid(999, "10000000")}/transfer-candidates`)).status).toBe(404);
  });

  it("caps suggestions at 50", async () => {
    const source = post({ kind: "transfer", postedDate: "2026-04-15" });
    for (let index = 0; index < 55; index += 1) {
      post({ accountId: card, postedDate: "2026-04-16", kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    }
    const response = await api.request(`/api/transactions/${source.id}/transfer-candidates`);
    expect((response.body as { items: unknown[] }).items).toHaveLength(50);
  });
});

describe("refund links", () => {
  it("links partial and excess refunds across accounts without changing any month or category", async () => {
    const purchase = post({ postedDate: "2026-04-02", merchant: "SYNTHETIC OUTFITTER",
      money: { amountMinor: "-10000", currency: "USD" }, category: { mode: "category", categoryId: FOOD } });
    const first = post({ accountId: card, postedDate: "2026-05-01", kind: "refund", merchant: "SYNTHETIC OUTFITTER",
      money: { amountMinor: "3000", currency: "USD" } });
    const second = post({ postedDate: "2026-05-01", kind: "refund", merchant: "SYNTHETIC OUTFITTER",
      money: { amountMinor: "7000", currency: "USD" }, category: { mode: "category", categoryId: FOOD } });
    const extra = post({ accountId: savings, postedDate: "2026-05-01", kind: "refund",
      money: { amountMinor: "1000", currency: "USD" } });
    const april = await summary("2026-04");
    const may = await summary("2026-05");

    const one = await link(1, first, purchase);
    expect(one.status).toBe(201);
    expect(one.headers.get("etag")).toBe('"1"');
    expect(one.body).toMatchObject({ refundLink: { id: linkId(1), refundId: first.id, purchaseId: purchase.id,
      version: "1" }, linkedRefundTotal: { amountMinor: "3000" }, exceedsPurchase: false });
    expect((await link(2, second, purchase)).body).toMatchObject({ linkedRefundTotal: { amountMinor: "10000" },
      exceedsPurchase: false });
    const excess = await link(3, extra, purchase);
    expect(excess.status).toBe(201);
    expect(excess.body).toMatchObject({ linkedRefundTotal: { amountMinor: "11000" }, exceedsPurchase: true });

    expect(await summary("2026-04")).toEqual({ ...april, financeRevision: expect.any(String) });
    expect(await summary("2026-05")).toEqual({ ...may, financeRevision: expect.any(String) });
    expect(await net("2026-04")).toBe("10000");
    expect(await detail(purchase.id)).toMatchObject({ linkedRefundCount: 3, version: "4", categoryId: FOOD,
      money: purchase.money, postedDate: "2026-04-02" });
    expect(await detail(first.id)).toMatchObject({ refundLink: { linkId: linkId(1), purchaseId: purchase.id },
      version: "2", categoryId: UNCATEGORIZED, postedDate: "2026-05-01" });
    expect((await history(purchase.id))[0]).toMatchObject({ eventType: "refund_linked", before: null, after: null,
      relatedIds: [linkId(3), extra.id] });
    expect((await api.request(`/api/refund-links/${linkId(1)}`)).body).toEqual((one.body as { refundLink: unknown }).refundLink);

    const revision = BigInt((await summary("2026-05")).financeRevision);
    const removed = await unlink(2);
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ transactionIds: [second.id, purchase.id], financeRevision: String(revision + 1n) });
    // A late retry of the original create must not bring the removed link back.
    const late = await link(2, second, purchase);
    expect(late.status).toBe(409);
    expect(code(late)).toBe("client_id_conflict");
    expect(await detail(second.id)).toMatchObject({ refundLink: null });
    expect(await detail(second.id)).toMatchObject({ refundLink: null, kind: "refund", categoryId: FOOD });
    expect(await net("2026-05")).toBe(may.spending.net.amountMinor);
    expect((await unlink(2)).status).toBe(404);
  });

  it("links to a purchase on an archived account and unlinks it again", async () => {
    const purchase = post({ accountId: card, money: { amountMinor: "-10000", currency: "USD" } });
    const refund = post({ kind: "refund", money: { amountMinor: "10000", currency: "USD" } });
    await archive(card);
    const frozen = api.db.prepare("SELECT kind, amount_cents, posted_date, lifecycle, category_id FROM transactions WHERE id = ?")
      .get(purchase.id);
    expect((await link(1, refund, purchase)).status).toBe(201);
    expect((await unlink(1)).status).toBe(200);
    expect(api.db.prepare("SELECT kind, amount_cents, posted_date, lifecycle, category_id FROM transactions WHERE id = ?")
      .get(purchase.id)).toEqual(frozen);
  });

  it("refuses wrong kinds, voided rows and a second link, and replays by client ID", async () => {
    const purchase = post({ money: { amountMinor: "-10000", currency: "USD" } });
    const other = post({ money: { amountMinor: "-5000", currency: "USD" } });
    const refund = post({ kind: "refund", money: { amountMinor: "1000", currency: "USD" } });
    const income = post({ kind: "income", money: { amountMinor: "1000", currency: "USD" } });
    const voided = post({ kind: "refund", money: { amountMinor: "1000", currency: "USD" } });
    voidDirectly(voided.id);
    for (const [refundRow, purchaseRow] of [[income, purchase], [refund, income],
      [voided, purchase], [purchase, refund]] as [Posted, Posted][]) {
      const response = await link(1, refundRow, purchaseRow);
      expect(response.status).toBe(422);
    }
    expect((await api.request("/api/refund-links", { method: "POST",
      body: { id: linkId(1), refundId: uuid(9, "10000000"), purchaseId: purchase.id } })).status).toBe(404);
    const created = await link(1, refund, purchase);
    expect(created.status).toBe(201);
    const before = snapshot();
    const replay = await api.request("/api/refund-links", { method: "POST",
      body: { id: linkId(1).toUpperCase(), refundId: refund.id.toUpperCase(), purchaseId: purchase.id } });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(created.body);
    expect(snapshot()).toEqual(before);
    const conflict = await link(1, refund, other);
    expect(conflict.status).toBe(409);
    expect(code(conflict)).toBe("client_id_conflict");
    const second = await link(2, refund, other);
    expect(second.status).toBe(409);
    expect(code(second)).toBe("refund_already_linked");
    expect(snapshot()).toEqual(before);
  });

  it("finds candidate purchases with explicit filters and paging, including archived accounts", async () => {
    const refund = post({ kind: "refund", merchant: "SYNTHETIC OUTFITTER RETURN", money: { amountMinor: "6000", currency: "USD" } });
    const target = post({ accountId: card, postedDate: "2026-04-03", merchant: "SYNTHETIC OUTFITTER",
      money: { amountMinor: "-10000", currency: "USD" } });
    const earlier = post({ accountId: card, postedDate: "2026-04-02", merchant: "SYNTHETIC OUTFITTER",
      money: { amountMinor: "-6000", currency: "USD" } });
    post({ postedDate: "2026-04-04", merchant: "SYNTHETIC MARKET" });
    post({ postedDate: "2026-04-05", kind: "refund", merchant: "SYNTHETIC OUTFITTER",
      money: { amountMinor: "100", currency: "USD" } });
    const priorRefund = post({ postedDate: "2026-04-06", kind: "refund", merchant: "OTHER",
      money: { amountMinor: "6000", currency: "USD" } });
    expect((await link(1, priorRefund, target)).status).toBe(201);
    await archive(card);
    const first = await api.request(`/api/transactions/${refund.id}/refund-candidates?q=outfitter&limit=1`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ items: [{ transaction: { id: target.id },
      linkedRefundTotal: { amountMinor: "6000" }, wouldExceedPurchase: true }] });
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    const next = await api.request(`/api/transactions/${refund.id}/refund-candidates?q=OUTFITTER&limit=1&cursor=${cursor}`);
    expect(next.body).toMatchObject({ items: [{ transaction: { id: earlier.id }, linkedRefundTotal: { amountMinor: "0" },
      wouldExceedPurchase: false }], nextCursor: null });
    const mismatch = await api.request(`/api/transactions/${refund.id}/refund-candidates?q=market&limit=1&cursor=${cursor}`);
    expect(code(mismatch)).toBe("cursor_filter_mismatch");
    for (const bad of ["kind=refund", "from=2026-04-05&to=2026-04-05", "q=%20%20", "month=2026-04"]) {
      const response = await api.request(`/api/transactions/${refund.id}/refund-candidates?${bad}`);
      expect(response.status).toBe(400);
      expect(code(response)).toBe("invalid_request");
    }
    // The already-linked refund does not count itself twice: 6000 of 10000, not 12000.
    const fromLinked = await api.request(`/api/transactions/${priorRefund.id}/refund-candidates?q=outfitter&limit=1`);
    expect(fromLinked.body).toMatchObject({ items: [{ transaction: { id: target.id },
      linkedRefundTotal: { amountMinor: "6000" }, wouldExceedPurchase: false }] });
    // A negative source cannot be a refund: it neither adds to nor offsets an existing excess.
    const topUp = post({ postedDate: "2026-04-07", kind: "refund", money: { amountMinor: "5000", currency: "USD" } });
    expect((await link(2, topUp, target)).status).toBe(201);
    const fromPurchase = await api.request(`/api/transactions/${earlier.id}/refund-candidates?q=outfitter&limit=1`);
    expect(fromPurchase.body).toMatchObject({ items: [{ transaction: { id: target.id },
      linkedRefundTotal: { amountMinor: "11000" }, wouldExceedPurchase: true }] });
    const byAccount = await api.request(`/api/transactions/${refund.id}/refund-candidates?accountId=${checking}`);
    expect((byAccount.body as { items: { transaction: { kind: string; accountId: string } }[] }).items
      .every(item => item.transaction.kind === "purchase" && item.transaction.accountId === checking)).toBe(true);
  });
});

describe("type changes", () => {
  it("never flips a sign and applies each type's category policy", async () => {
    const purchase = post({ merchant: "SYNTHETIC MARKET" });
    const deposit = post({ kind: "income", money: { amountMinor: "5000", currency: "USD" } });
    const mismatch = await classify(purchase, { kind: "income" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: "kind_sign_mismatch", fieldErrors: [{ path: "/kind" }] });
    expect(code(await classify(deposit, { kind: "purchase", category: { mode: "rules" } }))).toBe("kind_sign_mismatch");
    expect(code(await classify(deposit, { kind: "refund" }))).toBe("validation_failed");
    expect(code(await classify(deposit, { kind: "transfer", category: { mode: "rules" } }))).toBe("validation_failed");
    expect(code(await classify(deposit, { kind: "refund", category: { mode: "category", categoryId: INCOME_CATEGORY } })))
      .toBe("validation_failed");

    const refund = await classify(deposit, { kind: "refund", category: { mode: "category", categoryId: FOOD } });
    expect(refund.status).toBe(200);
    expect(refund.body).toMatchObject({ transaction: { kind: "refund", categoryId: FOOD, money: { amountMinor: "5000" },
      assignment: { origin: "manual" }, version: "2" } });
    expect((await classify(deposit, { kind: "income" })).body).toMatchObject({ transaction: { kind: "income",
      categoryId: INCOME_CATEGORY, assignment: { origin: "system" }, version: "3" } });
    expect((await api.request("/api/rules", { method: "POST", body: { id: uuid(1, "60000000"), matchType: "contains",
      pattern: "synthetic market", categoryId: FOOD } })).status).toBe(201);
    const toTransfer = await classify(purchase, { kind: "transfer" });
    expect(toTransfer.body).toMatchObject({ transaction: { kind: "transfer", categoryId: null } });
    const back = await classify(purchase, { kind: "purchase", category: { mode: "rules" } });
    expect(back.body).toMatchObject({ transaction: { kind: "purchase", categoryId: FOOD,
      assignment: { origin: "rule", ruleId: uuid(1, "60000000") }, money: { amountMinor: "-8000" } } });
    expect((await history(purchase.id))[0]).toMatchObject({ eventType: "kind_changed",
      before: { kind: "transfer", categoryId: null }, after: { kind: "purchase", categoryId: FOOD, categoryName: "Food",
        assignmentOrigin: "rule" }, ruleId: uuid(1, "60000000"), ruleRevision: "1" });
  });

  it("refuses an archived category, a missing session and a missing CSRF token", async () => {
    const deposit = post({ kind: "income", money: { amountMinor: "5000", currency: "USD" } });
    const category = await api.request(`/api/categories/${FOOD}`);
    expect((await api.request(`/api/categories/${FOOD}/archive`, { method: "POST",
      headers: { "if-match": category.headers.get("etag") ?? "" },
      body: { ruleResolutions: [], ruleSetRevision: "0", budgetPlanVersion: null } })).status).toBe(200);
    const archived = await classify(deposit, { kind: "refund", category: { mode: "category", categoryId: FOOD } });
    expect(archived.status).toBe(409);
    expect(code(archived)).toBe("category_archived");
    const noCsrf = await api.request(`/api/transactions/${deposit.id}/classify`, { method: "POST", csrfToken: null,
      headers: { "if-match": '"1"' }, body: { kind: "transfer" } });
    expect(noCsrf.status).toBe(403);
    expect((await api.request("/api/refund-links", { method: "POST", csrfToken: null,
      body: { id: linkId(1), refundId: deposit.id, purchaseId: deposit.id } })).status).toBe(403);
    const signedOut = { omitCookie: true };
    for (const path of [`/api/transactions/${deposit.id}/transfer-candidates`,
      `/api/transactions/${deposit.id}/refund-candidates`, `/api/transfer-pairs/${pairId(1)}`, `/api/refund-links/${linkId(1)}`]) {
      expect((await api.request(path, signedOut)).status).toBe(401);
    }
    expect((await api.request("/api/transfer-pairs", { method: "POST", ...signedOut,
      body: { id: pairId(1), legs: [], confirmKindChanges: false } })).status).toBe(401);
    expect((await detail(deposit.id))["version"]).toBe("1");
  });

  it("writes nothing for an unchanged type and leaves the ledger revision alone", async () => {
    const transfer = post({ kind: "transfer" });
    const before = snapshot();
    const same = await classify(transfer, { kind: "transfer" }, 1);
    expect(same.status).toBe(200);
    expect(same.headers.get("etag")).toBe('"1"');
    expect(snapshot()).toEqual(before);
    const accounts = snapshot().accounts;
    expect((await classify(transfer, { kind: "purchase", category: { mode: "rules" } }, 1)).status).toBe(200);
    expect(snapshot().accounts).toEqual(accounts);
    expect((await classify(transfer, { kind: "purchase", category: { mode: "rules" } }, 1)).status).toBe(412);
  });

  it("requires confirming exactly the links a type change breaks, then unlinks and changes together", async () => {
    const out = post({ kind: "transfer" });
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    expect((await pair(1, [out, into])).status).toBe(201);
    const before = snapshot();
    for (const confirmUnlink of [undefined, { transferPairIds: [], refundLinkIds: [] },
      { transferPairIds: [pairId(2)], refundLinkIds: [] }, { transferPairIds: [pairId(1)], refundLinkIds: [linkId(1)] }]) {
      const response = await classify(out, { kind: "purchase", category: { mode: "rules" }, confirmUnlink });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "unlink_confirmation_required",
        requiredUnlinks: { transferPairIds: [pairId(1)], refundLinkIds: [] } });
    }
    expect(snapshot()).toEqual(before);
    const revision = (before.metadata as { finance_revision: bigint }).finance_revision;
    const done = await classify(out, { kind: "purchase", category: { mode: "rules" },
      confirmUnlink: { transferPairIds: [pairId(1).toUpperCase()], refundLinkIds: [] } });
    expect(done.status).toBe(200);
    expect(done.headers.get("etag")).toBe('"3"');
    expect(done.body).toMatchObject({ transaction: { kind: "purchase", transferPairId: null, version: "3" },
      unlinked: { transferPairIds: [pairId(1)], refundLinkIds: [] }, financeRevision: String(revision + 1n) });
    expect(snapshot().accounts).toEqual(before.accounts);
    expect(await detail(into.id)).toMatchObject({ kind: "transfer", transferPairId: null, version: "3",
      money: into.money });
    expect(await unmatched()).toBe(1);
  });

  it("changing a purchase with two refunds confirms both links and keeps both refunds' months and categories", async () => {
    const purchase = post({ money: { amountMinor: "-10000", currency: "USD" } });
    const refunds = ["3000", "7000"].map(amount => post({ accountId: card, postedDate: "2026-05-01", kind: "refund",
      money: { amountMinor: amount, currency: "USD" }, category: { mode: "category", categoryId: FOOD } }));
    expect((await link(1, refunds[0]!, purchase)).status).toBe(201);
    expect((await link(2, refunds[1]!, purchase)).status).toBe(201);
    const may = await summary("2026-05");
    const refused = await classify(purchase, { kind: "transfer", confirmUnlink: {
      transferPairIds: [], refundLinkIds: [linkId(1), linkId(1)] } });
    expect(refused.status).toBe(422);
    const response = await classify(purchase, { kind: "transfer",
      confirmUnlink: { transferPairIds: [], refundLinkIds: [linkId(2), linkId(1)] } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ transaction: { kind: "transfer", linkedRefundCount: 0 },
      unlinked: { refundLinkIds: [linkId(1), linkId(2)] } });
    for (const refund of refunds) {
      expect(await detail(refund.id)).toMatchObject({ kind: "refund", refundLink: null, categoryId: FOOD,
        postedDate: "2026-05-01", money: refund.money });
    }
    const after = await summary("2026-05");
    expect(after.spending).toEqual(may.spending);
    expect(after.categories).toEqual(may.categories);
  });
});

describe("the 500-refund bound", () => {
  it("lets a type change confirm all 500 links, and refuses a 501st link", async () => {
    const purchase = post({ money: { amountMinor: "-10000", currency: "USD" } });
    const ids: string[] = [];
    for (let index = 1; index <= 500; index += 1) {
      const refund = post({ accountId: card, kind: "refund", money: { amountMinor: "1", currency: "USD" } });
      // Arranged directly for speed: the link command itself is covered above.
      api.db.prepare(`INSERT INTO refund_links (id, refund_id, purchase_id, creation_digest, version, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`).run(linkId(index), refund.id, purchase.id, "0".repeat(64), api.clock.now());
      ids.push(linkId(index));
    }
    const extra = post({ accountId: card, kind: "refund", money: { amountMinor: "1", currency: "USD" } });
    const refused = await link(501, extra, purchase);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ fieldErrors: [{ path: "/purchaseId" }] });
    const required = await classify(purchase, { kind: "transfer" });
    expect(required.status).toBe(409);
    expect((required.body as { requiredUnlinks: { refundLinkIds: string[] } }).requiredUnlinks.refundLinkIds).toEqual(ids);
    const done = await classify(purchase, { kind: "transfer", confirmUnlink: { transferPairIds: [], refundLinkIds: ids } });
    expect(done.status).toBe(200);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM refund_links").get()).toEqual({ n: 0n });
  });
});

describe("the 500-refund bound when pairing", () => {
  it("names only one leg's links, within the contract's bound, when both legs have refund links", async () => {
    const purchase = post({ money: { amountMinor: "-10000", currency: "USD" } });
    for (let index = 1; index <= 500; index += 1) {
      const refund = post({ accountId: card, kind: "refund", money: { amountMinor: "1", currency: "USD" } });
      api.db.prepare(`INSERT INTO refund_links (id, refund_id, purchase_id, creation_digest, version, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`).run(linkId(index), refund.id, purchase.id, "0".repeat(64), api.clock.now());
    }
    const elsewhere = post({ accountId: savings, money: { amountMinor: "-10000", currency: "USD" } });
    const refundLeg = post({ accountId: card, kind: "refund", money: { amountMinor: "10000", currency: "USD" } });
    expect((await link(501, refundLeg, elsewhere)).status).toBe(201);
    const refused = await pair(1, [purchase, refundLeg], true);
    expect(refused.status).toBe(409);
    const ids = (refused.body as { requiredUnlinks: { refundLinkIds: string[] } }).requiredUnlinks.refundLinkIds;
    expect(ids).toHaveLength(500);
    expect(ids).not.toContain(linkId(501));
  });
});

describe("atomicity", () => {
  const context = () => ({ db: api.db, now: api.clock.now(), today: easternDate(api.clock.now()), newId: api.deps.newId });
  const failingCheck = () => { throw new Error("injected failure after the writes"); };

  it("a failure after unlinking but before the response rolls back the unlink and the type change", async () => {
    const out = post({ kind: "transfer" });
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    expect((await pair(1, [out, into])).status).toBe(201);
    const before = snapshot();
    expect(() => withWriteTransaction(api.db, () => classifyTransaction(context(), out.id, 2n,
      { kind: "purchase", category: { mode: "rules" }, confirmUnlink: { transferPairIds: [pairId(1)], refundLinkIds: [] } },
      failingCheck))).toThrow("injected failure");
    expect(snapshot()).toEqual(before);
  });

  it("a failure after pairing with type changes leaves no pair and no type change", async () => {
    const payment = post();
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const before = snapshot();
    expect(() => withWriteTransaction(api.db, () => createTransferPair(context(), { id: pairId(1),
      confirmKindChanges: true, legs: [{ transactionId: payment.id, version: "1" }, { transactionId: into.id, version: "1" }] },
    failingCheck))).toThrow("injected failure");
    expect(snapshot()).toEqual(before);
    expect((await pair(1, [payment, into], true)).status).toBe(201);
  });

  it("the database itself refuses invalidating a paired or linked record without unlinking", async () => {
    const out = post({ kind: "transfer" });
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const purchase = post({ merchant: "SYNTHETIC MARKET", postedDate: "2026-04-02" });
    const refund = post({ kind: "refund", money: { amountMinor: "1000", currency: "USD" } });
    expect((await pair(1, [out, into])).status).toBe(201);
    expect((await link(1, refund, purchase)).status).toBe(201);
    expect(() => api.db.prepare(`UPDATE transactions SET kind = 'purchase', category_id = ?, assignment_origin = 'unassigned'
      WHERE id = ?`).run(UNCATEGORIZED, out.id)).toThrow("unlink transfer before an invalidating change");
    expect(() => api.db.prepare("UPDATE transactions SET kind = 'transfer', category_id = NULL, assignment_origin = 'system' WHERE id = ?")
      .run(purchase.id)).toThrow("unlink refunds before an invalidating change");
  });
});

describe("review counts and account deletion", () => {
  it("counts unmatched transfers immediately and excludes voided ones", async () => {
    const out = post({ kind: "transfer" });
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    const stray = post({ accountId: savings, kind: "transfer", postedDate: "2026-04-10" });
    expect(await unmatched()).toBe(3);
    expect((await pair(1, [out, into])).status).toBe(201);
    expect(await unmatched()).toBe(1);
    voidDirectly(stray.id);
    expect(await unmatched()).toBe(0);
    expect((await unpair(1)).status).toBe(200);
    expect(await unmatched()).toBe(2);
  });

  it("names transfer legs among the references that block deleting an account", async () => {
    const out = post({ kind: "transfer" });
    const into = post({ accountId: card, kind: "transfer", money: { amountMinor: "8000", currency: "USD" } });
    expect((await pair(1, [out, into])).status).toBe(201);
    const response = await api.request(`/api/accounts/${card}`, { method: "DELETE", headers: { "if-match": '"1"' } });
    expect(response.status).toBe(409);
    expect((response.body as { blocking: { kind: string; ids: string[] }[] }).blocking)
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "transfer_leg", ids: [into.id] })]));
  });
});
