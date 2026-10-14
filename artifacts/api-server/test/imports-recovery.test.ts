/**
 * What an interrupted upload amounts to after a restart.
 *
 * The bytes live on the filesystem and the records live in SQLite, so a crash
 * can land between the two. These tests reach that in-between state the way a
 * crash does - by storing the bytes and recording the batch, then stopping
 * short of publishing the preview - using the very functions the upload route
 * uses. Then they run the same recovery the service runs before it opens its
 * socket, and check the outcome is decided by evidence rather than assumed.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { creationDigest } from "../src/domain/digest.js";
import { createAdapterRegistry, type ImportAdapter } from "../src/imports/adapters.js";
import { SYNTHETIC_CHECKING } from "../src/imports/adapters-synthetic.js";
import { recoverInterruptedImports, removeOrphanBytes } from "../src/services/import-recovery.js";
import { createReceivedBatch, publishPreview, parseStoredUpload } from "../src/services/imports.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, uuid } from "./finance-harness.js";

const BOUNDARY = "----MoneyDeskRecoveryBoundary";
const CHECKING = "synthetic-canonical-checking";
const CSV = "Date,Description,Amount,Type\r\n"
  + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n"
  + "05/02/2026,SYNTHETIC ONLINE CREDIT,25.00,CREDIT\r\n";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { id: uuid(1), trackingStartDate: "2026-01-01" });
});
afterEach(async () => {
  await api.close();
});

const objectsDir = () => path.join(api.dataDir, "uploads", "objects");
const storedKeys = async (): Promise<string[]> =>
  (await readdir(objectsDir())).filter(name => /^[0-9a-f]{32}$/.test(name));

const context = () => ({ db: api.db, now: api.clock.now(), newId: api.deps.newId });

interface BatchState { status: string; failure: { code: string } | null }
const batchRow = (id: string): BatchState => {
  const row = api.db.prepare("SELECT status, failure_code FROM import_batches WHERE id = ?").get(id) as
    { status: string; failure_code: string | null };
  return { status: row.status, failure: row.failure_code === null ? null : { code: row.failure_code } };
};

const rowsOf = (id: string): unknown[] =>
  api.db.prepare(`SELECT source_row_number, amount_cents, merchant_text, kind, state
    FROM import_rows WHERE import_id = ? ORDER BY source_row_number`).all(id);

/**
 * Bytes stored and the batch recorded, but the preview never published: the
 * exact state a crash between the two leaves behind. The batch is `receiving`,
 * which is what the route writes before it parses.
 */
async function interrupted(
  content = CSV,
  adapter: ImportAdapter = SYNTHETIC_CHECKING,
): Promise<{ id: string; storageKey: string; sha256: string }> {
  const received = await api.deps.uploads.receive((async function* () {
    yield new TextEncoder().encode(content);
  })());
  const batch = withWriteTransaction(api.db, () => createReceivedBatch(context(), {
    accountId: uuid(1),
    adapter,
    filename: "may.csv",
    sha256: received.sha256,
    byteSize: received.byteSize,
    storageKey: received.storageKey,
    creationDigest: creationDigest({ accountId: uuid(1), sha256: received.sha256, formatId: adapter.id }),
  }));
  expect(batchRow(batch.id).status).toBe("receiving");
  return { id: batch.id, storageKey: received.storageKey, sha256: received.sha256 };
}

/** What the upload route would have done had it not been interrupted. */
async function publishNormally(id: string, storageKey: string, sha256: string): Promise<void> {
  const parsed = await parseStoredUpload(SYNTHETIC_CHECKING, await api.deps.uploads.read(storageKey));
  const batch = api.db.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as never;
  withWriteTransaction(api.db, () => { publishPreview(context(), batch, parsed, sha256); });
}

