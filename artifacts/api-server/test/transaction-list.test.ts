import { withWriteTransaction } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PostingInput } from "../src/lib/transaction-schemas.js";
import { startTestServer, type TestServer } from "./harness.js";
import { balanceOf, createAccount, postThroughService, UNCATEGORIZED, uuid } from "./finance-harness.js";

let api: TestServer;
let checking: string;
let card: string;
const FOOD = "abcdef00-0000-4000-8000-000000000001";

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  checking = (await createAccount(api, { id: uuid(1), openingMinor: "200000", trackingStartDate: "2026-03-01" })).id;
  card = (await createAccount(api, { id: uuid(2), kind: "credit_card", displayName: "Synthetic Card", openingMinor: "0", trackingStartDate: "2026-03-01" })).id;
  expect((await api.request("/api/categories", { method: "POST", body: { id: FOOD, name: "Food", color: "#123456" } })).status).toBe(201);
});
afterEach(async () => { await api.close(); });

const post = (patch: Partial<PostingInput> = {}) => postThroughService(api, {
  accountId: checking, postedDate: "2026-04-02", merchant: "SYNTHETIC SHOP", kind: "purchase",
  money: { amountMinor: "-1000", currency: "USD" }, ...patch,
});
type Page = {
  items: { id: string; postedDate: string }[]; nextCursor: string | null; financeRevision: string;
  totals: { matchingCount: number; purchases: { amountMinor: string }; refunds: { amountMinor: string };
    netSpending: { amountMinor: string }; income: { amountMinor: string } };
};
const list = async (query = "") => {
  const response = await api.request(`/api/transactions${query === "" ? "" : `?${query}`}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.body as Page;
};
const voidRow = (id: string) => withWriteTransaction(api.db, () => {
  // Stored-state fixture for list filtering only; the void command is Phase 5.
  api.db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ?, version = version + 1 WHERE id = ?")
    .run(api.clock.now(), id);
});
const allPages = async (query: string) => {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await list(`${query}${cursor === null ? "" : `&cursor=${cursor}`}`);
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return seen;
};

describe("transaction list paging and totals", () => {
  it("pages more than 50 tied-date rows by date then id, with totals over the whole scope", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 57; index += 1) ids.push(post({ postedDate: index < 7 ? "2026-04-03" : "2026-04-02" }).id);
    post({ kind: "refund", money: { amountMinor: "250", currency: "USD" }, postedDate: "2026-03-30" });
    post({ kind: "income", money: { amountMinor: "50000", currency: "USD" }, postedDate: "2026-04-01" });
    post({ kind: "transfer", money: { amountMinor: "-7000", currency: "USD" }, postedDate: "2026-04-01" });
    const first = await list();
    expect(first.items).toHaveLength(50);
    expect(first.totals).toEqual({ matchingCount: 60, purchases: { amountMinor: "57000", currency: "USD" },
      refunds: { amountMinor: "250", currency: "USD" }, netSpending: { amountMinor: "56750", currency: "USD" },
      income: { amountMinor: "50000", currency: "USD" } });
    const expected = [...ids.slice(0, 7).sort().reverse(), ...ids.slice(7).sort().reverse()];
    expect(first.items.map(item => item.id)).toEqual(expected.slice(0, 50));
    const second = await list(`cursor=${first.nextCursor}`);
    expect(second.totals).toEqual(first.totals);
    expect(second.items.slice(0, 7).map(item => item.id)).toEqual(expected.slice(50));
    expect(second.nextCursor).toBeNull();
    const all = await allPages("limit=7");
    expect(all).toHaveLength(60);
    expect(new Set(all).size).toBe(60);
    expect((await list("limit=200")).items).toHaveLength(60);
  });

  it("keeps paging through unrelated category and note edits and across restart", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => post({ postedDate: `2026-04-0${index + 1}` }));
    const first = await list("limit=2");
    const edited = rows[0]!;
    const note = await api.request(`/api/transactions/${edited.id}/note`, { method: "PATCH",
      headers: { "if-match": '"1"' }, body: { note: "unrelated edit" } });
    expect(note.status).toBe(200);
    const categorized = await api.request(`/api/transactions/${rows[1]!.id}/categorize`, { method: "POST",
      headers: { "if-match": '"1"' }, body: { categoryId: FOOD } });
    expect(categorized.status).toBe(200);
    post({ postedDate: "2026-04-09" });
    await api.restart();
    const second = await list(`limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map(item => item.id)).toEqual([rows[2]!.id, rows[1]!.id]);
    expect(Number(second.financeRevision)).toBeGreaterThan(Number(first.financeRevision));
  });

  it("combines every filter with AND and treats search text literally", async () => {
    const food = post({ merchant: "Synthetic 100%_Market (A+)", category: { mode: "category", categoryId: FOOD },
      postedDate: "2026-04-10" });
    const note = post({ merchant: "OTHER PLACE", note: "Paid at the \uff2d\uff21\uff32\uff2b\uff25\uff34  stall", postedDate: "2026-04-11" });
    const cardRow = post({ accountId: card, merchant: "SYNTHETIC 100%_MARKET", postedDate: "2026-04-12" });
    const other = post({ merchant: "Synthetic 100x Market", postedDate: "2026-04-13" });
    const march = post({ merchant: "synthetic 100%_market", postedDate: "2026-03-31" });
    const refund = post({ kind: "refund", merchant: "synthetic 100%_market refund", postedDate: "2026-04-14",
      money: { amountMinor: "300", currency: "USD" } });
    const q = encodeURIComponent("100%_market");
    const ids = async (query: string) => (await list(query)).items.map(item => item.id);
    expect(await ids(`q=${q}`)).toEqual([refund.id, cardRow.id, food.id, march.id]);
    expect(await ids(`q=${encodeURIComponent("  MARKET ")}&month=2026-04`)).toEqual(
      [refund.id, other.id, cardRow.id, note.id, food.id]);
    expect(await ids(`q=${encodeURIComponent("(a+)")}`)).toEqual([food.id]);
    expect(await ids(`q=${encodeURIComponent(".*")}`)).toEqual([]);
    expect(await ids(`q=${q}&accountId=${card.toUpperCase()}`)).toEqual([cardRow.id]);
    expect(await ids(`q=${q}&categoryId=${FOOD}`)).toEqual([food.id]);
    expect(await ids(`q=${q}&categoryId=${UNCATEGORIZED}&kind=purchase`)).toEqual([cardRow.id, march.id]);
    expect(await ids(`q=${q}&origin=manual`)).toEqual([food.id]);
    expect(await ids(`q=${q}&from=2026-04-01&to=2026-04-14`)).toEqual([cardRow.id, food.id]);
    expect(await ids(`q=${q}&kind=refund&month=2026-04`)).toEqual([refund.id]);
    const totals = (await list(`q=${q}&month=2026-04`)).totals;
    expect(totals).toMatchObject({ matchingCount: 3, purchases: { amountMinor: "2000" }, refunds: { amountMinor: "300" },
      netSpending: { amountMinor: "1700" } });
  });

  it("searches notes by their stored search form, legacy notes on read, and Greek sigma both ways", async () => {
    const greek = post({ merchant: "\u039f\u0394\u039f\u03a3 \u039a\u0391\u03a6\u0395" });
    const noted = post({ merchant: "PLAIN", note: "  Weekly   \uff2d\uff21\uff32\uff2b\uff25\uff34 " });
    const legacy = post({ merchant: "PLAIN" });
    expect(api.db.prepare("SELECT normalized_note FROM transactions WHERE id = ?").get(noted.id))
      .toEqual({ normalized_note: "weekly market" });
    // A pre-Stage-3 style row: a note with no stored search form.
    api.db.prepare("UPDATE transactions SET note = 'Legacy MARKET stall' WHERE id = ?").run(legacy.id);
    const ids = async (q: string) => (await list(`q=${encodeURIComponent(q)}`)).items.map(item => item.id);
    expect(await ids("market")).toEqual([legacy.id, noted.id].sort().reverse());
    for (const q of ["\u039f\u0394\u039f\u03a3", "\u03bf\u03b4\u03bf\u03c3", "\u03bf\u03b4\u03bf\u03c2", "\u03a3"]) {
      expect(await ids(q)).toEqual([greek.id]);
    }
    expect((await api.request(`/api/transactions/${noted.id}/note`, { method: "PATCH", headers: { "if-match": '"1"' },
      body: { note: null } })).status).toBe(200);
    expect(api.db.prepare("SELECT normalized_note FROM transactions WHERE id = ?").get(noted.id)).toEqual({ normalized_note: null });
    expect(await ids("weekly")).toEqual([]);
    expect(() => api.db.prepare("UPDATE transactions SET normalized_note = 'x' WHERE id = ?").run(noted.id)).toThrow();
  });

  it("lists voids only when asked and never counts their money", async () => {
    const kept = post({ money: { amountMinor: "-500", currency: "USD" } });
    const voided = post({ money: { amountMinor: "-900", currency: "USD" } });
    voidRow(voided.id);
    const active = await list();
    expect(active.items.map(item => item.id)).toEqual([kept.id]);
    expect(active.totals).toMatchObject({ matchingCount: 1, purchases: { amountMinor: "500" } });
    const voids = await list("lifecycle=void");
    expect(voids.items.map(item => item.id)).toEqual([voided.id]);
    expect(voids.totals).toMatchObject({ matchingCount: 1, purchases: { amountMinor: "0" }, netSpending: { amountMinor: "0" } });
    const all = await list("lifecycle=all");
    expect(all.items).toHaveLength(2);
    expect(all.totals).toMatchObject({ matchingCount: 2, purchases: { amountMinor: "500" } });
  });

  it("rejects a cursor used with different filters and malformed cursors", async () => {
    for (let index = 0; index < 3; index += 1) post();
    const page = await list("limit=1&kind=purchase");
    expect((await list(`limit=2&kind=purchase&cursor=${page.nextCursor}`)).items).toHaveLength(2);
    for (const query of ["kind=refund", "", "lifecycle=all", "q=shop"]) {
      const response = await api.request(`/api/transactions?${query}&cursor=${page.nextCursor}`);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "cursor_filter_mismatch" });
    }
    const forged = (body: unknown) => Buffer.from(JSON.stringify(body)).toString("base64url");
    for (const cursor of ["!", "a".repeat(513), "e30", forged({ v: 1, scope: "a".repeat(64), date: "2026-02-30", id: uuid(1) }),
      forged({ v: 2, scope: "a".repeat(64), date: "2026-02-01", id: uuid(1) }), `${page.nextCursor}=`]) {
      const response = await api.request(`/api/transactions?cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "invalid_cursor" });
    }
  });

  it.each([
    ["month=2026-04&from=2026-04-01", 400, "invalid_request"], ["month=2026-13", 400, "invalid_request"],
    ["from=2026-02-30", 400, "invalid_request"], ["kind=loan", 400, "invalid_request"],
    ["kind=purchase&kind=refund", 400, "invalid_request"], ["accountId=nope", 400, "invalid_request"],
    ["limit=0", 400, "invalid_request"], ["limit=201", 400, "invalid_request"], ["limit=1.5", 400, "invalid_request"],
    ["sort=asc", 400, "invalid_request"], ["q=", 400, "invalid_request"], [`q=${"a".repeat(201)}`, 400, "invalid_request"],
    ["q=%20%20", 422, "validation_failed"], ["from=2026-04-02&to=2026-04-02", 422, "validation_failed"],
  ])("refuses %s", async (query, status, code) => {
    const response = await api.request(`/api/transactions?${query}`);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code });
  });

  it("accepts 200 emoji search characters but not 201, and requires a session", async () => {
    expect((await api.request(`/api/transactions?q=${encodeURIComponent("\u{1F600}".repeat(200))}`)).status).toBe(200);
    expect((await api.request(`/api/transactions?q=${encodeURIComponent("\u{1F600}".repeat(201))}`)).status).toBe(400);
    expect((await api.request("/api/transactions", { omitCookie: true })).status).toBe(401);
  });

  it("proves $2,000 - $100 + $500 = $2,400 through posting, the list and the balance", async () => {
    post({ money: { amountMinor: "-10000", currency: "USD" } });
    post({ kind: "income", money: { amountMinor: "50000", currency: "USD" } });
    expect((await list(`accountId=${checking}`)).totals).toMatchObject({ matchingCount: 2,
      purchases: { amountMinor: "10000" }, income: { amountMinor: "50000" } });
    expect(balanceOf(await api.request(`/api/accounts/${checking}/balance?asOf=2026-04-30`))).toBe("240000");
  });
});
