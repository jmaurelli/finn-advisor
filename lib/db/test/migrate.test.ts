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

function tableNames(db: TemporaryLedger["db"]): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

describe("migration runner", () => {
  it("applies the foundation migration and records it", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;

    const result = migrate(db);

    expect(result.appliedNow).toEqual(["0001_foundation.sql"]);
    expect(result.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(tableNames(db)).toEqual([
      "ledger_metadata",
      "login_throttles",
      "owner_credentials",
      "preferences",
      "schema_migrations",
      "sessions",
    ]);
    const applied = appliedMigrations(db);
    expect(applied).toHaveLength(1);
    expect(applied[0].checksum).toHaveLength(64);
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

    // Renumber: the applied file becomes 0002 and a new 0001 appears first.
    cpSync(join(dir, "0001_foundation.sql"), join(dir, "0002_foundation.sql"));
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
      join(dir, "0002_future.sql"),
      "CREATE TABLE later (a INTEGER) STRICT;\nUPDATE ledger_metadata SET schema_version = 2;\n",
    );
    migrate(ledger.db, dir);

    rmSync(join(dir, "0002_future.sql"));
    expect(() => migrate(ledger!.db, dir)).toThrow(/older than the data/);
  });

  it("leaves no partial schema when a migration fails", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(
      join(dir, "0002_broken.sql"),
      [
        "CREATE TABLE half_created (a INTEGER NOT NULL) STRICT;",
        "INSERT INTO half_created (a) VALUES (1);",
        "SELECT this_function_does_not_exist();",
      ].join("\n"),
    );

    expect(() => migrate(ledger!.db, dir)).toThrow(MigrationError);
    expect(tableNames(ledger.db)).not.toContain("half_created");
    expect(schemaVersion(ledger.db)).toBe(1);
  });

  it("blocks a table rebuild that would leave a dangling reference", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(
      join(dir, "0002_parents.sql"),
      [
        "CREATE TABLE parents (id TEXT PRIMARY KEY) STRICT;",
        "CREATE TABLE children (",
        "  id TEXT PRIMARY KEY,",
        "  parent_id TEXT NOT NULL REFERENCES parents (id)",
        ") STRICT;",
        "INSERT INTO parents (id) VALUES ('p1');",
        "INSERT INTO children (id, parent_id) VALUES ('c1', 'p1');",
        "UPDATE ledger_metadata SET schema_version = 2;",
      ].join("\n"),
    );
    migrate(ledger.db, dir);

    // A rebuild that drops the referenced row: legal while foreign keys are
    // off, caught by the foreign_key_check before the commit.
    writeFileSync(
      join(dir, "0003_bad_rebuild.sql"),
      [
        "CREATE TABLE parents_new (id TEXT PRIMARY KEY) STRICT;",
        "INSERT INTO parents_new (id) SELECT id FROM parents WHERE id <> 'p1';",
        "DROP TABLE parents;",
        "ALTER TABLE parents_new RENAME TO parents;",
        "UPDATE ledger_metadata SET schema_version = 3;",
      ].join("\n"),
    );

    expect(() => migrate(ledger!.db, dir)).toThrow(/foreign key violations/);
    expect(schemaVersion(ledger.db)).toBe(2);
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
      join(dir, "0002_parents.sql"),
      [
        "CREATE TABLE parents (id TEXT PRIMARY KEY, label TEXT NOT NULL) STRICT;",
        "CREATE TABLE children (",
        "  id TEXT PRIMARY KEY,",
        "  parent_id TEXT NOT NULL REFERENCES parents (id)",
        ") STRICT;",
        "INSERT INTO parents (id, label) VALUES ('p1', 'first');",
        "INSERT INTO children (id, parent_id) VALUES ('c1', 'p1');",
        "UPDATE ledger_metadata SET schema_version = 2;",
      ].join("\n"),
    );
    // Tighten a CHECK constraint, which SQLite can only do by rebuilding.
    writeFileSync(
      join(dir, "0003_rebuild.sql"),
      [
        "CREATE TABLE parents_new (",
        "  id TEXT PRIMARY KEY,",
        "  label TEXT NOT NULL CHECK (trim(label) <> '')",
        ") STRICT;",
        "INSERT INTO parents_new (id, label) SELECT id, label FROM parents;",
        "DROP TABLE parents;",
        "ALTER TABLE parents_new RENAME TO parents;",
        "UPDATE ledger_metadata SET schema_version = 3;",
      ].join("\n"),
    );

    expect(migrate(ledger.db, dir).schemaVersion).toBe(3);
    expect(() =>
      ledger!.db.prepare("INSERT INTO parents (id, label) VALUES ('p2', '  ')").run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("refuses a migration that does not record its schema version", () => {
    const dir = scratchMigrations();
    ledger = createTemporaryLedger({ migrated: false });
    writeFileSync(join(dir, "0002_forgetful.sql"), "CREATE TABLE t (a INTEGER) STRICT;\n");

    expect(() => migrate(ledger!.db, dir)).toThrow(/schema_version/);
    expect(tableNames(ledger.db)).not.toContain("t");
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
