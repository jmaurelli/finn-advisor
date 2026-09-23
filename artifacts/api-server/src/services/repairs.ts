import type { SqliteDatabase } from "@workspace/db";
import { isCalendarDate } from "../domain/dates.js";
import { aggregateMoney, MoneyFormatError, parseMoney } from "../domain/money.js";
import { checkpointStates, deriveStatus } from "../domain/reconciliation.js";
import { nextCounter } from "../domain/versions.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import type { RepairInput, RepairPreview } from "../lib/repair-schemas.js";
import type { CommandContext } from "./accounts.js";
import { baselineOf, bumpFinanceRevision, requireAccount, requireActiveAccount, writeAudit } from "./ledger.js";
import { invalidatedLinks, requireConfirmedUnlinks, unlinkAll } from "./links.js";
import { requireTransaction, transactionDto, type TransactionRow } from "./transactions.js";

type State = RepairPreview["before"];
type Capture = RepairPreview["capturedVersions"][number];
function money(cents: bigint) {
  return { ...aggregateMoney(cents), currency: "USD" as const };
}
interface StoredPreview {
  id: string; transaction_id: string; preview_json: string; dependencies_json: string;
  expires_at: bigint; applied_at: bigint | null; result_json: string | null;
}

function invalid(path: string, message: string): never {
  throw problem({ status: 422, code: "validation_failed", title: "Cannot repair this transaction",
    detail: message, fieldErrors: [{ path, code: "invalid_value", message }] });
}

function state(row: TransactionRow): State {
  return { postedDate: row.posted_date, money: money(row.amount_cents), lifecycle: row.lifecycle };
}

function proposed(row: TransactionRow, input: RepairInput): State {
  const after = state(row);
  if (input.action === "correct") {
    if (input.postedDate === undefined && input.money === undefined) invalid("/action", "Choose an amount or date to correct.");
    if (input.postedDate !== undefined) {
      if (!isCalendarDate(input.postedDate)) invalid("/postedDate", "Choose a real calendar date.");
      after.postedDate = input.postedDate;
    }
    if (input.money !== undefined) {
      let amount: bigint;
      try { amount = parseMoney(input.money); } catch (error) {
        if (!(error instanceof MoneyFormatError)) throw error;
        invalid("/money", "Use exact USD cents within the supported range.");
      }
      if (amount === 0n) invalid("/money", "A transaction amount cannot be zero.");
      if ((row.kind === "purchase" && amount > 0n) || ((row.kind === "refund" || row.kind === "income") && amount < 0n)) {
        throw problem({ status: 422, code: "kind_sign_mismatch", title: "Type does not fit the amount",
          detail: "Keep the amount's sign compatible with the transaction type. Nothing was changed." });
      }
      after.money = money(amount);
    }
  } else {
    const lifecycle = input.action === "void" ? "void" : "active";
    if (row.lifecycle === lifecycle) invalid("/action", `This transaction is already ${lifecycle}.`);
    after.lifecycle = lifecycle;
  }
  return after;
}

/** Public captures fit the contract even for 500 refunds; all counterparts are also retained privately. */
function dependencies(db: SqliteDatabase, row: TransactionRow) {
  const account = requireAccount(db, row.account_id);
  const captures: Capture[] = [
    { entity: "transaction", id: row.id, version: String(row.version) },
    { entity: "account", id: account.id, version: String(account.version) },
  ];
  const links = db.prepare(`SELECT p.id, p.version, 'transfer_pair' AS entity, o.transaction_id AS counterpart
    FROM transfer_legs l JOIN transfer_pairs p ON p.id = l.pair_id
    JOIN transfer_legs o ON o.pair_id = l.pair_id AND o.transaction_id <> l.transaction_id
    WHERE l.transaction_id = ?
    UNION ALL SELECT id, version, 'refund_link', CASE WHEN refund_id = ? THEN purchase_id ELSE refund_id END
    FROM refund_links WHERE refund_id = ? OR purchase_id = ? ORDER BY entity, id`)
    .all(row.id, row.id, row.id, row.id) as { id: string; version: bigint; entity: "transfer_pair" | "refund_link"; counterpart: string }[];
  const counterparts = links.map(link => {
    captures.push({ entity: link.entity, id: link.id, version: String(link.version) });
    const other = requireTransaction(db, link.counterpart);
    const otherAccount = requireAccount(db, other.account_id);
    return { id: other.id, version: String(other.version), accountId: otherAccount.id,
      accountVersion: String(otherAccount.version) };
  });
  return { captures, counterparts, ledgerRevision: String(account.ledger_revision) };
}

