/**
 * Duplicate detection, transfer suggestions and refresh, end to end.
 *
 * The rules being tested are the safety ones. Nothing collapses on its own: a
 * matching date, amount and description is evidence the owner decides about.
 * Only the bank's own identifier for a record already imported is treated as
 * settled, and even then the row can only be left out. Every match is found
 * even though at most twenty are shown, and consent to include a row lapses
 * when the evidence behind it changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ListImportRowsResponse, RefreshImportResponse, UpdateImportRowResponse } from "@workspace/api-zod";
import { startTestServer, type TestResponse, type TestServer } from "./harness.js";
import { createAccount, postThroughService, uuid } from "./finance-harness.js";
import { IMPORT_REVIEW_MS } from "../src/services/imports.js";

const BOUNDARY = "MoneyDeskSuggestionTest";
const CHECKING = "synthetic-canonical-checking";
const IDENTIFIED = "synthetic-identified-checking";

let api: TestServer;

async function upload(csv: string, formatId = CHECKING, accountId = uuid(1)):
Promise<{ id: string; version: string }> {
  const fields = [["accountId", accountId], ["formatId", formatId]];
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

const rowsOf = async (importId: string) =>
  ListImportRowsResponse.parse((await api.request(`/api/imports/${importId}/rows`)).body).items;

const save = (importId: string, rowId: string, patch: unknown, version: string): Promise<TestResponse> =>
  api.request(`/api/imports/${importId}/rows/${rowId}`,
    { method: "PATCH", body: patch, headers: { "if-match": `"${version}"` } });

const refresh = (importId: string, version: string): Promise<TestResponse> =>
  api.request(`/api/imports/${importId}/refresh`, { method: "POST", headers: { "if-match": `"${version}"` } });

const detail = async (importId: string) =>
  (await api.request(`/api/imports/${importId}`)).body as
    { version: string; expiresAt: string | null; staleReasons: string[]; rowCounts: Record<string, number> };

function post(input: { accountId?: string; postedDate: string; merchant: string; amountMinor: string;
  kind?: "purchase" | "refund" | "income" | "transfer" }): string {
  return postThroughService(api, {
    accountId: input.accountId ?? uuid(1), postedDate: input.postedDate, merchant: input.merchant,
    money: { amountMinor: input.amountMinor, currency: "USD" }, kind: input.kind ?? "purchase",
    ...(input.kind === "income" || input.kind === "transfer" ? {} : { category: { mode: "rules" as const } }),
  }).id;
}

function voidTransaction(id: string): void {
  api.db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ?, version = version + 1 WHERE id = ?")
    .run(api.clock.now(), id);
}

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { id: uuid(1), trackingStartDate: "2026-01-01" });
});
afterEach(async () => { await api.close(); });

const ONE_ROW = "Date,Description,Amount,Type\r\n05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n";

describe("matching a row against the ledger", () => {
  it("holds a row whose date, amount and description already exist, without dropping it", async () => {
    const existing = post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    expect(row!.state).toBe("held");
    expect(row!.duplicate).toEqual({
      status: "suspected", decision: null,
      matches: [{ transactionId: existing, rowId: null, lifecycle: "active",
        reason: "same_date_amount_description" }],
    });
    expect(row!.issues.map(issue => issue.code)).toContain("suspected_duplicate");
    // The row is still there, with its own values intact.
    expect(row!.normalized.money).toEqual({ amountMinor: "-4599", currency: "USD" });
  });

  it("lets the owner include a suspected duplicate, or leave it out", async () => {
    post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    const included = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { duplicateDecision: "include" }, created.version)).body);
    expect(included.row).toMatchObject({ state: "ready", duplicate: { decision: "include" } });
    expect(included.row.issues).toEqual([]);

    const excluded = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { duplicateDecision: "exclude" }, included.import.version)).body);
    expect(excluded.row).toMatchObject({ state: "excluded", duplicate: { decision: "exclude" } });
  });

  it("reports a match against a voided record as its own reason", async () => {
    const existing = post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    voidTransaction(existing);
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    expect(row!.duplicate.status).toBe("suspected");
    expect(row!.duplicate.matches[0]).toMatchObject({ reason: "matches_voided", lifecycle: "void" });
  });

  it("holds two identical rows in one file against each other", async () => {
    const created = await upload("Date,Description,Amount,Type\r\n"
      + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n"
      + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n"
      + "05/02/2026,SYNTHETIC OTHER,-1.00,DEBIT\r\n");
    const rows = await rowsOf(created.id);
    expect(rows.map(row => row.duplicate.status)).toEqual(["suspected", "suspected", "none"]);
    expect(rows[0]!.duplicate.matches).toEqual([
      { transactionId: null, rowId: rows[1]!.id, lifecycle: null, reason: "within_file" },
    ]);
    expect(rows[1]!.duplicate.matches[0]!.rowId).toBe(rows[0]!.id);
    // Neither was collapsed into the other.
    expect(rows).toHaveLength(3);
  });

  it("leaves an unrelated row alone", async () => {
    post({ postedDate: "2026-05-01", merchant: "SYNTHETIC ELSEWHERE", amountMinor: "-4599" });
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    expect(row!.duplicate).toEqual({ status: "none", matches: [], decision: null });
    expect(row!.state).toBe("ready");
  });

  it("does not match a posting in another account", async () => {
    await createAccount(api, { id: uuid(2), trackingStartDate: "2026-01-01", displayName: "Synthetic Second" });
    post({ accountId: uuid(2), postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    const created = await upload(ONE_ROW);
    expect((await rowsOf(created.id))[0]!.duplicate.status).toBe("none");
  });
});

describe("the bank's own identifier", () => {
  const IDENTIFIED_ROW = "Reference,Date,Description,Amount\r\nREF-001,2026-05-01,SYNTHETIC MARKET,-45.99\r\n";

  /** A record this account imported earlier, as commit will record it. */
  function seedIdentity(reference: string): string {
    const id = post({ postedDate: "2026-04-01", merchant: "SYNTHETIC EARLIER", amountMinor: "-101" });
    api.db.prepare(
      `INSERT INTO source_identities (account_id, provider_namespace, bank_transaction_id, transaction_id, created_at)
       VALUES (?, 'synthetic_identified', ?, ?, ?)`,
    ).run(uuid(1), reference, id, api.clock.now());
    return id;
  }

  it("treats a record the bank says is already imported as confirmed", async () => {
    const existing = seedIdentity("REF-001");
    const created = await upload(IDENTIFIED_ROW, IDENTIFIED);
    const [row] = await rowsOf(created.id);
    expect(row!.duplicate.status).toBe("confirmed");
    expect(row!.duplicate.matches).toEqual([
      { transactionId: existing, rowId: null, lifecycle: "active", reason: "bank_id" },
    ]);
    expect(row!.state).toBe("held");
    expect(row!.issues.map(issue => issue.code)).toContain("confirmed_duplicate");
  });

  it("will not let a confirmed duplicate be included, only left out", async () => {
    seedIdentity("REF-001");
    const created = await upload(IDENTIFIED_ROW, IDENTIFIED);
    const [row] = await rowsOf(created.id);
    const refused = await save(created.id, row!.id, { duplicateDecision: "include" }, created.version);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "duplicate_source_identity" });
    const excluded = await save(created.id, row!.id, { duplicateDecision: "exclude" }, created.version);
    expect(excluded.status).toBe(200);
    expect((excluded.body as { row: { state: string } }).row.state).toBe("excluded");
  });

  it("still confirms when the earlier record was voided", async () => {
    const existing = seedIdentity("REF-001");
    voidTransaction(existing);
    const created = await upload(IDENTIFIED_ROW, IDENTIFIED);
    expect((await rowsOf(created.id))[0]!.duplicate.status).toBe("confirmed");
  });

  it("falls back to ordinary checks when the file carries no identifier", async () => {
    seedIdentity("REF-001");
    const created = await upload("Reference,Date,Description,Amount\r\n,2026-05-01,SYNTHETIC MARKET,-45.99\r\n",
      IDENTIFIED);
    expect((await rowsOf(created.id))[0]!.duplicate.status).toBe("none");
  });
});

