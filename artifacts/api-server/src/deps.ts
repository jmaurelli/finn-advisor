import type { SqliteDatabase } from "@workspace/db";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AppConfig } from "./config.js";
import { createAdapterRegistry, PRODUCTION_ADAPTERS, type AdapterRegistry } from "./imports/adapters.js";
import { createImportAdmission, type ImportAdmission } from "./imports/admission.js";
import { createUploadStore, type UploadStore } from "./imports/upload-store.js";
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
  /**
   * The bank formats available for import. Empty by default: a format appears
   * here only once its real semantics have been verified, so tests inject the
   * fabricated ones rather than the service shipping them.
   */
  adapters: AdapterRegistry;
  /** Private storage for uploaded bytes, under the configured data directory. */
  uploads: UploadStore;
  /** How many uploads may be received and parsed at the same time. */
  importJobs: ImportAdmission;
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
    adapters: createAdapterRegistry(PRODUCTION_ADAPTERS),
    uploads: createUploadStore({ root: path.join(config.dataDir, "uploads") }),
    importJobs: createImportAdmission(),
    ...overrides,
  };
}