function impact(db: SqliteDatabase, row: TransactionRow, after: State): RepairPreview["impact"] {
  const changes = new Map<string, bigint>();
  if (row.lifecycle === "active") changes.set(row.posted_date, -row.amount_cents);
  if (after.lifecycle === "active") changes.set(after.postedDate,
    (changes.get(after.postedDate) ?? 0n) + BigInt(after.money.amountMinor));
  const balanceChanges = [...changes].filter(([, delta]) => delta !== 0n).sort(([a], [b]) => a.localeCompare(b))
    .map(([effectiveFrom, delta]) => ({ accountId: row.account_id, effectiveFrom, delta: money(delta) }));
  const account = requireAccount(db, row.account_id);
  const affectedCheckpoints: RepairPreview["impact"]["affectedCheckpoints"] = [];
  for (const current of checkpointStates(db, baselineOf(account))) {
    const delta = balanceChanges.filter(change => change.effectiveFrom <= current.checkpoint.closing_date)
      .reduce((sum, change) => sum + BigInt(change.delta.amountMinor), 0n);
    if (delta === 0n || current.currentBalance === null) continue;
    const balanceAfter = current.currentBalance + delta;
    affectedCheckpoints.push({ checkpointId: current.checkpoint.id, closingDate: current.checkpoint.closing_date,
      balanceBefore: money(current.currentBalance), balanceAfter: money(balanceAfter),
      statusAfter: deriveStatus(current.checkpoint, current.latestCheck, balanceAfter) });
  }
  return { balanceChanges, affectedMonths: [...new Set(balanceChanges.map(change => change.effectiveFrom.slice(0, 7)))].sort(),
    affectedCheckpoints, requiredUnlinks: invalidatedLinks(db, row, { kind: row.kind,
      lifecycle: after.lifecycle, amountCents: BigInt(after.money.amountMinor) }) };
}