describe("a correction that reveals a candidate", () => {
  it("holds the corrected row for the duplicate its own edit revealed", async () => {
    post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    // The row's date is unreadable, so nothing matches it yet.
    const created = await upload("Date,Description,Amount,Type\r\nbad-date,SYNTHETIC MARKET,-45.99,DEBIT\r\n");
    const [row] = await rowsOf(created.id);
    expect(row!.duplicate.status).toBe("none");

    const result = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { postedDate: "2026-05-01" }, created.version)).body);
    // Correcting the date makes it a duplicate, which the same save cannot
    // have approved: it is held for its own decision.
    expect(result.row.duplicate.status).toBe("suspected");
    expect(result.row.duplicate.decision).toBeNull();
    expect(result.row.state).toBe("held");
    expect(result.row.issues.map(issue => issue.code)).toEqual(["suspected_duplicate"]);
    // And it is not reported as a changed suggestion needing acknowledgement.
    expect(result.row.reviewRequired).toBe(false);
  });

  it("drops consent when a correction changes the evidence it was given for", async () => {
    post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    post({ postedDate: "2026-05-02", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    const included = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { duplicateDecision: "include" }, created.version)).body);
    expect(included.row.state).toBe("ready");

    // Moving the date to the other posting is different evidence entirely.
    const moved = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { postedDate: "2026-05-02" }, included.import.version)).body);
    expect(moved.row.duplicate.decision).toBeNull();
    expect(moved.row.state).toBe("held");
  });

  it("reveals a transfer match created by a correction", async () => {
    await createAccount(api, { id: uuid(2), trackingStartDate: "2026-01-01", kind: "savings",
      displayName: "Synthetic Savings" });
    post({ accountId: uuid(2), postedDate: "2026-05-01", merchant: "SYNTHETIC MOVE",
      amountMinor: "4599", kind: "transfer" });
    const created = await upload("Date,Description,Amount,Type\r\n05/01/2026,SYNTHETIC MARKET,-1.00,DEBIT\r\n");
    const [row] = await rowsOf(created.id);
    expect(row!.transferCandidate).toBeNull();
    const result = UpdateImportRowResponse.parse((await save(created.id, row!.id,
      { money: { amountMinor: "-4599", currency: "USD" } }, created.version)).body);
    expect(result.row.transferCandidate).toMatchObject({ eligible: true, decision: null });
    expect(result.row.state).toBe("held");
    expect(result.row.issues.map(issue => issue.code)).toContain("possible_transfer");
  });
});

