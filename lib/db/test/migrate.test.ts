import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MigrationError } from "../src/errors.js";
import {
  appliedMigrations,
  EXPECTED_SCHEMA_VERSION,
  loadMigrations,
  migrate,
  MIGRATIONS_DIR,
  schemaVersion,
} from "../src/migrate.js";
import { closeLedger, openLedger } from "../src/open.js";
import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";

const disposables: (() => void)[] = [];
let ledger: TemporaryLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
  while (disposables.length > 0) disposables.pop()?.();
});

function scratchMigrations(): string {
  const dir = mkdtempSync(join(tmpdir(), "money-desk-migrations-"));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  disposables.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The next free migration numbers. Synthetic migrations in these tests used to
 * hard-code 0002; that silently became a duplicate the moment a real 0002
 * shipped, so the slot is computed from what is actually on disk.
 */
const SHIPPED = loadMigrations().length;
const SLOT_1 = String(SHIPPED + 1).padStart(4, "0");
const SLOT_2 = String(SHIPPED + 2).padStart(4, "0");
const VERSION_1 = SHIPPED + 1;
const VERSION_2 = SHIPPED + 2;

/** Every object definition in the database, in a stable order. */
function schemaText(db: TemporaryLedger["db"]): string[] {
  const rows = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as { type: string; name: string; sql: string | null }[];
  return rows.map((row) => `${row.type} ${row.name}: ${row.sql ?? ""}`);
}

function tableNames(db: TemporaryLedger["db"]): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migration runner", () => {
  it("applies every shipped migration and records each one", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;

    const result = migrate(db);

    expect(result.appliedNow).toEqual(["0001_foundation.sql", "0002_accounts.sql"]);
    expect(result.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(tableNames(db)).toEqual([
      "accounts",
      "audit_events",
      "categories",
      "checkpoint_checks",
      "ledger_metadata",
      "login_throttles",
      "owner_credentials",
      "preferences",
      "reconciliation_checkpoints",
      "schema_migrations",
      "sessions",
      "transactions",
    ]);
    const applied = appliedMigrations(db);
    expect(applied).toHaveLength(SHIPPED);
    for (const record of applied) expect(record.checksum).toHaveLength(64);
  });

  it("reaches the same schema whether applied all at once or one stage at a time", () => {
    // Stage 2 must land correctly on a database that already carries stage 1,
    // not only on a fresh one.
    const dir = scratchMigrations();
    const only0001 = scratchMigrations();
    rmSync(join(only0001, "0002_accounts.sql"));

    ledger = createTemporaryLedger({ migrated: false });
    migrate(ledger.db, only0001);
    migrate(ledger.db, dir);
    const incremental = schemaText(ledger.db);

    const fresh = createTemporaryLedger();
    try {
      expect(incremental).toEqual(schemaText(fresh.db));
    } finally {
      fresh.close();
    }
  });

  it("is a no-op the second time", () => {
    ledger = createTemporaryLedger();
    expect(migrate(ledger.db).appliedNow).toEqual([]);
  });

  it("creates every foundation table as STRICT", () => {
    ledger = createTemporaryLedger();
    const rows = ledger.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string; sql: string }[];
    for (const row of rows) {
      expect(row.sql.toUpperCase(), `${row.name} should be STRICT`).toMatch(/STRICT\s*$/);
    }
  });

  it("refuses a migration that changed after it was applied", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    migrate(ledger.db, dir);

    const file = join(dir, "0001_foundation.sql");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n-- tampered\n`);

    expect(() => migrate(ledger!.db, dir)).toThrow(MigrationError);
    expect(() => migrate(ledger!.db, dir)).toThrow(/changed after it was applied/);
  });

  it("refuses a migration inserted before one already applied", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    migrate(ledger.db, dir);

    // Renumber: the applied file moves to a later slot and a new 0001 appears.
    cpSync(join(dir, "0001_foundation.sql"), join(dir, `${SLOT_1}_foundation.sql`));
    writeFileSync(
      join(dir, "0001_foundation.sql"),
      "CREATE TABLE sneaked_in (a INTEGER) STRICT;\n",
    );

    expect(() => migrate(ledger!.db, dir)).toThrow(/out of order|changed after/);
    expect(tableNames(ledger.db)).not.toContain("sneaked_in");
  });

  it("refuses a database whose schema is newer than this build", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(
      join(dir, `${SLOT_1}_future.sql`),
      `CREATE TABLE later (a INTEGER) STRICT;\nUPDATE ledger_metadata SET schema_version = ${String(VERSION_1)};\n`,
    );
    migrate(ledger.db, dir);

    rmSync(join(dir, `${SLOT_1}_future.sql`));
    expect(() => migrate(ledger!.db, dir)).toThrow(/older than the data/);
  });

  it("leaves no partial schema when a migration fails", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(
      join(dir, `${SLOT_1}_broken.sql`),
      [
        "CREATE TABLE half_created (a INTEGER NOT NULL) STRICT;",
        "INSERT INTO half_created (a) VALUES (1);",
        "SELECT this_function_does_not_exist();",
      ].join("\n"),
    );

    expect(() => migrate(ledger!.db, dir)).toThrow(MigrationError);
    expect(tableNames(ledger.db)).not.toContain("half_created");
    expect(schemaVersion(ledger.db)).toBe(SHIPPED);
  });

  it("blocks a table rebuild that would leave a dangling reference", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(
      join(dir, `${SLOT_1}_parents.sql`),
      [
        "CREATE TABLE parents (id TEXT PRIMARY KEY) STRICT;",
        "CREATE TABLE children (",
        "  id TEXT PRIMARY KEY,",
        "  parent_id TEXT NOT NULL REFERENCES parents (id)",
        ") STRICT;",
        "INSERT INTO parents (id) VALUES ('p1');",
        "INSERT INTO children (id, parent_id) VALUES ('c1', 'p1');",
        `UPDATE ledger_metadata SET schema_version = ${String(VERSION_1)};`,
      ].join("\n"),
    );
    migrate(ledger.db, dir);

    // A rebuild that drops the referenced row: legal while foreign keys are
    // off, caught by the foreign_key_check before the commit.
    writeFileSync(
      join(dir, `${SLOT_2}_bad_rebuild.sql`),
      [
        "CREATE TABLE parents_new (id TEXT PRIMARY KEY) STRICT;",
        "INSERT INTO parents_new (id) SELECT id FROM parents WHERE id <> 'p1';",
        "DROP TABLE parents;",
        "ALTER TABLE parents_new RENAME TO parents;",
        `UPDATE ledger_metadata SET schema_version = ${String(VERSION_2)};`,
      ].join("\n"),
    );

    expect(() => migrate(ledger!.db, dir)).toThrow(/foreign key violations/);
    expect(schemaVersion(ledger.db)).toBe(VERSION_1);
    const children = ledger.db.prepare("SELECT COUNT(*) AS n FROM children").get() as {
      n: bigint;
    };
    expect(children.n).toBe(1n);
    expect(ledger.db.pragma("foreign_keys", { simple: true })).toBe(1n);
  });

  it("accepts a correct table rebuild with foreign keys intact", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(
      join(dir, `${SLOT_1}_parents.sql`),
      [
        "CREATE TABLE parents (id TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;",
        "CREATE TABLE children (",
        "  id TEXT PRIMARY KEY,",
        "  parent_id TEXT NOT NULL REFERENCES parents (id)",
        ") STRICT;",
        "INSERT INTO parents (id, label) VALUES ('p1', 'first');",
        "INSERT INTO children (id, parent_id) VALUES ('c1', 'p1');",
        `UPDATE ledger_metadata SET schema_version = ${String(VERSION_1)};`,
      ].join("\n"),
    );
    // Tighten a CHECK constraint, which SQLite can only do by rebuilding.
    writeFileSync(
      join(dir, `${SLOT_2}_rebuild.sql`),
      [
        "CREATE TABLE parents_new (",
        "  id TEXT PRIMARY KEY,",
        "  label TEXT NOT NULL CHECK (trim(label) <> '')",
        ") STRICT;",
        "INSERT INTO parents_new (id, label) SELECT id, label FROM parents;",
        "DROP TABLE parents;",
        "ALTER TABLE parents_new RENAME TO parents;",
        `UPDATE ledger_metadata SET schema_version = ${String(VERSION_2)};`,
      ].join("\n"),
    );

    expect(migrate(ledger.db, dir).schemaVersion).toBe(VERSION_2);
    expect(() =>
      ledger!.db.prepare("INSERT INTO parents (id, label) VALUES ('p2', '  ')").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("refuses a migration that does not record its schema version", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(join(dir, `${SLOT_1}_forgetful.sql`), "CREATE TABLE t (a INTEGER) STRICT;\n");

    expect(() => migrate(ledger!.db, dir)).toThrow(/schema_version/);
    expect(tableNames(ledger.db)).not.toContain("t");
  });

  /**
   * The runner turns foreign keys off around a migration. Whatever the
   * connection's integer mode, it must put them back: a connection left with
   * enforcement off would accept dangling references for the rest of its life.
   */
  it.each([true, false])("restores foreign keys with safe integers %s", (safeIntegers) => {
    ledger = createTemporaryLedger({ migrated: false });
    ledger.db.defaultSafeIntegers(safeIntegers);

    migrate(ledger.db);

    expect(Number(ledger.db.pragma("foreign_keys", { simple: true }))).toBe(1);
    ledger.db.defaultSafeIntegers(true);
  });

  it("restores foreign keys even when the migration fails", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(join(dir, `${SLOT_1}_broken.sql`), "SELECT this_does_not_exist();");

    expect(() => migrate(ledger!.db, dir)).toThrow(MigrationError);
    expect(Number(ledger.db.pragma("foreign_keys", { simple: true }))).toBe(1);
  });

  it("rejects a badly named migration file", () => {
    const dir = scratchMigrations();
    writeFileSync(join(dir, "not-a-migration.sql"), "SELECT 1;");
    expect(() => loadMigrations(dir)).toThrow(/does not match/);
  });

  it("survives a close and reopen", () => {
    // Not createTemporaryLedger: its cleanup deletes the directory, and this
    // test needs the same files back after the close.
    const dataDir = mkdtempSync(join(tmpdir(), "money-desk-reopen-"));
    const first = openLedger({ dataDir });
    migrate(first);
    first.prepare("UPDATE preferences SET density = 'compact' WHERE id = 1").run();
    closeLedger(first);

    const again = openLedger({ dataDir });
    try {
      expect(schemaVersion(again)).toBe(EXPECTED_SCHEMA_VERSION);
      const row = again.prepare("SELECT density FROM preferences WHERE id = 1").get() as {
        density: string;
      };
      expect(row.density).toBe("compact");
      expect(migrate(again).appliedNow).toEqual([]);
    } finally {
      closeLedger(again);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