const upload = async (content = CSV) =>
  api.request("/api/imports", {
    method: "POST",
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    rawBody: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${uuid(1)}\r\n`
      + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="formatId"\r\n\r\n${CHECKING}\r\n`
      + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="may.csv"\r\n`
      + `Content-Type: text/csv\r\n\r\n${content}\r\n--${BOUNDARY}--\r\n`,
  });

describe("a crash between storing the bytes and publishing the preview", () => {
  it("re-reads the verified bytes and publishes exactly what the first pass would have", async () => {
    // What an uninterrupted run produces, for comparison.
    const reference = await interrupted();
    await publishNormally(reference.id, reference.storageKey, reference.sha256);
    const expected = rowsOf(reference.id);

    const crashed = await interrupted(CSV.replace("MARKET", "MARKET II"));
    const outcome = await recoverInterruptedImports(api.deps);

    expect(outcome).toMatchObject({ reparsed: 1, failed: 0, published: 0 });
    expect(batchRow(crashed.id).status).toBe("preview");
    expect(rowsOf(crashed.id)).toEqual(
      expected.map(row => ({ ...(row as Record<string, unknown>), merchant_text: (row as { merchant_text: string }).merchant_text.replace("MARKET", "MARKET II") })),
    );
  });

  it("makes the recovered preview readable over HTTP with its rows counted", async () => {
    const crashed = await interrupted();
    await recoverInterruptedImports(api.deps);
    const read = await api.request(`/api/imports/${crashed.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: "preview",
      rowCounts: { total: 2, ready: 1, held: 1, excluded: 0 },
      failure: null,
      result: null,
    });
  });

  it("recognises the file again, so re-uploading it returns the recovered preview", async () => {
    const crashed = await interrupted();
    await recoverInterruptedImports(api.deps);
    const again = await upload();
    expect(again.status).toBe(200);
    expect((again.body as { disposition: string }).disposition).toBe("existing_preview");
    expect((again.body as { import: { id: string } }).import.id).toBe(crashed.id);
  });

  it("is safe to run twice: the second pass finds nothing left to do", async () => {
    const crashed = await interrupted();
    await recoverInterruptedImports(api.deps);
    const second = await recoverInterruptedImports(api.deps);
    expect(second).toMatchObject({ reparsed: 0, published: 0, failed: 0 });
    expect(batchRow(crashed.id).status).toBe("preview");
    expect(rowsOf(crashed.id)).toHaveLength(2);
  });

  it("publishes every row or none, even though the reader hands over early rows before failing", async () => {
    // The first row reads cleanly; the file then breaks. Nothing may be kept.
    const crashed = await interrupted(
      "Date,Description,Amount,Type\r\n05/01/2026,FIRST ROW,-1.00,DEBIT\r\n05/02/2026,\"unterminated\r\n",
    );
    await recoverInterruptedImports(api.deps);

    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "malformed_csv" } });
    expect(rowsOf(crashed.id)).toEqual([]);
  });

  it("keeps rows that are already there rather than reading the file again", async () => {
    // Publication is a single write, so a published preview is never left at
    // `receiving`. This is the defensive branch: rows present on a batch that
    // has not advanced are treated as the published set, not re-read - which
    // is what stops a second pass from inserting everything twice.
    const crashed = await interrupted();
    api.db.prepare(`INSERT INTO import_rows (id, import_id, source_row_number, source_fields_json,
      posted_date, merchant_text, normalized_text, amount_cents, kind, kind_source, state,
      issues_json, excluded, review_required, duplicate_status, duplicate_matches_json,
      version, created_at, updated_at)
      VALUES (?, ?, 1, '{"Amount":"-45.99"}', '2026-05-01', 'SYNTHETIC MARKET', 'synthetic market',
      -4599, 'purchase', 'bank', 'ready', '[]', 0, 0, 'none', '[]', 1, ?, ?)`)
      .run(api.deps.newId(), crashed.id, api.clock.now(), api.clock.now());

    const outcome = await recoverInterruptedImports(api.deps);

    expect(outcome).toMatchObject({ published: 1, reparsed: 0, failed: 0 });
    expect(batchRow(crashed.id).status).toBe("preview");
    // Still the one row it already had; the file's two rows were not added.
    expect(rowsOf(crashed.id)).toHaveLength(1);
  });

  it("never posts a transaction or a provenance record while recovering", async () => {
    await interrupted();
    await recoverInterruptedImports(api.deps);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_postings").get()).toEqual({ n: 0n });
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_source_records").get()).toEqual({ n: 0n });
  });
});

