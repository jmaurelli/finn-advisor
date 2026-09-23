/**
 * Tests added after the independent review of stage 2.
 *
 * The review planted real bugs in the code, one at a time, and found that the
 * whole suite still passed for several of them - most in the batched path that
 * serves the checkpoint list, the account's reconciliation summary and the
 * month summary's review counts. Each test here was confirmed to fail against
 * the code as it stood before the fixes, or against the planted bug it names.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTemporaryLedger } from "@workspace/db/testing";

import { balanceAt, balancesAt, type AccountBaseline } from "../src/domain/balances.js";
import { latestCheck, latestChecks } from "../src/domain/reconciliation.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, uuid } from "./finance-harness.js";

let api: TestServer;
let accountId: string;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  const created = await createAccount(api, {
    trackingStartDate: "2026-04-01",
    openingMinor: "125000",
  });
  accountId = created.id;
});

afterEach(async () => {
  await api.close();
});

async function addCheckpoint(
  statementMinor: string,
  options: { closingDate?: string; id?: string; account?: string } = {},
): Promise<{ id: string; status: number; body: Record<string, unknown> }> {
  const id = options.id ?? uuid(1, "70000000");
  const response = await api.request(`/api/accounts/${options.account ?? accountId}/checkpoints`, {
    method: "POST",
    body: {
      id,
      closingDate: options.closingDate ?? "2026-04-30",
      statementBalance: { amountMinor: statementMinor, currency: "USD" },
    },
  });
  return { id, status: response.status, body: response.body as Record<string, unknown> };
}

/** Status as the batched list path reports it. */
async function listedStatus(checkpointId: string): Promise<string> {
  const list = await api.request(`/api/accounts/${accountId}/checkpoints`);
  const items = (list.body as { items: { id: string; status: string }[] }).items;
  const found = items.find((item) => item.id === checkpointId);
  if (found === undefined) throw new Error("checkpoint not found");
  return found.status;
}

/** The account's reconciliation summary and the month summary's review counts. */
async function summaries(): Promise<{
  latestStatus: string | null;
  needsRecheck: number;
  difference: number;
  reviewNeedsRecheck: number;
  reviewDifference: number;
}> {
  const account = await api.request(`/api/accounts/${accountId}`);
  const reconciliation = (
    account.body as {
      reconciliation: { latestStatus: string | null; needsRecheckCount: number; differenceCount: number };
    }
  ).reconciliation;
  const summary = await api.request("/api/summary?month=2026-04");
  const review = (summary.body as { review: { needsRecheckCount: number; differenceCount: number } })
    .review;
  return {
    latestStatus: reconciliation.latestStatus,
    needsRecheck: reconciliation.needsRecheckCount,
    difference: reconciliation.differenceCount,
    reviewNeedsRecheck: review.needsRecheckCount,
    reviewDifference: review.differenceCount,
  };
}

const RECONCILED = {
  latestStatus: "reconciled",
  needsRecheck: 0,
  difference: 0,
  reviewNeedsRecheck: 0,
  reviewDifference: 0,
};

