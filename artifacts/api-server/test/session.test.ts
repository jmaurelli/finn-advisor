import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "../src/config.js";
import { OWNER_MAX_LOCK_MS, recordFailure, retryAfterSeconds } from "../src/auth/throttle.js";
import { ALLOWED_ORIGIN, startTestServer, TEST_PASSWORD, type TestServer } from "./harness.js";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
});

afterEach(async () => {
  await api.close();
});

function problemOf(body: unknown): { code: string; status: number; requestId: string } {
  return body as { code: string; status: number; requestId: string };
}

describe("sign in", () => {
  it("accepts the right password and sets the session cookie", async () => {
    const response = await api.login();

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ authenticated: true, displayName: "Personal space" });

    const cookie = response.headers.getSetCookie()[0];
    expect(cookie).toContain("__Host-money_desk_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain");
  });

  it("refuses the wrong password without saying why", async () => {
    const response = await api.login("not-the-password");

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(problemOf(response.body).code).toBe("invalid_credentials");
    expect(response.text).not.toContain("argon2");
  });

  it("gives the same answer when no password has ever been set", async () => {
    const fresh = await startTestServer({ setPassword: false });
    try {
      const response = await fresh.login();
      expect(response.status).toBe(401);
      expect(problemOf(response.body).code).toBe("invalid_credentials");
    } finally {
      await fresh.close();
    }
  });

  it("rotates the session token on sign-in", async () => {
    await api.login();
    const first = api.cookie;
    await api.login();

    expect(api.cookie).toBeDefined();
    expect(api.cookie).not.toBe(first);

    const sessions = api.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: bigint };
    expect(sessions.n).toBe(1n);
  });

  it("stores no token or password in the database", async () => {
    await api.login();
    const rows = api.db.prepare("SELECT token_hash, csrf_hash FROM sessions").all() as {
      token_hash: Buffer;
      csrf_hash: Buffer;
    }[];
    const cookieValue = api.cookie!.split("=")[1];

    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toHaveLength(32);
    expect(rows[0].token_hash.toString("utf8")).not.toContain(cookieValue);
    const credential = api.db
      .prepare("SELECT password_hash FROM owner_credentials WHERE id = 1")
      .get() as { password_hash: string };
    expect(credential.password_hash).not.toContain(TEST_PASSWORD);
    expect(credential.password_hash.startsWith("$argon2id$")).toBe(true);
  });

  it("rejects a sign-in from another origin", async () => {
    const response = await api.request("/api/session/login", {
      method: "POST",
      body: { password: TEST_PASSWORD },
      headers: { origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(problemOf(response.body).code).toBe("origin_rejected");
  });

  it("rejects a sign-in with no Origin at all", async () => {
    const response = await api.request("/api/session/login", {
      method: "POST",
      body: { password: TEST_PASSWORD },
      omitOrigin: true,
    });

    expect(response.status).toBe(403);
    expect(problemOf(response.body).code).toBe("origin_rejected");
  });

  it("rejects a form-encoded sign-in", async () => {
    const response = await api.request("/api/session/login", {
      method: "POST",
      rawBody: "password=synthetic-correct-horse-battery",
      contentType: "application/x-www-form-urlencoded",
    });

    expect(response.status).toBe(415);
    expect(problemOf(response.body).code).toBe("unsupported_media_type");
  });

  it("rejects unknown fields in the body", async () => {
    const response = await api.request("/api/session/login", {
      method: "POST",
      body: { password: TEST_PASSWORD, rememberMe: true },
    });

    expect(response.status).toBe(422);
    expect(problemOf(response.body).code).toBe("validation_failed");
  });
});

describe("throttling", () => {
  async function failTimes(count: number): Promise<number> {
    let status = 0;
    for (let attempt = 0; attempt < count; attempt += 1) {
      status = (await api.login("wrong-password")).status;
    }
    return status;
  }

  it("locks out after five failures and says how long to wait", async () => {
    await failTimes(5);
    const blocked = await api.login();

    expect(blocked.status).toBe(429);
    expect(problemOf(blocked.body).code).toBe("login_throttled");
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("still blocks after a restart", async () => {
    await failTimes(5);
    await api.restart();

    const blocked = await api.login();
    expect(blocked.status).toBe(429);
  });

  it("lets the owner back in once the window passes", async () => {
    await failTimes(5);
    api.clock.advance(16 * 60 * 1000);

    const response = await api.login();
    expect(response.status).toBe(200);
  });

  it("counts owner-wide failures as well as per-source ones", async () => {
    await failTimes(3);

    const owner = api.db
      .prepare("SELECT failure_count FROM login_throttles WHERE scope = 'owner'")
      .get() as { failure_count: bigint };
    const source = api.db
      .prepare("SELECT failure_count FROM login_throttles WHERE scope LIKE 'source:%'")
      .get() as { failure_count: bigint };

    expect(owner.failure_count).toBe(3n);
    expect(source.failure_count).toBe(3n);
  });

  /**
   * The owner-wide backoff exists so an attacker spread across many sources
   * cannot sidestep the per-source limit. It must also stay bounded: an
   * unbounded one would let someone else lock the owner out of their own
   * finances for good.
   */
  it("backs off owner-wide but never beyond the cap", async () => {
    const now = api.clock.now();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      recordFailure(api.db, `10.0.0.${String(attempt)}`, now);
    }

    const owner = api.db
      .prepare("SELECT failure_count, locked_until FROM login_throttles WHERE scope = 'owner'")
      .get() as { failure_count: bigint; locked_until: bigint | null };

    expect(Number(owner.failure_count)).toBe(40);
    expect(owner.locked_until).not.toBeNull();
    expect(Number(owner.locked_until) - now).toBeGreaterThan(0);
    expect(Number(owner.locked_until) - now).toBeLessThanOrEqual(OWNER_MAX_LOCK_MS);

    // Still blocked for a source that never failed, and still recoverable.
    expect(retryAfterSeconds(api.db, "192.168.1.50", now)).toBeGreaterThan(0);
    expect(retryAfterSeconds(api.db, "192.168.1.50", now + OWNER_MAX_LOCK_MS + 1000)).toBe(0);
  });

  it("lets the owner back in after setting a new password", async () => {
    await failTimes(5);
    expect((await api.login()).status).toBe(429);

    await api.setPassword("another-synthetic-password");

    const response = await api.login("another-synthetic-password");
    expect(response.status).toBe(200);
  });

  it("clears the counters after a correct password", async () => {
    await failTimes(4);
    expect((await api.login()).status).toBe(200);

    const rows = api.db.prepare("SELECT COUNT(*) AS n FROM login_throttles").get() as {
      n: bigint;
    };
    expect(rows.n).toBe(0n);
  });
});

describe("session lifetime", () => {
  it("reports the session without extending it", async () => {
    await api.login();
    const before = (await api.request("/api/session")).body as { idleExpiresAt: string };

    api.clock.advance(10 * 60 * 1000);
    const after = (await api.request("/api/session")).body as { idleExpiresAt: string };

    expect(after.idleExpiresAt).toBe(before.idleExpiresAt);
  });

  /**
   * The mutation check for the idle rule: if reads ever started extending the
   * session, this test would fail, because 40 minutes of pure reading must
   * still end the session.
   */
  it("expires after 30 idle minutes even while the page keeps reading", async () => {
    await api.login();
    const cookie = api.cookie;
    for (let minute = 0; minute < 40; minute += 5) {
      api.clock.advance(5 * 60 * 1000);
      await api.request("/api/session");
    }

    // The signed-out reply clears the cookie; present it again so the failure
    // is about the session having ended, not about a missing cookie.
    api.cookie = cookie;
    const response = await api.request("/api/preferences");
    expect(response.status).toBe(401);
    // The first request after the deadline is the one that reports the
    // expiry; the row is removed at the same moment.
    expect(problemOf(response.body).code).toBe("not_authenticated");
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0n });
  });

  it("clears the cookie once the session has expired", async () => {
    await api.login();
    api.clock.advance(SESSION_IDLE_MS + 1000);
    await api.request("/api/session");

    expect(api.cookie).toBeUndefined();
  });

  it("stays alive while activity is reported", async () => {
    await api.login();
    for (let minute = 0; minute < 40; minute += 5) {
      api.clock.advance(5 * 60 * 1000);
      expect((await api.request("/api/session/activity", { method: "POST" })).status).toBe(200);
    }

    expect((await api.request("/api/preferences")).status).toBe(200);
  });

  it("ends 12 hours after sign-in however active the owner is", async () => {
    await api.login();
    const total = SESSION_ABSOLUTE_MS + SESSION_IDLE_MS;
    for (let elapsed = 0; elapsed < total; elapsed += SESSION_IDLE_MS / 2) {
      api.clock.advance(SESSION_IDLE_MS / 2);
      await api.request("/api/session/activity", { method: "POST" });
    }

    const response = await api.request("/api/session/activity", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("never extends the idle deadline past the absolute one", async () => {
    await api.login();
    const step = 20 * 60 * 1000;
    for (let elapsed = step; elapsed <= SESSION_ABSOLUTE_MS - step; elapsed += step) {
      api.clock.advance(step);
      expect((await api.request("/api/session/activity", { method: "POST" })).status).toBe(200);
    }
    api.clock.advance(19 * 60 * 1000);

    const body = (await api.request("/api/session/activity", { method: "POST" })).body as {
      idleExpiresAt: string;
      absoluteExpiresAt: string;
    };

    expect(new Date(body.idleExpiresAt).getTime()).toBeLessThanOrEqual(
      new Date(body.absoluteExpiresAt).getTime(),
    );
  });

  it("reports signed out for an expired cookie", async () => {
    await api.login();
    api.clock.advance(SESSION_IDLE_MS + 1000);

    const response = await api.request("/api/session");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ authenticated: false });
  });

  it("signs out and revokes the session", async () => {
    await api.login();
    const cookie = api.cookie;

    const logout = await api.request("/api/session/logout", { method: "POST" });
    expect(logout.status).toBe(204);

    api.cookie = cookie;
    const after = await api.request("/api/preferences");
    expect(after.status).toBe(401);
  });

  it("revokes every session when the password is changed", async () => {
    await api.login();
    expect((await api.request("/api/preferences")).status).toBe(200);

    await api.setPassword("a-different-synthetic-password");

    const after = await api.request("/api/preferences");
    expect(after.status).toBe(401);
    // The rows are gone, so the server cannot tell this cookie apart from a
    // stale one; either way it is not a session.
    expect(["session_expired", "not_authenticated"]).toContain(problemOf(after.body).code);
    expect(api.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0n });
  });
});

describe("write protection", () => {
  it("rejects a write with no CSRF token", async () => {
    await api.login();
    const response = await api.request("/api/session/activity", {
      method: "POST",
      csrfToken: null,
    });

    expect(response.status).toBe(403);
    expect(problemOf(response.body).code).toBe("csrf_invalid");
  });

  it("rejects a write with the wrong CSRF token", async () => {
    await api.login();
    const response = await api.request("/api/session/activity", {
      method: "POST",
      csrfToken: "x".repeat(43),
    });

    expect(response.status).toBe(403);
    expect(problemOf(response.body).code).toBe("csrf_invalid");
  });

  it("rejects a write from another origin even with a valid session", async () => {
    await api.login();
    const response = await api.request("/api/session/activity", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });

    expect(response.status).toBe(403);
    expect(problemOf(response.body).code).toBe("origin_rejected");
  });

  it("accepts the write with the session's own token and origin", async () => {
    await api.login();
    const response = await api.request("/api/session/activity", {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.status).toBe(200);
  });
});