describe("showing at most twenty matches", () => {
  it("finds every match while displaying twenty", async () => {
    for (let index = 0; index < 25; index += 1) {
      post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    }
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    expect(row!.duplicate.matches).toHaveLength(20);
    expect(row!.duplicate.status).toBe("suspected");
    const stored = api.db.prepare("SELECT duplicate_match_count FROM import_rows WHERE id = ?")
      .get(row!.id) as { duplicate_match_count: bigint };
    // Detection is not limited to what is shown.
    expect(Number(stored.duplicate_match_count)).toBe(25);
  });

  it("invalidates consent when evidence beyond the displayed twenty changes", async () => {
    for (let index = 0; index < 25; index += 1) {
      post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    }
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    const included = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { duplicateDecision: "include" }, created.version)).body);
    expect(included.row.state).toBe("ready");

    // A further match the owner never saw still changes what they consented to.
    post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "-4599" });
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, included.import.version)).body);
    const after = (await rowsOf(created.id))[0]!;
    expect(after.duplicate.decision).toBeNull();
    expect(after.reviewRequired).toBe(true);
    expect(after.state).toBe("held");
    expect(after.issues.map(issue => issue.code)).toContain("suggestion_changed");
    expect(refreshed.import.staleReasons).toEqual([]);
  });
});

/**
 * Rows that share a date, amount and description are each other's evidence.
 * That used to be collected pair by pair, which is quadratic: an ordinary file
 * of identical small charges took 43 seconds and 2 GiB at two thousand
 * repeats, and exhausted the heap at four thousand. It is collected per group
 * now, so these tests fix the answers - which a faster implementation could
 * still get wrong - and the last one fixes the bound: restoring pairwise
 * collection makes it exceed the thirty-second timeout, measured, while the
 * grouped version runs it in about a second.
 */
