/**
 * Private storage for uploaded bank files.
 *
 * Everything here is owned by this application: the directory, its mode, and
 * every name inside it. A storage key is random and is checked against a
 * strict shape before it ever reaches the filesystem, so a key can never
 * express a path, a parent directory or a hidden file. Every open uses
 * `O_NOFOLLOW`, so a symbolic link planted in place of an object is refused
 * rather than followed out of the store.
 *
 * Bytes become visible under their final name only once they are complete and
 * on disk: the file is written to a staging name, fsynced, renamed within the
 * same directory, and the directory itself fsynced. A crash therefore leaves
 * either no object or a whole one, never a half-written file that looks
 * finished. Anything left behind in staging is identifiable as abandoned and
 * is removed by cleanup, which only ever touches names this store owns.
 *
 * The store holds no financial meaning and never decides what an import does;
 * it moves and protects bytes.
 */
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

/** Owner-only, matching the plan: 0700 directories and 0600 files. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const STORAGE_KEY = /^[0-9a-f]{32}$/;
const OBJECTS = "objects";
const STAGING = "staging";

export type UploadStoreFailure =
  /** More uploads are being retained than the configured capacity allows. */
  | "storage_capacity_exhausted"
  /** The sender exceeded the declared byte limit. */
  | "upload_too_large"
  /** The connection ended before the bytes did. */
  | "upload_incomplete"
  /** The store itself is unusable: wrong permissions, missing, or tampered with. */
  | "storage_unavailable";

export class UploadStoreError extends Error {
  constructor(readonly code: UploadStoreFailure, detail?: string) {
    // No path, key or file content in the message: these surface in logs.
    super({
      storage_capacity_exhausted: "No capacity to accept another upload right now.",
      upload_too_large: "The uploaded file is larger than the import limit.",
      upload_incomplete: "The upload ended before the whole file arrived.",
      storage_unavailable: "Upload storage is not usable.",
    }[code]);
    this.name = "UploadStoreError";
    this.detail = detail;
  }

  /** Operator-facing only; never sent to a client. */
  readonly detail: string | undefined;
}

export interface UploadStoreOptions {
  /** A directory this application owns exclusively. */
  root: string;
  maxBytes?: number;
  /**
   * How many stored uploads may exist at once. Reaching it refuses a new
   * upload; it never deletes an existing one to make room, because those
   * bytes may still be required.
   */
  capacity?: number;
}

export interface ReceivedUpload {
  storageKey: string;
  byteSize: number;
  sha256: string;
}

export interface UploadStore {
  /** Creates and verifies the private directories. Safe to call repeatedly. */
  initialize(): Promise<void>;
  receive(source: AsyncIterable<Uint8Array>): Promise<ReceivedUpload>;
  read(storageKey: string): Promise<Readable>;
  /** Removes an object. Missing bytes are not an error: deletion is idempotent. */
  remove(storageKey: string): Promise<void>;
  /** Keys currently on disk, for reconciling against the database. */
  listStoredKeys(): Promise<string[]>;
  /** Removes abandoned staging files. Returns how many it deleted. */
  cleanStaging(olderThanMs: number, now: number): Promise<number>;
  capacity(): number;
}

