import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { closeLedger, migrate, openLedger, type SqliteDatabase } from "@workspace/db";

import { createApp } from "../src/app.js";
import { SESSION_COOKIE_NAME, type AppConfig } from "../src/config.js";
import { defaultDependencies, type AppDependencies } from "../src/deps.js";
import { TestClock } from "../src/lib/clock.js";
import { hashPassword } from "../src/auth/passwords.js";
import { setOwnerPassword } from "../src/cli/set-password.js";

export const ALLOWED_ORIGIN = "http://localhost";
export const TEST_PASSWORD = "synthetic-correct-horse-battery";
export const START_TIME = Date.UTC(2026, 4, 2, 13, 55, 0);

export interface TestServer {
  deps: AppDependencies;
  db: SqliteDatabase;
  clock: TestClock;
  dataDir: string;
  baseUrl: string;
  cookie: string | undefined;
  request: (path: string, init?: TestRequestInit) => Promise<TestResponse>;
  login: (password?: string) => Promise<TestResponse>;
  restart: () => Promise<void>;
  setPassword: (password: string) => Promise<void>;
  close: () => Promise<void>;
}

export interface TestRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send no Origin header at all. */
  omitOrigin?: boolean;
  /** Send no session cookie, whatever is stored. */
  omitCookie?: boolean;
  csrfToken?: string | null;
  rawBody?: string;
  contentType?: string | null;
}

export interface TestResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

function testConfig(dataDir: string): AppConfig {
  return {
    dataDir,
    bindAddress: "127.0.0.1",
    port: 0,
    allowedOrigin: ALLOWED_ORIGIN,
    environment: "test",
  };
}

/**
 * Starts the real application against a real SQLite file on a real socket.
 * Only the clock and the id generator are substituted, so expiry can be
 * driven exactly instead of waited out.
 */
export async function startTestServer(
  options: { setPassword?: boolean } = {},
): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), "money-desk-api-"));
  const clock = new TestClock(START_TIME);
  let idCounter = 0;

  let db = openLedger({ dataDir });
  migrate(db);

  let deps = makeDeps(db);
  let server = await listen(deps);
  let csrfToken: string | undefined;

  function makeDeps(database: SqliteDatabase): AppDependencies {
    return defaultDependencies(database, testConfig(dataDir), {
      clock,
      newId: () => {
        idCounter += 1;
        return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
      },
    });
  }

  async function listen(dependencies: AppDependencies): Promise<Server> {
    const app = createApp(dependencies);
    return new Promise<Server>((resolve) => {
      const created = app.listen(0, "127.0.0.1", () => resolve(created));
    });
  }

  const api: TestServer = {
    deps,
    db,
    clock,
    dataDir,
    get baseUrl() {
      const address = server.address() as AddressInfo;
      return `http://127.0.0.1:${String(address.port)}`;
    },
    cookie: undefined,

    async request(path, init = {}) {
      const headers = new Headers(init.headers ?? {});
      const method = init.method ?? "GET";
      const write = method !== "GET" && method !== "HEAD";

      if (!init.omitOrigin && !headers.has("origin")) headers.set("origin", ALLOWED_ORIGIN);
      if (!init.omitCookie && api.cookie !== undefined) headers.set("cookie", api.cookie);
      if (write && init.csrfToken !== null) {
        const token = init.csrfToken ?? csrfToken;
        if (token !== undefined) headers.set("x-csrf-token", token);
      }

      let body: string | undefined;
      if (init.rawBody !== undefined) {
        body = init.rawBody;
      } else if (init.body !== undefined) {
        body = JSON.stringify(init.body);
      }
      if (body !== undefined && init.contentType !== null) {
        headers.set("content-type", init.contentType ?? "application/json");
      }

      const response = await fetch(`${api.baseUrl}${path}`, { method, headers, body });
      const setCookies = response.headers.getSetCookie();
      for (const cookie of setCookies) {
        const [pair] = cookie.split(";");
        if (pair.startsWith(`${SESSION_COOKIE_NAME}=`)) {
          const value = pair.slice(SESSION_COOKIE_NAME.length + 1);
          api.cookie = value === "" ? undefined : pair;
        }
      }

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === "" ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === "object" && parsed !== null && "csrfToken" in parsed) {
        csrfToken = (parsed as { csrfToken: string }).csrfToken;
      }
      return { status: response.status, headers: response.headers, body: parsed, text };
    },

    async login(password = TEST_PASSWORD) {
      return api.request("/api/session/login", { method: "POST", body: { password } });
    },

    async setPassword(password) {
      setOwnerPassword(db, await hashPassword(password), clock.now());
    },

    /** Stops and starts the process's worth of state, keeping the files. */
    async restart() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeLedger(db);
      db = openLedger({ dataDir });
      deps = makeDeps(db);
      api.db = db;
      api.deps = deps;
      server = await listen(deps);
    },

    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeLedger(db);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };

  if (options.setPassword !== false) await api.setPassword(TEST_PASSWORD);
  return api;
}
