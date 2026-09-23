/**
 * Transfer pairs and refund links (TDD sections 6 and 12).
 *
 * A link is a relationship, never a financial change: creating or removing
 * one changes no amount, date, category or month, and never advances an
 * account's ledger revision. Both members' versions advance, because their
 * representations (transferPairId, refundLink, linkedRefundCount) change.
 * Links can be made and removed on archived accounts; changing a type there
 * cannot, so pairing an archived leg works only if it is already a transfer.
 *
 * The unlink helpers here are shared with every command that invalidates a
 * relationship (classification now, repairs and voids later): the caller
 * computes the required set, the owner confirms exactly that set, and the
 * unlink and the change commit in one transaction.
 */
import type { SqliteDatabase } from "@workspace/db";
import type { Assignment, TransactionKind } from "../domain/assignment.js";
import { creationDigest } from "../domain/digest.js";
import { aggregateMoney, money } from "../domain/money.js";
import { nextCounter, versionMismatch } from "../domain/versions.js";
import { isoTimestamp } from "../lib/clock.js";
import type { RefundLinkInput, TransferPairInput, UnlinkSet } from "../lib/link-schemas.js";
import { problem } from "../lib/problem.js";
import type { CommandContext } from "./accounts.js";
import { bumpFinanceRevision, financeRevision, requireAccount, writeAudit } from "./ledger.js";
import { requireCategory } from "./categories.js";
import { requireTransaction, transactionDto, type TransactionRow } from "./transactions.js";

/** The most refunds one purchase can carry: every invalidating change must be able to list them all. */
export const MAX_REFUNDS_PER_PURCHASE = 500;

interface PairRow { id: string; creation_digest: string; version: bigint; created_at: bigint }
interface RefundLinkRow {
  id: string; refund_id: string; purchase_id: string; creation_digest: string; version: bigint; created_at: bigint;
}

export interface LinkOutcome { status: 200 | 201; version: bigint; body: unknown }

function touch(context: CommandContext, id: string): void {
  const row = requireTransaction(context.db, id);
  context.db.prepare("UPDATE transactions SET version = ?, updated_at = ? WHERE id = ?")
    .run(nextCounter(row.version), context.now, id);
}

function linkEvent(context: CommandContext, transactionId: string, event: string, relatedIds: string[]): void {
  context.db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source, reason,
    before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json)
    VALUES (?, ?, ?, ?, 'owner', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`)
    .run(context.newId().toLowerCase(), transactionId, context.now, event, JSON.stringify(relatedIds));
}

export function classificationSnapshot(db: SqliteDatabase, row: Pick<TransactionRow, "kind" | "category_id" | "assignment_origin">) {
  return {
    kind: row.kind, categoryId: row.category_id,
    categoryName: row.category_id === null ? null : requireCategory(db, row.category_id).display_name,
    assignmentOrigin: row.assignment_origin,
  };
}

/**
 * Changes a transaction's type and assignment, never its amount. The caller
 * has checked the account is active and has already removed every link the
 * change invalidates; the database refuses the update otherwise.
 */
export function writeKindChange(context: CommandContext, row: TransactionRow, kind: TransactionKind,
  next: Assignment, relatedIds: string[]): TransactionRow {
  const { db, now } = context;
  db.prepare(`UPDATE transactions SET kind = ?, category_id = ?, assignment_origin = ?, assigned_at = ?, rule_id = ?,
    rule_revision = ?, version = ?, updated_at = ? WHERE id = ?`).run(kind, next.categoryId, next.origin, now,
    next.ruleId, next.ruleRevision, nextCounter(row.version), now, row.id);
  const changed = requireTransaction(db, row.id);
  const before = classificationSnapshot(db, row);
  const after = classificationSnapshot(db, changed);
  db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source, reason,
    before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json)
    VALUES (?, ?, ?, 'kind_changed', 'owner', NULL, ?, ?, ?, ?, ?, ?, ?)`).run(context.newId().toLowerCase(), row.id,
    now, JSON.stringify(before), JSON.stringify(after), row.category_id, changed.category_id, next.ruleId,
    next.ruleRevision, JSON.stringify(relatedIds));
  writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "transaction", entityId: row.id,
    accountId: row.account_id, eventType: "kind_changed", before, after });
  return changed;
}

