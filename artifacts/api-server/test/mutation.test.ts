/**
 * Deliberate breakage.
 *
 * A passing test suite only means something if it fails when the thing it
 * guards is removed. Each test here disables one safety rule and shows the
 * scenario that should have caught it now behaving differently, so the tests
 * in the other files are demonstrably sensitive to that rule and not passing
 * by accident.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/middlewares/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/middlewares/session.js")>();
  const mutations = globalThis as { __moneyDeskDisableCsrf?: boolean };
  return {
    ...actual,
    requireCsrf: (req: unknown, res: unknown, next: () => void) => {
      if (mutations.__moneyDeskDisableCsrf === true) {
        next();
        return;
      }
      actual.requireCsrf(req as never, res as never, next as never);
    },
  };
});

vi.mock("../src/auth/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/sessions.js")>();
  const mutations = globalThis as { __moneyDeskExtendOnRead?: boolean };
  return {
    ...actual,
    lookupSession: (db: never, token: never, now: never) => {
      const lookup = actual.lookupSession(db, token, now);
      if (mutations.__moneyDeskExtendOnRead === true && lookup.state === "active") {
        // The mutation: a plain read moves the idle deadline.
        return { ...lookup, session: actual.recordActivity(db, lookup.session, now) };
      }
      return lookup;
    },
  };
});

const { SESSION_IDLE_MS } = await import("../src/config.js");
const { startTestServer } = await import("./harness.js");

const mutations = globalThis as {
  __moneyDeskDisableCsrf?: boolean;
  __moneyDeskExtendOnRead?: boolean;
};

afterEach(() => {
  mutations.__moneyDeskDisableCsrf = false;
  mutations.__moneyDeskExtendOnRead = false;
});

describe("without the CSRF check", () => {
  it("a write with no security token would be accepted", async () => {
    const api = await startTestServer();
    try {
      await api.login();

      const guarded = await api.request("/api/session/activity", {
        method: "POST",
        csrfToken: null,
      });
      expect(guarded.status).toBe(403);

      mutations.__moneyDeskDisableCsrf = true;
      const unguarded = await api.request("/api/session/activity", {
        method: "POST",
        csrfToken: null,
      });
      expect(unguarded.status).toBe(200);
    } finally {
      await api.close();
    }
  });
});

describe("if reads extended the session", () => {
  it("a page that only reads would never time out", async () => {
    const api = await startTestServer();
    try {
      await api.login();
      mutations.__moneyDeskExtendOnRead = true;

      for (let minute = 0; minute < 40; minute += 5) {
        api.clock.advance(5 * 60 * 1000);
        await api.request("/api/session");
      }

      // Still signed in after 40 idle minutes: exactly what the idle test in
      // session.test.ts asserts must not happen.
      const state = (await api.request("/api/session")).body as { authenticated: boolean };
      expect(state.authenticated).toBe(true);

      mutations.__moneyDeskExtendOnRead = false;
      api.clock.advance(SESSION_IDLE_MS + 1000);
      const after = (await api.request("/api/session")).body as { authenticated: boolean };
      expect(after.authenticated).toBe(false);
    } finally {
      await api.close();
    }
  });
});
