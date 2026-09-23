/**
 * Changing an account's starting point.
 *
 * This looks like an ordinary edit and is not. The balance counts only rows on
 * or after the tracking start, while spending reports count every posted row,
 * so a careless baseline change can silently drop transactions out of the
 * balance while they still count as spending. Each mode below exists to make
 * that impossible rather than to offer a variation on editing a date.
 */

import type { SqliteDatabase } from "@workspace/db";

import { activeTransactionsBefore } from "../domain/balances.js";
import { assertCalendarDate, compareDates } from "../domain/dates.js";
import { money, parseMoney, STORED_BOUND } from "../domain/money.js";
import { nextCounter } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import {
  bumpFinanceRevision,
  findAccount,
  requireActiveAccount,
  writeAudit,
  type AccountRow,
} from "./ledger.js";
import type { CommandContext } from "./accounts.js";

export interface BaselineChangeInput {
  mode: "correct_opening_balance" | "move_start_later" | "extend_backward";
  trackingStartDate?: string;
  openingBalance: unknown;
  heldRows?: { importId: string; importVersion: string; rowIds: string[] } | null;
}

export interface BaselineChangeOutcome {
  account: AccountRow;
  postedTransactionIds: string[];
}

export function changeBaseline(
  context: CommandContext,
  account: AccountRow,
  input: BaselineChangeInput,
): BaselineChangeOutcome {
  const { db, now } = context;
  requireActiveAccount(account);

  const openingCents = parseMoney(input.openingBalance, STORED_BOUND);
  const before = {
    trackingStartDate: account.tracking_start_date,
    openingBalance: money(account.opening_cents),
  };

  let trackingStartDate = account.tracking_start_date;

  if (input.mode === "correct_opening_balance") {
    // Same start date, new opening amount: every later balance moves by the
    // same difference and nothing leaves coverage.
    trackingStartDate = account.tracking_start_date;
  } else {
    const requested = requireDate(input.trackingStartDate);
    assertNotInTheFuture(requested, context.today);

    if (input.mode === "move_start_later") {
      if (compareDates(requested, account.tracking_start_date) <= 0) {
        throw validationProblem(
          "That date is not later than the current start.",
          "/trackingStartDate",
        );
      }
      refuseIfActiveRowsWouldBeStranded(db, account.id, requested);
    } else {
      if (compareDates(requested, account.tracking_start_date) >= 0) {
        throw validationProblem(
          "That date is not earlier than the current start.",
          "/trackingStartDate",
        );
      }
      refuseHeldRows(input.heldRows);
    }
    trackingStartDate = requested;
  }

  const version = nextCounter(account.version);
  const ledgerRevision = nextCounter(account.ledger_revision);
  db.prepare(
    `UPDATE accounts SET tracking_start_date = ?, opening_cents = ?, version = ?,
       ledger_revision = ?, updated_at = ? WHERE id = ?`,
  ).run(trackingStartDate, openingCents, version, ledgerRevision, now, account.id);

  writeAudit(db, context.newId, now, {
    entityType: "account",
    entityId: account.id,
    accountId: account.id,
    eventType: `baseline_${input.mode}`,
    before,
    after: { trackingStartDate, openingBalance: money(openingCents) },
  });
  bumpFinanceRevision(db);

  const updated = findAccount(db, account.id);
  if (updated === undefined) throw new Error("account disappeared during a baseline change");
  // No held rows can be posted yet, so nothing was posted. When imports
  // arrive this is where their ids appear.
  return { account: updated, postedTransactionIds: [] };
}

/**
 * Moving the start later is refused while any *active* transaction is dated
 * before the new start, and the refusal names the rows. Voided rows do not
 * block: they already affect neither balance nor spending, and they remain
 * inspectable. Nothing active is ever dropped silently.
 */
function refuseIfActiveRowsWouldBeStranded(
  db: SqliteDatabase,
  accountId: string,
  newStart: string,
): void {
  const blocking = activeTransactionsBefore(db, accountId, newStart);
  if (blocking.count === 0) return;
  throw problem({
    status: 409,
    code: "active_transactions_before_start",
    title: "Transactions before the new start",
    detail: "Void these transactions first if they are wrong; nothing is dropped silently.",
    blocking: [{ kind: "transaction", count: blocking.count, ids: blocking.ids }],
  });
}

/**
 * Extending coverage backward can post held rows from an open import preview
 * in the same transaction. Imports arrive in stage 5, so no preview can exist
 * and the only honest answer is that the referenced preview is not there.
 * Ignoring the field would report success for work that was not done.
 */
function refuseHeldRows(heldRows: BaselineChangeInput["heldRows"]): void {
  if (heldRows === undefined || heldRows === null) return;
  throw problem({
    status: 422,
    code: "validation_failed",
    title: "No such import preview",
    detail: "There is no import preview to take rows from.",
    fieldErrors: [
      {
        path: "/heldRows/importId",
        code: "invalid_value",
        message: "No import preview with that id.",
      },
    ],
  });
}

function requireDate(value: string | undefined): string {
  if (value === undefined) throw validationProblem("A start date is required.", "/trackingStartDate");
  try {
    return assertCalendarDate(value);
  } catch {
    throw validationProblem("Not a real calendar date.", "/trackingStartDate");
  }
}

function assertNotInTheFuture(date: string, today: string): void {
  if (compareDates(date, today) > 0) {
    throw validationProblem("Choose today or an earlier date.", "/trackingStartDate");
  }
}

function validationProblem(message: string, path: string): ReturnType<typeof problem> {
  return problem({
    status: 422,
    code: "validation_failed",
    title: "That start date cannot be used",
    detail: message,
    fieldErrors: [{ path, code: "invalid_value", message }],
  });
}
