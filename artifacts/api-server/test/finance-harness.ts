/**
 * Helpers for the finance tests.
 *
 * Older arithmetic/schema tests retain the direct-SQL fixture below. New
 * Stage 3 acceptance scenarios use postThroughService, the real posting path.
 */
import { withWriteTransaction, type SqliteDatabase } from "@workspace/db";
import { easternDate } from "../src/domain/dates.js";
import type { PostingInput } from "../src/lib/transaction-schemas.js";
import { postTransaction as postMovement } from "../src/services/posting.js";

import type { TestServer, TestResponse } from "./harness.js";

export const UNCATEGORIZED = "30000000-0000-4000-8000-000000000000";
export const INCOME_CATEGORY = "30000000-0000-4000-8000-000000000001";

/** Stage 3 acceptance tests use the real posting service, not the legacy SQL fixture. */
export function postThroughService(api: TestServer, input: PostingInput) {
  return withWriteTransaction(api.db, () => postMovement({
    db: api.db, now: api.clock.now(), today: easternDate(api.clock.now()), newId: api.deps.newId,
  }, input));
}

export function uuid(tag: number, prefix = "20000000"): string {
  return `${prefix}-0000-4000-8000-${String(tag).padStart(12, "0")}`;
}

export interface NewAccount {
  id?: string;
  kind?: string;
  providerKey?: string;
  displayName?: string;
  maskedSuffix?: string | null;
  trackingStartDate?: string;
  openingMinor?: string;
}

export async function createAccount(
  api: TestServer,
  options: NewAccount = {},
): Promise<{ id: string; response: TestResponse; etag: string }> {
  const id = options.id ?? uuid(1);
  const response = await api.request("/api/accounts", {
    method: "POST",
    body: {
      id,
      kind: options.kind ?? "checking",
      providerKey: options.providerKey ?? "chase",
      displayName: options.displayName ?? "Synthetic Everyday Checking",
      ...(options.maskedSuffix === undefined ? {} : { maskedSuffix: options.maskedSuffix }),
      trackingStartDate: options.trackingStartDate ?? "2026-04-01",
      openingBalance: { amountMinor: options.openingMinor ?? "125000", currency: "USD" },
    },
  });
  return { id, response, etag: response.headers.get("etag") ?? "" };
}

let transactionCounter = 0;

export interface SyntheticTransaction {
  id?: string;
  accountId: string;
  postedDate: string;
  amountMinor: string;
  kind?: "purchase" | "refund" | "income" | "transfer";
  categoryId?: string | null;
  origin?: string;
  lifecycle?: "active" | "void";
  merchant?: string;
}

/** Legacy SQL fixture: not evidence that application posting commands work. */
export function postTransaction(db: SqliteDatabase, input: SyntheticTransaction): string {
  transactionCounter += 1;
  const kind = input.kind ?? "purchase";
  const categoryId =
    input.categoryId !== undefined
      ? input.categoryId
      : kind === "transfer"
        ? null
        : kind === "income"
          ? INCOME_CATEGORY
          : UNCATEGORIZED;
  const origin =
    input.origin ?? (kind === "transfer" || kind === "income" ? "system" : "unassigned");
  const id = input.id ?? uuid(transactionCounter, "10000000");

  db.prepare(
    `INSERT INTO transactions (id, account_id, posted_date, merchant_text, normalized_text,
       amount_cents, kind, category_id, assignment_origin, note, lifecycle, version,
       created_at, updated_at, assigned_at, original_posted_date, original_amount_cents, voided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, 1750000000000, 1750000000000,
       1750000000000, ?, ?, ?)`,
  ).run(
    id,
    input.accountId,
    input.postedDate,
    input.merchant ?? `SYNTHETIC MERCHANT ${String(transactionCounter)}`,
    `synthetic merchant ${String(transactionCounter)}`,
    BigInt(input.amountMinor),
    kind,
    categoryId,
    origin,
    input.lifecycle ?? "active",
    input.postedDate,
    BigInt(input.amountMinor),
    input.lifecycle === "void" ? 1750000000000 : null,
  );
  return id;
}

export function balanceOf(response: TestResponse): string | null {
  const body = response.body as { balance: { amountMinor: string } | null };
  return body.balance === null ? null : body.balance.amountMinor;
}