export function createRepairPreview(context: CommandContext, id: string, input: RepairInput,
  check: (body: unknown) => unknown): { id: string; body: unknown } {
  const { db, now } = context;
  const row = requireTransaction(db, id);
  const account = requireAccount(db, row.account_id);
  requireActiveAccount(account);
  const after = proposed(row, input);
  if (after.lifecycle === "active" && after.postedDate < account.tracking_start_date) {
    invalid("/postedDate", "This date is before the account's tracking start. Extend coverage before restoring or correcting it.");
  }
  const captured = dependencies(db, row);
  const preview: RepairPreview = { id: context.newId().toLowerCase(), transactionId: row.id, accountId: row.account_id,
    action: input.action, reason: input.reason, status: "ready", before: state(row), after,
    impact: impact(db, row, after), capturedVersions: captured.captures,
    createdAt: isoTimestamp(now), expiresAt: isoTimestamp(now + 86_400_000), appliedAt: null };
  if (preview.impact.affectedCheckpoints.length > 1000) invalid("/action", "This repair affects more than 1,000 checkpoints.");
  const body = check(preview);
  db.prepare(`INSERT INTO repair_previews (id, transaction_id, preview_json, dependencies_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(preview.id, row.id, JSON.stringify(body), JSON.stringify(captured), now, now + 86_400_000);
  return { id: preview.id, body };
}

function requirePreview(db: SqliteDatabase, id: string): StoredPreview {
  const row = db.prepare("SELECT * FROM repair_previews WHERE id = ?").get(id.toLowerCase()) as StoredPreview | undefined;
  if (row === undefined) throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no repair with that id." });
  return row;
}

function status(db: SqliteDatabase, saved: StoredPreview, preview: RepairPreview, now: number): RepairPreview["status"] {
  if (saved.applied_at !== null) return "applied";
  if (BigInt(now) >= saved.expires_at) return "expired";
  const row = requireTransaction(db, saved.transaction_id);
  if (JSON.stringify(dependencies(db, row)) !== saved.dependencies_json) return "stale";
  // Checkpoint creation and rechecks do not advance the account ledger revision.
  if (JSON.stringify(impact(db, row, preview.after)) !== JSON.stringify(preview.impact)) return "stale";
  return "ready";
}

export function getRepairPreview(db: SqliteDatabase, id: string, now: number): RepairPreview {
  const saved = requirePreview(db, id);
  if (saved.result_json !== null) return (JSON.parse(saved.result_json) as { repair: RepairPreview }).repair;
  const preview = JSON.parse(saved.preview_json) as RepairPreview;
  return { ...preview, status: status(db, saved, preview, now) };
}

export function applyRepair(context: CommandContext, id: string, confirmUnlinking: boolean,
  check: (body: unknown) => unknown): unknown {
  const { db, now } = context;
  const saved = requirePreview(db, id);
  if (saved.result_json !== null) return check(JSON.parse(saved.result_json));
  const preview = JSON.parse(saved.preview_json) as RepairPreview;
  const currentStatus = status(db, saved, preview, now);
  if (currentStatus === "expired") throw problem({ status: 410, code: "preview_expired", title: "Preview expired",
    detail: "Create a new preview and review it again." });
  if (currentStatus === "stale") throw problem({ status: 409, code: "preview_stale", title: "Preview changed",
    detail: "The transaction, its relationships or its balance impact changed. Create a new preview. Nothing was saved." });
  const row = requireTransaction(db, saved.transaction_id);
  const account = requireAccount(db, row.account_id);
  requireActiveAccount(account);
  const { after } = preview;
  if (after.lifecycle === "active" && after.postedDate < account.tracking_start_date) {
    invalid("/postedDate", "Extend account coverage before restoring this transaction.");
  }
  const unlinked = preview.impact.requiredUnlinks;
  requireConfirmedUnlinks(unlinked, confirmUnlinking ? unlinked : undefined);
  unlinkAll(context, unlinked, row.id);
  const changed = JSON.stringify(preview.before) !== JSON.stringify(after);
  if (changed) {
    db.prepare(`UPDATE transactions SET posted_date = ?, amount_cents = ?, lifecycle = ?, voided_at = ?, version = ?, updated_at = ?
      WHERE id = ?`).run(after.postedDate, BigInt(after.money.amountMinor), after.lifecycle,
      after.lifecycle === "void" ? row.voided_at ?? now : null, nextCounter(row.version), now, row.id);
    const events = preview.action === "correct"
      ? [row.amount_cents !== BigInt(after.money.amountMinor) ? "amount_corrected" : null,
        row.posted_date !== after.postedDate ? "date_corrected" : null].filter(event => event !== null)
      : [preview.action === "void" ? "voided" : "restored"];
    for (const event of events) {
      db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source, reason,
        before_json, after_json, related_ids_json) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?)`)
        .run(context.newId().toLowerCase(), row.id, now, event, preview.reason,
          JSON.stringify(preview.before), JSON.stringify(after), JSON.stringify([preview.id]));
      writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "transaction", entityId: row.id,
        accountId: row.account_id, eventType: event!, reason: preview.reason, before: preview.before, after });
    }
    db.prepare("UPDATE accounts SET ledger_revision = ? WHERE id = ?").run(nextCounter(account.ledger_revision), account.id);
  }
  const revision = bumpFinanceRevision(db);
  const body = check({ repair: { ...preview, status: "applied", appliedAt: isoTimestamp(now) },
    transaction: transactionDto(db, requireTransaction(db, row.id)), unlinked, financeRevision: String(revision) });
  db.prepare("UPDATE repair_previews SET applied_at = ?, result_json = ? WHERE id = ?").run(now, JSON.stringify(body), saved.id);
  return body;
}
