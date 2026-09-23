import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";

import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, uuid } from "./finance-harness.js";

let api: TestServer;
const NOW = 1770000000000;
const DIGEST = "a".repeat(64);
const CATEGORY = uuid(30, "30000000");
const RULE = uuid(40, "40000000");

beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});
afterEach(async () => { await api.close(); });

function scopedRule(accountId: string): void {
  withWriteTransaction(api.db, () => {
    api.db.prepare(`INSERT INTO categories (id, display_name, normalized_name, color, protected,
      version, created_at, updated_at) VALUES (?, 'Food', 'food', '#112233', 0, 1, ?, ?)`)
      .run(CATEGORY, NOW, NOW);
    api.db.prepare(`INSERT INTO rules (id, position, revision, creation_digest, version, created_at, updated_at)
      VALUES (?, 1, 1, ?, 1, ?, ?)`).run(RULE, DIGEST, NOW, NOW);
    api.db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern,
      normalized_pattern, account_id, applies_to, category_id, category_name, enabled, changed_at)
      VALUES (?, 1, 'created', 'contains', 'Market', 'market', ?, 'purchases_and_refunds', ?, 'Food', 1, ?)`)
      .run(RULE, accountId, CATEGORY, NOW);
  });
}

async function unmatched(): Promise<number> {
  const response = await api.request("/api/summary?month=2026-04");
  expect(response.status).toBe(200);
  return (response.body as { review: { unmatchedTransferCount: number } }).review.unmatchedTransferCount;
}

describe("Stage 3 replaces the forward placeholders", () => {
  it("returns a readable blocker for an account referenced only by a scoped rule", async () => {
    const { id, etag } = await createAccount(api);
    scopedRule(id);
    const response = await api.request(`/api/accounts/${id}`, { method: "DELETE", headers: { "if-match": etag } });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "account_in_use", blocking: [{ kind: "rule", count: 1, ids: [RULE] }] });
    expect((await api.request(`/api/accounts/${id}`)).status).toBe(200);
  });

  it("retains the blocker after an old rule scope is changed and archived", async () => {
    const { id, etag } = await createAccount(api);
    scopedRule(id);
    api.db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern,
      normalized_pattern, account_id, applies_to, category_id, category_name, enabled, changed_at)
      VALUES (?, 2, 'archived', 'contains', 'Market', 'market', NULL, 'purchases_and_refunds', ?, 'Food', 0, ?)`)
      .run(RULE, CATEGORY, NOW + 1);
    api.db.prepare("UPDATE rules SET revision = 2, archived_at = ?, position = NULL").run(NOW + 1);
    const response = await api.request(`/api/accounts/${id}`, { method: "DELETE", headers: { "if-match": etag } });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ blocking: [{ kind: "rule", count: 1, ids: [RULE] }] });
  });

  it("counts active unpaired transfers across months and archived accounts, never voids", async () => {
    const { id } = await createAccount(api);
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-100", kind: "transfer" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-03-02", amountMinor: "-100", kind: "transfer" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-100", kind: "transfer", lifecycle: "void" });
    postTransaction(api.db, { accountId: id, postedDate: "2026-04-02", amountMinor: "-100", kind: "purchase" });
    api.db.prepare("UPDATE accounts SET archived_at = ?").run(NOW);
    expect(await unmatched()).toBe(2);
  });

  it("updates the unmatched count after pairing/unlinking and reports transfer deletion references", async () => {
    const first = await createAccount(api);
    const second = await createAccount(api, { id: uuid(2) });
    const a = postTransaction(api.db, { accountId: first.id, postedDate: "2026-04-02", amountMinor: "-100", kind: "transfer" });
    const b = postTransaction(api.db, { accountId: second.id, postedDate: "2026-04-03", amountMinor: "100", kind: "transfer" });
    expect(await unmatched()).toBe(2);
    withWriteTransaction(api.db, () => {
      api.db.prepare("INSERT INTO transfer_pairs (id, creation_digest, version, created_at) VALUES (?, ?, 1, ?)")
        .run(uuid(50), DIGEST, NOW);
      api.db.prepare("INSERT INTO transfer_legs VALUES (?, 1, ?), (?, 2, ?)").run(uuid(50), a, uuid(50), b);
    });
    expect(await unmatched()).toBe(0);
    const refused = await api.request(`/api/accounts/${first.id}`, { method: "DELETE", headers: { "if-match": first.etag } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ blocking: [
      { kind: "transaction", count: 1, ids: [a] },
      { kind: "transfer_leg", count: 1, ids: [a] },
    ] });
    api.db.prepare("DELETE FROM transfer_pairs").run();
    expect(await unmatched()).toBe(2);
  });
});