describe("rows that repeat within one file", () => {
  const repeated = (count: number) => "Date,Description,Amount,Type\r\n"
    + "05/01/2026,SYNTHETIC REPEAT,-12.00,DEBIT\r\n".repeat(count);

  const storedEvidence = (importId: string) =>
    api.db.prepare(`SELECT id, duplicate_match_count AS count, duplicate_evidence_digest AS digest
      FROM import_rows WHERE import_id = ? ORDER BY source_row_number`)
      .all(importId) as { id: string; count: bigint; digest: string | null }[];

  it("counts every sibling while displaying twenty, and never counts itself", async () => {
    const created = await upload(repeated(25));
    const rows = await rowsOf(created.id);
    const ids = [...rows.map(row => row.id)].sort();

    for (const row of rows) {
      expect(row.state).toBe("held");
      expect(row.duplicate.status).toBe("suspected");
      expect(row.duplicate.matches).toHaveLength(20);
      // The twenty shown are the lowest sibling ids, in order, and a row is
      // never its own evidence.
      expect(row.duplicate.matches).toEqual(ids.filter(id => id !== row.id).slice(0, 20)
        .map(id => ({ transactionId: null, rowId: id, lifecycle: null, reason: "within_file" })));
    }
    for (const row of storedEvidence(created.id)) expect(Number(row.count)).toBe(24);
  });

  it("counts a ledger match and a sibling separately", async () => {
    const existing = post({ postedDate: "2026-05-01", merchant: "SYNTHETIC REPEAT", amountMinor: "-1200" });
    const created = await upload(repeated(3));
    const rows = await rowsOf(created.id);

    for (const row of rows) {
      expect(row.duplicate.matches.filter(match => match.reason === "same_date_amount_description"))
        .toEqual([{ transactionId: existing, rowId: null, lifecycle: "active",
          reason: "same_date_amount_description" }]);
      expect(row.duplicate.matches.filter(match => match.reason === "within_file")).toHaveLength(2);
    }
    for (const row of storedEvidence(created.id)) expect(Number(row.count)).toBe(3);
  });

  it("gives each row in a group its own fingerprint", async () => {
    const created = await upload(repeated(4));
    const digests = storedEvidence(created.id).map(row => row.digest);
    expect(digests.every(digest => digest !== null)).toBe(true);
    expect(new Set(digests).size).toBe(4);
  });

  /**
   * Consent is to the whole evidence. A sibling leaving the group is a change
   * to every other row's evidence, even though none of them was touched.
   */
  it("withdraws consent from the whole group when one sibling leaves it", async () => {
    const created = await upload(repeated(3));
    const rows = await rowsOf(created.id);
    const [first, , third] = rows;
    const included = UpdateImportRowResponse.parse(
      (await save(created.id, first!.id, { duplicateDecision: "include" }, created.version)).body);
    expect(included.row.state).toBe("ready");
    const before = storedEvidence(created.id).map(row => row.digest);

    const moved = UpdateImportRowResponse.parse((await save(created.id, third!.id,
      { merchant: "SYNTHETIC SOMETHING ELSE" }, included.import.version)).body);
    expect(moved.row.duplicate.status).toBe("none");
    await refresh(created.id, moved.import.version);

    const after = (await rowsOf(created.id)).find(row => row.id === first!.id)!;
    expect(after.duplicate.decision).toBeNull();
    expect(after.reviewRequired).toBe(true);
    expect(after.state).toBe("held");
    expect(after.duplicate.matches).toHaveLength(1);
    expect(storedEvidence(created.id).map(row => row.digest)).not.toEqual(before);
  });

  it("handles a group far larger than anything pairwise collection could", async () => {
    const created = await upload(repeated(4000));
    expect((await detail(created.id)).rowCounts).toMatchObject({ total: 4000, held: 4000 });
    const stored = storedEvidence(created.id);
    expect(stored).toHaveLength(4000);
    for (const row of stored) {
      expect(Number(row.count)).toBe(3999);
      expect(row.digest).not.toBeNull();
    }
    // Every row in one group shares its evidence, so the fingerprints differ
    // only by the row they belong to - and they must still all differ.
    expect(new Set(stored.map(row => row.digest)).size).toBe(4000);
  });
});


