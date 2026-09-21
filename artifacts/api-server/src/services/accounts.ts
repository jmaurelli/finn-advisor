/**
 * Account commands.
 *
 * Every mutation runs inside one `BEGIN IMMEDIATE` write transaction, takes
 * the write intent before reading state it is about to change, and advances
 * the versions and revisions the browser uses to detect staleness.
 */

import type { SqliteDatabase } from "@workspace/db";

import { assertCalendarDate, compareDates } from "../domain/dates.js";
import { creationDigest } from "../domain/digest.js";
import { money, parseMoney, STORED_BOUND } from "../domain/money.js";
import { nextCounter } from "../domain/versions.js";
import { problem, type BlockingReference } from "../lib/problem.js";
import {
  accountDto,
  ACCOUNT_COLUMNS,
  bumpFinanceRevision,
  findAccount,
  requireActiveAccount,
  writeAudit,
  type AccountRow,
} from "./ledger.js";

export interface CreateAccountInput {
  id: string;
  kind: string;
  providerKey: string;
  displayName: string;
  maskedSuffix?: string | null;
  trackingStartDate: string;
  openingBalance: unknown;
}

export interface CommandContext {
  db: SqliteDatabase;
  now: number;
  today: string;
  newId: () => string;
}

/**
 * A tracking start is the day the owner's records begin, and its opening
 * balance is the closing balance of the day before. Neither can be in the
 * future: there is no closing balance for a day that has not happened, and
 * accepting one would make every account's "current balance" a guess.
 */
function assertNotInTheFuture(date: string, today: string, path: string): void {
  if (compareDates(date, today) > 0) {
    throw problem({
      status: 422,
      code: "validation_failed",
      title: "That start date is in the future",
      detail: "Records can only start on a day that has already happened.",
      fieldErrors: [
        { path, code: "invalid_value", message: "Choose today or an earlier date." },
      ],
    });
  }
}

/**
 * The contract only requires one character, so a name of nothing but spaces
 * passes the schema and would then hit the database constraint as a 500.
 * It is a plain validation failure (stage 2 review).
 */
function assertVisibleName(name: string, path: string): void {
  if (/\S/u.test(name)) return;
  throw problem({
    status: 422,
    code: "validation_failed",
    title: "Name needed",
    detail: "Give the account a name.",
    fieldErrors: [{ path, code: "invalid_value", message: "Enter a name, not only spaces." }],
  });
}

function assertKnownDate(value: string, path: string): string {
  try {
    return assertCalendarDate(value);
  } catch {
    throw problem({
      status: 422,
      code: "validation_failed",
      title: "That date does not exist",
      detail: "Check the date and try again.",
      fieldErrors: [{ path, code: "invalid_value", message: "Not a real calendar date." }],
    });
  }
}

export function createAccount(context: CommandContext, input: CreateAccountInput): {
  status: 200 | 201;
  row: AccountRow;
} {
  const { db, now } = context;
  const digest = creationDigest({
    kind: input.kind,
    providerKey: input.providerKey,
    displayName: input.displayName,
    maskedSuffix: input.maskedSuffix ?? null,
    trackingStartDate: input.trackingStartDate,
    openingBalance: money(parseMoney(input.openingBalance)).amountMinor,
  });

  // A retry of a create the owner already made returns what it made. The same
  // id with different content is a genuine conflict, not a retry.
  const existing = findAccount(db, input.id);
  if (existing !== undefined) {
    if (existing.creation_digest === digest) return { status: 200, row: existing };
    throw problem({
      status: 409,
      code: "client_id_conflict",
      title: "Already used for something else",
      detail: "This create was already saved with different values. Reload before trying again.",
    });
  }

  assertVisibleName(input.displayName, "/displayName");
  const trackingStartDate = assertKnownDate(input.trackingStartDate, "/trackingStartDate");
  assertNotInTheFuture(trackingStartDate, context.today, "/trackingStartDate");
  const openingCents = parseMoney(input.openingBalance, STORED_BOUND);

  db.prepare(
    `INSERT INTO accounts (id, kind, provider_key, display_name, masked_suffix,
       tracking_start_date, opening_cents, archived_at, creation_digest, version,
       ledger_revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, ?)`,
  ).run(
    input.id,
    input.kind,
    input.providerKey,
    input.displayName,
    input.maskedSuffix ?? null,
    trackingStartDate,
    openingCents,
    digest,
    now,
    now,
  );

  writeAudit(db, context.newId, now, {
    entityType: "account",
    entityId: input.id,
    accountId: input.id,
    eventType: "account_created",
    after: {
      kind: input.kind,
      displayName: input.displayName,
      trackingStartDate,
      openingBalance: money(openingCents),
    },
  });
  bumpFinanceRevision(db);

  const row = findAccount(db, input.id);
  if (row === undefined) throw new Error("account disappeared immediately after insert");
  return { status: 201, row };
}

export interface UpdateAccountInput {
  displayName?: string;
  maskedSuffix?: string | null;
  providerKey?: string;
}

