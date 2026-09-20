/**
 * Helpers for the finance tests.
 *
 * Transactions are inserted directly, because the commands that create them
 * are stage 3. That is deliberate and it is also a limit worth stating: these
 * tests prove the balance and reconciliation arithmetic, not the posting path
 * that will produce those rows later.
 */
import type { SqliteDatabase } from "@workspace/db";

import type { TestServer, TestResponse } from "./harness.js";

export const UNCATEGORIZED = "30000000-0000-4000-8000-000000000000";
export const INCOME_CATEGORY = "30000000-0000-4000-8000-000000000001";

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

/** Writes a transaction straight into the ledger, as a future import will. */
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
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, 1750000000000, 1750000000000)`,
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
  );
  return id;
}

export function balanceOf(response: TestResponse): string | null {
  const body = response.body as { balance: { amountMinor: string } | null };
  return body.balance === null ? null : body.balance.amountMinor;
}
