import { withWriteTransaction } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postThroughService, uuid } from "./finance-harness.js";

let api: TestServer;
let accountId: string;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  accountId = (await createAccount(api)).id;
});
afterEach(async () => { await api.close(); });
const post = (kind: "purchase" | "refund" | "transfer" = "purchase", cents = "-100", account = accountId) =>
  postThroughService(api, { accountId: account, kind, money: { amountMinor: cents, currency: "USD" },
    postedDate: "2026-04-02", merchant: "SYNTHETIC READ FIXTURE" });
type Page = { items: { id: string }[]; nextCursor: string | null };

// Persisted-event fixtures test the read model, not the future correction commands.
function historyFixture(id: string, eventId: string, time: number, event = "note_changed") {
  api.db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source,
    reason, before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json)
    VALUES (?, ?, ?, ?, 'owner', NULL, NULL, '{"note":"synthetic history fixture"}', NULL, NULL, NULL, NULL, '[]')`)
    .run(eventId, id, time, event);
}

describe("transaction history keyset reads", () => {
  it("pages more than 100 tied events without duplicates and permits unrelated changes and page-size changes", async () => {
    const row = post();
    const other = post();
    const eventIds = Array.from({ length: 106 }, (_, index) => uuid(index + 1, "aaaaaaaa"));
    withWriteTransaction(api.db, () => {
      for (const id of eventIds) historyFixture(row.id, id, api.clock.now());
    });
    const first = await api.request(`/api/transactions/${row.id}/history`);
    expect(first.status).toBe(200);
    const page = first.body as Page;
    // The contract's default history page is 25.
    expect(page.items).toHaveLength(25);
    expect(page.items.map(item => item.id)).toEqual([...eventIds].reverse().slice(0, 25));
    expect(page.nextCursor).not.toBeNull();
    const seen = page.items.map(item => item.id);
    // Neither a new posting (finance revision) nor another transaction's history expires a cursor.
    post();
    historyFixture(other.id, uuid(999, "aaaaaaaa"), api.clock.now() + 1);
    let cursor = page.nextCursor;
    while (cursor !== null) {
      const response = await api.request(`/api/transactions/${row.id.toUpperCase()}/history?limit=17&cursor=${cursor}`);
      expect(response.status).toBe(200);
      const next = response.body as Page;
      seen.push(...next.items.map(item => item.id));
      cursor = next.nextCursor;
    }
    expect(seen).toHaveLength(107);
    expect(new Set(seen).size).toBe(107);
    expect(seen.slice(0, 106)).toEqual([...eventIds].reverse());
    const cross = await api.request(`/api/transactions/${other.id}/history?cursor=${page.nextCursor}`);
    expect(cross.status).toBe(400);
    expect(cross.body).toMatchObject({ code: "cursor_filter_mismatch" });
    const max = await api.request(`/api/transactions/${row.id}/history?limit=100`);
    expect((max.body as Page).items).toHaveLength(100);
    await api.restart();
    expect((await api.request(`/api/transactions/${row.id}/history?cursor=${page.nextCursor}`)).status).toBe(200);
  });

  it("orders timestamps before UUIDs and returns null cursor for exactly a full page", async () => {
    const row = post();
    historyFixture(row.id, uuid(1, "aaaaaaaa"), api.clock.now() + 1);
    historyFixture(row.id, uuid(1, "bbbbbbbb"), api.clock.now());
    const page = await api.request(`/api/transactions/${row.id}/history?limit=3`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ nextCursor: null, items: [
      { id: uuid(1, "aaaaaaaa") }, { id: uuid(1, "bbbbbbbb") }, { eventType: "imported" },
    ] });
  });

  it.each(["", "!", "a", "e30", "a".repeat(2049), Buffer.from("null").toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, scope: "a".repeat(64), time: "9007199254740992", id: uuid(1) })).toString("base64url"),
  ])("refuses malformed cursor %s", async cursor => {
    const row = post();
    const response = await api.request(`/api/transactions/${row.id}/history?cursor=${cursor}`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_cursor" });
  });

  it.each(["0", "101", "-1", "1.5", "1e2", "01", "", "x", "50&limit=50"])("refuses page size %s", async limit => {
    const row = post();
    const response = await api.request(`/api/transactions/${row.id}/history?limit=${limit}`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_request" });
  });
});

describe("full transaction read model", () => {
  it("reflects stored relationship membership, not guessed matches", async () => {
    const purchase = post();
    const refund = post("refund", "50");
    const refund2 = post("refund", "80");
    const account2 = (await createAccount(api, { id: uuid(2) })).id;
    const debit = post("transfer", "-100");
    const credit = post("transfer", "100", account2);
    // Relationship commands are Phase 4; only DTO mapping is under test here.
    withWriteTransaction(api.db, () => {
      for (const [index, row] of [refund, refund2].entries()) {
        api.db.prepare(`INSERT INTO refund_links (id, refund_id, purchase_id, creation_digest, version, created_at)
          VALUES (?, ?, ?, ?, 1, ?)`).run(uuid(index + 1, "91000000"), row.id, purchase.id, "a".repeat(64), api.clock.now());
      }
      api.db.prepare(`INSERT INTO transfer_pairs (id, creation_digest, version, created_at) VALUES (?, ?, 1, ?)`)
        .run(uuid(1, "90000000"), "a".repeat(64), api.clock.now());
      for (const [index, row] of [debit, credit].entries()) {
        api.db.prepare("INSERT INTO transfer_legs (pair_id, slot, transaction_id) VALUES (?, ?, ?)")
          .run(uuid(1, "90000000"), index + 1, row.id);
      }
    });
    expect((await api.request(`/api/transactions/${purchase.id}`)).body).toMatchObject({ linkedRefundCount: 2, refundLink: null });
    expect((await api.request(`/api/transactions/${refund.id}`)).body).toMatchObject({
      refundLink: { linkId: uuid(1, "91000000"), purchaseId: purchase.id }, linkedRefundCount: 0,
    });
    for (const row of [debit, credit]) {
      expect((await api.request(`/api/transactions/${row.id}`)).body).toMatchObject({ transferPairId: uuid(1, "90000000") });
    }
  });

  it("shows retained originals and void time, including after values are repaired back to the originals", async () => {
    const row = post();
    // Stored-state read test, not repair/void command evidence (Phase 5).
    withWriteTransaction(api.db, () => {
      api.db.prepare(`UPDATE transactions SET posted_date = '2026-04-03', amount_cents = -200,
        lifecycle = 'void', voided_at = ?, version = 2 WHERE id = ?`).run(api.clock.now(), row.id);
      historyFixture(row.id, uuid(1, "aaaaaaaa"), api.clock.now(), "amount_corrected");
    });
    const changed = await api.request(`/api/transactions/${row.id}`);
    expect(changed.headers.get("etag")).toBe('"2"');
    expect(changed.body).toMatchObject({ postedDate: "2026-04-03", money: { amountMinor: "-200" }, lifecycle: "void",
      voidedAt: "2026-05-02T13:55:00Z", correction: { originalPostedDate: row.postedDate, originalMoney: row.money },
      importId: null, sourceRowNumber: null });
    api.db.prepare("UPDATE transactions SET posted_date = ?, amount_cents = ? WHERE id = ?")
      .run(row.postedDate, BigInt(row.money.amountMinor), row.id);
    expect((await api.request(`/api/transactions/${row.id}`)).body).toMatchObject({
      correction: { originalPostedDate: row.postedDate, originalMoney: row.money },
    });
    expect(() => api.db.prepare("UPDATE transactions SET original_amount_cents = -200 WHERE id = ?").run(row.id)).toThrow();
  });
});
