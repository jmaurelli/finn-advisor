import { withWriteTransaction } from "@workspace/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { easternDate } from "../src/domain/dates.js";
import type { RepairPreview } from "../src/lib/repair-schemas.js";
import { RepairResult } from "../src/lib/repair-schemas.js";
import { checkedResponse } from "../src/lib/respond.js";
import type { PostingInput } from "../src/lib/transaction-schemas.js";
import { applyRepair } from "../src/services/repairs.js";
import { createAccount, postThroughService, uuid } from "./finance-harness.js";
import { startTestServer, type TestServer } from "./harness.js";

let api: TestServer;
let accountId: string;
const usd = (amountMinor: string) => ({ amountMinor, currency: "USD" as const });
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  accountId = (await createAccount(api, { openingMinor: "200000" })).id;
});
afterEach(async () => { await api.close(); });
const post = (patch: Partial<PostingInput> = {}) => postThroughService(api, {
  accountId, postedDate: "2026-04-02", merchant: "SYNTHETIC MARKET", kind: "purchase", money: usd("-10000"), ...patch,
});
const create = (id: string, body: unknown) => api.request(`/api/transactions/${id}/repair-previews`, { method: "POST", body });
async function preview(id: string, body: Record<string, unknown> = { action: "void" }) {
  const response = await create(id.toUpperCase(), { reason: "Synthetic correction", ...body });
  expect(response.status, response.text).toBe(201);
  const result = response.body as RepairPreview;
  expect(response.headers.get("location")).toBe(`/api/transaction-repairs/${result.id}`);
  return result;
}
const apply = (id: string, confirmUnlinking = true) => api.request(`/api/transaction-repairs/${id.toUpperCase()}/apply`,
  { method: "POST", body: { confirmUnlinking } });
const get = (id: string) => api.request(`/api/transaction-repairs/${id.toUpperCase()}`);
const snapshot = () => Object.fromEntries([
  "transactions", "accounts", "assignment_events", "audit_events", "transfer_pairs", "transfer_legs", "refund_links",
  "repair_previews", "ledger_metadata", "checkpoint_checks",
].map(table => [table, api.db.prepare(`SELECT * FROM ${table}`).all()]));
async function checkpoint(n: number, closingDate = "2026-04-30", amountMinor = "190000") {
  const id = uuid(n, "70000000");
  const response = await api.request(`/api/accounts/${accountId}/checkpoints`, { method: "POST", body: {
    id, closingDate, statementBalance: usd(amountMinor),
  } });
  expect(response.status, response.text).toBe(201);
  return id;
}
async function pair() {
  const other = (await createAccount(api, { id: uuid(2) })).id;
  const a = post({ kind: "transfer" });
  const b = post({ accountId: other, kind: "transfer", money: usd("10000") });
  const id = uuid(1, "abcdef00");
  expect((await api.request("/api/transfer-pairs", { method: "POST", body: {
    id, legs: [a, b].map(row => ({ transactionId: row.id, version: row.version })), confirmKindChanges: false,
  } })).status).toBe(201);
  return { a, b, id, other };
}
async function refund(purchaseId: string, n: number, amount = "6000") {
  const row = post({ kind: "refund", money: usd(amount) });
  const id = uuid(n, "abcdef00");
  const response = await api.request("/api/refund-links", { method: "POST", body: {
    id, refundId: row.id, purchaseId,
  } });
  expect(response.status, response.text).toBe(201);
  return { row, id };
}

