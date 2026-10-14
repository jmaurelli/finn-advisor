/**
 * The finance behaviour that has to survive contact with a real import.
 *
 * Every earlier finance test posts through the posting service directly. That
 * proves the arithmetic and says nothing about whether rows that arrive as a
 * reviewed file reach it in the same shape. These cases run the PRD's headline
 * acceptance scenarios end to end through upload, review and commit:
 *
 * - an $80 card purchase and its $80 payment report $80 of spending, never
 *   $160, whichever file is imported first;
 * - a refund reduces the month it was posted in, leaving the purchase's month
 *   exactly as it was;
 * - balances, budgets, checkpoint rechecks and repairs all read imported rows
 *   as ordinary financial history.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ListImportRowsResponse } from "@workspace/api-zod";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, uuid } from "./finance-harness.js";

let api: TestServer;
const CHECKING = uuid(1);
const CARD = uuid(2);
const GROCERIES = uuid(10, "30000000");

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { id: CHECKING, trackingStartDate: "2026-04-01", openingMinor: "200000" });
  await createAccount(api, { id: CARD, kind: "credit_card", providerKey: "capital_one",
    displayName: "Synthetic Card", maskedSuffix: "0002", trackingStartDate: "2026-04-01", openingMinor: "0" });
});
afterEach(async () => { await api.close(); });

async function upload(accountId: string, formatId: string, csv: string) {
  const boundary = "SyntheticIntegrationBoundary";
  const response = await api.request("/api/imports", { method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: [["accountId", accountId], ["formatId", formatId]].map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n` });
  expect(response.status, response.text).toBe(201);
  return (response.body as { import: { id: string; version: string } }).import;
}

const rowsOf = async (id: string) =>
  ListImportRowsResponse.parse((await api.request(`/api/imports/${id}/rows`)).body).items;

async function save(importId: string, rowId: string, version: string, body: unknown) {
  const response = await api.request(`/api/imports/${importId}/rows/${rowId}`,
    { method: "PATCH", headers: { "if-match": `"${version}"` }, body });
  expect(response.status, response.text).toBe(200);
  return (response.body as { import: { version: string } }).import.version;
}

async function commit(importId: string, version: string) {
  const response = await api.request(`/api/imports/${importId}/commit`,
    { method: "POST", headers: { "if-match": `"${version}"` } });
  expect(response.status, response.text).toBe(200);
  return response.body as { import: { result: { added: number; pairedTransfers: number } } };
}

/** Whole-file convenience: upload, optionally decide rows, commit. */
async function importFile(accountId: string, formatId: string, csv: string,
  decide?: (importId: string, rows: Awaited<ReturnType<typeof rowsOf>>, version: string) => Promise<string>) {
  const batch = await upload(accountId, formatId, csv);
  const version = decide === undefined ? batch.version
    : await decide(batch.id, await rowsOf(batch.id), batch.version);
  return { batch, result: await commit(batch.id, version) };
}

const CHECKING_HEADER = "Date,Description,Amount,Type\r\n";
const CARD_HEADER = "Post Date,Description,Debit,Credit,Status,Account Number\r\n";
/** The checking side of the card payment: money leaving, with no type evidence. */
const CHECKING_PAYMENT = `${CHECKING_HEADER}04/20/2026,SYNTHETIC CARD PAYMENT,-80.00,DEBIT\r\n`;
/** The card side: an $80 purchase and the $80 payment arriving as a credit. */
const CARD_ACTIVITY = `${CARD_HEADER}2026-04-10,SYNTHETIC CARD STORE,80.00,,Posted,****0002\r\n`
  + "2026-04-20,SYNTHETIC CARD PAYMENT,,80.00,Posted,****0002\r\n";

const spending = async (month: string) =>
  (await api.request(`/api/summary?month=${month}`)).body as {
    spending: { purchases: { amountMinor: string }; refunds: { amountMinor: string }; net: { amountMinor: string } };
  };