// ---------------------------------------------------------------- invalidation

/**
 * The links a transaction's next state would leave invalid. A pair needs both
 * legs active transfers with equal and opposite amounts; a refund link needs
 * an active refund and an active purchase. Dates never invalidate a link.
 */
export function invalidatedLinks(db: SqliteDatabase, row: TransactionRow,
  next: { kind: TransactionKind; lifecycle: "active" | "void"; amountCents: bigint }): UnlinkSet {
  const leg = db.prepare(`SELECT l.pair_id AS pairId, other.amount_cents AS otherAmount FROM transfer_legs l
    JOIN transfer_legs o ON o.pair_id = l.pair_id AND o.transaction_id <> l.transaction_id
    JOIN transactions other ON other.id = o.transaction_id WHERE l.transaction_id = ?`)
    .get(row.id) as { pairId: string; otherAmount: bigint } | undefined;
  const transferPairIds = leg !== undefined && (next.kind !== "transfer" || next.lifecycle !== "active"
    || next.amountCents !== -leg.otherAmount) ? [leg.pairId] : [];
  const refundLinkIds: string[] = [];
  if (next.kind !== "refund" || next.lifecycle !== "active") {
    const own = db.prepare("SELECT id FROM refund_links WHERE refund_id = ?").get(row.id) as { id: string } | undefined;
    if (own !== undefined) refundLinkIds.push(own.id);
  }
  if (next.kind !== "purchase" || next.lifecycle !== "active") {
    for (const link of db.prepare("SELECT id FROM refund_links WHERE purchase_id = ?").all(row.id) as { id: string }[]) {
      refundLinkIds.push(link.id);
    }
  }
  return { transferPairIds, refundLinkIds: refundLinkIds.sort() };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The owner must confirm exactly the links the change breaks: no fewer, no more. */
export function requireConfirmedUnlinks(required: UnlinkSet, confirmed: UnlinkSet | undefined): void {
  const none = required.transferPairIds.length === 0 && required.refundLinkIds.length === 0;
  const matches = confirmed === undefined ? none
    : sameIds(required.transferPairIds, confirmed.transferPairIds) && sameIds(required.refundLinkIds, confirmed.refundLinkIds);
  if (matches) return;
  const parts = [
    required.transferPairIds.length === 0 ? null : "a transfer pair",
    required.refundLinkIds.length === 0 ? null
      : required.refundLinkIds.length === 1 ? "1 refund link" : `${required.refundLinkIds.length} refund links`,
  ].filter(part => part !== null);
  throw problem({ status: 409, code: "unlink_confirmation_required", title: "Links must be removed first",
    detail: parts.length === 0
      ? "This change breaks no links. Send it again without confirming any. Nothing was changed."
      : `This change breaks ${parts.join(" and ")}. Confirm unlinking exactly these, or cancel. Nothing was changed.`,
    requiredUnlinks: required });
}

/** Removes the links in the set. `skip` is the transaction whose own write advances its version. */
export function unlinkAll(context: CommandContext, set: UnlinkSet, skip: string | null): void {
  for (const id of set.transferPairIds) unlinkTransferPair(context, id, skip);
  for (const id of set.refundLinkIds) unlinkRefundLink(context, id, skip);
}

// ---------------------------------------------------------------- transfer pairs

/**
 * A link's client ID is used up once created, even after the link is
 * removed: otherwise a late retry of the original create would silently bring
 * back a relationship the owner deliberately removed. The append-only audit
 * history is the durable record of every ID ever created.
 */
function requireUnusedId(db: SqliteDatabase, entityType: "transfer_pair" | "refund_link", id: string): void {
  if (db.prepare("SELECT 1 FROM audit_events WHERE entity_type = ? AND entity_id = ? LIMIT 1").get(entityType, id)
    === undefined) return;
  throw problem({ status: 409, code: "client_id_conflict", title: "Already used for something else",
    detail: "This id belonged to a link that was later removed. Start a new link to link these again." });
}

function findPair(db: SqliteDatabase, id: string): PairRow | undefined {
  return db.prepare("SELECT id, creation_digest, version, created_at FROM transfer_pairs WHERE id = ?")
    .get(id.toLowerCase()) as PairRow | undefined;
}

export function requirePair(db: SqliteDatabase, id: string): PairRow {
  const pair = findPair(db, id);
  if (pair === undefined) throw problem({ status: 404, code: "not_found", title: "Not found",
    detail: "There is no transfer pair with that id." });
  return pair;
}

function pairLegs(db: SqliteDatabase, pairId: string): TransactionRow[] {
  return db.prepare(`SELECT t.* FROM transfer_legs l JOIN transactions t ON t.id = l.transaction_id
    WHERE l.pair_id = ? ORDER BY l.slot`).all(pairId) as TransactionRow[];
}

export function transferPairDto(db: SqliteDatabase, pair: PairRow) {
  return {
    id: pair.id,
    legs: pairLegs(db, pair.id).map(leg => ({ transactionId: leg.id, accountId: leg.account_id,
      postedDate: leg.posted_date, money: money(leg.amount_cents) })),
    createdAt: isoTimestamp(Number(pair.created_at)), version: String(pair.version),
  };
}

function pairResult(db: SqliteDatabase, pair: PairRow) {
  return { transferPair: transferPairDto(db, pair),
    transactions: pairLegs(db, pair.id).map(leg => transactionDto(db, leg)),
    financeRevision: String(financeRevision(db)) };
}

export type PairIneligibility = "voided" | "same_account" | "amount_mismatch" | "already_paired" | "reactivation_required";

/** Why two transactions cannot be one transfer, or null. Dates never matter. */
export function pairIneligibility(db: SqliteDatabase, a: TransactionRow, b: TransactionRow): PairIneligibility | null {
  if (a.lifecycle !== "active" || b.lifecycle !== "active") return "voided";
  if (a.account_id === b.account_id) return "same_account";
  if (a.amount_cents !== -b.amount_cents) return "amount_mismatch";
  const paired = db.prepare("SELECT 1 FROM transfer_legs WHERE transaction_id IN (?, ?) LIMIT 1").get(a.id, b.id);
  if (paired !== undefined) return "already_paired";
  // Pairing a non-transfer changes its type, which an archived account refuses.
  for (const leg of [a, b]) {
    if (leg.kind !== "transfer" && requireAccount(db, leg.account_id).archived_at !== null) return "reactivation_required";
  }
  return null;
}

function pairDigest(input: TransferPairInput): string {
  return creationDigest({ command: "transfer_pair",
    legs: input.legs.map(leg => ({ transactionId: leg.transactionId, version: leg.version }))
      .sort((left, right) => (left.transactionId < right.transactionId ? -1 : 1)),
    confirmKindChanges: input.confirmKindChanges });
}

/**
 * Confirms two transactions as one transfer. The pair's client ID is the
 * retry token: the same request returns the pair as it is now, anything else
 * under that ID conflicts, even after the pair is removed. A non-transfer leg changes type only with
 * `confirmKindChanges`, in the same transaction as the pairing.
 */
export function createTransferPair(context: CommandContext, input: TransferPairInput,
  check: (body: unknown) => unknown): LinkOutcome {
  const { db, now } = context;
  const [first, second] = input.legs as [TransferPairInput["legs"][0], TransferPairInput["legs"][0]];
  if (first.transactionId === second.transactionId) throw problem({ status: 422, code: "validation_failed",
    title: "Choose two different transactions", detail: "A transfer pairs two different transactions. Nothing was changed.",
    fieldErrors: [{ path: "/legs/1/transactionId", code: "invalid_value", message: "Choose a different transaction." }] });
  const digest = pairDigest(input);
  const existing = findPair(db, input.id);
  if (existing !== undefined) {
    if (existing.creation_digest !== digest) throw problem({ status: 409, code: "client_id_conflict",
      title: "Already used for something else",
      detail: "This transfer pair id was already saved with different values. Reload before trying again." });
    return { status: 200, version: existing.version, body: check(pairResult(db, existing)) };
  }
  requireUnusedId(db, "transfer_pair", input.id);
  const rows = [first, second].map(leg => requireTransaction(db, leg.transactionId)) as [TransactionRow, TransactionRow];
  if (rows.some((row, index) => row.version !== BigInt(input.legs[index]!.version))) throw problem({ status: 409,
    code: "preview_stale", title: "Changed since you chose it",
    detail: "One of these transactions changed since you chose it. Reload the candidates and try again. Nothing was changed." });
  const reason = pairIneligibility(db, rows[0], rows[1]);
  if (reason === "already_paired") throw problem({ status: 409, code: "transfer_pair_linked", title: "Already paired",
    detail: "One of these transactions is already part of a transfer pair. Unlink it first. Nothing was changed." });
  if (reason === "reactivation_required") throw problem({ status: 409, code: "reactivation_required",
    title: "Account is archived",
    detail: "Pairing would change the type of a transaction on an archived account. Reactivate it first. Nothing was changed." });
  if (reason !== null) {
    const message = { voided: "Both transactions must be active, not voided.",
      same_account: "The two transactions must be in different accounts.",
      amount_mismatch: "The amounts must be equal and opposite." }[reason];
    throw problem({ status: 422, code: "validation_failed", title: "These cannot be one transfer",
      detail: `${message} Nothing was changed.`, fieldErrors: [{ path: "/legs", code: reason, message }] });
  }
  const changing = rows.filter(row => row.kind !== "transfer");
  if (changing.length > 0 && !input.confirmKindChanges) throw problem({ status: 409,
    code: "kind_change_confirmation_required", title: "Type change needs confirmation",
    detail: changing.length === 1
      ? `Pairing changes one of these transactions from ${changing[0]!.kind} to transfer. Confirm to continue. Nothing was changed.`
      : "Pairing changes both transactions to transfers. Confirm to continue. Nothing was changed." });
  // A refund link on a leg that stops being a purchase or refund must be removed deliberately first.
  // One leg at a time, so the list stays within the contract's bound of 500.
  for (const row of changing) {
    const blocked = invalidatedLinks(db, row, { kind: "transfer", lifecycle: "active", amountCents: row.amount_cents });
    if (blocked.refundLinkIds.length > 0) throw problem({ status: 409, code: "unlink_confirmation_required",
      title: "Links must be removed first",
      detail: "A transaction here has refund links, which a transfer cannot keep. Remove them, or change its type with confirmation, first. Nothing was changed.",
      requiredUnlinks: blocked });
  }

  const pairId = input.id;
  for (const row of rows) {
    if (row.kind === "transfer") touch(context, row.id);
    else writeKindChange(context, row, "transfer",
      { origin: "system", categoryId: null, ruleId: null, ruleRevision: null }, [pairId]);
  }
  db.prepare("INSERT INTO transfer_pairs (id, creation_digest, version, created_at) VALUES (?, ?, 1, ?)")
    .run(pairId, digest, now);
  const insertLeg = db.prepare("INSERT INTO transfer_legs (pair_id, slot, transaction_id) VALUES (?, ?, ?)");
  insertLeg.run(pairId, 1, rows[0].id);
  insertLeg.run(pairId, 2, rows[1].id);
  linkEvent(context, rows[0].id, "transfer_linked", [pairId, rows[1].id]);
  linkEvent(context, rows[1].id, "transfer_linked", [pairId, rows[0].id]);
  writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "transfer_pair", entityId: pairId,
    eventType: "transfer_paired", after: { transactionIds: [rows[0].id, rows[1].id],
      kindChanged: changing.map(row => row.id) } });
  bumpFinanceRevision(db);
  const pair = requirePair(db, pairId);
  return { status: 201, version: pair.version, body: check(pairResult(db, pair)) };
}

