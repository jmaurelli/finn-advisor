import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appliedMigrations, loadMigrations, migrate, schemaVersion } from "../src/migrate.js";
import { closeLedger, openLedger } from "../src/open.js";
import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";
import { withWriteTransaction } from "../src/transaction.js";

const CATEGORY = "10000000-0000-4000-8000-000000000030";
const PREVIEW = "10000000-0000-4000-8000-000000000040";
const NOW = 1770000000000;
let ledger: TemporaryLedger | undefined;
const scratch: string[] = [];
afterEach(() => {
  ledger?.close(); ledger = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function migrationDir(count = 4, fail = false) {
  const dir = mkdtempSync(join(tmpdir(), "money-desk-budget-migrations-"));
  scratch.push(dir);
  for (const m of loadMigrations().slice(0, count)) {
    writeFileSync(join(dir, m.name), m.sql + (fail && m.id === 4 ? "\nSELECT nonexistent_function();" : ""));
  }
  return dir;
}
function open(stage3 = false) {
  ledger = createTemporaryLedger({ migrated: !stage3 });
  if (stage3) migrate(ledger.db, migrationDir(3));
  ledger.db.prepare(`INSERT INTO categories (id, display_name, normalized_name, color, protected, version, created_at, updated_at)
    VALUES (?, 'Food', 'food', '#112233', 0, 1, ?, ?)`).run(CATEGORY, NOW, NOW);
  return ledger.db;
}
function plan(db: TemporaryLedger["db"]) {
  db.prepare("INSERT INTO budget_plans VALUES (?, 1, ?, ?)").run(CATEGORY, NOW, NOW);
}
function preview(db: TemporaryLedger["db"]) {
  db.prepare(`INSERT INTO budget_previews (id, category_id, preview_json, dependencies_json, created_at, expires_at)
    VALUES (?, ?, '{"request":"reviewed"}', '{"version":null}', ?, ?)`).run(PREVIEW, CATEGORY, NOW, NOW + 86400000);
}

describe("budget schema upgrade", () => {
  function populate(db: TemporaryLedger["db"]) {
    db.prepare(`INSERT INTO accounts (id, kind, provider_key, display_name, tracking_start_date,
      opening_cents, creation_digest, version, ledger_revision, created_at, updated_at)
      VALUES (?, 'checking', 'other', 'Synthetic', '2026-01-01', 900, ?, 1, 3, ?, ?)`)
      .run(PREVIEW, "a".repeat(64), NOW, NOW);
    db.prepare(`INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text, amount_cents,
      kind, category_id, assignment_origin, assigned_at, lifecycle, original_posted_date, original_amount_cents,
      version, created_at, updated_at) VALUES (?, ?, '2026-01-02', 'Synthetic', 'synthetic', -123,
      'purchase', ?, 'manual', ?, 'active', '2026-01-02', -123, 1, ?, ?)`)
      .run(CATEGORY, PREVIEW, CATEGORY, NOW, NOW, NOW);
    db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, event_type, origin, after_json, occurred_at)
      VALUES (?, 'transaction', ?, 'transaction_created', 'owner', '{"synthetic":true}', ?)`).run(PREVIEW, CATEGORY, NOW);
  }
  it("upgrades populated Stage 3 without changing ledger, audit or original migration checksums", () => {
    const db = open(true); populate(db);
    const tables = ["accounts", "categories", "transactions", "audit_events"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const migrations = appliedMigrations(db);
    const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    expect(migrate(db).appliedNow).toEqual(["0004_budgets.sql"]);
    expect(schemaVersion(db)).toBe(4);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(before);
    expect(appliedMigrations(db).slice(0, 3)).toEqual(migrations);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()).toEqual(expect.arrayContaining(triggers));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => db.exec("DELETE FROM audit_events")).toThrow(/cannot be removed/);
    expect(() => db.exec("UPDATE audit_events SET event_type = 'changed'")).toThrow(/cannot be changed/);
    expect(() => db.exec("INSERT OR REPLACE INTO audit_events SELECT * FROM audit_events")).toThrow(/cannot be removed/);
  });
  it("rolls back late failure including rebuilt audit and all new tables", () => {
    const db = open(true); populate(db);
    const before = db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all();
    const audit = db.prepare("SELECT * FROM audit_events").all();
    expect(() => migrate(db, migrationDir(4, true))).toThrow(/nonexistent_function/);
    expect(db.prepare("SELECT * FROM sqlite_master ORDER BY type, name").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM audit_events").all()).toEqual(audit);
    expect(schemaVersion(db)).toBe(3);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
  });
});

describe("budget configuration backstops", () => {
  it.each([0n, -1n, 1000000000000000000n])("rejects version %s", version => {
    const db = open();
    expect(() => db.prepare("INSERT INTO budget_plans VALUES (?, ?, ?, ?)").run(CATEGORY, version, NOW, NOW)).toThrow(/CHECK/);
  });
  it("retains identity and category references; refuses protected, archived and missing categories", () => {
    const db = open();
    for (const id of ["30000000-0000-4000-8000-000000000000", "30000000-0000-4000-8000-000000000001", PREVIEW]) {
      expect(() => db.prepare("INSERT INTO budget_plans VALUES (?, 1, ?, ?)").run(id, NOW, NOW)).toThrow(/active expense/);
    }
    db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(NOW, CATEGORY);
    expect(() => plan(db)).toThrow(/active expense/);
    db.prepare("UPDATE categories SET archived_at = NULL WHERE id = ?").run(CATEGORY);
    plan(db);
    expect(() => db.exec("DELETE FROM budget_plans")).toThrow(/not deleted/);
    expect(() => db.exec("INSERT OR REPLACE INTO budget_plans SELECT * FROM budget_plans")).toThrow(/not deleted/);
    expect(() => db.exec("UPDATE budget_plans SET created_at = 1")).toThrow(/identity/);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(CATEGORY)).toThrow(/FOREIGN KEY/);
  });
  it.each(["budget_schedule", "budget_exceptions"])("validates %s amount states, calendar, identity and restrictive references", table => {
    const db = open(); plan(db);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?)`);
    const absent = table === "budget_schedule" ? "stopped" : "skip";
    for (const [month, state, amount] of [
      ["2026-00", "amount", 0], ["2026-13", "amount", 0], ["2026-2", "amount", 0],
      ["1899-12", "amount", 0], ["3000-01", "amount", 0], ["2026-01", "amount", -1],
      ["2026-01", "amount", 100000000000], ["2026-01", "amount", null],
      ["2026-01", absent, 0], ["2026-01", "invalid", null], ["2026-01", "amount", 0.5],
    ] as const) expect(() => insert.run(CATEGORY, month, state, amount)).toThrow();
    expect(() => insert.run(PREVIEW, "2026-01", "amount", 0)).toThrow(/FOREIGN KEY/);
    insert.run(CATEGORY, "2026-01", "amount", 0);
    insert.run(CATEGORY, "2026-02", absent, null);
    insert.run(CATEGORY, "2999-12", "amount", 99999999999n);
    expect(() => insert.run(CATEGORY, "2026-01", "amount", 1)).toThrow(/UNIQUE/);
    expect(() => db.exec(`UPDATE ${table} SET month = '2026-03' WHERE month = '2026-01'`)).toThrow(/moving/);
    expect(db.prepare(`SELECT amount_cents FROM ${table} WHERE month = '2026-01'`).get()).toEqual({ amount_cents: 0n });
  });
  it("reserves archive capacity and cannot bypass it with UPDATE or REPLACE", () => {
    const db = open(); plan(db);
    withWriteTransaction(db, () => {
      const insert = db.prepare("INSERT INTO budget_exceptions VALUES (?, ?, 'amount', 0)");
      for (let i = 0; i < 999; i++) insert.run(CATEGORY, `${1900 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`);
    });
    expect(() => db.prepare("INSERT INTO budget_schedule VALUES (?, '2026-01', 'amount', 0)").run(CATEGORY)).toThrow(/capacity/);
    db.prepare("INSERT INTO budget_schedule VALUES (?, '2026-01', 'stopped', NULL)").run(CATEGORY);
    expect(() => db.exec("UPDATE budget_schedule SET state = 'amount', amount_cents = 0")).toThrow(/capacity/);
    expect(() => db.prepare("INSERT OR REPLACE INTO budget_schedule VALUES (?, '2026-01', 'amount', 0)").run(CATEGORY)).toThrow(/capacity/);
    expect(() => db.prepare("INSERT INTO budget_exceptions VALUES (?, '2027-01', 'skip', NULL)").run(CATEGORY)).toThrow(/capacity/);
  });
  it.each(["budget_schedule", "budget_exceptions"])("prevents archived %s mutation from restarting on reactivation", table => {
    const db = open(); plan(db);
    db.prepare("INSERT INTO budget_schedule VALUES (?, '2026-06', 'stopped', NULL)").run(CATEGORY);
    db.prepare("INSERT INTO budget_exceptions VALUES (?, '2026-05', 'skip', NULL)").run(CATEGORY);
    db.prepare("UPDATE categories SET archived_at = ?, archive_cutoff_month = '2026-06' WHERE id = ?").run(NOW, CATEGORY);
    expect(() => db.exec(`UPDATE ${table} SET state = 'amount', amount_cents = 100`)).toThrow(/archived/);
    expect(() => db.prepare(`INSERT INTO ${table} VALUES (?, '2026-07', 'amount', 100)`).run(CATEGORY)).toThrow(/archived/);
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/archived/);
    expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(/archived/);
  });
  it.each(["no cutoff", "active recurrence", "future recurrence", "future exception"])("requires stopping a budget before direct archive: %s", invalid => {
    const db = open(); plan(db);
    if (invalid === "active recurrence") db.prepare("INSERT INTO budget_schedule VALUES (?, '2026-01', 'amount', 1)").run(CATEGORY);
    if (invalid === "future recurrence") db.prepare("INSERT INTO budget_schedule VALUES (?, '2026-07', 'amount', 1)").run(CATEGORY);
    if (invalid === "future exception") db.prepare("INSERT INTO budget_exceptions VALUES (?, '2026-06', 'skip', NULL)").run(CATEGORY);
    expect(() => db.prepare("UPDATE categories SET archived_at = ?, archive_cutoff_month = ? WHERE id = ?")
      .run(NOW, invalid === "no cutoff" ? null : "2026-06", CATEGORY)).toThrow(/stop budget/);
    expect(db.prepare("SELECT archived_at FROM categories WHERE id = ?").get(CATEGORY)).toEqual({ archived_at: null });
  });
});

