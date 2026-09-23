import { withWriteTransaction, type SqliteDatabase } from "@workspace/db";

import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "../config.js";
import { constantTimeEquals, deriveCsrfToken, hashToken, newSessionToken } from "./tokens.js";

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  credentialGeneration: number;
}

export interface EstablishedSession {
  token: string;
  csrfToken: string;
  session: SessionRecord;
}

interface SessionRow {
  id: string;
  csrf_hash: Buffer;
  credential_generation: bigint;
  created_at: bigint;
  last_activity_at: bigint;
  idle_expires_at: bigint;
  absolute_expires_at: bigint;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    createdAt: Number(row.created_at),
    lastActivityAt: Number(row.last_activity_at),
    idleExpiresAt: Number(row.idle_expires_at),
    absoluteExpiresAt: Number(row.absolute_expires_at),
    credentialGeneration: Number(row.credential_generation),
  };
}

export function currentCredentialGeneration(db: SqliteDatabase): number | undefined {
  const row = db
    .prepare("SELECT generation FROM owner_credentials WHERE id = 1")
    .get() as { generation: bigint } | undefined;
  return row === undefined ? undefined : Number(row.generation);
}

/**
 * Creates a new session. Sign-in always lands here with a fresh identifier
 * and a fresh token, so a token that existed before sign-in can never be
 * carried across it.
 */
export function createSession(
  db: SqliteDatabase,
  options: { now: number; newId: () => string; credentialGeneration: number },
): EstablishedSession {
  const token = newSessionToken();
  const csrfToken = deriveCsrfToken(token);
  const session: SessionRecord = {
    id: options.newId(),
    createdAt: options.now,
    lastActivityAt: options.now,
    idleExpiresAt: options.now + SESSION_IDLE_MS,
    absoluteExpiresAt: options.now + SESSION_ABSOLUTE_MS,
    credentialGeneration: options.credentialGeneration,
  };

  withWriteTransaction(db, () => {
    db.prepare(
      `INSERT INTO sessions
         (id, token_hash, csrf_hash, credential_generation,
          created_at, last_activity_at, idle_expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      session.id,
      hashToken(token),
      hashToken(csrfToken),
      session.credentialGeneration,
      session.createdAt,
      session.lastActivityAt,
      session.idleExpiresAt,
      session.absoluteExpiresAt,
    );
  });

  return { token, csrfToken, session };
}

export type SessionLookup =
  | { state: "none" }
  | { state: "expired" }
  | { state: "active"; session: SessionRecord; csrfToken: string };

/**
 * Resolves a cookie token to a session. Reading never extends the idle
 * deadline; only `recordActivity` does. An expired or superseded session is
 * deleted on sight, so an attacker cannot keep presenting it.
 */
export function lookupSession(
  db: SqliteDatabase,
  token: string | undefined,
  now: number,
): SessionLookup {
  if (token === undefined || token === "") return { state: "none" };

  const row = db
    .prepare(
      `SELECT id, csrf_hash, credential_generation, created_at, last_activity_at,
              idle_expires_at, absolute_expires_at
         FROM sessions WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as SessionRow | undefined;
  if (row === undefined) return { state: "none" };

  const session = toRecord(row);
  const generation = currentCredentialGeneration(db);
  const superseded = generation === undefined || generation !== session.credentialGeneration;
  if (superseded || now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
    revokeSession(db, session.id);
    return { state: "expired" };
  }

  const csrfToken = deriveCsrfToken(token);
  if (!constantTimeEquals(hashToken(csrfToken), row.csrf_hash)) {
    revokeSession(db, session.id);
    return { state: "expired" };
  }
  return { state: "active", session, csrfToken };
}

/**
 * Extends the idle deadline from server time. The absolute deadline is never
 * moved, and an already expired session is never revived.
 */
export function recordActivity(
  db: SqliteDatabase,
  session: SessionRecord,
  now: number,
): SessionRecord {
  const idleExpiresAt = Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt);
  withWriteTransaction(db, () => {
    db.prepare(
      "UPDATE sessions SET last_activity_at = ?, idle_expires_at = ? WHERE id = ?",
    ).run(now, idleExpiresAt, session.id);
  });
  return { ...session, lastActivityAt: now, idleExpiresAt };
}

export function revokeSession(db: SqliteDatabase, sessionId: string): void {
  withWriteTransaction(db, () => {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  });
}

export function revokeAllSessions(db: SqliteDatabase): void {
  withWriteTransaction(db, () => {
    db.prepare("DELETE FROM sessions").run();
  });
}

/** Removes sessions past either deadline; safe to call at startup and hourly. */
export function purgeExpiredSessions(db: SqliteDatabase, now: number): number {
  return withWriteTransaction(db, () => {
    const result = db
      .prepare("DELETE FROM sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?")
      .run(now, now);
    return Number(result.changes);
  });
}

export function verifyCsrf(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided === "") return false;
  return constantTimeEquals(hashToken(expected), hashToken(provided));
}
