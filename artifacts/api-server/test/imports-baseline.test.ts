/**
 * Posting held import rows while extending an account's coverage backward.
 *
 * These rows are held for exactly one reason - they are earlier than the
 * account's tracking start - and a single command both fixes that and adds
 * them. What is checked here is that the two halves are inseparable: the new
 * start and the postings arrive together or neither arrives, a selection this
 * command cannot use changes nothing at all, and the refusals speak the
 * baseline operation's own vocabulary rather than the import endpoints'.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeAccountBaselineResponse, ListImportRowsResponse } from "@workspace/api-zod";
import { IMPORT_REVIEW_MS } from "../src/services/imports.js";
import { declaredStatuses, validateAgainst } from "./contract-support.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postThroughService, uuid } from "./finance-harness.js";


let api: TestServer;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});
afterEach(async () => { await api.close(); });

/** March 3 and March 20 are before the April 1 start; April 5 is inside it. */
const MIXED = "Date,Description,Amount,Type\r\n"
  + "03/03/2026,SYNTHETIC EARLY MARKET,-15.00,DEBIT\r\n"
  + "03/20/2026,SYNTHETIC LATER MARCH,-25.00,DEBIT\r\n"
  + "04/05/2026,SYNTHETIC APRIL,-10.00,DEBIT\r\n";

