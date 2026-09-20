import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestServer, START_TIME, type TestServer } from "./harness.js";
import { balanceOf, createAccount, postTransaction, uuid } from "./finance-harness.js";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});

afterEach(async () => {
  await api.close();
});

async function balance(id: string, asOf: string): Promise<{ status: number; body: unknown }> {
  return api.request(`/api/accounts/${id}/balance?asOf=${asOf}`);
}

describe("the balance at a date", () => {
  it("is the opening balance on the day before tracking starts, and outside coverage before that", async () => {
    const { id } = await createAccount(api, { trackingStartDate: "2026-04-01", openingMinor: "125000" });

    const dayBefore = await balance(id, "2026-03-31");
    expect(balanceOf(dayBefore as never)).toBe("125000");
    expect((dayBefore.body as { coverage: string }).coverage).toBe("covered");

    const earlier = await balance(id, "2026-03-30");
    expect((earlier.body as { coverage: string }).coverage).toBe("outside_coverage");
    // Null, never a fabricated zero: a zero here would be indistinguishable
    // from an account that genuinely held nothing.
    expect(balanceOf(earlier as never)).toBeNull();
  });

  it("adds active movements from the tracking start through the date", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-10", amountMinor: "-2500" });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-15",
      amountMinor: "2500",
      kind: "refund",
      origin: "manual",
    });
    postTransaction(api.db, { accountId: id, postedDate: "2026-05-01", amountMinor: "-10000" });

    expect(balanceOf((await balance(id, "2026-04-01")) as never)).toBe("125000");
    expect(balanceOf((await balance(id, "2026-04-02")) as never)).toBe("117000");
    expect(balanceOf((await balance(id, "2026-04-30")) as never)).toBe("117000");
    expect(balanceOf((await balance(id, "2026-05-31")) as never)).toBe("107000");
  });

  it("ignores voided rows entirely", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-03",
      amountMinor: "-50000",
      lifecycle: "void",
    });

    expect(balanceOf((await balance(id, "2026-04-30")) as never)).toBe("117000");
  });

  it("reports an empty range as zero rather than as missing data", async () => {
    const { id } = await createAccount(api, { openingMinor: "0" });
    // SUM() over no rows is NULL in SQLite; without COALESCE this would be a
    // missing balance instead of a real zero.
    const response = await balance(id, "2026-04-15");
    expect(balanceOf(response as never)).toBe("0");
    expect((response.body as { coverage: string }).coverage).toBe("covered");
  });

  it("keeps a total exact past the range an ordinary number can hold", async () => {
    const { id } = await createAccount(api, { openingMinor: "0" });

    // The per-value bound is under 10^11, so reaching past 2^53 takes about
    // ninety thousand rows. Worth doing once: this is the case where a float
    // total would start losing cents silently.
    const rows = 90100;
    const each = 99999999999n;
    const insert = api.db.prepare(
      `INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
         amount_cents, kind, category_id, assignment_origin, note, lifecycle, version,
         created_at, updated_at)
       VALUES (?, ?, '2026-04-02', 'SYNTHETIC BULK', 'synthetic bulk', ?, 'refund',
         '30000000-0000-4000-8000-000000000000', 'manual', NULL, 'active', 1,
         1750000000000, 1750000000000)`,
    );
    api.db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < rows; index += 1) {
      insert.run(`10000000-0000-4000-9000-${String(index).padStart(12, "0")}`, id, each);
    }
    api.db.exec("COMMIT");

    const total = each * BigInt(rows);
    expect(total).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    const reported = balanceOf((await balance(id, "2026-04-30")) as never);
    expect(reported).toBe(total.toString());
    expect(BigInt(reported ?? "0")).toBe(total);
    // Why this matters: at this magnitude a float cannot even tell this total
    // apart from one cent more, so a float pipeline would lose cents here
    // without any error.
    expect(Number(total) + 1).toBe(Number(total));
  });

  it("reports the last imported posted date and the account's ledger revision", async () => {
    const { id } = await createAccount(api);
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-20", amountMinor: "-1000" });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-05-30",
      amountMinor: "-1000",
      lifecycle: "void",
    });

    const response = await balance(id, "2026-04-30");
    const body = response.body as { lastImportedPostedDate: string; ledgerRevision: string };
    expect(body.lastImportedPostedDate).toBe("2026-04-20");
    expect(body.ledgerRevision).toBe("0");
  });

  it("refuses a missing or impossible asOf", async () => {
    const { id } = await createAccount(api);
    expect((await api.request(`/api/accounts/${id}/balance`)).status).toBe(400);
    expect((await balance(id, "2026-02-31")).status).toBe(400);
    expect((await balance(id, "yesterday")).status).toBe(400);
  });

  it("uses the Eastern date for an account's current balance", async () => {
    // START_TIME is 2026-05-02 13:55 UTC, which is 09:55 Eastern.
    const { id } = await createAccount(api, { openingMinor: "100000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-05-02", amountMinor: "-5000" });

    const account = await api.request(`/api/accounts/${id}`);
    expect((account.body as { balanceAsOf: string }).balanceAsOf).toBe("2026-05-02");
    expect((account.body as { currentBalance: { amountMinor: string } }).currentBalance.amountMinor)
      .toBe("95000");

    // 2026-05-03 01:30 UTC is still 2026-05-02 in the Eastern ledger. That is
    // far past the idle deadline, so sign in again first.
    api.clock.set(Date.UTC(2026, 4, 3, 1, 30));
    await api.login();
    const later = await api.request(`/api/accounts/${id}`);
    expect(later.status).toBe(200);
    expect((later.body as { balanceAsOf: string }).balanceAsOf).toBe("2026-05-02");
    expect(START_TIME).toBeLessThan(Date.UTC(2026, 4, 3, 1, 30));
  });
});

