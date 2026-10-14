import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "../src/migrate.js";
import { clearStatementCache, closeLedger, openLedger, STATEMENT_CACHE_LIMIT } from "../src/open.js";
import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";

let ledger: TemporaryLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

/**
 * Compiling SQL is not free, and the services prepare inside their loops: a
 * 25,000-row import commit spent most of its wall time in SQLite's parser
 * rather than on the writes. These tests pin both halves of the fix - that
 * identical SQL is compiled once, and that anything which would make a
 * compiled statement lie about the connection drops it again.
 */
describe("prepared statement cache", () => {
  it("compiles identical SQL once per connection", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;

    const first = db.prepare("SELECT id FROM ledger_metadata WHERE id = ?");
    const second = db.prepare("SELECT id FROM ledger_metadata WHERE id = ?");

    expect(second).toBe(first);
    expect(db.prepare("SELECT id FROM ledger_metadata WHERE id = 1")).not.toBe(first);
  });

  it("gives a reused statement fresh results for each set of parameters", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;
    db.exec("CREATE TABLE amounts (id INTEGER PRIMARY KEY, cents INTEGER NOT NULL) STRICT");
    const insert = "INSERT INTO amounts (id, cents) VALUES (?, ?)";
    db.prepare(insert).run(1n, 9007199254740993n);
    db.prepare(insert).run(2n, -250n);

    const read = "SELECT cents FROM amounts WHERE id = ?";
    expect(db.prepare(read).get(1n)).toEqual({ cents: 9007199254740993n });
    expect(db.prepare(read).get(2n)).toEqual({ cents: -250n });
  });

  it("keeps the cache bounded, evicting the least recently used text", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;
    db.exec("CREATE TABLE amounts (id INTEGER PRIMARY KEY, cents INTEGER NOT NULL) STRICT");

    const oldest = db.prepare("SELECT 0 AS n FROM amounts");
    const kept = db.prepare("SELECT 1 AS n FROM amounts");
    for (let i = 2; i <= STATEMENT_CACHE_LIMIT; i++) {
      db.prepare(`SELECT ${String(i)} AS n FROM amounts`);
      // Touching it on every round keeps it newest, so eviction is a choice
      // about use rather than about insertion order alone.
      db.prepare("SELECT 1 AS n FROM amounts");
    }

    expect(db.prepare("SELECT 1 AS n FROM amounts")).toBe(kept);
    expect(db.prepare("SELECT 0 AS n FROM amounts")).not.toBe(oldest);
  });

  /**
   * The sharpest invalidation: integer mode is bound into a statement when it
   * is compiled, so a cache that survived `defaultSafeIntegers` would quietly
   * hand back the doubles this whole module exists to prevent.
   */
  it("recompiles after the connection's integer mode changes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "money-desk-cache-"));
    try {
      const db = openLedger({ dataDir });
      db.exec("CREATE TABLE amounts (cents INTEGER NOT NULL) STRICT");
      db.prepare("INSERT INTO amounts VALUES (?)").run(9007199254740993n);
      const read = "SELECT cents FROM amounts";
      const compiled = db.prepare(read);
      expect((compiled.get() as { cents: unknown }).cents).toBe(9007199254740993n);

      db.defaultSafeIntegers(false);
      expect(db.prepare(read)).not.toBe(compiled);
      expect(typeof (db.prepare(read).get() as { cents: unknown }).cents).toBe("number");

      db.defaultSafeIntegers(true);
      expect((db.prepare(read).get() as { cents: unknown }).cents).toBe(9007199254740993n);
      closeLedger(db);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recompiles after a pragma that changes how statements are planned", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;
    const sql = "SELECT id FROM ledger_metadata WHERE id = ?";
    const before = db.prepare(sql);

    db.pragma("foreign_keys = OFF");
    try {
      expect(db.prepare(sql)).not.toBe(before);
    } finally {
      db.pragma("foreign_keys = ON");
    }
    // A pragma that only reads leaves the cache alone.
    const after = db.prepare(sql);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
    expect(db.prepare(sql)).toBe(after);
  });

  it("recompiles after a migration changes the schema", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;
    const sql = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
    const before = db.prepare(sql);
    expect(db.prepare(sql)).toBe(before);

    migrate(db);

    expect(db.prepare(sql)).not.toBe(before);
  });

  it("drops every statement when the cache is cleared explicitly", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;
    const sql = "SELECT id FROM ledger_metadata WHERE id = ?";
    const before = db.prepare(sql);

    clearStatementCache(db);

    expect(db.prepare(sql)).not.toBe(before);
  });
});
