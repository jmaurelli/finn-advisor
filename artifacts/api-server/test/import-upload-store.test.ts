import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUploadStore, isStorageKey, sanitizeDisplayFilename, UploadStoreError,
  type UploadStore,
} from "../src/imports/upload-store.js";

const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function store(options: { capacity?: number; maxBytes?: number } = {}): Promise<{ store: UploadStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "money-desk-upload-store-"));
  scratch.push(root);
  const created = createUploadStore({ root: path.join(root, "uploads"), ...options });
  await created.initialize();
  return { store: created, root: path.join(root, "uploads") };
}

const bytes = (text: string): AsyncIterable<Uint8Array> => (async function* () {
  yield new TextEncoder().encode(text);
})();

const chunked = (text: string, size: number): AsyncIterable<Uint8Array> => (async function* () {
  const all = new TextEncoder().encode(text);
  for (let offset = 0; offset < all.byteLength; offset += size) yield all.subarray(offset, offset + size);
})();

const read = async (stream: import("node:stream").Readable): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const failureOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof UploadStoreError) return error.code;
    throw error;
  }
  return "no error";
};

describe("private directories", () => {
  it("creates owner-only directories whatever the process umask is", async () => {
    const original = process.umask(0o000);
    try {
      const { root } = await store();
      for (const dir of [root, path.join(root, "objects"), path.join(root, "staging")]) {
        const info = await lstat(dir);
        expect(info.isDirectory()).toBe(true);
        expect((info.mode & 0o777).toString(8)).toBe("700");
      }
    } finally {
      process.umask(original);
    }
  });

  it("can be initialized again without complaint", async () => {
    const { store: created } = await store();
    await expect(created.initialize()).resolves.toBeUndefined();
  });

  it.each(["root", "objects", "staging"])("refuses a symlinked %s without changing its target", async (location) => {
    const base = await mkdtemp(path.join(tmpdir(), "money-desk-upload-link-"));
    scratch.push(base);
    const elsewhere = path.join(base, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await chmod(elsewhere, 0o755);
    const root = path.join(base, "uploads");
    if (location !== "root") await mkdir(root, { mode: 0o700 });
    await symlink(elsewhere, location === "root" ? root : path.join(root, location));
    const created = createUploadStore({ root });
    expect(await failureOf(() => created.initialize())).toBe("storage_unavailable");
    expect((await lstat(elsewhere)).mode & 0o777).toBe(0o755);
  });

  it("tightens an existing storage root that others can read", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "money-desk-upload-open-"));
    scratch.push(base);
    const created = createUploadStore({ root: base });
    // The directory mkdtemp made is 0700; loosening it must be detected. The
    // store tightens what it creates, so an existing loose root is the case
    // that matters.
    const { chmod } = await import("node:fs/promises");
    const objects = path.join(base, "objects");
    await mkdir(objects, { mode: 0o755 });
    await chmod(base, 0o755);
    await chmod(objects, 0o755);
    // initialize() re-tightens, so it succeeds; the check is that it does not
    // leave a world-readable directory behind.
    await created.initialize();
    expect(((await lstat(base)).mode & 0o777).toString(8)).toBe("700");
    expect(((await lstat(objects)).mode & 0o777).toString(8)).toBe("700");
  });
});

