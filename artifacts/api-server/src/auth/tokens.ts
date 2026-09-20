import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Session tokens are 256 bits of randomness, transported in the cookie and
 * never written down: the database holds only SHA-256 hashes. SHA-256 is the
 * right tool here (unlike for passwords) because the input already has full
 * entropy, so there is nothing to brute-force.
 */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * The CSRF token is derived from the session token the browser holds, so the
 * server can hand it back on `GET /session` without ever storing anything an
 * attacker who reads the database could use. Its hash is stored as the
 * verifier, which is what a request is actually checked against.
 */
export function deriveCsrfToken(sessionToken: string): string {
  return createHmac("sha256", "money-desk.csrf.v1").update(sessionToken, "utf8").digest("base64url");
}

export function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
