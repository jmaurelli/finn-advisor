import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, UNCATEGORIZED, uuid } from "./finance-harness.js";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});

afterEach(async () => {
  await api.close();
});

interface Summary {
  month: string;
  asOf: string;
  spending: { purchases: Money; refunds: Money; net: Money };
  income: Money;
  categories: { categoryId: string; net: Money; transactionCount: number }[];
  uncategorized: { net: Money; transactionCount: number };
  accounts: { accountId: string; balance: Money | null; coverage: string }[];
  review: Record<string, number>;
  financeRevision: string;
}
interface Money {
  amountMinor: string;
  currency: string;
}

async function summary(month: string): Promise<Summary> {
  const response = await api.request(`/api/summary?month=${month}`);
  expect(response.status).toBe(200);
  return response.body as Summary;
}

describe("the month summary", () => {
  it("reports zero for an empty month rather than failing or reporting nothing", async () => {
    await createAccount(api, { openingMinor: "125000" });
    const april = await summary("2026-04");

    expect(april.spending.purchases.amountMinor).toBe("0");
    expect(april.spending.refunds.amountMinor).toBe("0");
    expect(april.spending.net.amountMinor).toBe("0");
    expect(april.income.amountMinor).toBe("0");
    expect(april.categories).toEqual([]);
    expect(april.uncategorized).toEqual({
      net: { amountMinor: "0", currency: "USD" },
      transactionCount: 0,
    });
  });

  it("reports purchases minus refunds, and income separately", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-10", amountMinor: "-2500" });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-12",
      amountMinor: "1500",
      kind: "refund",
      origin: "manual",
    });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-15",
      amountMinor: "450000",
      kind: "income",
    });

    const april = await summary("2026-04");
    expect(april.spending.purchases.amountMinor).toBe("10500");
    expect(april.spending.refunds.amountMinor).toBe("1500");
    expect(april.spending.net.amountMinor).toBe("9000");
    expect(april.income.amountMinor).toBe("450000");
  });

  it("counts a card payment once: $80 of spending, never $160", async () => {
    // The acceptance case from the design. An $80 purchase on the card, and
    // the $80 payment from checking that settles it. The payment is a
    // transfer: it moves money between owned accounts and is not spending.
    const checking = await createAccount(api, {
      id: uuid(1),
      kind: "checking",
      displayName: "Synthetic Checking",
      openingMinor: "125000",
    });
    const card = await createAccount(api, {
      id: uuid(2),
      kind: "credit_card",
      displayName: "Synthetic Card",
      providerKey: "american_express",
      openingMinor: "0",
    });

    postTransaction(api.db, {
      accountId: card.id,
      postedDate: "2026-04-02",
      amountMinor: "-8000",
    });
    postTransaction(api.db, {
      accountId: checking.id,
      postedDate: "2026-04-20",
      amountMinor: "-8000",
      kind: "transfer",
    });
    postTransaction(api.db, {
      accountId: card.id,
      postedDate: "2026-04-20",
      amountMinor: "8000",
      kind: "transfer",
    });

    const april = await summary("2026-04");
    expect(april.spending.purchases.amountMinor).toBe("8000");
    expect(april.spending.net.amountMinor).toBe("8000");

    // The transfers moved the balances and nothing else.
    const balances = new Map(april.accounts.map((entry) => [entry.accountId, entry.balance]));
    expect(balances.get(checking.id)?.amountMinor).toBe("117000");
    expect(balances.get(card.id)?.amountMinor).toBe("0");
  });

  it("counts the same $80 the same way when the files arrive in the other order", async () => {
    const checking = await createAccount(api, { id: uuid(1), openingMinor: "125000" });
    const card = await createAccount(api, {
      id: uuid(2),
      kind: "credit_card",
      displayName: "Synthetic Card",
      openingMinor: "0",
    });

    // Payment first, purchase second.
    postTransaction(api.db, {
      accountId: checking.id,
      postedDate: "2026-04-20",
      amountMinor: "-8000",
      kind: "transfer",
    });
    postTransaction(api.db, {
      accountId: card.id,
      postedDate: "2026-04-20",
      amountMinor: "8000",
      kind: "transfer",
    });
    postTransaction(api.db, {
      accountId: card.id,
      postedDate: "2026-04-02",
      amountMinor: "-8000",
    });

    const april = await summary("2026-04");
    expect(april.spending.net.amountMinor).toBe("8000");
  });

  it("excludes voided rows from every total", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-03",
      amountMinor: "-50000",
      lifecycle: "void",
    });
    postTransaction(api.db, {
      accountId: id,
      postedDate: "2026-04-04",
      amountMinor: "99000",
      kind: "income",
      lifecycle: "void",
    });

    const april = await summary("2026-04");
    expect(april.spending.net.amountMinor).toBe("8000");
    expect(april.income.amountMinor).toBe("0");
    expect(april.uncategorized.transactionCount).toBe(1);
  });

  it("keeps months apart by posted date", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-30", amountMinor: "-1000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-05-01", amountMinor: "-2000" });

    expect((await summary("2026-04")).spending.net.amountMinor).toBe("1000");
    expect((await summary("2026-05")).spending.net.amountMinor).toBe("2000");
  });

  it("reports per-account balances at month end, and today for the running month", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-05-20", amountMinor: "-3000" });

    // Today is 2026-05-02 Eastern in the harness, so May's balance is today's
    // and does not include a transaction dated later in the month.
    const may = await summary("2026-05");
    expect(may.asOf).toBe("2026-05-02");
    expect(may.accounts[0].balance?.amountMinor).toBe("117000");

    const april = await summary("2026-04");
    expect(april.accounts[0].balance?.amountMinor).toBe("117000");
  });

  it("reports an account whose coverage has not reached the month as outside coverage", async () => {
    const { id } = await createAccount(api, {
      trackingStartDate: "2026-04-01",
      openingMinor: "125000",
    });
    const january = await summary("2026-01");
    expect(january.accounts[0].accountId).toBe(id);
    expect(january.accounts[0].coverage).toBe("outside_coverage");
    expect(january.accounts[0].balance).toBeNull();
  });

  it("groups spending by category and counts what still needs review", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-8000" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-03", amountMinor: "-1000" });

    const april = await summary("2026-04");
    expect(april.categories).toEqual([
      {
        categoryId: UNCATEGORIZED,
        purchases: { amountMinor: "9000", currency: "USD" },
        refunds: { amountMinor: "0", currency: "USD" },
        net: { amountMinor: "9000", currency: "USD" },
        transactionCount: 2,
      },
    ]);
    expect(april.uncategorized.transactionCount).toBe(2);
    expect(april.review["uncategorizedCount"]).toBe(2);
  });

  it("reports the reconciliation counts it can compute, and zero for what later stages own", async () => {
    const { id } = await createAccount(api, { openingMinor: "125000" });
    await api.request(`/api/accounts/${id}/checkpoints`, {
      method: "POST",
      body: {
        id: uuid(1, "70000000"),
        closingDate: "2026-04-30",
        statementBalance: { amountMinor: "999", currency: "USD" },
      },
    });

    const april = await summary("2026-04");
    expect(april.review["differenceCount"]).toBe(1);
    expect(april.review["needsRecheckCount"]).toBe(0);
    // These three have no table to count yet; the forward guard in
    // accounts.test.ts fails as soon as one arrives.
    expect(april.review["openImportCount"]).toBe(0);
    expect(april.review["heldImportRowCount"]).toBe(0);
    expect(april.review["unmatchedTransferCount"]).toBe(0);
  });

  it("refuses a missing or unusable month", async () => {
    expect((await api.request("/api/summary")).status).toBe(400);
    expect((await api.request("/api/summary?month=2026-13")).status).toBe(400);
    expect((await api.request("/api/summary?month=2026-4")).status).toBe(400);
    expect((await api.request("/api/summary?month=2026-04-01")).status).toBe(400);
  });

  it("needs a session", async () => {
    const response = await api.request("/api/summary?month=2026-04", { omitCookie: true });
    expect(response.status).toBe(401);
  });
});
