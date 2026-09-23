import type { SqliteDatabase } from "@workspace/db";

import {
  evaluateAssignment,
  normalizeMerchantText,
  type Assignment,
  type AssignmentRule,
  type TransactionKind,
} from "../domain/assignment.js";
import { requireAccount, requireActiveAccount } from "./ledger.js";

/** Read in the caller's snapshot; no independent transaction or assignment writes. */
export function loadAssignmentRules(db: SqliteDatabase): AssignmentRule[] {
  const rows = db.prepare(`
    SELECT r.id, r.revision, r.position, v.match_type AS matchType,
      v.normalized_pattern AS normalizedPattern, v.account_id AS accountId,
      v.applies_to AS appliesTo, v.category_id AS categoryId
    FROM rules r
    JOIN rule_revisions v ON v.rule_id = r.id AND v.revision = r.revision
    JOIN categories c ON c.id = v.category_id
    WHERE r.archived_at IS NULL AND v.enabled = 1
      AND c.archived_at IS NULL AND c.system_kind IS NULL
    ORDER BY r.position, r.id
  `).all() as AssignmentRule[];
  return rows;
}

/** For posting and explicit rule evaluation, never for manual category edits. */
export function assignByRules(
  db: SqliteDatabase,
  input: { accountId: string; kind: TransactionKind; merchantText: string; current?: Assignment },
): Assignment {
  const accountId = input.accountId.toLowerCase();
  requireActiveAccount(requireAccount(db, accountId));
  return evaluateAssignment({
    accountId,
    kind: input.kind,
    normalizedMerchant: normalizeMerchantText(input.merchantText),
    current: input.current,
  }, loadAssignmentRules(db));
}

export function currentRuleAssignmentCount(db: SqliteDatabase, ruleId: string): bigint {
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM transactions
    WHERE rule_id = ? AND assignment_origin = 'rule' AND lifecycle = 'active'
  `).get(ruleId.toLowerCase()) as { count: bigint };
  return row.count;
}
