/**
 * Owner preferences. The reader and its shape live here rather than in the
 * route, so the ledger export cannot report different preferences than the
 * API does.
 */
import type { SqliteDatabase } from "@workspace/db";

export interface PreferencesRow {
  display_name: string;
  density: string;
  version: bigint;
}

export function readPreferencesRow(db: SqliteDatabase): PreferencesRow {
  return db.prepare("SELECT display_name, density, version FROM preferences WHERE id = 1")
    .get() as PreferencesRow;
}

/** Currency and timezone are ledger policy, not stored preferences. */
export function preferencesDto(row: PreferencesRow): Record<string, unknown> {
  return {
    displayName: row.display_name,
    density: row.density,
    currency: "USD",
    timezone: "America/New_York",
    version: String(row.version),
  };
}
