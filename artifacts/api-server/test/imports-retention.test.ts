import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { ListImportRowsResponse } from "@workspace/api-zod";
import { cleanupImports, discardImport, prepareImportCleanup } from "../src/services/import-retention.js";
import { recoverInterruptedImports } from "../src/services/import-recovery.js";
import { failBatch, IMPORT_REVIEW_MS, parseStoredUpload, publishPreviewUnlessClaimed, requireBatch,
  UPLOAD_RETENTION_MS } from "../src/services/imports.js";
import { SYNTHETIC_CHECKING } from "../src/imports/adapters-synthetic.js";
import { logger } from "../src/lib/logger.js";
import { declaredStatuses, validateAgainst } from "./contract-support.js";
import { startTestServer, type TestServer, type TestRequestInit } from "./harness.js";
import { createAccount, uuid } from "./finance-harness.js";

const CSV = "Date,Description,Amount,Type\r\n"
  + "03/03/2026,SYNTHETIC CONFIRMED,-15.00,DEBIT\r\n"
  + "04/05/2026,SYNTHETIC ABANDONED,-37.42,DEBIT\r\n";
let api: TestServer;
beforeEach(async () => { api = await startTestServer(); await api.login(); });
afterEach(async () => { vi.restoreAllMocks(); await api.close(); });
const context = () => ({ db: api.db, now: api.clock.now(), newId: api.deps.newId });

