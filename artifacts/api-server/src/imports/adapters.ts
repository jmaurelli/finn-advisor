/**
 * Bank format declarations and envelope normalization.
 *
 * A format is a pinned, explicit description of one bank's export: its exact
 * header, which of its columns may be kept, how it writes dates, which
 * direction its signs point, and which of its own words mean which
 * transaction type. Nothing here sniffs or guesses. A column the declaration
 * does not name is dropped rather than stored, and a file whose header does
 * not match exactly fails instead of being interpreted.
 *
 * `evidence` describes the provenance of the declaration, not the quality of
 * the code: `verified` means real safe headers were actually checked, so a
 * format that has only ever seen fabricated rows stays `synthetic_only` no
 * matter how many tests pass.
 *
 * Row-level problems are held as issues for the owner to correct. Only a file
 * that does not match its declared envelope at all fails the batch, because a
 * misread envelope would silently mis-sign or misdate every row in it.
 */
import type { TransactionKind } from "../domain/assignment.js";
import { isCalendarDate } from "../domain/dates.js";
import { classifyImportAmount, parseSourceAmount } from "../domain/imports.js";
import { CURRENCY } from "../domain/money.js";
import { IMPORT_CSV_LIMITS } from "../lib/import-csv.js";
import { CHASE_CHECKING, CHASE_CREDIT_CARD } from "./adapters-production.js";

export type ImportEvidence = "verified" | "unverified" | "synthetic_only";
export type AccountKind = "checking" | "savings" | "credit_card";
export type ProviderKey =
  | "chase" | "campus_usa" | "bank_of_america" | "citibank"
  | "american_express" | "capital_one" | "discover" | "wells_fargo" | "other";

/** The contract's `ImportFailure` codes this module can raise. */
export type ImportFormatFailure = "header_mismatch" | "malformed_csv" | "pending_records_unsupported";

export class ImportFormatError extends Error {
  constructor(readonly code: ImportFormatFailure) {
    // Bank values never reach the message: a mismatch report must not echo
    // the file back to a log or an error response.
    super({
      header_mismatch: "The file's columns do not match the selected bank format.",
      malformed_csv: "The CSV structure could not be read.",
      pending_records_unsupported: "This file contains transactions the bank has not posted yet.",
    }[code]);
    this.name = "ImportFormatError";
  }
}

/** Date syntaxes declared per format. A format never has more than one. */
export type SourceDateFormat = "MM/DD/YYYY" | "YYYY-MM-DD";

export type AmountPolicy =
  /** One signed column. `outflow` says which sign the bank uses for money leaving the account. */
  | { style: "signed"; column: string; outflow: "negative" | "positive" }
  /** Two mutually exclusive unsigned columns. */
  | { style: "debit_credit"; debitColumn: string; creditColumn: string };

export interface StatusPolicy {
  column: string;
  /** Exact values meaning the bank has posted the row. */
  posted: readonly string[];
  /** Exact values meaning it has not. Such a file is refused whole. */
  pending: readonly string[];
}

export interface TypePolicy {
  column: string;
  /**
   * The bank's own vocabulary. `null` records a word that carries no type
   * evidence, so the amount decides and a positive amount still asks the
   * owner.
   */
  words: Readonly<Record<string, TransactionKind | null>>;
  /**
   * What an unlisted word means. `fail` suits a bank whose vocabulary is
   * fully enumerated; `ignore` suits one where it is not, and drops the
   * unverified evidence rather than acting on it.
   */
  unknown: "fail" | "ignore";
}

/**
 * A bank's own identifier for a record, where the bank supplies one that is
 * actually reliable. Declared per format and never inferred: a check number, a
 * running balance, an amount or a description is not an identifier, however
 * convenient it looks.
 */
export interface IdentityPolicy {
  column: string;
  /**
   * The space the identifier is unique within. Deliberately not the format
   * version, so re-reading the same export with a newer adapter still
   * recognises the identity.
   */
  namespace: string;
}

export interface RetainedColumn {
  column: string;
  /**
   * `last_four` keeps at most the final four digits. A column that can carry
   * a whole account or card number is never retained any other way.
   */
  retain: "value" | "last_four";
}

export interface ImportAdapter {
  id: string;
  version: number;
  label: string;
  providerKey: ProviderKey;
  accountKind: AccountKind;
  evidence: ImportEvidence;
  /** What was actually checked, and against what. Kept honest, not aspirational. */
  evidenceNote: string;
  /**
   * Lines above the header, skipped without being read. Some banks print an
   * account summary first; it carries account numbers, names and balances, so
   * it is dropped rather than retained, and it is deliberately not matched
   * against anything - the header is the gate. A blank separator line counts.
   */
  preambleLines: number;
  /** The exact header, in order. A file must present precisely these columns. */
  header: readonly string[];
  /** Tolerated only when the bank is known to end every line with a separator. */
  allowTrailingEmptyColumn: boolean;
  /** Blank lines are skipped when the bank is known to emit them; they never renumber later rows. */
  blankRows: "skip" | "fail";
  dateColumn: string;
  dateFormat: SourceDateFormat;
  merchantColumn: string;
  amount: AmountPolicy;
  status: StatusPolicy | null;
  type: TypePolicy | null;
  /** Null for a bank that supplies no identifier this project will trust. */
  identity: IdentityPolicy | null;
  retained: readonly RetainedColumn[];
}

