/**
 * Reconciliation checkpoints.
 *
 * A checkpoint is what the statement said: a closing date and the balance the
 * bank printed. The app never overwrites that, never adjusts the ledger to
 * make it agree, and never claims a match that is no longer true. Each
 * explicit comparison is appended, so the history of what was checked and when
 * survives every later change.
 */

import type { SqliteDatabase } from "@workspace/db";

import { balanceAt } from "../domain/balances.js";
import { assertCalendarDate, compareDates, dayBefore } from "../domain/dates.js";
import { aggregateMoney, money, parseMoney, STORED_BOUND } from "../domain/money.js";
import { creationDigest } from "../domain/digest.js";
import { formatCounter, nextCounter } from "../domain/versions.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import {
  baselineOf,
  bumpFinanceRevision,
  requireActiveAccount,
  writeAudit,
  type AccountRow,
} from "./ledger.js";
import {
  checkpointState,
  checkpointStates,
  type CheckpointRow,
  type CheckRow,
} from "../domain/reconciliation.js";
import type { CommandContext } from "./accounts.js";

const CHECKPOINT_COLUMNS = `id, account_id, closing_date, statement_cents, version, created_at`;

export function findCheckpoint(
  db: SqliteDatabase,
  accountId: string,
  checkpointId: string,
): CheckpointRow | undefined {
  return db
    .prepare(
      `SELECT ${CHECKPOINT_COLUMNS} FROM reconciliation_checkpoints
       WHERE id = ? AND account_id = ?`,
    )
    .get(checkpointId, accountId) as CheckpointRow | undefined;
}

export function requireCheckpoint(
  db: SqliteDatabase,
  accountId: string,
  checkpointId: string,
): CheckpointRow {
  const row = findCheckpoint(db, accountId, checkpointId);
  if (row === undefined) {
    throw problem({
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "There is no statement check with that id on this account.",
    });
  }
  return row;
}

export interface CreateCheckpointInput {
  id: string;
  closingDate: string;
  statementBalance: unknown;
}

export function createCheckpoint(
  context: CommandContext,
  account: AccountRow,
  input: CreateCheckpointInput,
): { status: 200 | 201; checkpoint: CheckpointRow } {
  const { db, now } = context;
  const statementCents = parseMoney(input.statementBalance, STORED_BOUND);
  const digest = creationDigest({
    accountId: account.id,
    closingDate: input.closingDate,
    statementBalance: money(statementCents).amountMinor,
  });

  const existing = db
    .prepare(
      `SELECT ${CHECKPOINT_COLUMNS}, creation_digest FROM reconciliation_checkpoints WHERE id = ?`,
    )
    .get(input.id) as (CheckpointRow & { creation_digest: string }) | undefined;
  if (existing !== undefined) {
    if (existing.creation_digest === digest) return { status: 200, checkpoint: existing };
    throw problem({
      status: 409,
      code: "client_id_conflict",
      title: "Already used for something else",
      detail: "This create was already saved with different values. Reload before trying again.",
    });
  }

  requireActiveAccount(account);
  const closingDate = requireClosingDate(input.closingDate, account, context.today);

  db.prepare(
    `INSERT INTO reconciliation_checkpoints (id, account_id, closing_date, statement_cents,
       creation_digest, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(input.id, account.id, closingDate, statementCents, digest, now, now);

  const checkpoint = requireCheckpoint(db, account.id, input.id);
  recordCheck(context, account, checkpoint);
  bumpFinanceRevision(db);
  return { status: 201, checkpoint };
}

/**
 * Appends one explicit comparison against the balance as it is right now. The
 * statement value and every earlier comparison are left exactly as they were.
 */
export function recordCheck(
  context: CommandContext,
  account: AccountRow,
  checkpoint: CheckpointRow,
): CheckRow {
  const { db, now } = context;
  const { balance, coverage } = balanceAt(db, baselineOf(account), checkpoint.closing_date);
  if (coverage !== "covered" || balance === null) {
    throw problem({
      status: 422,
      code: "validation_failed",
      title: "That closing date is outside what is covered",
      detail:
        "This account's records now start after that statement's closing date, so there is no balance to compare.",
      fieldErrors: [
        { path: "/closingDate", code: "invalid_value", message: "Outside the tracked range." },
      ],
    });
  }

  const difference = balance - checkpoint.statement_cents;
  const id = context.newId();
  db.prepare(
    `INSERT INTO checkpoint_checks (id, checkpoint_id, checked_at, calculated_cents,
       difference_cents, matched)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, checkpoint.id, now, balance, difference, difference === 0n ? 1 : 0);

  writeAudit(db, context.newId, now, {
    entityType: "checkpoint",
    entityId: checkpoint.id,
    accountId: account.id,
    eventType: "checkpoint_checked",
    after: {
      calculatedBalance: aggregateMoney(balance),
      matched: difference === 0n,
    },
  });

  return {
    id,
    checked_at: BigInt(now),
    calculated_cents: balance,
    difference_cents: difference,
    matched: difference === 0n ? 1n : 0n,
  };
}