/** Removes a pair's link rows. Both legs keep their amounts, dates and transfer type. */
function unlinkTransferPair(context: CommandContext, pairId: string, skip: string | null): string[] {
  const { db, now } = context;
  const legs = pairLegs(db, pairId);
  const ids = legs.map(leg => leg.id);
  db.prepare("DELETE FROM transfer_pairs WHERE id = ?").run(pairId);
  for (const [index, id] of ids.entries()) {
    linkEvent(context, id, "transfer_unlinked", [pairId, ids[1 - index]!]);
    if (id !== skip) touch(context, id);
  }
  writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "transfer_pair", entityId: pairId,
    eventType: "transfer_unlinked", before: { transactionIds: ids } });
  return ids;
}

/** Allowed when a leg is on an archived account: no financial column changes. */
export function deleteTransferPair(context: CommandContext, id: string, expected: bigint,
  check: (body: unknown) => unknown): unknown {
  const pair = requirePair(context.db, id);
  if (pair.version !== expected) throw versionMismatch(pair.version);
  const transactionIds = unlinkTransferPair(context, pair.id, null);
  bumpFinanceRevision(context.db);
  return check({ transactionIds, financeRevision: String(financeRevision(context.db)) });
}

// ---------------------------------------------------------------- refund links

function findRefundLink(db: SqliteDatabase, id: string): RefundLinkRow | undefined {
  return db.prepare("SELECT * FROM refund_links WHERE id = ?").get(id.toLowerCase()) as RefundLinkRow | undefined;
}