export type RowIssueCode =
  | "invalid_date" | "invalid_amount" | "fractional_cent"
  | "zero_amount" | "non_usd" | "missing_merchant" | "choose_type";

export interface AdapterRow {
  /**
   * The row's position among the file's data records, counting skipped blank
   * lines, so it always points back at the same physical line.
   */
  rowNumber: number;
  sourceFields: Record<string, string>;
  postedDate: string | null;
  merchant: string | null;
  cents: bigint | null;
  kind: TransactionKind | null;
  kindSource: "bank" | "default" | null;
  /** The bank's identifier for this record and its namespace, or null for both. */
  identity: { namespace: string; bankTransactionId: string } | null;
  issues: readonly RowIssueCode[];
}

/** Resolved column positions; built once per file from its header. */
export type ColumnIndex = ReadonlyMap<string, number>;

/**
 * Checks the header and resolves its positions. Column names are compared
 * exactly: a renamed or reordered export is a different format, not a variant
 * to be absorbed.
 */
export function matchHeader(adapter: ImportAdapter, fields: readonly string[]): ColumnIndex {
  const trimmedBom = fields.length > 0 ? [stripBom(fields[0]!), ...fields.slice(1)] : fields;
  const columns = dropTrailingEmpty(adapter, trimmedBom);
  if (columns.length !== adapter.header.length) throw new ImportFormatError("header_mismatch");
  const index = new Map<string, number>();
  for (const [position, name] of columns.entries()) {
    if (name !== adapter.header[position]) throw new ImportFormatError("header_mismatch");
    // A duplicated column name would make every later lookup ambiguous.
    if (index.has(name)) throw new ImportFormatError("header_mismatch");
    index.set(name, position);
  }
  return index;
}

/**
 * Normalizes one data record. Returns null for a blank line the format
 * declares skippable. Row problems become issues; only an envelope the
 * declaration cannot describe throws.
 */
export function normalizeRow(
  adapter: ImportAdapter,
  columns: ColumnIndex,
  fields: readonly string[],
  rowNumber: number,
): AdapterRow | null {
  const record = dropTrailingEmpty(adapter, fields);
  if (record.every(value => value === "")) {
    if (adapter.blankRows === "skip") return null;
    throw new ImportFormatError("malformed_csv");
  }
  // A record that does not carry the header's columns cannot be read against
  // the declaration; holding it as a row would mean guessing which value is
  // which.
  if (record.length !== adapter.header.length) throw new ImportFormatError("malformed_csv");
  const at = (column: string): string => record[columns.get(column)!]!;

  if (adapter.status !== null) {
    const value = at(adapter.status.column);
    if (adapter.status.pending.includes(value)) throw new ImportFormatError("pending_records_unsupported");
    // A status word the declaration never saw means this file is not the
    // format it claims to be; treating it as posted would be a guess.
    if (!adapter.status.posted.includes(value)) throw new ImportFormatError("header_mismatch");
  }

  const issues: RowIssueCode[] = [];
  const postedDate = parseSourceDate(at(adapter.dateColumn), adapter.dateFormat);
  if (postedDate === null) issues.push("invalid_date");

  const merchant = normalizeMerchant(at(adapter.merchantColumn));
  if (merchant === null) issues.push("missing_merchant");

  const amount = readAmount(adapter, at);
  if (amount.issue !== null) issues.push(amount.issue);

  const bankKind = readBankKind(adapter, at);
  const classified = classifyImportAmount(amount.cents, bankKind ?? undefined);
  if (classified.issue !== null) issues.push(classified.issue);

  return {
    rowNumber,
    sourceFields: retainSourceFields(adapter, at),
    postedDate,
    merchant,
    cents: amount.cents,
    kind: classified.kind,
    kindSource: classified.kindSource,
    identity: readIdentity(adapter, at),
    issues,
  };
}

function readAmount(
  adapter: ImportAdapter,
  at: (column: string) => string,
): { cents: bigint | null; issue: RowIssueCode | null } {
  if (adapter.amount.style === "signed") {
    const parsed = parseSourceAmount(at(adapter.amount.column), CURRENCY);
    if (parsed.cents === null) return { cents: null, issue: parsed.issue };
    const cents = adapter.amount.outflow === "positive" ? -parsed.cents : parsed.cents;
    return { cents, issue: parsed.issue };
  }
  const debitText = at(adapter.amount.debitColumn);
  const creditText = at(adapter.amount.creditColumn);
  // Exactly one side carries the amount. Both filled or both empty is a row
  // the owner must correct, never a subtraction we invent.
  if ((debitText === "") === (creditText === "")) return { cents: null, issue: "invalid_amount" };
  const debit = debitText !== "";
  const parsed = parseSourceAmount(debit ? debitText : creditText, CURRENCY);
  if (parsed.cents === null) return { cents: null, issue: parsed.issue };
  // A sign inside an unsigned column contradicts the declaration.
  if (parsed.cents < 0n) return { cents: null, issue: "invalid_amount" };
  return { cents: debit ? -parsed.cents : parsed.cents, issue: parsed.issue };
}

