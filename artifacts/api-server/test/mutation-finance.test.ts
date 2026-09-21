/**
 * Deliberate breakage, stage 2.
 *
 * Same purpose as `mutation.test.ts`: each test here runs a hand-written
 * stand-in for a broken rule and shows the scenario behaving differently. What
 * this proves is narrow: the scenario is sensitive to the rule. It does not
 * change the real code, and it is not evidence that the rest of the suite
 * would catch a real bug. The independent stage 2 review showed that
 * directly: several bugs planted in the real code survived the whole suite.
 * `review-stage2.test.ts` closes those gaps, and each was checked by planting
 * the bug in the real code and seeing the suite fail.
 */
import { describe, expect, it } from "vitest";

import { createTemporaryLedger } from "@workspace/db/testing";
import type { SqliteDatabase } from "@workspace/db";

import { balanceAt } from "../src/domain/balances.js";
import { deriveStatus, type CheckpointRow, type CheckRow } from "../src/domain/reconciliation.js";
import { activeTransactionsBefore } from "../src/domain/balances.js";

const UNCATEGORIZED = "30000000-0000-4000-8000-000000000000";
const ACCOUNT = "20000000-0000-4000-8000-000000000001";

function seed(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO accounts (id, kind, provider_key, display_name, masked_suffix,
       tracking_start_date, opening_cents, archived_at, creation_digest, version,
       ledger_revision, created_at, updated_at)
     VALUES (?, 'checking', 'chase', 'Synthetic Checking', NULL, '2026-04-01', 125000,
       NULL, ?, 1, 0, 1750000000000, 1750000000000)`,
  ).run(ACCOUNT, "a".repeat(64));
}

function post(
  db: SqliteDatabase,
  tag: number,
  postedDate: string,
  amount: bigint,
  lifecycle: "active" | "void" = "active",
): void {
  db.prepare(
    `INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
       amount_cents, kind, category_id, assignment_origin, note, lifecycle, version,
       created_at, updated_at)
     VALUES (?, ?, ?, 'SYNTHETIC', 'synthetic', ?, 'purchase', ?, 'unassigned', NULL, ?, 1,
       1750000000000, 1750000000000)`,
  ).run(
    `10000000-0000-4000-8000-${String(tag).padStart(12, "0")}`,
    ACCOUNT,
    postedDate,
    amount,
    UNCATEGORIZED,
    lifecycle,
  );
}

const baseline = { id: ACCOUNT, trackingStartDate: "2026-04-01", openingCents: 125000n };

describe("if voided rows counted toward balances", () => {
  it("the balance would change, which is what the tests assert it does not", () => {
    const ledger = createTemporaryLedger();
    try {
      seed(ledger.db);
      post(ledger.db, 1, "2026-04-02", -8000n);
      post(ledger.db, 2, "2026-04-03", -50000n, "void");

      expect(balanceAt(ledger.db, baseline, "2026-04-30").balance).toBe(117000n);

      // The mutation: the same query without the lifecycle filter.
      const withVoids = ledger.db
        .prepare(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions
           WHERE account_id = ? AND posted_date >= ? AND posted_date <= ?`,
        )
        .get(ACCOUNT, "2026-04-01", "2026-04-30") as { total: bigint };
      expect(125000n + withVoids.total).toBe(67000n);
    } finally {
      ledger.close();
    }
  });
});

describe("if COALESCE were dropped from the money aggregate", () => {
  it("an empty month would report nothing instead of zero", () => {
    const ledger = createTemporaryLedger();
    try {
      seed(ledger.db);

      expect(balanceAt(ledger.db, baseline, "2026-04-30").balance).toBe(125000n);

      // The mutation: SUM() over zero rows is NULL in SQLite, not 0. Without
      // COALESCE an account with no transactions reports a missing balance.
      const raw = ledger.db
        .prepare(
          `SELECT SUM(amount_cents) AS total FROM transactions
           WHERE account_id = ? AND lifecycle = 'active'`,
        )
        .get(ACCOUNT) as { total: bigint | null };
      expect(raw.total).toBeNull();
    } finally {
      ledger.close();
    }
  });
});