describe("derived status through the batched path", () => {
  it("ignores a voided row dated before the closing date", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    const { id } = await addCheckpoint("117000");
    postTransaction(api.db, {
      accountId,
      postedDate: "2026-04-10",
      amountMinor: "-2500",
      lifecycle: "void",
    });

    expect(await listedStatus(id)).toBe("reconciled");
    expect(await summaries()).toEqual(RECONCILED);
  });

  it("counts a row posted on the closing date itself", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-30", amountMinor: "-8000" });
    const { id, body } = await addCheckpoint("117000");
    expect((body["checkpoint"] as { status: string }).status).toBe("reconciled");
    expect(await listedStatus(id)).toBe("reconciled");
    expect(await summaries()).toEqual(RECONCILED);

    // And a row added later on that same day changes it.
    postTransaction(api.db, { accountId, postedDate: "2026-04-30", amountMinor: "-100" });
    expect(await listedStatus(id)).toBe("needs_recheck");
    expect((await summaries()).needsRecheck).toBe(1);
  });

  it("ignores rows dated before the tracking start", async () => {
    const { id } = await addCheckpoint("125000");
    postTransaction(api.db, { accountId, postedDate: "2026-03-15", amountMinor: "-4000" });

    expect(await listedStatus(id)).toBe("reconciled");
    expect(await summaries()).toEqual(RECONCILED);
  });

  it("derives status from the newest of several checks, not the oldest", async () => {
    const { id } = await addCheckpoint("125000");
    postTransaction(api.db, { accountId, postedDate: "2026-04-15", amountMinor: "-2500" });

    api.clock.advance(60_000);
    const recheck = await api.request(`/api/accounts/${accountId}/checkpoints/${id}/recheck`, {
      method: "POST",
      headers: { "if-match": '"1"' },
    });
    expect(recheck.status).toBe(200);

    expect(await listedStatus(id)).toBe("difference");
    const after = await summaries();
    expect(after.latestStatus).toBe("difference");
    expect(after.difference).toBe(1);
    expect(after.reviewDifference).toBe(1);
    expect(after.needsRecheck).toBe(0);
  });

  it("picks the check recorded last when two share the same millisecond", async () => {
    const { id } = await addCheckpoint("125000");
    const insert = api.db.prepare(
      `INSERT INTO checkpoint_checks (id, checkpoint_id, checked_at, calculated_cents,
         difference_cents, matched)
       VALUES (?, ?, 1780000000000, 125000, ?, ?)`,
    );
    // Production ids are random, so the check recorded last can sort either
    // way. Here it deliberately sorts first.
    insert.run("ffffffff-0000-4000-8000-000000000001", id, 500n, 0);
    insert.run("00000000-0000-4000-8000-000000000001", id, 0n, 1);

    expect(await listedStatus(id)).toBe("reconciled");
    expect(latestCheck(api.db, id)?.id).toBe("00000000-0000-4000-8000-000000000001");
    expect(latestChecks(api.db, accountId).get(id)?.id).toBe(
      "00000000-0000-4000-8000-000000000001",
    );

    const history = await api.request(`/api/accounts/${accountId}/checkpoints/${id}/history`);
    const checks = (history.body as { checks: { id: string }[] }).checks;
    expect(checks[0].id).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("refuses a checkpoint id already used on another account, even with the same values", async () => {
    const other = await createAccount(api, { id: uuid(2), trackingStartDate: "2026-04-01" });
    const first = await addCheckpoint("125000");
    expect(first.status).toBe(201);

    const reused = await addCheckpoint("125000", { id: first.id, account: other.id });
    expect(reused.status).toBe(409);
    expect((reused.body as { code: string }).code).toBe("client_id_conflict");
  });

  it("leaves voided rows out of the uncategorized review count", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, {
      accountId,
      postedDate: "2026-04-03",
      amountMinor: "-900",
      lifecycle: "void",
    });
    const summary = await api.request("/api/summary?month=2026-04");
    expect((summary.body as { review: { uncategorizedCount: number } }).review.uncategorizedCount).toBe(1);
  });
});

describe("the batched balance agrees with the single-date balance", () => {
  it("for random ledgers and random date lists", () => {
    // A seeded generator keeps any failure reproducible.
    let seed = 20260921;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const date = (dayOffset: number): string =>
      new Date(Date.UTC(2026, 2, 1) + dayOffset * 86_400_000).toISOString().slice(0, 10);

    const ledger = createTemporaryLedger();
    try {
      const { db } = ledger;
      for (let round = 0; round < 40; round += 1) {
        const id = uuid(1000 + round);
        const start = date(10 + random(40));
        const baseline: AccountBaseline = {
          id,
          trackingStartDate: start,
          openingCents: BigInt(random(500000) - 250000),
        };
        db.prepare(
          `INSERT INTO accounts (id, kind, provider_key, display_name, masked_suffix,
             tracking_start_date, opening_cents, archived_at, creation_digest, version,
             ledger_revision, created_at, updated_at)
           VALUES (?, 'checking', 'chase', 'Synthetic', NULL, ?, ?, NULL, ?, 1, 0, 1, 1)`,
        ).run(id, start, baseline.openingCents, "a".repeat(64));

        const rows = random(30);
        for (let n = 0; n < rows; n += 1) {
          postTransaction(db, {
            accountId: id,
            // Some rows fall before the tracking start on purpose.
            postedDate: date(random(90)),
            amountMinor: String(-(1 + random(50000))),
            lifecycle: random(5) === 0 ? "void" : "active",
          });
        }

        const dates = Array.from({ length: 1 + random(12) }, () => date(random(100)));
        dates.push(dates[0]); // a duplicate
        const before = new Date(Date.parse(`${start}T00:00:00Z`) - 86_400_000);
        dates.push(before.toISOString().slice(0, 10)); // the day before the start
        dates.push(date(0)); // well before coverage

        const batched = balancesAt(db, baseline, dates);
        for (const wanted of dates) {
          expect([round, wanted, batched.get(wanted)]).toEqual([
            round,
            wanted,
            balanceAt(db, baseline, wanted).balance,
          ]);
        }
      }
    } finally {
      ledger.close();
    }
  });
});

