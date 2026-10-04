/**
 * Saving review work on an import, end to end.
 *
 * Three properties carry most of these tests. A save never changes the values
 * the bank wrote. A save from a stale tab is refused rather than applied. And
 * only a successful save counts as review activity, so reading and polling
 * cannot keep a preview alive indefinitely.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ListImportRowsResponse, UpdateImportRowResponse, BulkSetImportRowTypeResponse } from "@workspace/api-zod";
import { startTestServer, type TestResponse, type TestServer } from "./harness.js";
import { createAccount, INCOME_CATEGORY, postThroughService, uuid } from "./finance-harness.js";
import { IMPORT_REVIEW_MS } from "../src/services/imports.js";

const BOUNDARY = "MoneyDeskReviewTest";

/**
 * Row 1 is a clean purchase, row 2 has an unreadable date, row 3 is a positive
 * amount the bank did not classify, and row 4 has no amount at all.
 */
const CSV = "Date,Description,Amount,Type\r\n"
  + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n"
  + "bad-date,SYNTHETIC MARKET,-12.50,DEBIT\r\n"
  + "05/03/2026,SYNTHETIC PAYROLL,2500.00,CREDIT\r\n"
  + "05/04/2026,SYNTHETIC UNREADABLE,not-a-number,DEBIT\r\n";

let api: TestServer;
let importId: string;
let batchVersion: string;

async function upload(csv = CSV): Promise<{ id: string; version: string }> {
  const fields = [["accountId", uuid(1)], ["formatId", "synthetic-canonical-checking"]];
  const response = await api.request("/api/imports", {
    method: "POST", contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    rawBody: fields.map(([name, value]) =>
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")
      + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="fabricated.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${csv}\r\n--${BOUNDARY}--\r\n`,
  });
  expect(response.status).toBe(201);
  const body = response.body as { import: { id: string; version: string } };
  return { id: body.import.id, version: body.import.version };
}

async function rows(): Promise<ReturnType<typeof ListImportRowsResponse.parse>["items"]> {
  const response = await api.request(`/api/imports/${importId}/rows`);
  return ListImportRowsResponse.parse(response.body).items;
}

async function rowNumbered(number: number) {
  const found = (await rows()).find(row => row.rowNumber === number);
  expect(found).toBeDefined();
  return found!;
}

const save = async (rowId: string, patch: unknown, version = batchVersion): Promise<TestResponse> =>
  api.request(`/api/imports/${importId}/rows/${rowId}`, {
    method: "PATCH", body: patch, headers: { "if-match": `"${version}"` },
  });

const bulk = async (body: unknown, version = batchVersion): Promise<TestResponse> =>
  api.request(`/api/imports/${importId}/rows/bulk-type`, {
    method: "POST", body, headers: { "if-match": `"${version}"` },
  });

/** Applies a save and adopts the batch version it returns, as a client would. */
async function saved(rowId: string, patch: unknown): Promise<TestResponse> {
  const response = await save(rowId, patch);
  expect(response.status).toBe(200);
  batchVersion = (response.body as { import: { version: string } }).import.version;
  return response;
}

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { id: uuid(1), trackingStartDate: "2026-01-01" });
  const created = await upload();
  importId = created.id;
  batchVersion = created.version;
});
afterEach(async () => { await api.close(); });

describe("saving a correction", () => {
  it("corrects a date without touching the values the bank wrote", async () => {
    const before = await rowNumbered(2);
    expect(before.state).toBe("held");
    expect(before.issues.map(issue => issue.code)).toContain("invalid_date");

    const response = await saved(before.id, { postedDate: "2026-05-02" });
    const result = UpdateImportRowResponse.parse(response.body);
    expect(result.row.normalized.postedDate).toBe("2026-05-02");
    // The original, unreadable value is still there as evidence.
    expect(result.row.sourceFields["Date"]).toBe("bad-date");
    expect(result.row.state).toBe("ready");
    expect(result.row.issues).toEqual([]);
    expect(result.row.version).toBe("2");
    expect(response.headers.get("etag")).toBe(`"${result.import.version}"`);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("corrects an unreadable amount and proposes a type for it", async () => {
    const before = await rowNumbered(4);
    expect(before.normalized.money).toBeNull();
    expect(before.issues.map(issue => issue.code)).toEqual(["invalid_amount"]);
    const result = UpdateImportRowResponse.parse(
      (await saved(before.id, { money: { amountMinor: "-3300", currency: "USD" } })).body);
    expect(result.row.normalized.money).toEqual({ amountMinor: "-3300", currency: "USD" });
    expect(result.row.sourceFields["Amount"]).toBe("not-a-number");
    expect(result.row.kind).toBe("purchase");
    expect(result.row.state).toBe("ready");
  });

  it("keeps the original reason an amount was held when only the date is corrected", async () => {
    const row = await rowNumbered(4);
    const result = UpdateImportRowResponse.parse((await saved(row.id, { postedDate: "2026-05-05" })).body);
    expect(result.row.issues.map(issue => issue.code)).toEqual(["invalid_amount"]);
    expect(result.row.state).toBe("held");
  });

  it("refuses a correction that would leave nothing changed at all", async () => {
    const row = await rowNumbered(1);
    const response = await save(row.id, {});
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: "validation_failed" });
  });

  it("allows re-saving a choice that is already the current one", async () => {
    const row = await rowNumbered(1);
    const first = UpdateImportRowResponse.parse((await saved(row.id, { kind: "purchase" })).body);
    const again = UpdateImportRowResponse.parse((await saved(row.id, { kind: "purchase" })).body);
    expect(again.row.kind).toBe("purchase");
    expect(again.row.version).toBe(String(Number(first.row.version) + 1));
  });
});