export function createUploadStore(options: UploadStoreOptions): UploadStore {
  const root = path.resolve(options.root);
  const objectsDir = path.join(root, OBJECTS);
  const stagingDir = path.join(root, STAGING);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const capacity = options.capacity ?? 8;
  let receiving = 0;
  let receiptRevision = 0;

  /** A key only ever names one file directly inside the objects directory. */
  const objectPath = (storageKey: string): string => {
    if (!STORAGE_KEY.test(storageKey)) {
      throw new UploadStoreError("storage_unavailable", "storage key is not a valid key");
    }
    return path.join(objectsDir, storageKey);
  };

  async function privateDirectory(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: DIRECTORY_MODE });
    let handle: FileHandle | undefined;
    try {
      handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.chmod(DIRECTORY_MODE);
      const info = await handle.stat();
      if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
        throw new UploadStoreError("storage_unavailable");
      }
    } catch (error) {
      throw error instanceof UploadStoreError
        ? error
        : new UploadStoreError("storage_unavailable", (error as Error).message);
    } finally {
      await handle?.close();
    }
  }

  async function initialize(): Promise<void> {
    await privateDirectory(root);
    await privateDirectory(objectsDir);
    await privateDirectory(stagingDir);
  }

  async function storedCount(): Promise<number> {
    const names = await readdir(objectsDir);
    return names.filter(name => STORAGE_KEY.test(name)).length;
  }

  /**
   * One filesystem step. Its failure is the store's fault, not the sender's,
   * so it is reported as `storage_unavailable` rather than being folded into
   * `upload_incomplete`, which would tell the owner their connection dropped
   * when the disk was full or unreadable.
   *
   * The operator detail carries the errno and syscall and nothing else. A
   * Node filesystem error puts the whole path in its `message`, so `message`
   * is deliberately not used here.
   */
  async function storageStep<T>(operation: string, step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      if (error instanceof UploadStoreError) throw error;
      const fault = error as NodeJS.ErrnoException;
      const syscall = fault.syscall === undefined ? "" : ` (${fault.syscall})`;
      throw new UploadStoreError("storage_unavailable",
        `${operation} failed: ${fault.code ?? fault.name ?? "unknown"}${syscall}`);
    }
  }

  async function receive(source: AsyncIterable<Uint8Array>): Promise<ReceivedUpload> {
    // Reserve admission before the first await, including the on-disk capacity check.
    if (receiving >= capacity) throw new UploadStoreError("storage_capacity_exhausted");
    receiving += 1;
    receiptRevision += 1;
    try {
      return await receiveReserved(source);
    } finally {
      receiving -= 1;
      receiptRevision += 1;
    }
  }

  async function receiveReserved(source: AsyncIterable<Uint8Array>): Promise<ReceivedUpload> {
    let count: number;
    let revision: number;
    // A receipt finishing during readdir moves a reservation onto disk; retry
    // rather than combining the old disk snapshot with the new reservation count.
    do {
      revision = receiptRevision;
      count = await storedCount();
    } while (revision !== receiptRevision);
    if (count + receiving > capacity) {
      throw new UploadStoreError("storage_capacity_exhausted", `capacity ${String(capacity)} reached`);
    }
    const storageKey = randomBytes(16).toString("hex");
    // Staging carries the same key, so an abandoned file is traceable to the
    // attempt that left it rather than being an anonymous orphan.
    const stagingPath = path.join(stagingDir, `${storageKey}.part`);
    const hash = createHash("sha256");
    let byteSize = 0;
    let handle: FileHandle | undefined;
    try {
      // O_EXCL: never write through an existing name. O_NOFOLLOW: never write
      // through a symbolic link planted at that name.
      handle = await storageStep("open staging", () => open(
        stagingPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        FILE_MODE,
      ));
      for await (const chunk of source) {
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes) throw new UploadStoreError("upload_too_large");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await storageStep("write", () => handle!.write(chunk.subarray(offset)));
          if (bytesWritten <= 0) throw new UploadStoreError("storage_unavailable", "write made no progress");
          offset += bytesWritten;
        }
      }
      // The bytes must survive a power loss before anything calls this upload
      // available, so they are flushed before the rename that publishes them.
      await storageStep("sync", () => handle!.sync());
      await storageStep("close", () => handle!.close());
      handle = undefined;
      await storageStep("publish", () => rename(stagingPath, objectPath(storageKey)));
      await storageStep("sync directory", () => syncDirectory(objectsDir));
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(stagingPath).catch(() => undefined);
      // Everything the store itself does is wrapped above, so an unclassified
      // error here came from reading the sender's stream: the connection
      // ended, or the client aborted. That, and only that, is incomplete.
      throw error instanceof UploadStoreError
        ? error
        : new UploadStoreError("upload_incomplete", (error as Error).message);
    }
    return { storageKey, byteSize, sha256: hash.digest("hex") };
  }

  async function read(storageKey: string): Promise<Readable> {
    const target = objectPath(storageKey);
    let handle: FileHandle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new UploadStoreError("storage_unavailable", (error as Error).message);
    }
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw new UploadStoreError("storage_unavailable", "stored upload is not a regular file");
    }
    return handle.createReadStream({ autoClose: true });
  }

  async function remove(storageKey: string): Promise<void> {
    try {
      await unlink(objectPath(storageKey));
    } catch (error) {
      // Already gone is the desired state, so retrying a deletion is safe.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    await syncDirectory(objectsDir);
  }

  async function listStoredKeys(): Promise<string[]> {
    const names = await readdir(objectsDir);
    return names.filter(name => STORAGE_KEY.test(name)).sort();
  }

  async function cleanStaging(olderThanMs: number, now: number): Promise<number> {
    let removed = 0;
    for (const name of await readdir(stagingDir)) {
      // Only names this store writes are ever removed.
      if (!/^[0-9a-f]{32}\.part$/.test(name)) continue;
      const target = path.join(stagingDir, name);
      const info = await lstat(target).catch(() => undefined);
      if (info === undefined || !info.isFile()) continue;
      if (now - info.mtimeMs < olderThanMs) continue;
      await unlink(target).catch(() => undefined);
      removed += 1;
    }
    if (removed > 0) await syncDirectory(stagingDir);
    return removed;
  }

  return { initialize, receive, read, remove, listStoredKeys, cleanStaging, capacity: () => capacity };
}

/**
 * A rename is only durable once the directory entry itself is flushed;
 * without this the file can survive a crash while the name pointing at it
 * does not.
 */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    // Some filesystems refuse to fsync a directory. The rename is still
    // ordered; there is nothing further this code can do about durability.
    if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Turns whatever the browser sent into something safe to show back. The result
 * is a display label only and is never used to open anything: separators,
 * directory references, control characters and leading dots are removed rather
 * than escaped.
 */
export function sanitizeDisplayFilename(supplied: unknown): string {
  const fallback = "upload.csv";
  if (typeof supplied !== "string") return fallback;
  // Take the last segment first, so "../../etc/passwd" cannot survive as a path.
  const base = supplied.split(/[/\\]/).pop() ?? "";
  const cleaned = [...base]
    // eslint-disable-next-line no-control-regex
    .filter(character => !/[\u0000-\u001f\u007f]/.test(character))
    .join("")
    .replace(/^[.\s]+/, "")
    .trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  return [...cleaned].slice(0, 255).join("");
}

/** True for the exact shape this store generates; useful to callers validating input. */
export function isStorageKey(value: unknown): value is string {
  return typeof value === "string" && STORAGE_KEY.test(value);
}

export async function isPrivateDirectory(dir: string): Promise<boolean> {
  const info = await stat(dir).catch(() => undefined);
  return info !== undefined && info.isDirectory() && (info.mode & 0o077) === 0;
}
