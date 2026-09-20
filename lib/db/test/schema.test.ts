/**
 * The finance schema, exercised by writing directly to the database.
 *
 * These are deliberately not API tests. The design requires the invariants to
 * hold against a direct write, not only against a request the service
 * validated first: the constraints are the backstop for anything that reaches
 * the file, including a future bug in the service and a hand-run statement.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";
import type { SqliteDatabase } from "../src/open.js";

const UNCATEGORIZED = "30000000-0000-4000-8000-000000000000";
const INCOME = "30000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";

let ledger: TemporaryLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

function open(): SqliteDatabase {
  ledger = createTemporaryLedger();
  const { db } = ledger;
  insertAccount(db, {});
  return db;
}

function insertAccount(db: SqliteDatabase, overrides: Record<string, unknown>): void {
  const row = {
    id: ACCOUNT,
    kind: "checking",
    provider_key: "chase",
    display_name: "Synthetic Everyday Checking",
    masked_suffix: "4321",
    tracking_start_date: "2026-04-01",
    opening_cents: 125000n,
    archived_at: null,
    creation_digest: "a".repeat(64),
    version: 1n,
    ledger_revision: 0n,
    created_at: 1750000000000n,
    updated_at: 1750000000000n,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO accounts (id, kind, provider_key, display_name, masked_suffix,
       tracking_start_date, opening_cents, archived_at, creation_digest, version,
       ledger_revision, created_at, updated_at)
     VALUES (@id, @kind, @provider_key, @display_name, @masked_suffix,
       @tracking_start_date, @opening_cents, @archived_at, @creation_digest, @version,
       @ledger_revision, @created_at, @updated_at)`,
  ).run(row);
}

let transactionCounter = 0;
function insertTransaction(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
  transactionCounter += 1;
  const row = {
    id: `10000000-0000-4000-8000-${String(transactionCounter).padStart(12, "0")}`,
    account_id: ACCOUNT,
    posted_date: "2026-04-02",
    merchant_text: "SYNTHETIC MARKET #12",
    normalized_text: "synthetic market 12",
    amount_cents: -8000n,
    kind: "purchase",
    category_id: UNCATEGORIZED,
    assignment_origin: "unassigned",
    note: null,
    lifecycle: "active",
    version: 1n,
    created_at: 1750000000000n,
    updated_at: 1750000000000n,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
       amount_cents, kind, category_id, assignment_origin, note, lifecycle, version,
       created_at, updated_at)
     VALUES (@id, @account_id, @posted_date, @merchant_text, @normalized_text,
       @amount_cents, @kind, @category_id, @assignment_origin, @note, @lifecycle, @version,
       @created_at, @updated_at)`,
  ).run(row);
}

describe("the migration itself", () => {
  it("creates the finance tables and records schema version 2", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name);
    for (const table of [
      "accounts",
      "categories",
      "transactions",
      "reconciliation_checkpoints",
      "checkpoint_checks",
      "audit_events",
    ]) {
      expect(names).toContain(table);
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(
      db.prepare("SELECT schema_version FROM ledger_metadata WHERE id = 1").get(),
    ).toEqual({ schema_version: 2n });
  });

  it("leaves foreign key enforcement ON afterwards", () => {
    // The stage 1 review found a defect that would have silently left this
    // OFF. This is the stage where every foreign key starts to matter, so it
    // is asserted on the live connection rather than assumed from the fix.
    ledger = createTemporaryLedger();
    expect(Number(ledger.db.pragma("foreign_keys", { simple: true }))).toBe(1);

    expect(() =>
      insertTransaction(ledger!.db, { account_id: "20000000-0000-4000-8000-00000000dead" }),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("keeps every finance table STRICT", () => {
    ledger = createTemporaryLedger();
    const rows = ledger.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string }[];
    for (const row of rows) {
      expect(`${row.name}: ${row.sql.trimEnd().slice(-20)}`).toMatch(/STRICT/);
    }
  });
});

describe("account constraints", () => {
  it("accepts a well-formed account", () => {
    expect(() => open()).not.toThrow();
  });

  const badAccounts: Array<[string, Record<string, unknown>]> = [
    ["an unknown kind", { kind: "brokerage" }],
    ["an unknown provider", { provider_key: "unknown_bank" }],
    ["an empty display name", { display_name: "" }],
    ["a whitespace-only display name", { display_name: "   " }],
    ["a masked suffix that is not four digits", { masked_suffix: "12" }],
    ["a masked suffix with letters", { masked_suffix: "12ab" }],
    ["an impossible tracking start", { tracking_start_date: "2026-02-31" }],
    ["a month-13 tracking start", { tracking_start_date: "2026-13-01" }],
    ["an unpadded tracking start", { tracking_start_date: "2026-4-2" }],
    ["a non-date tracking start", { tracking_start_date: "not-a-date" }],
    ["an empty tracking start", { tracking_start_date: "" }],
    ["a year-zero tracking start", { tracking_start_date: "0000-01-01" }],
    ["an opening balance at the bound", { opening_cents: 100000000000n }],
    ["a negative opening balance at the bound", { opening_cents: -100000000000n }],
    ["a version of zero", { version: 0n }],
  ];
  for (const [why, overrides] of badAccounts) {
    it(`refuses ${why}`, () => {
      ledger = createTemporaryLedger();
      // Matching the constraint message, not merely "it threw": a typo in the
      // test's own INSERT would otherwise look like the schema working.
      expect(() => insertAccount(ledger!.db, overrides)).toThrow(/constraint failed/i);
    });
  }

  it("accepts a real leap day and the bound minus one", () => {
    ledger = createTemporaryLedger();
    expect(() =>
      insertAccount(ledger!.db, {
        tracking_start_date: "2028-02-29",
        opening_cents: 99999999999n,
        masked_suffix: null,
      }),
    ).not.toThrow();
  });
});

describe("protected categories", () => {
  it("seeds exactly Uncategorized and Income", () => {
    const db = open();
    const rows = db
      .prepare("SELECT id, display_name, system_kind, protected FROM categories ORDER BY id")
      .all() as { id: string; display_name: string; system_kind: string; protected: bigint }[];
    expect(rows).toEqual([
      { id: UNCATEGORIZED, display_name: "Uncategorized", system_kind: "uncategorized", protected: 1n },
      { id: INCOME, display_name: "Income", system_kind: "income", protected: 1n },
    ]);
  });

  it("refuses to rename, archive, unprotect or delete one, even directly", () => {
    const db = open();
    expect(() =>
      db.prepare("UPDATE categories SET display_name = 'Salary' WHERE id = ?").run(INCOME),
    ).toThrow(/protected category/);
    expect(() =>
      db.prepare("UPDATE categories SET archived_at = 1750000000000 WHERE id = ?").run(INCOME),
    ).toThrow(/protected category/);
    expect(() =>
      db.prepare("UPDATE categories SET protected = 0 WHERE id = ?").run(INCOME),
    ).toThrow(/protected category/);
    expect(() => db.prepare("DELETE FROM categories WHERE id = ?").run(UNCATEGORIZED)).toThrow(
      /protected category/,
    );
  });

  it("still allows an unrelated column on a protected row to change", () => {
    // The trigger guards identity and lifecycle, not the record's own
    // bookkeeping: a description or colour correction must stay possible.
    const db = open();
    expect(() =>
      db.prepare("UPDATE categories SET color = '#123456', version = 2 WHERE id = ?").run(INCOME),
    ).not.toThrow();
  });

  it("refuses deleting a category that transactions still reference, and allows an unused one", () => {
    const db = open();
    db.prepare(
      `INSERT INTO categories (id, display_name, normalized_name, description, color,
         system_kind, protected, archived_at, version, created_at, updated_at)
       VALUES ('30000000-0000-4000-8000-000000000010', 'Groceries', 'groceries', NULL,
         '#1F6F5F', NULL, 0, NULL, 1, 1750000000000, 1750000000000)`,
    ).run();
    insertTransaction(db, {
      category_id: "30000000-0000-4000-8000-000000000010",
      assignment_origin: "manual",
    });
    expect(() =>
      db.prepare("DELETE FROM categories WHERE id = '30000000-0000-4000-8000-000000000010'").run(),
    ).toThrow(/FOREIGN KEY/i);

    db.prepare(
      `INSERT INTO categories (id, display_name, normalized_name, description, color,
         system_kind, protected, archived_at, version, created_at, updated_at)
       VALUES ('30000000-0000-4000-8000-000000000011', 'Dining', 'dining', NULL,
         '#C9A227', NULL, 0, NULL, 1, 1750000000000, 1750000000000)`,
    ).run();
    expect(() =>
      db.prepare("DELETE FROM categories WHERE id = '30000000-0000-4000-8000-000000000011'").run(),
    ).not.toThrow();
  });

  it("refuses a second category claiming the same system kind or normalized name", () => {
    const db = open();
    expect(() =>
      db
        .prepare(
          `INSERT INTO categories (id, display_name, normalized_name, description, color,
             system_kind, protected, archived_at, version, created_at, updated_at)
           VALUES ('30000000-0000-4000-8000-000000000012', 'More Income', 'more income', NULL,
             '#2F7D6D', 'income', 1, NULL, 1, 1750000000000, 1750000000000)`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO categories (id, display_name, normalized_name, description, color,
             system_kind, protected, archived_at, version, created_at, updated_at)
           VALUES ('30000000-0000-4000-8000-000000000013', 'income', 'income', NULL,
             '#2F7D6D', NULL, 0, NULL, 1, 1750000000000, 1750000000000)`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });
});

describe("transaction kind, sign and category constraints", () => {
  const accepted: Array<[string, Record<string, unknown>]> = [
    ["an unassigned purchase in Uncategorized", {}],
    [
      "a purchase deliberately kept in Uncategorized by hand",
      { assignment_origin: "manual" },
    ],
    [
      "a refund",
      { kind: "refund", amount_cents: 2500n, assignment_origin: "rule" },
    ],
    [
      "income in the Income category",
      { kind: "income", amount_cents: 450000n, category_id: INCOME, assignment_origin: "system" },
    ],
    [
      "a transfer out with no category",
      { kind: "transfer", amount_cents: -20000n, category_id: null, assignment_origin: "system" },
    ],
    [
      "a transfer in with no category",
      { kind: "transfer", amount_cents: 20000n, category_id: null, assignment_origin: "system" },
    ],
    ["a voided row", { lifecycle: "void" }],
  ];
  for (const [what, overrides] of accepted) {
    it(`accepts ${what}`, () => {
      const db = open();
      expect(() => insertTransaction(db, overrides)).not.toThrow();
    });
  }

  const refused: Array<[string, Record<string, unknown>]> = [
    ["a positive purchase", { amount_cents: 8000n }],
    ["a negative refund", { kind: "refund", amount_cents: -2500n, assignment_origin: "rule" }],
    [
      "negative income",
      { kind: "income", amount_cents: -450000n, category_id: INCOME, assignment_origin: "system" },
    ],
    ["a zero amount", { amount_cents: 0n }],
    ["an amount at the bound", { amount_cents: -100000000000n }],
    [
      "a transfer carrying a category",
      { kind: "transfer", amount_cents: -100n, category_id: UNCATEGORIZED, assignment_origin: "system" },
    ],
    ["a purchase with no category", { category_id: null }],
    [
      "a purchase in the Income category",
      { kind: "purchase", amount_cents: -100n, category_id: INCOME, assignment_origin: "manual" },
    ],
    [
      "a refund in the Income category",
      { kind: "refund", amount_cents: 100n, category_id: INCOME, assignment_origin: "manual" },
    ],
    [
      "income outside the Income category",
      { kind: "income", amount_cents: 100n, category_id: UNCATEGORIZED, assignment_origin: "system" },
    ],
    ["`unassigned` outside Uncategorized", { category_id: INCOME, assignment_origin: "unassigned" }],
    ["a purchase with `system` provenance", { assignment_origin: "system" }],
    ["an unknown kind", { kind: "adjustment" }],
    ["an unknown lifecycle", { lifecycle: "deleted" }],
    ["an unknown provenance", { assignment_origin: "guessed" }],
    ["an impossible posted date", { posted_date: "2026-02-31" }],
    ["a month-13 posted date", { posted_date: "2026-13-01" }],
    ["an empty merchant text", { merchant_text: "" }],
  ];
  for (const [what, overrides] of refused) {
    it(`refuses ${what}`, () => {
      const db = open();
      expect(() => insertTransaction(db, overrides)).toThrow(/constraint failed/i);
    });
  }

  it("refuses to delete an account that still has any transaction, voided included", () => {
    const db = open();
    insertTransaction(db, { lifecycle: "void" });
    expect(() => db.prepare("DELETE FROM accounts WHERE id = ?").run(ACCOUNT)).toThrow(
      /FOREIGN KEY/i,
    );
  });
});

describe("reconciliation constraints", () => {
  function insertCheckpoint(db: SqliteDatabase, overrides: Record<string, unknown> = {}): void {
    const row = {
      id: "70000000-0000-4000-8000-000000000001",
      account_id: ACCOUNT,
      closing_date: "2026-04-30",
      statement_cents: 117000n,
      creation_digest: "b".repeat(64),
      version: 1n,
      created_at: 1750000000000n,
      updated_at: 1750000000000n,
      ...overrides,
    };
    db.prepare(
      `INSERT INTO reconciliation_checkpoints (id, account_id, closing_date, statement_cents,
         creation_digest, version, created_at, updated_at)
       VALUES (@id, @account_id, @closing_date, @statement_cents, @creation_digest, @version,
         @created_at, @updated_at)`,
    ).run(row);
  }

  it("has no status column at all", () => {
    const db = open();
    const columns = (
      db.pragma("table_info(reconciliation_checkpoints)") as { name: string }[]
    ).map((column) => column.name);
    // Status is derived on read. A stored one could go stale, which is the
    // exact failure the derived design exists to prevent.
    expect(columns).not.toContain("status");
    expect(columns).toContain("statement_cents");
  });

  it("refuses an impossible closing date", () => {
    const db = open();
    expect(() => insertCheckpoint(db, { closing_date: "2026-04-31" })).toThrow(
      /constraint failed/i,
    );
  });

  it("refuses a check whose matched flag disagrees with its difference", () => {
    const db = open();
    insertCheckpoint(db);
    const insert = (matched: number, difference: bigint): void => {
      db.prepare(
        `INSERT INTO checkpoint_checks (id, checkpoint_id, checked_at, calculated_cents,
           difference_cents, matched)
         VALUES ('80000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000001',
           1750000000000, 117000, ?, ?)`,
      ).run(difference, matched);
    };
    expect(() => insert(1, 500n)).toThrow(/constraint failed/i);
    expect(() => insert(0, 0n)).toThrow(/constraint failed/i);
    expect(() => insert(1, 0n)).not.toThrow();
  });

  it("refuses to delete an account or checkpoint that history still references", () => {
    const db = open();
    insertCheckpoint(db);
    expect(() => db.prepare("DELETE FROM accounts WHERE id = ?").run(ACCOUNT)).toThrow(
      /FOREIGN KEY/i,
    );
  });
});

describe("audit events", () => {
  it("records the account as a plain string with no foreign key, so history never blocks deletion", () => {
    const db = open();
    const foreignKeys = db.pragma("foreign_key_list(audit_events)") as unknown[];
    expect(foreignKeys).toEqual([]);

    db.prepare(
      `INSERT INTO audit_events (id, command_id, entity_type, entity_id, account_id, event_type,
         origin, reason, before_json, after_json, occurred_at)
       VALUES ('a0000000-0000-4000-8000-000000000001', NULL, 'account', ?, ?, 'account_created',
         'owner', NULL, NULL, '{"displayName":"Synthetic Everyday Checking"}', 1750000000000)`,
    ).run(ACCOUNT, ACCOUNT);

    // The account's own creation record must not stand in the way of deleting
    // a genuinely unused account, and it survives that deletion.
    expect(() => db.prepare("DELETE FROM accounts WHERE id = ?").run(ACCOUNT)).not.toThrow();
    expect(
      db.prepare("SELECT count(*) AS n FROM audit_events WHERE account_id = ?").get(ACCOUNT),
    ).toEqual({ n: 1n });
  });

  it("refuses malformed json in a recorded state", () => {
    const db = open();
    expect(() =>
      db
        .prepare(
          `INSERT INTO audit_events (id, command_id, entity_type, entity_id, account_id,
             event_type, origin, reason, before_json, after_json, occurred_at)
           VALUES ('a0000000-0000-4000-8000-000000000002', NULL, 'account', ?, NULL,
             'account_created', 'owner', NULL, NULL, 'not json', 1750000000000)`,
        )
        .run(ACCOUNT),
    ).toThrow(/constraint failed/i);
  });
});
