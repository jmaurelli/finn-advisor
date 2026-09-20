import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_JSON_BODY_BYTES } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { startTestServer, TEST_PASSWORD, type TestServer } from "./harness.js";

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
});

afterEach(async () => {
  await api.close();
});

function problemOf(body: unknown): { code: string; status: number; requestId: string; detail: string } {
  return body as { code: string; status: number; requestId: string; detail: string };
}

describe("service endpoints", () => {
  it("answers liveness without a session", async () => {
    const response = await api.request("/api/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports readiness with a compatible schema", async () => {
    const response = await api.request("/api/readyz");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready", database: "ok", schema: "compatible" });
  });

  it("reports an incompatible schema as not ready", async () => {
    api.db.prepare("DELETE FROM schema_migrations").run();
    const response = await api.request("/api/readyz");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: "not_ready", schema: "incompatible" });
    expect(response.headers.get("retry-after")).toBe("30");
  });
});

describe("security baseline", () => {
  it("puts the hardening headers on every response", async () => {
    for (const path of ["/api/healthz", "/api/session", "/api/nope"]) {
      const response = await api.request(path);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("content-security-policy"), path).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("x-powered-by"), path).toBeNull();
      expect(response.headers.get("x-request-id"), path).toBeTruthy();
    }
  });

  it("sends no CORS headers to another origin", async () => {
    const response = await api.request("/api/healthz", {
      headers: { origin: "https://evil.example" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers an unknown /api path with problem JSON, not HTML", async () => {
    const response = await api.request("/api/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(problemOf(response.body).code).toBe("not_found");
    expect(response.text).not.toContain("<html");
  });

  it("answers an unknown path outside /api with problem JSON too", async () => {
    const response = await api.request("/elsewhere");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.text).not.toContain("<html");
  });

  it("refuses a body over the limit", async () => {
    const response = await api.request("/api/session/login", {
      method: "POST",
      rawBody: JSON.stringify({ password: "x".repeat(MAX_JSON_BODY_BYTES + 100) }),
    });

    expect(response.status).toBe(413);
    expect(problemOf(response.body).code).toBe("payload_too_large");
  });

  it("refuses malformed JSON with a problem, not a stack", async () => {
    const response = await api.request("/api/session/login", {
      method: "POST",
      rawBody: "{not json",
    });

    expect(response.status).toBe(400);
    expect(problemOf(response.body).code).toBe("invalid_request");
    expect(response.text).not.toMatch(/at [A-Za-z]+ \(/);
  });

  it("gives every response a unique request id that the problem body repeats", async () => {
    const first = await api.request("/api/nope");
    const second = await api.request("/api/nope");

    expect(problemOf(first.body).requestId).toBe(first.headers.get("x-request-id"));
    expect(problemOf(first.body).requestId).not.toBe(problemOf(second.body).requestId);
  });
});

describe("configuration", () => {
  const base = {
    NODE_ENV: "production",
    MONEY_DESK_DATA_DIR: "/tmp/money-desk",
    MONEY_DESK_BIND_ADDRESS: "127.0.0.1",
    MONEY_DESK_PORT: "8123",
    MONEY_DESK_ALLOWED_ORIGIN: "https://money.example",
  };

  it("accepts a complete configuration", () => {
    expect(loadConfig(base).port).toBe(8123);
  });

  it.each([
    ["MONEY_DESK_DATA_DIR", ""],
    ["MONEY_DESK_ALLOWED_ORIGIN", ""],
    ["MONEY_DESK_PORT", ""],
    ["NODE_ENV", ""],
  ])("refuses to start when %s is missing", (key) => {
    expect(() => loadConfig({ ...base, [key]: "" })).toThrow();
  });

  it("refuses the port the review app already uses", () => {
    expect(() => loadConfig({ ...base, MONEY_DESK_PORT: "4173" })).toThrow(/reserved/);
  });

  it("refuses to listen on anything but loopback for now", () => {
    expect(() => loadConfig({ ...base, MONEY_DESK_BIND_ADDRESS: "0.0.0.0" })).toThrow(
      /loopback|127\.0\.0\.1/,
    );
  });

  it("refuses an origin with a path", () => {
    expect(() =>
      loadConfig({ ...base, MONEY_DESK_ALLOWED_ORIGIN: "https://money.example/app" }),
    ).toThrow();
  });
});

describe("preferences", () => {
  it("needs a session", async () => {
    const response = await api.request("/api/preferences");
    expect(response.status).toBe(401);
    expect(problemOf(response.body).code).toBe("not_authenticated");
  });

  it("returns the defaults with a strong ETag", async () => {
    await api.login();
    const response = await api.request("/api/preferences");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      displayName: "Personal space",
      density: "standard",
      currency: "USD",
      timezone: "America/New_York",
      version: "1",
    });
    expect(response.headers.get("etag")).toBe('"1"');
  });

  it("saves a change and moves the version on", async () => {
    await api.login();
    const response = await api.request("/api/preferences", {
      method: "PATCH",
      body: { density: "compact" },
      headers: { "if-match": '"1"' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ density: "compact", version: "2" });
    expect(response.headers.get("etag")).toBe('"2"');
  });

  it("requires If-Match", async () => {
    await api.login();
    const response = await api.request("/api/preferences", {
      method: "PATCH",
      body: { density: "compact" },
    });

    expect(response.status).toBe(428);
    expect(problemOf(response.body).code).toBe("precondition_required");
  });

  it("refuses a stale If-Match and says what the current version is", async () => {
    await api.login();
    await api.request("/api/preferences", {
      method: "PATCH",
      body: { density: "compact" },
      headers: { "if-match": '"1"' },
    });

    const stale = await api.request("/api/preferences", {
      method: "PATCH",
      body: { density: "standard" },
      headers: { "if-match": '"1"' },
    });

    expect(stale.status).toBe(412);
    expect(stale.body).toMatchObject({ code: "version_mismatch", currentVersion: "2" });
  });

  it("rejects an empty change", async () => {
    await api.login();
    const response = await api.request("/api/preferences", {
      method: "PATCH",
      body: {},
      headers: { "if-match": '"1"' },
    });

    expect(response.status).toBe(422);
    expect(problemOf(response.body).code).toBe("validation_failed");
  });

  it("rejects fixed and unknown fields", async () => {
    await api.login();
    for (const body of [{ currency: "EUR" }, { timezone: "UTC" }, { nickname: "x" }]) {
      const response = await api.request("/api/preferences", {
        method: "PATCH",
        body,
        headers: { "if-match": '"1"' },
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("rejects a whitespace-only display name", async () => {
    await api.login();
    const response = await api.request("/api/preferences", {
      method: "PATCH",
      body: { displayName: "   " },
      headers: { "if-match": '"1"' },
    });

    expect(response.status).toBe(422);
  });

  it("keeps the saved name across a restart, and shows it at sign-in", async () => {
    await api.login();
    await api.request("/api/preferences", {
      method: "PATCH",
      body: { displayName: "Household" },
      headers: { "if-match": '"1"' },
    });

    await api.restart();
    const response = await api.login(TEST_PASSWORD);

    expect(response.body).toMatchObject({ displayName: "Household" });
  });
});