describe("choosing a type and a category", () => {
  it("records an owner's choice of income and gives it the Income category", async () => {
    const row = await rowNumbered(3);
    expect(row.issues.map(issue => issue.code)).toEqual(["choose_type"]);
    const result = UpdateImportRowResponse.parse((await saved(row.id, { kind: "income" })).body);
    expect(result.row).toMatchObject({ kind: "income", kindSource: "owner", state: "ready" });
    expect(result.row.assignment).toEqual({
      categoryId: INCOME_CATEGORY, origin: "system", ruleId: null, ruleRevision: null,
    });
  });

  it("refuses a type the amount's sign cannot carry", async () => {
    const row = await rowNumbered(3);
    const response = await save(row.id, { kind: "purchase" });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: "kind_sign_mismatch" });
    // Nothing was changed.
    expect((await rowNumbered(3)).version).toBe("1");
  });

  it("refuses a category on a type that has none, and requires a type first", async () => {
    const income = await rowNumbered(3);
    expect((await save(income.id, { kind: "income", category: { mode: "rules" } })).status).toBe(422);
    expect((await save(income.id, { category: { mode: "rules" } })).status).toBe(422);
  });

  it("assigns a purchase by rules and lets an explicit choice replace it", async () => {
    const category = await api.request("/api/categories", {
      method: "POST", body: { id: uuid(9, "30000000"), name: "Synthetic Groceries", color: "#336699" },
    });
    expect(category.status).toBe(201);
    await api.request("/api/rules", {
      method: "POST",
      body: { id: uuid(8, "40000000"), matchType: "contains", pattern: "SYNTHETIC MARKET",
        appliesTo: "purchases_and_refunds", categoryId: uuid(9, "30000000"), enabled: true },
    });

    const row = await rowNumbered(1);
    const byRules = UpdateImportRowResponse.parse((await saved(row.id, { category: { mode: "rules" } })).body);
    expect(byRules.row.assignment).toMatchObject({ categoryId: uuid(9, "30000000"), origin: "rule" });
    expect(byRules.row.assignment?.ruleId).toBe(uuid(8, "40000000"));

    const manual = UpdateImportRowResponse.parse((await saved(row.id, {
      category: { mode: "category", categoryId: uuid(9, "30000000") },
    })).body);
    expect(manual.row.assignment).toMatchObject({ categoryId: uuid(9, "30000000"), origin: "manual" });

    // A later correction must not quietly take the owner's choice away again.
    const corrected = UpdateImportRowResponse.parse(
      (await saved(row.id, { merchant: "SYNTHETIC CORNER STORE" })).body);
    expect(corrected.row.assignment).toMatchObject({ origin: "manual" });
  });

  it("refuses an unknown category", async () => {
    const row = await rowNumbered(1);
    const response = await save(row.id, { category: { mode: "category", categoryId: uuid(77, "30000000") } });
    expect(response.status).toBe(422);
  });
});

describe("leaving a row out", () => {
  it("excludes and re-includes a row", async () => {
    const row = await rowNumbered(1);
    const excluded = UpdateImportRowResponse.parse((await saved(row.id, { excluded: true })).body);
    expect(excluded.row).toMatchObject({ excluded: true, state: "excluded" });
    expect(excluded.import.rowCounts).toMatchObject({ excluded: 1 });
    const included = UpdateImportRowResponse.parse((await saved(row.id, { excluded: false })).body);
    expect(included.row).toMatchObject({ excluded: false, state: "ready" });
  });

  it("refuses a duplicate decision for a row with no duplicate", async () => {
    const row = await rowNumbered(1);
    const response = await save(row.id, { duplicateDecision: "exclude" });
    expect(response.status).toBe(422);
  });

  it("refuses a transfer decision for a row with no suggested match", async () => {
    const row = await rowNumbered(1);
    expect((await save(row.id, { transferDecision: "confirm" })).status).toBe(422);
  });
});