describe("bytes that cannot be trusted after a restart", () => {
  it("ends the attempt when the stored file is gone", async () => {
    const crashed = await interrupted();
    await api.deps.uploads.remove(crashed.storageKey);

    await recoverInterruptedImports(api.deps);

    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "upload_incomplete" } });
  });

  it("ends the attempt when the stored file was truncated", async () => {
    const crashed = await interrupted();
    await writeFile(path.join(objectsDir(), crashed.storageKey), CSV.slice(0, 40));

    await recoverInterruptedImports(api.deps);

    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "upload_incomplete" } });
    expect(rowsOf(crashed.id)).toEqual([]);
  });

  it("ends the attempt when the stored file no longer matches its fingerprint", async () => {
    const crashed = await interrupted();
    const target = path.join(objectsDir(), crashed.storageKey);
    const original = await readFile(target, "utf8");
    // Same length, different content: only the fingerprint catches this.
    await writeFile(target, original.replace("-45.99", "-95.44"));
    expect((await readFile(target)).byteLength).toBe(Buffer.byteLength(original));

    await recoverInterruptedImports(api.deps);

    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "upload_incomplete" } });
    expect(rowsOf(crashed.id)).toEqual([]);
  });

  it("ends the attempt when the bytes were already marked for deletion", async () => {
    const crashed = await interrupted();
    api.db.prepare("UPDATE uploads SET state = 'deletion_pending' WHERE import_id = ?").run(crashed.id);

    await recoverInterruptedImports(api.deps);

    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "upload_incomplete" } });
  });

  it("refuses to re-read bytes with an adapter version that is not the pinned one", async () => {
    const crashed = await interrupted();
    // The batch pinned version 1; only a version 2 adapter is available now.
    api.deps.adapters = createAdapterRegistry([{ ...SYNTHETIC_CHECKING, version: 2 }]);

    await recoverInterruptedImports(api.deps);

    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "unreadable_file" } });
    expect(rowsOf(crashed.id)).toEqual([]);
  });

  it("refuses to re-read bytes when the pinned format is gone entirely", async () => {
    const crashed = await interrupted();
    api.deps.adapters = createAdapterRegistry([]);

    await recoverInterruptedImports(api.deps);

    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "unreadable_file" } });
  });

  it("releases the file claim of a failed attempt so the file can be tried again", async () => {
    const crashed = await interrupted();
    await api.deps.uploads.remove(crashed.storageKey);
    await recoverInterruptedImports(api.deps);

    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_file_claims").get()).toEqual({ n: 0n });
    const again = await upload();
    expect(again.status).toBe(201);
    expect((again.body as { disposition: string }).disposition).toBe("created");
  });

  it("marks the bytes of a failed attempt for deletion rather than losing track of them", async () => {
    const crashed = await interrupted(
      "Date,Memo,Amount\r\n05/01/2026,x,-1.00\r\n",
    );
    await recoverInterruptedImports(api.deps);
    expect(batchRow(crashed.id)).toMatchObject({ status: "failed", failure: { code: "header_mismatch" } });
    // Recovery's own orphan sweep then finishes the deletion it recorded.
    expect(api.db.prepare("SELECT state FROM uploads WHERE import_id = ?").get(crashed.id))
      .toEqual({ state: "deleted" });
    expect(await storedKeys()).toEqual([]);
  });

  it("leaves a completed import alone", async () => {
    const crashed = await interrupted();
    await publishNormally(crashed.id, crashed.storageKey, crashed.sha256);
    api.db.prepare(`UPDATE import_batches SET status = 'committed', expires_at = NULL, result_rows = 2,
      result_added = 2, result_excluded = 0, result_paired_transfers = 0, result_json = '{"added":2}',
      completed_at = ?, version = version + 1 WHERE id = ?`).run(api.clock.now(), crashed.id);

    const outcome = await recoverInterruptedImports(api.deps);

    expect(outcome).toMatchObject({ reparsed: 0, published: 0, failed: 0 });
    expect(batchRow(crashed.id).status).toBe("committed");
    expect(rowsOf(crashed.id)).toHaveLength(2);
  });
});

describe("bytes nobody refers to", () => {
  it("removes stored files the database does not know about", async () => {
    const crashed = await interrupted();
    await publishNormally(crashed.id, crashed.storageKey, crashed.sha256);
    const orphan = "f".repeat(32);
    await writeFile(path.join(objectsDir(), orphan), "abandoned", { mode: 0o600 });
    expect(await storedKeys()).toHaveLength(2);

    expect(await removeOrphanBytes(api.deps)).toBe(1);

    expect(await storedKeys()).toEqual([crashed.storageKey]);
  });

  it("finishes a deletion that was already intended, and records it as done", async () => {
    const crashed = await interrupted();
    api.db.prepare("UPDATE uploads SET state = 'deletion_pending' WHERE import_id = ?").run(crashed.id);

    expect(await removeOrphanBytes(api.deps)).toBe(1);

    expect(await storedKeys()).toEqual([]);
    expect(api.db.prepare("SELECT state FROM uploads WHERE storage_key = ?").get(crashed.storageKey))
      .toEqual({ state: "deleted" });
  });

  it("never removes bytes a live import still refers to", async () => {
    const crashed = await interrupted();
    await publishNormally(crashed.id, crashed.storageKey, crashed.sha256);
    expect(await removeOrphanBytes(api.deps)).toBe(0);
    expect(await storedKeys()).toEqual([crashed.storageKey]);
  });

  it("leaves files outside its own naming alone", async () => {
    await writeFile(path.join(objectsDir(), "someone-elses-notes.txt"), "not mine", { mode: 0o600 });
    expect(await removeOrphanBytes(api.deps)).toBe(0);
    expect(await readdir(objectsDir())).toContain("someone-elses-notes.txt");
  });
});

describe("a real restart of the running service", () => {
  it("keeps a published preview readable, byte for byte", async () => {
    const response = await upload();
    const id = (response.body as { import: { id: string } }).import.id;
    const before = await api.request(`/api/imports/${id}`);
    const [key] = await storedKeys();
    const bytes = await readFile(path.join(objectsDir(), key!), "utf8");

    await api.restart();
    await api.login();

    const after = await api.request(`/api/imports/${id}`);
    expect(after.status).toBe(200);
    expect(after.body).toEqual(before.body);
    expect(await readFile(path.join(objectsDir(), key!), "utf8")).toBe(bytes);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe((api.db.prepare("SELECT sha256 FROM uploads WHERE import_id = ?").get(id) as { sha256: string }).sha256);
  });

  it("settles an interrupted import across a restart, before the first request is served", async () => {
    const crashed = await interrupted();
    await api.restart();
    // The startup path runs this before it opens the socket.
    await recoverInterruptedImports(api.deps);
    await api.login();

    const read = await api.request(`/api/imports/${crashed.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ status: "preview", rowCounts: { total: 2, ready: 1, held: 1, excluded: 0 } });
  });
});
