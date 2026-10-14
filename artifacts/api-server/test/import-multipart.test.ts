import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MULTIPART_MAX_BYTES, readMultipartUpload } from "../src/imports/multipart.js";
import { createUploadStore } from "../src/imports/upload-store.js";

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0)) await rm(root, { recursive: true, force: true });
});
const boundary = "synthetic-boundary";
const headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\n\r\n`;
const end = `\r\n--${boundary}--\r\n`;

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "multipart-regression-"));
  scratch.push(root);
  const store = createUploadStore({ root });
  await store.initialize();
  const read = (request: Readable) => readMultipartUpload(request, {
    headers, requiredFields: [], authorize: () => {}, consume: file => store.receive(file),
  });
  const empty = async () => {
    expect(await store.listStoredKeys()).toEqual([]);
    expect(await readdir(path.join(root, "staging"))).toEqual([]);
  };
  return { store, read, empty };
}

describe("multipart failure ownership", () => {
  it("does not publish a file before the whole envelope is accepted", async () => {
    const { read, empty } = await setup();
    const body = fileHeader + "first" + "\r\n" + fileHeader + "second" + end;
    await expect(read(Readable.from([body]))).rejects.toMatchObject({ code: "too_many_parts" });
    await empty();
  });

  it("does not publish the truncated prefix of an oversized file", async () => {
    const { read, empty } = await setup();
    await expect(read(Readable.from([fileHeader, Buffer.alloc(10 * 1024 * 1024 + 1, 97), end])))
      .rejects.toMatchObject({ code: "file_too_large" });
    await empty();
  });

  it("settles an aborted request and cleans its incomplete file", async () => {
    const { read, empty } = await setup();
    const request = new PassThrough();
    const outcome = read(request);
    const refused = expect(outcome).rejects.toMatchObject({ code: "malformed_multipart" });
    request.write(fileHeader + "partial");
    await new Promise(resolve => setImmediate(resolve));
    request.destroy(new Error("synthetic disconnect"));
    await refused;
    await empty();
  }, 2000);

  it("bounds preamble bytes independently of the file size", async () => {
    const { read, empty } = await setup();
    await expect(read(Readable.from([Buffer.alloc(11 * 1024 * 1024, 97), "\r\n", fileHeader, "small", end])))
      .rejects.toMatchObject({ code: "file_too_large" });
    await empty();
  });

  it("still publishes an accepted file after checking its envelope", async () => {
    const { read, store } = await setup();
    const result = await read(Readable.from([fileHeader, "valid", end]));
    expect(result.accepted.byteSize).toBe(5);
    expect(await store.listStoredKeys()).toEqual([result.accepted.storageKey]);
  });

  it("cleans staging when the closing boundary is missing", async () => {
    const { read, empty } = await setup();
    await expect(read(Readable.from([fileHeader, "partial"])))
      .rejects.toMatchObject({ code: "malformed_multipart" });
    await empty();
  });

  it.each([false, true])("checks the total byte boundary including epilogue (over=%s)", async over => {
    const { read, empty } = await setup();
    const envelope = fileHeader + "small" + end;
    const padding = Buffer.alloc(MULTIPART_MAX_BYTES - Buffer.byteLength(envelope) + Number(over), 97);
    const result = read(Readable.from([envelope, padding]));
    if (over) {
      await expect(result).rejects.toMatchObject({ code: "file_too_large" });
      await empty();
    } else {
      await expect(result).resolves.toMatchObject({ accepted: { byteSize: 5 } });
    }
  });

  it("cancels storage after a real client socket abort", async () => {
    const { read, empty } = await setup();
    let settle!: (error: unknown) => void;
    let started!: () => void;
    const result = new Promise<unknown>(resolve => { settle = resolve; });
    const receiving = new Promise<void>(resolve => { started = resolve; });
    const server = createServer((req, res) => {
      req.once("data", started);
      void read(req).then(() => { settle("unexpected acceptance"); res.end(); }, settle);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const client = httpRequest({ host: "127.0.0.1", port: (server.address() as AddressInfo).port,
      method: "POST", headers });
    client.on("error", () => {});
    try {
      client.write(fileHeader + "partial");
      await receiving;
      client.destroy();
      expect(await result).toMatchObject({ code: "malformed_multipart" });
      await empty();
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 2000);
});
