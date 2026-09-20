import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, uuid } from "./finance-harness.js";
import { PENDING_PLACEHOLDERS, pendingTables } from "../src/services/pending-stages.js";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});

afterEach(async () => {
  await api.close();
});

describe("creating an account", () => {
  it("creates one, with an ETag, a Location and the opening balance as today's balance", async () => {
    const { response } = await createAccount(api);
    expect(response.status).toBe(201);
    expect(response.headers.get("etag")).toBe('"1"');
    expect(response.headers.get("location")).toBe(`/api/accounts/${uuid(1)}`);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = response.body as {
      account: Record<string, unknown>;
      financeRevision: string;
    };
    expect(body.account["currentBalance"]).toEqual({ amountMinor: "125000", currency: "USD" });
    expect(body.account["openingBalance"]).toEqual({ amountMinor: "125000", currency: "USD" });
    expect(body.account["status"]).toBe("active");
    expect(body.account["version"]).toBe("1");
    expect(body.account["ledgerRevision"]).toBe("0");
    expect(body.account["lastImportedPostedDate"]).toBeNull();
    expect(body.account["reconciliation"]).toEqual({
      latestStatus: null,
      needsRecheckCount: 0,
      differenceCount: 0,
    });
    expect(body.financeRevision).toBe("1");
  });

  it("returns the existing record for a retry with the same id and content", async () => {
    const first = await createAccount(api);
    const second = await createAccount(api);
    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(200);
    expect(second.response.headers.get("location")).toBeNull();

    const list = await api.request("/api/accounts");
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("refuses the same id with different content", async () => {
    await createAccount(api);
    const conflicting = await createAccount(api, { displayName: "Something Else" });
    expect(conflicting.response.status).toBe(409);
    expect((conflicting.response.body as { code: string }).code).toBe("client_id_conflict");
  });

  it("refuses a tracking start in the future, so no balance is ever a guess", async () => {
    const { response } = await createAccount(api, { trackingStartDate: "2027-01-01" });
    expect(response.status).toBe(422);
    const body = response.body as { code: string; fieldErrors: { path: string }[] };
    expect(body.code).toBe("validation_failed");
    expect(body.fieldErrors[0].path).toBe("/trackingStartDate");
  });

  it("refuses an impossible date, an unknown kind and an unknown field", async () => {
    const impossible = await api.request("/api/accounts", {
      method: "POST",
      body: {
        id: uuid(2),
        kind: "checking",
        providerKey: "chase",
        displayName: "Synthetic",
        trackingStartDate: "2026-02-31",
        openingBalance: { amountMinor: "0", currency: "USD" },
      },
    });
    expect(impossible.status).toBe(422);

    const unknownKind = await createAccount(api, { id: uuid(3), kind: "brokerage" });
    expect(unknownKind.response.status).toBe(422);

    const unknownField = await api.request("/api/accounts", {
      method: "POST",
      body: {
        id: uuid(4),
        kind: "checking",
        providerKey: "chase",
        displayName: "Synthetic",
        trackingStartDate: "2026-04-01",
        openingBalance: { amountMinor: "0", currency: "USD" },
        interestRate: "3.5",
      },
    });
    expect(unknownField.status).toBe(422);
    const fields = (unknownField.body as { fieldErrors: { code: string }[] }).fieldErrors;
    expect(fields.some((field) => field.code === "unknown_field")).toBe(true);
  });

  it("refuses a non-canonical opening balance", async () => {
    for (const amountMinor of ["1.00", "+100", "0100", "-0", "1e3", " 100"]) {
      const response = await api.request("/api/accounts", {
        method: "POST",
        body: {
          id: uuid(9),
          kind: "checking",
          providerKey: "chase",
          displayName: "Synthetic",
          trackingStartDate: "2026-04-01",
          openingBalance: { amountMinor, currency: "USD" },
        },
      });
      expect([400, 422]).toContain(response.status);
    }
  });

  it("needs a session and a CSRF token", async () => {
    const noCsrf = await api.request("/api/accounts", {
      method: "POST",
      csrfToken: null,
      body: { id: uuid(5) },
    });
    expect(noCsrf.status).toBe(403);

    const noSession = await api.request("/api/accounts", { omitCookie: true });
    expect(noSession.status).toBe(401);
  });
});

describe("reading accounts", () => {
  it("filters by status and sorts by kind then name", async () => {
    await createAccount(api, { id: uuid(1), kind: "credit_card", displayName: "Synthetic Card" });
    await createAccount(api, { id: uuid(2), kind: "checking", displayName: "Zeta Checking" });
    await createAccount(api, { id: uuid(3), kind: "checking", displayName: "Alpha Checking" });

    const active = await api.request("/api/accounts");
    expect(
      (active.body as { items: { displayName: string }[] }).items.map((item) => item.displayName),
    ).toEqual(["Alpha Checking", "Zeta Checking", "Synthetic Card"]);

    const card = await api.request(`/api/accounts/${uuid(1)}`);
    await api.request(`/api/accounts/${uuid(1)}/archive`, {
      method: "POST",
      headers: { "if-match": card.headers.get("etag") ?? "" },
    });

    expect((((await api.request("/api/accounts")).body) as { items: unknown[] }).items).toHaveLength(2);
    expect(
      (((await api.request("/api/accounts?status=archived")).body) as { items: unknown[] }).items,
    ).toHaveLength(1);
    expect(
      (((await api.request("/api/accounts?status=all")).body) as { items: unknown[] }).items,
    ).toHaveLength(3);

    const bogus = await api.request("/api/accounts?status=deleted");
    expect(bogus.status).toBe(400);
  });

  it("returns problem json for an unknown or malformed id", async () => {
    const missing = await api.request(`/api/accounts/${uuid(99)}`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/problem+json");

    const malformed = await api.request("/api/accounts/not-a-uuid");
    expect(malformed.status).toBe(404);
  });
});

describe("editing an account", () => {
  it("changes labels, advances the version and requires the current one", async () => {
    const { id, etag } = await createAccount(api);

    const stale = await api.request(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "if-match": '"99"' },
      body: { displayName: "Renamed" },
    });
    expect(stale.status).toBe(412);
    expect((stale.body as { currentVersion: string }).currentVersion).toBe("1");

    const missing = await api.request(`/api/accounts/${id}`, {
      method: "PATCH",
      body: { displayName: "Renamed" },
    });
    expect(missing.status).toBe(428);

    const malformed = await api.request(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "if-match": "1" },
      body: { displayName: "Renamed" },
    });
    expect(malformed.status).toBe(400);

    const empty = await api.request(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "if-match": etag },
      body: {},
    });
    expect(empty.status).toBe(422);

    const ok = await api.request(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "if-match": etag },
      body: { displayName: "Renamed Checking", maskedSuffix: "9876" },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe('"2"');
    const account = (ok.body as { account: Record<string, unknown> }).account;
    expect(account["displayName"]).toBe("Renamed Checking");
    expect(account["maskedSuffix"]).toBe("9876");
    // Renaming is not a financial change, so the account's ledger revision
    // stays put and no open list or preview is invalidated by it.
    expect(account["ledgerRevision"]).toBe("0");
  });

  it("cannot change the tracking start or opening balance through a label edit", async () => {
    const { id, etag } = await createAccount(api);
    const response = await api.request(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "if-match": etag },
      body: { trackingStartDate: "2026-01-01" },
    });
    expect(response.status).toBe(422);
  });
});

