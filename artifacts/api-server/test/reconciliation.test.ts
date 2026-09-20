import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, uuid } from "./finance-harness.js";

let api: TestServer;
let accountId: string;
let accountEtag: string;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  const created = await createAccount(api, {
    trackingStartDate: "2026-04-01",
    openingMinor: "125000",
  });
  accountId = created.id;
  accountEtag = created.etag;
});

afterEach(async () => {
  await api.close();
});

async function addCheckpoint(
  statementMinor: string,
  options: { closingDate?: string; id?: string } = {},
): Promise<{ id: string; status: number; body: Record<string, unknown> }> {
  const id = options.id ?? uuid(1, "70000000");
  const response = await api.request(`/api/accounts/${accountId}/checkpoints`, {
    method: "POST",
    body: {
      id,
      closingDate: options.closingDate ?? "2026-04-30",
      statementBalance: { amountMinor: statementMinor, currency: "USD" },
    },
  });
  return {
    id,
    status: response.status,
    body: (response.body as { checkpoint?: Record<string, unknown> }).checkpoint ??
      (response.body as Record<string, unknown>),
  };
}

async function statusOf(checkpointId: string): Promise<string> {
  const list = await api.request(`/api/accounts/${accountId}/checkpoints`);
  const items = (list.body as { items: { id: string; status: string }[] }).items;
  const found = items.find((item) => item.id === checkpointId);
  if (found === undefined) throw new Error("checkpoint not found");
  return found.status;
}

describe("recording a statement", () => {
  it("records the comparison and reports reconciled when it matches", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });

    const { id, status, body } = await addCheckpoint("117000");
    expect(status).toBe(201);
    expect(body["status"]).toBe("reconciled");
    expect(body["statementBalance"]).toEqual({ amountMinor: "117000", currency: "USD" });
    expect(body["currentCalculatedBalance"]).toEqual({ amountMinor: "117000", currency: "USD" });
    expect(body["currentDifference"]).toEqual({ amountMinor: "0", currency: "USD" });
    expect((body["latestCheck"] as { matched: boolean }).matched).toBe(true);
    expect(await statusOf(id)).toBe("reconciled");
  });

  it("keeps a difference visible and creates no adjusting entry", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });

    const { id, body } = await addCheckpoint("120000");
    expect(body["status"]).toBe("difference");
    expect(body["currentDifference"]).toEqual({ amountMinor: "-3000", currency: "USD" });
    expect(await statusOf(id)).toBe("difference");

    // Nothing was invented to make the books agree.
    const count = api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: bigint };
    expect(count.n).toBe(1n);
  });

  it("is retry-safe and refuses the same id with different content", async () => {
    const first = await addCheckpoint("117000");
    expect(first.status).toBe(201);

    const retry = await addCheckpoint("117000");
    expect(retry.status).toBe(200);

    const conflicting = await addCheckpoint("999");
    expect(conflicting.status).toBe(409);

    const list = await api.request(`/api/accounts/${accountId}/checkpoints`);
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("refuses a closing date before coverage begins, and allows the day before the start", async () => {
    const early = await addCheckpoint("125000", { closingDate: "2026-03-30" });
    expect(early.status).toBe(422);

    const edge = await addCheckpoint("125000", {
      closingDate: "2026-03-31",
      id: uuid(2, "70000000"),
    });
    expect(edge.status).toBe(201);
    expect(edge.body["status"]).toBe("reconciled");
  });

  it("refuses to record one on an archived account", async () => {
    await api.request(`/api/accounts/${accountId}/archive`, {
      method: "POST",
      headers: { "if-match": accountEtag },
    });
    const response = await addCheckpoint("117000");
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code ?? response.body["code"]).toBe(
      "reactivation_required",
    );
  });
});

