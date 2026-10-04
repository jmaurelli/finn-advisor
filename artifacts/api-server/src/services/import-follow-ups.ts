import { z } from "zod";
import { creationDigest } from "../domain/digest.js";
import { problem } from "../lib/problem.js";
import { applySuggestions } from "./import-suggestions.js";
import { findBatch, IMPORT_REVIEW_MS, importCreateResult, requireBatch, type ImportContext } from "./imports.js";
import { requireAccount, requireActiveAccount, writeAudit } from "./ledger.js";

const snapshotSchema = z.object({
  posted_date: z.string().nullable(),
  merchant_text: z.string().nullable(),
  normalized_text: z.string().nullable(),
  amount_cents: z.string().regex(/^-?\d+$/).transform(value => BigInt(value)).nullable(),
  kind: z.enum(["purchase", "refund", "income", "transfer"]).nullable(),
  kind_source: z.enum(["bank", "transfer_candidate", "default", "owner"]).nullable(),
  bank_identity_namespace: z.string().nullable(),
  bank_transaction_id: z.string().nullable(),
  issues_json: z.string(),
});

interface RetainedRow {
  id: string;
  source_row_number: bigint;
  source_fields_json: string;
  normalized_json: string;
}

export function createImportFollowUp<T>(context: ImportContext, parentId: string, id: string,
  check: (body: unknown) => T): { status: 200 | 201; body: T; id: string } {
  const { db, now, newId } = context;
  const digest = creationDigest({ id, parentImportId: parentId });
  const existing = findBatch(db, id);
  if (existing !== undefined) {
    if (existing.parent_import_id !== parentId || existing.creation_digest !== digest) {
      throw problem({ status: 409, code: "client_id_conflict", title: "Id already used",
        detail: "That id belongs to a different import. Use a new id for this review." });
    }
    return { status: 200, id, body: check(importCreateResult(db, existing,
      existing.status === "committed" ? "existing_completed" : "existing_preview")) };
  }
  const parent = requireBatch(db, parentId);
  const unusable = () => problem({ status: 422, code: "validation_failed", title: "No rows to review",
    detail: "Choose a completed import with excluded rows that have not already been added." });
  if (parent.status !== "committed") throw unusable();
  const account = requireAccount(db, parent.account_id);
  requireActiveAccount(account);
  const retained = db.prepare(`SELECT s.id, r.source_row_number, s.source_fields_json, s.normalized_json
    FROM import_rows r JOIN import_source_records s ON s.id = COALESCE(r.source_record_id,
      (SELECT id FROM import_source_records WHERE origin_import_id = r.import_id AND origin_row_number = r.source_row_number))
    WHERE r.import_id = ? AND r.state = 'excluded'
      AND NOT EXISTS (SELECT 1 FROM import_postings p WHERE p.source_record_id = s.id)
    ORDER BY r.source_row_number`).all(parentId) as RetainedRow[];
  if (retained.length === 0) throw unusable();
  const revision = db.prepare("SELECT rule_set_revision FROM ledger_metadata WHERE id = 1")
    .get() as { rule_set_revision: bigint };
  db.prepare(`INSERT INTO import_batches (id, account_id, format_id, format_version, filename, status,
    parent_import_id, created_at, last_reviewed_at, expires_at, version, captured_ledger_revision,
    captured_rule_set_revision, captured_account_archived, creation_digest, updated_at)
    VALUES (?, ?, ?, ?, ?, 'preview', ?, ?, ?, ?, 1, ?, ?, 0, ?, ?)`)
    .run(id, parent.account_id, parent.format_id, parent.format_version, parent.filename, parentId,
      now, now, now + IMPORT_REVIEW_MS, account.ledger_revision, revision.rule_set_revision, digest, now);
  const insert = db.prepare(`INSERT INTO import_rows (id, import_id, source_row_number, source_fields_json,
    source_record_id, bank_identity_namespace, bank_transaction_id, posted_date, merchant_text, normalized_text,
    amount_cents, kind, kind_source, state, issues_json, excluded, review_required,
    duplicate_status, duplicate_matches_json, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, 0, 0, 'none', '[]', 1, ?, ?)`);
  for (const source of retained) {
    // Snapshots store bigint values as decimal strings, never JSON numbers.
    const parsed = snapshotSchema.safeParse(JSON.parse(source.normalized_json));
    if (!parsed.success) throw new Error("Retained import snapshot cannot be reconstructed");
    const row = parsed.data;
    insert.run(newId(), id, source.source_row_number, source.source_fields_json, source.id,
      row.bank_identity_namespace, row.bank_transaction_id, row.posted_date, row.merchant_text,
      row.normalized_text, row.amount_cents, row.kind, row.kind_source, row.issues_json, now, now);
  }
  const batch = requireBatch(db, id);
  applySuggestions(context, batch, "publish");
  writeAudit(db, newId, now, { entityType: "import", entityId: id, accountId: parent.account_id,
    eventType: "import_follow_up_created", after: { parentImportId: parentId, rows: retained.length } });
  return { status: 201, id, body: check(importCreateResult(db, batch, "created")) };
}
