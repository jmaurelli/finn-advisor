/**
 * Canonical money. Every amount is exact integer cents held as a `bigint`;
 * nothing here ever produces or consumes a JavaScript `number`, because a
 * float cannot represent every cent value the ledger may hold.
 *
 * Two bounds, deliberately different (TDD section 2):
 *  - stored values (transaction amounts, opening and statement balances) are
 *    below 10^11 cents, which keeps every one of them exactly representable
 *    even as a `number` and puts 64-bit overflow of any sum out of reach;
 *  - aggregates (balances, totals) are below 10^18, inside the signed 64-bit
 *    range SQLite itself works in.
 */

export const STORED_BOUND = 100000000000n; // 10^11
export const AGGREGATE_BOUND = 1000000000000000000n; // 10^18

/**
 * The transport grammar, and only this: no whitespace, no leading `+`, no
 * leading zeros, no `-0`, no decimal point, no exponent. Bank adapters parse
 * a different, decimal grammar; the two must never be confused.
 */
const CANONICAL_INTEGER = /^(0|-?[1-9][0-9]*)$/;

/** Longest canonical aggregate: `-` plus 18 digits. */
const MAX_INPUT_LENGTH = 19;

export const CURRENCY = "USD";

export interface MoneyDto {
  amountMinor: string;
  currency: string;
}

export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

/**
 * Parses canonical cents. Length is bounded *before* conversion so a huge
 * string cannot be turned into a huge `bigint` first and rejected after.
 */
export function parseMinorUnits(text: unknown, bound = AGGREGATE_BOUND): bigint {
  if (typeof text !== "string") throw new MoneyFormatError("amount must be a string");
  if (text.length === 0 || text.length > MAX_INPUT_LENGTH) {
    throw new MoneyFormatError("amount is not a canonical integer");
  }
  if (!CANONICAL_INTEGER.test(text)) {
    throw new MoneyFormatError("amount is not a canonical integer");
  }
  const value = BigInt(text);
  assertWithin(value, bound);
  return value;
}

export function formatMinorUnits(value: bigint): string {
  // `bigint` stringification is already canonical: no separators, no
  // exponent, no negative zero. Asserting that keeps it true if it ever
  // passes through something else.
  const text = value.toString();
  if (!CANONICAL_INTEGER.test(text)) {
    throw new MoneyFormatError("amount did not format canonically");
  }
  return text;
}

export function assertWithin(value: bigint, bound: bigint): void {
  const magnitude = value < 0n ? -value : value;
  if (magnitude >= bound) throw new MoneyFormatError("amount is out of range");
}

/** Reads a `Money` DTO from the contract into exact cents. */
export function parseMoney(dto: unknown, bound = STORED_BOUND): bigint {
  if (typeof dto !== "object" || dto === null) throw new MoneyFormatError("money must be an object");
  const record = dto as Record<string, unknown>;
  if (record["currency"] !== CURRENCY) throw new MoneyFormatError("unsupported currency");
  return parseMinorUnits(record["amountMinor"], bound);
}

/** Builds a `Money` DTO for a stored value. */
export function money(value: bigint): MoneyDto {
  assertWithin(value, STORED_BOUND);
  return { amountMinor: formatMinorUnits(value), currency: CURRENCY };
}

/** Builds an `AggregateMoney` DTO for a balance or total. */
export function aggregateMoney(value: bigint): MoneyDto {
  assertWithin(value, AGGREGATE_BOUND);
  return { amountMinor: formatMinorUnits(value), currency: CURRENCY };
}

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}
