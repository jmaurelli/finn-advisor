import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { CommitImportResponse, ListImportRowsResponse, UpdateImportRowResponse } from "@workspace/api-zod";
import { easternDate } from "../src/domain/dates.js";
import { commitImport } from "../src/services/import-posting.js";
import { IMPORT_REVIEW_MS } from "../src/services/imports.js";
import { declaredStatuses, validateAgainst } from "./contract-support.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postThroughService, uuid } from "./finance-harness.js";


let api: TestServer;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { trackingStartDate: "2026-01-01" });
});
afterEach(async () => { await api.close(); });

const ONE = "Date,Description,Amount,Type\r\n05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n";
const TWO = ONE + "05/02/2026,SYNTHETIC SECOND,-10.00,DEBIT\r\n";
async function upload(csv = ONE, format = "synthetic-canonical-checking") {
  const boundary = "SyntheticPostingBoundary";
  const fields = [["accountId", uuid(1)], ["formatId", format]];
  const response = await api.request("/api/imports", { method: "POST",
    contentType: `multipart/form-data; boundary=${boundary}`,
    rawBody: fields.map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n` });
  expect(response.status).toBe(201);
  return (response.body as { import: { id: string; version: string } }).import;
}
const rowsOf = async (id: string) => ListImportRowsResponse.parse((await api.request(`/api/imports/${id}/rows`)).body).items;
async function commit(id: string, version?: string) {
  const response = await api.request(`/api/imports/${id}/commit`,
    { method: "POST", ...(version === undefined ? {} : { headers: { "if-match": `"${version}"` } }) });
  expect(declaredStatuses("/imports/{importId}/commit", "post")).toContain(String(response.status));
  validateAgainst(response.status === 200 ? "ImportBatchResult" : "Problem", response.body);
  return response;
}
async function save(id: string, rowId: string, version: string, body: unknown) {
  const response = await api.request(`/api/imports/${id}/rows/${rowId}`,
    { method: "PATCH", headers: { "if-match": `"${version}"` }, body });
  expect(response.status).toBe(200);
  return UpdateImportRowResponse.parse(response.body);
}
function financialSnapshot() {
  return Object.fromEntries(["transactions", "accounts", "ledger_metadata", "assignment_events", "audit_events",
    "import_source_records", "import_postings", "source_identities", "transfer_pairs", "transfer_legs",
    "refund_links", "import_rows", "import_batches", "uploads"].map(table =>
    [table, api.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function post(accountId: string, amountMinor: string, kind: "purchase" | "refund" | "income" | "transfer") {
  return postThroughService(api, { accountId, postedDate: "2026-05-02", merchant: "SYNTHETIC COUNTERPART",
    money: { amountMinor, currency: "USD" }, kind });
}
async function withCounterpart(kind: "refund" | "income" | "transfer" = "income") {
  await createAccount(api, { id: uuid(2), kind: "savings", displayName: "Synthetic Savings", trackingStartDate: "2026-01-01" });
  return post(uuid(2), "4599", kind);
}

describe("atomic import commit", () => {
  it("posts once with retained source evidence, provenance and import history", async () => {
    const batch = await upload(TWO);
    const response = await commit(batch.id, batch.version);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const result = CommitImportResponse.parse(response.body);
    expect(result.import).toMatchObject({ status: "committed", expiresAt: null,
      result: { rows: 2, added: 2, excluded: 0, pairedTransfers: 0 } });
    const rows = await rowsOf(batch.id);
    expect(rows.every(row => row.postedTransactionId !== null)).toBe(true);
    for (const [index, row] of rows.entries()) {
      const transaction = (await api.request(`/api/transactions/${row.postedTransactionId}`)).body;
      expect(transaction).toMatchObject({ importId: batch.id, sourceRowNumber: index + 1 });
    }
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_source_records").get()).toEqual({ n: 2n });
    expect(api.db.prepare("SELECT DISTINCT source FROM assignment_events WHERE event_type = 'imported'").all())
      .toEqual([{ source: "import" }]);
    const before = financialSnapshot();
    expect((await commit(batch.id, "999")).body).toEqual(response.body);
    expect((await commit(batch.id)).body).toEqual(response.body);
    expect(financialSnapshot()).toEqual(before);
  });

  it("replays the recorded result after restart, archive and ledger changes", async () => {
    const batch = await upload();
    const first = await commit(batch.id, batch.version);
    expect(first.status).toBe(200);
    post(uuid(1), "-100", "purchase");
    const account = await api.request(`/api/accounts/${uuid(1)}`);
    expect((await api.request(`/api/accounts/${uuid(1)}/archive`, { method: "POST",
      headers: { "if-match": account.headers.get("etag")! } })).status).toBe(200);
    await api.restart();
    expect((await commit(batch.id)).body).toEqual(first.body);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 2n });
  });

  it("requires authentication and CSRF even for replay", async () => {
    const batch = await upload();
    expect((await commit(batch.id, batch.version)).status).toBe(200);
    for (const [options, status] of [[{ omitCookie: true }, 401], [{ csrfToken: null }, 403]] as const) {
      expect((await api.request(`/api/imports/${batch.id}/commit`, { method: "POST", ...options })).status).toBe(status);
    }
  });

  it("enforces version and deadline before posting new work", async () => {
    const batch = await upload();
    expect((await commit(batch.id)).status).toBe(428);
    expect((await commit(batch.id, "999")).status).toBe(412);
    api.clock.advance(IMPORT_REVIEW_MS);
    await api.login();
    expect((await commit(batch.id, batch.version)).status).toBe(410);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });

  it("refuses a whole batch if one row is held", async () => {
    const batch = await upload(ONE + "05/02/2026,SYNTHETIC UNKNOWN,10.00,CREDIT\r\n");
    const before = financialSnapshot();
    expect((await commit(batch.id, batch.version)).body).toMatchObject({ code: "held_rows_unresolved" });
    expect(financialSnapshot()).toEqual(before);
  });

  it("refuses uncovered dates even before baseline review integration", async () => {
    const batch = await upload("Date,Description,Amount,Type\r\n12/31/2025,SYNTHETIC EARLY,-1.00,DEBIT\r\n");
    expect((await commit(batch.id, batch.version)).body).toMatchObject({ code: "held_rows_unresolved" });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });

  it("retains exclusions without posting them and counts them in the immutable result", async () => {
    const batch = await upload(TWO);
    const rows = await rowsOf(batch.id);
    const saved = await save(batch.id, rows[1]!.id, batch.version, { excluded: true });
    const result = CommitImportResponse.parse((await commit(batch.id, saved.import.version)).body);
    expect(result.import.result).toMatchObject({ rows: 2, added: 1, excluded: 1 });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_source_records").get()).toEqual({ n: 2n });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_postings").get()).toEqual({ n: 1n });
  });

  it("checks current ledger revisions rather than trusting a clean preview", async () => {
    const batch = await upload();
    post(uuid(1), "-100", "purchase");
    const before = financialSnapshot();
    expect((await commit(batch.id, batch.version)).body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });

  it("rediscovers a duplicate introduced by an edit to a different row", async () => {
    const batch = await upload(TWO);
    const rows = await rowsOf(batch.id);
    const changed = await save(batch.id, rows[1]!.id, batch.version,
      { postedDate: "2026-05-01", merchant: "SYNTHETIC MARKET", money: { amountMinor: "-4599", currency: "USD" } });
    const included = await save(batch.id, rows[1]!.id, changed.import.version, { duplicateDecision: "include" });
    expect((await rowsOf(batch.id))[0]!.state).toBe("ready");
    const before = financialSnapshot();
    expect((await commit(batch.id, included.import.version)).body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });

  it("writes bank identities used by later uploads", async () => {
    const batch = await upload("Reference,Date,Description,Amount\r\nSYN-1,2026-05-01,SYNTHETIC,-45.99\r\n",
      "synthetic-identified-checking");
    expect((await commit(batch.id, batch.version)).status).toBe(200);
    const next = await upload("Reference,Date,Description,Amount\r\nSYN-1,2026-05-02,SYNTHETIC CHANGED,-50.00\r\n",
      "synthetic-identified-checking");
    expect((await rowsOf(next.id))[0]!.duplicate.status).toBe("confirmed");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM source_identities").get()).toEqual({ n: 1n });
  });

  it("posts explicitly included within-file duplicates without collapsing them", async () => {
    const batch = await upload(ONE + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n");
    const rows = await rowsOf(batch.id);
    const first = await save(batch.id, rows[0]!.id, batch.version, { duplicateDecision: "include" });
    const second = await save(batch.id, rows[1]!.id, first.import.version, { duplicateDecision: "include" });
    const response = await commit(batch.id, second.import.version);
    expect(response.status).toBe(200);
    expect(CommitImportResponse.parse(response.body).import.result).toMatchObject({ added: 2 });
  });

  it("rechecks a manual category even without a rule revision change", async () => {
    const categoryId = uuid(70);
    expect((await api.request("/api/categories", { method: "POST",
      body: { id: categoryId, name: "Synthetic Category", color: "#123456" } })).status).toBe(201);
    const batch = await upload();
    const saved = await save(batch.id, (await rowsOf(batch.id))[0]!.id, batch.version,
      { category: { mode: "category", categoryId } });
    expect((await api.request(`/api/categories/${categoryId}/archive`, { method: "POST", headers: { "if-match": '"1"' },
      body: { ruleSetRevision: "0", budgetPlanVersion: null, ruleResolutions: [] } })).status).toBe(200);
    expect(api.db.prepare("SELECT rule_set_revision FROM ledger_metadata").get()).toEqual({ rule_set_revision: 0n });
    const before = financialSnapshot();
    expect((await commit(batch.id, saved.import.version)).body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });

  it("uses the reviewed rule assignment and refuses later rule changes", async () => {
    const categoryId = uuid(70);
    expect((await api.request("/api/categories", { method: "POST",
      body: { id: categoryId, name: "Synthetic Category", color: "#123456" } })).status).toBe(201);
    expect((await api.request("/api/rules", { method: "POST",
      body: { id: uuid(71), matchType: "contains", pattern: "SYNTHETIC", categoryId } })).status).toBe(201);
    const batch = await upload();
    expect((await commit(batch.id, batch.version)).status).toBe(200);
    const transactionId = (await rowsOf(batch.id))[0]!.postedTransactionId;
    expect((await api.request(`/api/transactions/${transactionId}`)).body).toMatchObject({ categoryId,
      assignment: { origin: "rule", ruleId: uuid(71), ruleRevision: "1" } });
    const next = await upload(ONE.replace("-45.99", "-45.98"));
    expect((await api.request(`/api/rules/${uuid(71)}`, { method: "PATCH", headers: { "if-match": '"1"' },
      body: { enabled: false } })).status).toBe(200);
    const before = financialSnapshot();
    expect((await commit(next.id, next.version)).body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });

  /**
   * The state column is the general gate, standing behind each specific check.
   * Every ordinary way a row is held also leaves a reason a later check finds -
   * an issue, a review flag, an undecided duplicate - so the gate is only
   * observable once those reasons are gone. This clears them directly, which is
   * what a regression in the review path would look like from here.
   */
  it("refuses a held row on an ordinary commit even with no reason left on it", async () => {
    const batch = await upload();
    const row = (await rowsOf(batch.id))[0]!;
    expect(row.state).toBe("ready");
    api.db.prepare("UPDATE import_rows SET state = 'held' WHERE id = ?").run(row.id);
    const before = financialSnapshot();
    const response = await commit(batch.id, batch.version);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "held_rows_unresolved" });
    expect(financialSnapshot()).toEqual(before);
  });

  it("refuses two distinct rows carrying the same bank identity", async () => {
    const batch = await upload("Reference,Date,Description,Amount\r\nSYN-1,2026-05-01,SYNTHETIC ONE,-45.99\r\n"
      + "SYN-1,2026-05-02,SYNTHETIC TWO,-1.00\r\n", "synthetic-identified-checking");
    const before = financialSnapshot();
    expect((await commit(batch.id, batch.version)).body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });
});

describe("confirmed transfer posting", () => {
  it("posts and reclassifies the counterpart in the same write", async () => {
    const counterpart = await withCounterpart();
    const batch = await upload();
    const row = (await rowsOf(batch.id))[0]!;
    const saved = await save(batch.id, row.id, batch.version, { transferDecision: "confirm" });
    const response = await commit(batch.id, saved.import.version);
    expect(response.status).toBe(200);
    expect(CommitImportResponse.parse(response.body).import.result).toMatchObject({ added: 1, pairedTransfers: 1 });
    expect(api.db.prepare("SELECT kind FROM transactions WHERE id = ?").get(counterpart.id)).toEqual({ kind: "transfer" });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transfer_legs").get()).toEqual({ n: 2n });
  });

  it("refuses two rows claiming the same counterpart without posting either", async () => {
    await withCounterpart();
    const batch = await upload(ONE + "05/02/2026,SYNTHETIC OTHER,-45.99,DEBIT\r\n");
    const rows = await rowsOf(batch.id);
    const first = await save(batch.id, rows[0]!.id, batch.version, { transferDecision: "confirm" });
    const second = await save(batch.id, rows[1]!.id, first.import.version, { transferDecision: "confirm" });
    const before = financialSnapshot();
    expect((await commit(batch.id, second.import.version)).body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });

  it("refuses a counterpart that gained a refund link after confirmation", async () => {
    const refund = await withCounterpart("refund");
    const purchase = post(uuid(2), "-4599", "purchase");
    const batch = await upload();
    const saved = await save(batch.id, (await rowsOf(batch.id))[0]!.id, batch.version, { transferDecision: "confirm" });
    expect((await api.request("/api/refund-links", { method: "POST",
      body: { id: uuid(90), refundId: refund.id, purchaseId: purchase.id } })).status).toBe(201);
    const before = financialSnapshot();
    expect((await commit(batch.id, saved.import.version)).body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });

  /**
   * The leg version stored on the row is checked against the counterpart as it
   * actually is. Reaching that check alone takes some arranging: the same change
   * normally makes the recomputed candidate differ from the stored one, so here
   * the stored candidate is brought up to date and the leg version is not, which
   * is what a recompute that forgot to carry the version forward would leave
   * behind. Two layers refuse it - the commit preflight and `createTransferPair`
   * itself - and both say the same thing, so this test pins the outcome rather
   * than which layer produced it: refused, with nothing posted.
   */
  it("refuses a confirmed transfer whose stored leg version no longer matches the counterpart", async () => {
    const counterpart = await withCounterpart();
    const batch = await upload();
    const row = (await rowsOf(batch.id))[0]!;
    const saved = await save(batch.id, row.id, batch.version, { transferDecision: "confirm" });
    // Moved without touching the account's ledger revision, so the batch's own
    // staleness checks cannot see it and this check is the only one left.
    api.db.prepare("UPDATE transactions SET version = version + 1 WHERE id = ?").run(counterpart.id);
    const moved = (api.db.prepare("SELECT version FROM transactions WHERE id = ?")
      .get(counterpart.id) as { version: bigint }).version;
    api.db.prepare(`UPDATE import_rows
      SET transfer_candidate_json = json_set(transfer_candidate_json, '$.counterpartVersion', ?)
      WHERE id = ?`).run(String(moved), row.id);
    const before = financialSnapshot();
    const response = await commit(batch.id, saved.import.version);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "preview_stale" });
    expect(financialSnapshot()).toEqual(before);
  });

  it.each(["income", "transfer"] as const)("handles an archived %s counterpart without changing archived types", async kind => {
    await withCounterpart(kind);
    const batch = await upload();
    const saved = await save(batch.id, (await rowsOf(batch.id))[0]!.id, batch.version, { transferDecision: "confirm" });
    const account = await api.request(`/api/accounts/${uuid(2)}`);
    expect((await api.request(`/api/accounts/${uuid(2)}/archive`, { method: "POST",
      headers: { "if-match": account.headers.get("etag")! } })).status).toBe(200);
    const response = await commit(batch.id, saved.import.version);
    if (kind === "transfer") expect(response.status).toBe(200);
    else {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "reactivation_required" });
      expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 1n });
    }
  });
});

describe("rollback boundaries", () => {
  it.each(["import_source_records", "transactions", "assignment_events", "import_postings", "source_identities", "import_rows",
    "import_batches", "uploads", "audit_events"])("rolls everything back on a %s write failure", async table => {
    const batch = await upload("Reference,Date,Description,Amount\r\nSYN-1,2026-05-01,SYNTHETIC ONE,-45.99\r\n"
      + "SYN-2,2026-05-02,SYNTHETIC TWO,-1.00\r\n", "synthetic-identified-checking");
    const before = financialSnapshot();
    const update = ["import_rows", "import_batches", "uploads"].includes(table);
    api.db.exec(`CREATE TEMP TRIGGER injected_failure BEFORE ${update ? "UPDATE" : "INSERT"} ON ${table}
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect((await commit(batch.id, batch.version)).status).toBe(500);
    expect(financialSnapshot()).toEqual(before);
  });

  it("rolls back the first posted row when the second posting fails", async () => {
    const batch = await upload(TWO);
    const before = financialSnapshot();
    api.db.exec(`CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON transactions
      WHEN NEW.merchant_text = 'SYNTHETIC SECOND' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect((await commit(batch.id, batch.version)).status).toBe(500);
    expect(financialSnapshot()).toEqual(before);
  });

  it.each(["transfer_pairs", "transfer_legs"])("rolls back counterpart reclassification on a %s failure", async table => {
    await withCounterpart();
    const batch = await upload();
    const saved = await save(batch.id, (await rowsOf(batch.id))[0]!.id, batch.version, { transferDecision: "confirm" });
    const before = financialSnapshot();
    api.db.exec(`CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    expect((await commit(batch.id, saved.import.version)).status).toBe(500);
    expect(financialSnapshot()).toEqual(before);
  });

  /**
   * Reading the rule set per posted row made a commit cost rows x rules: with
   * the 2,000 rules the service allows, a 5,000-row commit measured 22.2 s
   * against 2.5 s with none. The count is compared between a one-row and a
   * six-row commit rather than asserted outright, so this pins the property
   * that matters - the rule set is read per commit, not per row - without
   * pinning how many places inside one commit read it.
   */
  it("reads the rule set once per commit rather than once per row", async () => {
    expect((await api.request("/api/categories", { method: "POST",
      body: { id: uuid(9, "abcdef00"), name: "Probe groceries", color: "#123456" } })).status).toBe(201);
    expect((await api.request("/api/rules", { method: "POST", body: { id: uuid(9, "abcdef01"),
      matchType: "contains", pattern: "SYNTHETIC", categoryId: uuid(9, "abcdef00") } })).status).toBe(201);

    const countRuleSetReads = async (run: () => Promise<void>): Promise<number> => {
      const original = api.db.prepare.bind(api.db);
      let reads = 0;
      (api.db as { prepare: unknown }).prepare = (sql: string) => {
        const statement = original(sql);
        if (!sql.includes("FROM rules r")) return statement;
        const all = statement.all.bind(statement);
        return new Proxy(statement, { get: (target, key, receiver) => key === "all"
          ? (...args: unknown[]) => { reads += 1; return all(...args); }
          : Reflect.get(target, key, receiver) as unknown });
      };
      try { await run(); } finally { (api.db as { prepare: unknown }).prepare = original; }
      return reads;
    };

    const one = await upload(ONE);
    const oneRead = await countRuleSetReads(async () => {
      expect((await commit(one.id, one.version)).status).toBe(200);
    });
    const many = await upload("Date,Description,Amount,Type\r\n"
      + Array.from({ length: 6 }, (_, i) => `05/0${String(i + 3)}/2026,SYNTHETIC ROW ${String(i)},-1.00,DEBIT\r\n`).join(""));
    const manyReads = await countRuleSetReads(async () => {
      expect((await commit(many.id, many.version)).status).toBe(200);
    });

    expect(oneRead).toBeGreaterThan(0);
    expect(manyReads).toBe(oneRead);
    // The rule still applied to every row: a commit that read no rules at all
    // would satisfy the comparison above and assign nothing.
    expect(api.db.prepare(`SELECT COUNT(*) AS n FROM transactions
      WHERE assignment_origin = 'rule' AND category_id = ?`).get(uuid(9, "abcdef00"))).toEqual({ n: 7n });
  });

  it("rolls back all postings when final response validation fails", async () => {
    const batch = await upload(TWO);
    const before = financialSnapshot();
    expect(() => withWriteTransaction(api.db, () => commitImport({ db: api.db, now: api.clock.now(),
      today: easternDate(api.clock.now()), newId: api.deps.newId }, batch.id, `"${batch.version}"`,
    () => { throw new Error("synthetic response failure"); }))).toThrow("synthetic response failure");
    expect(financialSnapshot()).toEqual(before);
  });
});