describe("suggesting a transfer", () => {
  beforeEach(async () => {
    await createAccount(api, { id: uuid(2), trackingStartDate: "2026-01-01", displayName: "Synthetic Savings",
      kind: "savings" });
  });

  it("suggests the nearest opposite posting in another account and holds the row", async () => {
    const near = post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC MOVE",
      amountMinor: "4599", kind: "income" });
    post({ accountId: uuid(2), postedDate: "2026-05-06", merchant: "SYNTHETIC MOVE LATER",
      amountMinor: "4599", kind: "income" });
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    expect(row!.state).toBe("held");
    expect(row!.issues.map(issue => issue.code)).toContain("possible_transfer");
    expect(row!.transferCandidate).toMatchObject({
      transactionId: near, accountId: uuid(2), counterpartKind: "income", requiresKindChange: true,
      eligible: true, ineligibleReason: null, postedDate: "2026-05-02", daysApart: 1, decision: null,
    });
    expect(row!.transferCandidate?.money).toEqual({ amountMinor: "4599", currency: "USD" });
  });

  it("confirming makes the row a transfer, rejecting leaves its type alone", async () => {
    post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC MOVE",
      amountMinor: "4599", kind: "income" });
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    const confirmed = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { transferDecision: "confirm" }, created.version)).body);
    expect(confirmed.row).toMatchObject({ kind: "transfer", kindSource: "transfer_candidate", state: "ready" });
    expect(confirmed.row.transferCandidate?.decision).toBe("confirm");
    // A transfer has no category of its own.
    expect(confirmed.row.assignment).toBeNull();

    const rejected = UpdateImportRowResponse.parse(
      (await save(created.id, row!.id, { transferDecision: "reject" }, confirmed.import.version)).body);
    expect(rejected.row.transferCandidate?.decision).toBe("reject");
    expect(rejected.row.state).toBe("ready");
  });

  it("will not confirm a match that is already paired", async () => {
    const first = post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC MOVE",
      amountMinor: "4599", kind: "transfer" });
    const second = post({ postedDate: "2026-05-02", merchant: "SYNTHETIC MOVE BACK",
      amountMinor: "-4599", kind: "transfer" });
    const paired = await api.request("/api/transfer-pairs", {
      method: "POST",
      body: { id: uuid(40), confirmKindChanges: false,
        legs: [{ transactionId: first, version: "1" }, { transactionId: second, version: "1" }] },
    });
    expect(paired.status).toBe(201);
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    expect(row!.transferCandidate).toMatchObject({ eligible: false, ineligibleReason: "already_paired" });
    const refused = await save(created.id, row!.id, { transferDecision: "confirm" }, created.version);
    expect(refused.status).toBe(422);
    // Rejecting an unusable suggestion is still allowed, and settles the row.
    const rejected = await save(created.id, row!.id, { transferDecision: "reject" }, created.version);
    expect(rejected.status).toBe(200);
  });

  it("will not confirm a match that would need a type change on an archived account", async () => {
    post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC MOVE",
      amountMinor: "4599", kind: "income" });
    const account = (await api.request(`/api/accounts/${uuid(2)}`));
    const archived = await api.request(`/api/accounts/${uuid(2)}/archive`, {
      method: "POST", headers: { "if-match": account.headers.get("etag")! },
    });
    expect(archived.status).toBe(200);
    const created = await upload(ONE_ROW);
    const [row] = await rowsOf(created.id);
    expect(row!.transferCandidate)
      .toMatchObject({ eligible: false, ineligibleReason: "reactivation_required" });
    expect((await save(created.id, row!.id, { transferDecision: "confirm" }, created.version)).status).toBe(422);
  });

  it.each(["purchase", "refund"] as const)("refuses a linked %s as a transfer counterpart", async kind => {
    const purchaseId = post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC PURCHASE",
      amountMinor: "-4599", kind: "purchase" });
    const refundId = post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC REFUND",
      amountMinor: "4599", kind: "refund" });
    expect((await api.request("/api/refund-links", { method: "POST",
      body: { id: uuid(41), refundId, purchaseId } })).status).toBe(201);
    const created = await upload(kind === "refund" ? ONE_ROW
      : "Date,Description,Amount,Type\r\n05/01/2026,SYNTHETIC MOVE,45.99,CREDIT\r\n");
    const row = (await rowsOf(created.id))[0]!;
    expect(row.transferCandidate).toMatchObject({ eligible: false, ineligibleReason: "refund_links_present",
      transactionId: kind === "purchase" ? purchaseId : refundId });
    const refused = await save(created.id, row.id, { transferDecision: "confirm" }, created.version);
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "validation_failed" });
    const rejected = UpdateImportRowResponse.parse((await save(created.id, row.id,
      { transferDecision: "reject", kind: kind === "refund" ? "purchase" : "refund" }, created.version)).body);
    expect(rejected.row.state).toBe("ready");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM refund_links").get()).toEqual({ n: 1n });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transfer_pairs").get()).toEqual({ n: 0n });
  });

  it("invalidates confirmation on refresh when the counterpart gains a refund link", async () => {
    const purchaseId = post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC PURCHASE",
      amountMinor: "-4599" });
    const refundId = post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC REFUND",
      amountMinor: "4599", kind: "refund" });
    const created = await upload(ONE_ROW);
    const row = (await rowsOf(created.id))[0]!;
    const confirmed = UpdateImportRowResponse.parse((await save(created.id, row.id,
      { transferDecision: "confirm" }, created.version)).body);
    expect((await api.request("/api/refund-links", { method: "POST",
      body: { id: uuid(41), refundId, purchaseId } })).status).toBe(201);
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, confirmed.import.version)).body);
    const after = (await rowsOf(created.id))[0]!;
    expect(after).toMatchObject({ state: "held", reviewRequired: true,
      transferCandidate: { eligible: false, ineligibleReason: "refund_links_present", decision: null } });
    expect((await save(created.id, row.id, { transferDecision: "confirm" }, refreshed.import.version)).status).toBe(422);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM refund_links").get()).toEqual({ n: 1n });
  });

  it("ignores a counterpart more than a week away or in the same account", async () => {
    post({ accountId: uuid(2), postedDate: "2026-05-09", merchant: "SYNTHETIC TOO LATE",
      amountMinor: "4599", kind: "income" });
    post({ postedDate: "2026-05-02", merchant: "SYNTHETIC SAME ACCOUNT", amountMinor: "4599", kind: "income" });
    const created = await upload(ONE_ROW);
    expect((await rowsOf(created.id))[0]!.transferCandidate).toBeNull();
  });
});

