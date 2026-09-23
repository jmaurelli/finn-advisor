import type { Assignment } from "../domain/assignment.js";
import { normalizeMatchText, normalizeMerchantText } from "../domain/assignment.js";
import { isCalendarDate } from "../domain/dates.js";
import { parseMoney, MoneyFormatError } from "../domain/money.js";
import { nextCounter } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import { checkedResponse } from "../lib/respond.js";
import { PostingInput, Transaction } from "../lib/transaction-schemas.js";
import { validateBody } from "../lib/validate.js";
import type { CommandContext } from "./accounts.js";
import { assignByRules } from "./assignment.js";
import { bumpFinanceRevision, requireAccount, requireActiveAccount, writeAudit } from "./ledger.js";
import { requireManualCategory, requireTransaction, transactionDto, transactionSnapshot } from "./transactions.js";

function invalid(path: string, message: string): never {
  throw problem({ status: 422, code: "validation_failed", title: "Cannot post this transaction",
    detail: message, fieldErrors: [{ path, code: "invalid_value", message }] });
}

/** Internal only: the caller owns the unit of work, including rollback on any failure. */
export function postTransaction(context: CommandContext, input: PostingInput) {
  const { db, now } = context;
  if (!db.inTransaction) throw new Error("Posting requires the caller's write transaction");
  const value = validateBody(PostingInput, input);
  const account = requireAccount(db, value.accountId);
  requireActiveAccount(account);
  if (!isCalendarDate(value.postedDate)) invalid("/postedDate", "Choose a real calendar date.");
  if (value.postedDate < account.tracking_start_date) {
    invalid("/postedDate", "This date is before the account's tracking start. Extend coverage before posting it.");
  }
  let amount: bigint;
  try { amount = parseMoney(value.money); } catch (error) {
    if (!(error instanceof MoneyFormatError)) throw error;
    invalid("/money", "Use exact USD cents within the supported range.");
  }
  if (amount === 0n || (value.kind === "purchase" && amount > 0n)
    || ((value.kind === "refund" || value.kind === "income") && amount < 0n)) {
    invalid("/money", "Purchases must be negative, refunds and income positive, and transfers nonzero.");
  }
  if (value.category !== undefined && (value.kind === "income" || value.kind === "transfer")) {
    invalid("/category", "Income and transfers use their system category, not a category choice.");
  }
  const assignment: Assignment = value.category?.mode === "category"
    ? { origin: "manual", categoryId: requireManualCategory(db, value.category.categoryId), ruleId: null, ruleRevision: null }
    : assignByRules(db, { accountId: account.id, kind: value.kind, merchantText: value.merchant });
  const revision = nextCounter(account.ledger_revision);
  const id = context.newId().toLowerCase();
  db.prepare(`INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
    amount_cents, kind, category_id, assignment_origin, assigned_at, rule_id, rule_revision,
    note, normalized_note, lifecycle, voided_at, original_posted_date, original_amount_cents, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, 1, ?, ?)`)
    .run(id, account.id, value.postedDate, value.merchant, normalizeMerchantText(value.merchant),
      amount, value.kind, assignment.categoryId, assignment.origin, now, assignment.ruleId,
      assignment.ruleRevision, value.note ?? null,
      value.note == null ? null : normalizeMatchText(value.note), value.postedDate, amount, now, now);
  const row = requireTransaction(db, id);
  const snapshot = transactionSnapshot(db, row);
  // The contract calls the initial posting event "imported". System source and
  // null provenance distinguish synthetic postings from Stage 5 bank imports.
  db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source,
    reason, before_json, after_json, before_category_id, after_category_id, rule_id, rule_revision, related_ids_json)
    VALUES (?, ?, ?, 'imported', 'system', NULL, NULL, ?, NULL, ?, ?, ?, '[]')`)
    .run(context.newId().toLowerCase(), id, now, JSON.stringify(snapshot), assignment.categoryId,
      assignment.ruleId, assignment.ruleRevision);
  writeAudit(db, () => context.newId().toLowerCase(), now, { entityType: "transaction", entityId: id,
    accountId: account.id, eventType: "transaction_posted", origin: "system", after: snapshot });
  db.prepare("UPDATE accounts SET ledger_revision = ? WHERE id = ?").run(revision, account.id);
  bumpFinanceRevision(db);
  const result = transactionDto(db, row);
  checkedResponse(Transaction, result);
  return result;
}
