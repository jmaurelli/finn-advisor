import { DatabaseSetupError } from "@workspace/db";

/**
 * Explicit configuration only. Nothing here has a convenient default that
 * could quietly start the service in a less safe shape than intended: a
 * missing or implausible value stops startup with a message that names the
 * variable and nothing else.
 */
export interface AppConfig {
  dataDir: string;
  bindAddress: string;
  port: number;
  allowedOrigin: string;
  environment: "development" | "test" | "production";
}

/** The review app already serves on 4173; taking it would break it. */
const RESERVED_PORTS = new Set([4173]);

export const SESSION_COOKIE_NAME = "__Host-money_desk_session";
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const MAX_JSON_BODY_BYTES = 64 * 1024;
/**
 * The contract lets a reorder list 2,000 rule ids and a category archive carry
 * 1,000 rule resolutions; compactly serialized those need about 78 KB and
 * 123 KB. Only those two routes get this larger bound.
 */
export const MAX_LIST_BODY_BYTES = 256 * 1024;
// Case-insensitive with an optional trailing slash, as Express routes them.
export const LIST_BODY_PATHS = [/^\/rules\/reorder\/?$/i, /^\/categories\/[^/]+\/archive\/?$/i];
/**
 * Extending coverage backward may name up to 25,000 held rows, which the
 * contract allows. Measured, that body is 953 KB compactly serialized and
 * 1,124 KB pretty-printed, so this bound clears the larger of the two with room
 * for a longer version counter. It is deliberately one route's bound rather
 * than a larger general limit: no other write gains anything from it.
 */
export const MAX_BASELINE_BODY_BYTES = 1536 * 1024;
export const BASELINE_BODY_PATHS = [/^\/accounts\/[^/]+\/baseline\/?$/i];
/**
 * The one route that carries a file instead of JSON. Listed here rather than
 * relaxing the content-type rule generally, so no other write can arrive as
 * anything but JSON.
 */
export const MULTIPART_PATHS = [/^\/imports\/?$/i];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const environment = readEnvironment(env);
  const dataDir = required(env, "MONEY_DESK_DATA_DIR");
  const bindAddress = required(env, "MONEY_DESK_BIND_ADDRESS");
  const allowedOrigin = required(env, "MONEY_DESK_ALLOWED_ORIGIN");
  const port = Number(required(env, "MONEY_DESK_PORT"));

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseSetupError("MONEY_DESK_PORT must be a port number between 1 and 65535");
  }
  if (RESERVED_PORTS.has(port)) {
    throw new DatabaseSetupError(
      `MONEY_DESK_PORT ${String(port)} is reserved by another service on this host`,
    );
  }
  // Until the reverse proxy stage the service must not be reachable from the
  // network, so a non-loopback bind address is refused rather than trusted.
  if (bindAddress !== "127.0.0.1" && bindAddress !== "::1") {
    throw new DatabaseSetupError(
      "MONEY_DESK_BIND_ADDRESS must be 127.0.0.1 or ::1 until the proxy stage",
    );
  }
  assertOrigin(allowedOrigin);

  return { dataDir, bindAddress, port, allowedOrigin, environment };
}

function readEnvironment(env: NodeJS.ProcessEnv): AppConfig["environment"] {
  const value = env["NODE_ENV"];
  if (value === "development" || value === "test" || value === "production") return value;
  throw new DatabaseSetupError("NODE_ENV must be development, test or production");
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new DatabaseSetupError(`${name} is required`);
  }
  return value.trim();
}

function assertOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DatabaseSetupError("MONEY_DESK_ALLOWED_ORIGIN must be an absolute origin");
  }
  if (url.origin !== value || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new DatabaseSetupError(
      "MONEY_DESK_ALLOWED_ORIGIN must be a bare http(s) origin such as https://localhost:8443",
    );
  }
}
