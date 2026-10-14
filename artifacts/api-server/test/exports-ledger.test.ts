/**
 * The whole-ledger JSON export.
 *
 * Two properties carry the weight. It must validate against the contract with
 * real data in every collection, not just an empty database - an export that
 * only type-checks when there is nothing to export proves nothing. And it must
 * be an allowlist: the test that matters most is the one that fails when a
 * secret starts appearing, so this scans the serialized document for material
 * that must never be in it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportLedger, LEDGER_EXPORT_FORMAT_VERSION } from "../src/services/exports-ledger.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, uuid } from "./finance-harness.js";
import { spec, validateAgainst } from "./contract-support.js";

let api: TestServer;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});
afterEach(async () => { await api.close(); });

/** A ledger with something in most collections, built through the real API. */
async function populate(): Promise<void> {
  await createAccount(api, { displayName: "Synthetic Checking" });
  postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02",
    amountMinor: "-8000", merchant: "SYNTHETIC MARKET" });
  postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-09",
    amountMinor: "3000", kind: "refund", merchant: "SYNTHETIC REFUND" });
  const category = await api.request("/api/categories", { method: "POST", body: {
    id: uuid(80, "30000000"), name: "Synthetic Groceries", color: "#2f7d72" } });
  expect(category.status, category.text).toBe(201);
  const rule = await api.request("/api/rules", { method: "POST", body: {
    id: uuid(90, "40000000"), matchType: "contains", pattern: "SYNTHETIC MARKET",
    categoryId: uuid(80, "30000000"), appliesTo: "purchases" } });
  expect(rule.status, rule.text).toBe(201);
}

const ledger = () => exportLedger(api.db, api.clock.now(), "2026-05-02");

describe("the document", () => {
  it("validates against the contract with every collection populated", async () => {
    await populate();
    const body = ledger();
    // Not an empty database: an export that only validates when there is
    // nothing in it has not been tested.
    expect((body["accounts"] as unknown[]).length).toBeGreaterThan(0);
    expect((body["transactions"] as unknown[]).length).toBeGreaterThan(0);
    expect((body["categories"] as unknown[]).length).toBeGreaterThan(0);
    expect((body["rules"] as unknown[]).length).toBeGreaterThan(0);
    expect(() => validateAgainst("LedgerExport", body)).not.toThrow();
  });

  it("validates on an untouched ledger too", () => {
    // The seeded categories exist from the start; everything else is empty.
    expect(() => validateAgainst("LedgerExport", ledger())).not.toThrow();
  });

  it("declares its format version, currency and timezone", () => {
    const body = ledger();
    expect(body["formatVersion"]).toBe(LEDGER_EXPORT_FORMAT_VERSION);
    expect([body["currency"], body["timezone"]]).toEqual(["USD", "America/New_York"]);
    expect(body["exportedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
  });

  it("carries every collection the contract requires, and no others", () => {
    const required = ((spec as unknown as { components: { schemas: Record<string, {
      required: string[] }> } }).components.schemas["LedgerExport"]!).required;
    expect(Object.keys(ledger()).sort()).toEqual([...required].sort());
  });
});

describe("it is an allowlist, not a denylist", () => {
  it("contains no credential, session or filesystem material", async () => {
    await populate();
    // Uploading would be the way raw file paths could leak in; there is no
    // upload here, so this checks the shape of everything else.
    const text = JSON.stringify(ledger());
    for (const forbidden of [
      "password", "passwordHash", "password_hash", "argon", "$2b$",
      "csrf", "session", "cookie", "secret", "token",
      "storageKey", "storage_key", "creationDigest", "creation_digest",
      "/home/", "/var/", "/tmp/", "sha256",
    ]) {
      expect(text.toLowerCase(), `${forbidden} must not appear`)
        .not.toContain(forbidden.toLowerCase());
    }
  });

  it("names its collections explicitly, so a new table is absent by default", () => {
    // The guard against leaking by default: these keys are written out one by
    // one in the service, never gathered from sqlite_master or a row spread.
    const tables = (api.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]).map(row => row.name);
    // Tables that hold material the export must never carry.
    for (const sensitive of ["owner_auth", "sessions", "uploads", "source_identities"]) {
      if (!tables.includes(sensitive)) continue;
      expect(Object.keys(ledger())).not.toContain(sensitive);
    }
  });
});

describe("what it says about records", () => {
  it("reports a transaction the same way the API does", async () => {
    await populate();
    const fromApi = await api.request(`/api/transactions?accountId=${uuid(1)}`);
    const listed = (fromApi.body as { items: { id: string }[] }).items;
    const exported = ledger()["transactions"] as { id: string }[];
    // Same builder, so the same record must serialize identically.
    for (const item of listed) {
      const match = exported.find(row => row.id === item.id);
      expect(match, `transaction ${item.id} missing from the export`).toBeDefined();
      expect(match).toEqual(item);
    }
  });

  it("orders deterministically, so two exports of unchanged data match", async () => {
    await populate();
    expect(JSON.stringify(ledger())).toBe(JSON.stringify(ledger()));
  });

  it("exports a budget plan only for a category that has one", async () => {
    await populate();
    expect(ledger()["budgetPlans"]).toEqual([]);
    const category = uuid(80, "30000000");
    const preview = await api.request(`/api/budget-plans/${category}/preview-change`, {
      method: "POST", body: { change: "set_regular", fromMonth: "2026-06",
        amount: { amountMinor: "40000", currency: "USD" } },
    });
    expect(preview.status, preview.text).toBe(201);
    const applied = await api.request(`/api/budget-plans/${category}/apply-change`, {
      method: "POST", body: { previewId: (preview.body as { id: string }).id },
    });
    expect(applied.status, applied.text).toBe(200);
    const plans = ledger()["budgetPlans"] as { categoryId: string }[];
    expect(plans.map(p => p.categoryId)).toEqual([category]);
  });
});

describe("the route", () => {
  it("is an uncacheable attachment that validates", async () => {
    await populate();
    const response = await api.request("/api/exports/ledger.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition"))
      .toMatch(/^attachment; filename="money-desk-ledger-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(() => validateAgainst("LedgerExport", response.body)).not.toThrow();
  });

  it("refuses a signed-out reader", async () => {
    const response = await api.request("/api/exports/ledger.json", { omitCookie: true });
    expect(response.status).toBe(401);
  });
});
