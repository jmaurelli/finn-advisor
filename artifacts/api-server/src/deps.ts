import type { SqliteDatabase } from "@workspace/db";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "./config.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { hashPassword, verifyPassword } from "./auth/passwords.js";

/**
 * Everything the request handlers are allowed to reach: the database, the
 * configuration, and the two sources of non-determinism (time and ids),
 * injected so tests can drive expiry exactly instead of sleeping.
 */
export interface AppDependencies {
  db: SqliteDatabase;
  config: AppConfig;
  clock: Clock;
  newId: () => string;
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (storedHash: string, password: string) => Promise<boolean>;
}

export function defaultDependencies(
  db: SqliteDatabase,
  config: AppConfig,
  overrides: Partial<AppDependencies> = {},
): AppDependencies {
  return {
    db,
    config,
    clock: systemClock,
    newId: randomUUID,
    hashPassword,
    verifyPassword,
    ...overrides,
  };
}