async function upload(csv: string, format = "synthetic-canonical-checking", accountId = uuid(1)) {
  const boundary = "SyntheticBaselineBoundary";
  const fields = [["accountId", accountId], ["formatId", format]];
  const response = await api.request("/api/imports", { method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: fields.map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n` });
  expect(response.status).toBe(201);
  return (response.body as { import: { id: string; version: string } }).import;
}

const rowsOf = async (id: string) =>
  ListImportRowsResponse.parse((await api.request(`/api/imports/${id}/rows`)).body).items;

async function accountEtag(id = uuid(1)) {
  const response = await api.request(`/api/accounts/${id}`);
  expect(response.status).toBe(200);
  return response.headers.get("etag")!;
}

interface Selection { importId: string; importVersion: string; rowIds: string[] }

/** Every response goes through the operation's own declared statuses and schemas. */
async function extend(options: {
  id?: string; etag?: string; start?: string; openingMinor?: string; heldRows?: Selection | null;
} = {}) {
  const id = options.id ?? uuid(1);
  const response = await api.request(`/api/accounts/${id}/baseline`, { method: "POST",
    headers: { "if-match": options.etag ?? await accountEtag(id) },
    body: {
      mode: "extend_backward",
      trackingStartDate: options.start ?? "2026-03-01",
      openingBalance: { amountMinor: options.openingMinor ?? "125000", currency: "USD" },
      ...(options.heldRows === undefined ? {} : { heldRows: options.heldRows }),
    } });
  expect(declaredStatuses("/accounts/{accountId}/baseline", "post")).toContain(String(response.status));
  validateAgainst(response.status === 200 ? "BaselineChangeResult" : "Problem", response.body);
  return response;
}

async function commit(id: string, version: string) {
  const response = await api.request(`/api/imports/${id}/commit`,
    { method: "POST", headers: { "if-match": `"${version}"` } });
  expect(declaredStatuses("/imports/{importId}/commit", "post")).toContain(String(response.status));
  return response;
}

async function refresh(id: string, version: string) {
  const response = await api.request(`/api/imports/${id}/refresh`,
    { method: "POST", headers: { "if-match": `"${version}"` } });
  expect(response.status).toBe(200);
  return (response.body as { import: { version: string } }).import.version;
}

function snapshot() {
  return Object.fromEntries(["transactions", "accounts", "ledger_metadata", "assignment_events", "audit_events",
    "import_source_records", "import_postings", "source_identities", "transfer_pairs", "transfer_legs",
    "import_rows", "import_batches", "uploads"].map(table =>
    [table, api.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

/** The common fixture: one preview whose first two rows are outside coverage. */
async function previewWithEarlyRows(csv = MIXED) {
  await createAccount(api, { trackingStartDate: "2026-04-01" });
  const batch = await upload(csv);
  const rows = await rowsOf(batch.id);
  return { batch, rows };
}

/**
 * A preview whose first row is *both* before the tracking start and a
 * suspected duplicate.
 *
 * Reaching that state takes the void. A row selected for this command has to
 * be genuinely earlier than the current start, or the command refuses it at
 * the coverage boundary and never reaches the duplicate check; but an active
 * ledger transaction before the start is exactly what stops the start being
 * moved later. A voided one does not block the move and still counts as
 * duplicate evidence, because a void is not permission to import the same
 * bank record again.
 */
async function previewWithVoidedDuplicate() {
  await createAccount(api, { trackingStartDate: "2026-04-01" });
  const covered = await api.request(`/api/accounts/${uuid(1)}/baseline`, { method: "POST",
    headers: { "if-match": await accountEtag() },
    body: { mode: "extend_backward", trackingStartDate: "2026-03-01",
      openingBalance: { amountMinor: "125000", currency: "USD" } } });
  expect(covered.status).toBe(200);
  const posted = postThroughService(api, { accountId: uuid(1), postedDate: "2026-03-03",
    merchant: "SYNTHETIC EARLY MARKET", money: { amountMinor: "-1500", currency: "USD" }, kind: "purchase" });

  // While it is active it holds the start where it is.
  const blocked = await api.request(`/api/accounts/${uuid(1)}/baseline`, { method: "POST",
    headers: { "if-match": await accountEtag() },
    body: { mode: "move_start_later", trackingStartDate: "2026-04-01",
      openingBalance: { amountMinor: "125000", currency: "USD" } } });
  expect(blocked.status).toBe(409);

  const preview = await api.request(`/api/transactions/${posted.id}/repair-previews`,
    { method: "POST", body: { action: "void", reason: "synthetic duplicate evidence" } });
  expect(preview.status).toBe(201);
  expect((await api.request(`/api/transaction-repairs/${(preview.body as { id: string }).id}/apply`,
    { method: "POST", body: { confirmUnlinking: true } })).status).toBe(200);
  const later = await api.request(`/api/accounts/${uuid(1)}/baseline`, { method: "POST",
    headers: { "if-match": await accountEtag() },
    body: { mode: "move_start_later", trackingStartDate: "2026-04-01",
      openingBalance: { amountMinor: "125000", currency: "USD" } } });
  expect(later.status).toBe(200);

  const batch = await upload(MIXED);
  const rows = await rowsOf(batch.id);
  // Held for coverage *and* suspected: the state these tests need, because the
  // coverage this command supplies settles only one of the two.
  expect(rows[0]!.issues.map(issue => issue.code).sort())
    .toEqual(["before_tracking_start", "suspected_duplicate"]);
  return { batch, rows };
}

describe("held rows in review", () => {
  it("shows a row before the tracking start as held for coverage, not as a correction", async () => {
    const { rows } = await previewWithEarlyRows();
    expect(rows.map(row => [row.state, row.issues.map(issue => issue.code)])).toEqual([
      ["held", ["before_tracking_start"]],
      ["held", ["before_tracking_start"]],
      ["ready", []],
    ]);
    // The date is not the thing that is wrong, so the issue names no field to
    // correct.
    expect(rows[0]!.issues[0]).toMatchObject({ field: null });
  });

  it("counts held rows in the month summary and refuses an ordinary commit", async () => {
    const { batch } = await previewWithEarlyRows();
    const summary = await api.request("/api/summary?month=2026-05");
    expect((summary.body as { review: Record<string, number> }).review).toMatchObject({
      openImportCount: 1, heldImportRowCount: 2,
    });
    const refused = await commit(batch.id, batch.version);
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe("held_rows_unresolved");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });
});

describe("extending coverage and posting the selection together", () => {
  it("applies the new start and posts only the selected rows in one transaction", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    const response = await extend({ heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id, rows[1]!.id] } });
    expect(response.status).toBe(200);
    const result = ChangeAccountBaselineResponse.parse(response.body);
    expect(result.account.trackingStartDate).toBe("2026-03-01");
    expect(result.postedTransactionIds).toHaveLength(2);

    // Each posted row carries its own import provenance, and the paths are
    // recorded so a later count can tell the two apart.
    for (const [index, id] of result.postedTransactionIds.entries()) {
      const transaction = (await api.request(`/api/transactions/${id}`)).body;
      expect(transaction).toMatchObject({ importId: batch.id, sourceRowNumber: index + 1,
        postedDate: index === 0 ? "2026-03-03" : "2026-03-20" });
    }
    expect(api.db.prepare("SELECT posting_path, COUNT(*) AS n FROM import_postings GROUP BY posting_path").all())
      .toEqual([{ posting_path: "baseline_extension", n: 2n }]);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_source_records").get()).toEqual({ n: 2n });

    // The April row was not selected and is untouched: still open, still ready.
    const after = await rowsOf(batch.id);
    expect(after.map(row => row.postedTransactionId)).toEqual([...result.postedTransactionIds, null]);
    expect(after[2]!.state).toBe("ready");
    expect(api.db.prepare("SELECT status FROM import_batches WHERE id = ?").get(batch.id))
      .toEqual({ status: "preview" });
  });

  it("makes a posted row immutable and leaves the rest of the review usable", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    expect((await extend({ heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] } })).status).toBe(200);
    const version = api.db.prepare("SELECT version FROM import_batches WHERE id = ?").get(batch.id) as { version: bigint };

    const save = await api.request(`/api/imports/${batch.id}/rows/${rows[0]!.id}`, { method: "PATCH",
      headers: { "if-match": `"${String(version.version)}"` }, body: { merchant: "SYNTHETIC RENAMED" } });
    expect(save.status).toBe(422);
    // The other early row is still editable, and still held for coverage it no
    // longer lacks until the preview is refreshed.
    const other = await api.request(`/api/imports/${batch.id}/rows/${rows[1]!.id}`, { method: "PATCH",
      headers: { "if-match": `"${String(version.version)}"` }, body: { merchant: "SYNTHETIC EDITED" } });
    expect(other.status).toBe(200);
  });

  it("requires a refresh before committing, then resolves the remaining early row", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    expect((await extend({ heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] } })).status).toBe(200);
    const version = String((api.db.prepare("SELECT version FROM import_batches WHERE id = ?")
      .get(batch.id) as { version: bigint }).version);

    // The account's ledger revision moved, so the preview is stale until it is
    // refreshed against the new inputs.
    const stale = await commit(batch.id, version);
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe("preview_stale");

    const refreshed = await refresh(batch.id, version);
    const after = await rowsOf(batch.id);
    // March 20 is now inside coverage, so its only issue is gone.
    expect(after[1]).toMatchObject({ state: "ready", issues: [] });
    expect(after[0]!.postedTransactionId).not.toBeNull();

    const committed = await commit(batch.id, refreshed);
    expect(committed.status).toBe(200);
    // Three rows, three transactions: the baseline row is counted once, by the
    // path that actually posted it, and is not posted again here.
    expect((committed.body as { import: { result: unknown } }).import.result)
      .toMatchObject({ rows: 3, added: 3, excluded: 0, pairedTransfers: 0 });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 3n });
    expect(api.db.prepare("SELECT posting_path, COUNT(*) AS n FROM import_postings GROUP BY posting_path ORDER BY posting_path").all())
      .toEqual([{ posting_path: "baseline_extension", n: 1n }, { posting_path: "commit", n: 2n }]);
  });

  it("reports balances and spending consistently after the extension", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    expect((await extend({ openingMinor: "140000", heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id, rows[1]!.id] } })).status).toBe(200);

    // Opening 1,400.00 on Feb 28, less 15.00 and 25.00 in March.
    const balance = await api.request(`/api/accounts/${uuid(1)}/balance?asOf=2026-03-31`);
    expect(balance.body).toMatchObject({ coverage: "covered",
      balance: { amountMinor: "136000", currency: "USD" } });
    // The day before the new start is covered; the day before that is not.
    expect((await api.request(`/api/accounts/${uuid(1)}/balance?asOf=2026-02-28`)).body)
      .toMatchObject({ balance: { amountMinor: "140000", currency: "USD" } });
    expect((await api.request(`/api/accounts/${uuid(1)}/balance?asOf=2026-02-27`)).body)
      .toMatchObject({ coverage: "outside_coverage", balance: null });

    // Spending counts each row in its own posted month, not the month of the
    // baseline change.
    const march = await api.request("/api/summary?month=2026-03");
    expect((march.body as { spending: { purchases: unknown; net: unknown } }).spending)
      .toMatchObject({ purchases: { amountMinor: "4000", currency: "USD" },
        net: { amountMinor: "4000", currency: "USD" } });
    // April keeps the row that was never part of this command.
    expect((await api.request("/api/summary?month=2026-04")).body)
      .toMatchObject({ spending: { purchases: { amountMinor: "0", currency: "USD" } } });
  });
});

describe("selections this command cannot use", () => {
  it("changes nothing when a row still has an issue other than coverage", async () => {
    // The second March row has no description, so it is held for that too.
    const { batch, rows } = await previewWithEarlyRows("Date,Description,Amount,Type\r\n"
      + "03/03/2026,SYNTHETIC EARLY MARKET,-15.00,DEBIT\r\n"
      + "03/20/2026,,-25.00,DEBIT\r\n");
    expect(rows[1]!.issues.map(issue => issue.code))
      .toEqual(["before_tracking_start", "missing_merchant"]);
    const before = snapshot();
    const response = await extend({ heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id, rows[1]!.id] } });
    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe("validation_failed");
    // Neither row posted, and the start did not move: the command is one unit.
    expect(snapshot()).toEqual(before);
  });

  it("refuses a row that is not outside the current coverage", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    const response = await extend({ heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[2]!.id] } });
    expect(response.status).toBe(422);
    expect((response.body as { fieldErrors: { path: string }[] }).fieldErrors[0]!.path).toBe("/heldRows/rowIds");
  });

  it("refuses a row the requested start still would not cover", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    const response = await extend({ start: "2026-03-10", heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id, rows[1]!.id] } });
    expect(response.status).toBe(422);
    expect(api.db.prepare("SELECT tracking_start_date FROM accounts WHERE id = ?").get(uuid(1)))
      .toEqual({ tracking_start_date: "2026-04-01" });
  });

  it("refuses an excluded row, a row from another preview and a repeated row", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    const excluded = await api.request(`/api/imports/${batch.id}/rows/${rows[1]!.id}`, { method: "PATCH",
      headers: { "if-match": `"${batch.version}"` }, body: { excluded: true } });
    expect(excluded.status).toBe(200);
    const version = (excluded.body as { import: { version: string } }).import.version;

    for (const rowIds of [[rows[1]!.id], [uuid(77, "41000000")], [rows[0]!.id, rows[0]!.id]]) {
      const response = await extend({ heldRows: { importId: batch.id, importVersion: version, rowIds } });
      expect(response.status).toBe(422);
      expect((response.body as { fieldErrors: { path: string }[] }).fieldErrors[0]!.path).toBe("/heldRows/rowIds");
    }
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });

  it("treats a stale version, an expired preview and an already posted row as conflicts, never a 410", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    const selection = { importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] };

    const wrongVersion = await extend({ heldRows: { ...selection, importVersion: "999" } });
    expect(wrongVersion.status).toBe(409);
    expect((wrongVersion.body as { code: string }).code).toBe("preview_stale");

    expect((await extend({ heldRows: selection })).status).toBe(200);
    // The same selection resent: the row has posted, so this view has moved on.
    const again = await extend({ heldRows: selection, start: "2026-02-01", openingMinor: "125000" });
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe("preview_stale");

    // Thirty days also ends the session, so signing in again is part of
    // reaching the expiry, not part of what is being tested.
    api.clock.advance(IMPORT_REVIEW_MS + 1000);
    await api.login();
    const expired = await extend({ heldRows: { ...selection, rowIds: [rows[1]!.id] }, start: "2026-02-01" });
    expect(expired.status).toBe(409);
    expect((expired.body as { code: string }).code).toBe("preview_stale");
  });

  it("refuses a discarded preview and one belonging to another account", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    await createAccount(api, { id: uuid(2), displayName: "Synthetic Other Checking",
      trackingStartDate: "2026-04-01" });

    // Another account's preview is not something this account can select from.
    const other = await api.request(`/api/accounts/${uuid(2)}/baseline`, { method: "POST",
      headers: { "if-match": await accountEtag(uuid(2)) },
      body: { mode: "extend_backward", trackingStartDate: "2026-03-01",
        openingBalance: { amountMinor: "125000", currency: "USD" },
        heldRows: { importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] } } });
    expect(other.status).toBe(422);
    expect((other.body as { fieldErrors: { path: string }[] }).fieldErrors[0]!.path).toBe("/heldRows/importId");

    expect((await api.request(`/api/imports/${batch.id}/discard`, { method: "POST",
      headers: { "if-match": `"${batch.version}"` } })).status).toBe(200);
    const response = await extend({ heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] } });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe("preview_stale");
  });

  /**
   * The row selected here has to be genuinely before the tracking start, or
   * the command refuses it at the coverage boundary and never reaches the
   * duplicate check - which is what this test is about. Getting a ledger
   * transaction to sit before the start takes the void: an *active* one before
   * the start is exactly what blocks moving the start later, while a voided
   * one still counts as duplicate evidence, because a void is not permission
   * to import the same record again.
   */
  it("refuses a selection whose duplicate evidence is unresolved", async () => {
    const { batch, rows } = await previewWithVoidedDuplicate();
    const response = await extend({ start: "2026-02-01", heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] } });
    expect(response.status).toBe(422);
    // The refusal is the unresolved-decision one, not the coverage-boundary
    // one: if the fixture ever drifts back to selecting a covered row, this
    // fails instead of passing for the wrong reason.
    const body = response.body as { detail: string; fieldErrors: { path: string; message: string }[] };
    expect(body.detail).toContain("still need a decision");
    expect(body.fieldErrors).toEqual([{ path: "/heldRows/rowIds", code: "invalid_value",
      message: body.detail }]);
    // Only the voided March transaction; nothing was added and the start held.
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 1n });
    expect(api.db.prepare("SELECT tracking_start_date AS d FROM accounts WHERE id = ?").get(uuid(1)))
      .toEqual({ d: "2026-04-01" });
  });

  /**
   * The other half of the test above: with the duplicate decided, the very
   * same selection goes through. That is what proves the refusal was caused by
   * the unresolved duplicate rather than by anything else about the fixture.
   */
  it("accepts the same selection once the duplicate is decided", async () => {
    const { batch, rows } = await previewWithVoidedDuplicate();
    const decided = await api.request(`/api/imports/${batch.id}/rows/${rows[0]!.id}`, { method: "PATCH",
      headers: { "if-match": `"${batch.version}"` }, body: { duplicateDecision: "include" } });
    expect(decided.status).toBe(200);
    const version = (decided.body as { import: { version: string } }).import.version;
    expect((await api.request(`/api/imports/${batch.id}/rows`)).status).toBe(200);

    const response = await extend({ start: "2026-02-01", heldRows: {
      importId: batch.id, importVersion: version, rowIds: [rows[0]!.id] } });
    expect(response.status).toBe(200);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE lifecycle = 'active'").get())
      .toEqual({ n: 1n });
    expect(api.db.prepare("SELECT tracking_start_date AS d FROM accounts WHERE id = ?").get(uuid(1)))
      .toEqual({ d: "2026-02-01" });
  });

  it("refuses a selection on an archived account without posting anything", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    expect((await api.request(`/api/accounts/${uuid(1)}/archive`, { method: "POST",
      headers: { "if-match": await accountEtag() } })).status).toBe(200);
    const response = await extend({ heldRows: {
      importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] } });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe("reactivation_required");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_postings").get()).toEqual({ n: 0n });
  });
});

describe("retrying the command", () => {
  it("keeps the account-version rule rather than replaying like an import commit", async () => {
    const { batch, rows } = await previewWithEarlyRows();
    const etag = await accountEtag();
    const selection = { importId: batch.id, importVersion: batch.version, rowIds: [rows[0]!.id] };
    expect((await extend({ etag, heldRows: selection })).status).toBe(200);

    // The same request sent again with the same If-Match. A baseline change has
    // no saved result to hand back, so it refuses on the account version and
    // the owner refetches - it does not replay, and it does not post twice.
    const retried = await api.request(`/api/accounts/${uuid(1)}/baseline`, { method: "POST",
      headers: { "if-match": etag },
      body: { mode: "extend_backward", trackingStartDate: "2026-03-01",
        openingBalance: { amountMinor: "125000", currency: "USD" }, heldRows: selection } });
    expect(retried.status).toBe(412);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 1n });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_postings").get()).toEqual({ n: 1n });

    // Missing If-Match is required here too, unlike import commit replay.
    const unconditional = await api.request(`/api/accounts/${uuid(1)}/baseline`, { method: "POST",
      body: { mode: "extend_backward", trackingStartDate: "2026-02-01",
        openingBalance: { amountMinor: "125000", currency: "USD" }, heldRows: selection } });
    expect(unconditional.status).toBe(428);
  });
});

describe("the maximum selection the contract allows", () => {
  it("accepts a body naming 25,000 rows on this route and nowhere else", async () => {
    await createAccount(api, { trackingStartDate: "2026-04-01" });
    const rowIds = Array.from({ length: 25000 }, (_, index) =>
      `41000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    const body = JSON.stringify({ mode: "extend_backward", trackingStartDate: "2026-03-01",
      openingBalance: { amountMinor: "125000", currency: "USD" },
      heldRows: { importId: uuid(6, "40000000"), importVersion: "1", rowIds } });
    expect(Buffer.byteLength(body)).toBeGreaterThan(900 * 1024);

    const accepted = await api.request(`/api/accounts/${uuid(1)}/baseline`, { method: "POST",
      headers: { "if-match": await accountEtag() }, rawBody: body });
    // Read and understood, then refused on its merits: there is no such
    // preview. Not a 413, which would mean the contract's maximum is unusable.
    expect(accepted.status).toBe(422);
    expect((accepted.body as { fieldErrors: { path: string }[] }).fieldErrors[0]!.path).toBe("/heldRows/importId");

    // The larger bound belongs to this route alone.
    const elsewhere = await api.request("/api/rules", { method: "POST", rawBody: body });
    expect(elsewhere.status).toBe(413);
  });
});