describe("reviewed financial repairs", () => {
  it("stales for a counterpart account change and for a recheck that changes presented impact", async () => {
    const { a, other } = await pair();
    const p = await preview(a.id);
    expect((await api.request(`/api/accounts/${other}/archive`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    expect((await apply(p.id)).body).toMatchObject({ code: "preview_stale" });
    const checkId = await checkpoint(1);
    const added = post();
    const v = await preview(added.id);
    expect(v.impact.affectedCheckpoints[0].statusAfter).toBe("reconciled");
    expect((await api.request(`/api/accounts/${accountId}/checkpoints/${checkId}/recheck`, {
      method: "POST", headers: { "if-match": '"1"' },
    })).status).toBe(200);
    expect((await get(v.id)).body).toMatchObject({ status: "stale" });
    expect((await apply(v.id)).body).toMatchObject({ code: "preview_stale" });
  });

  it("updates income totals and current rule counts through real void and restore commands", async () => {
    const categoryId = uuid(55);
    const ruleId = uuid(56);
    expect((await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Food", color: "#123456" } })).status).toBe(201);
    expect((await api.request("/api/rules", { method: "POST", body: { id: ruleId, matchType: "contains", pattern: "market", categoryId } })).status).toBe(201);
    const purchase = post();
    const income = post({ kind: "income", money: usd("50000") });
    for (const [action, count, total] of [["void", 0, "0"], ["restore", 1, "50000"]] as const) {
      for (const row of [purchase, income]) expect((await apply((await preview(row.id, { action })).id)).status).toBe(200);
      expect((await api.request(`/api/rules/${ruleId}`)).body).toMatchObject({ currentAssignmentCount: count });
      expect((await api.request("/api/summary?month=2026-04")).body).toMatchObject({ income: usd(total) });
    }
  });

  it("refuses pre-coverage restoration after a baseline move and allows a deliberate date correction first", async () => {
    const row = post();
    expect((await apply((await preview(row.id)).id)).status).toBe(200);
    const restore = await preview(row.id, { action: "restore" });
    expect((await api.request(`/api/accounts/${accountId}/baseline`, { method: "POST", headers: { "if-match": '"1"' },
      body: { mode: "move_start_later", trackingStartDate: "2026-04-15", openingBalance: usd("200000") } })).status).toBe(200);
    expect((await apply(restore.id)).body).toMatchObject({ code: "preview_stale" });
    expect((await create(row.id, { action: "restore", reason: "Restore" })).status).toBe(422);
    expect((await apply((await preview(row.id, { action: "correct", postedDate: "2026-04-16" })).id)).body)
      .toMatchObject({ transaction: { lifecycle: "void" } });
    expect((await apply((await preview(row.id, { action: "restore" })).id)).body)
      .toMatchObject({ transaction: { lifecycle: "active", postedDate: "2026-04-16" } });
  });

  it("authenticates before looking up previews, requires CSRF and validates apply bodies", async () => {
    const row = post();
    const p = await preview(row.id);
    const before = snapshot();
    expect((await api.request(`/api/transaction-repairs/${p.id}`, { omitCookie: true })).status).toBe(401);
    for (const path of [`/api/transactions/${row.id}/repair-previews`, `/api/transaction-repairs/${p.id}/apply`]) {
      expect((await api.request(path, { method: "POST", body: {}, omitCookie: true })).status).toBe(401);
      expect((await api.request(path, { method: "POST", body: {}, csrfToken: null })).status).toBe(403);
    }
    for (const body of [{}, { confirmUnlinking: "true" }, { confirmUnlinking: true, extra: true }]) {
      expect((await api.request(`/api/transaction-repairs/${p.id}/apply`, { method: "POST", body })).status).toBe(422);
    }
    expect((await get("bad")).status).toBe(404);
    expect((await get(uuid(99))).status).toBe(404);
    expect(snapshot()).toEqual(before);
  });

  it("handles the full 500-refund boundary without omitting counterpart staleness checks", async () => {
    const purchase = post();
    let last = purchase.id;
    for (let n = 1; n <= 500; n += 1) last = (await refund(purchase.id, n, "1")).row.id;
    const p = await preview(purchase.id);
    expect(p.capturedVersions).toHaveLength(502);
    expect(p.impact.requiredUnlinks.refundLinkIds).toHaveLength(500);
    expect((await api.request(`/api/transactions/${last}/note`, { method: "PATCH", headers: { "if-match": '"2"' },
      body: { note: "Last counterpart changed" } })).status).toBe(200);
    expect((await apply(p.id)).body).toMatchObject({ code: "preview_stale" });
    const fresh = await preview(purchase.id);
    const result = await apply(fresh.id);
    expect(result.status, result.text).toBe(200);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM refund_links").get()).toEqual({ n: 0n });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind = 'refund' AND lifecycle = 'active'").get()).toEqual({ n: 500n });
  });

  it.each(["transaction", "account", "finance"])("refuses %s counter overflow atomically", async counter => {
    const row = post();
    if (counter === "transaction") api.db.prepare("UPDATE transactions SET version = 999999999999999999 WHERE id = ?").run(row.id);
    if (counter === "account") api.db.prepare("UPDATE accounts SET ledger_revision = 999999999999999999 WHERE id = ?").run(accountId);
    if (counter === "finance") api.db.exec("UPDATE ledger_metadata SET finance_revision = 999999999999999999");
    const p = await preview(row.id);
    const before = snapshot();
    expect((await apply(p.id)).status).toBe(500);
    expect(snapshot()).toEqual(before);
  });

  it("keeps a no-op correction financially unchanged and still records its completed preview", async () => {
    const row = post();
    const p = await preview(row.id, { action: "correct", money: row.money });
    const before = snapshot();
    expect(p.impact.balanceChanges).toEqual([]);
    const first = await apply(p.id);
    expect(first.status).toBe(200);
    expect(snapshot().transactions).toEqual(before.transactions);
    expect(snapshot().accounts).toEqual(before.accounts);
    expect(snapshot().assignment_events).toEqual(before.assignment_events);
    expect((await apply(p.id)).body).toEqual(first.body);
  });

  it("marks a preview stale when newly added checkpoints exceed the response bound", async () => {
    const row = post();
    const p = await preview(row.id);
    for (let n = 1; n <= 1001; n += 1) await checkpoint(n);
    const before = snapshot();
    expect((await get(p.id)).body).toMatchObject({ status: "stale" });
    expect((await apply(p.id)).body).toMatchObject({ code: "preview_stale", status: 409 });
    expect((await create(row.id, { action: "void", reason: "Too many checkpoints" })).status).toBe(422);
    expect(snapshot()).toEqual(before);
  });
  it("previews without changing totals, repairs exact money and retains first originals through repeated repairs", async () => {
    const row = post();
    post({ kind: "income", money: usd("50000") });
    const before = snapshot();
    const p = await preview(row.id, { action: "correct", money: usd("-12000") });
    expect(p).toMatchObject({ status: "ready", before: { money: usd("-10000") }, after: { money: usd("-12000") },
      impact: { balanceChanges: [{ accountId, effectiveFrom: "2026-04-02", delta: usd("-2000") }], affectedMonths: ["2026-04"] } });
    expect(snapshot().transactions).toEqual(before.transactions);
    expect(snapshot().accounts).toEqual(before.accounts);
    expect(snapshot().ledger_metadata).toEqual(before.ledger_metadata);
    expect((await api.request(`/api/accounts/${accountId}`)).body).toMatchObject({ currentBalance: usd("240000") });
    const result = await apply(p.id, false);
    expect(result.status, result.text).toBe(200);
    expect(result.body).toMatchObject({ repair: { status: "applied" }, transaction: { version: "2", money: usd("-12000"),
      correction: { originalMoney: usd("-10000"), originalPostedDate: "2026-04-02" } } });
    expect((await api.request(`/api/accounts/${accountId}`)).body).toMatchObject({ currentBalance: usd("238000"), ledgerRevision: "3" });
    const again = await preview(row.id, { action: "correct", money: usd("-10000"), postedDate: "2026-04-03" });
    expect((await apply(again.id)).body).toMatchObject({ transaction: { version: "3", correction: {
      originalMoney: usd("-10000"), originalPostedDate: "2026-04-02",
    } } });
    expect((await api.request(`/api/transactions/${row.id}/history`)).body).toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ eventType: "amount_corrected", reason: "Synthetic correction" }),
      expect.objectContaining({ eventType: "date_corrected", reason: "Synthetic correction" }),
    ]) });
  });

  it("moves a date across only one checkpoint and reports Needs recheck on every read surface", async () => {
    const row = post();
    const first = await checkpoint(1, "2026-04-10");
    await checkpoint(2);
    const p = await preview(row.id, { action: "correct", postedDate: "2026-04-15" });
    expect(p.impact.affectedCheckpoints).toEqual([{ checkpointId: first, closingDate: "2026-04-10",
      balanceBefore: usd("190000"), balanceAfter: usd("200000"), statusAfter: "needs_recheck" }]);
    expect((await apply(p.id)).status).toBe(200);
    expect((await api.request(`/api/accounts/${accountId}/checkpoints`)).body).toMatchObject({ items: [
      { status: "reconciled" }, { status: "needs_recheck" },
    ] });
    expect((await api.request(`/api/accounts/${accountId}`)).body).toMatchObject({ reconciliation: { needsRecheckCount: 1 } });
    expect((await api.request("/api/summary?month=2026-04")).body).toMatchObject({ review: { needsRecheckCount: 1 } });
    const before = api.db.prepare("SELECT * FROM reconciliation_checkpoints WHERE id = ?").get(first);
    const checks = api.db.prepare("SELECT COUNT(*) AS n FROM checkpoint_checks").get() as { n: bigint };
    expect((await api.request(`/api/accounts/${accountId}/checkpoints/${first}/recheck`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    expect(api.db.prepare("SELECT * FROM reconciliation_checkpoints WHERE id = ?").get(first)).toMatchObject({
      ...(before as object), version: 2n,
    });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM checkpoint_checks").get()).toEqual({ n: checks.n + 1n });
  });

  it("voids and restores the same identity without changing assignments or original evidence", async () => {
    const row = post();
    await checkpoint(1);
    const p = await preview(row.id);
    const voided = await apply(p.id);
    expect(voided.status, voided.text).toBe(200);
    expect(voided.body).toMatchObject({ transaction: { id: row.id, lifecycle: "void", voidedAt: expect.any(String) } });
    expect((await api.request(`/api/accounts/${accountId}`)).body).toMatchObject({ currentBalance: usd("200000"), ledgerRevision: "2" });
    expect((await api.request("/api/transactions?lifecycle=all")).body).toMatchObject({ totals: { netSpending: usd("0") } });
    const restore = await preview(row.id, { action: "restore" });
    const restored = await apply(restore.id);
    expect(restored.status, restored.text).toBe(200);
    expect(restored.body).toMatchObject({ transaction: { id: row.id, lifecycle: "active", voidedAt: null, assignment: row.assignment } });
    expect((await api.request(`/api/accounts/${accountId}`)).body).toMatchObject({ currentBalance: usd("190000"), ledgerRevision: "3" });
  });

  it("requires confirmed transfer unlinking, preserves an archived counterpart, and never restores links", async () => {
    const { a, b, id, other } = await pair();
    expect((await api.request(`/api/accounts/${other}/archive`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    const counterpart = api.db.prepare("SELECT * FROM transactions WHERE id = ?").get(b.id);
    const p = await preview(a.id, { action: "correct", money: usd("-12000") });
    const before = snapshot();
    expect((await apply(p.id, false)).body).toMatchObject({ code: "unlink_confirmation_required", requiredUnlinks: { transferPairIds: [id] } });
    expect(snapshot()).toEqual(before);
    expect((await apply(p.id)).body).toMatchObject({ unlinked: { transferPairIds: [id], refundLinkIds: [] } });
    expect(api.db.prepare("SELECT * FROM transactions WHERE id = ?").get(b.id)).toEqual({ ...(counterpart as object), version: 3n });
    const v = await preview(a.id);
    expect((await apply(v.id)).status).toBe(200);
    const r = await preview(a.id, { action: "restore" });
    expect((await apply(r.id)).body).toMatchObject({ transaction: { transferPairId: null } });
  });

  it("keeps a valid transfer paired across a date-only repair", async () => {
    const { a, b, id } = await pair();
    const before = api.db.prepare("SELECT * FROM transactions WHERE id = ?").get(b.id);
    const p = await preview(a.id, { action: "correct", postedDate: "2026-05-20" });
    expect(p.impact.requiredUnlinks).toEqual({ transferPairIds: [], refundLinkIds: [] });
    expect((await apply(p.id, false)).body).toMatchObject({ transaction: { transferPairId: id, postedDate: "2026-05-20" } });
    expect(api.db.prepare("SELECT * FROM transactions WHERE id = ?").get(b.id)).toEqual(before);
  });

  it("voids a purchase with several refunds but leaves their money active and restore unlinked", async () => {
    const purchase = post();
    const a = await refund(purchase.id, 1);
    const b = await refund(purchase.id, 2);
    const p = await preview(purchase.id);
    expect(p.impact.requiredUnlinks.refundLinkIds).toEqual([a.id, b.id]);
    expect((await apply(p.id)).status).toBe(200);
    for (const { row } of [a, b]) expect((await api.request(`/api/transactions/${row.id}`)).body).toMatchObject({
      lifecycle: "active", money: usd("6000"), refundLink: null,
    });
    expect((await apply((await preview(purchase.id, { action: "restore" })).id)).body).toMatchObject({ transaction: { linkedRefundCount: 0 } });
  });

  it("keeps refund links through amount/date repair even if the refunds exceed the purchase", async () => {
    const purchase = post();
    const linked = await refund(purchase.id, 1);
    expect((await api.request("/api/summary?month=2026-04")).body).toMatchObject({ spending: { net: usd("4000") }, categories: [{ net: usd("4000") }] });
    const p = await preview(purchase.id, { action: "correct", money: usd("-2000"), postedDate: "2026-05-01" });
    expect((await apply(p.id, false)).body).toMatchObject({ transaction: { linkedRefundCount: 1 } });
    expect((await api.request("/api/refund-links", { method: "POST", body: {
      id: linked.id, refundId: linked.row.id, purchaseId: purchase.id,
    } })).body).toMatchObject({ exceedsPurchase: true });
    expect((await api.request("/api/summary?month=2026-04")).body).toMatchObject({ spending: { net: usd("-6000") }, categories: [{ net: usd("-6000") }] });
    expect((await api.request("/api/summary?month=2026-05")).body).toMatchObject({ spending: { net: usd("2000") }, categories: [{ net: usd("2000") }] });
    expect((await apply((await preview(purchase.id)).id)).status).toBe(200);
    expect((await api.request("/api/summary?month=2026-05")).body).toMatchObject({ spending: { net: usd("0") }, categories: [] });
    expect((await apply((await preview(purchase.id, { action: "restore" })).id)).status).toBe(200);
    expect((await api.request("/api/summary?month=2026-05")).body).toMatchObject({ spending: { net: usd("2000") }, categories: [{ net: usd("2000") }] });
  });

  // Archiving through the API bumps the account version, which the captured dependencies already catch.
  // This writes the archive directly, leaving those dependencies intact, so the active-account guard stands alone.
  it("refuses to apply a repair when the account was archived without a version change", async () => {
    const row = post();
    const p = await preview(row.id);
    api.db.prepare("UPDATE accounts SET archived_at = ? WHERE id = ?").run(api.clock.now(), accountId);
    const before = snapshot();
    expect((await get(p.id)).body).toMatchObject({ status: "ready" });
    const response = await apply(p.id);
    expect(response.status, response.text).toBe(409);
    expect(response.body).toMatchObject({ code: "reactivation_required" });
    expect(snapshot()).toEqual(before);
  });

  it("preserves an archived category on repair and restore", async () => {
    const categoryId = uuid(55);
    expect((await api.request("/api/categories", { method: "POST", body: { id: categoryId, name: "Old", color: "#123456" } })).status).toBe(201);
    const row = post({ category: { mode: "category", categoryId } });
    expect((await api.request(`/api/categories/${categoryId}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "0", budgetPlanVersion: null, ruleResolutions: [] } })).status).toBe(200);
    for (const body of [{ action: "correct", money: usd("-12000") }, { action: "void" }, { action: "restore" }]) {
      expect((await apply((await preview(row.id, body)).id)).body).toMatchObject({ transaction: { categoryId, assignment: row.assignment } });
    }
  });

  it("replays a recorded result after later edits, expiry and restart but never bypasses authentication", async () => {
    const row = post();
    const p = await preview(row.id);
    await api.restart();
    const first = await apply(p.id);
    expect(first.status).toBe(200);
    expect((await apply((await preview(row.id, { action: "restore" })).id)).status).toBe(200);
    await api.restart();
    api.clock.advance(86_400_000);
    expect((await apply(p.id)).status).toBe(401);
    await api.login();
    const before = snapshot();
    expect((await apply(p.id, false)).body).toEqual(first.body);
    expect((await get(p.id)).body).toEqual((first.body as { repair: unknown }).repair);
    expect(snapshot()).toEqual(before);
  });

  it("expires unapplied previews at exactly 24 hours", async () => {
    const p = await preview(post().id);
    api.clock.advance(86_400_000);
    await api.login();
    const before = snapshot();
    expect((await get(p.id)).body).toMatchObject({ status: "expired" });
    expect((await apply(p.id)).body).toMatchObject({ code: "preview_expired", status: 410 });
    expect(snapshot()).toEqual(before);
  });

  it.each(["target", "posting", "account", "checkpoint", "counterpart", "new-link", "removed-link"])("refuses stale dependencies: %s", async change => {
    const purchase = post();
    const linked = await refund(purchase.id, 1);
    const p = await preview(purchase.id);
    if (change === "target" || change === "counterpart") {
      const id = change === "target" ? purchase.id : linked.row.id;
      expect((await api.request(`/api/transactions/${id}/note`, { method: "PATCH", headers: { "if-match": '"2"' }, body: { note: "Changed" } })).status).toBe(200);
    } else if (change === "posting") post();
    else if (change === "account") expect((await api.request(`/api/accounts/${accountId}/archive`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    else if (change === "checkpoint") await checkpoint(1, "2026-04-30", "196000");
    else if (change === "new-link") await refund(purchase.id, 2);
    else expect((await api.request(`/api/refund-links/${linked.id}`, { method: "DELETE", headers: { "if-match": '"1"' } })).status).toBe(200);
    const before = snapshot();
    expect((await get(p.id)).body).toMatchObject({ status: "stale" });
    expect((await apply(p.id)).body).toMatchObject({ code: "preview_stale" });
    expect(snapshot()).toEqual(before);
  });

  it("does not stale a preview for unrelated finance or same-account note edits", async () => {
    const a = post();
    const b = post();
    const p = await preview(a.id);
    expect((await api.request(`/api/transactions/${b.id}/note`, { method: "PATCH", headers: { "if-match": '"1"' }, body: { note: "Not related" } })).status).toBe(200);
    const other = (await createAccount(api, { id: uuid(2) })).id;
    post({ accountId: other });
    expect((await get(p.id)).body).toMatchObject({ status: "ready" });
    expect((await apply(p.id)).status).toBe(200);
  });

  it.each(["unlink", "audit", "response"])("rolls back after %s failure, including preview completion", async phase => {
    const { a } = await pair();
    const p = await preview(a.id);
    const before = snapshot();
    if (phase === "unlink") api.db.exec(`CREATE TRIGGER fail_repair BEFORE UPDATE OF lifecycle ON transactions
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    if (phase === "audit") api.db.exec(`CREATE TRIGGER fail_repair AFTER INSERT ON audit_events WHEN NEW.event_type = 'voided'
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    if (phase === "response") {
      expect(() => withWriteTransaction(api.db, () => applyRepair({ db: api.db, now: api.clock.now(),
        today: easternDate(api.clock.now()), newId: api.deps.newId }, p.id, true,
      body => checkedResponse(RepairResult, { ...(body as object), transaction: null })))).toThrow();
    } else {
      expect((await apply(p.id)).status).toBe(500);
      api.db.exec("DROP TRIGGER fail_repair");
    }
    expect(snapshot()).toEqual(before);
    expect((await apply(p.id)).status).toBe(200);
  });

  it("rejects invalid input and forbidden lifecycle transitions without writing", async () => {
    const row = post();
    const before = snapshot();
    for (const body of [
      { action: "restore" }, { action: "correct" }, { action: "correct", money: usd("0") },
      { action: "correct", money: usd("+1") }, { action: "correct", money: usd("-100000000000") },
      { action: "correct", money: usd("100") }, { action: "correct", postedDate: "2026-02-30" },
      { action: "correct", postedDate: "2026-03-31" }, { action: "void", reason: " \n " },
      { action: "void", reason: "\ud800" }, { action: "void", reason: "x".repeat(501) },
      { action: "void", accountId: uuid(2) },
    ]) expect((await create(row.id, { reason: "Synthetic", ...body })).status).toBe(422);
    expect(snapshot()).toEqual(before);
    expect((await api.request(`/api/accounts/${accountId}/archive`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
    expect((await create(row.id, { action: "void", reason: "Synthetic" })).body).toMatchObject({ code: "reactivation_required" });
  });
});