describe("receiving bytes", () => {
  it.each([0, 3])("handles a filesystem write returning %i bytes", async (written) => {
    const { store: created, root } = await store();
    const handle = await open(path.join(root, "probe"), "w");
    const prototype = Object.getPrototypeOf(handle) as {
      write(buffer: Uint8Array): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    };
    const original = prototype.write;
    await handle.close();
    vi.spyOn(prototype, "write").mockImplementationOnce(function (this: typeof prototype, buffer) {
      if (written === 0) return Promise.resolve({ bytesWritten: 0, buffer });
      return original.call(this, buffer.subarray(0, written));
    });
    if (written === 0) {
      expect(await failureOf(() => created.receive(bytes("abcdef")))).toBe("storage_unavailable");
      expect(await created.listStoredKeys()).toEqual([]);
      expect(await readdir(path.join(root, "staging"))).toEqual([]);
    } else {
      const received = await created.receive(bytes("abcdef"));
      expect(await read(await created.read(received.storageKey))).toBe("abcdef");
      expect(received.sha256).toBe(createHash("sha256").update("abcdef").digest("hex"));
    }
  });

  /**
   * A failing disk is not a failing sender. Every filesystem step the store
   * takes is classified as `storage_unavailable`; only an error from reading
   * the sender's stream is `upload_incomplete`. Folding the two together told
   * the owner their connection dropped when the disk was full or read-only.
   */
  it.each([
    ["ENOSPC", "write"],
    ["EIO", "write"],
    ["EROFS", "write"],
  ])("reports a %s from the filesystem as unusable storage, not an incomplete upload", async (code, syscall) => {
    const { store: created, root } = await store();
    const handle = await open(path.join(root, "probe"), "w");
    const prototype = Object.getPrototypeOf(handle) as { write(buffer: Uint8Array): Promise<unknown> };
    await handle.close();
    vi.spyOn(prototype, "write").mockImplementationOnce(() => {
      const fault: NodeJS.ErrnoException = new Error(`${syscall} ${code}, ${syscall} '${path.join(root, "staging", "secret.part")}'`);
      fault.code = code;
      fault.syscall = syscall;
      return Promise.reject(fault);
    });
    let caught: UploadStoreError | undefined;
    await created.receive(bytes("abcdef")).catch((error: unknown) => { caught = error as UploadStoreError; });
    expect(caught?.code).toBe("storage_unavailable");
    // The operator needs the errno to diagnose this; nobody needs the path,
    // and the underlying message carries one.
    expect(caught?.detail).toBe(`write failed: ${code} (${syscall})`);
    expect(caught?.detail).not.toContain(root);
    expect(caught?.message).toBe("Upload storage is not usable.");
    expect(await created.listStoredKeys()).toEqual([]);
    expect(await readdir(path.join(root, "staging"))).toEqual([]);
  });

  it("still calls a sender that stops early an incomplete upload", async () => {
    const { store: created } = await store();
    const cut = (async function* () {
      yield new TextEncoder().encode("Date,Amount\r\n");
      throw new Error("aborted");
    })();
    expect(await failureOf(() => created.receive(cut))).toBe("upload_incomplete");
  });

  it("returns a random key, the exact size and a fingerprint of what arrived", async () => {
    const { store: created, root } = await store();
    const text = "Date,Amount\r\n05/01/2026,-45.99\r\n";
    const received = await created.receive(bytes(text));
    expect(isStorageKey(received.storageKey)).toBe(true);
    expect(received.byteSize).toBe(Buffer.byteLength(text));
    expect(received.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(await readFile(path.join(root, "objects", received.storageKey), "utf8")).toBe(text);
  });

  it("gives every upload its own key and keeps them apart", async () => {
    const { store: created } = await store();
    const first = await created.receive(bytes("one"));
    const second = await created.receive(bytes("two"));
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(await read(await created.read(first.storageKey))).toBe("one");
    expect(await read(await created.read(second.storageKey))).toBe("two");
  });

  it("fingerprints identical content identically without sharing a file", async () => {
    const { store: created } = await store();
    const first = await created.receive(bytes("same"));
    const second = await created.receive(chunked("same", 1));
    expect(second.sha256).toBe(first.sha256);
    expect(second.storageKey).not.toBe(first.storageKey);
  });

  it("writes files only the owner can read", async () => {
    const original = process.umask(0o000);
    try {
      const { store: created, root } = await store();
      const received = await created.receive(bytes("x"));
      const info = await lstat(path.join(root, "objects", received.storageKey));
      expect((info.mode & 0o777).toString(8)).toBe("600");
    } finally {
      process.umask(original);
    }
  });

  it("assembles bytes arriving in many small pieces", async () => {
    const { store: created } = await store();
    const text = "abcdefghij".repeat(500);
    const received = await created.receive(chunked(text, 7));
    expect(received.byteSize).toBe(text.length);
    expect(await read(await created.read(received.storageKey))).toBe(text);
  });

  it("refuses more bytes than the limit and leaves nothing behind", async () => {
    const { store: created, root } = await store({ maxBytes: 64 });
    expect(await failureOf(() => created.receive(bytes("y".repeat(65))))).toBe("upload_too_large");
    expect(await readdir(path.join(root, "objects"))).toEqual([]);
    expect(await readdir(path.join(root, "staging"))).toEqual([]);
  });

  it("publishes nothing when the sender fails part way through", async () => {
    const { store: created, root } = await store();
    const truncated = (async function* () {
      yield new TextEncoder().encode("Date,Amount\r\n");
      throw new Error("connection reset");
    })();
    expect(await failureOf(() => created.receive(truncated))).toBe("upload_incomplete");
    // Neither a finished object nor an abandoned staging file remains.
    expect(await readdir(path.join(root, "objects"))).toEqual([]);
    expect(await readdir(path.join(root, "staging"))).toEqual([]);
  });

  it("never reports a size or fingerprint for bytes it did not publish", async () => {
    const { store: created } = await store();
    const failing = (async function* () {
      yield new TextEncoder().encode("partial");
      throw new Error("gone");
    })();
    await expect(created.receive(failing)).rejects.toBeInstanceOf(UploadStoreError);
    expect(await created.listStoredKeys()).toEqual([]);
  });

  it("accepts an empty file and reports it as empty rather than missing", async () => {
    const { store: created } = await store();
    const received = await created.receive((async function* () { /* nothing */ })());
    expect(received.byteSize).toBe(0);
    expect(await read(await created.read(received.storageKey))).toBe("");
  });
});

describe("capacity", () => {
  it.each([1, 2])("reserves in-flight capacity at limit %i and releases admission on failure", async (capacity) => {
    const { store: created } = await store({ capacity });
    if (capacity === 2) await created.receive(bytes("retained"));
    let signalStarted!: () => void;
    let signalFinish!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const finish = new Promise<void>(resolve => { signalFinish = resolve; });
    const first = created.receive((async function* () {
      signalStarted();
      await finish;
      throw new Error("sender disconnected");
      yield new Uint8Array();
    })());
    const failed = expect(first).rejects.toBeInstanceOf(UploadStoreError);
    await started;
    let consumed = false;
    try {
      expect(await failureOf(() => created.receive((async function* () {
        consumed = true;
        yield new Uint8Array([1]);
      })()))).toBe("storage_capacity_exhausted");
      expect(consumed).toBe(false);
    } finally {
      signalFinish();
      await failed;
    }
    await expect(created.receive(bytes("retry"))).resolves.toMatchObject({ byteSize: 5 });
  });

  it("refuses a new upload rather than deleting one that may still be needed", async () => {
    const { store: created } = await store({ capacity: 2 });
    const first = await created.receive(bytes("one"));
    const second = await created.receive(bytes("two"));
    expect(await failureOf(() => created.receive(bytes("three")))).toBe("storage_capacity_exhausted");
    // Both existing uploads are untouched.
    expect(await created.listStoredKeys()).toEqual([first.storageKey, second.storageKey].sort());
    expect(await read(await created.read(first.storageKey))).toBe("one");
  });

  it("accepts again once something has been removed", async () => {
    const { store: created } = await store({ capacity: 1 });
    const first = await created.receive(bytes("one"));
    expect(await failureOf(() => created.receive(bytes("two")))).toBe("storage_capacity_exhausted");
    await created.remove(first.storageKey);
    await expect(created.receive(bytes("two"))).resolves.toMatchObject({ byteSize: 3 });
  });

  it("reports the configured capacity", async () => {
    const { store: created } = await store({ capacity: 5 });
    expect(created.capacity()).toBe(5);
  });
});

describe("reading and removing", () => {
  it("refuses a key that is not a key, so no key can name a path", async () => {
    const { store: created } = await store();
    for (const key of [
      "../../etc/passwd", "..", ".", "", "/etc/passwd", "a".repeat(31), "a".repeat(33),
      "A".repeat(32), "z".repeat(32), "0123456789abcdef0123456789abcde/", "objects",
    ]) {
      expect(await failureOf(() => created.read(key))).toBe("storage_unavailable");
      expect(await failureOf(() => created.remove(key))).toBe("storage_unavailable");
    }
  });

  it("refuses to read through a symbolic link planted at an object's name", async () => {
    const { store: created, root } = await store();
    const secret = path.join(root, "..", "secret.txt");
    await writeFile(secret, "not yours", { mode: 0o600 });
    const key = "0".repeat(32);
    await symlink(secret, path.join(root, "objects", key));
    expect(await failureOf(() => created.read(key))).toBe("storage_unavailable");
  });

  it("removes bytes and treats a second removal as already done", async () => {
    const { store: created, root } = await store();
    const received = await created.receive(bytes("x"));
    await created.remove(received.storageKey);
    expect(await readdir(path.join(root, "objects"))).toEqual([]);
    await expect(created.remove(received.storageKey)).resolves.toBeUndefined();
  });

  it("reports a missing object rather than pretending it is empty", async () => {
    const { store: created } = await store();
    expect(await failureOf(() => created.read("1".repeat(32)))).toBe("storage_unavailable");
  });

  it("lists only keys it owns, ignoring anything else in the directory", async () => {
    const { store: created, root } = await store();
    const received = await created.receive(bytes("x"));
    await writeFile(path.join(root, "objects", "README"), "not a key");
    await writeFile(path.join(root, "objects", "not-a-key.txt"), "nor this");
    expect(await created.listStoredKeys()).toEqual([received.storageKey]);
  });
});

describe("abandoned staging files", () => {
  it("removes only its own stale staging names, and leaves fresh ones alone", async () => {
    const { store: created, root } = await store();
    const staging = path.join(root, "staging");
    const stale = path.join(staging, `${"a".repeat(32)}.part`);
    const fresh = path.join(staging, `${"b".repeat(32)}.part`);
    const foreign = path.join(staging, "someone-elses-file");
    for (const file of [stale, fresh, foreign]) await writeFile(file, "x", { mode: 0o600 });
    const now = Date.now();
    const old = new Date(now - 7200_000);
    await utimes(stale, old, old);
    await utimes(foreign, old, old);

    expect(await created.cleanStaging(3600_000, now)).toBe(1);
    expect((await readdir(staging)).sort()).toEqual([`${"b".repeat(32)}.part`, "someone-elses-file"]);
  });

  it("does nothing when there is nothing abandoned", async () => {
    const { store: created } = await store();
    expect(await created.cleanStaging(1000, Date.now())).toBe(0);
  });

  it("never touches finished objects", async () => {
    const { store: created } = await store();
    const received = await created.receive(bytes("keep"));
    await created.cleanStaging(0, Date.now() + 1);
    expect(await created.listStoredKeys()).toEqual([received.storageKey]);
  });
});

describe("display filenames", () => {
  it.each([
    ["statement.csv", "statement.csv"],
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\me\\may.csv", "may.csv"],
    ["/absolute/path/april.csv", "april.csv"],
    ["  spaced.csv  ", "spaced.csv"],
    [".hidden.csv", "hidden.csv"],
    ["with\u0000null.csv", "withnull.csv"],
    ["line\nbreak.csv", "linebreak.csv"],
    ["statement (may) #2.csv", "statement (may) #2.csv"],
    ["ünïcode.csv", "ünïcode.csv"],
  ])("turns %j into %j", (supplied, expected) => {
    expect(sanitizeDisplayFilename(supplied)).toBe(expected);
  });

  it.each(["", "   ", ".", "..", "...", "/", "\\", "/////", null, undefined, 42, {}])(
    "falls back to a safe name for %j", supplied => {
      expect(sanitizeDisplayFilename(supplied)).toBe("upload.csv");
    });

  it("bounds the length the column accepts", () => {
    expect(sanitizeDisplayFilename(`${"x".repeat(400)}.csv`)).toHaveLength(255);
  });

  it("never produces something that could be read as a path", () => {
    for (const supplied of ["../../x", "a/b/c", "a\\b\\c", "..\\..\\x", "./x"]) {
      const result = sanitizeDisplayFilename(supplied);
      expect(result).not.toMatch(/[/\\]/);
      expect(result).not.toBe("..");
      expect(result).not.toBe(".");
    }
  });
});
