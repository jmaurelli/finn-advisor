/**
 * Picking up imports that a crash interrupted.
 *
 * An upload and its preview are written on two different media: bytes on the
 * filesystem, records in SQLite. A crash can land between them, so on startup
 * every batch that was still receiving or parsing is settled here, before the
 * socket opens and before anything financial can be read.
 *
 * The decision is made from evidence, never from optimism:
 *
 *  - bytes still on disk whose fingerprint matches what was recorded are
 *    re-read with the adapter version the batch pinned, so the second parse
 *    produces exactly what the first would have;
 *  - bytes that are missing, truncated or no longer match their fingerprint
 *    end the attempt as a declared failure rather than a half-read preview;
 *  - a batch whose rows were already published but whose status never advanced
 *    keeps its rows and becomes a preview, because publication is the atomic
 *    step that decides this.
 *
 * Recovery never posts a transaction and never touches a completed import.
 */
import { withWriteTransaction } from "@workspace/db";
import { createHash } from "node:crypto";

import type { AppDependencies } from "../deps.js";
import { logger } from "../lib/logger.js";
import { deletePendingImportUploads, prepareImportCleanup } from "./import-retention.js";
import {
  failBatch, findUpload, importFailureOf, parseStoredUpload, publishPreviewUnlessClaimed, rowCounts,
  type ImportBatchRow,
} from "./imports.js";

/** Staging files older than this were left by a process that is gone. */
export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

export interface RecoveryOutcome {
  reparsed: number;
  published: number;
  failed: number;
  /** Interrupted attempts whose file the account had already claimed elsewhere. */
  redundant: number;
  orphanBytesRemoved: number;
}

export async function recoverInterruptedImports(deps: AppDependencies): Promise<RecoveryOutcome> {
  const outcome: RecoveryOutcome = { reparsed: 0, published: 0, failed: 0, redundant: 0, orphanBytesRemoved: 0 };
  const context = () => ({ db: deps.db, now: deps.clock.now(), newId: deps.newId });
  prepareImportCleanup(context());

  const interrupted = deps.db.prepare(
    "SELECT * FROM import_batches WHERE status IN ('receiving', 'parsing') ORDER BY created_at",
  ).all() as ImportBatchRow[];

  for (const batch of interrupted) {
    try {
      // Rows already published mean the atomic publication ran; the status
      // update is all that was lost.
      if (rowCounts(deps.db, batch.id).total > 0) {
        withWriteTransaction(deps.db, () => {
          deps.db.prepare(
            "UPDATE import_batches SET status = 'preview', version = version + 1, updated_at = ? WHERE id = ?",
          ).run(deps.clock.now(), batch.id);
        });
        outcome.published += 1;
        continue;
      }

      const failure = await verifyBytes(deps, batch);
      if (failure !== undefined) {
        withWriteTransaction(deps.db, () => { failBatch(context(), batch, failure); });
        outcome.failed += 1;
        continue;
      }

      const upload = findUpload(deps.db, batch.id)!;
      const adapter = deps.adapters.get(batch.format_id);
      if (adapter === undefined || adapter.version !== Number(batch.format_version)) {
        // The pinned adapter is not the one available now, so re-reading could
        // interpret the same bytes differently. The attempt ends instead.
        withWriteTransaction(deps.db, () => {
          failBatch(context(), batch, {
            code: "unreadable_file",
            message: "This file was read by a version of the bank format that is no longer available.",
          });
        });
        outcome.failed += 1;
        continue;
      }

      const parsed = await parseStoredUpload(adapter, await deps.uploads.read(upload.storage_key));
      // Another attempt may have published these same bytes before the stop.
      const owner = withWriteTransaction(deps.db,
        () => publishPreviewUnlessClaimed(context(), batch, parsed, upload.sha256!));
      if (owner === null) outcome.reparsed += 1;
      else outcome.redundant += 1;
    } catch (error) {
      const failure = importFailureOf(error) ?? {
        code: "unreadable_file",
        message: "This file could not be read after the service restarted.",
      };
      try {
        withWriteTransaction(deps.db, () => { failBatch(context(), batch, failure); });
        outcome.failed += 1;
      } catch (nested) {
        // Recovery must not stop the service from starting; the batch stays
        // interrupted and is retried on the next start.
        logger.error({ err: nested, importId: batch.id }, "could not record an interrupted import as failed");
      }
    }
  }

  outcome.orphanBytesRemoved = await removeOrphanBytes(deps);
  // No receipt can be in flight before the socket opens, so every staging file
  // here was left by a process that is gone - including one abandoned seconds
  // ago by a shutdown that cut an upload off. Waiting out the age used by the
  // hourly sweep would leave it on disk for an hour of the next run.
  await deps.uploads.cleanStaging(0, deps.clock.now());
  return outcome;
}

/**
 * Re-reads the stored bytes and compares them with what was recorded. A
 * truncated or altered file is not parsed: the fingerprint is the only thing
 * that proves the bytes are the ones the batch was created for.
 */
async function verifyBytes(
  deps: AppDependencies,
  batch: ImportBatchRow,
): Promise<{ code: string; message: string } | undefined> {
  const upload = findUpload(deps.db, batch.id);
  if (upload === undefined || upload.sha256 === null || upload.state !== "available") {
    return { code: "upload_incomplete", message: "The upload did not finish before the service stopped." };
  }
  let stream;
  try {
    stream = await deps.uploads.read(upload.storage_key);
  } catch {
    return { code: "upload_incomplete", message: "The uploaded file is no longer available." };
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  if (size !== Number(upload.byte_size) || hash.digest("hex") !== upload.sha256) {
    return { code: "upload_incomplete", message: "The uploaded file did not survive the restart intact." };
  }
  return undefined;
}

/**
 * Deletes stored bytes no batch refers to, and finishes deletions that were
 * already intended. Only keys this store owns are considered, and a key the
 * database still points at is never touched.
 */
export async function removeOrphanBytes(deps: AppDependencies): Promise<number> {
  let removed = await deletePendingImportUploads(deps);
  const known = new Map(
    (deps.db.prepare("SELECT storage_key, state FROM uploads").all() as { storage_key: string; state: string }[])
      .map(row => [row.storage_key, row.state]),
  );
  for (const key of await deps.uploads.listStoredKeys()) {
    const state = known.get(key);
    // Unknown to the database, or already marked for deletion: either way the
    // bytes are not needed. Anything `available` or still `receiving` is left.
    if (state === undefined || state === "deleted") {
      try {
        await deps.uploads.remove(key);
        removed += 1;
      } catch {
        logger.warn("orphan upload deletion will be retried at startup");
      }
    }
  }
  return removed;
}
