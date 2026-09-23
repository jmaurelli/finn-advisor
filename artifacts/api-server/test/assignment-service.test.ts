import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";

import { assignByRules, currentRuleAssignmentCount, loadAssignmentRules } from "../src/services/assignment.js";
import { normalizeRulePattern } from "../src/domain/assignment.js";
import { ProblemError } from "../src/lib/problem.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, UNCATEGORIZED, uuid } from "./finance-harness.js";

let api: TestServer;
let accountId: string;
const NOW = 1770000000000;
const CATEGORY = uuid(30, "30000000");
const RULE_A = "60000000-0000-4000-8000-00000000000a";
const RULE_B = "60000000-0000-4000-8000-00000000000b";

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  accountId = (await createAccount(api, { id: "20000000-0000-4000-8000-00000000000a" })).id;
  api.db.prepare(`INSERT INTO categories (id, display_name, normalized_name, color, protected,
    version, created_at, updated_at) VALUES (?, 'Food', 'food', '#112233', 0, 1, ?, ?)`)
    .run(CATEGORY, NOW, NOW);
});
afterEach(async () => { await api.close(); });

// These fixtures test the read/evaluation service, not the still-pending rule commands or posting service.
function addRule(id: string, position: number, enabled = true, pattern = "Market"): void {
  withWriteTransaction(api.db, () => {
    api.db.prepare(`INSERT INTO rules (id, position, revision, creation_digest, version, created_at, updated_at)
      VALUES (?, ?, 1, ?, 1, ?, ?)`).run(id, position, "a".repeat(64), NOW, NOW);
    api.db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern,
      normalized_pattern, account_id, applies_to, category_id, category_name, enabled, changed_at)
      VALUES (?, 1, 'created', 'contains', ?, ?, NULL, 'purchases_and_refunds', ?, 'Food', ?, ?)`)
      .run(id, pattern, normalizeRulePattern(pattern), CATEGORY, enabled ? 1 : 0, NOW);
  });
}

function nextRevision(id: string, enabled: boolean): void {
  withWriteTransaction(api.db, () => {
    api.db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern,
      normalized_pattern, account_id, applies_to, category_id, category_name, enabled, changed_at)
      SELECT rule_id, revision + 1, ?, match_type, pattern, normalized_pattern, account_id,
        applies_to, category_id, category_name, ?, changed_at + 1
      FROM rule_revisions WHERE rule_id = ? AND revision = (SELECT revision FROM rules WHERE id = ?)`)
      .run(enabled ? "enabled" : "disabled", enabled ? 1 : 0, id, id);
    api.db.prepare("UPDATE rules SET revision = revision + 1 WHERE id = ?").run(id);
  });
}

function assign() {
  return assignByRules(api.db, { accountId: accountId.toUpperCase(), kind: "purchase", merchantText: " SYNTHETIC\tMARKET " });
}