describe("a stale tab", () => {
  it("refuses a save carrying an older batch version", async () => {
    const first = await rowNumbered(1);
    const stale = batchVersion;
    await saved(first.id, { excluded: true });
    const response = await save((await rowNumbered(2)).id, { postedDate: "2026-05-02" }, stale);
    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({ code: "version_mismatch", currentVersion: batchVersion });
    // And the second row is untouched.
    expect((await rowNumbered(2)).normalized.postedDate).toBeNull();
  });

  it("requires a version and rejects a malformed one", async () => {
    const row = await rowNumbered(1);
    const missing = await api.request(`/api/imports/${importId}/rows/${row.id}`,
      { method: "PATCH", body: { excluded: true } });
    expect(missing.status).toBe(428);
    const malformed = await api.request(`/api/imports/${importId}/rows/${row.id}`,
      { method: "PATCH", body: { excluded: true }, headers: { "if-match": "not-a-version" } });
    expect(malformed.status).toBe(400);
  });

  it("refuses an unknown row and a row from another import", async () => {
    const other = await upload("Date,Description,Amount,Type\r\n05/07/2026,SYNTHETIC OTHER,-1.00,DEBIT\r\n");
    const otherRow = ListImportRowsResponse.parse(
      (await api.request(`/api/imports/${other.id}/rows`)).body).items[0]!;
    expect((await save(otherRow.id, { excluded: true })).status).toBe(404);
    expect((await save(uuid(99), { excluded: true })).status).toBe(404);
  });

  it("refuses a save without a session or a CSRF token", async () => {
    const row = await rowNumbered(1);
    const anonymous = await api.request(`/api/imports/${importId}/rows/${row.id}`, {
      method: "PATCH", body: { excluded: true }, headers: { "if-match": `"${batchVersion}"` }, omitCookie: true,
    });
    expect(anonymous.status).toBe(401);
    const forged = await api.request(`/api/imports/${importId}/rows/${row.id}`, {
      method: "PATCH", body: { excluded: true }, headers: { "if-match": `"${batchVersion}"` }, csrfToken: null,
    });
    expect(forged.status).toBe(403);
  });
});

describe("review activity and the deadline", () => {
  it("extends the deadline on a successful save and not on a read", async () => {
    const before = (await api.request(`/api/imports/${importId}`)).body as { expiresAt: string };
    api.clock.advance(60 * 60 * 1000);
    await api.login();
    // Reading changes nothing.
    await rows();
    const afterRead = (await api.request(`/api/imports/${importId}`)).body as { expiresAt: string };
    expect(afterRead.expiresAt).toBe(before.expiresAt);

    const result = UpdateImportRowResponse.parse((await saved((await rowNumbered(1)).id, { excluded: true })).body);
    expect(new Date(result.import.expiresAt!).getTime())
      .toBe(api.clock.now() + IMPORT_REVIEW_MS);
    expect(new Date(result.import.lastReviewedAt).getTime()).toBe(api.clock.now());
  });

  it("does not extend the deadline on a refused save", async () => {
    const before = (await api.request(`/api/imports/${importId}`)).body as { expiresAt: string };
    api.clock.advance(60 * 60 * 1000);
    await api.login();
    expect((await save((await rowNumbered(3)).id, { kind: "purchase" })).status).toBe(422);
    const after = (await api.request(`/api/imports/${importId}`)).body as { expiresAt: string };
    expect(after.expiresAt).toBe(before.expiresAt);
  });

  it("does not extend the deadline on a refresh, however often a page polls", async () => {
    const before = (await api.request(`/api/imports/${importId}`)).body as { expiresAt: string };
    for (let poll = 0; poll < 3; poll += 1) {
      api.clock.advance(60 * 60 * 1000);
      await api.login();
      const response = await api.request(`/api/imports/${importId}/refresh`, {
        method: "POST", headers: { "if-match": `"${batchVersion}"` },
      });
      expect(response.status).toBe(200);
      const body = response.body as { import: { version: string; expiresAt: string } };
      batchVersion = body.import.version;
      // The deadline the owner was given stands: a polling page cannot keep an
      // abandoned preview alive by asking for fresh suggestions.
      expect(body.import.expiresAt).toBe(before.expiresAt);
      expect((api.db.prepare("SELECT expires_at FROM import_batches WHERE id = ?")
        .get(importId) as { expires_at: bigint }).expires_at)
        .toBe(BigInt(new Date(before.expiresAt).getTime()));
    }
  });

  it("refuses to save once the deadline has passed", async () => {
    const row = await rowNumbered(1);
    api.clock.advance(IMPORT_REVIEW_MS);
    await api.login();
    const response = await save(row.id, { excluded: true });
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "preview_expired" });
  });
});

