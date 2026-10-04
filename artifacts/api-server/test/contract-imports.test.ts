/**
 * Every response the import operations can produce, measured against
 * `openapi.yaml` itself.
 *
 * The other import suites test behaviour and check the responses they happen
 * to touch. This one is organised by the contract instead: it walks each
 * declared status of each import operation, produces it against the real
 * service, and validates the body with Ajv against the approved document. The
 * last test fails if any declared status was neither produced nor listed in
 * `UNREACHABLE` with a reason, so a forgotten response cannot pass quietly.
 *
 * Nothing this file produces is undeclared. The 400s the shared middleware
 * answers for a malformed `If-Match` were undeclared on the three body-less
 * import writes until the contract completion in
 * `83-stage-5-generic-refusal-contract-change.md`; they are ordinary declared
 * coverage now. `Coverage` still accepts an exception list if another gap
 * appears, and refuses an undeclared response by default.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPORT_CSV_LIMITS } from "../src/lib/import-csv.js";
import { IMPORT_REVIEW_MS } from "../src/services/imports.js";
import { startTestServer, type TestRequestInit, type TestServer } from "./harness.js";
import { createAccount, postThroughService, uuid } from "./finance-harness.js";
import { Coverage, declaredStatuses, operationOf, type ObservedResponse } from "./contract-support.js";

interface Op { template: string; method: string }
const FORMATS: Op = { template: "/import-formats", method: "get" };
const LIST: Op = { template: "/imports", method: "get" };
const CREATE: Op = { template: "/imports", method: "post" };
const READ: Op = { template: "/imports/{importId}", method: "get" };
const ROWS: Op = { template: "/imports/{importId}/rows", method: "get" };
const PATCH_ROW: Op = { template: "/imports/{importId}/rows/{rowId}", method: "patch" };
const BULK: Op = { template: "/imports/{importId}/rows/bulk-type", method: "post" };
const REFRESH: Op = { template: "/imports/{importId}/refresh", method: "post" };
const COMMIT: Op = { template: "/imports/{importId}/commit", method: "post" };
const DISCARD: Op = { template: "/imports/{importId}/discard", method: "post" };
const FOLLOW_UPS: Op = { template: "/imports/{importId}/follow-ups", method: "post" };
const ALL = [FORMATS, LIST, CREATE, READ, ROWS, PATCH_ROW, BULK, REFRESH, COMMIT, DISCARD, FOLLOW_UPS];

/**
 * Declared statuses no test here produces, each with the reason. `500` and
 * `503` are declared on all 77 operations as a blanket policy; they come from
 * one shared error handler, and this file exercises them where an import can
 * actually cause them (a failed response check during commit, exhausted upload
 * storage) rather than 22 more times through the same code.
 */
const UNREACHABLE: Record<string, string> = {
  "listImportFormats 500": "shared error handler; no import-specific cause",
  "listImportFormats 503": "shared error handler; no import-specific cause",
  "listImports 500": "shared error handler; no import-specific cause",
  "listImports 503": "shared error handler; no import-specific cause",
  "getImport 500": "shared error handler; no import-specific cause",
  "getImport 503": "shared error handler; no import-specific cause",
  "listImportRows 500": "shared error handler; no import-specific cause",
  "listImportRows 503": "shared error handler; no import-specific cause",
  "updateImportRow 500": "shared error handler; covered on commitImport",
  "updateImportRow 503": "shared error handler; no import-specific cause",
  "bulkSetImportRowType 500": "shared error handler; covered on commitImport",
  "bulkSetImportRowType 503": "shared error handler; no import-specific cause",
  "refreshImport 500": "shared error handler; covered on commitImport",
  "refreshImport 503": "shared error handler; no import-specific cause",
  "commitImport 503": "shared error handler; covered on createImport",
  "discardImport 500": "shared error handler; covered on commitImport",
  "discardImport 503": "shared error handler; no import-specific cause",
  "createImportFollowUp 500": "shared error handler; covered on commitImport",
  "createImportFollowUp 503": "shared error handler; no import-specific cause",
  "createImport 500": "shared error handler; no import-specific cause",
};

const cover = new Coverage();

