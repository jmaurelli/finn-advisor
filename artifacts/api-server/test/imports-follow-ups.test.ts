import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { ListImportRowsResponse } from "@workspace/api-zod";
import { createAdapterRegistry } from "../src/imports/adapters.js";
import { createImportFollowUp } from "../src/services/import-follow-ups.js";
import { cleanupImports } from "../src/services/import-retention.js";
import { UPLOAD_RETENTION_MS } from "../src/services/imports.js";
import { declaredStatuses, validateAgainst } from "./contract-support.js";
import { startTestServer, type TestServer, type TestRequestInit } from "./harness.js";
import { createAccount, uuid } from "./finance-harness.js";

let api: TestServer;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { trackingStartDate: "2026-01-01" });
});
afterEach(async () => { await api.close(); });
const rowsOf = async (id: string) =>
  ListImportRowsResponse.parse((await api.request(`/api/imports/${id}/rows`)).body).items;
const versionOf = (id: string) => (api.db.prepare("SELECT version FROM import_batches WHERE id = ?")
  .get(id) as { version: bigint }).version.toString();
function snapshot() {
  return Object.fromEntries(["transactions", "accounts", "ledger_metadata", "import_batches", "import_rows",
    "import_source_records", "import_postings", "uploads", "audit_events"].map(table =>
    [table, api.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
async function command(id: string, name: string) {
  return api.request(`/api/imports/${id}/${name}`, { method: "POST",
    headers: { "if-match": `"${versionOf(id)}"` } });
}
async function save(id: string, rowId: string, body: unknown) {
  const response = await api.request(`/api/imports/${id}/rows/${rowId}`, { method: "PATCH",
    headers: { "if-match": `"${versionOf(id)}"` }, body });
  expect(response.status).toBe(200);
}
async function parent(amount = "-15.01", complete = true) {
  const boundary = "SyntheticFollowUpBoundary";
  const csv = `Date,Description,Amount,Type\r\n03/03/2026,SYNTHETIC EXCLUDED,${amount},DEBIT\r\n`;
  const response = await api.request("/api/imports", { method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: `--${boundary}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${uuid(1)}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="formatId"\r\n\r\nsynthetic-canonical-checking\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n` });
  expect(response.status).toBe(201);
  const batch = (response.body as { import: { id: string } }).import;
  if (complete) {
    const [row] = await rowsOf(batch.id);
    await save(batch.id, row!.id, { excluded: true });
    expect((await command(batch.id, "commit")).status).toBe(200);
  }
  return batch.id;
}
async function followUp(parentId: string, id = uuid(301), init: TestRequestInit = {}) {
  const response = await api.request(`/api/imports/${parentId}/follow-ups`, { method: "POST", body: { id }, ...init });
  expect(declaredStatuses("/imports/{importId}/follow-ups", "post")).toContain(String(response.status));
  validateAgainst(response.status < 300 ? "ImportCreateResult" : "Problem", response.body);
  return response;
}

describe("follow-ups from retained excluded evidence", () => {
  it("reconstructs exact cents and source values without an upload or an available adapter", async () => {
    const id = await parent();
    const original = (await api.request(`/api/imports/${id}`)).body;
    const originalRows = await rowsOf(id);
    api.clock.advance(UPLOAD_RETENTION_MS);
    await cleanupImports(api.deps);
    await api.login();
    api.deps.adapters = createAdapterRegistry([]);
    expect(await api.deps.uploads.listStoredKeys()).toEqual([]);
    const created = await followUp(id);
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe(`/api/imports/${uuid(301)}`);
    expect(created.body).toMatchObject({ disposition: "created", import: { id: uuid(301), parentImportId: id,
      status: "preview", uploadRetainedUntil: null, rowCounts: { total: 1, ready: 1, excluded: 0 } } });
    const [row] = await rowsOf(uuid(301));
    expect(row!.sourceFields).toEqual(originalRows[0]!.sourceFields);
    expect(row!.normalized.money).toEqual({ amountMinor: "-1501", currency: "USD" });
    expect(row!.excluded).toBe(false);
    expect(api.db.prepare("SELECT * FROM uploads WHERE import_id = ?").all(uuid(301))).toEqual([]);
    expect((await api.request(`/api/imports/${id}`)).body).toEqual(original);
    expect(await rowsOf(id)).toEqual(originalRows);
    expect((await command(uuid(301), "commit")).body).toMatchObject({ import: { uploadRetainedUntil: null,
      result: { added: 1 } } });
    const posting = api.db.prepare("SELECT posting_import_id, source_record_id, transaction_id FROM import_postings").get() as
      { posting_import_id: string; source_record_id: string; transaction_id: string };
    expect(posting.posting_import_id).toBe(uuid(301));
    expect(api.db.prepare("SELECT origin_import_id FROM import_source_records WHERE id = ?").get(posting.source_record_id))
      .toEqual({ origin_import_id: id });
    expect((await api.request(`/api/transactions/${posting.transaction_id}`)).body).toMatchObject({ importId: uuid(301), sourceRowNumber: 1 });
  });

  it("replays the same client id across restart without copying or changing review work", async () => {
    const id = await parent();
    expect((await followUp(id)).status).toBe(201);
    const [row] = await rowsOf(uuid(301));
    await save(uuid(301), row!.id, { merchant: "SYNTHETIC EDITED" });
    const before = snapshot();
    await api.restart();
    await api.login();
    const replay = await followUp(id);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ disposition: "existing_preview", import: { id: uuid(301) } });
    expect(snapshot()).toEqual(before);
    expect((await rowsOf(uuid(301)))[0]!.normalized.merchant).toBe("SYNTHETIC EDITED");
  });

  it("refuses a reused id with another parent and enforces session and CSRF", async () => {
    const id = await parent();
    expect((await followUp(id, uuid(301), { omitCookie: true })).status).toBe(401);
    expect((await followUp(id, uuid(301), { csrfToken: null })).status).toBe(403);
    expect((await followUp(id)).status).toBe(201);
    const other = await parent("-16.00");
    const response = await followUp(other);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "client_id_conflict" });
  });

  it("refuses an unfinished parent or an archived account without creating a preview", async () => {
    const open = await parent("-16.00", false);
    expect((await followUp(open)).status).toBe(422);
    const id = await parent();
    const account = await api.request(`/api/accounts/${uuid(1)}`);
    expect((await api.request(`/api/accounts/${uuid(1)}/archive`, { method: "POST",
      headers: { "if-match": account.headers.get("etag")! } })).status).toBe(200);
    const response = await followUp(id);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "reactivation_required" });
    expect(api.db.prepare("SELECT * FROM import_batches WHERE parent_import_id IS NOT NULL").all()).toEqual([]);
  });

  it("keeps invalid excluded amounts held rather than coercing them to numbers", async () => {
    const id = await parent("-15.001");
    expect((await followUp(id)).status).toBe(201);
    const [row] = await rowsOf(uuid(301));
    expect(row!.state).toBe("held");
    expect(row!.issues.map(issue => issue.code)).toContain("fractional_cent");
    expect((await command(uuid(301), "commit")).status).toBe(409);
  });

  it("allows two previews of one root but refuses the second posting even after its matching values change", async () => {
    const id = await parent();
    expect((await followUp(id, uuid(301))).status).toBe(201);
    expect((await followUp(id, uuid(302))).status).toBe(201);
    expect((await command(uuid(301), "commit")).status).toBe(200);
    const [row] = await rowsOf(uuid(302));
    await save(uuid(302), row!.id, { merchant: "SYNTHETIC NO LONGER MATCHES" });
    expect((await command(uuid(302), "refresh")).status).toBe(200);
    expect((await rowsOf(uuid(302)))[0]!.state).toBe("ready");
    const before = snapshot();
    const refused = await command(uuid(302), "commit");
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "preview_stale" });
    expect(snapshot()).toEqual(before);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 1n });
    expect((await followUp(id, uuid(303))).status).toBe(422);
  });

  it("does not offer a posted root again after voiding its transaction", async () => {
    const id = await parent();
    expect((await followUp(id)).status).toBe(201);
    expect((await command(uuid(301), "commit")).status).toBe(200);
    const transaction = api.db.prepare("SELECT id FROM transactions").get() as { id: string };
    const preview = await api.request(`/api/transactions/${transaction.id}/repair-previews`, { method: "POST",
      body: { reason: "Synthetic correction", action: "void" } });
    expect(preview.status).toBe(201);
    expect((await api.request(`/api/transaction-repairs/${(preview.body as { id: string }).id}/apply`,
      { method: "POST", body: { confirmUnlinking: true } })).status).toBe(200);
    expect((await followUp(id, uuid(302))).status).toBe(422);
  });

  it("cancels a follow-up without removing its parent evidence and can review those rows again", async () => {
    const id = await parent();
    const evidence = api.db.prepare("SELECT * FROM import_source_records").all();
    const original = (await api.request(`/api/imports/${id}`)).body;
    expect((await followUp(id)).status).toBe(201);
    expect((await command(uuid(301), "discard")).status).toBe(200);
    expect(api.db.prepare("SELECT * FROM import_source_records").all()).toEqual(evidence);
    expect((await api.request(`/api/imports/${id}`)).body).toEqual(original);
    expect((await followUp(id)).status).toBe(200);
    expect((await followUp(id, uuid(302))).status).toBe(201);
    expect(await rowsOf(uuid(302))).toHaveLength(1);
  });

  it("rolls back the batch, row copies and audit if response validation fails", async () => {
    const id = await parent();
    const before = snapshot();
    expect(() => withWriteTransaction(api.db, () => createImportFollowUp({ db: api.db, now: api.clock.now(),
      newId: api.deps.newId }, id, uuid(301), () => { throw new Error("synthetic response failure"); }))).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("follows a second generation of exclusions back to the same root instead of minting another", async () => {
    const id = await parent();
    expect((await followUp(id)).status).toBe(201);
    const [row] = await rowsOf(uuid(301));
    await save(uuid(301), row!.id, { excluded: true });
    expect((await command(uuid(301), "commit")).status).toBe(200);
    expect((await followUp(uuid(301), uuid(302))).status).toBe(201);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_source_records").get()).toEqual({ n: 1n });
    expect((await command(uuid(302), "commit")).status).toBe(200);
    expect((await followUp(id, uuid(303))).status).toBe(422);
    expect((await followUp(uuid(301), uuid(304))).status).toBe(422);
  });
});