describe("applying one type to matching rows", () => {
  const REPEATED = "Date,Description,Amount,Type\r\n"
    + "05/01/2026,SYNTHETIC REFUND SOURCE,40.00,CREDIT\r\n"
    + "05/02/2026,synthetic  refund source,25.00,CREDIT\r\n"
    + "05/03/2026,SYNTHETIC REFUND SOURCE,-10.00,DEBIT\r\n"
    + "05/04/2026,SYNTHETIC ELSEWHERE,15.00,CREDIT\r\n";

  beforeEach(async () => {
    const created = await upload(REPEATED);
    importId = created.id;
    batchVersion = created.version;
  });

  it("updates every matching row and reports the ones it skipped", async () => {
    const all = await rows();
    const first = all.find(row => row.rowNumber === 1)!;
    const response = await bulk({ rowId: first.id, kind: "refund" });
    expect(response.status).toBe(200);
    const result = BulkSetImportRowTypeResponse.parse(response.body);
    // Rows 1 and 2 share a normalized description; row 3's sign cannot be a
    // refund, and row 4 is a different description entirely.
    expect(result.updatedRowIds).toEqual([first.id, all.find(row => row.rowNumber === 2)!.id]);
    expect(result.skippedRowIds).toEqual([all.find(row => row.rowNumber === 3)!.id]);
    expect(response.headers.get("etag")).toBe(`"${result.import.version}"`);

    const after = await rows();
    expect(after.filter(row => row.kind === "refund").map(row => row.rowNumber)).toEqual([1, 2]);
    expect(after.find(row => row.rowNumber === 2)!.kindSource).toBe("owner");
    expect(after.find(row => row.rowNumber === 4)!.kind).toBeNull();
  });

  it("skips a row that was already left out", async () => {
    const all = await rows();
    const second = all.find(row => row.rowNumber === 2)!;
    await saved(second.id, { excluded: true });
    const result = BulkSetImportRowTypeResponse.parse(
      (await bulk({ rowId: all.find(row => row.rowNumber === 1)!.id, kind: "refund" })).body);
    expect(result.skippedRowIds).toContain(second.id);
    expect(result.updatedRowIds).not.toContain(second.id);
  });

  it("refuses a stale version, an unknown row and a missing precondition", async () => {
    const all = await rows();
    const first = all.find(row => row.rowNumber === 1)!;
    expect((await bulk({ rowId: first.id, kind: "refund" }, "1")).status).toBe(412);
    expect((await bulk({ rowId: uuid(98), kind: "refund" })).status).toBe(404);
    const missing = await api.request(`/api/imports/${importId}/rows/bulk-type`,
      { method: "POST", body: { rowId: first.id, kind: "refund" } });
    expect(missing.status).toBe(428);
  });

  it("is review activity and extends the deadline", async () => {
    const all = await rows();
    api.clock.advance(60 * 60 * 1000);
    await api.login();
    const result = BulkSetImportRowTypeResponse.parse(
      (await bulk({ rowId: all.find(row => row.rowNumber === 1)!.id, kind: "refund" })).body);
    expect(new Date(result.import.expiresAt!).getTime()).toBe(api.clock.now() + IMPORT_REVIEW_MS);
  });
});

describe("a preview that is no longer open", () => {
  it("refuses saves once the import has been cancelled", async () => {
    const row = await rowNumbered(1);
    api.db.prepare("UPDATE import_batches SET status = 'cancelled', expires_at = NULL WHERE id = ?").run(importId);
    const response = await save(row.id, { excluded: true });
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "import_contents_deleted" });
  });

  it("refuses saves on a row that already posted", async () => {
    const row = await rowNumbered(1);
    api.db.prepare("UPDATE import_rows SET posted_transaction_id = ? WHERE id = ?")
      .run(seedTransaction(), row.id);
    const response = await save(row.id, { excluded: true });
    expect(response.status).toBe(422);
  });
});

/** A synthetic ledger row, posted through the real service, only so a preview row can point at one. */
function seedTransaction(): string {
  return postThroughService(api, {
    accountId: uuid(1), postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET",
    money: { amountMinor: "-4599", currency: "USD" }, kind: "purchase", category: { mode: "rules" },
  }).id;
}
