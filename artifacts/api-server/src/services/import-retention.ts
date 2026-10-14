import { withWriteTransaction } from "@workspace/db";
import type { AppDependencies } from "../deps.js";
import { formatCounter, nextCounter, versionMismatch } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import { logger } from "../lib/logger.js";
import { financeRevision, writeAudit } from "./ledger.js";
import { importBatchDto, requireBatch, type ImportBatchRow, type ImportContext } from "./imports.js";

function abandon(context: ImportContext, batch: ImportBatchRow, status: "cancelled" | "expired"): void {
  const { db, now, newId } = context;
  db.prepare("DELETE FROM import_rows WHERE import_id = ? AND posted_transaction_id IS NULL").run(batch.id);
  db.prepare("DELETE FROM import_file_claims WHERE import_id = ?").run(batch.id);
  db.prepare(`UPDATE uploads SET state = 'deletion_pending', updated_at = ?
    WHERE import_id = ? AND state = 'available'`).run(now, batch.id);
  db.prepare(`UPDATE import_batches SET status = ?, expires_at = NULL, version = ?, updated_at = ?
    WHERE id = ?`).run(status, nextCounter(batch.version), now, batch.id);
  writeAudit(db, newId, now, { entityType: "import", entityId: batch.id, accountId: batch.account_id,
    eventType: `import_${status}`, origin: status === "expired" ? "system" : "owner",
    before: { status: batch.status }, after: { status } });
}

export function discardImport<T>(
  context: ImportContext, id: string, expected: bigint, check: (body: unknown) => T,
): { body: T; version: bigint } {
  const batch = requireBatch(context.db, id);
  if (!["receiving", "parsing", "preview"].includes(batch.status)
    || (batch.expires_at !== null && batch.expires_at <= BigInt(context.now))) {
    throw problem({ status: 409, code: "import_not_open", title: "Import is not open",
      detail: "This import is no longer available to discard." });
  }
  if (batch.version !== expected) throw versionMismatch(batch.version);
  abandon(context, batch, "cancelled");
  const updated = requireBatch(context.db, id);
  return { version: updated.version, body: check({ import: importBatchDto(context.db, updated),
    financeRevision: formatCounter(financeRevision(context.db)) }) };
}

/** Persist intent before touching bytes, so either side of a crash is retryable. */
export function prepareImportCleanup(context: ImportContext): void {
  const { db, now } = context;
  withWriteTransaction(db, () => {
    const overdue = db.prepare(`SELECT * FROM import_batches
      WHERE status IN ('receiving', 'parsing', 'preview') AND expires_at <= ?`).all(now) as ImportBatchRow[];
    for (const batch of overdue) abandon(context, batch, "expired");
    const retained = db.prepare(`SELECT u.storage_key, b.id, b.account_id FROM uploads u
      JOIN import_batches b ON b.id = u.import_id
      WHERE u.state = 'available' AND b.status = 'committed' AND u.retention_deadline <= ?`)
      .all(now) as { storage_key: string; id: string; account_id: string }[];
    for (const upload of retained) {
      db.prepare("UPDATE uploads SET state = 'deletion_pending', updated_at = ? WHERE storage_key = ?")
        .run(now, upload.storage_key);
      writeAudit(db, context.newId, now, { entityType: "import", entityId: upload.id,
        accountId: upload.account_id, eventType: "import_upload_cleanup", origin: "system",
        after: { state: "deletion_pending" } });
    }
  });
}

export async function deletePendingImportUploads(deps: AppDependencies): Promise<number> {
  const pending = deps.db.prepare("SELECT storage_key FROM uploads WHERE state = 'deletion_pending'")
    .all() as { storage_key: string }[];
  let deleted = 0;
  for (const upload of pending) {
    try {
      // remove is idempotent, including a crash after unlink but before this update.
      await deps.uploads.remove(upload.storage_key);
      deps.db.prepare("UPDATE uploads SET state = 'deleted', updated_at = ? WHERE storage_key = ? AND state = 'deletion_pending'")
        .run(deps.clock.now(), upload.storage_key);
      deleted += 1;
    } catch {
      // Filesystem errors may include paths or source values. Log no error payload.
      logger.warn("import upload deletion will be retried");
    }
  }
  return deleted;
}

export async function cleanupImports(deps: AppDependencies): Promise<void> {
  prepareImportCleanup({ db: deps.db, now: deps.clock.now(), newId: deps.newId });
  await deletePendingImportUploads(deps);
}
