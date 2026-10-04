import BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DatabaseSetupError, isBusy } from "./errors.js";
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
  /** Milliseconds the open-time self-test waits for the write lock. */
  openTimeoutMs?: number;
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
  // Startup waits longer for the lock than a request does: opening while the
  // migration CLI or a backup holds the write lock should wait, not fail.
  const openTimeoutMs = options.openTimeoutMs ?? 5000;

  // Checked before the directory is created, so a refused filesystem is not
  // written to at all.
  if (options.skipFilesystemCheck !== true) {
    assertLocalFilesystem(nearestExistingPath(dataDir));
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (options.skipFilesystemCheck !== true) {
    assertLocalFilesystem(dataDir);
  }

  const db = new BetterSqlite3(ledgerPath(dataDir));
  try {
    db.defaultSafeIntegers(true);
    // SQLite length(TEXT) stops at NUL; the API contract counts all code points.
    // Register before migrations or schema checks, including on reopened ledgers.
    db.function("codepoint_length", { deterministic: true }, (value: unknown) => {
      if (value === null) return null;
      if (typeof value !== "string") throw new TypeError("codepoint_length requires text");
      return [...value].length;
    });
    db.pragma("foreign_keys = ON");
    // REPLACE deletes conflicting rows; those deletes bypass history guards
    // unless recursive triggers are enabled on this connection.
    db.pragma("recursive_triggers = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma(`busy_timeout = ${openTimeoutMs}`);

    assertPragma(db, "foreign_keys", 1n);
    assertPragma(db, "recursive_triggers", 1n);
    assertPragma(db, "journal_mode", "wal");
    assertPragma(db, "synchronous", 2n);
    assertExactIntegers(db);

    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    assertPragma(db, "busy_timeout", BigInt(busyTimeoutMs));

    // Installed last, so the self-test above compiles its throwaway statements
    // against the table it drops rather than leaving them in the cache.
    installStatementCache(db);
  } catch (error) {
    db.close();
    if (isBusy(error)) {
      throw new DatabaseSetupError(
        "Another process is writing to the ledger; it could not be opened. Wait for that command to finish and try again.",
      );
    }
    throw error;
  }
  return db;
}

/**
 * How many compiled statements one connection keeps.
 *
 * Every entry holds a native `sqlite3_stmt`, so this is a memory bound as much
 * as a hit-rate one. The services prepare a few hundred distinct texts, and a
 * handful of places build SQL whose shape varies with the size of a batch;
 * those varying texts are exactly what must not accumulate, so the cache is a
 * least-recently-used one rather than an unbounded map.
 */
export const STATEMENT_CACHE_LIMIT = 512;

const statementCaches = new WeakMap<SqliteDatabase, Map<string, BetterSqlite3.Statement>>();

/**
 * Compiles each distinct SQL text once per connection.
 *
 * Preparing a statement is SQLite's parser and planner running again, and the
 * services prepare inside their loops: posting an imported row compiles a
 * dozen statements, so a large import spent most of its time in the compiler
 * rather than on the work. Reuse is safe here because nothing in this codebase
 * mutates a statement (no `pluck`, `raw`, `expand`, `safeIntegers` or
 * `iterate`) and `run`/`get`/`all` each finish before they return, so no two
 * callers can hold the same statement mid-execution.
 *
 * What a statement *does* capture is the connection as it stood when it was
 * compiled: its column list, its integer mode, its custom functions and the
 * pragmas that compile into the plan, foreign key enforcement among them.
 * Anything that changes those has to drop the cache, so the wrappers below do,
 * and `migrate` drops it after each schema change.
 */
function installStatementCache(db: SqliteDatabase): void {
  const cache = new Map<string, BetterSqlite3.Statement>();
  statementCaches.set(db, cache);
  const compile = db.prepare.bind(db) as (source: string) => BetterSqlite3.Statement;
  Object.defineProperty(db, "prepare", {
    configurable: true,
    writable: true,
    value: (source: string): BetterSqlite3.Statement => {
      const cached = cache.get(source);
      if (cached !== undefined) {
        // Re-inserting marks it as the most recently used.
        cache.delete(source);
        cache.set(source, cached);
        return cached;
      }
      const statement = compile(source);
      cache.set(source, statement);
      if (cache.size > STATEMENT_CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return statement;
    },
  });

  // `defaultSafeIntegers` is the sharpest of these: a statement compiled while
  // it was off keeps returning doubles, which is the one failure this module
  // exists to prevent. Custom functions and assigning pragmas are bound into
  // the compiled plan the same way.
  for (const name of ["defaultSafeIntegers", "function", "aggregate", "table", "loadExtension"] as const) {
    const original = (db[name] as (...args: unknown[]) => unknown).bind(db);
    Object.defineProperty(db, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        const result = original(...args);
        cache.clear();
        return result;
      },
    });
  }
  const pragma = db.pragma.bind(db);
  Object.defineProperty(db, "pragma", {
    configurable: true,
    writable: true,
    value: (source: string, options?: BetterSqlite3.PragmaOptions): unknown => {
      const result = pragma(source, options as never);
      if (source.includes("=")) cache.clear();
      return result;
    },
  });
}

/**
 * Drops every compiled statement on this connection.
 *
 * Called after the schema changes, because a statement compiled against the
 * old schema still describes the old columns.
 */
export function clearStatementCache(db: SqliteDatabase): void {
  statementCaches.get(db)?.clear();
}

/** The closest ancestor that exists, so the filesystem check has something real to resolve. */
function nearestExistingPath(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
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
export function assertExactIntegers(db: SqliteDatabase): void {
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
    clearStatementCache(db);
  }
}