/**
 * What happens when the command fails *late* - after the new start is already
 * written, while rows are being posted, or while the response is being checked.
 *
 * The design says the whole thing is one write transaction and the response is
 * validated before it commits, so any of these must leave the account, the
 * ledger and the preview exactly as they were. Reading the enclosing
 * transaction is not evidence that it holds; these inject the failures.
 */
describe("a failure after the start is updated", () => {
  /**
   * Makes the command's own id generation the injection point. Every id after
   * the account UPDATE belongs to a later step - the audit record first, then
   * the posted rows - so failing at the k-th one walks the failure through the
   * whole second half of the command.
   */
  function armIdFailure(): { arm: (at: number | null) => void; count: () => number } {
    const real = api.deps.newId;
    let counted = 0;
    let failAt: number | null = null;
    api.deps.newId = () => {
      counted += 1;
      if (counted === failAt) throw new Error("synthetic late failure");
      return real();
    };
    return {
      arm: (at: number | null) => { counted = 0; failAt = at; },
      count: () => counted,
    };
  }

  async function twoEarlyRows() {
    const { batch, rows } = await previewWithEarlyRows();
    return { heldRows: { importId: batch.id, importVersion: batch.version,
      rowIds: [rows[0]!.id, rows[1]!.id] } };
  }

  it("leaves nothing behind, wherever in the second half it fails", async () => {
    // First: how many ids does a successful command make? The etag is fetched
    // before arming, so the count starts at this request's own id - which the
    // middleware makes before the handler runs, so step 1 is not a late
    // failure and the loop below starts at 2.
    const control = armIdFailure();
    const selection = await twoEarlyRows();
    const etag = await accountEtag();
    control.arm(null);
    expect((await extend({ ...selection, etag })).status).toBe(200);
    const steps = control.count();
    // The request id, the audit record and at least one id per posted row. If
    // this ever collapses, the loop below would silently test nothing.
    expect(steps).toBeGreaterThanOrEqual(4);

    for (let step = 2; step <= steps; step += 1) {
      await api.close();
      api = await startTestServer();
      await api.login();
      const injected = armIdFailure();
      const again = await twoEarlyRows();
      const currentEtag = await accountEtag();
      const before = snapshot();
      injected.arm(step);
      const response = await extend({ ...again, etag: currentEtag });

      expect(response.status, `step ${String(step)} should have failed`).toBe(500);
      expect((response.body as { code: string }).code).toBe("internal_error");
      // The start, the opening balance, the postings, the rows and every
      // version number are as they were before the request.
      expect(snapshot(), `step ${String(step)} left state behind`).toEqual(before);
    }
  });

  it("rolls back when the response does not match the contract", async () => {
    const selection = await twoEarlyRows();
    const before = snapshot();
    // The response is validated inside the transaction, so a response the
    // contract does not allow has to roll the whole command back rather than
    // commit it and then report a failure the owner cannot act on.
    const real = ChangeAccountBaselineResponse.safeParse.bind(ChangeAccountBaselineResponse);
    let used = false;
    ChangeAccountBaselineResponse.safeParse = ((value: unknown) => {
      if (used) return real(value);
      used = true;
      return { success: false, error: { issues: [{ path: ["account"], message: "synthetic mismatch" }] } };
    }) as typeof ChangeAccountBaselineResponse.safeParse;
    try {
      const response = await extend(selection);
      expect(used).toBe(true);
      expect(response.status).toBe(500);
      expect((response.body as { code: string }).code).toBe("internal_error");
    } finally {
      ChangeAccountBaselineResponse.safeParse = real;
    }
    expect(snapshot()).toEqual(before);
    // And the account is still usable afterwards: the failure was not durable.
    expect((await extend(selection)).status).toBe(200);
  });
});
