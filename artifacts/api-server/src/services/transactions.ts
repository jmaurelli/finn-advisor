import type { SqliteDatabase } from "@workspace/db";
import type { TransactionKind } from "../domain/assignment.js";
import { money } from "../domain/money.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import { requireCategory } from "./categories.js";

export interface TransactionRow {
  id: string;
  account_id: string;
  posted_date: string;
  merchant_text: string;
  normalized_text: string;
  amount_cents: bigint;
  kind: TransactionKind;
  category_id: string | null;
  assignment_origin: "manual" | "rule" | "unassigned" | "system";
  assigned_at: bigint;
  rule_id: string | null;
  rule_revision: bigint | null;
  note: string | null;
  normalized_note: string | null;
  lifecycle: "active" | "void";
  voided_at: bigint | null;
  original_posted_date: string;
  original_amount_cents: bigint;
  version: bigint;
  created_at: bigint;
  updated_at: bigint;
}

export function requireTransaction(db: SqliteDatabase, id: string): TransactionRow {
  const row = db.prepare("SELECT * FROM transactions WHERE id = ?").get(id.toLowerCase()) as TransactionRow | undefined;
  if (row === undefined) throw problem({ status: 404, code: "not_found", title: "Not found",
    detail: "There is no transaction with that id." });
  return row;
}

export function transactionDto(db: SqliteDatabase, row: TransactionRow) {
  const transfer = db.prepare("SELECT pair_id FROM transfer_legs WHERE transaction_id = ?")
    .get(row.id) as { pair_id: string } | undefined;
  const refund = db.prepare("SELECT id, purchase_id FROM refund_links WHERE refund_id = ?")
    .get(row.id) as { id: string; purchase_id: string } | undefined;
  const refunds = db.prepare("SELECT COUNT(*) AS n FROM refund_links WHERE purchase_id = ?")
    .get(row.id) as { n: bigint };
  const repaired = db.prepare(`SELECT 1 FROM assignment_events WHERE transaction_id = ?
    AND event_type IN ('amount_corrected', 'date_corrected') LIMIT 1`).get(row.id);
  return {
    id: row.id, accountId: row.account_id, postedDate: row.posted_date, merchant: row.merchant_text,
    money: money(row.amount_cents), kind: row.kind, lifecycle: row.lifecycle, categoryId: row.category_id,
    assignment: { origin: row.assignment_origin, assignedAt: isoTimestamp(Number(row.assigned_at)),
      ruleId: row.rule_id, ruleRevision: row.rule_revision === null ? null : String(row.rule_revision) },
    note: row.note, importId: null, sourceRowNumber: null,
    transferPairId: transfer?.pair_id ?? null,
    refundLink: refund === undefined ? null : { linkId: refund.id, purchaseId: refund.purchase_id },
    linkedRefundCount: Number(refunds.n),
    correction: repaired === undefined && row.original_posted_date === row.posted_date && row.original_amount_cents === row.amount_cents
      ? null : { originalPostedDate: row.original_posted_date, originalMoney: money(row.original_amount_cents) },
    voidedAt: row.voided_at === null ? null : isoTimestamp(Number(row.voided_at)),
    version: String(row.version), createdAt: isoTimestamp(Number(row.created_at)),
    updatedAt: isoTimestamp(Number(row.updated_at)),
  };
}

export function transactionSnapshot(db: SqliteDatabase, row: TransactionRow) {
  return {
    categoryId: row.category_id,
    categoryName: row.category_id === null ? null : requireCategory(db, row.category_id).display_name,
    assignmentOrigin: row.assignment_origin, kind: row.kind, lifecycle: row.lifecycle,
    postedDate: row.posted_date, money: money(row.amount_cents), note: row.note,
  };
}

export function requireManualCategory(db: SqliteDatabase, id: string): string {
  const category = requireCategory(db, id);
  if (category.archived_at !== null) throw problem({ status: 409, code: "category_archived",
    title: "Category is archived", detail: "Reactivate the category before assigning it." });
  if (category.system_kind === "income") throw problem({ status: 422, code: "validation_failed",
    title: "Choose an expense category", detail: "Purchases and refunds cannot use Income." });
  return category.id;
}
