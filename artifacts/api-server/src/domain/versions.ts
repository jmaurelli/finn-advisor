/**
 * Entity versions, ledger revisions and the strong ETags built from them.
 *
 * Counters are checked for overflow rather than wrapped or reset (TDD
 * section 2): a version that silently returned to 1 would make a stale
 * `If-Match` match again, which is precisely the accident version checks
 * exist to prevent.
 */

import { problem } from "../lib/problem.js";

/** The contract serializes versions and revisions below 10^18. */
export const COUNTER_BOUND = 1000000000000000000n;

export class CounterOverflowError extends Error {
  constructor() {
    super("version counter reached its bound");
    this.name = "CounterOverflowError";
  }
}

export function nextCounter(current: bigint): bigint {
  const next = current + 1n;
  if (next >= COUNTER_BOUND) throw new CounterOverflowError();
  return next;
}

export function formatCounter(value: bigint): string {
  if (value < 0n || value >= COUNTER_BOUND) throw new CounterOverflowError();
  return value.toString();
}

/** A strong ETag is the quoted entity version, and nothing else. */
export function etag(version: bigint): string {
  return `"${formatCounter(version)}"`;
}

const ETAG_SHAPE = /^"[1-9][0-9]{0,17}"$/;

/**
 * Reads a required `If-Match`. The three outcomes are deliberately distinct:
 * absent is 428 (the client forgot the precondition), malformed is 400 (the
 * client sent nonsense), and only a well-formed but stale version reaches the
 * 412 the caller raises after comparing. Reporting a malformed header as 428
 * would send the owner off to refetch a version they already had.
 */
export function requireIfMatch(header: unknown): bigint {
  if (header === undefined || header === null || header === "") {
    throw problem({
      status: 428,
      code: "precondition_required",
      title: "Missing version",
      detail: "Reload the record and try again so nothing is overwritten by accident.",
    });
  }
  if (typeof header !== "string" || !ETAG_SHAPE.test(header)) {
    throw problem({
      status: 400,
      code: "invalid_request",
      title: "Malformed version",
      detail: "The version sent with this change was not in the expected form.",
    });
  }
  return BigInt(header.slice(1, -1));
}

export function versionMismatch(currentVersion: bigint): ReturnType<typeof problem> {
  return problem({
    status: 412,
    code: "version_mismatch",
    title: "Someone else changed this first",
    detail: "This record changed since you loaded it. Reload and try again.",
    currentVersion: formatCounter(currentVersion),
  });
}