export function recheck(
  context: CommandContext,
  account: AccountRow,
  checkpoint: CheckpointRow,
): CheckpointRow {
  const { db, now } = context;
  requireActiveAccount(account);
  recordCheck(context, account, checkpoint);

  // The checkpoint's own version advances so a concurrent recheck cannot be
  // applied twice against the same loaded state.
  const version = nextCounter(checkpoint.version);
  db.prepare(
    "UPDATE reconciliation_checkpoints SET version = ?, updated_at = ? WHERE id = ?",
  ).run(version, now, checkpoint.id);
  bumpFinanceRevision(db);

  return requireCheckpoint(db, account.id, checkpoint.id);
}

/**
 * A statement cannot close before the account's records begin. The day before
 * the tracking start is allowed: that day's closing balance is exactly the
 * opening balance. Nor can it close after today: a statement for a day still
 * to come would show "reconciled" against a balance that has not happened
 * (owner decision, stage 2 review).
 */
function requireClosingDate(value: string, account: AccountRow, today: string): string {
  let closingDate: string;
  try {
    closingDate = assertCalendarDate(value);
  } catch {
    throw closingDateProblem("Not a real calendar date.");
  }
  if (compareDates(closingDate, dayBefore(account.tracking_start_date)) < 0) {
    throw closingDateProblem(
      "This account's records start later than that statement's closing date.",
    );
  }
  if (compareDates(closingDate, today) > 0) {
    throw closingDateProblem("A statement cannot close after today.");
  }
  return closingDate;
}

function closingDateProblem(message: string): ReturnType<typeof problem> {
  return problem({
    status: 422,
    code: "validation_failed",
    title: "That closing date cannot be used",
    detail: message,
    fieldErrors: [{ path: "/closingDate", code: "invalid_value", message }],
  });
}

export function checkDto(check: CheckRow): unknown {
  return {
    id: check.id,
    checkedAt: isoTimestamp(Number(check.checked_at)),
    calculatedBalance: aggregateMoney(check.calculated_cents),
    matched: check.matched === 1n,
    difference: aggregateMoney(check.difference_cents),
  };
}

/** Every checkpoint on an account, newest closing date first, in one pass. */
export function checkpointDtos(db: SqliteDatabase, account: AccountRow): unknown[] {
  return checkpointStates(db, baselineOf(account)).map((state) => stateDto(state));
}

export function checkpointDto(
  db: SqliteDatabase,
  account: AccountRow,
  checkpoint: CheckpointRow,
): unknown {
  return stateDto(checkpointState(db, baselineOf(account), checkpoint));
}

function stateDto(state: ReturnType<typeof checkpointState>): unknown {
  const { checkpoint } = state;
  return {
    id: checkpoint.id,
    accountId: checkpoint.account_id,
    closingDate: checkpoint.closing_date,
    statementBalance: money(checkpoint.statement_cents),
    status: state.status,
    latestCheck: state.latestCheck === null ? null : checkDto(state.latestCheck),
    currentCalculatedBalance:
      state.currentBalance === null ? null : aggregateMoney(state.currentBalance),
    currentDifference:
      state.currentDifference === null ? null : aggregateMoney(state.currentDifference),
    version: formatCounter(checkpoint.version),
    createdAt: isoTimestamp(Number(checkpoint.created_at)),
  };
}

export function checkpointHistory(
  db: SqliteDatabase,
  checkpoint: CheckpointRow,
): unknown {
  const checks = db
    .prepare(
      `SELECT id, checked_at, calculated_cents, difference_cents, matched
       FROM checkpoint_checks WHERE checkpoint_id = ?
       ORDER BY rowid DESC`,
    )
    .all(checkpoint.id) as CheckRow[];

  return {
    checkpointId: checkpoint.id,
    accountId: checkpoint.account_id,
    closingDate: checkpoint.closing_date,
    statementBalance: money(checkpoint.statement_cents),
    checks: checks.map(checkDto),
  };
}