describe("the $80 card purchase and its payment", () => {
  it("reports $80 of spending when the checking file is imported first", async () => {
    // Nothing in the checking row says the -$80 is a card payment, so it
    // defaults to a purchase and is, for the moment, counted as spending.
    await importFile(CHECKING, "synthetic-canonical-checking", CHECKING_PAYMENT);
    expect((await spending("2026-04")).spending.purchases.amountMinor).toBe("8000");

    // The card file then supplies the other side. Its credit row has no type
    // evidence, so the type is chosen, and the checking row appears as a
    // transfer candidate to confirm.
    const batch = await upload(CARD, "synthetic-status-card", CARD_ACTIVITY);
    const rows = await rowsOf(batch.id);
    expect(rows[1]!.issues.map(issue => issue.code)).toContain("choose_type");
    let version = await save(batch.id, rows[1]!.id, batch.version, { kind: "transfer" });
    const withCandidate = (await rowsOf(batch.id))[1]!;
    expect(withCandidate.transferCandidate).toMatchObject({ accountId: CHECKING, eligible: true,
      counterpartKind: "purchase", requiresKindChange: true });
    version = await save(batch.id, rows[1]!.id, version, { transferDecision: "confirm" });
    const { import: committed } = await commit(batch.id, version);
    expect(committed.result).toMatchObject({ added: 2, pairedTransfers: 1 });

    // Confirming the pair converted the checking row to a transfer, so the only
    // spending left is the purchase itself.
    const totals = await spending("2026-04");
    expect(totals.spending.purchases.amountMinor).toBe("8000");
    expect(totals.spending.net.amountMinor).toBe("8000");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transfer_pairs").get()).toEqual({ n: 1n });
    expect(api.db.prepare("SELECT kind, COUNT(*) AS n FROM transactions GROUP BY kind ORDER BY kind").all())
      .toEqual([{ kind: "purchase", n: 1n }, { kind: "transfer", n: 2n }]);
  });

  it("reports $80 of spending when the card file is imported first", async () => {
    const card = await upload(CARD, "synthetic-status-card", CARD_ACTIVITY);
    const cardRows = await rowsOf(card.id);
    // No counterpart exists yet, so the payment posts as an unpaired transfer.
    const cardVersion = await save(card.id, cardRows[1]!.id, card.version, { kind: "transfer" });
    expect((await rowsOf(card.id))[1]!.transferCandidate).toBeNull();
    expect((await commit(card.id, cardVersion)).import.result)
      .toMatchObject({ added: 2, pairedTransfers: 0 });
    expect((await spending("2026-04")).spending.purchases.amountMinor).toBe("8000");

    // The checking file now finds it. The row still defaults to a purchase, so
    // confirming the match has to change this row's own type as it pairs.
    const checking = await upload(CHECKING, "synthetic-canonical-checking", CHECKING_PAYMENT);
    const checkingRows = await rowsOf(checking.id);
    expect(checkingRows[0]!.transferCandidate).toMatchObject({ accountId: CARD, eligible: true,
      counterpartKind: "transfer", requiresKindChange: false });
    let version = await save(checking.id, checkingRows[0]!.id, checking.version, { kind: "transfer" });
    version = await save(checking.id, checkingRows[0]!.id, version, { transferDecision: "confirm" });
    expect((await commit(checking.id, version)).import.result)
      .toMatchObject({ added: 1, pairedTransfers: 1 });

    // The same answer as the other order: $80, not $160.
    const totals = await spending("2026-04");
    expect(totals.spending.purchases.amountMinor).toBe("8000");
    expect(totals.spending.net.amountMinor).toBe("8000");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transfer_pairs").get()).toEqual({ n: 1n });
  });

  it("cannot post an ambiguous positive row until its type is chosen", async () => {
    const batch = await upload(CARD, "synthetic-status-card", CARD_ACTIVITY);
    const refused = await api.request(`/api/imports/${batch.id}/commit`,
      { method: "POST", headers: { "if-match": `"${batch.version}"` } });
    expect(refused.status).toBe(409);
    expect((refused.body as { code: string }).code).toBe("held_rows_unresolved");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });
});