describe("archiving and reactivating", () => {
  it("archives, refuses edits while archived, and reactivates", async () => {
    const { id, etag } = await createAccount(api);

    const archived = await api.request(`/api/accounts/${id}/archive`, {
      method: "POST",
      headers: { "if-match": etag },
    });
    expect(archived.status).toBe(200);
    const account = (archived.body as { account: Record<string, unknown> }).account;
    expect(account["status"]).toBe("archived");
    expect(account["archivedAt"]).toMatch(/^2026-/);

    const edit = await api.request(`/api/accounts/${id}`, {
      method: "PATCH",
      headers: { "if-match": '"2"' },
      body: { displayName: "While Archived" },
    });
    expect(edit.status).toBe(409);
    expect((edit.body as { code: string }).code).toBe("reactivation_required");

    const back = await api.request(`/api/accounts/${id}/reactivate`, {
      method: "POST",
      headers: { "if-match": '"2"' },
    });
    expect(back.status).toBe(200);
    expect((back.body as { account: { status: string } }).account.status).toBe("active");
  });

  it("is idempotent: archiving an archived account returns it unchanged", async () => {
    const { id, etag } = await createAccount(api);
    await api.request(`/api/accounts/${id}/archive`, {
      method: "POST",
      headers: { "if-match": etag },
    });

    const again = await api.request(`/api/accounts/${id}/archive`, {
      method: "POST",
      headers: { "if-match": '"2"' },
    });
    expect(again.status).toBe(200);
    expect(again.headers.get("etag")).toBe('"2"');
    expect((again.body as { account: { version: string } }).account.version).toBe("2");

    const reactivateActive = await api.request(`/api/accounts/${id}/reactivate`, {
      method: "POST",
      headers: { "if-match": '"2"' },
    });
    expect(reactivateActive.status).toBe(200);
    expect((reactivateActive.body as { account: { version: string } }).account.version).toBe("3");
  });

  it("records a re-archive as an ordinary archive event", async () => {
    const { id, etag } = await createAccount(api);
    await api.request(`/api/accounts/${id}/archive`, {
      method: "POST",
      headers: { "if-match": etag },
    });
    await api.request(`/api/accounts/${id}/reactivate`, {
      method: "POST",
      headers: { "if-match": '"2"' },
    });
    await api.request(`/api/accounts/${id}/archive`, {
      method: "POST",
      headers: { "if-match": '"3"' },
    });

    const events = api.db
      .prepare("SELECT event_type FROM audit_events WHERE entity_id = ? ORDER BY occurred_at, id")
      .all(id) as { event_type: string }[];
    expect(events.map((event) => event.event_type)).toEqual([
      "account_created",
      "account_archived",
      "account_reactivated",
      "account_archived",
    ]);
  });
});