function readBankKind(adapter: ImportAdapter, at: (column: string) => string): TransactionKind | null {
  if (adapter.type === null) return null;
  const word = at(adapter.type.column);
  if (!Object.hasOwn(adapter.type.words, word)) {
    if (adapter.type.unknown === "fail") throw new ImportFormatError("header_mismatch");
    return null;
  }
  return adapter.type.words[word] ?? null;
}

function retainSourceFields(adapter: ImportAdapter, at: (column: string) => string): Record<string, string> {
  const retained: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const column of adapter.retained) {
    const value = at(column.column);
    retained[column.column] = column.retain === "last_four" ? lastFourDigits(value) : value;
  }
  return retained;
}

/**
 * The bank's identifier, if the format declares one and this row carries it.
 * An empty or overlong value is simply no identifier: this row then falls back
 * to ordinary duplicate checks rather than being matched on something invented.
 */
function readIdentity(
  adapter: ImportAdapter,
  at: (column: string) => string,
): { namespace: string; bankTransactionId: string } | null {
  if (adapter.identity === null) return null;
  const value = at(adapter.identity.column).trim();
  if (value === "" || [...value].length > 255) return null;
  return { namespace: adapter.identity.namespace, bankTransactionId: value };
}

/** At most four digits survive; everything else about the number is discarded. */
function lastFourDigits(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  return digits.slice(-4);
}

/**
 * Reads a date in the format the declaration names, then checks it exists:
 * a bank can write 02/29/2026, and February 2026 has no 29th.
 */
export function parseSourceDate(text: string, format: SourceDateFormat): string | null {
  let canonical: string;
  if (format === "MM/DD/YYYY") {
    const match = /^([0-9]{2})\/([0-9]{2})\/([0-9]{4})$/.exec(text);
    if (match === null) return null;
    canonical = `${match[3]}-${match[1]}-${match[2]}`;
  } else {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return null;
    canonical = text;
  }
  return isCalendarDate(canonical) ? canonical : null;
}

/** Collapses the padding banks use for display; the source field keeps the original. */
function normalizeMerchant(text: string): string | null {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed.slice(0, 2000);
}

function dropTrailingEmpty(adapter: ImportAdapter, fields: readonly string[]): readonly string[] {
  if (!adapter.allowTrailingEmptyColumn) return fields;
  return fields.length === adapter.header.length + 1 && fields.at(-1) === ""
    ? fields.slice(0, -1)
    : fields;
}

/**
 * The reader keeps the byte-order mark so nothing downstream has to assume it
 * was stripped; it belongs to the header's first column name, not to its value.
 */
function stripBom(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

/** The public shape of a format, as the contract's `ImportFormat` lists it. */
export interface ImportFormatSummary {
  id: string;
  version: number;
  label: string;
  providerKey: ProviderKey;
  accountKind: AccountKind;
  evidence: ImportEvidence;
  /** The same bounds the reader enforces, so a client need not guess them. */
  limits: {
    maxFileBytes: number;
    maxRows: number;
    maxColumns: number;
    maxFieldBytes: number;
  };
}

export function summarizeFormat(adapter: ImportAdapter): ImportFormatSummary {
  return {
    id: adapter.id,
    version: adapter.version,
    label: adapter.label,
    providerKey: adapter.providerKey,
    accountKind: adapter.accountKind,
    evidence: adapter.evidence,
    limits: { ...IMPORT_CSV_LIMITS },
  };
}

export interface AdapterRegistry {
  list(): readonly ImportFormatSummary[];
  get(id: string): ImportAdapter | undefined;
}

export function createAdapterRegistry(adapters: readonly ImportAdapter[]): AdapterRegistry {
  const byId = new Map<string, ImportAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) throw new Error(`duplicate import format id: ${adapter.id}`);
    byId.set(adapter.id, adapter);
  }
  const summaries = adapters.map(summarizeFormat);
  return { list: () => summaries, get: id => byId.get(id) };
}

/**
 * The formats the owner can select. Being in this list is a claim that the
 * format's real headers, sign convention and date semantics were checked
 * against an actual export; a format that only ever saw fabricated rows is
 * injected by tests instead and must never appear here.
 *
 * Chase only, at the owner's direction: the Bank of America and Campus USA
 * accounts are pre-allocated whole to a category rather than imported row by
 * row. Their verified declarations are kept, unshipped, in
 * `adapters-shelved.ts`, so restoring one is adding it to this list.
 *
 * Savings is in the approved account-type scope but no savings provider was
 * ever named, so no savings format exists.
 */
export const PRODUCTION_ADAPTERS: readonly ImportAdapter[] =
  [CHASE_CHECKING, CHASE_CREDIT_CARD];
