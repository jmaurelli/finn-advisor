import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ListImportRowsResponse } from "@workspace/api-zod";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, UNCATEGORIZED, uuid } from "./finance-harness.js";
import { IMPORT_REVIEW_MS } from "../src/services/imports.js";

let api: TestServer;
let importId: string;
const rowsPath = () => `/api/imports/${importId}/rows`;

async function upload(description = "SYNTHETIC MARKET"): Promise<string> {
  const boundary = "MoneyDeskRowsTest";
  const csv = "Date,Description,Amount,Type\r\n"
    + `05/01/2026,${description},-45.99,DEBIT\r\n`
    + "bad-date,SYNTHETIC CREDIT,25.00,CREDIT\r\n"
    + "05/02/2026,SYNTHETIC ZERO,0.00,DEBIT\r\n";
  const fields = [["accountId", uuid(1)], ["formatId", "synthetic-canonical-checking"]];
  const response = await api.request("/api/imports", {
    method: "POST", contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fabricated.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
  });
  expect(response.status).toBe(201);
  return (response.body as { import: { id: string } }).import.id;
}

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { id: uuid(1), trackingStartDate: "2026-01-01" });
  importId = await upload();
});
afterEach(async () => { await api.close(); });

describe("durable import row reads", () => {
  it("serves complete schema-valid ready and held rows with original source fields", async () => {
    const response = await api.request(rowsPath());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const page = ListImportRowsResponse.parse(response.body);
    expect(page.importVersion).toBe("2");
    expect(page.nextCursor).toBeNull();
    expect(page.items.map(row => row.rowNumber)).toEqual([1, 2, 3]);
    expect(page.items[0]).toMatchObject({ state: "ready", normalized: {
      postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", money: { amountMinor: "-4599", currency: "USD" },
    }, duplicate: { status: "none", matches: [], decision: null }, version: "1" });
    // Publication now proposes a category: no rule matches, so it is the
    // uncategorized one, and the row is still ready.
    expect(page.items[0]!.assignment)
      .toEqual({ categoryId: UNCATEGORIZED, origin: "unassigned", ruleId: null, ruleRevision: null });
    expect(page.items[1]).toMatchObject({ state: "held", normalized: { postedDate: null },
      sourceFields: { Date: "bad-date", Amount: "25.00" } });
    expect(page.items[2]!.normalized.money).toEqual({ amountMinor: "0", currency: "USD" });
  });

  it("paginates in source order without overlap and allows a different page size", async () => {
    const first = ListImportRowsResponse.parse((await api.request(`${rowsPath()}?limit=1`)).body);
    expect(first.nextCursor).not.toBeNull();
    const second = ListImportRowsResponse.parse((await api.request(`${rowsPath()}?limit=200&cursor=${first.nextCursor}`)).body);
    expect(second.items.map(row => row.rowNumber)).toEqual([2, 3]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters before pagination and binds the cursor to that filter", async () => {
    const first = ListImportRowsResponse.parse((await api.request(`${rowsPath()}?state=held&limit=1`)).body);
    expect(first.items.map(row => row.rowNumber)).toEqual([2]);
    const second = ListImportRowsResponse.parse((await api.request(`${rowsPath()}?state=held&cursor=${first.nextCursor}`)).body);
    expect(second.items.map(row => row.rowNumber)).toEqual([3]);
    for (const state of ["", "&state=ready"]) {
      const response = await api.request(`${rowsPath()}?cursor=${first.nextCursor}${state}`);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: "invalid_cursor" });
    }
  });

  it("refuses a cursor from another import", async () => {
    const first = ListImportRowsResponse.parse((await api.request(`${rowsPath()}?limit=1`)).body);
    const other = await upload("SYNTHETIC OTHER");
    const response = await api.request(`/api/imports/${other}/rows?cursor=${first.nextCursor}`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_cursor" });
  });

  it("returns schema-valid excluded rows from saved state", async () => {
    api.db.prepare("UPDATE import_rows SET excluded = 1, state = 'excluded' WHERE import_id = ? AND source_row_number = 2").run(importId);
    const page = ListImportRowsResponse.parse((await api.request(`${rowsPath()}?state=excluded`)).body);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ rowNumber: 2, state: "excluded", excluded: true });
    expect(page.items[0]!.issues.length).toBeGreaterThan(0);
  });

  it("preserves rows and pagination across restart without writes or financial effects", async () => {
    const before = await api.request(rowsPath());
    const batch = api.db.prepare("SELECT * FROM import_batches WHERE id = ?").get(importId);
    const metadata = api.db.prepare("SELECT * FROM ledger_metadata").all();
    await api.restart();
    await api.login();
    expect((await api.request(rowsPath())).body).toEqual(before.body);
    expect(api.db.prepare("SELECT * FROM import_batches WHERE id = ?").get(importId)).toEqual(batch);
    expect(api.db.prepare("SELECT * FROM ledger_metadata").all()).toEqual(metadata);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });

  it("requires authentication before revealing row availability", async () => {
    const response = await api.request(rowsPath(), { omitCookie: true });
    expect(response.status).toBe(401);
    expect(response.text).not.toContain("SYNTHETIC MARKET");
  });

  it.each(["not-an-id", uuid(999)])("returns 404 for an unknown import %s", async id => {
    expect((await api.request(`/api/imports/${id}/rows`)).status).toBe(404);
  });

  it.each(["state=bad", "state=held&state=ready", "limit=0", "limit=201", "limit=1.5", "limit=1&limit=2", "unknown=x"])("rejects invalid query %s", async query => {
    expect((await api.request(`${rowsPath()}?${query}`)).status).toBe(400);
  });

  it.each(["!", "bm90LWpzb24", "bnVsbA", "W10", "e30"])("rejects malformed cursor %s", async cursor => {
    const response = await api.request(`${rowsPath()}?cursor=${encodeURIComponent(cursor)}`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: "invalid_cursor" });
  });

  it.each([0, -1, 25001, 1.5, "1"])("rejects invalid source position %s", async rowNumber => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, importId, state: null, rowNumber })).toString("base64url");
    expect((await api.request(`${rowsPath()}?cursor=${cursor}`)).status).toBe(400);
  });

  it.each(["cancelled", "expired", "failed"])("hides rows for a %s batch", async status => {
    api.db.prepare(`UPDATE import_batches SET status = ?, expires_at = NULL,
      failure_code = ?, failure_message = ? WHERE id = ?`).run(status,
      status === "failed" ? "unreadable_file" : null, status === "failed" ? "Unreadable file." : null, importId);
    const response = await api.request(rowsPath());
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: status === "expired" ? "preview_expired" : "import_contents_deleted" });
    expect(response.text).not.toContain("SYNTHETIC MARKET");
  });

  it("expires at the deadline without polling extending or mutating review activity", async () => {
    const batch = api.db.prepare("SELECT * FROM import_batches WHERE id = ?").get(importId);
    api.clock.advance(IMPORT_REVIEW_MS - 1);
    await api.login();
    expect((await api.request(rowsPath())).status).toBe(200);
    api.clock.advance(1);
    const response = await api.request(rowsPath());
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "preview_expired" });
    expect(api.db.prepare("SELECT * FROM import_batches WHERE id = ?").get(importId)).toEqual(batch);
  });

  it("keeps an archive/reactivate cycle stale across restart without extending review", async () => {
    const before = (await api.request(`/api/imports/${importId}`)).body as Record<string, unknown>;
    for (const action of ["archive", "reactivate"]) {
      const account = await api.request(`/api/accounts/${uuid(1)}`);
      const changed = await api.request(`/api/accounts/${uuid(1)}/${action}`, {
        method: "POST", headers: { "if-match": account.headers.get("etag")! },
      });
      expect(changed.status).toBe(200);
      const batch = (await api.request(`/api/imports/${importId}`)).body as Record<string, unknown>;
      expect(batch.staleReasons).toEqual(["account_archived"]);
      expect(batch.version).toBe("3");
      expect(batch.expiresAt).toBe(before.expiresAt);
      expect(batch.lastReviewedAt).toBe(before.lastReviewedAt);
    }
    await api.restart();
    await api.login();
    expect((await api.request(`/api/imports/${importId}`)).body).toMatchObject({
      staleReasons: ["account_archived"], version: "3",
    });
  });

  it("does not invalidate previews for account display-name changes", async () => {
    const before = (await api.request(`/api/imports/${importId}`)).body;
    const account = await api.request(`/api/accounts/${uuid(1)}`);
    const changed = await api.request(`/api/accounts/${uuid(1)}`, {
      method: "PATCH", headers: { "if-match": account.headers.get("etag")! },
      body: { displayName: "Synthetic renamed account" },
    });
    expect(changed.status).toBe(200);
    expect((await api.request(`/api/imports/${importId}`)).body).toEqual(before);
  });
});
