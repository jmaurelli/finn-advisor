/**
 * The whole logical ledger as one JSON document.
 *
 * An **explicit allowlist**, assembled from one read snapshot. Every
 * collection is built with the same DTO builder the API itself serves, so a
 * record cannot read one way through the API and another way in the export -
 * that drift is the whole reason the builders are shared rather than
 * reimplemented here.
 *
 * What is deliberately absent, and why listing it matters: raw uploaded files,
 * password hashes, sessions, CSRF material, request digests, credentials, keys
 * and filesystem paths. An allowlist rather than a denylist means a table
 * added later is absent by default instead of leaking by default.
 *
 * This is not a backup. There is no reimport, and nothing here is sufficient
 * to reconstruct the database; it is for the owner to read, keep, or move into
 * another tool.
 */
import type { SqliteDatabase } from "@workspace/db";
import { accountDto, listAccounts } from "./accounts.js";
import { checkpointDtos } from "./checkpoints.js";
import { budgetPlanDto } from "./budget-plans.js";
import { categoryDto, listCategories, type CategoryRow } from "./categories.js";
import { importBatchDto, type ImportBatchRow } from "./imports.js";
import { importRowDto, type StoredImportRow } from "./import-review.js";
import { refundLinkDto, requireRefundLink, requirePair, transferPairDto } from "./links.js";
import { assignmentCounts, listRules, ruleDto } from "./rules.js";
import { ruleHistory } from "./rules.js";
import { getRuleRun } from "./rule-runs.js";
import { preferencesDto, readPreferencesRow } from "./preferences.js";
import { historyEventDto } from "./transaction-history.js";
import { transactionDto, type TransactionRow } from "./transactions.js";
import { isoTimestamp } from "../lib/clock.js";

export const LEDGER_EXPORT_FORMAT_VERSION = 1;

/**
 * The readers order for their own screens; the export orders by id so two
 * exports of unchanged data are byte-identical and can be diffed.
 */
const sortById = <T extends { id: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

interface HistoryRow {
  id: string;
  transaction_id: string;
  occurred_at: bigint;
  event_type: string;
  source: string;
  reason: string | null;
  before_json: string | null;
  after_json: string | null;
  rule_id: string | null;
  rule_revision: bigint | null;
  related_ids_json: string;
}

/**
 * Reads every collection inside one transaction, which is what makes the
 * document internally consistent: a transfer pair cannot name a transaction
 * the transactions array does not contain.
 *
 * Ordering is deterministic throughout - by id, or by the natural key where
 * one exists - so two exports of unchanged data are byte-identical and can be
 * diffed.
 */
export function exportLedger(db: SqliteDatabase, now: number, today: string): Record<string, unknown> {
  return db.transaction((): Record<string, unknown> => {
    // Every collection comes from the reader the API itself uses. A direct
    // `SELECT * FROM rules` looked equivalent and was not: a rule's
    // configuration lives in `rule_revisions`, joined at its current
    // revision, so the rows arrived without a pattern or a match type and the
    // export silently omitted them. The same applies to accounts, whose
    // reader selects an explicit column list.
    const accounts = sortById(listAccounts(db, "all"));
    const categories = sortById(listCategories(db, "all"));
    const rules = sortById(listRules(db, "all"));
    const counts = assignmentCounts(db);
    const transactions = db.prepare("SELECT * FROM transactions ORDER BY posted_date, id")
      .all() as TransactionRow[];
    const events = db.prepare("SELECT * FROM assignment_events ORDER BY occurred_at, id")
      .all() as HistoryRow[];
    const pairIds = db.prepare("SELECT id FROM transfer_pairs ORDER BY id").all() as { id: string }[];
    const refundIds = db.prepare("SELECT id FROM refund_links ORDER BY id").all() as { id: string }[];
    const runs = db.prepare("SELECT id FROM rule_runs ORDER BY id").all() as { id: string }[];
    const batches = db.prepare("SELECT * FROM import_batches ORDER BY created_at, id")
      .all() as ImportBatchRow[];
    const importRows = db.prepare("SELECT * FROM import_rows ORDER BY import_id, source_row_number")
      .all() as (StoredImportRow & { import_id: string })[];

    const planned = new Set((db.prepare("SELECT category_id FROM budget_plans").all() as
      { category_id: string }[]).map(row => row.category_id));

    const rowsByImport = new Map<string, StoredImportRow[]>();
    for (const row of importRows) {
      const list = rowsByImport.get(row.import_id);
      if (list === undefined) rowsByImport.set(row.import_id, [row]);
      else list.push(row);
    }

    return {
      formatVersion: LEDGER_EXPORT_FORMAT_VERSION,
      exportedAt: isoTimestamp(now),
      currency: "USD",
      timezone: "America/New_York",
      preferences: preferencesDto(readPreferencesRow(db)),
      accounts: accounts.map(row => accountDto(db, row, today)),
      checkpoints: accounts.flatMap(account => checkpointDtos(db, account)),
      transactions: transactions.map(row => transactionDto(db, row)),
      transactionHistory: events.map(historyEventDto),
      transferPairs: pairIds.map(pair => transferPairDto(db, requirePair(db, pair.id))),
      refundLinks: refundIds.map(link => refundLinkDto(requireRefundLink(db, link.id))),
      categories: categories.map(categoryDto),
      rules: rules.map(row => ruleDto(row, counts.get(row.id) ?? 0n)),
      ruleHistory: rules.map(row => ruleHistory(db, row)),
      // A run's own reader resolves its counts and expiry; reusing it keeps
      // the export honest about an expired preview rather than inventing a
      // status for it here.
      ruleRuns: runs.map(run => getRuleRun(db, run.id, now)),
      // Only categories that actually carry a plan. `budget_plans` is the
      // record of that, so an untouched category is absent rather than
      // exported as an empty schedule.
      budgetPlans: categories.filter(category => planned.has(category.id))
        .map(category => budgetPlanDto(db, category)),
      imports: batches.map(batch => ({
        batch: importBatchDto(db, batch),
        // Whatever survived: a discarded or expired preview has had its
        // unposted rows deleted already, so this is the retained history
        // rather than a reconstruction of what was once there.
        rows: (rowsByImport.get(batch.id) ?? []).map(importRowDto),
      })),
    };
  })();
}

