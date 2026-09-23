import type { SqliteDatabase } from "@workspace/db";
import { z } from "zod";
import { creationDigest } from "../domain/digest.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import { requireTransaction } from "./transactions.js";

interface HistoryRow {
  id: string;
  transaction_id: string;
  occurred_at: bigint;
  event_type: string;
  source: string;
  reason: string | null;
  before_json: string | null;
  after_json: string | null;
  rule_id: string | null;
  rule_revision: bigint | null;
  related_ids_json: string;
}

const cursorSchema = z.object({
  v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  time: z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value))),
  id: z.string().uuid(),
}).strict();

function invalidCursor(): never {
  throw problem({ status: 400, code: "invalid_cursor", title: "The list position is not valid",
    detail: "Reload the list from the first page." });
}

export function transactionHistory(db: SqliteDatabase, id: string, query: Record<string, unknown>) {
  requireTransaction(db, id);
  const limit = query["limit"] ?? "25";
  if (typeof limit !== "string" || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100) {
    throw problem({ status: 400, code: "invalid_request", title: "Invalid page size",
      detail: "Choose a history page size from 1 to 100." });
  }
  const scope = creationDigest({ list: "transaction-history", transactionId: id.toLowerCase() });
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (query["cursor"] !== undefined) {
    const encoded = query["cursor"];
    if (typeof encoded !== "string" || encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalidCursor();
    try {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded) invalidCursor();
      cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch { invalidCursor(); }
    if (cursor.scope !== scope) throw problem({ status: 400, code: "cursor_filter_mismatch",
      title: "The list filters changed", detail: "Reload the list from the first page." });
  }
  const rows = db.prepare(`SELECT * FROM assignment_events WHERE transaction_id = ?
    ${cursor === undefined ? "" : "AND (occurred_at, id) < (?, ?)"}
    ORDER BY occurred_at DESC, id DESC LIMIT ?`).all(id.toLowerCase(),
      ...(cursor === undefined ? [] : [BigInt(cursor.time), cursor.id.toLowerCase()]), Number(limit) + 1) as HistoryRow[];
  const more = rows.length > Number(limit);
  const page = rows.slice(0, Number(limit));
  const last = page.at(-1);
  return {
    items: page.map(row => ({
      id: row.id, transactionId: row.transaction_id, occurredAt: isoTimestamp(Number(row.occurred_at)),
      eventType: row.event_type, source: row.source, reason: row.reason,
      before: row.before_json === null ? null : JSON.parse(row.before_json) as unknown,
      after: row.after_json === null ? null : JSON.parse(row.after_json) as unknown,
      ruleId: row.rule_id, ruleRevision: row.rule_revision === null ? null : String(row.rule_revision),
      relatedIds: JSON.parse(row.related_ids_json) as unknown,
    })),
    nextCursor: !more || last === undefined ? null : Buffer.from(JSON.stringify({
      v: 1, scope, time: String(last.occurred_at), id: last.id,
    })).toString("base64url"),
  };
}
