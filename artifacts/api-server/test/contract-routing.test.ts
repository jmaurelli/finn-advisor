/**
 * Every operation the contract declares is actually served.
 *
 * This exists because three operations - `exportTransactionsCsv`,
 * `exportLedgerJson` and `getBackupStatus` - were fully specified, had
 * generated clients and validators, passed every contract check, and had no
 * implementation at all. Nothing noticed, because the contract checks read the
 * document and the service tests only cover routes someone wrote a test for.
 * A specified operation that answers nothing is a promise the document makes
 * and the service breaks.
 *
 * Each request is sent **unauthenticated**, which is what makes this safe to
 * run against every path including the writes: `requireSession` is attached
 * per route, so a 401 proves the route matched without any handler running and
 * without touching a single row. An unrouted path instead falls through to the
 * catch-all, which answers with its own distinct detail - and that is the one
 * response this test treats as a failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestServer, type TestServer } from "./harness.js";
import { spec } from "./contract-support.js";

/** The catch-all's wording. Matching on it is what separates "no such route" from "no such record". */
const NOTHING_HERE = "There is nothing at this address.";

const PLACEHOLDER = "99999999-9999-4999-8999-999999999999";

interface Operation { method: string; path: string; operationId: string }

function declaredOperations(): Operation[] {
  const paths = (spec as unknown as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  }).paths;
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = item[method];
      if (operation?.operationId === undefined) continue;
      operations.push({ method, path, operationId: operation.operationId });
    }
  }
  return operations;
}

/** `/imports/{importId}/rows/{rowId}` becomes a concrete, certainly-absent path. */
const concrete = (path: string): string => path.replace(/\{[^}]+\}/g, PLACEHOLDER);

let api: TestServer;
beforeEach(async () => { api = await startTestServer(); });
afterEach(async () => { await api.close(); });

describe("every declared operation is routed", () => {
  const operations = declaredOperations();

  it("found the whole blueprint to check", () => {
    // If this number collapses, the walk below is passing by checking nothing.
    expect(operations.length).toBe(77);
  });

  it.each(operations)("$method $path ($operationId)", async ({ method, path }) => {
    const response = await api.request(`/api${concrete(path)}`, {
      method: method.toUpperCase(),
      omitCookie: true,
      csrfToken: null,
      ...(["post", "patch", "put"].includes(method) ? { body: {} } : {}),
    });
    const detail = (response.body as { detail?: string } | undefined)?.detail;
    expect(detail, `${method.toUpperCase()} ${path} is declared but nothing serves it`)
      .not.toBe(NOTHING_HERE);
  });

  it("fails for a path the contract does not declare, so the check is real", async () => {
    // Proves the signal works: an address nothing serves must look different
    // from one that does.
    const response = await api.request("/api/not-an-operation", { omitCookie: true });
    expect((response.body as { detail: string }).detail).toBe(NOTHING_HERE);
  });
});