async function upload(csv = CSV) {
  const boundary = "SyntheticRetentionBoundary";
  const response = await api.request("/api/imports", { method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: `--${boundary}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${uuid(1)}\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="formatId"\r\n\r\nsynthetic-canonical-checking\r\n`
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n` });
  expect(response.status).toBe(201);
  return (response.body as { import: { id: string; version: string } }).import;
}
const rowsOf = async (id: string) =>
  ListImportRowsResponse.parse((await api.request(`/api/imports/${id}/rows`)).body).items;
const versionOf = (id: string) => (api.db.prepare("SELECT version FROM import_batches WHERE id = ?")
  .get(id) as { version: bigint }).version.toString();
const stateOf = (id: string) => api.db.prepare("SELECT state FROM uploads WHERE import_id = ?").get(id);
function snapshot(tables = ["import_batches", "import_rows", "import_file_claims", "uploads", "audit_events"]) {
  return Object.fromEntries(tables.map(table => [table, api.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
async function discard(id: string, init: TestRequestInit = {}) {
  const response = await api.request(`/api/imports/${id}/discard`, { method: "POST",
    headers: { "if-match": `"${versionOf(id)}"` }, ...init });
  expect(declaredStatuses("/imports/{importId}/discard", "post")).toContain(String(response.status));
  validateAgainst(response.status === 200 ? "ImportBatchResult" : "Problem", response.body);
  return response;
}
async function baselinePosted() {
  await createAccount(api, { trackingStartDate: "2026-04-01" });
  const batch = await upload();
  const rows = await rowsOf(batch.id);
  const account = await api.request(`/api/accounts/${uuid(1)}`);
  const response = await api.request(`/api/accounts/${uuid(1)}/baseline`, { method: "POST",
    headers: { "if-match": account.headers.get("etag")! }, body: {
      mode: "extend_backward", trackingStartDate: "2026-03-01",
      openingBalance: { amountMinor: "125000", currency: "USD" },
      heldRows: { importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] },
    } });
  expect(response.status).toBe(200);
  return batch;
}

describe("discarding unfinished imports", () => {
  it("purges unfinished payloads and bytes, releases the hash, and hides settled rows without losing evidence", async () => {
    const batch = await baselinePosted();
    const finance = snapshot(["transactions", "accounts", "ledger_metadata", "import_source_records", "import_postings"]);
    const response = await discard(batch.id);
    expect(response.body).toMatchObject({ import: { status: "cancelled", expiresAt: null,
      rowCounts: { total: 0, ready: 0, held: 0, excluded: 0 }, commitBlockers: ["not_open"] } });
    expect(response.headers.get("etag")).toBe(`"${versionOf(batch.id)}"`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(snapshot(Object.keys(finance))).toEqual(finance);
    expect(stateOf(batch.id)).toEqual({ state: "deleted" });
    expect(await api.deps.uploads.listStoredKeys()).toEqual([]);
    expect(api.db.prepare("SELECT * FROM import_file_claims").all()).toEqual([]);
    expect(api.db.prepare("SELECT merchant_text FROM import_rows").all()).toEqual([{ merchant_text: "SYNTHETIC CONFIRMED" }]);
    expect((await api.request(`/api/imports/${batch.id}/rows`)).status).toBe(410);
    expect((await api.request(`/api/imports/${batch.id}`)).body).toMatchObject({ rowCounts: { total: 0 } });
    const audits = JSON.stringify(api.db.prepare("SELECT before_json, after_json FROM audit_events WHERE entity_type = 'import'").all());
    expect(audits).not.toContain("SYNTHETIC ABANDONED");
    expect(audits).not.toContain("3742");
    const again = await upload();
    expect(again.id).not.toBe(batch.id);
    expect((await rowsOf(again.id))[0]!.duplicate.status).toBe("suspected");
  });

  it("requires session, CSRF and a current version without changing anything on refusal", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const batch = await upload();
    const before = snapshot();
    expect((await discard(batch.id, { omitCookie: true })).status).toBe(401);
    expect((await discard(batch.id, { csrfToken: null })).status).toBe(403);
    expect((await discard(batch.id, { headers: {} })).status).toBe(428);
    expect((await discard(batch.id, { headers: { "if-match": '"1"' } })).status).toBe(412);
    expect(snapshot()).toEqual(before);
    expect((await discard(batch.id)).status).toBe(200);
    expect((await discard(batch.id)).status).toBe(409);
  });

  it("rolls back deletion, claim release, status and audit if response validation fails", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const batch = await upload();
    const before = snapshot();
    expect(() => withWriteTransaction(api.db, () => discardImport(context(), batch.id,
      BigInt(batch.version), () => { throw new Error("synthetic validation failure"); }))).toThrow();
    expect(snapshot()).toEqual(before);
    expect(await api.deps.uploads.listStoredKeys()).toHaveLength(1);
  });

  it("persists byte deletion failure without failing the discard, then retries after restart", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const batch = await upload();
    const log = vi.spyOn(logger, "warn");
    vi.spyOn(api.deps.uploads, "remove").mockRejectedValue(new Error("SYNTHETIC PRIVATE ERROR"));
    expect((await discard(batch.id)).status).toBe(200);
    expect(log).toHaveBeenCalledWith("import upload deletion will be retried");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SYNTHETIC PRIVATE ERROR");
    expect(stateOf(batch.id)).toEqual({ state: "deletion_pending" });
    await api.restart();
    await recoverInterruptedImports(api.deps);
    expect(stateOf(batch.id)).toEqual({ state: "deleted" });
    expect(await api.deps.uploads.listStoredKeys()).toEqual([]);
  });
});

describe("expiry and completed-file retention", () => {
  it("does not republish or fail an import when asynchronous parsing finishes after abandonment", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const batch = await upload();
    const old = requireBatch(api.db, batch.id);
    const parsed = await parseStoredUpload(SYNTHETIC_CHECKING, (async function* () {
      yield Buffer.from(CSV);
    })());
    expect((await discard(batch.id)).status).toBe(200);
    const before = snapshot();
    expect(withWriteTransaction(api.db, () => publishPreviewUnlessClaimed(context(), old, parsed, "f".repeat(64))))
      .toBe(batch.id);
    withWriteTransaction(api.db, () => failBatch(context(), old,
      { code: "unreadable_file", message: "This file could not be read." }));
    expect(snapshot()).toEqual(before);
  });

  it("continues past one filesystem failure and retries it on the next scheduled sweep", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const first = await upload();
    const second = await upload(CSV.replace("ABANDONED", "OTHER"));
    api.clock.advance(IMPORT_REVIEW_MS);
    const remove = vi.spyOn(api.deps.uploads, "remove").mockRejectedValueOnce(new Error("synthetic failure"));
    await cleanupImports(api.deps);
    expect(remove).toHaveBeenCalledTimes(2);
    const states = [stateOf(first.id), stateOf(second.id)];
    expect(states).toContainEqual({ state: "deletion_pending" });
    expect(states).toContainEqual({ state: "deleted" });
    api.clock.advance(60 * 60 * 1000);
    await cleanupImports(api.deps);
    expect(stateOf(first.id)).toEqual({ state: "deleted" });
    expect(stateOf(second.id)).toEqual({ state: "deleted" });
  });

  it("expires at the exact deadline and preserves baseline postings and source evidence", async () => {
    const batch = await baselinePosted();
    const finance = snapshot(["transactions", "accounts", "ledger_metadata", "import_source_records", "import_postings"]);
    api.clock.advance(IMPORT_REVIEW_MS - 1);
    await cleanupImports(api.deps);
    expect(stateOf(batch.id)).toEqual({ state: "available" });
    api.clock.advance(1);
    await cleanupImports(api.deps);
    expect(stateOf(batch.id)).toEqual({ state: "deleted" });
    expect(snapshot(Object.keys(finance))).toEqual(finance);
    await api.login();
    expect((await api.request(`/api/imports/${batch.id}`)).body).toMatchObject({ status: "expired", rowCounts: { total: 0 } });
    expect((await api.request(`/api/imports/${batch.id}/rows`)).status).toBe(410);
    const before = snapshot();
    await cleanupImports(api.deps);
    expect(snapshot()).toEqual(before);
  });

  it("cleans an overdue restored preview at startup before attempting to reparse it", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const batch = await upload();
    api.clock.advance(IMPORT_REVIEW_MS + 1);
    await api.restart();
    await recoverInterruptedImports(api.deps);
    expect(stateOf(batch.id)).toEqual({ state: "deleted" });
    expect(api.db.prepare("SELECT status FROM import_batches WHERE id = ?").get(batch.id)).toEqual({ status: "expired" });
    expect(api.db.prepare("SELECT * FROM import_rows").all()).toEqual([]);
  });

  it("finishes a deletion interrupted after unlink but before marking the upload deleted", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const batch = await upload();
    api.clock.advance(IMPORT_REVIEW_MS);
    prepareImportCleanup(context());
    const [key] = await api.deps.uploads.listStoredKeys();
    await api.deps.uploads.remove(key!);
    expect(stateOf(batch.id)).toEqual({ state: "deletion_pending" });
    await api.restart();
    await recoverInterruptedImports(api.deps);
    expect(stateOf(batch.id)).toEqual({ state: "deleted" });
  });

  it("retains completed rows, exclusions, sources, results and hash claims after the raw file is gone", async () => {
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const batch = await upload();
    const rows = await rowsOf(batch.id);
    expect((await api.request(`/api/imports/${batch.id}/rows/${rows[1]!.id}`, { method: "PATCH",
      headers: { "if-match": `"${batch.version}"` }, body: { excluded: true } })).status).toBe(200);
    const committed = await api.request(`/api/imports/${batch.id}/commit`, { method: "POST",
      headers: { "if-match": `"${versionOf(batch.id)}"` } });
    expect(committed.status).toBe(200);
    const retained = snapshot(["import_batches", "import_rows", "import_source_records", "import_postings", "import_file_claims"]);
    api.clock.advance(UPLOAD_RETENTION_MS - 1);
    await cleanupImports(api.deps);
    expect(stateOf(batch.id)).toEqual({ state: "available" });
    api.clock.advance(1);
    await cleanupImports(api.deps);
    expect(stateOf(batch.id)).toEqual({ state: "deleted" });
    expect(snapshot(Object.keys(retained))).toEqual(retained);
    await api.login();
    expect((await api.request(`/api/imports/${batch.id}/commit`, { method: "POST" })).body).toEqual(committed.body);
    expect((await discard(batch.id)).status).toBe(409);
    expect(await rowsOf(batch.id)).toHaveLength(2);
  });
});