export function updateAccount(
  context: CommandContext,
  account: AccountRow,
  patch: UpdateAccountInput,
): AccountRow {
  const { db, now } = context;
  requireActiveAccount(account);
  if (patch.displayName !== undefined) assertVisibleName(patch.displayName, "/displayName");

  const next = {
    display_name: patch.displayName ?? account.display_name,
    masked_suffix: patch.maskedSuffix === undefined ? account.masked_suffix : patch.maskedSuffix,
    provider_key: patch.providerKey ?? account.provider_key,
    version: nextCounter(account.version),
  };

  db.prepare(
    `UPDATE accounts SET display_name = ?, masked_suffix = ?, provider_key = ?, version = ?,
       updated_at = ? WHERE id = ?`,
  ).run(
    next.display_name,
    next.masked_suffix,
    next.provider_key,
    next.version,
    now,
    account.id,
  );

  writeAudit(db, context.newId, now, {
    entityType: "account",
    entityId: account.id,
    accountId: account.id,
    eventType: "account_updated",
    before: {
      displayName: account.display_name,
      maskedSuffix: account.masked_suffix,
      providerKey: account.provider_key,
    },
    after: {
      displayName: next.display_name,
      maskedSuffix: next.masked_suffix,
      providerKey: next.provider_key,
    },
  });
  bumpFinanceRevision(db);

  return reload(db, account.id);
}

/**
 * Archiving and reactivating are both idempotent: asking for the state
 * something is already in returns it unchanged rather than failing, so a
 * retried click is never an error.
 */
export function setArchived(
  context: CommandContext,
  account: AccountRow,
  archived: boolean,
): AccountRow {
  const { db, now } = context;
  const already = (account.archived_at !== null) === archived;
  if (already) return account;

  const version = nextCounter(account.version);
  db.prepare("UPDATE accounts SET archived_at = ?, version = ?, updated_at = ? WHERE id = ?").run(
    archived ? now : null,
    version,
    now,
    account.id,
  );

  writeAudit(db, context.newId, now, {
    entityType: "account",
    entityId: account.id,
    accountId: account.id,
    // Re-archiving after a repair is an ordinary archive event, with no
    // special label in history.
    eventType: archived ? "account_archived" : "account_reactivated",
    before: { status: account.archived_at === null ? "active" : "archived" },
    after: { status: archived ? "archived" : "active" },
  });
  bumpFinanceRevision(db);

  return reload(db, account.id);
}

/**
 * What stops an account being deleted.
 *
 * This is a closed allowlist, not "anything that mentions the account":
 * ordinary bookkeeping would otherwise make the approved deletion of a
 * genuinely unused account unreachable. Audit events describing the account's
 * own creation deliberately do not block, which is why they carry the account
 * id as a plain recorded string with no foreign key.
 *
 * The kinds this stage cannot check yet - imports, account-scoped rules,
 * transfer legs, source identities - are declared in `pending-stages.ts` and
 * guarded by a test that fails as soon as their tables exist.
 */
export function blockingReferences(db: SqliteDatabase, accountId: string): BlockingReference[] {
  const blocking: BlockingReference[] = [];

  // Voided transactions block too: voiding everything is not the same as
  // never having used the account.
  const transactions = db
    .prepare("SELECT id FROM transactions WHERE account_id = ? ORDER BY posted_date, id LIMIT 20")
    .all(accountId) as { id: string }[];
  const transactionCount = db
    .prepare("SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?")
    .get(accountId) as { n: bigint };
  if (transactionCount.n > 0n) {
    blocking.push({
      kind: "transaction",
      count: Number(transactionCount.n),
      ids: transactions.map((row) => row.id),
    });
  }

  const checkpoints = db
    .prepare(
      "SELECT id FROM reconciliation_checkpoints WHERE account_id = ? ORDER BY closing_date, id LIMIT 20",
    )
    .all(accountId) as { id: string }[];
  const checkpointCount = db
    .prepare("SELECT COUNT(*) AS n FROM reconciliation_checkpoints WHERE account_id = ?")
    .get(accountId) as { n: bigint };
  if (checkpointCount.n > 0n) {
    blocking.push({
      kind: "checkpoint",
      count: Number(checkpointCount.n),
      ids: checkpoints.map((row) => row.id),
    });
  }

  return blocking;
}

export function deleteAccount(context: CommandContext, account: AccountRow): void {
  const { db, now } = context;
  const blocking = blockingReferences(db, account.id);
  if (blocking.length > 0) {
    throw problem({
      status: 409,
      code: "account_in_use",
      title: "Account has history",
      detail: "Accounts with history cannot be deleted. Archive it instead.",
      blocking,
    });
  }

  db.prepare("DELETE FROM accounts WHERE id = ?").run(account.id);

  // The deletion itself is recorded, naming the account that is gone.
  writeAudit(db, context.newId, now, {
    entityType: "account",
    entityId: account.id,
    accountId: account.id,
    eventType: "account_deleted",
    before: {
      kind: account.kind,
      displayName: account.display_name,
      trackingStartDate: account.tracking_start_date,
    },
  });
  bumpFinanceRevision(db);
}

export function listAccounts(db: SqliteDatabase, status: string): AccountRow[] {
  const where =
    status === "all"
      ? ""
      : status === "archived"
        ? "WHERE archived_at IS NOT NULL"
        : "WHERE archived_at IS NULL";
  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts ${where}
       ORDER BY kind, display_name COLLATE NOCASE, id`,
    )
    .all() as AccountRow[];
}

function reload(db: SqliteDatabase, id: string): AccountRow {
  const row = findAccount(db, id);
  if (row === undefined) throw new Error("account disappeared during its own command");
  return row;
}

export { accountDto };
