import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadMigrations, migrate, schemaVersion } from "../src/migrate.js";
import type { SqliteDatabase } from "../src/open.js";
import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";
import { withWriteTransaction } from "../src/transaction.js";

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const UNCATEGORIZED = "30000000-0000-4000-8000-000000000000";
const NOW = 1770000000000;
const DIGEST = "a".repeat(64);
let ledger: TemporaryLedger | undefined;
const scratch: string[] = [];

afterEach(() => {
  ledger?.close();
  ledger = undefined;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function account(db: SqliteDatabase, n = 1): void {
  db.prepare(`INSERT INTO accounts (id, kind, provider_key, display_name, tracking_start_date,
    opening_cents, creation_digest, version, ledger_revision, created_at, updated_at)
    VALUES (?, 'checking', 'other', 'Synthetic', '2026-01-01', 0, ?, 1, 0, ?, ?)`)
    .run(id(n), DIGEST, NOW, NOW);
}

function category(db: SqliteDatabase): void {
  db.prepare(`INSERT INTO categories (id, display_name, normalized_name, color, protected,
    version, created_at, updated_at) VALUES (?, 'Food', 'food', '#112233', 0, 1, ?, ?)`)
    .run(id(30), NOW, NOW);
}

function open(): SqliteDatabase {
  ledger = createTemporaryLedger();
  account(ledger.db);
  account(ledger.db, 2);
  category(ledger.db);
  return ledger.db;
}

function revision(db: SqliteDatabase, rev = 1, enabled = 1): void {
  db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern,
    normalized_pattern, account_id, applies_to, category_id, category_name, enabled, changed_at)
    VALUES (?, ?, 'created', 'contains', 'Market', 'market', ?, 'purchases_and_refunds', ?, 'Food', ?, ?)`)
    .run(id(40), rev, id(1), id(30), enabled, NOW);
}

function rule(db: SqliteDatabase): void {
  withWriteTransaction(db, () => {
    db.prepare(`INSERT INTO rules (id, position, revision, creation_digest, version, created_at, updated_at)
      VALUES (?, 1, 1, ?, 1, ?, ?)`).run(id(40), DIGEST, NOW, NOW);
    revision(db);
  });
}

function transaction(db: SqliteDatabase, n: number, kind = "transfer", cents = -100, accountNumber = 1): void {
  db.prepare(`INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
    amount_cents, kind, category_id, assignment_origin, assigned_at, lifecycle,
    original_posted_date, original_amount_cents, version, created_at, updated_at)
    VALUES (?, ?, '2026-02-01', 'SYNTHETIC', 'synthetic', ?, ?, ?, ?, ?, 'active', '2026-02-01', ?, 1, ?, ?)`)
    .run(id(n), id(accountNumber), cents, kind, kind === "transfer" ? null : UNCATEGORIZED,
      kind === "transfer" ? "system" : "unassigned", NOW, cents, NOW, NOW);
}

function pairHeader(db: SqliteDatabase): void {
  db.prepare("INSERT INTO transfer_pairs (id, creation_digest, version, created_at) VALUES (?, ?, 1, ?)")
    .run(id(50), DIGEST, NOW);
}

function leg(db: SqliteDatabase, slot: number, tx: number): void {
  db.prepare("INSERT INTO transfer_legs (pair_id, slot, transaction_id) VALUES (?, ?, ?)")
    .run(id(50), slot, id(tx));
}

function pair(db: SqliteDatabase): void {
  withWriteTransaction(db, () => { pairHeader(db); leg(db, 1, 10); leg(db, 2, 11); });
}

function refundLink(db: SqliteDatabase, n = 60, refund = 11): void {
  db.prepare(`INSERT INTO refund_links (id, refund_id, purchase_id, creation_digest, version, created_at)
    VALUES (?, ?, ?, ?, 1, ?)`).run(id(n), id(refund), id(10), DIGEST, NOW);
}

describe("populated schema-2 upgrades", () => {
  function oldDatabase(): SqliteDatabase {
    const dir = mkdtempSync(join(tmpdir(), "money-desk-stage3-upgrade-"));
    scratch.push(dir);
    for (const migration of loadMigrations().slice(0, 2)) writeFileSync(join(dir, migration.name), migration.sql);
    ledger = createTemporaryLedger({ migrated: false });
    migrate(ledger.db, dir);
    account(ledger.db);
    return ledger.db;
  }

  function oldTransaction(db: SqliteDatabase, origin: string, lifecycle = "active"): void {
    db.prepare(`INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
      amount_cents, kind, category_id, assignment_origin, note, lifecycle, version, created_at, updated_at)
      VALUES (?, ?, '2026-02-01', 'SYNTHETIC', 'synthetic', -12345, 'purchase', ?, ?, 'Legacy NOTE', ?, 7, ?, ?)`)
      .run(id(10), id(1), UNCATEGORIZED, origin, lifecycle, NOW - 100, NOW);
  }

  it.each(["active", "void"])("preserves %s transactions, audit and original values on an archived account", (lifecycle) => {
    const db = oldDatabase();
    oldTransaction(db, "manual", lifecycle);
    db.prepare("UPDATE accounts SET archived_at = ?").run(NOW);
    db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, account_id, event_type, origin, after_json, occurred_at)
      VALUES (?, 'account', ?, ?, 'account_created', 'owner', '{"name":"Synthetic"}', ?)`)
      .run(id(90), id(1), id(1), NOW);
    const before = db.prepare("SELECT * FROM transactions").get() as Record<string, unknown>;
    const auditBefore = db.prepare("SELECT * FROM audit_events").all();
    expect(migrate(db).appliedNow).toEqual(["0003_transactions_rules.sql", "0004_budgets.sql"]);
    expect(db.prepare("SELECT * FROM transactions").get()).toMatchObject({
      ...before, assigned_at: BigInt(NOW), voided_at: lifecycle === "void" ? BigInt(NOW) : null,
      original_posted_date: "2026-02-01", original_amount_cents: -12345n, rule_id: null, rule_revision: null,
      // The note is kept; its search form is left for search to derive, not invented by SQL.
      note: "Legacy NOTE", normalized_note: null,
    });
    expect(db.prepare("SELECT * FROM audit_events").all()).toEqual(auditBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
    expect(() => db.prepare("UPDATE transactions SET amount_cents = -99").run()).toThrow(/archived account/);
    expect(() => db.prepare("UPDATE audit_events SET event_type = 'erased'").run()).toThrow(/cannot be changed/);
  });

  it("refuses unrecoverable rule attribution and rolls the entire migration back", () => {
    const db = oldDatabase();
    oldTransaction(db, "rule");
    const before = db.prepare("SELECT * FROM transactions").all();
    expect(() => migrate(db)).toThrow(/stage3_requires_recoverable_rule_attribution/);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare("SELECT * FROM transactions").all()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('rules', 'stage3_attribution_gate')").all()).toEqual([]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
  });

  it("preserves custom categories and their references while removing only the normalized-name length cap", () => {
    const db = oldDatabase();
    category(db);
    oldTransaction(db, "manual");
    db.prepare("UPDATE transactions SET category_id = ?").run(id(30));
    const before = db.prepare("SELECT * FROM categories ORDER BY id").all() as Record<string, unknown>[];
    migrate(db);
    const after = db.prepare("SELECT * FROM categories ORDER BY id").all();
    expect(after).toEqual(before.map(row => ({ ...row, creation_digest: null, archive_cutoff_month: null })));
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(id(30))).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("UPDATE categories SET display_name = 'Changed' WHERE id = ?").run(UNCATEGORIZED)).toThrow(/protected category/);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(UNCATEGORIZED)).toThrow(/protected category/);
    expect(() => db.prepare("UPDATE categories SET normalized_name = ? WHERE id = ?").run("i\u0307".repeat(60), id(30))).not.toThrow();
    expect(() => db.prepare("UPDATE categories SET display_name = ? WHERE id = ?").run("x".repeat(61), id(30))).toThrow(/CHECK/);
  });

  it("rolls a late migration failure back, including rebuilt tables and triggers", () => {
    const db = oldDatabase();
    oldTransaction(db, "manual");
    const dir = mkdtempSync(join(tmpdir(), "money-desk-stage3-failure-"));
    scratch.push(dir);
    for (const migration of loadMigrations()) {
      writeFileSync(join(dir, migration.name), migration.sql + (migration.id === 3 ? "\nSELECT nonexistent_function();" : ""));
    }
    const schemaBefore = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const before = db.prepare("SELECT * FROM transactions").all();
    expect(() => migrate(db, dir)).toThrow(/nonexistent_function/);
    expect(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(schemaBefore);
    expect(db.prepare("SELECT * FROM transactions").all()).toEqual(before);
    expect(schemaVersion(db)).toBe(2);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
  });
});

