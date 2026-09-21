/**
 * Reconciliation status is derived on every read and never stored.
 *
 * Storing it was the obvious design and the wrong one: a later import
 * containing a transaction dated before a reconciled closing date changes that
 * balance, and a stored status would still say "reconciled". Enumerating every
 * event that can change a covered balance - imports, follow-ups, repairs,
 * voids, restores, baseline edits - would mean remembering all of them,
 * including ones nobody has thought of yet.
 *
 * Computing it from the current balance is correct by construction for every
 * cause. The cost is one balance calculation per displayed checkpoint, which
 * is small for one household.
 */

import type { SqliteDatabase } from "@workspace/db";

import { balanceAt, balancesAt, type AccountBaseline } from "./balances.js";

export type ReconciliationStatus = "reconciled" | "needs_recheck" | "difference" | "not_checked";

export interface CheckpointRow {
  id: string;
  account_id: string;
  closing_date: string;
  statement_cents: bigint;
  version: bigint;
  created_at: bigint;
}

export interface CheckRow {
  id: string;
  checked_at: bigint;
  calculated_cents: bigint;
  difference_cents: bigint;
  matched: bigint;
}

export interface CheckpointState {
  checkpoint: CheckpointRow;
  latestCheck: CheckRow | null;
  status: ReconciliationStatus;
  currentBalance: bigint | null;
  currentDifference: bigint | null;
}

/**
 * The latest check for every checkpoint on an account, in one query rather
 * than one per checkpoint.
 *
 * "Latest" means recorded last, which is insertion order (`rowid`): checks are
 * append-only, so it only ever grows. Ordering by `checked_at` and then by the
 * random id picked the older of two same-millisecond checks about half the
 * time, and would be fooled by a clock stepping back (stage 2 review).
 */
export function latestChecks(
  db: SqliteDatabase,
  accountId: string,
): Map<string, CheckRow> {
  const rows = db
    .prepare(
      `SELECT id, checkpoint_id, checked_at, calculated_cents, difference_cents, matched
       FROM (
         SELECT id, checkpoint_id, checked_at, calculated_cents, difference_cents, matched,
                ROW_NUMBER() OVER (
                  PARTITION BY checkpoint_id ORDER BY rowid DESC
                ) AS rank_in_checkpoint
         FROM checkpoint_checks
         WHERE checkpoint_id IN (SELECT id FROM reconciliation_checkpoints WHERE account_id = ?)
       )
       WHERE rank_in_checkpoint = 1`,
    )
    .all(accountId) as (CheckRow & { checkpoint_id: string })[];

  return new Map(rows.map((row) => [row.checkpoint_id, row]));
}

export function latestCheck(db: SqliteDatabase, checkpointId: string): CheckRow | null {
  const row = db
    .prepare(
      `SELECT id, checked_at, calculated_cents, difference_cents, matched
       FROM checkpoint_checks WHERE checkpoint_id = ?
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(checkpointId) as CheckRow | undefined;
  return row ?? null;
}

export function checkpointState(
  db: SqliteDatabase,
  account: AccountBaseline,
  checkpoint: CheckpointRow,
): CheckpointState {
  const check = latestCheck(db, checkpoint.id);
  const { balance } = balanceAt(db, account, checkpoint.closing_date);

  return {
    checkpoint,
    latestCheck: check,
    status: deriveStatus(checkpoint, check, balance),
    currentBalance: balance,
    currentDifference: balance === null ? null : balance - checkpoint.statement_cents,
  };
}

export function deriveStatus(
  checkpoint: CheckpointRow,
  check: CheckRow | null,
  currentBalance: bigint | null,
): ReconciliationStatus {
  if (check === null) return "not_checked";
  if (check.matched !== 1n) return "difference";
  // It matched when it was checked. It only stays reconciled while the
  // balance for that closing date is still the one that was compared - and a
  // date that has fallen outside coverage has no balance at all, so it
  // certainly is not still the same.
  if (currentBalance === null) return "needs_recheck";
  return currentBalance === check.calculated_cents ? "reconciled" : "needs_recheck";
}

/**
 * The state of every checkpoint on an account, computed together: one query
 * for the checkpoints, one for their latest checks, and one scan for all the
 * balances.
 */
export function checkpointStates(
  db: SqliteDatabase,
  account: AccountBaseline,
): CheckpointState[] {
  const checkpoints = db
    .prepare(
      `SELECT id, account_id, closing_date, statement_cents, version, created_at
       FROM reconciliation_checkpoints WHERE account_id = ?
       ORDER BY closing_date DESC, id DESC`,
    )
    .all(account.id) as CheckpointRow[];
  if (checkpoints.length === 0) return [];

  const checks = latestChecks(db, account.id);
  const balances = balancesAt(
    db,
    account,
    checkpoints.map((checkpoint) => checkpoint.closing_date),
  );

  return checkpoints.map((checkpoint) => {
    const check = checks.get(checkpoint.id) ?? null;
    const balance = balances.get(checkpoint.closing_date) ?? null;
    return {
      checkpoint,
      latestCheck: check,
      status: deriveStatus(checkpoint, check, balance),
      currentBalance: balance,
      currentDifference: balance === null ? null : balance - checkpoint.statement_cents,
    };
  });
}

export interface AccountReconciliation {
  latestStatus: ReconciliationStatus | null;
  needsRecheckCount: number;
  differenceCount: number;
}

/** The reconciliation summary carried on every account representation. */
export function accountReconciliation(
  db: SqliteDatabase,
  account: AccountBaseline,
): AccountReconciliation {
  const states = checkpointStates(db, account);

  let needsRecheckCount = 0;
  let differenceCount = 0;
  for (const state of states) {
    if (state.status === "needs_recheck") needsRecheckCount += 1;
    if (state.status === "difference") differenceCount += 1;
  }

  return {
    // Checkpoints come back newest closing date first.
    latestStatus: states.length === 0 ? null : states[0].status,
    needsRecheckCount,
    differenceCount,
  };
}