describe("durable budget reviews", () => {
  it("retains a preview without creating a plan, including after restart", () => {
    const db = open(); preview(db);
    expect(db.prepare("SELECT * FROM budget_plans").all()).toEqual([]);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(CATEGORY)).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("DELETE FROM budget_previews")).toThrow(/cannot be removed/);
    expect(() => db.exec("INSERT OR REPLACE INTO budget_previews SELECT * FROM budget_previews")).toThrow(/cannot be removed/);
    const saved = db.prepare("SELECT * FROM budget_previews").all();
    closeLedger(db);
    const reopened = openLedger({ dataDir: ledger!.dataDir });
    try { expect(reopened.prepare("SELECT * FROM budget_previews").all()).toEqual(saved); }
    finally { closeLedger(reopened); }
  });
  it.each(["preview_json = '{}'", "dependencies_json = '{}'", "created_at = 1", "expires_at = 1", "category_id = id", "id = category_id"])("preserves review field %s", change => {
    const db = open(); preview(db);
    expect(() => db.exec(`UPDATE budget_previews SET ${change}`)).toThrow(/cannot be changed/);
  });
  it("requires exact expiry, paired completion fields, object JSON, and immutable saved result", () => {
    const db = open(); preview(db);
    expect(() => db.exec("UPDATE budget_previews SET result_json = '{}' ")).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE budget_previews SET applied_at = ?, result_json = '[]'").run(NOW)).toThrow(/CHECK/);
    db.prepare("UPDATE budget_previews SET applied_at = ?, result_json = '{\"saved\":true}'").run(NOW + 1);
    for (const change of ["result_json = '{}'", "applied_at = NULL, result_json = NULL", "preview_json = preview_json"]) {
      expect(() => db.exec(`UPDATE budget_previews SET ${change}`)).toThrow(/cannot be changed/);
    }
    expect(() => db.prepare(`INSERT INTO budget_previews (id, category_id, preview_json, dependencies_json, created_at, expires_at)
      VALUES (?, ?, '{}', '{}', ?, ?)`).run(CATEGORY, CATEGORY, NOW, NOW + 86400001)).toThrow(/CHECK/);
  });
});