describe("changing an account's starting point", () => {
  it("corrects the opening balance and moves every later balance by the same difference", async () => {
    const { id, etag } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });

    const response = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: {
        mode: "correct_opening_balance",
        openingBalance: { amountMinor: "130000", currency: "USD" },
      },
    });
    expect(response.status).toBe(200);
    const account = (response.body as { account: Record<string, unknown> }).account;
    expect(account["openingBalance"]).toEqual({ amountMinor: "130000", currency: "USD" });
    // A baseline change is a financial change, so the account's ledger
    // revision advances and dependent previews become stale.
    expect(account["ledgerRevision"]).toBe("1");
    expect(balanceOf((await balance(id, "2026-04-30")) as never)).toBe("122000");
  });

  it("refuses to move the start past an active transaction, and names the blocking rows", async () => {
    const { id, etag } = await createAccount(api, { trackingStartDate: "2026-04-01" });
    const blocking = postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-02",
      amountMinor: "-8000",
    });

    const refused = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: {
        mode: "move_start_later",
        trackingStartDate: "2026-04-10",
        openingBalance: { amountMinor: "117000", currency: "USD" },
      },
    });
    expect(refused.status).toBe(409);
    const body = refused.body as { code: string; blocking: { kind: string; ids: string[] }[] };
    expect(body.code).toBe("active_transactions_before_start");
    expect(body.blocking).toEqual([{ kind: "transaction", count: 1, ids: [blocking] }]);

    // Nothing changed, so the version is still the one the caller held.
    const unchanged = await api.request(`/api/accounts/${id}`);
    expect((unchanged.body as { trackingStartDate: string }).trackingStartDate).toBe("2026-04-01");
    expect((unchanged.body as { version: string }).version).toBe("1");
  });

  it("allows the move once the blocking rows are voided", async () => {
    const { id, etag } = await createAccount(api, { trackingStartDate: "2026-04-01" });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-02",
      amountMinor: "-8000",
      lifecycle: "void",
    });

    const response = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: {
        mode: "move_start_later",
        trackingStartDate: "2026-04-10",
        openingBalance: { amountMinor: "117000", currency: "USD" },
      },
    });
    expect(response.status).toBe(200);
    expect(
      ((response.body as { account: { trackingStartDate: string } }).account).trackingStartDate,
    ).toBe("2026-04-10");
    // The voided row is now outside coverage and still affects nothing.
    expect(balanceOf((await balance(id, "2026-04-30")) as never)).toBe("117000");
  });

  it("extends coverage backward atomically", async () => {
    const { id, etag } = await createAccount(api, {
      trackingStartDate: "2026-04-01",
      openingMinor: "125000",
    });
    postTransaction(api.db, { accountId: id, postedDate: "2026-03-15", amountMinor: "-4000" });

    const response = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: {
        mode: "extend_backward",
        trackingStartDate: "2026-03-01",
        openingBalance: { amountMinor: "129000", currency: "USD" },
      },
    });
    expect(response.status).toBe(200);
    expect((response.body as { postedTransactionIds: string[] }).postedTransactionIds).toEqual([]);

    // The row dated 2026-03-15 is now inside coverage and counts.
    expect(balanceOf((await balance(id, "2026-03-31")) as never)).toBe("125000");
    // 2026-02-28 is the day before the new start, so it is covered and shows
    // the opening balance. The day before that is outside coverage.
    expect(balanceOf((await balance(id, "2026-02-28")) as never)).toBe("129000");
    expect((await balance(id, "2026-02-27")).body).toMatchObject({ coverage: "outside_coverage" });
  });

  it("refuses held rows rather than silently ignoring them", async () => {
    const { id, etag } = await createAccount(api, { trackingStartDate: "2026-04-01" });
    const response = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: {
        mode: "extend_backward",
        trackingStartDate: "2026-03-01",
        openingBalance: { amountMinor: "129000", currency: "USD" },
        heldRows: {
          importId: uuid(1, "40000000"),
          importVersion: "1",
          rowIds: [uuid(1, "50000000")],
        },
      },
    });
    // Imports arrive in stage 5. Reporting success for rows that were never
    // posted would be worse than refusing.
    expect(response.status).toBe(422);
    const body = response.body as { fieldErrors: { path: string }[] };
    expect(body.fieldErrors[0].path).toBe("/heldRows/importId");

    const unchanged = await api.request(`/api/accounts/${id}`);
    expect((unchanged.body as { trackingStartDate: string }).trackingStartDate).toBe("2026-04-01");
  });

  it("refuses a wrong-direction move, a future start and an archived account", async () => {
    const { id, etag } = await createAccount(api, { trackingStartDate: "2026-04-01" });

    const backwards = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: {
        mode: "move_start_later",
        trackingStartDate: "2026-03-01",
        openingBalance: { amountMinor: "1", currency: "USD" },
      },
    });
    expect(backwards.status).toBe(422);

    const future = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: {
        mode: "move_start_later",
        trackingStartDate: "2027-01-01",
        openingBalance: { amountMinor: "1", currency: "USD" },
      },
    });
    expect(future.status).toBe(422);

    await api.request(`/api/accounts/${id}/archive`, {
      method: "POST",
      headers: { "if-match": etag },
    });
    const archived = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": '"2"' },
      body: {
        mode: "correct_opening_balance",
        openingBalance: { amountMinor: "1", currency: "USD" },
      },
    });
    expect(archived.status).toBe(409);
    expect((archived.body as { code: string }).code).toBe("reactivation_required");
  });

  it("requires the current version", async () => {
    const { id } = await createAccount(api);
    const stale = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": '"7"' },
      body: {
        mode: "correct_opening_balance",
        openingBalance: { amountMinor: "1", currency: "USD" },
      },
    });
    expect(stale.status).toBe(412);

    const missing = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      body: {
        mode: "correct_opening_balance",
        openingBalance: { amountMinor: "1", currency: "USD" },
      },
    });
    expect(missing.status).toBe(428);
  });

  it("gives a field-level error for a malformed baseline body, not an unreadable union error", async () => {
    const { id, etag } = await createAccount(api);
    const response = await api.request(`/api/accounts/${id}/baseline`, {
      method: "POST",
      headers: { "if-match": etag },
      body: { mode: "correct_opening_balance", openingBalance: { amountMinor: "1.5", currency: "USD" } },
    });
    expect(response.status).toBe(422);
    const body = response.body as { code: string; fieldErrors: { path: string }[] };
    expect(body.code).toBe("validation_failed");
    expect(body.fieldErrors.length).toBeGreaterThan(0);
  });
});