export function requireRefundLink(db: SqliteDatabase, id: string): RefundLinkRow {
  const link = findRefundLink(db, id);
  if (link === undefined) throw problem({ status: 404, code: "not_found", title: "Not found",
    detail: "There is no refund link with that id." });
  return link;
}

export function refundLinkDto(link: RefundLinkRow) {
  return { id: link.id, refundId: link.refund_id, purchaseId: link.purchase_id,
    createdAt: isoTimestamp(Number(link.created_at)), version: String(link.version) };
}

/** All refunds now linked to the purchase, as a positive amount. */
export function linkedRefundTotal(db: SqliteDatabase, purchaseId: string, excludingRefund: string | null = null): bigint {
  const row = db.prepare(`SELECT COALESCE(SUM(t.amount_cents), 0) AS total FROM refund_links l
    JOIN transactions t ON t.id = l.refund_id WHERE l.purchase_id = ? AND t.lifecycle = 'active'
    AND t.id IS NOT ?`).get(purchaseId, excludingRefund) as { total: bigint };
  return row.total;
}

function refundLinkResult(db: SqliteDatabase, link: RefundLinkRow) {
  const purchase = requireTransaction(db, link.purchase_id);
  const total = linkedRefundTotal(db, link.purchase_id);
  return { refundLink: refundLinkDto(link), linkedRefundTotal: aggregateMoney(total),
    exceedsPurchase: total > -purchase.amount_cents, financeRevision: String(financeRevision(db)) };
}

