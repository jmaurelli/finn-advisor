import BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { DatabaseSetupError } from "./errors.js";
import { assertLocalFilesystem } from "./filesystem.js";

export type SqliteDatabase = BetterSqlite3.Database;

export const LEDGER_FILE_NAME = "money-desk.sqlite3";

/** A value larger than Number.MAX_SAFE_INTEGER, used by the round-trip self-test. */
const BEYOND_DOUBLE = 9007199254740993n;

export interface OpenLedgerOptions {
  /** Directory holding the ledger file. Created if missing. */
  dataDir: string;
  /** Milliseconds a statement waits for the write lock before reporting busy. */
  busyTimeoutMs?: number;
  /** Skip the mountinfo check. Only for unit tests of the check itself. */
  skipFilesystemCheck?: boolean;
}

export function ledgerPath(dataDir: string): string {
  return join(resolve(dataDir), LEDGER_FILE_NAME);
}

/**
 * Opens the single writer connection.
 *
 * Everything that must be true for money to be stored exactly is asserted
 * here, at open time: safe integers, foreign keys, WAL, durable commits, and
 * a real round trip of an integer that a double cannot represent. A process
 * that cannot prove those properties refuses to serve rather than quietly
 * corrupting amounts.
 */
export function openLedger(options: OpenLedgerOptions): SqliteDatabase {
  const dataDir = resolve(options.dataDir);
  const busyTimeoutMs = options.busyTimeoutMs ?? 250;

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (options.skipFilesystemCheck !== true) {
    assertLocalFilesystem(dataDir);
  }

  const db = new BetterSqlite3(ledgerPath(dataDir));
  try {
    db.defaultSafeIntegers(true);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);

    assertPragma(db, "foreign_keys", 1n);
    assertPragma(db, "journal_mode", "wal");
    assertPragma(db, "synchronous", 2n);
    assertPragma(db, "busy_timeout", BigInt(busyTimeoutMs));
    assertExactIntegers(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function assertPragma(
  db: SqliteDatabase,
  name: string,
  expected: bigint | string,
): void {
  const actual = db.pragma(name, { simple: true });
  const normalized = typeof actual === "string" ? actual.toLowerCase() : actual;
  if (normalized !== expected) {
    throw new DatabaseSetupError(
      `SQLite ${name} is ${String(actual)}, expected ${String(expected)}`,
    );
  }
}

/**
 * Writes and reads back an integer beyond double precision. If safe-integer
 * mode is ever switched off this returns 9007199254740992 and startup fails,
 * which is the point: a silent one-cent class of error becomes a loud one.
 */
function assertExactIntegers(db: SqliteDatabase): void {
  // A real table in the main database, not a TEMP one: creating any temp table
  // holds a lock that blocks a truncating WAL checkpoint for the life of the
  // connection, which would leave a stray -wal file behind on shutdown.
  db.exec("CREATE TABLE IF NOT EXISTS startup_self_test (v INTEGER NOT NULL) STRICT");
  try {
    db.prepare("DELETE FROM startup_self_test").run();
    db.prepare("INSERT INTO startup_self_test (v) VALUES (?)").run(BEYOND_DOUBLE);
    const row = db
      .prepare("SELECT v FROM startup_self_test")
      .get() as { v: unknown } | undefined;
    const value = row?.v;
    if (typeof value !== "bigint" || value !== BEYOND_DOUBLE) {
      throw new DatabaseSetupError(
        `Integer round trip returned ${typeof value} ${String(value)}; exact integers are not available`,
      );
    }
  } finally {
    db.exec("DROP TABLE IF EXISTS startup_self_test");
  }
}

/**
 * Closes the connection, checkpointing the WAL so a stopped service leaves a
 * single self-contained file for the backup job to copy.
 */
export function closeLedger(db: SqliteDatabase): void {
  if (!db.open) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}