describe("a changed balance never stays reconciled", () => {
  it("flips to needs recheck when a later import lands before the closing date, with no repair", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    const { id } = await addCheckpoint("117000");
    expect(await statusOf(id)).toBe("reconciled");

    // A later import containing a transaction that was missed. No repair, no
    // void, nothing that anyone would think to mark the checkpoint against.
    postTransaction(api.db, { accountId, postedDate: "2026-04-15", amountMinor: "-2500" });

    expect(await statusOf(id)).toBe("needs_recheck");

    // What the owner entered, and the original comparison, are untouched.
    const history = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/history`,
    );
    const body = history.body as {
      statementBalance: { amountMinor: string };
      checks: { calculatedBalance: { amountMinor: string }; matched: boolean }[];
    };
    expect(body.statementBalance.amountMinor).toBe("117000");
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0].calculatedBalance.amountMinor).toBe("117000");
    expect(body.checks[0].matched).toBe(true);
  });

  it("affects only the checkpoint whose balance actually changed", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    const april = await addCheckpoint("117000", {
      closingDate: "2026-04-30",
      id: uuid(1, "70000000"),
    });

    postTransaction(api.db, { accountId, postedDate: "2026-05-10", amountMinor: "-5000" });
    const may = await addCheckpoint("112000", {
      closingDate: "2026-05-31",
      id: uuid(2, "70000000"),
    });
    expect(await statusOf(april.id)).toBe("reconciled");
    expect(await statusOf(may.id)).toBe("reconciled");

    // A change dated after April's closing date crosses May's, not April's.
    postTransaction(api.db, { accountId, postedDate: "2026-05-20", amountMinor: "-1000" });

    expect(await statusOf(april.id)).toBe("reconciled");
    expect(await statusOf(may.id)).toBe("needs_recheck");
  });

  it("flips when a baseline change moves the balance", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    const { id } = await addCheckpoint("117000");

    await api.request(`/api/accounts/${accountId}/baseline`, {
      method: "POST",
      headers: { "if-match": accountEtag },
      body: {
        mode: "correct_opening_balance",
        openingBalance: { amountMinor: "130000", currency: "USD" },
      },
    });

    expect(await statusOf(id)).toBe("needs_recheck");
  });

  it("flips when the closing date falls outside coverage entirely", async () => {
    const { id } = await addCheckpoint("125000", { closingDate: "2026-03-31" });
    expect(await statusOf(id)).toBe("reconciled");

    await api.request(`/api/accounts/${accountId}/baseline`, {
      method: "POST",
      headers: { "if-match": accountEtag },
      body: {
        mode: "move_start_later",
        trackingStartDate: "2026-04-20",
        openingBalance: { amountMinor: "117000", currency: "USD" },
      },
    });

    // There is no balance for that date any more, so it certainly is not the
    // one that was compared.
    expect(await statusOf(id)).toBe("needs_recheck");
    const list = await api.request(`/api/accounts/${accountId}/checkpoints`);
    const item = (list.body as { items: { id: string; currentCalculatedBalance: unknown }[] }).items
      .find((entry) => entry.id === id);
    expect(item?.currentCalculatedBalance).toBeNull();
  });

  it("does not flip for a note or category edit", async () => {
    const transactionId = postTransaction(api.db, {
      accountId,
      postedDate: "2026-04-02",
      amountMinor: "-8000",
    });
    const { id } = await addCheckpoint("117000");

    // Stage 3 owns the endpoint; the point here is that the derived status
    // depends on the balance, which a category or note edit cannot change.
    api.db
      .prepare("UPDATE transactions SET note = 'groceries for the week' WHERE id = ?")
      .run(transactionId);

    expect(await statusOf(id)).toBe("reconciled");
  });
});

describe("rechecking", () => {
  it("appends a comparison without replacing the statement or the history", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    const { id } = await addCheckpoint("117000");
    postTransaction(api.db, { accountId, postedDate: "2026-04-15", amountMinor: "-2500" });
    expect(await statusOf(id)).toBe("needs_recheck");

    api.clock.advance(60_000);
    const response = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/recheck`,
      { method: "POST", headers: { "if-match": '"1"' } },
    );
    expect(response.status).toBe(200);
    const checkpoint = (response.body as { checkpoint: Record<string, unknown> }).checkpoint;
    // The new comparison does not match, so the difference is now visible.
    expect(checkpoint["status"]).toBe("difference");
    expect(checkpoint["statementBalance"]).toEqual({ amountMinor: "117000", currency: "USD" });
    expect(checkpoint["currentDifference"]).toEqual({ amountMinor: "-2500", currency: "USD" });

    const history = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/history`,
    );
    const checks = (history.body as {
      checks: { matched: boolean; calculatedBalance: { amountMinor: string } }[];
    }).checks;
    expect(checks).toHaveLength(2);
    // Newest first; the original comparison survives exactly as it was.
    expect(checks[0].matched).toBe(false);
    expect(checks[1].matched).toBe(true);
    expect(checks[1].calculatedBalance.amountMinor).toBe("117000");
  });

  it("returns to reconciled when the ledger is put right", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    const { id } = await addCheckpoint("117000");
    const extra = postTransaction(api.db, {
      accountId,
      postedDate: "2026-04-15",
      amountMinor: "-2500",
    });
    api.db.prepare("UPDATE transactions SET lifecycle = 'void' WHERE id = ?").run(extra);

    api.clock.advance(60_000);
    const response = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/recheck`,
      { method: "POST", headers: { "if-match": '"1"' } },
    );
    expect((response.body as { checkpoint: { status: string } }).checkpoint.status).toBe(
      "reconciled",
    );
  });

  it("requires the current version and refuses on an archived account", async () => {
    const { id } = await addCheckpoint("125000", { closingDate: "2026-03-31" });

    const stale = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/recheck`,
      { method: "POST", headers: { "if-match": '"9"' } },
    );
    expect(stale.status).toBe(412);

    const missing = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/recheck`,
      { method: "POST" },
    );
    expect(missing.status).toBe(428);

    await api.request(`/api/accounts/${accountId}/archive`, {
      method: "POST",
      headers: { "if-match": accountEtag },
    });
    const archived = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/recheck`,
      { method: "POST", headers: { "if-match": '"1"' } },
    );
    expect(archived.status).toBe(409);
  });

  it("refuses when the closing date is now outside coverage", async () => {
    const { id } = await addCheckpoint("125000", { closingDate: "2026-03-31" });
    await api.request(`/api/accounts/${accountId}/baseline`, {
      method: "POST",
      headers: { "if-match": accountEtag },
      body: {
        mode: "move_start_later",
        trackingStartDate: "2026-04-20",
        openingBalance: { amountMinor: "117000", currency: "USD" },
      },
    });

    const response = await api.request(
      `/api/accounts/${accountId}/checkpoints/${id}/recheck`,
      { method: "POST", headers: { "if-match": '"1"' } },
    );
    expect(response.status).toBe(422);
  });

  it("is reflected in the account's reconciliation summary", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    await addCheckpoint("117000", { closingDate: "2026-04-30", id: uuid(1, "70000000") });
    await addCheckpoint("999", { closingDate: "2026-04-20", id: uuid(2, "70000000") });

    const account = await api.request(`/api/accounts/${accountId}`);
    expect((account.body as { reconciliation: unknown }).reconciliation).toEqual({
      latestStatus: "reconciled",
      needsRecheckCount: 0,
      differenceCount: 1,
    });

    postTransaction(api.db, { accountId, postedDate: "2026-04-25", amountMinor: "-100" });
    const after = await api.request(`/api/accounts/${accountId}`);
    expect((after.body as { reconciliation: unknown }).reconciliation).toEqual({
      latestStatus: "needs_recheck",
      needsRecheckCount: 1,
      differenceCount: 1,
    });
  });
});
