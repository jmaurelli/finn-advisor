/**
 * Creation digests make a retried create safe (TDD section 4).
 *
 * The browser generates a new record's UUID once per intended action. If the
 * same ID arrives again with the same content, the existing record is
 * returned; with different content it is a genuine conflict, not a retry.
 * That distinction needs a stable fingerprint of the creating request, so the
 * value is canonicalized — object keys sorted, no insertion-order dependence
 * — before hashing.
 */

import { createHash } from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (typeof value === "number") {
    // Money never travels as a number; anything that does is a bug worth
    // failing on rather than hashing into an unreproducible digest.
    if (!Number.isSafeInteger(value)) throw new TypeError("cannot digest a non-integer number");
    return value.toString();
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  throw new TypeError("cannot digest this value");
}

export function creationDigest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}