describe("rule references and original evidence", () => {
  it("requires a real immutable revision for every rule assignment", () => {
    const db = open();
    transaction(db, 10, "purchase");
    expect(() => db.prepare("UPDATE transactions SET assignment_origin = 'rule'").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE transactions SET assignment_origin = 'rule', rule_id = ?, rule_revision = 1").run(id(40))).toThrow(/FOREIGN KEY/);
    rule(db);
    db.prepare("UPDATE transactions SET assignment_origin = 'rule', rule_id = ?, rule_revision = 1, category_id = ?").run(id(40), id(30));
    expect(() => db.prepare("UPDATE transactions SET assignment_origin = 'manual'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE transactions SET assignment_origin = 'manual', rule_id = NULL, rule_revision = NULL").run();
    expect(() => db.prepare("DELETE FROM rule_revisions").run()).toThrow(/cannot be removed/);
    expect(() => db.prepare("UPDATE rule_revisions SET pattern = 'other'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(id(30))).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("DELETE FROM accounts WHERE id = ?").run(id(1))).toThrow(/FOREIGN KEY/);
  });

  it("counts complete code points, including NUL, in rule, merchant, note and reason limits", () => {
    const db = open();
    const nul = String.fromCharCode(0);
    rule(db);
    const insertRevision = (rev: number, pattern: string, normalized: string) => db.prepare(`INSERT INTO rule_revisions
      (rule_id, revision, change, match_type, pattern, normalized_pattern, account_id, applies_to, category_id,
      category_name, enabled, changed_at) VALUES (?, ?, 'edited', 'contains', ?, ?, NULL, 'purchases', ?, 'Food', 1, ?)`)
      .run(id(40), rev, pattern, normalized, id(30), NOW);
    insertRevision(2, nul, nul);
    insertRevision(3, "\u{1f600}".repeat(256), "\u{1f600}".repeat(256));
    expect(() => insertRevision(4, nul + "a".repeat(256), "a")).toThrow(/CHECK/);
    expect(() => insertRevision(4, "\u{1f600}".repeat(257), "a")).toThrow(/CHECK/);
    expect(() => insertRevision(4, "a", "")).toThrow(/CHECK/);
    const post = (n: number, merchant: string) => db.prepare(`INSERT INTO transactions (id, account_id, posted_date,
      merchant_text, normalized_text, amount_cents, kind, category_id, assignment_origin, assigned_at, lifecycle,
      original_posted_date, original_amount_cents, version, created_at, updated_at)
      VALUES (?, ?, '2026-02-01', ?, 'synthetic', -100, 'purchase', ?, 'unassigned', ?, 'active', '2026-02-01', -100, 1, ?, ?)`)
      .run(id(n), id(1), merchant, UNCATEGORIZED, NOW, NOW, NOW);
    post(10, nul + "a");
    expect(() => post(11, nul + "a".repeat(2000))).toThrow(/CHECK/);
    db.prepare("UPDATE transactions SET note = ?").run(nul);
    expect(() => db.prepare("UPDATE transactions SET note = ?").run(nul + "a".repeat(1000))).toThrow(/CHECK/);
    const event = (n: number, reason: string) => db.prepare(`INSERT INTO assignment_events (id, transaction_id,
      occurred_at, event_type, source, reason, related_ids_json) VALUES (?, ?, ?, 'amount_corrected', 'owner', ?, '[]')`)
      .run(id(n), id(10), NOW, reason);
    event(70, nul);
    expect(() => event(71, nul + "a".repeat(500))).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, event_type, origin, reason, occurred_at)
      VALUES (?, 'rule', ?, 'rule_updated', 'owner', ?, ?)`).run(id(72), id(40), nul + "a".repeat(500), NOW)).toThrow(/CHECK/);
  });

  it("cannot commit a rule without its current revision", () => {
    const db = open();
    expect(() => withWriteTransaction(db, () => {
      db.prepare(`INSERT INTO rules (id, position, revision, creation_digest, version, created_at, updated_at)
        VALUES (?, 1, 1, ?, 1, ?, ?)`).run(id(40), DIGEST, NOW, NOW);
    })).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT * FROM rules").all()).toEqual([]);
  });

  it("requires resolving enabled rules before category archive and does not revive them", () => {
    const db = open();
    rule(db);
    expect(() => db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(NOW, id(30))).toThrow(/resolve enabled rules/);
    revision(db, 2, 0);
    db.prepare("UPDATE rules SET revision = 2").run();
    db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(NOW, id(30));
    expect(() => revision(db, 3, 1)).toThrow(/eligible expense category/);
    expect(() => db.prepare("UPDATE rules SET revision = 1").run()).toThrow(/archived category/);
    db.prepare("UPDATE categories SET archived_at = NULL WHERE id = ?").run(id(30));
    expect(db.prepare("SELECT enabled FROM rules r JOIN rule_revisions v ON v.rule_id = r.id AND v.revision = r.revision").get()).toEqual({ enabled: 0n });
  });

  it.each(["id", "account_id", "merchant_text", "original_posted_date", "original_amount_cents", "created_at"])("preserves transaction %s", (column) => {
    const db = open();
    transaction(db, 10, "purchase");
    const value = column === "original_amount_cents" || column === "created_at" ? 123 : column === "original_posted_date" ? "2026-02-02" : id(2);
    expect(() => db.prepare(`UPDATE transactions SET ${column} = ?`).run(value)).toThrow(/original evidence/);
    expect(() => db.prepare("DELETE FROM transactions").run()).toThrow(/must be voided/);
  });

  it("requires a void timestamp but permits restore with a retained archived category", () => {
    const db = open();
    transaction(db, 10, "purchase");
    db.prepare("UPDATE transactions SET category_id = ?, assignment_origin = 'manual'").run(id(30));
    db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(NOW, id(30));
    expect(() => db.prepare("UPDATE transactions SET lifecycle = 'void'").run()).toThrow(/CHECK/);
    db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ?").run(NOW);
    db.prepare("UPDATE transactions SET lifecycle = 'active', voided_at = NULL").run();
    expect(db.prepare("SELECT lifecycle, category_id FROM transactions").get()).toEqual({ lifecycle: "active", category_id: id(30) });
  });
});

describe("transfer cardinality at the real commit boundary", () => {
  it.each([0, 1])("refuses a committed pair with %s legs and rolls everything back", (count) => {
    const db = open();
    transaction(db, 10);
    expect(() => withWriteTransaction(db, () => {
      pairHeader(db);
      if (count === 1) leg(db, 1, 10);
    })).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT * FROM transfer_pairs").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM transfer_legs").all()).toEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it("allows exactly two archived-side transfer legs and removes only the links", () => {
    const db = open();
    transaction(db, 10);
    transaction(db, 11, "transfer", 100, 2);
    db.prepare("UPDATE accounts SET archived_at = ?").run(NOW);
    const before = db.prepare("SELECT * FROM transactions ORDER BY id").all();
    pair(db);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(() => db.prepare("DELETE FROM transfer_legs WHERE slot = 1").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("UPDATE transfer_legs SET slot = 2 WHERE slot = 1").run()).toThrow(/unlink/);
    expect(() => db.prepare("UPDATE transfer_pairs SET version = 2").run()).toThrow(/cannot be changed/);
    db.prepare("DELETE FROM transfer_pairs").run();
    expect(db.prepare("SELECT * FROM transfer_legs").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM transactions ORDER BY id").all()).toEqual(before);
  });

  it.each(["same account", "unequal", "non-transfer", "void"])("refuses %s counterpart", (scenario) => {
    const db = open();
    transaction(db, 10);
    transaction(db, 11, scenario === "non-transfer" ? "refund" : "transfer", scenario === "unequal" ? 99 : 100, scenario === "same account" ? 1 : 2);
    if (scenario === "void") db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ? WHERE id = ?").run(NOW, id(11));
    expect(() => pair(db)).toThrow(/active equal opposite/);
    expect(db.prepare("SELECT * FROM transfer_pairs").all()).toEqual([]);
  });

  it("rejects third slots, duplicate legs and membership in a second pair", () => {
    const db = open();
    transaction(db, 10);
    transaction(db, 11, "transfer", 100, 2);
    transaction(db, 12, "transfer", 100, 2);
    pair(db);
    expect(() => leg(db, 3, 12)).toThrow(/CHECK|active equal opposite/);
    expect(() => leg(db, 1, 12)).toThrow(/UNIQUE|active equal opposite/);
    expect(() => withWriteTransaction(db, () => {
      db.prepare("INSERT INTO transfer_pairs (id, creation_digest, version, created_at) VALUES (?, ?, 1, ?)").run(id(51), DIGEST, NOW);
      db.prepare("INSERT INTO transfer_legs VALUES (?, 1, ?)").run(id(51), id(10));
    })).toThrow(/UNIQUE/);
  });

  it("permits date changes but requires unlinking before amount or lifecycle changes", () => {
    const db = open();
    transaction(db, 10);
    transaction(db, 11, "transfer", 100, 2);
    pair(db);
    db.prepare("UPDATE transactions SET posted_date = '2026-03-01' WHERE id = ?").run(id(10));
    expect(() => db.prepare("UPDATE transactions SET amount_cents = -90 WHERE id = ?").run(id(10))).toThrow(/unlink transfer/);
    expect(() => db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ? WHERE id = ?").run(NOW, id(10))).toThrow(/unlink transfer/);
    const counterpart = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id(11));
    withWriteTransaction(db, () => {
      db.prepare("DELETE FROM transfer_pairs").run();
      db.prepare("UPDATE transactions SET amount_cents = -90 WHERE id = ?").run(id(10));
    });
    expect(db.prepare("SELECT * FROM transactions WHERE id = ?").get(id(11))).toEqual(counterpart);
  });
});

describe("informational refund links", () => {
  it("allows multiple cross-account refunds exceeding the purchase, including archived accounts", () => {
    const db = open();
    transaction(db, 10, "purchase");
    transaction(db, 11, "refund", 70, 2);
    transaction(db, 12, "refund", 70, 2);
    db.prepare("UPDATE accounts SET archived_at = ?").run(NOW);
    const before = db.prepare("SELECT * FROM transactions ORDER BY id").all();
    refundLink(db);
    refundLink(db, 61, 12);
    expect(db.prepare("SELECT COUNT(*) AS n FROM refund_links").get()).toEqual({ n: 2n });
    expect(db.prepare("SELECT * FROM transactions ORDER BY id").all()).toEqual(before);
    db.prepare("DELETE FROM refund_links").run();
    expect(db.prepare("SELECT * FROM transactions ORDER BY id").all()).toEqual(before);
  });

  it("requires active kinds, unique refund membership and explicit unlinking before void", () => {
    const db = open();
    transaction(db, 10, "purchase");
    transaction(db, 11, "refund", 100, 2);
    transaction(db, 12, "transfer", 100, 2);
    expect(() => refundLink(db, 61, 12)).toThrow(/active refund and purchase/);
    refundLink(db);
    expect(() => refundLink(db, 61)).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE refund_links SET refund_id = ?").run(id(12))).toThrow(/cannot be changed/);
    expect(() => db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ? WHERE id = ?").run(NOW, id(10))).toThrow(/unlink refunds/);
    db.prepare("UPDATE transactions SET amount_cents = -50, posted_date = '2026-03-01' WHERE id = ?").run(id(10));
    withWriteTransaction(db, () => {
      db.prepare("DELETE FROM refund_links").run();
      db.prepare("UPDATE transactions SET lifecycle = 'void', voided_at = ? WHERE id = ?").run(NOW, id(10));
    });
    expect(() => refundLink(db)).toThrow(/active refund and purchase/);
  });
});

describe("durable reviews and history", () => {
  it.each(["repair_previews", "rule_runs", "transactions", "rule_revisions", "assignment_events", "audit_events"])(
    "cannot bypass immutable %s with INSERT OR REPLACE", (table) => {
      const db = open();
      transaction(db, 10, "purchase");
      rule(db);
      db.prepare(`INSERT INTO repair_previews (id, transaction_id, preview_json, dependencies_json,
        created_at, expires_at, applied_at, result_json) VALUES (?, ?, '{}', '[]', ?, ?, ?, '{"saved":true}')`)
        .run(id(70), id(10), NOW, NOW + 86400000, NOW + 1);
      db.prepare(`INSERT INTO rule_runs (id, preview_json, rule_set_revision, created_at, expires_at, applied_at, result_json)
        VALUES (?, '{}', 0, ?, ?, ?, '{"saved":true}')`).run(id(71), NOW, NOW + 86400000, NOW + 1);
      db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source, related_ids_json)
        VALUES (?, ?, ?, 'note_changed', 'owner', '[]')`).run(id(80), id(10), NOW);
      db.prepare(`INSERT INTO audit_events (id, entity_type, entity_id, event_type, origin, occurred_at)
        VALUES (?, 'account', ?, 'account_created', 'owner', ?)`).run(id(90), id(1), NOW);
      const before = db.prepare(`SELECT * FROM ${table}`).all();
      expect(() => db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`).run())
        .toThrow(/cannot be removed|must be voided/);
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
    },
  );

  it.each(["repair_previews", "rule_runs"])("preserves %s reviewed content and its completed result", (table) => {
    const db = open();
    transaction(db, 10, "purchase");
    if (table === "repair_previews") {
      db.prepare(`INSERT INTO repair_previews (id, transaction_id, preview_json, dependencies_json, created_at, expires_at)
        VALUES (?, ?, '{}', '[]', ?, ?)`).run(id(70), id(10), NOW, NOW + 86400000);
    } else {
      db.prepare(`INSERT INTO rule_runs (id, preview_json, rule_set_revision, created_at, expires_at)
        VALUES (?, '{}', 0, ?, ?)`).run(id(70), NOW, NOW + 86400000);
    }
    expect(() => db.prepare(`UPDATE ${table} SET preview_json = '{"different":true}'`).run()).toThrow(/cannot be changed/);
    expect(() => db.prepare(`UPDATE ${table} SET expires_at = expires_at + 1`).run()).toThrow(/cannot be changed/);
    expect(() => db.prepare(`UPDATE ${table} SET applied_at = ?`).run(NOW + 1)).toThrow(/CHECK/);
    db.prepare(`UPDATE ${table} SET applied_at = ?, result_json = '{"saved":true}'`).run(NOW + 1);
    expect(() => db.prepare(`UPDATE ${table} SET result_json = '{}'`).run()).toThrow(/cannot be changed/);
    expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/cannot be removed/);
  });

  it("keeps assignment history append-only and retains referenced categories", () => {
    const db = open();
    transaction(db, 10, "purchase");
    db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source,
      before_json, after_json, before_category_id, after_category_id, related_ids_json)
      VALUES (?, ?, ?, 'category_changed', 'owner', '{"categoryName":"Food"}', '{}', ?, ?, '[]')`)
      .run(id(80), id(10), NOW, id(30), UNCATEGORIZED);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(id(30))).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("UPDATE assignment_events SET before_json = '{}'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM assignment_events").run()).toThrow(/cannot be removed/);
  });

  it("keeps rule-run candidates immutable and cannot add candidates after apply", () => {
    const db = open();
    transaction(db, 10, "purchase");
    transaction(db, 11, "purchase");
    db.prepare(`INSERT INTO rule_runs (id, preview_json, rule_set_revision, created_at, expires_at)
      VALUES (?, '{}', 0, ?, ?)`).run(id(70), NOW, NOW + 86400000);
    const add = (tx: number) => db.prepare(`INSERT INTO rule_run_rows (run_id, transaction_id,
      transaction_version, account_version, before_category_id, after_category_id, row_json, changed)
      VALUES (?, ?, 1, 1, ?, ?, '{}', 1)`).run(id(70), id(tx), UNCATEGORIZED, id(30));
    add(10);
    expect(() => db.prepare("UPDATE rule_run_rows SET changed = 0").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("DELETE FROM rule_run_rows").run()).toThrow(/cannot be removed/);
    db.prepare("UPDATE rule_runs SET applied_at = ?, result_json = '{}'").run(NOW + 1);
    expect(() => add(11)).toThrow(/cannot gain candidates/);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(id(30))).toThrow(/FOREIGN KEY/);
  });
});
