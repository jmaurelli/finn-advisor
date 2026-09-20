import { withWriteTransaction, type SqliteDatabase } from "@workspace/db";

/**
 * Persistent login throttling.
 *
 * Two scopes, deliberately: a per-source counter stops one client hammering
 * the form, and a bounded owner-wide backoff stops a spread-out attack from
 * sidestepping it. The owner-wide delay is capped, because a lockout the
 * owner cannot wait out would turn a nuisance into a denial of service
 * against the only person who uses this. `clearAllThrottles` is the deliberate
 * way out, run by the owner at the console.
 *
 * Known limit, to be resolved at the proxy stage: the source key is the
 * socket address, and behind a reverse proxy every request arrives from the
 * loopback address, so the per-source bucket stops distinguishing clients.
 * Until the proxy's forwarded address is explicitly trusted and validated,
 * treat the per-source limit as a single shared bucket.
 */
export const SOURCE_WINDOW_MS = 15 * 60 * 1000;
export const SOURCE_MAX_FAILURES = 5;
export const SOURCE_LOCK_MS = 15 * 60 * 1000;
export const OWNER_BACKOFF_AFTER = 10;
export const OWNER_MAX_LOCK_MS = 15 * 60 * 1000;

export interface ThrottleState {
  lockedUntil: number | undefined;
}

interface ThrottleRow {
  failure_count: bigint;
  window_started_at: bigint;
  locked_until: bigint | null;
}

function read(db: SqliteDatabase, scope: string): ThrottleRow | undefined {
  return db
    .prepare(
      "SELECT failure_count, window_started_at, locked_until FROM login_throttles WHERE scope = ?",
    )
    .get(scope) as ThrottleRow | undefined;
}

export function sourceScope(address: string): string {
  return `source:${address.slice(0, 70)}`;
}

/** Seconds the caller must wait, or 0 when a login attempt is allowed now. */
export function retryAfterSeconds(
  db: SqliteDatabase,
  address: string,
  now: number,
): number {
  let wait = 0;
  for (const scope of [sourceScope(address), "owner"]) {
    const row = read(db, scope);
    const lockedUntil = row?.locked_until == null ? 0 : Number(row.locked_until);
    if (lockedUntil > now) wait = Math.max(wait, Math.ceil((lockedUntil - now) / 1000));
  }
  return wait;
}

export function recordFailure(db: SqliteDatabase, address: string, now: number): void {
  withWriteTransaction(db, () => {
    bumpSource(db, sourceScope(address), now);
    bumpOwner(db, now);
  });
}

function bumpSource(db: SqliteDatabase, scope: string, now: number): void {
  const row = read(db, scope);
  const freshWindow = row === undefined || now - Number(row.window_started_at) > SOURCE_WINDOW_MS;
  const windowStarted = freshWindow ? now : Number(row.window_started_at);
  const failures = (freshWindow ? 0 : Number(row.failure_count)) + 1;
  const lockedUntil = failures >= SOURCE_MAX_FAILURES ? now + SOURCE_LOCK_MS : null;

  db.prepare(
    `INSERT INTO login_throttles (scope, failure_count, window_started_at, locked_until, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (scope) DO UPDATE SET
       failure_count = excluded.failure_count,
       window_started_at = excluded.window_started_at,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
  ).run(scope, failures, windowStarted, lockedUntil, now);
}

function bumpOwner(db: SqliteDatabase, now: number): void {
  const row = read(db, "owner");
  const freshWindow = row === undefined || now - Number(row.window_started_at) > SOURCE_WINDOW_MS;
  const windowStarted = freshWindow ? now : Number(row.window_started_at);
  const failures = (freshWindow ? 0 : Number(row.failure_count)) + 1;

  let lockedUntil: number | null = null;
  if (failures > OWNER_BACKOFF_AFTER) {
    const steps = failures - OWNER_BACKOFF_AFTER;
    lockedUntil = now + Math.min(1000 * 2 ** Math.min(steps, 20), OWNER_MAX_LOCK_MS);
  }

  db.prepare(
    `INSERT INTO login_throttles (scope, failure_count, window_started_at, locked_until, updated_at)
     VALUES ('owner', ?, ?, ?, ?)
     ON CONFLICT (scope) DO UPDATE SET
       failure_count = excluded.failure_count,
       window_started_at = excluded.window_started_at,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
  ).run(failures, windowStarted, lockedUntil, now);
}

/** Clears every lockout. The console command behind it is how an owner who
 * has locked themselves out gets back in without editing the database. */
export function clearAllThrottles(db: SqliteDatabase): number {
  return withWriteTransaction(db, () => {
    const result = db.prepare("DELETE FROM login_throttles").run();
    return Number(result.changes);
  });
}

/** A correct password clears both counters. */
export function clearFailures(db: SqliteDatabase, address: string): void {
  withWriteTransaction(db, () => {
    db.prepare("DELETE FROM login_throttles WHERE scope IN (?, 'owner')").run(
      sourceScope(address),
    );
  });
}
