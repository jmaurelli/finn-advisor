import { DatabaseBusyError, isBusy } from "./errors.js";
import type { SqliteDatabase } from "./open.js";

/**
 * Runs `fn` inside a write transaction.
 *
 * `BEGIN IMMEDIATE` takes the write lock up front, so a conflict is reported
 * before any work is done rather than at commit. The explicit ROLLBACK is not
 * decoration: SQLite leaves the transaction open after an ordinary constraint
 * error (proved in probe 06), so without it a failed statement could be
 * followed by a commit of everything that came before it.
 *
 * The callback must be synchronous. An async callback would return a promise
 * while the transaction is still open and the lock would be released at an
 * unrelated moment, so it is rejected outright.
 */
export function withWriteTransaction<T>(
  db: SqliteDatabase,
  fn: (db: SqliteDatabase) => T,
): T {
  if (db.inTransaction) {
    throw new Error("A write transaction is already open on this connection");
  }

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw isBusy(error) ? new DatabaseBusyError() : error;
  }

  let result: T;
  try {
    result = fn(db);
    if (isPromiseLike(result)) {
      // Swallow the callback's own rejection: it is already being reported as
      // a misuse, and an unhandled rejection later would be noise.
      void (result as PromiseLike<unknown>).then?.(
        () => undefined,
        () => undefined,
      );
      throw new TypeError(
        "withWriteTransaction requires a synchronous callback; it received a promise",
      );
    }
  } catch (error) {
    rollbackQuietly(db);
    throw isBusy(error) ? new DatabaseBusyError() : error;
  }

  try {
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw isBusy(error) ? new DatabaseBusyError() : error;
  }
  return result;
}

function isPromiseLike(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function rollbackQuietly(db: SqliteDatabase): void {
  if (!db.inTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // A rollback failure must not mask the original error.
  }
}