describe("account names", () => {
  it("refuses a name that is only spaces, on create and on rename", async () => {
    const created = await createAccount(api, { id: uuid(3), displayName: "   " });
    expect(created.response.status).toBe(422);
    expect(created.response.body).toMatchObject({
      code: "validation_failed",
      fieldErrors: [{ path: "/displayName" }],
    });

    const account = await api.request(`/api/accounts/${accountId}`);
    const renamed = await api.request(`/api/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "if-match": account.headers.get("etag") ?? "" },
      body: { displayName: "\t  " },
    });
    expect(renamed.status).toBe(422);
    expect(renamed.body).toMatchObject({
      code: "validation_failed",
      fieldErrors: [{ path: "/displayName" }],
    });
  });
});

describe("id letter case", () => {
  it("treats an upper-case id as the same id, never as a second account", async () => {
    const upper = "ABCDEF00-0000-4000-8000-000000000001";
    const lower = upper.toLowerCase();

    const created = await createAccount(api, { id: upper });
    expect(created.response.status).toBe(201);
    expect((created.response.body as { account: { id: string } }).account.id).toBe(lower);

    expect((await api.request(`/api/accounts/${lower}`)).status).toBe(200);
    expect((await api.request(`/api/accounts/${upper}`)).status).toBe(200);

    // The same create with the other spelling is a retry, not a new account.
    const twin = await createAccount(api, { id: lower });
    expect(twin.response.status).toBe(200);
    const list = await api.request("/api/accounts");
    const ids = (list.body as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids.filter((id) => id === lower)).toHaveLength(1);
  });

  it("does the same for a checkpoint id", async () => {
    const upper = "ABCDEF00-0000-4000-8000-000000000070";
    const first = await addCheckpoint("125000", { id: upper });
    expect(first.status).toBe(201);
    const again = await addCheckpoint("125000", { id: upper.toLowerCase() });
    expect(again.status).toBe(200);
  });
});

describe("days that have not happened", () => {
  it("keeps listing accounts if the clock steps back past a tracking start", async () => {
    // The test clock's today is 2026-05-02 (Eastern).
    const created = await createAccount(api, {
      id: uuid(4),
      trackingStartDate: "2026-05-02",
      openingMinor: "5000",
    });
    expect(created.response.status).toBe(201);

    api.clock.advance(-3 * 86_400_000);
    const list = await api.request("/api/accounts");
    expect(list.status).toBe(200);
    const item = (
      list.body as { items: { id: string; currentBalance: unknown; balanceAsOf: string }[] }
    ).items.find((row) => row.id === created.id);
    // The opening balance is exactly the closing balance of the day before the
    // start, so that is the date it is reported for - never a made-up "today".
    expect(item).toMatchObject({
      currentBalance: { amountMinor: "5000", currency: "USD" },
      balanceAsOf: "2026-05-01",
    });
    expect((await api.request(`/api/accounts/${created.id}`)).status).toBe(200);
  });

  it("refuses a statement closing date after today, and accepts today", async () => {
    const tomorrow = await addCheckpoint("125000", { closingDate: "2026-05-03" });
    expect(tomorrow.status).toBe(422);
    expect(tomorrow.body).toMatchObject({
      code: "validation_failed",
      fieldErrors: [{ path: "/closingDate" }],
    });

    const today = await addCheckpoint("125000", { closingDate: "2026-05-02", id: uuid(2, "70000000") });
    expect(today.status).toBe(201);
  });

  it("reports a future month's balances as of today, not a month end still to come", async () => {
    postTransaction(api.db, { accountId, postedDate: "2026-04-02", amountMinor: "-8000" });
    // A row dated after today (as a pending bank entry might be).
    postTransaction(api.db, { accountId, postedDate: "2026-05-20", amountMinor: "-500" });

    const summary = await api.request("/api/summary?month=2026-12");
    expect(summary.status).toBe(200);
    const accounts = (summary.body as { accounts: { accountId: string; balance: unknown }[] })
      .accounts;
    expect(accounts.find((row) => row.accountId === accountId)?.balance).toEqual({
      amountMinor: "117000",
      currency: "USD",
    });
  });
});

describe("write responses are checked before the change commits", () => {
  it("rolls the change back when the response would break the contract", async () => {
    const { withWriteTransaction } = await import("@workspace/db");
    const { UpdateAccountResponse } = await import("@workspace/api-zod");
    const { checkedResponse } = await import("../src/lib/respond.js");

    const ledger = createTemporaryLedger();
    try {
      const { db } = ledger;
      expect(() =>
        withWriteTransaction(db, () => {
          db.prepare("UPDATE ledger_metadata SET finance_revision = 99 WHERE id = 1").run();
          // Not a valid account response: this must stop the commit.
          return checkedResponse(UpdateAccountResponse, { account: { id: "x" } });
        }),
      ).toThrow(/does not match the contract/);
      const row = db.prepare("SELECT finance_revision FROM ledger_metadata WHERE id = 1").get() as {
        finance_revision: bigint;
      };
      expect(row.finance_revision).not.toBe(99n);
    } finally {
      ledger.close();
    }
  });
});