describe("persisted deterministic assignment", () => {
  it("orders by priority, not insertion or UUID, and selects the current revision", () => {
    addRule(RULE_A, 2);
    addRule(RULE_B, 1);
    nextRevision(RULE_B, true);
    expect(loadAssignmentRules(api.db).map((r) => r.id)).toEqual([RULE_B, RULE_A]);
    expect(assign()).toEqual({ origin: "rule", categoryId: CATEGORY, ruleId: RULE_B, ruleRevision: 2n });
    const financeBefore = api.db.prepare("SELECT finance_revision FROM ledger_metadata").get();
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
    expect(assign().ruleId).toBe(RULE_B);
    expect(api.db.prepare("SELECT finance_revision FROM ledger_metadata").get()).toEqual(financeBefore);
  });

  it("excludes disabled and archived rules even when old revisions were enabled", () => {
    addRule(RULE_A, 1);
    addRule(RULE_B, 2);
    nextRevision(RULE_A, false);
    expect(assign().ruleId).toBe(RULE_B);
    api.db.prepare("UPDATE rules SET archived_at = ?, position = NULL WHERE id = ?").run(NOW, RULE_B);
    expect(loadAssignmentRules(api.db)).toEqual([]);
    expect(assign()).toEqual({ origin: "unassigned", categoryId: UNCATEGORIZED, ruleId: null, ruleRevision: null });
  });

  it("never revives disabled rules when their category is reactivated", () => {
    addRule(RULE_A, 1, false);
    api.db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(NOW, CATEGORY);
    expect(loadAssignmentRules(api.db)).toEqual([]);
    api.db.prepare("UPDATE categories SET archived_at = NULL WHERE id = ?").run(CATEGORY);
    expect(loadAssignmentRules(api.db)).toEqual([]);
    nextRevision(RULE_A, true);
    expect(assign().ruleId).toBe(RULE_A);
  });

  it("independently excludes an archived category even if its enabled rule survives", () => {
    addRule(RULE_A, 1);
    addRule(RULE_B, 2);
    const eligibleCategory = uuid(31, "30000000");
    api.db.prepare(`INSERT INTO categories (id, display_name, normalized_name, color, protected,
      version, created_at, updated_at) VALUES (?, 'Dining', 'dining', '#112233', 0, 1, ?, ?)`)
      .run(eligibleCategory, NOW, NOW);
    api.db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern,
      normalized_pattern, account_id, applies_to, category_id, category_name, enabled, changed_at)
      VALUES (?, 2, 'retargeted', 'contains', 'Market', 'market', NULL,
        'purchases_and_refunds', ?, 'Dining', 1, ?)`)
      .run(RULE_B, eligibleCategory, NOW);
    api.db.prepare("UPDATE rules SET revision = 2 WHERE id = ?").run(RULE_B);

    // Valid commands cannot leave an enabled rule pointing at an archived category.
    // Temporarily bypass that backstop to isolate the query's independent defense,
    // then roll back both the invalid fixture and the trigger removal.
    const rollback = new Error("roll back deliberately invalid category fixture");
    expect(() => withWriteTransaction(api.db, () => {
      api.db.exec("DROP TRIGGER categories_resolve_rules_before_archive");
      api.db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(NOW, CATEGORY);
      expect(loadAssignmentRules(api.db).map((r) => r.id)).toEqual([RULE_B]);
      expect(assign().ruleId).toBe(RULE_B);
      throw rollback;
    })).toThrow(rollback);
    expect(assign().ruleId).toBe(RULE_A);
    expect(api.db.prepare("SELECT name FROM sqlite_schema WHERE name = 'categories_resolve_rules_before_archive'").get())
      .toEqual({ name: "categories_resolve_rules_before_archive" });
  });

  it("retains source bounds while matching a normalized value longer than the source cap", () => {
    addRule(RULE_A, 1, true, "\ufb03".repeat(256));
    expect(assignByRules(api.db, {
      accountId, kind: "purchase", merchantText: "\ufb03".repeat(2000),
    }).ruleId).toBe(RULE_A);
  });

  it("preserves manual Uncategorized and does not write a new assignment", () => {
    addRule(RULE_A, 1);
    const current = { origin: "manual" as const, categoryId: UNCATEGORIZED, ruleId: null, ruleRevision: null };
    expect(assignByRules(api.db, { accountId, kind: "refund", merchantText: "Market", current })).toEqual(current);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM assignment_events").get()).toEqual({ n: 0n });
  });

  it("refuses rule evaluation for archived accounts and unknown accounts", () => {
    addRule(RULE_A, 1);
    api.db.prepare("UPDATE accounts SET archived_at = ? WHERE id = ?").run(NOW, accountId);
    try {
      assign();
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).problem).toMatchObject({ status: 409, code: "reactivation_required" });
    }
    expect(() => assignByRules(api.db, { accountId: uuid(999), kind: "purchase", merchantText: "Market" }))
      .toThrow(ProblemError);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM transactions").get()).toEqual({ n: 0n });
  });

  it("counts retained revisions, excluding voids and manual rows but not archived accounts", () => {
    addRule(RULE_A, 1);
    const first = postTransaction(api.db, { accountId, postedDate: "2026-04-01", amountMinor: "-100" });
    const second = postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-200" });
    const voided = postTransaction(api.db, { accountId, postedDate: "2026-04-03", amountMinor: "-300", lifecycle: "void" });
    postTransaction(api.db, { accountId, postedDate: "2026-04-04", amountMinor: "-400", categoryId: CATEGORY, origin: "manual" });
    const setRule = api.db.prepare(`UPDATE transactions SET category_id = ?, assignment_origin = 'rule',
      rule_id = ?, rule_revision = ? WHERE id = ?`);
    setRule.run(CATEGORY, RULE_A, 1, first);
    nextRevision(RULE_A, true);
    setRule.run(CATEGORY, RULE_A, 2, second);
    setRule.run(CATEGORY, RULE_A, 2, voided);
    expect(currentRuleAssignmentCount(api.db, RULE_A.toUpperCase())).toBe(2n);
    api.db.prepare("UPDATE accounts SET archived_at = ? WHERE id = ?").run(NOW, accountId);
    expect(currentRuleAssignmentCount(api.db, RULE_A)).toBe(2n);
    api.db.prepare(`UPDATE transactions SET assignment_origin = 'manual', rule_id = NULL, rule_revision = NULL
      WHERE id = ?`).run(first);
    expect(currentRuleAssignmentCount(api.db, RULE_A)).toBe(1n);
    expect(currentRuleAssignmentCount(api.db, RULE_B)).toBe(0n);
  });
});
