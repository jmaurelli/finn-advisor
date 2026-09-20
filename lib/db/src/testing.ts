/**
 * Helpers for tests only. Every test runs against a real file-backed SQLite
 * database in a temporary directory, never in memory: in-memory SQLite has
 * different locking and journal behavior, and those are exactly the properties
 * under test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrate } from "./migrate.js";
import { closeLedger, openLedger, type SqliteDatabase } from "./open.js";

export interface TemporaryLedger {
  db: SqliteDatabase;
  dataDir: string;
  close: () => void;
}

export function createTemporaryLedger(
  options: { migrated?: boolean; busyTimeoutMs?: number } = {},
): TemporaryLedger {
  const dataDir = mkdtempSync(join(tmpdir(), "money-desk-test-"));
  const db = openLedger({ dataDir, busyTimeoutMs: options.busyTimeoutMs });
  if (options.migrated !== false) migrate(db);

  return {
    db,
    dataDir,
    close: () => {
      closeLedger(db);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