describe("refreshing a preview", () => {
  it.each(["refresh", "save"])("keeps duplicate exclusion when evidence disappears during %s", async mode => {
    const created = await upload(ONE_ROW + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n");
    const [first, second] = await rowsOf(created.id);
    const excluded = UpdateImportRowResponse.parse((await save(created.id, first!.id,
      { duplicateDecision: "exclude" }, created.version)).body);
    let version = excluded.import.version;
    if (mode === "refresh") {
      version = UpdateImportRowResponse.parse((await save(created.id, second!.id,
        { merchant: "SYNTHETIC OTHER" }, version)).body).import.version;
      version = RefreshImportResponse.parse((await refresh(created.id, version)).body).import.version;
    } else {
      version = UpdateImportRowResponse.parse((await save(created.id, first!.id,
        { merchant: "SYNTHETIC OTHER" }, version)).body).import.version;
    }
    const acknowledged = UpdateImportRowResponse.parse((await save(created.id, first!.id,
      { kind: "purchase" }, version)).body);
    expect(acknowledged.row.state).toBe("excluded");
    expect(acknowledged.row.excluded).toBe(true);
    const included = UpdateImportRowResponse.parse((await save(created.id, first!.id,
      { excluded: false }, acknowledged.import.version)).body);
    expect(included.row.state).toBe("ready");
  });

  /**
   * Putting a row back in has to mean what it says. The exclusion decision that
   * took the row out survives an ordinary save, so if its evidence had changed
   * in the meantime the rediscover pass used to promote the lapsing decision
   * straight back into an exclusion - answering 200 to an instruction it had
   * just reversed, and needing the owner to say it twice.
   */
  it("honours putting a row back in even while its duplicate evidence is lapsing", async () => {
    const created = await upload(ONE_ROW + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n");
    const [first, second] = await rowsOf(created.id);
    const excluded = UpdateImportRowResponse.parse((await save(created.id, second!.id,
      { duplicateDecision: "exclude" }, created.version)).body);
    expect(excluded.row.state).toBe("excluded");
    // The twin is edited, so the excluded row's duplicate evidence is stale.
    const edited = UpdateImportRowResponse.parse((await save(created.id, first!.id,
      { merchant: "SYNTHETIC OTHER" }, excluded.import.version)).body);

    const included = UpdateImportRowResponse.parse((await save(created.id, second!.id,
      { excluded: false }, edited.import.version)).body);
    expect(included.row.excluded).toBe(false);
    expect(included.row.state).not.toBe("excluded");
    expect(api.db.prepare("SELECT excluded, duplicate_decision FROM import_rows WHERE id = ?")
      .get(second!.id)).toMatchObject({ excluded: 0n, duplicate_decision: null });
  });

  it.each(["purchase", "refund"] as const)("does not acknowledge an undiscovered category change through bulk %s", async kind => {
    const created = await upload(kind === "purchase" ? ONE_ROW : ONE_ROW.replace("-45.99,DEBIT", "45.99,CREDIT"));
    const [row] = await rowsOf(created.id);
    let inputVersion = created.version;
    if (kind === "refund") {
      inputVersion = UpdateImportRowResponse.parse((await save(created.id, row!.id,
        { kind }, inputVersion)).body).import.version;
    }
    expect((await api.request("/api/categories", { method: "POST",
      body: { id: uuid(9, "30000000"), name: "Synthetic Groceries", color: "#336699" } })).status).toBe(201);
    expect((await api.request("/api/rules", { method: "POST",
      body: { id: uuid(8, "40000000"), matchType: "contains", pattern: "SYNTHETIC MARKET",
        appliesTo: "purchases_and_refunds", categoryId: uuid(9, "30000000") } })).status).toBe(201);
    const bulk = await api.request(`/api/imports/${created.id}/rows/bulk-type`, {
      method: "POST", body: { rowId: row!.id, kind },
      headers: { "if-match": `"${inputVersion}"` },
    });
    expect(bulk.status).toBe(200);
    const version = (bulk.body as { import: { version: string } }).import.version;
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, version)).body);
    expect((await rowsOf(created.id))[0]).toMatchObject({ state: "held", reviewRequired: true,
      assignment: { origin: "rule", categoryId: uuid(9, "30000000") } });
    const commit = await api.request(`/api/imports/${created.id}/commit`, { method: "POST",
      headers: { "if-match": `"${refreshed.import.version}"` } });
    expect(commit.status).toBe(409);
    expect(commit.body).toMatchObject({ code: "held_rows_unresolved" });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });

  /**
   * The same hole, reached the other way round. Taking a row *out* of an
   * expense type and then back into it recomputes its category from the rules
   * as they are now, with nothing stored to compare against - and a bulk
   * action carries that to every matching row, including ones the owner has
   * never opened. The adopted category has to be flagged, or two bulk actions
   * commit a rule change nobody acknowledged.
   */
  it("does not acknowledge a category change by leaving and re-entering an expense type", async () => {
    const created = await upload(ONE_ROW + "05/02/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n");
    const rows = await rowsOf(created.id);
    expect(rows).toHaveLength(2);
    expect((await api.request("/api/categories", { method: "POST",
      body: { id: uuid(9, "30000000"), name: "Synthetic Groceries", color: "#336699" } })).status).toBe(201);
    expect((await api.request("/api/rules", { method: "POST",
      body: { id: uuid(8, "40000000"), matchType: "contains", pattern: "SYNTHETIC MARKET",
        appliesTo: "purchases_and_refunds", categoryId: uuid(9, "30000000") } })).status).toBe(201);

    const bulk = async (kind: string, version: string) => {
      const response = await api.request(`/api/imports/${created.id}/rows/bulk-type`, {
        method: "POST", body: { rowId: rows[0]!.id, kind }, headers: { "if-match": `"${version}"` } });
      expect(response.status).toBe(200);
      return (response.body as { import: { version: string } }).import.version;
    };
    // Out of purchase, which drops the category, then straight back in.
    const version = await bulk("purchase", await bulk("transfer", created.version));

    // Refresh first, so the rule-set staleness the new rule caused is settled
    // and what is left is the question this test is about.
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, version)).body);

    // Both rows adopted the new category, so both are held for it - the second
    // one having never been opened by the owner at all.
    const after = await rowsOf(created.id);
    for (const row of after) {
      expect(row).toMatchObject({ state: "held", reviewRequired: true,
        assignment: { origin: "rule", categoryId: uuid(9, "30000000") } });
    }
    const commit = await api.request(`/api/imports/${created.id}/commit`,
      { method: "POST", headers: { "if-match": `"${refreshed.import.version}"` } });
    expect(commit.status).toBe(409);
    expect(commit.body).toMatchObject({ code: "held_rows_unresolved" });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });

  it("keeps corrections and exclusions while flagging a changed suggestion", async () => {
    const created = await upload("Date,Description,Amount,Type\r\n"
      + "bad-date,SYNTHETIC MARKET,-45.99,DEBIT\r\n"
      + "05/02/2026,SYNTHETIC KEEP OUT,-10.00,DEBIT\r\n");
    let rows = await rowsOf(created.id);
    const corrected = UpdateImportRowResponse.parse(
      (await save(created.id, rows[0]!.id, { postedDate: "2026-05-01" }, created.version)).body);
    const excluded = UpdateImportRowResponse.parse(
      (await save(created.id, rows[1]!.id, { excluded: true }, corrected.import.version)).body);

    // A new rule changes what the first row's category would be.
    await api.request("/api/categories", {
      method: "POST", body: { id: uuid(9, "30000000"), name: "Synthetic Groceries", color: "#336699" },
    });
    await api.request("/api/rules", {
      method: "POST",
      body: { id: uuid(8, "40000000"), matchType: "contains", pattern: "SYNTHETIC MARKET",
        appliesTo: "purchases_and_refunds", categoryId: uuid(9, "30000000") },
    });
    expect((await detail(created.id)).staleReasons).toContain("rules_changed");

    const response = await refresh(created.id, excluded.import.version);
    expect(response.status).toBe(200);
    const refreshed = RefreshImportResponse.parse(response.body);
    expect(refreshed.import.staleReasons).toEqual([]);
    rows = await rowsOf(created.id);
    // The correction survived, the exclusion survived, and the changed
    // suggestion is flagged rather than applied silently.
    expect(rows[0]!.normalized.postedDate).toBe("2026-05-01");
    expect(rows[0]!.assignment).toMatchObject({ categoryId: uuid(9, "30000000"), origin: "rule" });
    expect(rows[0]!.reviewRequired).toBe(true);
    expect(rows[0]!.state).toBe("held");
    expect(rows[1]!).toMatchObject({ excluded: true, state: "excluded" });
  });

  it("clears the flag when the owner saves the row again", async () => {
    const created = await upload(ONE_ROW);
    await api.request("/api/categories", {
      method: "POST", body: { id: uuid(9, "30000000"), name: "Synthetic Groceries", color: "#336699" },
    });
    await api.request("/api/rules", {
      method: "POST",
      body: { id: uuid(8, "40000000"), matchType: "contains", pattern: "SYNTHETIC MARKET",
        appliesTo: "purchases_and_refunds", categoryId: uuid(9, "30000000") },
    });
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, created.version)).body);
    const row = (await rowsOf(created.id))[0]!;
    expect(row.reviewRequired).toBe(true);
    const acknowledged = UpdateImportRowResponse.parse(
      (await save(created.id, row.id, { category: { mode: "rules" } }, refreshed.import.version)).body);
    expect(acknowledged.row.reviewRequired).toBe(false);
    expect(acknowledged.row.state).toBe("ready");
  });

  it("is not review activity and does not extend the deadline", async () => {
    const created = await upload(ONE_ROW);
    const before = await detail(created.id);
    api.clock.advance(60 * 60 * 1000);
    await api.login();
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, created.version)).body);
    expect(refreshed.import.expiresAt).toBe(before.expiresAt);
    expect(refreshed.import.lastReviewedAt).toBe((before as unknown as { lastReviewedAt: string }).lastReviewedAt);
  });

  it("refuses a stale version, a missing precondition and an expired preview", async () => {
    const created = await upload(ONE_ROW);
    expect((await refresh(created.id, "99")).status).toBe(412);
    expect((await api.request(`/api/imports/${created.id}/refresh`, { method: "POST" })).status).toBe(428);
    api.clock.advance(IMPORT_REVIEW_MS);
    await api.login();
    expect((await refresh(created.id, created.version)).status).toBe(410);
  });

  it("clears the archive marker only once the account is active again", async () => {
    const created = await upload(ONE_ROW);
    const account = await api.request(`/api/accounts/${uuid(1)}`);
    const archived = await api.request(`/api/accounts/${uuid(1)}/archive`, {
      method: "POST", headers: { "if-match": account.headers.get("etag")! },
    });
    expect(archived.status).toBe(200);
    // A refresh while the account is still archived cannot make it look current.
    const stillArchived = RefreshImportResponse.parse(
      (await refresh(created.id, (await detail(created.id)).version)).body);
    expect(stillArchived.import.staleReasons).toContain("account_archived");

    const current = await api.request(`/api/accounts/${uuid(1)}`);
    const reactivated = await api.request(`/api/accounts/${uuid(1)}/reactivate`, {
      method: "POST", headers: { "if-match": current.headers.get("etag")! },
    });
    expect(reactivated.status).toBe(200);
    // Reactivating alone does not clear it; the refresh after it does.
    expect((await detail(created.id)).staleReasons).toContain("account_archived");
    const afterRefresh = RefreshImportResponse.parse(
      (await refresh(created.id, (await detail(created.id)).version)).body);
    expect(afterRefresh.import.staleReasons).toEqual([]);
  });

  it("does not let a bulk type choice acknowledge a changed duplicate", async () => {
    const created = await upload("Date,Description,Amount,Type\r\n"
      + "05/01/2026,SYNTHETIC MARKET,25.00,CREDIT\r\n"
      + "05/02/2026,SYNTHETIC MARKET,30.00,CREDIT\r\n");
    // A posting appears that matches the first row, then it is refreshed.
    post({ postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", amountMinor: "2500", kind: "refund" });
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, created.version)).body);
    let rows = await rowsOf(created.id);
    expect(rows[0]!.reviewRequired).toBe(true);

    const bulk = await api.request(`/api/imports/${created.id}/rows/bulk-type`, {
      method: "POST", body: { rowId: rows[0]!.id, kind: "refund" },
      headers: { "if-match": `"${refreshed.import.version}"` },
    });
    expect(bulk.status).toBe(200);
    rows = await rowsOf(created.id);
    // The type was applied to both rows, but the changed duplicate on the
    // first one still needs its own decision.
    expect(rows.map(row => row.kind)).toEqual(["refund", "refund"]);
    expect(rows[0]!.reviewRequired).toBe(true);
    expect(rows[0]!.issues.map(issue => issue.code)).toContain("suggestion_changed");
    expect(rows[1]!.reviewRequired).toBe(false);
  });

  it("acknowledges only the row that was saved", async () => {
    const created = await upload("Date,Description,Amount,Type\r\n"
      + "05/01/2026,SYNTHETIC ONE,-25.00,DEBIT\r\n"
      + "05/02/2026,SYNTHETIC TWO,-30.00,DEBIT\r\n");
    await api.request("/api/categories", {
      method: "POST", body: { id: uuid(9, "30000000"), name: "Synthetic Groceries", color: "#336699" },
    });
    await api.request("/api/rules", {
      method: "POST",
      body: { id: uuid(8, "40000000"), matchType: "contains", pattern: "SYNTHETIC",
        appliesTo: "purchases_and_refunds", categoryId: uuid(9, "30000000") },
    });
    const refreshed = RefreshImportResponse.parse((await refresh(created.id, created.version)).body);
    let rows = await rowsOf(created.id);
    expect(rows.map(row => row.reviewRequired)).toEqual([true, true]);
    await save(created.id, rows[0]!.id, { category: { mode: "rules" } }, refreshed.import.version);
    rows = await rowsOf(created.id);
    expect(rows.map(row => row.reviewRequired)).toEqual([false, true]);
  });

  it("drops a transfer confirmation whose counterpart is no longer the same", async () => {
    await createAccount(api, { id: uuid(2), trackingStartDate: "2026-01-01", kind: "savings",
      displayName: "Synthetic Savings" });
    const counterpart = post({ accountId: uuid(2), postedDate: "2026-05-02", merchant: "SYNTHETIC MOVE",
      amountMinor: "4599", kind: "transfer" });
    const created = await upload(ONE_ROW);
    const row = (await rowsOf(created.id))[0]!;
    const confirmed = UpdateImportRowResponse.parse(
      (await save(created.id, row.id, { transferDecision: "confirm" }, created.version)).body);
    expect(confirmed.row.transferCandidate?.decision).toBe("confirm");

    voidTransaction(counterpart);
    RefreshImportResponse.parse((await refresh(created.id, confirmed.import.version)).body);
    const after = (await rowsOf(created.id))[0]!;
    expect(after.transferCandidate).toBeNull();
    expect(after.reviewRequired).toBe(true);
    expect(after.state).toBe("held");
  });
});
