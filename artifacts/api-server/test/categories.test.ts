import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withWriteTransaction } from "@workspace/db";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, INCOME_CATEGORY, postTransaction, UNCATEGORIZED, uuid } from "./finance-harness.js";
import { createCategory } from "../src/services/categories.js";

let api: TestServer;
const id = "abcdef00-0000-4000-8000-000000000001";
const input = { id, name: "Synthetic Food", color: "#123456" };
const path = `/api/categories/${id}`;
const headers = { "if-match": '"1"' };
beforeEach(async () => { api = await startTestServer(); await api.login(); });
afterEach(async () => { await api.close(); });
const create = (body: unknown = input) => api.request("/api/categories", { method: "POST", body });
const remove = () => api.request(path, { method: "DELETE", headers });
const snapshot = () => ({
  categories: api.db.prepare("SELECT * FROM categories ORDER BY id").all(),
  audit: api.db.prepare("SELECT * FROM audit_events ORDER BY id").all(),
  metadata: api.db.prepare("SELECT * FROM ledger_metadata").get(),
});

describe("category commands", () => {
  it("honors code-point limits for supplementary Unicode in requests and responses", async () => {
    const name = "\u{1f600}".repeat(60);
    const description = "\u{1f600}".repeat(280);
    expect((await create({ ...input, name, description })).status).toBe(201);
    expect((await api.request(path)).body).toMatchObject({ name, description });
    expect((await api.request("/api/categories")).status).toBe(200);
    const edit = await api.request(path, { method: "PATCH", headers, body: { name: "\u{1f601}".repeat(60), description } });
    expect(edit.status).toBe(200);
    expect((await api.request(`${path}/reactivate`, { method: "POST", headers: { "if-match": '"2"' } })).status).toBe(200);
    for (const body of [{ name: "\u{1f600}".repeat(61) }, { description: "\u{1f600}".repeat(281) }]) {
      expect((await api.request(path, { method: "PATCH", headers: { "if-match": '"2"' }, body })).status).toBe(422);
    }
  });

  it("supports embedded NUL characters without an accidental database refusal", async () => {
    const name = "\u0000a";
    expect((await create({ ...input, name })).status).toBe(201);
    await api.restart();
    expect((await api.request(path)).body).toMatchObject({ name });
    expect(api.db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(() => api.db.prepare("UPDATE categories SET display_name = ? WHERE id = ?")
      .run("\u0000" + "a".repeat(60), id)).toThrow(/CHECK/);
    expect(() => api.db.prepare("UPDATE categories SET description = ? WHERE id = ?")
      .run("\u0000" + "a".repeat(280), id)).toThrow(/CHECK/);
  });

  it("keeps the complete collection within the contract limit and permits replay at capacity", async () => {
    const context = { db: api.db, now: api.clock.now(), today: "2026-05-02", newId: api.deps.newId };
    withWriteTransaction(api.db, () => {
      for (let i = 0; i < 997; i++) createCategory(context, { ...input, id: uuid(i), name: `Category ${i}` });
    });
    expect((await create()).status).toBe(201);
    const before = snapshot();
    expect((await create({ ...input, id: uuid(998), name: "One too many" })).status).toBe(422);
    expect((await create()).status).toBe(200);
    expect(snapshot()).toEqual(before);
    for (const environment of ["test", "production"] as const) {
      api.deps.config.environment = environment;
      const list = await api.request("/api/categories?status=all");
      expect(list.status).toBe(200);
      expect((list.body as { items: unknown[] }).items).toHaveLength(1000);
    }
  });
  it("creates, updates, restarts and replays the current representation without duplicate writes", async () => {
    const first = await create({ ...input, id: id.toUpperCase() });
    expect(first.status).toBe(201);
    expect(first.headers.get("etag")).toBe('"1"');
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.body).toMatchObject({ category: { id, name: input.name, protected: false, version: "1" }, financeRevision: "1" });
    const edit = await api.request(path.toUpperCase().replace("/API/CATEGORIES/", "/api/categories/"), {
      method: "PATCH", headers, body: { name: "Synthetic Groceries", description: "Local shops" },
    });
    expect(edit.status).toBe(200);
    expect(edit.headers.get("etag")).toBe('"2"');
    await api.restart();
    const before = snapshot();
    const replay = await create({ ...input, description: null });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(edit.body);
    expect(snapshot()).toEqual(before);
    const conflict = await create({ ...input, color: "#654321" });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "client_id_conflict" });
    expect(snapshot()).toEqual(before);
  });

  it("keeps a deleted category deleted when the original create is retried", async () => {
    expect((await create()).status).toBe(201);
    expect((await remove()).status).toBe(204);
    expect((await api.request(path)).status).toBe(404);
    const before = snapshot();
    const replay = await create();
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ code: "client_id_conflict" });
    expect((await api.request(path)).status).toBe(404);
    expect(snapshot()).toEqual(before);
    // A different id is the supported way to create it again.
    expect((await create({ ...input, id: uuid(91) })).status).toBe(201);
  });

  it("uses case and whitespace normalized names, including archived and protected names", async () => {
    await create();
    for (const name of ["  SYNTHETIC\tFOOD  ", "Income", "  uncategorized "]) {
      const response = await create({ ...input, id: uuid(90), name });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "category_name_taken" });
    }
    api.db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(api.clock.now(), id);
    expect((await create({ ...input, id: uuid(90) })).status).toBe(409);
    expect((await create({ ...input, id: uuid(90), name: "Travel" })).status).toBe(201);
    const before = snapshot();
    expect((await api.request(`/api/categories/${uuid(90)}`, { method: "PATCH", headers, body: { name: "Synthetic Food" } })).status).toBe(409);
    expect(snapshot()).toEqual(before);
  });

  it("accepts a maximum-length name whose lowercase key expands beyond 60 characters", async () => {
    const name = "\u0130".repeat(60);
    expect((await create({ ...input, name })).status).toBe(201);
    expect(api.db.prepare("SELECT length(normalized_name) AS n FROM categories WHERE id = ?").get(id)).toEqual({ n: 120n });
    expect((await api.request(path)).body).toMatchObject({ name });
  });

  it.each(["", " \t\n", "\u00a0\u2003", "a".repeat(61)])("rejects invalid name %j without writes", async name => {
    const before = snapshot();
    const response = await create({ ...input, name });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: "validation_failed" });
    expect(snapshot()).toEqual(before);
  });

  it("rejects empty patches, unknown fields and invalid colors; nullable descriptions can be cleared", async () => {
    await create({ ...input, description: "Shops" });
    for (const body of [{}, { extra: true }, { color: "red" }, { name: "\t" }]) {
      const before = snapshot();
      expect((await api.request(path, { method: "PATCH", headers, body })).status).toBe(422);
      expect(snapshot()).toEqual(before);
    }
    const response = await api.request(path, { method: "PATCH", headers, body: { description: null } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ category: { name: input.name, description: null, color: input.color } });
  });

  it("always includes protected categories, filters custom categories and sorts by normalized name", async () => {
    await create();
    await create({ ...input, id: uuid(90), name: "Alpha" });
    api.db.prepare("UPDATE categories SET archived_at = ? WHERE id = ?").run(api.clock.now(), id);
    for (const [status, expected] of [
      ["active", [INCOME_CATEGORY, UNCATEGORIZED, uuid(90)]],
      ["archived", [INCOME_CATEGORY, UNCATEGORIZED, id]],
      ["all", [INCOME_CATEGORY, UNCATEGORIZED, uuid(90), id]],
    ] as const) {
      const response = await api.request(`/api/categories?status=${status}`);
      expect(response.status).toBe(200);
      expect((response.body as { items: { id: string }[] }).items.map(row => row.id)).toEqual(expected);
    }
    for (const query of ["status=deleted", "status=active&status=all"]) {
      expect((await api.request(`/api/categories?${query}`)).status).toBe(400);
    }
  });

  it.each([INCOME_CATEGORY, UNCATEGORIZED])("protects %s from all metadata edits and deletion; reactivation is unchanged", async protectedId => {
    const before = snapshot();
    for (const body of [{ name: "Rename" }, { color: "#FFFFFF" }, { description: "New" }]) {
      const response = await api.request(`/api/categories/${protectedId}`, { method: "PATCH", headers, body });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "category_protected" });
    }
    expect((await api.request(`/api/categories/${protectedId}`, { method: "DELETE", headers })).status).toBe(409);
    const reactivate = await api.request(`/api/categories/${protectedId}/reactivate`, { method: "POST", headers });
    expect(reactivate.status).toBe(200);
    expect(reactivate.headers.get("etag")).toBe('"1"');
    expect(snapshot()).toEqual(before);
  });

  it("requires authentication, CSRF and strong current versions even on retries", async () => {
    await create();
    const before = snapshot();
    expect((await api.request("/api/categories", { omitCookie: true })).status).toBe(401);
    expect((await api.request("/api/categories", { method: "POST", body: input, omitCookie: true })).status).toBe(401);
    expect((await api.request(path, { method: "DELETE", headers, csrfToken: null })).status).toBe(403);
    for (const [version, status] of [[undefined, 428], ['W/"1"', 400], ['"2"', 412]] as const) {
      expect((await api.request(path, { method: "DELETE", headers: version ? { "if-match": version } : {} })).status).toBe(status);
    }
    expect(snapshot()).toEqual(before);
    for (const missing of ["nonsense", uuid(999)]) expect((await api.request(`/api/categories/${missing}`)).status).toBe(404);
  });

  it("deletes only an unused category, retaining its audit and returning 404 on retry", async () => {
    await create();
    expect((await remove()).status).toBe(204);
    expect((await remove()).status).toBe(404);
    expect(api.db.prepare("SELECT event_type FROM audit_events WHERE entity_id = ? ORDER BY rowid").all(id))
      .toEqual([{ event_type: "category_created" }, { event_type: "category_deleted" }]);
    expect(api.db.prepare("SELECT finance_revision FROM ledger_metadata").get()).toEqual({ finance_revision: 2n });
  });

  it.each(["active", "void"])("retains a category referenced by a %s transaction", async lifecycle => {
    await create();
    const account = await createAccount(api);
    postTransaction(api.db, { accountId: account.id, categoryId: id, origin: "manual", postedDate: "2026-04-02",
      amountMinor: "-100", lifecycle: lifecycle as "active" | "void" });
    const before = snapshot();
    const response = await remove();
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "category_in_use", blocking: [{ kind: "transaction", count: 1 }] });
    expect(snapshot()).toEqual(before);
  });

  it("retains historical rule targets and does not enable disabled rules on reactivation", async () => {
    await create();
    const ruleId = uuid(77);
    withWriteTransaction(api.db, () => {
      api.db.prepare(`INSERT INTO rules (id, position, revision, creation_digest, version, created_at, updated_at)
        VALUES (?, 1, 1, ?, 1, ?, ?)`).run(ruleId, "a".repeat(64), api.clock.now(), api.clock.now());
      api.db.prepare(`INSERT INTO rule_revisions (rule_id, revision, change, match_type, pattern, normalized_pattern,
        applies_to, category_id, category_name, enabled, changed_at)
        VALUES (?, 1, 'created', 'contains', 'Market', 'market', 'purchases', ?, ?, 0, ?)`)
        .run(ruleId, id, input.name, api.clock.now());
    });
    api.db.prepare("UPDATE categories SET archived_at = ?, archive_cutoff_month = '2026-06' WHERE id = ?").run(api.clock.now(), id);
    const response = await api.request(`${path}/reactivate`, { method: "POST", headers });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ category: { status: "active", version: "2" } });
    expect(api.db.prepare("SELECT archive_cutoff_month FROM categories WHERE id = ?").get(id)).toEqual({ archive_cutoff_month: null });
    expect(api.db.prepare("SELECT enabled FROM rule_revisions WHERE rule_id = ?").get(ruleId)).toEqual({ enabled: 0n });
    expect((await api.request(path, { method: "PATCH", headers: { "if-match": '"2"' }, body: { name: "Renamed" } })).status).toBe(200);
    expect(api.db.prepare("SELECT category_name FROM rule_revisions WHERE rule_id = ?").get(ruleId)).toEqual({ category_name: input.name });
    const refused = await api.request(path, { method: "DELETE", headers: { "if-match": '"3"' } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ blocking: [{ kind: "rule", count: 1 }] });
  });

  it("blocks deletion when only an old assignment event retains the category", async () => {
    await create();
    const account = await createAccount(api);
    const tx = postTransaction(api.db, { accountId: account.id, postedDate: "2026-04-02", amountMinor: "-100" });
    api.db.prepare(`INSERT INTO assignment_events (id, transaction_id, occurred_at, event_type, source,
      before_category_id, after_category_id, related_ids_json) VALUES (?, ?, ?, 'category_changed', 'owner', ?, ?, '[]')`)
      .run(uuid(88), tx, api.clock.now(), id, UNCATEGORIZED);
    expect((await remove()).status).toBe(409);
  });

  it("blocks deletion when only a saved preview scope retains the category", async () => {
    await create();
    api.db.prepare(`INSERT INTO rule_runs (id, preview_json, rule_set_revision, created_at, expires_at)
      VALUES (?, ?, 0, ?, ?)`).run(uuid(88), JSON.stringify({ scope: { categoryIds: [id] } }), api.clock.now(), api.clock.now() + 86400000);
    const response = await remove();
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "category_in_use" });
  });

  it("rolls back the entity and revision if audit persistence fails", async () => {
    const before = snapshot();
    api.db.exec("CREATE TRIGGER fail_category_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect((await create()).status).toBe(500);
    expect(snapshot()).toEqual(before);
    api.db.exec("DROP TRIGGER fail_category_audit");
    expect((await create()).status).toBe(201);
  });

  it("checks the response before committing, including in production mode", async () => {
    api.deps.config.environment = "production";
    api.db.exec(`CREATE TRIGGER invalidate_category_result AFTER INSERT ON categories BEGIN
      UPDATE categories SET display_name = char(9) WHERE id = NEW.id; END`);
    const before = snapshot();
    expect((await create()).status).toBe(500);
    expect(snapshot()).toEqual(before);
  });
});