describe("if TOTAL() were used instead of SUM()", () => {
  it("cents would be lost silently rather than kept exact", () => {
    const ledger = createTemporaryLedger();
    try {
      seed(ledger.db);

      // No single row can be large enough: the per-value bound refuses it,
      // which is the schema working. Reaching the range where a float starts
      // losing cents takes about ninety thousand rows, and an odd total.
      const rows = 90100;
      const each = 99999999999n;
      const insert = ledger.db.prepare(
        `INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
           amount_cents, kind, category_id, assignment_origin, note, lifecycle, version,
           created_at, updated_at)
         VALUES (?, ?, '2026-04-02', 'SYNTHETIC', 'synthetic', ?, 'refund', ?, 'manual', NULL,
           'active', 1, 1750000000000, 1750000000000)`,
      );
      ledger.db.exec("BEGIN IMMEDIATE");
      for (let index = 0; index < rows; index += 1) {
        insert.run(
          `10000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
          ACCOUNT,
          each,
          UNCATEGORIZED,
        );
      }
      insert.run(`10000000-0000-4000-9000-${String(rows).padStart(12, "0")}`, ACCOUNT, 1n, UNCATEGORIZED);
      ledger.db.exec("COMMIT");

      const expected = each * BigInt(rows) + 1n + 125000n;
      expect(expected % 2n).toBe(1n);
      expect(expected).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));

      const exact = balanceAt(ledger.db, baseline, "2026-04-30").balance;
      expect(exact).toBe(expected);

      // The mutation: TOTAL() is defined to return a float, and at this
      // magnitude a float cannot hold an odd value. It reports a total that
      // is wrong, with no error of any kind.
      const floated = ledger.db
        .prepare(
          `SELECT TOTAL(amount_cents) AS total FROM transactions
           WHERE account_id = ? AND lifecycle = 'active'`,
        )
        .get(ACCOUNT) as { total: number };
      expect(typeof floated.total).toBe("number");
      expect(BigInt(floated.total) + 125000n).not.toBe(exact);
    } finally {
      ledger.close();
    }
  });
});

describe("if moving the start later did not check for active earlier rows", () => {
  it("a transaction would drop out of the balance while still counting as spending", () => {
    const ledger = createTemporaryLedger();
    try {
      seed(ledger.db);
      post(ledger.db, 1, "2026-04-02", -8000n);

      // The real guard finds it and the command refuses.
      expect(activeTransactionsBefore(ledger.db, ACCOUNT, "2026-04-10").count).toBe(1);

      // The mutation: move the start anyway. The row still counts as spending
      // for April, but the balance no longer includes it - the exact silent
      // inconsistency the check exists to prevent.
      const moved = { ...baseline, trackingStartDate: "2026-04-10", openingCents: 117000n };
      expect(balanceAt(ledger.db, moved, "2026-04-30").balance).toBe(117000n);
      const spending = ledger.db
        .prepare(
          `SELECT COALESCE(SUM(-amount_cents), 0) AS total FROM transactions
           WHERE lifecycle = 'active' AND kind = 'purchase'
             AND posted_date >= '2026-04-01' AND posted_date < '2026-05-01'`,
        )
        .get() as { total: bigint };
      expect(spending.total).toBe(8000n);
      // Spending says $80 happened; the balance counts no movement at all
      // since the new start, as if it never did.
      const counted = balanceAt(ledger.db, moved, "2026-04-30").balance! - moved.openingCents;
      expect(counted).toBe(0n);
      expect(counted).not.toBe(-spending.total);
    } finally {
      ledger.close();
    }
  });
});

describe("if reconciliation status were stored instead of derived", () => {
  it("a later import would leave a stale 'reconciled' behind", () => {
    const checkpoint: CheckpointRow = {
      id: "70000000-0000-4000-8000-000000000001",
      account_id: ACCOUNT,
      closing_date: "2026-04-30",
      statement_cents: 117000n,
      version: 1n,
      created_at: 1750000000000n,
    };
    const matchedCheck: CheckRow = {
      id: "80000000-0000-4000-8000-000000000001",
      checked_at: 1750000000000n,
      calculated_cents: 117000n,
      difference_cents: 0n,
      matched: 1n,
    };

    // Derived from the balance as it is now.
    expect(deriveStatus(checkpoint, matchedCheck, 117000n)).toBe("reconciled");
    expect(deriveStatus(checkpoint, matchedCheck, 114500n)).toBe("needs_recheck");
    expect(deriveStatus(checkpoint, matchedCheck, null)).toBe("needs_recheck");

    // The mutation: a stored status, written once when the check matched. It
    // keeps saying "reconciled" whatever the balance does afterwards.
    const stored = matchedCheck.matched === 1n ? "reconciled" : "difference";
    expect(stored).toBe("reconciled");
    expect(stored).not.toBe(deriveStatus(checkpoint, matchedCheck, 114500n));
  });
});