/**
 * Links a refund to the purchase it refunds, across accounts and on archived
 * accounts. Exceeding the purchase is a warning in the result, not a refusal.
 */
export function createRefundLink(context: CommandContext, input: RefundLinkInput,
  check: (body: unknown) => unknown): LinkOutcome {
  const { db, now } = context;
  const digest = creationDigest({ command: "refund_link", refundId: input.refundId, purchaseId: input.purchaseId });
  const existing = findRefundLink(db, input.id);
  if (existing !== undefined) {
    if (existing.creation_digest !== digest) throw problem({ status: 409, code: "client_id_conflict",
      title: "Already used for something else",
      detail: "This refund link id was already saved with different values. Reload before trying again." });
    return { status: 200, version: existing.version, body: check(refundLinkResult(db, existing)) };
  }
  requireUnusedId(db, "refund_link", input.id);
  const invalid = (path: string, message: string): never => {
    throw problem({ status: 422, code: "validation_failed", title: "These cannot be linked",
      detail: `${message} Nothing was changed.`, fieldErrors: [{ path, code: "invalid_value", message }] });
  };
  const refund = requireTransaction(db, input.refundId);
  const purchase = requireTransaction(db, input.purchaseId);
  if (refund.kind !== "refund" || refund.lifecycle !== "active") invalid("/refundId", "Choose an active refund.");
  if (purchase.kind !== "purchase" || purchase.lifecycle !== "active") invalid("/purchaseId", "Choose an active purchase.");
  if (db.prepare("SELECT 1 FROM refund_links WHERE refund_id = ?").get(refund.id) !== undefined) throw problem({
    status: 409, code: "refund_already_linked", title: "Refund already linked",
    detail: "This refund is already linked to a purchase. Remove that link first." });
  const count = db.prepare("SELECT COUNT(*) AS n FROM refund_links WHERE purchase_id = ?").get(purchase.id) as { n: bigint };
  if (count.n >= BigInt(MAX_REFUNDS_PER_PURCHASE)) {
    invalid("/purchaseId", `A purchase can have at most ${MAX_REFUNDS_PER_PURCHASE} linked refunds.`);
  }
  db.prepare(`INSERT INTO refund_links (id, refund_id, purchase_id, creation_digest, version, created_at)
    VALUES (?, ?, ?, ?, 1, ?)`).run(input.id, refund.id, purchase.id, digest, now);
  touch(context, refund.id);
  touch(context, purchase.id);
  linkEvent(context, refund.id, "refund_linked", [input.id, purchase.id]);
  linkEvent(context, purchase.id, "refund_linked", [input.id, refund.id]);
  writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "refund_link", entityId: input.id,
    eventType: "refund_linked", after: { refundId: refund.id, purchaseId: purchase.id } });
  bumpFinanceRevision(db);
  const link = requireRefundLink(db, input.id);
  return { status: 201, version: link.version, body: check(refundLinkResult(db, link)) };
}

/** Removes one link. Both transactions keep their amounts, categories and months. */
function unlinkRefundLink(context: CommandContext, linkId: string, skip: string | null): string[] {
  const { db, now } = context;
  const link = requireRefundLink(db, linkId);
  db.prepare("DELETE FROM refund_links WHERE id = ?").run(link.id);
  linkEvent(context, link.refund_id, "refund_unlinked", [link.id, link.purchase_id]);
  linkEvent(context, link.purchase_id, "refund_unlinked", [link.id, link.refund_id]);
  for (const id of [link.refund_id, link.purchase_id]) if (id !== skip) touch(context, id);
  writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "refund_link", entityId: link.id,
    eventType: "refund_unlinked", before: { refundId: link.refund_id, purchaseId: link.purchase_id } });
  return [link.refund_id, link.purchase_id];
}

export function deleteRefundLink(context: CommandContext, id: string, expected: bigint,
  check: (body: unknown) => unknown): unknown {
  const link = requireRefundLink(context.db, id);
  if (link.version !== expected) throw versionMismatch(link.version);
  const transactionIds = unlinkRefundLink(context, link.id, null);
  bumpFinanceRevision(context.db);
  return check({ transactionIds, financeRevision: String(financeRevision(context.db)) });
}