describe("deleting an account", () => {
  it("deletes a completely unused one and keeps its history", async () => {
    const { id, etag } = await createAccount(api);

    const deleted = await api.request(`/api/accounts/${id}`, {
      method: "DELETE",
      headers: { "if-match": etag },
    });
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe("");
    expect((await api.request(`/api/accounts/${id}`)).status).toBe(404);

    // A repeated delete is treated as done after a refetch.
    const again = await api.request(`/api/accounts/${id}`, {
      method: "DELETE",
      headers: { "if-match": etag },
    });
    expect(again.status).toBe(404);

    const events = api.db
      .prepare("SELECT event_type FROM audit_events WHERE account_id = ? ORDER BY occurred_at, id")
      .all(id) as { event_type: string }[];
    expect(events.map((event) => event.event_type)).toEqual([
      "account_created",
      "account_deleted",
    ]);
  });

  it("refuses when transactions exist, including voided ones, and names them", async () => {
    const { id, etag } = await createAccount(api);
    const voided = postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-02",
      amountMinor: "-8000",
      lifecycle: "void",
    });

    const response = await api.request(`/api/accounts/${id}`, {
      method: "DELETE",
      headers: { "if-match": etag },
    });
    expect(response.status).toBe(409);
    const body = response.body as {
      code: string;
      blocking: { kind: string; count: number; ids: string[] }[];
    };
    expect(body.code).toBe("account_in_use");
    // Voiding everything is not the same as never having used the account.
    expect(body.blocking).toEqual([{ kind: "transaction", count: 1, ids: [voided] }]);
  });

  it("refuses when a checkpoint exists", async () => {
    const { id, etag } = await createAccount(api);
    const created = await api.request(`/api/accounts/${id}/checkpoints`, {
      method: "POST",
      body: {
        id: uuid(1, "70000000"),
        closingDate: "2026-04-30",
        statementBalance: { amountMinor: "125000", currency: "USD" },
      },
    });
    // Asserted so this test cannot pass while the checkpoint was never made.
    expect(created.status).toBe(201);

    const response = await api.request(`/api/accounts/${id}`, {
      method: "DELETE",
      headers: { "if-match": etag },
    });
    expect(response.status).toBe(409);
    expect((response.body as { blocking: { kind: string }[] }).blocking[0].kind).toBe("checkpoint");
  });
});

describe("the forward guard for later stages", () => {
  it("fails as soon as a table arrives that makes a placeholder wrong", () => {
    const present = (
      api.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name);

    const arrived = pendingTables().filter((table) => present.includes(table));
    const affected = PENDING_PLACEHOLDERS.filter((entry) => arrived.includes(entry.table)).map(
      (entry) => `${entry.table} -> ${entry.where} (stage ${entry.stage})`,
    );

    // When this fails, it is not a broken test: a later stage created one of
    // these tables, and the placeholders listed above now need real values.
    expect(affected).toEqual([]);
  });

  it("declares a placeholder for every count the summary cannot compute yet", () => {
    const declared = PENDING_PLACEHOLDERS.map((entry) => entry.where);
    for (const count of ["openImportCount", "heldImportRowCount", "unmatchedTransferCount"]) {
      expect(declared.some((where) => where.includes(count))).toBe(true);
    }
  });
});