describe("an imported refund", () => {
  it("reduces the month it was posted in and leaves the purchase's month alone", async () => {
    await importFile(CHECKING, "synthetic-canonical-checking",
      `${CHECKING_HEADER}04/05/2026,SYNTHETIC MARKET,-100.00,DEBIT\r\n`);
    const april = await spending("2026-04");
    expect(april.spending.purchases.amountMinor).toBe("10000");

    // The refund arrives as a May credit, so its type is chosen explicitly.
    await importFile(CHECKING, "synthetic-canonical-checking",
      `${CHECKING_HEADER}05/04/2026,SYNTHETIC MARKET,100.00,CREDIT\r\n`,
      async (importId, rows, version) => save(importId, rows[0]!.id, version, { kind: "refund" }));

    // April is untouched: the refund belongs to the month it posted in.
    expect((await spending("2026-04")).spending).toEqual(april.spending);
    const may = await spending("2026-05");
    expect(may.spending.refunds.amountMinor).toBe("10000");
    expect(may.spending.net.amountMinor).toBe("-10000");
  });
});

describe("imported rows as ordinary financial history", () => {
  it("moves the account balance and the budget for the month it posted in", async () => {
    expect((await api.request("/api/categories", { method: "POST",
      body: { id: GROCERIES, name: "Synthetic Groceries", color: "#112233" } })).status).toBe(201);
    const review = await api.request(`/api/budget-plans/${GROCERIES}/preview-change`, { method: "POST",
      // Today is 2026-05-02, and a regular budget starts no earlier than the
      // current month.
      body: { change: "set_regular", fromMonth: "2026-05", amount: { amountMinor: "50000", currency: "USD" } } });
    expect(review.status).toBe(201);
    expect((await api.request(`/api/budget-plans/${GROCERIES}/apply-change`, { method: "POST",
      body: { previewId: (review.body as { id: string }).id } })).status).toBe(200);

    const batch = await upload(CHECKING, "synthetic-canonical-checking",
      `${CHECKING_HEADER}05/01/2026,SYNTHETIC MARKET,-120.00,DEBIT\r\n`);
    const rows = await rowsOf(batch.id);
    const version = await save(batch.id, rows[0]!.id, batch.version,
      { category: { mode: "category", categoryId: GROCERIES } });
    await commit(batch.id, version);

    // 2,000.00 opening less 120.00.
    expect((await api.request(`/api/accounts/${CHECKING}/balance?asOf=2026-05-02`)).body)
      .toMatchObject({ coverage: "covered", balance: { amountMinor: "188000", currency: "USD" } });
    const budgets = (await api.request("/api/budgets?month=2026-05")).body as
      { items: { categoryId: string }[] };
    const groceries = budgets.items.find(item => item.categoryId === GROCERIES);
    expect(groceries).toMatchObject({ limit: { amountMinor: "50000", currency: "USD" },
      purchases: { amountMinor: "12000", currency: "USD" },
      net: { amountMinor: "12000", currency: "USD" },
      remaining: { amountMinor: "38000", currency: "USD" }, percentUsed: 24 });
  });

  it("flips a reconciled checkpoint to needs recheck, and the recheck reads the imported row", async () => {
    const checkpoint = uuid(30, "60000000");
    expect((await api.request(`/api/accounts/${CHECKING}/checkpoints`, { method: "POST",
      body: { id: checkpoint, closingDate: "2026-04-30",
        statementBalance: { amountMinor: "200000", currency: "USD" } } })).status).toBe(201);
    const listed = async () => ((await api.request(`/api/accounts/${CHECKING}/checkpoints`)).body as
      { items: { id: string; status: string; version: string }[] }).items[0]!;
    expect(await listed()).toMatchObject({ status: "reconciled" });

    await importFile(CHECKING, "synthetic-canonical-checking",
      `${CHECKING_HEADER}04/12/2026,SYNTHETIC MARKET,-120.00,DEBIT\r\n`);
    // The statement no longer matches, and nothing was repaired, so the owner is
    // asked to look rather than told a new answer.
    const stale = await listed();
    expect(stale.status).toBe("needs_recheck");

    const rechecked = await api.request(
      `/api/accounts/${CHECKING}/checkpoints/${checkpoint}/recheck`,
      { method: "POST", headers: { "if-match": `"${stale.version}"` } });
    expect(rechecked.status).toBe(200);
    expect((rechecked.body as { checkpoint: { latestCheck: { calculatedBalance: unknown; matched: boolean } } })
      .checkpoint.latestCheck).toMatchObject({ matched: false,
        calculatedBalance: { amountMinor: "188000", currency: "USD" } });
  });

  it("repairs an imported transaction without disturbing its source evidence", async () => {
    const { batch } = await importFile(CHECKING, "synthetic-canonical-checking",
      `${CHECKING_HEADER}04/12/2026,SYNTHETIC MARKET,-120.00,DEBIT\r\n`);
    const rows = await rowsOf(batch.id);
    const transactionId = rows[0]!.postedTransactionId!;
    const evidence = api.db.prepare("SELECT * FROM import_source_records").all();
    const postings = api.db.prepare("SELECT * FROM import_postings").all();

    const preview = await api.request(`/api/transactions/${transactionId}/repair-previews`, { method: "POST",
      body: { reason: "Synthetic correction", action: "correct",
        money: { amountMinor: "-11000", currency: "USD" } } });
    expect(preview.status, preview.text).toBe(201);
    const applied = await api.request(
      `/api/transaction-repairs/${(preview.body as { id: string }).id}/apply`,
      { method: "POST", body: { confirmUnlinking: true } });
    expect(applied.status, applied.text).toBe(200);

    const corrected = (await api.request(`/api/transactions/${transactionId}`)).body;
    expect(corrected).toMatchObject({ money: { amountMinor: "-11000", currency: "USD" },
      // The provenance still points at the row that produced it.
      importId: batch.id, sourceRowNumber: 1 });
    // A repair corrects the ledger; it never rewrites what the bank sent.
    expect(api.db.prepare("SELECT * FROM import_source_records").all()).toEqual(evidence);
    expect(api.db.prepare("SELECT * FROM import_postings").all()).toEqual(postings);
    expect((await api.request(`/api/accounts/${CHECKING}/balance?asOf=2026-04-30`)).body)
      .toMatchObject({ balance: { amountMinor: "189000", currency: "USD" } });
  });

  it("keeps the completed import's counts after a void", async () => {
    const { batch, result } = await importFile(CHECKING, "synthetic-canonical-checking",
      `${CHECKING_HEADER}04/12/2026,SYNTHETIC MARKET,-120.00,DEBIT\r\n`);
    const transactionId = (await rowsOf(batch.id))[0]!.postedTransactionId!;
    const preview = await api.request(`/api/transactions/${transactionId}/repair-previews`, { method: "POST",
      body: { reason: "Synthetic correction", action: "void" } });
    expect(preview.status).toBe(201);
    expect((await api.request(`/api/transaction-repairs/${(preview.body as { id: string }).id}/apply`,
      { method: "POST", body: { confirmUnlinking: true } })).status).toBe(200);

    // The import added one row. Voiding it later changes the ledger, not the
    // history of what that import did.
    const after = (await api.request(`/api/imports/${batch.id}`)).body as
      { result: { added: number; pairedTransfers: number } };
    expect(after.result).toEqual(result.import.result);
    expect(after.result.added).toBe(1);
  });
});
