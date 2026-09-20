import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MigrationError } from "./errors.js";
import type { SqliteDatabase } from "./open.js";

/**
 * The schema this build of the application expects. Readiness compares it with
 * what is actually applied; a mismatch is reported instead of guessed at.
 */
export const EXPECTED_SCHEMA_VERSION = 2;

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export interface Migration {
  id: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  id: number;
  name: string;
  checksum: string;
  appliedAt: number;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".sql")) continue;
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (match === null) {
      throw new MigrationError(
        `Migration file name "${name}" does not match NNNN_lower_snake_case.sql`,
      );
    }
    const sql = readFileSync(join(dir, name), "utf8");
    migrations.push({
      id: Number(match[1]),
      name,
      sql,
      checksum: createHash("sha256").update(sql, "utf8").digest("hex"),
    });
  }

  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) {
      throw new MigrationError(
        `Migration numbering has a gap or duplicate at "${migration.name}"; expected ${String(index + 1)}`,
      );
    }
  });
  return migrations;
}

function ensureLedgerTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INTEGER PRIMARY KEY CHECK (id >= 1),
      name       TEXT    NOT NULL,
      checksum   TEXT    NOT NULL CHECK (length(checksum) = 64),
      applied_at INTEGER NOT NULL CHECK (applied_at > 0)
    ) STRICT
  `);
}

export function appliedMigrations(db: SqliteDatabase): AppliedMigration[] {
  ensureLedgerTable(db);
  const rows = db
    .prepare(
      "SELECT id, name, checksum, applied_at FROM schema_migrations ORDER BY id",
    )
    .all() as { id: bigint; name: string; checksum: string; applied_at: bigint }[];
  return rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    checksum: row.checksum,
    appliedAt: Number(row.applied_at),
  }));
}

export function schemaVersion(db: SqliteDatabase): number {
  const applied = appliedMigrations(db);
  return applied.length === 0 ? 0 : applied[applied.length - 1].id;
}

/**
 * Refuses to continue unless what is recorded in the database is exactly the
 * prefix of what is on disk: same ids, same names, same bytes. A migration
 * edited after it ran, one that disappeared, or one inserted before an already
 * applied migration all mean the schema is not what the code believes.
 */
function reconcile(
  migrations: Migration[],
  applied: AppliedMigration[],
): Migration[] {
  if (applied.length > migrations.length) {
    throw new MigrationError(
      `The database has ${String(applied.length)} migrations applied but only ${String(migrations.length)} are present; this build is older than the data`,
    );
  }
  applied.forEach((record, index) => {
    const migration = migrations[index];
    if (migration.id !== record.id || migration.name !== record.name) {
      throw new MigrationError(
        `Applied migration ${String(record.id)} "${record.name}" does not match "${migration.name}" on disk; migrations are out of order`,
      );
    }
    if (migration.checksum !== record.checksum) {
      throw new MigrationError(
        `Migration "${record.name}" changed after it was applied; refusing to run`,
      );
    }
  });
  return migrations.slice(applied.length);
}

export interface MigrateResult {
  appliedNow: string[];
  schemaVersion: number;
}

/**
 * Applies pending migrations, one transaction each.
 *
 * Foreign-key enforcement is turned off *outside* the transaction, because
 * `PRAGMA foreign_keys` is a no-op inside one, and SQLite's table-rebuild
 * procedure needs it off. `PRAGMA foreign_key_check` then runs before the
 * commit, so a rebuild that would leave a dangling reference fails instead of
 * committing broken relationships.
 *
 * Only the CLI calls this. The API never migrates at startup.
 */
export function migrate(
  db: SqliteDatabase,
  dir: string = MIGRATIONS_DIR,
): MigrateResult {
  const migrations = loadMigrations(dir);
  const pending = reconcile(migrations, appliedMigrations(db));
  const appliedNow: string[] = [];

  for (const migration of pending) {
    // Number(), not a bigint literal: safe-integer mode decides whether this
    // pragma reads back as 1n or 1, and comparing against the wrong one would
    // silently restore foreign keys to OFF on a live connection.
    const foreignKeysWereOn = Number(db.pragma("foreign_keys", { simple: true })) === 1;
    db.pragma("foreign_keys = OFF");
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migration.sql);

        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new MigrationError(
            `Migration "${migration.name}" leaves ${String(violations.length)} foreign key violations`,
          );
        }

        db.prepare(
          "INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
        ).run(migration.id, migration.name, migration.checksum, Date.now());

        assertRecordedVersion(db, migration);
        db.exec("COMMIT");
      } catch (error) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw error instanceof MigrationError
          ? error
          : new MigrationError(
              `Migration "${migration.name}" failed: ${(error as Error).message}`,
            );
      }
    } catch (error) {
      // Restore quietly on the failure path: a problem restoring the pragma
      // must not hide why the migration failed.
      try {
        restoreForeignKeys(db, foreignKeysWereOn);
      } catch {
        // reported by the throw below
      }
      throw error;
    }
    restoreForeignKeys(db, foreignKeysWereOn);
    appliedNow.push(migration.name);
  }

  return { appliedNow, schemaVersion: schemaVersion(db) };
}

/**
 * Puts enforcement back as it was, and proves it: silently leaving foreign
 * keys off on a live connection would disable the protection the rest of the
 * schema depends on.
 */
function restoreForeignKeys(db: SqliteDatabase, wasOn: boolean): void {
  db.pragma(`foreign_keys = ${wasOn ? "ON" : "OFF"}`);
  const now = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  if (now !== wasOn) {
    throw new MigrationError(
      "Foreign key enforcement could not be restored after the migration",
    );
  }
}

/**
 * Each migration is responsible for recording its own schema version in the
 * ledger metadata, so the two records cannot drift apart unnoticed.
 */
function assertRecordedVersion(db: SqliteDatabase, migration: Migration): void {
  const row = db
    .prepare("SELECT schema_version FROM ledger_metadata WHERE id = 1")
    .get() as { schema_version: bigint } | undefined;
  if (row === undefined || Number(row.schema_version) !== migration.id) {
    throw new MigrationError(
      `Migration "${migration.name}" did not set ledger_metadata.schema_version to ${String(migration.id)}`,
    );
  }
}