const BOUNDARY = "MoneyDeskContractBoundary";
const HEADERS = "Date,Description,Amount,Type\r\n";
const READY = "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n";
const HELD_DATE = "not-a-date,SYNTHETIC HELD,-12.50,DEBIT\r\n";
const NO_DESCRIPTION = "05/05/2026,,-9.99,DEBIT\r\n";
const TWO_READY = READY + "05/02/2026,SYNTHETIC SECOND,-10.00,DEBIT\r\n";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { trackingStartDate: "2026-01-01" });
});
afterEach(async () => { await api.close(); });

async function call(op: Op, url: string, init: TestRequestInit = {}): Promise<ObservedResponse> {
  const response = await api.request(url, { method: op.method.toUpperCase(), ...init });
  return cover.check(op.template, op.method, response);
}

function multipart(
  csv: string,
  fields: [string, string][] = [["accountId", uuid(1)], ["formatId", "synthetic-canonical-checking"]],
): TestRequestInit {
  return {
    method: "POST", contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    rawBody: fields.map(([name, value]) =>
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")
      + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="fabricated.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${csv}\r\n--${BOUNDARY}--\r\n`,
  };
}

interface Batch { id: string; version: string }
async function upload(csv = HEADERS + READY, fields?: [string, string][]): Promise<Batch> {
  const response = await call(CREATE, "/api/imports", multipart(csv, fields));
  expect(response.status, response.text).toBe(201);
  // A file the reader rejected also answers 201, so a helper that only checked
  // the status could hand back a failed batch as if it were a preview.
  expect(response.body, response.text).toMatchObject({ import: { status: "preview" } });
  return (response.body as { import: Batch }).import;
}

const versionOf = (id: string): string =>
  (api.db.prepare("SELECT version FROM import_batches WHERE id = ?").get(id) as { version: bigint })
    .version.toString();

async function rowsOf(id: string): Promise<{ id: string; rowNumber: number; state: string }[]> {
  const response = await call(ROWS, `/api/imports/${id}/rows?limit=200`);
  expect(response.status, response.text).toBe(200);
  return (response.body as { items: { id: string; rowNumber: number; state: string }[] }).items;
}

const ifMatch = (version: string): TestRequestInit => ({ headers: { "if-match": `"${version}"` } });

/**
 * The refusals every signed-in write shares. All come from middleware ahead of
 * the handler, so a well-formed precondition is not needed to reach them - and
 * must not be, or the test would be proving the handler instead.
 *
 * 413 and 415 are the generic refusals the contract completion declared on
 * every write (`83-stage-5-generic-refusal-contract-change.md`). They are
 * produced here rather than excused, because every one of these operations
 * really answers them.
 */
async function sharedWriteRefusals(op: Op, url: string, body?: unknown): Promise<void> {
  const init: TestRequestInit = { ...ifMatch("1"), ...(body === undefined ? {} : { body }) };
  expect((await call(op, url, { ...init, omitCookie: true })).status).toBe(401);
  expect((await call(op, url, { ...init, csrfToken: null })).status).toBe(403);
  // Wrong content type, refused before any body parser runs. Body-less writes
  // reach this too: the check is on the header, not on whether a body is used.
  expect((await call(op, url,
    { ...init, contentType: "text/plain", rawBody: "{}" })).status).toBe(415);
  // Over the 64 KiB JSON limit for these routes; nothing is read or saved.
  expect((await call(op, url,
    { ...init, contentType: "application/json", rawBody: oversizeJson() })).status).toBe(413);
}

/** A syntactically valid JSON body just past `MAX_JSON_BODY_BYTES`. */
const oversizeJson = (): string => `{"pad":"${"x".repeat(64 * 1024)}"}`;

describe("import reads against the contract", () => {
  it("lists formats and refuses a signed-out reader", async () => {
    const formats = await call(FORMATS, "/api/import-formats");
    expect(formats.status).toBe(200);
    expect((formats.body as { items: { id: string }[] }).items.map(format => format.id))
      .toEqual(["synthetic-canonical-checking", "synthetic-status-card", "synthetic-identified-checking"]);
    expect((await call(FORMATS, "/api/import-formats", { omitCookie: true })).status).toBe(401);
  });

  it("lists imports with filters, a full page and every unusable list option", async () => {
    const first = await upload(HEADERS + READY);
    const second = await upload(HEADERS + TWO_READY);

    const all = await call(LIST, "/api/imports?limit=100");
    expect(all.status).toBe(200);
    expect((all.body as { items: { id: string }[] }).items.map(item => item.id))
      .toEqual([second.id, first.id]);

    const filtered = await call(LIST, `/api/imports?accountId=${uuid(1)}&status=preview`);
    expect(filtered.status).toBe(200);
    expect((filtered.body as { items: unknown[] }).items).toHaveLength(2);

    const page = await call(LIST, "/api/imports?limit=1");
    expect(page.status).toBe(200);
    const cursor = (page.body as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    const next = await call(LIST, `/api/imports?limit=1&cursor=${cursor!}`);
    expect(next.status).toBe(200);
    expect((next.body as { items: { id: string }[] }).items.map(item => item.id)).toEqual([first.id]);
    expect((next.body as { nextCursor: string | null }).nextCursor).toBeNull();

    for (const query of ["?accountId=not-an-id", "?status=invented", "?limit=0", "?limit=101", "?cursor=%20"]) {
      const refused = await call(LIST, `/api/imports${query}`);
      expect(refused.status, query).toBe(400);
    }
    expect((await call(LIST, "/api/imports", { omitCookie: true })).status).toBe(401);
  });

  it("reads one import, and refuses an unknown id or a signed-out reader", async () => {
    const batch = await upload();
    const read = await call(READ, `/api/imports/${batch.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("etag")).toBe(`"${batch.version}"`);
    expect((await call(READ, `/api/imports/${uuid(99)}`)).status).toBe(404);
    expect((await call(READ, "/api/imports/not-a-uuid")).status).toBe(404);
    expect((await call(READ, `/api/imports/${batch.id}`, { omitCookie: true })).status).toBe(401);
  });

  it("returns a maximum-size row page with maximum-size retained fields", async () => {
    // 201 rows so a full 200-row page still has a next cursor, each with a
    // description at the reader's field limit: the largest row page the
    // contract permits, validated whole rather than assumed to fit.
    const description = "S".repeat(IMPORT_CSV_LIMITS.maxFieldBytes - 6);
    const rows = Array.from({ length: 201 }, (_, index) =>
      `05/01/2026,${description}${String(index).padStart(6, "0")},-${String(index + 1)}.99,DEBIT\r\n`);
    const batch = await upload(HEADERS + rows.join(""));

    const page = await call(ROWS, `/api/imports/${batch.id}/rows?limit=200`);
    expect(page.status).toBe(200);
    const body = page.body as { items: { sourceFields: Record<string, string>;
      normalized: { merchant: string | null } }[]; nextCursor: string | null };
    expect(body.items).toHaveLength(200);
    expect(body.nextCursor).not.toBeNull();
    expect(body.items[0]!.sourceFields["Description"]).toHaveLength(IMPORT_CSV_LIMITS.maxFieldBytes);
    // The contract bounds a normalized merchant at 2000 characters, so the
    // reader must truncate rather than answer with a value it cannot describe.
    expect(body.items[0]!.normalized.merchant).toHaveLength(2000);

    const last = await call(ROWS, `/api/imports/${batch.id}/rows?limit=200&cursor=${body.nextCursor!}`);
    expect(last.status).toBe(200);
    expect((last.body as { items: unknown[]; nextCursor: null }).items).toHaveLength(1);
    expect((last.body as { nextCursor: string | null }).nextCursor).toBeNull();
  });

  it("filters rows, and refuses unusable options, an unknown import and discarded contents", async () => {
    const batch = await upload(HEADERS + READY + HELD_DATE);
    const held = await call(ROWS, `/api/imports/${batch.id}/rows?state=held`);
    expect(held.status).toBe(200);
    expect((held.body as { items: { state: string }[] }).items.map(row => row.state)).toEqual(["held"]);

    for (const query of ["?state=invented", "?limit=201", "?state=ready&state=held", "?unknown=1"]) {
      expect((await call(ROWS, `/api/imports/${batch.id}/rows${query}`)).status, query).toBe(400);
    }
    const badCursor = await call(ROWS, `/api/imports/${batch.id}/rows?cursor=bm90LWpzb24`);
    expect(badCursor.status).toBe(400);
    expect((badCursor.body as { code: string }).code).toBe("invalid_cursor");
    // A cursor from one filter is not valid under another.
    const first = await call(ROWS, `/api/imports/${batch.id}/rows?limit=1`);
    const mismatched = await call(ROWS,
      `/api/imports/${batch.id}/rows?state=held&limit=1&cursor=${(first.body as { nextCursor: string }).nextCursor}`);
    expect(mismatched.status).toBe(400);

    expect((await call(ROWS, `/api/imports/${uuid(99)}/rows`)).status).toBe(404);
    expect((await call(ROWS, `/api/imports/${batch.id}/rows`, { omitCookie: true })).status).toBe(401);

    expect((await call(DISCARD, `/api/imports/${batch.id}/discard`, ifMatch(batch.version))).status).toBe(200);
    const gone = await call(ROWS, `/api/imports/${batch.id}/rows`);
    expect(gone.status).toBe(410);
    expect((gone.body as { code: string }).code).toBe("import_contents_deleted");
  });
});

describe("creating an import against the contract", () => {
  it("answers 201 for a new preview and 200 for the same file again", async () => {
    const created = await call(CREATE, "/api/imports", multipart(HEADERS + READY));
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe(`/api/imports/${(created.body as { import: Batch }).import.id}`);
    expect((created.body as { disposition: string }).disposition).toBe("created");

    const again = await call(CREATE, "/api/imports", multipart(HEADERS + READY));
    expect(again.status).toBe(200);
    expect((again.body as { disposition: string }).disposition).toBe("existing_preview");

    const batch = (created.body as { import: Batch }).import;
    expect((await call(COMMIT, `/api/imports/${batch.id}/commit`, ifMatch(batch.version))).status).toBe(200);
    const completed = await call(CREATE, "/api/imports", multipart(HEADERS + READY));
    expect(completed.status).toBe(200);
    expect((completed.body as { disposition: string }).disposition).toBe("existing_completed");
  });

  it("answers 201 with a recorded failure when the file cannot be read", async () => {
    const created = await call(CREATE, "/api/imports", multipart("Nothing,Useful\r\nx,y\r\n"));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ import: { status: "failed", failure: { code: "header_mismatch" } } });
  });

  it("refuses an unknown account, an archived account and an unavailable format", async () => {
    expect((await call(CREATE, "/api/imports",
      multipart(HEADERS + READY, [["accountId", uuid(98)], ["formatId", "synthetic-canonical-checking"]]))).status)
      .toBe(404);
    expect((await call(CREATE, "/api/imports",
      multipart(HEADERS + READY, [["accountId", "not-a-uuid"], ["formatId", "synthetic-canonical-checking"]]))).status)
      .toBe(404);

    const unsupported = await call(CREATE, "/api/imports",
      multipart(HEADERS + READY, [["accountId", uuid(1)], ["formatId", "chase-checking"]]));
    expect(unsupported.status).toBe(422);
    expect((unsupported.body as { code: string }).code).toBe("unsupported_file_format");
    // A format for another kind of account is refused for this one.
    const mismatched = await call(CREATE, "/api/imports",
      multipart(HEADERS + READY, [["accountId", uuid(1)], ["formatId", "synthetic-status-card"]]));
    expect(mismatched.status).toBe(422);
    // A missing required field is unreadable rather than a validation failure
    // of a JSON body this route never has.
    const incomplete = await call(CREATE, "/api/imports",
      multipart(HEADERS + READY, [["accountId", uuid(1)]]));
    expect(incomplete.status).toBe(422);
    expect((incomplete.body as { code: string }).code).toBe("validation_failed");

    const account = await api.request(`/api/accounts/${uuid(1)}`);
    expect((await api.request(`/api/accounts/${uuid(1)}/archive`,
      { method: "POST", headers: { "if-match": account.headers.get("etag")! } })).status).toBe(200);
    const archived = await call(CREATE, "/api/imports", multipart(HEADERS + READY));
    expect(archived.status).toBe(409);
    expect((archived.body as { code: string }).code).toBe("reactivation_required");
  });

  it("refuses a file over the store's byte limit and keeps none of it", async () => {
    // The real bound is ten megabytes. A client sharing this process's event
    // loop with the server cannot push that much without destabilising the
    // worker, so the store's own bound is lowered and the same refusal is
    // produced from the same code path. The parser's ten-megabyte truncation
    // is measured separately, with an out-of-process client, under Phase 6's
    // maximum-file workload.
    await api.close();
    api = await startTestServer({ uploadMaxBytes: 4096 });
    await api.login();
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    const oversized = HEADERS + `05/01/2026,${"S".repeat(200)},-1.00,DEBIT\r\n`.repeat(40);
    expect(oversized.length).toBeGreaterThan(4096);
    const large = await call(CREATE, "/api/imports", multipart(oversized));
    expect(large.status).toBe(413);
    expect((large.body as { code: string }).code).toBe("payload_too_large");
    expect(await api.deps.uploads.listStoredKeys()).toEqual([]);
  });

  it("refuses a body that is not multipart", async () => {
    const wrongType = await call(CREATE, "/api/imports",
      { method: "POST", body: { accountId: uuid(1), formatId: "synthetic-canonical-checking" } });
    expect(wrongType.status).toBe(415);
    expect((wrongType.body as { code: string }).code).toBe("unsupported_media_type");
  });

  it("refuses an upload with no session or no token", async () => {
    expect((await call(CREATE, "/api/imports", { ...multipart(HEADERS + READY), omitCookie: true })).status).toBe(401);
    expect((await call(CREATE, "/api/imports", { ...multipart(HEADERS + READY), csrfToken: null })).status).toBe(403);
  });

  it("refuses a further upload when upload storage is full", async () => {
    await api.close();
    api = await startTestServer({ uploadCapacity: 1 });
    await api.login();
    await createAccount(api, { trackingStartDate: "2026-01-01" });
    await upload(HEADERS + READY);
    const busy = await call(CREATE, "/api/imports", multipart(HEADERS + TWO_READY));
    expect(busy.status).toBe(503);
    expect(busy.body).toMatchObject({ code: "service_busy", retryAfterSeconds: 30 });
  });
});

describe("review writes against the contract", () => {
  it("saves a row and refuses every unusable save", async () => {
    const batch = await upload(HEADERS + READY + HELD_DATE);
    const rows = await rowsOf(batch.id);
    const url = `/api/imports/${batch.id}/rows/${rows[0]!.id}`;

    const saved = await call(PATCH_ROW, url, { ...ifMatch(batch.version), body: { excluded: true } });
    expect(saved.status).toBe(200);
    const version = (saved.body as { import: Batch }).import.version;

    expect((await call(PATCH_ROW, url, { ...ifMatch(version), body: {} })).status).toBe(422);
    expect((await call(PATCH_ROW, url, { ...ifMatch(version), body: { merchant: "" } })).status).toBe(422);
    expect((await call(PATCH_ROW, url, { headers: { "if-match": "nonsense" }, body: { excluded: false } })).status)
      .toBe(400);
    expect((await call(PATCH_ROW, url, { body: { excluded: false } })).status).toBe(428);
    expect((await call(PATCH_ROW, url, { ...ifMatch("1"), body: { excluded: false } })).status).toBe(412);
    expect((await call(PATCH_ROW, `/api/imports/${batch.id}/rows/${uuid(97)}`,
      { ...ifMatch(version), body: { excluded: false } })).status).toBe(404);
    expect((await call(PATCH_ROW, `/api/imports/${uuid(99)}/rows/${rows[0]!.id}`,
      { ...ifMatch(version), body: { excluded: false } })).status).toBe(404);
    await sharedWriteRefusals(PATCH_ROW, url, { excluded: false });

    expect((await call(DISCARD, `/api/imports/${batch.id}/discard`, ifMatch(versionOf(batch.id)))).status).toBe(200);
    const deleted = await call(PATCH_ROW, url, { ...ifMatch(versionOf(batch.id)), body: { excluded: false } });
    expect(deleted.status).toBe(410);
  });

  it("refuses a save on a finished import", async () => {
    const batch = await upload(HEADERS + READY);
    const rows = await rowsOf(batch.id);
    expect((await call(COMMIT, `/api/imports/${batch.id}/commit`, ifMatch(batch.version))).status).toBe(200);
    const closed = await call(PATCH_ROW, `/api/imports/${batch.id}/rows/${rows[0]!.id}`,
      { ...ifMatch(versionOf(batch.id)), body: { excluded: true } });
    expect(closed.status).toBe(409);
    expect((closed.body as { code: string }).code).toBe("import_not_open");
  });

  it("applies a type to matching rows and refuses every unusable request", async () => {
    const batch = await upload(HEADERS + READY + READY.replace("05/01", "05/03") + NO_DESCRIPTION);
    const rows = await rowsOf(batch.id);
    const url = `/api/imports/${batch.id}/rows/bulk-type`;

    const applied = await call(BULK, url, { ...ifMatch(batch.version), body: { rowId: rows[0]!.id, kind: "purchase" } });
    expect(applied.status).toBe(200);
    expect((applied.body as { updatedRowIds: string[] }).updatedRowIds).toHaveLength(2);
    const version = (applied.body as { import: Batch }).import.version;

    const noDescription = rows.find(row => row.rowNumber === 3)!;
    const refused = await call(BULK, url, { ...ifMatch(version), body: { rowId: noDescription.id, kind: "purchase" } });
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe("validation_failed");
    expect((await call(BULK, url, { ...ifMatch(version), body: { rowId: rows[0]!.id, kind: "invented" } })).status)
      .toBe(422);
    expect((await call(BULK, url, { headers: { "if-match": "nonsense" }, body: { rowId: rows[0]!.id, kind: "purchase" } })).status)
      .toBe(400);
    expect((await call(BULK, url, { body: { rowId: rows[0]!.id, kind: "purchase" } })).status).toBe(428);
    expect((await call(BULK, url, { ...ifMatch("1"), body: { rowId: rows[0]!.id, kind: "purchase" } })).status).toBe(412);
    expect((await call(BULK, url, { ...ifMatch(version), body: { rowId: uuid(97), kind: "purchase" } })).status).toBe(404);
    expect((await call(BULK, `/api/imports/${uuid(99)}/rows/bulk-type`,
      { ...ifMatch(version), body: { rowId: rows[0]!.id, kind: "purchase" } })).status).toBe(404);
    await sharedWriteRefusals(BULK, url, { rowId: rows[0]!.id, kind: "purchase" });

    // Thirty days also ends the session, so the owner signs in again: the
    // refusal under test is the expired preview, not the expired session.
    api.clock.advance(IMPORT_REVIEW_MS);
    await api.login();
    const expired = await call(BULK, url,
      { ...ifMatch(versionOf(batch.id)), body: { rowId: rows[0]!.id, kind: "purchase" } });
    expect(expired.status).toBe(410);
    expect((expired.body as { code: string }).code).toBe("preview_expired");
  });

  it("refuses a bulk type on a finished import", async () => {
    const batch = await upload(HEADERS + READY);
    const rows = await rowsOf(batch.id);
    expect((await call(COMMIT, `/api/imports/${batch.id}/commit`, ifMatch(batch.version))).status).toBe(200);
    const closed = await call(BULK, `/api/imports/${batch.id}/rows/bulk-type`,
      { ...ifMatch(versionOf(batch.id)), body: { rowId: rows[0]!.id, kind: "purchase" } });
    expect(closed.status).toBe(409);
  });

  it("refreshes a preview and refuses every unusable refresh", async () => {
    const batch = await upload(HEADERS + READY);
    const url = `/api/imports/${batch.id}/refresh`;
    const refreshed = await call(REFRESH, url, ifMatch(batch.version));
    expect(refreshed.status).toBe(200);

    expect((await call(REFRESH, url, { headers: { "if-match": "nonsense" } })).status).toBe(400);
    expect((await call(REFRESH, url)).status).toBe(428);
    expect((await call(REFRESH, url, ifMatch("1"))).status).toBe(412);
    expect((await call(REFRESH, `/api/imports/${uuid(99)}/refresh`, ifMatch("1"))).status).toBe(404);
    await sharedWriteRefusals(REFRESH, url);

    api.clock.advance(IMPORT_REVIEW_MS);
    await api.login();
    expect((await call(REFRESH, url, ifMatch(versionOf(batch.id)))).status).toBe(410);
  });

  it("refuses a refresh on a finished import", async () => {
    const batch = await upload(HEADERS + READY);
    expect((await call(COMMIT, `/api/imports/${batch.id}/commit`, ifMatch(batch.version))).status).toBe(200);
    expect((await call(REFRESH, `/api/imports/${batch.id}/refresh`, ifMatch(versionOf(batch.id)))).status).toBe(409);
  });
});

describe("commit against the contract", () => {
  it("commits, replays the recorded result, and refuses every unusable confirmation", async () => {
    const batch = await upload(HEADERS + TWO_READY);
    const url = `/api/imports/${batch.id}/commit`;

    expect((await call(COMMIT, url, { headers: { "if-match": "nonsense" } })).status).toBe(400);
    expect((await call(COMMIT, url)).status).toBe(428);
    expect((await call(COMMIT, url, ifMatch("999"))).status).toBe(412);
    expect((await call(COMMIT, `/api/imports/${uuid(99)}/commit`, ifMatch("1"))).status).toBe(404);
    await sharedWriteRefusals(COMMIT, url);

    const committed = await call(COMMIT, url, ifMatch(versionOf(batch.id)));
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({ import: { status: "committed",
      result: { rows: 2, added: 2, excluded: 0, pairedTransfers: 0 } } });
    // A repeated confirmation is the recorded result, whatever version it sends.
    const replay = await call(COMMIT, url, ifMatch("1"));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ import: { result: { added: 2 } } });
  });

  it("refuses held rows, changed inputs, an archived account and an expired preview", async () => {
    const held = await upload(HEADERS + READY + HELD_DATE);
    const blocked = await call(COMMIT, `/api/imports/${held.id}/commit`, ifMatch(held.version));
    expect(blocked.status).toBe(409);
    expect((blocked.body as { code: string }).code).toBe("held_rows_unresolved");

    // The ledger this preview was measured against moved on.
    postThroughService(api, { accountId: uuid(1), postedDate: "2026-05-04", merchant: "SYNTHETIC OTHER",
      kind: "purchase", money: { amountMinor: "-2500", currency: "USD" } });
    const stale = await call(COMMIT, `/api/imports/${held.id}/commit`, ifMatch(versionOf(held.id)));
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe("preview_stale");

    const ready = await upload(HEADERS + TWO_READY);
    const account = await api.request(`/api/accounts/${uuid(1)}`);
    expect((await api.request(`/api/accounts/${uuid(1)}/archive`,
      { method: "POST", headers: { "if-match": account.headers.get("etag")! } })).status).toBe(200);
    // Archiving invalidates every open preview on the account, which advances
    // their versions, so the confirmation must send the version it now has.
    const archived = await call(COMMIT, `/api/imports/${ready.id}/commit`, ifMatch(versionOf(ready.id)));
    expect(archived.status).toBe(409);
    expect((archived.body as { code: string }).code).toBe("reactivation_required");

    api.clock.advance(IMPORT_REVIEW_MS);
    await api.login();
    const expired = await call(COMMIT, `/api/imports/${ready.id}/commit`, ifMatch(versionOf(ready.id)));
    expect(expired.status).toBe(410);
  });

  it("answers 500 and posts nothing when a write inside the commit fails", async () => {
    const batch = await upload(HEADERS + TWO_READY);
    const before = api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get();
    api.db.exec(`CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON transactions
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    const failed = await call(COMMIT, `/api/imports/${batch.id}/commit`, ifMatch(batch.version));
    expect(failed.status).toBe(500);
    expect((failed.body as { code: string }).code).toBe("internal_error");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual(before);
  });
});

describe("discard against the contract", () => {
  it("discards once and refuses every unusable discard", async () => {
    const batch = await upload(HEADERS + READY);
    const url = `/api/imports/${batch.id}/discard`;

    expect((await call(DISCARD, url, { headers: { "if-match": "nonsense" } })).status).toBe(400);
    expect((await call(DISCARD, url)).status).toBe(428);
    expect((await call(DISCARD, url, ifMatch("999"))).status).toBe(412);
    expect((await call(DISCARD, `/api/imports/${uuid(99)}/discard`, ifMatch("1"))).status).toBe(404);
    await sharedWriteRefusals(DISCARD, url);

    const discarded = await call(DISCARD, url, ifMatch(versionOf(batch.id)));
    expect(discarded.status).toBe(200);
    expect(discarded.body).toMatchObject({ import: { status: "cancelled",
      rowCounts: { total: 0 }, commitBlockers: ["not_open"] } });

    const again = await call(DISCARD, url, ifMatch(versionOf(batch.id)));
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe("import_not_open");
  });
});

describe("follow-up reviews against the contract", () => {
  /** Commits an import whose second row was left out, so it has something to revisit. */
  async function completedWithExclusion(csv = HEADERS + TWO_READY): Promise<Batch> {
    const batch = await upload(csv);
    const rows = await rowsOf(batch.id);
    const saved = await call(PATCH_ROW, `/api/imports/${batch.id}/rows/${rows[1]!.id}`,
      { ...ifMatch(batch.version), body: { excluded: true } });
    expect(saved.status).toBe(200);
    const committed = await call(COMMIT, `/api/imports/${batch.id}/commit`, ifMatch(versionOf(batch.id)));
    expect(committed.status).toBe(200);
    return { id: batch.id, version: versionOf(batch.id) };
  }

  it("creates a linked review, replays the same id, and refuses a reused id on another parent", async () => {
    const parent = await completedWithExclusion();
    const url = `/api/imports/${parent.id}/follow-ups`;
    const created = await call(FOLLOW_UPS, url, { body: { id: uuid(50) } });
    expect(created.status).toBe(201);
    expect(created.headers.get("location")).toBe(`/api/imports/${uuid(50)}`);
    expect(created.body).toMatchObject({ disposition: "created",
      import: { id: uuid(50), parentImportId: parent.id, status: "preview" } });

    const replay = await call(FOLLOW_UPS, url, { body: { id: uuid(50) } });
    expect(replay.status).toBe(200);
    expect((replay.body as { disposition: string }).disposition).toBe("existing_preview");

    const other = await completedWithExclusion(HEADERS + READY.replace("05/01", "05/07")
      + "05/08/2026,SYNTHETIC THIRD,-3.00,DEBIT\r\n");
    const conflict = await call(FOLLOW_UPS, `/api/imports/${other.id}/follow-ups`, { body: { id: uuid(50) } });
    expect(conflict.status).toBe(409);
    expect((conflict.body as { code: string }).code).toBe("client_id_conflict");
  });

  it("refuses an unfinished parent, an unknown parent, a malformed body and an archived account", async () => {
    const preview = await upload(HEADERS + TWO_READY);
    const unfinished = await call(FOLLOW_UPS, `/api/imports/${preview.id}/follow-ups`, { body: { id: uuid(51) } });
    expect(unfinished.status).toBe(422);

    expect((await call(FOLLOW_UPS, `/api/imports/${uuid(99)}/follow-ups`, { body: { id: uuid(52) } })).status).toBe(404);

    const parent = await completedWithExclusion(HEADERS + "05/09/2026,SYNTHETIC NINE,-9.00,DEBIT\r\n"
      + "05/10/2026,SYNTHETIC TEN,-10.00,DEBIT\r\n");
    const url = `/api/imports/${parent.id}/follow-ups`;
    expect((await call(FOLLOW_UPS, url, { rawBody: "{" })).status).toBe(400);
    expect((await call(FOLLOW_UPS, url, { body: { id: "not-a-uuid" } })).status).toBe(422);
    expect((await call(FOLLOW_UPS, url, { body: {} })).status).toBe(422);
    await sharedWriteRefusals(FOLLOW_UPS, url, { id: uuid(53) });

    const account = await api.request(`/api/accounts/${uuid(1)}`);
    expect((await api.request(`/api/accounts/${uuid(1)}/archive`,
      { method: "POST", headers: { "if-match": account.headers.get("etag")! } })).status).toBe(200);
    const archived = await call(FOLLOW_UPS, url, { body: { id: uuid(54) } });
    expect(archived.status).toBe(409);
    expect((archived.body as { code: string }).code).toBe("reactivation_required");
  });
});

describe("coverage of the import contract", () => {
  it("produced every declared response, or named why it cannot happen", () => {
    expect(cover.missing(ALL.map(op => [op.template, op.method]), UNREACHABLE)).toEqual([]);
  });

  it("keeps no unexercised exclusions", () => {
    // An exclusion a test turned out to reach is a stale excuse.
    expect(cover.staleExclusions(UNREACHABLE)).toEqual([]);
  });

  it("declares the middleware refusals the body-less import writes produce", () => {
    // These three were the contract gap that `KNOWN_UNDECLARED` used to hold
    // open. The 400s are produced by cases above; this pins the declaration so
    // the gap cannot reopen unnoticed.
    for (const template of ["/imports/{importId}/discard", "/imports/{importId}/commit",
      "/imports/{importId}/refresh"]) {
      expect(declaredStatuses(template, "post"), `${template} no longer declares 400`).toContain("400");
      expect(cover.observed(operationOf(template, "post").operationId, 400),
        `${template} 400 was never produced`).toBe(true);
    }
  });
});
