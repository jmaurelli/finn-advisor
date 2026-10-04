/**
 * The upload endpoint, end to end against a real socket, a real SQLite file
 * and real private storage.
 *
 * The security order is the point of most of this: a request that is not
 * signed in, not same-origin, or without a CSRF token must be refused before
 * any of its bytes are read, and a file must never be stored against a
 * destination that was not checked first.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UploadStoreError } from "../src/imports/upload-store.js";
import { startTestServer, type TestResponse, type TestServer } from "./harness.js";
import { createAccount, uuid } from "./finance-harness.js";

const BOUNDARY = "----MoneyDeskTestBoundary";
const CHECKING = "synthetic-canonical-checking";
const CARD = "synthetic-status-card";
const IDENTIFIED = "synthetic-identified-checking";

const CSV = "Date,Description,Amount,Type\r\n"
  + "05/01/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n"
  + "05/02/2026,SYNTHETIC ONLINE CREDIT,25.00,CREDIT\r\n";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});
afterEach(async () => {
  await api.close();
});

interface Part {
  name: string;
  value?: string;
  file?: { filename: string; content: string };
}

function multipart(parts: readonly Part[]): string {
  let body = "";
  for (const part of parts) {
    body += `--${BOUNDARY}\r\n`;
    if (part.file !== undefined) {
      body += `Content-Disposition: form-data; name="${part.name}"; filename="${part.file.filename}"\r\n`
        + "Content-Type: text/csv\r\n\r\n" + part.file.content + "\r\n";
    } else {
      body += `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ""}\r\n`;
    }
  }
  return body + `--${BOUNDARY}--\r\n`;
}

const upload = async (
  parts: readonly Part[],
  init: { omitOrigin?: boolean; omitCookie?: boolean; csrfToken?: string | null; contentType?: string | null } = {},
): Promise<TestResponse> =>
  api.request("/api/imports", {
    method: "POST",
    rawBody: multipart(parts),
    contentType: init.contentType === undefined
      ? `multipart/form-data; boundary=${BOUNDARY}`
      : init.contentType,
    omitOrigin: init.omitOrigin,
    omitCookie: init.omitCookie,
    csrfToken: init.csrfToken,
  });

const standardParts = (content = CSV, formatId = CHECKING, accountId = uuid(1)): Part[] => [
  { name: "accountId", value: accountId },
  { name: "formatId", value: formatId },
  { name: "file", file: { filename: "synthetic-checking-may.csv", content } },
];

const storedKeys = async (): Promise<string[]> =>
  (await readdir(path.join(api.dataDir, "uploads", "objects"))).filter(name => /^[0-9a-f]{32}$/.test(name));

const stagingFiles = async (): Promise<string[]> => readdir(path.join(api.dataDir, "uploads", "staging"));

async function account(): Promise<string> {
  const created = await createAccount(api, { id: uuid(1), trackingStartDate: "2026-01-01" });
  return created.id;
}

describe("refusing an upload before reading it", () => {
  it("refuses a request with no session and stores nothing", async () => {
    await account();
    const response = await upload(standardParts(), { omitCookie: true });
    expect(response.status).toBe(401);
    expect((response.body as { code: string }).code).toBe("not_authenticated");
    expect(await storedKeys()).toEqual([]);
    expect(await stagingFiles()).toEqual([]);
  });

  it("refuses a cross-origin upload and stores nothing", async () => {
    await account();
    const response = await api.request("/api/imports", {
      method: "POST",
      rawBody: multipart(standardParts()),
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      headers: { origin: "https://elsewhere.invalid" },
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("origin_rejected");
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses an upload with no Origin header at all", async () => {
    await account();
    const response = await upload(standardParts(), { omitOrigin: true });
    expect(response.status).toBe(403);
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses an upload without a CSRF token and stores nothing", async () => {
    await account();
    const response = await upload(standardParts(), { csrfToken: null });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("csrf_invalid");
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses a wrong CSRF token", async () => {
    await account();
    const response = await upload(standardParts(), { csrfToken: "not-the-token" });
    expect(response.status).toBe(403);
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses a body that is not multipart", async () => {
    await account();
    const response = await upload(standardParts(), { contentType: "application/json" });
    expect(response.status).toBe(415);
    expect((response.body as { code: string }).code).toBe("unsupported_media_type");
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses multipart with no boundary", async () => {
    await account();
    const response = await upload(standardParts(), { contentType: "multipart/form-data" });
    expect(response.status).toBe(415);
    expect(await storedKeys()).toEqual([]);
  });
});

describe("refusing before the bytes are stored", () => {
  it("rejects an extra file without keeping the first file or a database batch", async () => {
    await account();
    const response = await upload([...standardParts(),
      { name: "extra", file: { filename: "extra.csv", content: CSV } }]);
    expect(response.status).toBe(422);
    expect(await storedKeys()).toEqual([]);
    expect(await stagingFiles()).toEqual([]);
    expect(api.db.prepare("SELECT count(*) AS n FROM import_batches").get()).toMatchObject({ n: 0n });
  });

  it("rejects an oversized file without retaining its truncated prefix", async () => {
    await account();
    const response = await upload(standardParts("a".repeat(10 * 1024 * 1024 + 1)));
    expect(response.status).toBe(413);
    expect((response.body as { code: string }).code).toBe("payload_too_large");
    expect(await storedKeys()).toEqual([]);
    expect(await stagingFiles()).toEqual([]);
  });

  it("stores nothing for an account that does not exist", async () => {
    await account();
    const response = await upload(standardParts(CSV, CHECKING, uuid(99)));
    expect(response.status).toBe(404);
    expect(await storedKeys()).toEqual([]);
  });

  it("stores nothing for a format that is not available", async () => {
    await account();
    const response = await upload(standardParts(CSV, "chase-checking"));
    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe("unsupported_file_format");
    expect(await storedKeys()).toEqual([]);
  });

  it("stores nothing for a format meant for another kind of account", async () => {
    await account();
    const response = await upload(standardParts(CSV, CARD));
    expect(response.status).toBe(422);
    expect((response.body as { code: string }).code).toBe("unsupported_file_format");
    expect(await storedKeys()).toEqual([]);
  });

  it("stores nothing for an archived account", async () => {
    const id = await account();
    const read = await api.request(`/api/accounts/${id}`);
    const version = read.headers.get("etag")!;
    const archived = await api.request(`/api/accounts/${id}/archive`, {
      method: "POST", headers: { "if-match": version },
    });
    expect(archived.status).toBe(200);
    const response = await upload(standardParts());
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe("reactivation_required");
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses a file that arrives before the fields that say where it belongs", async () => {
    await account();
    const response = await upload([
      { name: "file", file: { filename: "may.csv", content: CSV } },
      { name: "accountId", value: uuid(1) },
      { name: "formatId", value: CHECKING },
    ]);
    expect(response.status).toBe(422);
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses an upload with no file part", async () => {
    await account();
    const response = await upload([
      { name: "accountId", value: uuid(1) },
      { name: "formatId", value: CHECKING },
    ]);
    expect(response.status).toBe(422);
    expect(await storedKeys()).toEqual([]);
  });

  it("refuses an upload carrying more parts than it should", async () => {
    await account();
    const extras: Part[] = Array.from({ length: 8 }, (_, i) => ({ name: `extra${String(i)}`, value: "x" }));
    const response = await upload([
      { name: "accountId", value: uuid(1) },
      { name: "formatId", value: CHECKING },
      ...extras,
      { name: "file", file: { filename: "may.csv", content: CSV } },
    ]);
    expect(response.status).toBe(422);
    expect(await storedKeys()).toEqual([]);
  });
});

describe("the world changing while the file is still arriving", () => {
  /**
   * A body that pauses after its fields so the test can change something while
   * the upload is genuinely in flight, then finish sending the file.
   */
  const slowUpload = async (
    duringUpload: () => void | Promise<void>,
  ): Promise<{ status: number; body: unknown }> => {
    const head = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${uuid(1)}\r\n`
      + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="formatId"\r\n\r\n${CHECKING}\r\n`
      + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="may.csv"\r\n`
      + "Content-Type: text/csv\r\n\r\n"
      // The first line of the file goes with the head, so the file part has
      // genuinely begun - and its pre-upload checks have already run - before
      // the test changes anything.
      + CSV.slice(0, CSV.indexOf("\r\n") + 2);
    const tail = `${CSV.slice(CSV.indexOf("\r\n") + 2)}\r\n--${BOUNDARY}--\r\n`;
    let released: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { released = resolve; });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(head));
        await gate;
        controller.enqueue(new TextEncoder().encode(tail));
        controller.close();
      },
    });
    const headers = new Headers({
      origin: "http://localhost",
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    });
    if (api.cookie !== undefined) headers.set("cookie", api.cookie);
    const csrf = (await api.request("/api/session")).body as { csrfToken?: string };
    if (csrf.csrfToken !== undefined) headers.set("x-csrf-token", csrf.csrfToken);

    const inFlight = fetch(`${api.baseUrl}/api/imports`, {
      method: "POST", headers, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    // The fields have been sent; the file has not.
    await new Promise(resolve => setTimeout(resolve, 50));
    await duringUpload();
    released!();
    const response = await inFlight;
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : JSON.parse(text) };
  };

  it("refuses and discards the bytes when the session expires mid-upload", async () => {
    await account();
    const result = await slowUpload(() => {
      // Past the idle deadline, exactly as a long upload on a slow link would be.
      api.clock.advance(31 * 60 * 1000);
    });
    expect(result.status).toBe(401);
    expect((result.body as { code: string }).code).toBe("session_expired");
    expect(await storedKeys()).toEqual([]);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()).toEqual({ n: 0n });
  });

  it("refuses and discards the bytes when the account is archived mid-upload", async () => {
    const id = await account();
    const result = await slowUpload(() => {
      api.db.prepare("UPDATE accounts SET archived_at = ?, version = version + 1 WHERE id = ?")
        .run(api.clock.now(), id);
    });
    expect(result.status).toBe(409);
    expect((result.body as { code: string }).code).toBe("reactivation_required");
    expect(await storedKeys()).toEqual([]);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()).toEqual({ n: 0n });
  });

  it("still accepts the upload when nothing changed while it was arriving", async () => {
    await account();
    const result = await slowUpload(() => undefined);
    expect(result.status).toBe(201);
    expect((result.body as { import: { status: string } }).import.status).toBe("preview");
    expect(await storedKeys()).toHaveLength(1);
  });
});

describe("a file that parses", () => {
  it("creates a reviewable preview and reports where it lives", async () => {
    await account();
    const response = await upload(standardParts());
    expect(response.status).toBe(201);
    const body = response.body as { disposition: string; import: Record<string, unknown> };
    expect(body.disposition).toBe("created");
    expect(body.import).toMatchObject({
      accountId: uuid(1),
      formatId: CHECKING,
      formatVersion: 1,
      filename: "synthetic-checking-may.csv",
      status: "preview",
      parentImportId: null,
      result: null,
      failure: null,
      uploadRetainedUntil: null,
    });
    // One row is ready; the +25.00 row waits for a type choice.
    expect(body.import["rowCounts"]).toEqual({ total: 2, ready: 1, held: 1, excluded: 0 });
    expect(body.import["commitBlockers"]).toEqual(["held_rows"]);
    expect(response.headers.get("location")).toBe(`/api/imports/${String(body.import["id"])}`);
    expect(response.headers.get("etag")).toBe('"2"');
    expect(await storedKeys()).toHaveLength(1);
    expect(await stagingFiles()).toEqual([]);
  });

  it("stores the bytes exactly and keeps them private", async () => {
    await account();
    await upload(standardParts());
    const [key] = await storedKeys();
    expect(await readFile(path.join(api.dataDir, "uploads", "objects", key!), "utf8")).toBe(CSV);
  });

  it("changes no money: no transaction, no balance, no finance revision", async () => {
    const id = await account();
    const before = await api.request("/api/summary?month=2026-05");
    const beforeRevision = (before.body as { financeRevision: string }).financeRevision;
    const balanceBefore = await api.request(`/api/accounts/${id}/balance?asOf=2026-05-31`);
    await upload(standardParts());
    const list = await api.request("/api/transactions");
    expect((list.body as { items: unknown[] }).items).toEqual([]);
    const after = await api.request("/api/summary?month=2026-05");
    expect((after.body as { financeRevision: string }).financeRevision).toBe(beforeRevision);
    const balanceAfter = await api.request(`/api/accounts/${id}/balance?asOf=2026-05-31`);
    expect(balanceAfter.body).toEqual(balanceBefore.body);
  });

  it("shows the preview again on its own address, without extending its deadline", async () => {
    await account();
    const created = await upload(standardParts());
    const id = (created.body as { import: { id: string } }).import.id;
    const expiresAt = (created.body as { import: { expiresAt: string } }).import.expiresAt;
    api.clock.advance(60_000);
    const read = await api.request(`/api/imports/${id}`);
    expect(read.status).toBe(200);
    expect((read.body as { expiresAt: string }).expiresAt).toBe(expiresAt);
    expect(read.headers.get("etag")).toBe('"2"');
    expect(read.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps a sanitized display name and never a path", async () => {
    await account();
    const response = await upload([
      { name: "accountId", value: uuid(1) },
      { name: "formatId", value: CHECKING },
      { name: "file", file: { filename: "../../etc/passwd", content: CSV } },
    ]);
    expect(response.status).toBe(201);
    expect((response.body as { import: { filename: string } }).import.filename).toBe("passwd");
  });

  it("reads a file with a byte-order mark, quoted commas and embedded newlines", async () => {
    await account();
    const content = "﻿Date,Description,Amount,Type\r\n"
      + '05/01/2026,"SYNTHETIC GROCER, INC",-40.00,DEBIT\r\n'
      + '05/02/2026,"SYNTHETIC\nHARDWARE",-10.00,DEBIT\r\n';
    const response = await upload(standardParts(content));
    expect(response.status).toBe(201);
    expect((response.body as { import: { rowCounts: unknown } }).import.rowCounts)
      .toEqual({ total: 2, ready: 2, held: 0, excluded: 0 });
  });

  it("holds a row whose values need correcting instead of dropping it", async () => {
    await account();
    const content = "Date,Description,Amount,Type\r\n"
      + "02/29/2026,SYNTHETIC MARKET,-45.99,DEBIT\r\n"
      + "05/01/2026,SYNTHETIC MARKET,-0.001,DEBIT\r\n"
      + "05/02/2026,,-1.00,DEBIT\r\n";
    const response = await upload(standardParts(content));
    expect(response.status).toBe(201);
    expect((response.body as { import: { rowCounts: unknown } }).import.rowCounts)
      .toEqual({ total: 3, ready: 0, held: 3, excluded: 0 });
  });
});

describe("a file that does not parse", () => {
  const failing: [string, string, string][] = [
    ["a header that is not the format", "Date,Memo,Amount\r\n05/01/2026,x,-1.00\r\n", "header_mismatch"],
    ["a data row with the wrong column count", "Date,Description,Amount,Type\r\n05/01/2026,x,-1.00\r\n", "malformed_csv"],
    ["a type word the format never saw", "Date,Description,Amount,Type\r\n05/01/2026,x,-1.00,ACH\r\n", "header_mismatch"],
    ["an unterminated quote", 'Date,Description,Amount,Type\r\n05/01/2026,"never closed,-1.00,DEBIT\r\n', "malformed_csv"],
    ["an empty file", "", "unreadable_file"],
  ];

  it.each(failing)("records %s as a safe failure with no rows", async (_label, content, code) => {
    await account();
    const response = await upload(standardParts(content));
    expect(response.status).toBe(201);
    const batch = (response.body as { import: Record<string, unknown> }).import;
    expect(batch["status"]).toBe("failed");
    expect(batch["failure"]).toMatchObject({ code });
    expect(batch["rowCounts"]).toEqual({ total: 0, ready: 0, held: 0, excluded: 0 });
    expect(batch["expiresAt"]).toBeNull();
    expect(batch["commitBlockers"]).toEqual(["not_open"]);
  });

  it("never puts a value from the file into the failure message", async () => {
    await account();
    const content = "Date,Description,Amount,Type\r\n05/01/2026,\"SECRET MERCHANT NAME,-1.00,DEBIT\r\n";
    const response = await upload(standardParts(content));
    const failure = (response.body as { import: { failure: { message: string } } }).import.failure;
    expect(failure.message).not.toContain("SECRET");
    expect(response.text).not.toContain("SECRET MERCHANT NAME");
  });

  it("leaves no rows and no finance change behind after a failure", async () => {
    await account();
    await upload(standardParts("Date,Memo,Amount\r\n05/01/2026,x,-1.00\r\n"));
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_rows").get()).toEqual({ n: 0n });
    const list = await api.request("/api/transactions");
    expect((list.body as { items: unknown[] }).items).toEqual([]);
  });

  it("does not keep recognising the file of a failed attempt", async () => {
    await account();
    const bad = "Date,Memo,Amount\r\n05/01/2026,x,-1.00\r\n";
    const first = await upload(standardParts(bad));
    const second = await upload(standardParts(bad));
    // A second attempt is a new attempt, not the earlier failure replayed.
    expect((second.body as { disposition: string }).disposition).toBe("created");
    expect((second.body as { import: { id: string } }).import.id)
      .not.toBe((first.body as { import: { id: string } }).import.id);
  });
});

describe("the same file twice", () => {
  it("returns the existing preview rather than making a second one", async () => {
    await account();
    const first = await upload(standardParts());
    const firstId = (first.body as { import: { id: string } }).import.id;
    const second = await upload(standardParts());
    expect(second.status).toBe(200);
    expect((second.body as { disposition: string }).disposition).toBe("existing_preview");
    expect((second.body as { import: { id: string } }).import.id).toBe(firstId);
    // And the redundant copy of the bytes was not kept.
    expect(await storedKeys()).toHaveLength(1);
  });

  it("treats the same content under a different name as the same file", async () => {
    await account();
    await upload(standardParts());
    const again = await upload([
      { name: "accountId", value: uuid(1) },
      { name: "formatId", value: CHECKING },
      { name: "file", file: { filename: "renamed.csv", content: CSV } },
    ]);
    expect((again.body as { disposition: string }).disposition).toBe("existing_preview");
  });

  it("lets a different account import the same file", async () => {
    await account();
    await createAccount(api, { id: uuid(2), trackingStartDate: "2026-01-01" });
    await upload(standardParts());
    const other = await upload(standardParts(CSV, CHECKING, uuid(2)));
    expect(other.status).toBe(201);
    expect((other.body as { disposition: string }).disposition).toBe("created");
  });

  it("treats a changed file as a new import", async () => {
    await account();
    await upload(standardParts());
    const changed = await upload(standardParts(CSV + "05/03/2026,SYNTHETIC MARKET,-1.00,DEBIT\r\n"));
    expect(changed.status).toBe(201);
    expect((changed.body as { disposition: string }).disposition).toBe("created");
  });

  // Both requests look for an existing claim before either has parsed, so both
  // find none: the race is real and is resolved when the preview is published.
  it("returns the one preview to both callers when two uploads of it overlap", async () => {
    await account();
    const [first, second] = await Promise.all([upload(standardParts()), upload(standardParts())]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 201]);
    const bodies = [first, second].map(response => response.body as
      { disposition: string; import: { id: string; status: string } });
    const created = bodies.find(body => body.disposition === "created")!;
    const existing = bodies.find(body => body.disposition !== "created")!;
    expect(existing.disposition).toBe("existing_preview");
    // One preview, and both callers were sent to it.
    expect(existing.import.id).toBe(created.import.id);
    expect(existing.import.status).toBe("preview");

    const list = await api.request("/api/imports");
    const items = (list.body as { items: { id: string; status: string; rowCounts: { total: number } }[] }).items;
    expect(items.filter(item => item.status === "preview")).toHaveLength(1);
    // The attempt that gave way is recorded as abandoned, with no rows of its
    // own, rather than failing or disappearing.
    const abandoned = items.filter(item => item.id !== created.import.id);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ status: "cancelled", rowCounts: { total: 0 } });
    // And its redundant copy of the bytes is gone.
    expect(await storedKeys()).toHaveLength(1);
  });

  it("keeps only one claim when two uploads overlap and the winner is then reuploaded", async () => {
    await account();
    await Promise.all([upload(standardParts()), upload(standardParts())]);
    const again = await upload(standardParts());
    expect(again.status).toBe(200);
    expect((again.body as { disposition: string }).disposition).toBe("existing_preview");
    expect(await storedKeys()).toHaveLength(1);
  });
});

describe("storage capacity", () => {
  it("refuses a further upload rather than deleting one that may still be needed", async () => {
    await api.close();
    api = await startTestServer({ uploadCapacity: 1 });
    await api.login();
    await account();
    const first = await upload(standardParts());
    expect(first.status).toBe(201);
    const second = await upload(standardParts("Date,Description,Amount,Type\r\n05/09/2026,OTHER,-1.00,DEBIT\r\n"));
    expect(second.status).toBe(503);
    expect((second.body as { code: string }).code).toBe("service_busy");
    // The first import and its bytes are untouched.
    expect(await storedKeys()).toHaveLength(1);
    const still = await api.request(`/api/imports/${(first.body as { import: { id: string } }).import.id}`);
    expect((still.body as { status: string }).status).toBe("preview");
  });

  /**
   * A store failure part-way through the file used to leave the request with
   * no answer at all: the consumer destroyed the part on its way out, so the
   * parser never reached `finish` and the handler waited for it for as long as
   * the client held the connection. An owner whose disk filled up mid-upload
   * would have watched the page hang.
   */
  it("answers a store failure part-way through the file instead of waiting forever", async () => {
    await account();
    let chunks = 0;
    api.deps.uploads.receive = async (source: AsyncIterable<Uint8Array>) => {
      for await (const chunk of source) {
        chunks += 1;
        void chunk;
        throw new UploadStoreError("upload_incomplete", "synthetic write failure");
      }
      throw new Error("the file had no bytes to fail on");
    };
    const padding = "05/03/2026,SYNTHETIC PADDING,-1.00,DEBIT\r\n".repeat(400);
    const refused = await upload(standardParts(CSV + padding));
    expect(chunks).toBeGreaterThan(0);
    expect(refused.status).toBe(422);
    expect((refused.body as { code: string }).code).toBe("validation_failed");
    expect(await storedKeys()).toEqual([]);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()).toEqual({ n: 0n });
  });

  /**
   * The store being unusable is the app's fault, and saying `validation_failed`
   * told the owner their file was bad when the disk was. It is a 503 with its
   * own code, so the answer names the real cause.
   */
  it("blames its own storage, not the file, when the store is unusable", async () => {
    await account();
    api.deps.uploads.receive = async (source: AsyncIterable<Uint8Array>) => {
      for await (const chunk of source) void chunk;
      throw new UploadStoreError("storage_unavailable", "write failed: ENOSPC (write)");
    };
    const refused = await upload(standardParts(CSV));
    expect(refused.status).toBe(503);
    expect((refused.body as { code: string }).code).toBe("storage_unavailable");
    // No Retry-After: an unusable store needs an operator, not a retry, and a
    // retry hint that cannot come true only wastes the owner's time.
    expect(refused.headers.get("retry-after")).toBeNull();
    expect((refused.body as { retryAfterSeconds?: number }).retryAfterSeconds).toBeUndefined();
    // The operator detail stays out of the response.
    expect(JSON.stringify(refused.body)).not.toContain("ENOSPC");
    expect(await storedKeys()).toEqual([]);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()).toEqual({ n: 0n });
  });
});

/**
 * Receiving a file is bounded by the store, but reading it back and running it
 * through the grammar is where the memory goes, and nothing above the store
 * bounded how many requests could be doing that at once.
 */
describe("concurrent import jobs", () => {
  it("refuses an upload while every job slot is occupied, then accepts once one frees", async () => {
    await api.close();
    api = await startTestServer({ importJobLimit: 1 });
    await api.login();
    await account();
    // Hold the only slot through the real limiter the route uses, so the
    // refusal is the route's own and does not depend on request timing.
    let release: (() => void) | undefined;
    const held = api.deps.importJobs.run(() => new Promise<void>(resolve => { release = resolve; }));

    const refused = await upload(standardParts());
    expect(refused.status).toBe(503);
    expect((refused.body as { code: string }).code).toBe("service_busy");
    expect(refused.headers.get("retry-after")).toBe("30");
    // Refused before the body was read: nothing was stored and no import exists.
    expect(await storedKeys()).toEqual([]);
    expect(await stagingFiles()).toEqual([]);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM import_batches").get()).toEqual({ n: 0n });

    release!();
    await held;
    expect(api.deps.importJobs.active()).toBe(0);
    const accepted = await upload(standardParts());
    expect(accepted.status).toBe(201);
  });

  it("frees the slot when an upload fails", async () => {
    await api.close();
    api = await startTestServer({ importJobLimit: 1 });
    await api.login();
    await account();
    const rejected = await upload([
      { name: "accountId", value: uuid(1) },
      { name: "formatId", value: "no-such-format" },
      { name: "file", file: { filename: "x.csv", content: CSV } },
    ]);
    expect(rejected.status).toBe(422);
    expect(api.deps.importJobs.active()).toBe(0);
    const accepted = await upload(standardParts());
    expect(accepted.status).toBe(201);
  });

  /**
   * Two uploads issued together do not prove the bound admits two: the client
   * or the event loop could serialise them and both would pass under a limit
   * of one. So the first slot is held open here, and the second upload has to
   * succeed *while* it is held.
   */
  it("still admits a second upload while the first is in flight", async () => {
    await account();
    expect(api.deps.importJobs.limit()).toBe(2);
    let release: (() => void) | undefined;
    const held = api.deps.importJobs.run(() => new Promise<void>(resolve => { release = resolve; }));
    expect(api.deps.importJobs.active()).toBe(1);

    const accepted = await upload(standardParts());
    expect(accepted.status).toBe(201);
    // Still held: the upload above really did run alongside it.
    expect(api.deps.importJobs.active()).toBe(1);

    // With the second slot held too, the next upload is refused - so the bound
    // is two exactly, not "two or more".
    let releaseSecond: (() => void) | undefined;
    const alsoHeld = api.deps.importJobs.run(() => new Promise<void>(resolve => { releaseSecond = resolve; }));
    const refused = await upload(
      standardParts("Date,Description,Amount,Type\r\n05/09/2026,OTHER,-1.00,DEBIT\r\n"));
    expect(refused.status).toBe(503);

    release!();
    releaseSecond!();
    await Promise.all([held, alsoHeld]);
    expect(api.deps.importJobs.active()).toBe(0);
  });
});

describe("listing imports", () => {
  it("lists newest first and filters by account and status", async () => {
    await account();
    await createAccount(api, { id: uuid(2), trackingStartDate: "2026-01-01" });
    const good = await upload(standardParts());
    api.clock.advance(1000);
    const bad = await upload(standardParts("Date,Memo,Amount\r\n05/01/2026,x,-1.00\r\n"));
    api.clock.advance(1000);
    const other = await upload(standardParts(CSV, CHECKING, uuid(2)));

    const all = await api.request("/api/imports");
    expect((all.body as { items: { id: string }[] }).items.map(item => item.id)).toEqual([
      (other.body as { import: { id: string } }).import.id,
      (bad.body as { import: { id: string } }).import.id,
      (good.body as { import: { id: string } }).import.id,
    ]);

    const filtered = await api.request(`/api/imports?accountId=${uuid(2)}`);
    expect((filtered.body as { items: unknown[] }).items).toHaveLength(1);
    const failed = await api.request("/api/imports?status=failed");
    expect((failed.body as { items: { id: string }[] }).items.map(item => item.id))
      .toEqual([(bad.body as { import: { id: string } }).import.id]);
  });

  it("pages with a cursor and refuses a tampered one", async () => {
    await account();
    for (let i = 0; i < 3; i++) {
      await upload(standardParts(`Date,Description,Amount,Type\r\n05/0${String(i + 1)}/2026,M,-1.00,DEBIT\r\n`));
      api.clock.advance(1000);
    }
    const first = await api.request("/api/imports?limit=2");
    const page = first.body as { items: unknown[]; nextCursor: string | null };
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const second = await api.request(`/api/imports?limit=2&cursor=${String(page.nextCursor)}`);
    expect((second.body as { items: unknown[]; nextCursor: null }).items).toHaveLength(1);
    expect((second.body as { nextCursor: null }).nextCursor).toBeNull();
    expect((await api.request("/api/imports?cursor=not-a-cursor")).status).toBe(400);
    expect((await api.request("/api/imports?limit=0")).status).toBe(400);
    expect((await api.request("/api/imports?limit=101")).status).toBe(400);
    expect((await api.request("/api/imports?status=nonsense")).status).toBe(400);
    expect((await api.request("/api/imports?accountId=nope")).status).toBe(400);
  });

  it("needs a session to read anything about imports", async () => {
    await account();
    await upload(standardParts());
    for (const path of ["/api/import-formats", "/api/imports", `/api/imports/${uuid(1)}`]) {
      const response = await api.request(path, { omitCookie: true });
      expect(response.status).toBe(401);
    }
  });

  it("reports 404 for an import that does not exist or an unusable id", async () => {
    expect((await api.request(`/api/imports/${uuid(77)}`)).status).toBe(404);
    expect((await api.request("/api/imports/not-a-uuid")).status).toBe(404);
  });
});

describe("available formats", () => {
  it("lists what was injected, marked as fabricated rather than verified", async () => {
    const response = await api.request("/api/import-formats");
    expect(response.status).toBe(200);
    const items = (response.body as { items: { id: string; evidence: string }[] }).items;
    expect(items.map(item => item.id)).toEqual([CHECKING, CARD, IDENTIFIED]);
    expect(items.every(item => item.evidence === "synthetic_only")).toBe(true);
  });
});
