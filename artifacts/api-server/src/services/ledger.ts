/**
 * Shared ledger state: revisions, and the representation of an account.
 */

import type { SqliteDatabase } from "@workspace/db";

import { accountReconciliation } from "../domain/reconciliation.js";
import { aggregateMoney, money } from "../domain/money.js";
import { balanceAt, lastPostedDate, type AccountBaseline } from "../domain/balances.js";
import { dayBefore } from "../domain/dates.js";
import { formatCounter, nextCounter } from "../domain/versions.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";

export interface AccountRow {
  id: string;
  kind: string;
  provider_key: string;
  display_name: string;
  masked_suffix: string | null;
  tracking_start_date: string;
  opening_cents: bigint;
  archived_at: bigint | null;
  creation_digest: string;
  version: bigint;
  ledger_revision: bigint;
  created_at: bigint;
  updated_at: bigint;
}

export const ACCOUNT_COLUMNS = `id, kind, provider_key, display_name, masked_suffix,
  tracking_start_date, opening_cents, archived_at, creation_digest, version,
  ledger_revision, created_at, updated_at`;

export function baselineOf(row: AccountRow): AccountBaseline {
  return {
    id: row.id,
    trackingStartDate: row.tracking_start_date,
    openingCents: row.opening_cents,
  };
}

/**
 * A cheap hint telling the browser which cached screens to refetch. It never
 * rejects a request, and session activity never advances it.
 */
export function financeRevision(db: SqliteDatabase): bigint {
  const row = db.prepare("SELECT finance_revision FROM ledger_metadata WHERE id = 1").get() as {
    finance_revision: bigint;
  };
  return row.finance_revision;
}

export function bumpFinanceRevision(db: SqliteDatabase): bigint {
  const next = nextCounter(financeRevision(db));
  db.prepare("UPDATE ledger_metadata SET finance_revision = ? WHERE id = 1").run(next);
  return next;
}

export function findAccount(db: SqliteDatabase, id: string): AccountRow | undefined {
  return db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).get(id) as
    | AccountRow
    | undefined;
}

export function requireAccount(db: SqliteDatabase, id: string): AccountRow {
  const row = findAccount(db, id);
  if (row === undefined) {
    throw problem({
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "There is no account with that id.",
    });
  }
  return row;
}

/**
 * The archived-account rule, in one place (design section 12).
 *
 * On an archived account only category edits, note edits and refund/transfer
 * links are allowed. Everything else - type changes, amount or date repairs,
 * void, restore, baseline changes, imports - requires explicit reactivation
 * first. Every command path calls this, including the ones later stages add,
 * so no path can quietly apply a different rule.
 */
export function requireActiveAccount(account: AccountRow): void {
  if (account.archived_at === null) return;
  throw problem({
    status: 409,
    code: "reactivation_required",
    title: "Account is archived",
    detail: `Reactivate ${account.display_name} first. No changes were saved.`,
  });
}

export interface AccountDto {
  id: string;
  kind: string;
  providerKey: string;
  displayName: string;
  maskedSuffix: string | null;
  trackingStartDate: string;
  openingBalance: ReturnType<typeof money>;
  status: string;
  archivedAt: string | null;
  currentBalance: ReturnType<typeof aggregateMoney>;
  balanceAsOf: string;
  lastImportedPostedDate: string | null;
  reconciliation: ReturnType<typeof accountReconciliation>;
  version: string;
  ledgerRevision: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * `today` is the Eastern date, so "current balance" means what the owner would
 * call today, not whatever day it is in UTC.
 */
export function accountDto(db: SqliteDatabase, row: AccountRow, today: string): AccountDto {
  const baseline = baselineOf(row);

  // The contract requires every account to carry a current balance. A
  // tracking start after today is refused when it is set, so today is
  // normally inside coverage. If the server clock later steps back past a
  // start date, the honest answer is the opening balance reported for the day
  // it belongs to (the day before the start) - never a fabricated "today", and
  // never a failure that takes the whole account list down (stage 2 review).
  let balanceAsOf = today;
  let { balance } = balanceAt(db, baseline, today);
  if (balance === null) {
    balanceAsOf = dayBefore(row.tracking_start_date);
    balance = row.opening_cents;
  }

  return {
    id: row.id,
    kind: row.kind,
    providerKey: row.provider_key,
    displayName: row.display_name,
    maskedSuffix: row.masked_suffix,
    trackingStartDate: row.tracking_start_date,
    openingBalance: money(row.opening_cents),
    status: row.archived_at === null ? "active" : "archived",
    archivedAt: row.archived_at === null ? null : isoTimestamp(Number(row.archived_at)),
    currentBalance: aggregateMoney(balance),
    balanceAsOf,
    lastImportedPostedDate: lastPostedDate(db, row.id),
    reconciliation: accountReconciliation(db, baseline),
    version: formatCounter(row.version),
    ledgerRevision: formatCounter(row.ledger_revision),
    createdAt: isoTimestamp(Number(row.created_at)),
    updatedAt: isoTimestamp(Number(row.updated_at)),
  };
}

export interface AuditEntry {
  entityType: "account" | "transaction" | "category" | "checkpoint" | "rule" | "transfer_pair" | "refund_link";
  entityId: string;
  accountId?: string | null;
  eventType: string;
  origin?: "owner" | "import" | "system";
  reason?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * A client id is used up once it has been created, even after the record is
 * deleted: otherwise a late retry of the original create would silently bring
 * back something the owner deliberately removed, opening balance and all. The
 * append-only audit history is the durable record of every id ever used.
 */
export function requireUnusedEntityId(
  db: SqliteDatabase,
  entityType: AuditEntry["entityType"],
  id: string,
  detail: string,
): void {
  const used = db
    .prepare("SELECT 1 FROM audit_events WHERE entity_type = ? AND entity_id = ? LIMIT 1")
    .get(entityType, id.toLowerCase());
  if (used === undefined) return;
  throw problem({
    status: 409,
    code: "client_id_conflict",
    title: "Already used for something else",
    detail,
  });
}

export function writeAudit(
  db: SqliteDatabase,
  newId: () => string,
  now: number,
  entry: AuditEntry,
): void {
  db.prepare(
    `INSERT INTO audit_events (id, command_id, entity_type, entity_id, account_id, event_type,
       origin, reason, before_json, after_json, occurred_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    entry.entityType,
    entry.entityId,
    entry.accountId ?? null,
    entry.eventType,
    entry.origin ?? "owner",
    entry.reason ?? null,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    now,
  );
}
