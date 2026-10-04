import type { TransactionKind } from "./assignment.js";
import { CURRENCY, STORED_BOUND } from "./money.js";

export type SourceAmountResult =
  | { cents: bigint; issue: null | "zero_amount" }
  | { cents: null; issue: "invalid_amount" | "fractional_cent" | "non_usd" };

/** Adapters must explicitly normalize verified separators/sign syntax before this boundary. */
export function parseSourceAmount(text: unknown, currency: unknown): SourceAmountResult {
  if (currency !== CURRENCY) return { cents: null, issue: "non_usd" };
  if (typeof text !== "string" || text.length === 0 || text.length > 16384) {
    return { cents: null, issue: "invalid_amount" };
  }
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))$/.exec(text)
    ?? /^(-?)([0-9]+)$/.exec(text);
  // JavaScript's $ also matches before a final newline; require the entire field.
  if (match === null || match[0] !== text) return { cents: null, issue: "invalid_amount" };
  const fraction = match[3] ?? "";
  if (/[1-9]/.test(fraction.slice(2))) return { cents: null, issue: "fractional_cent" };
  const whole = match[2]!.replace(/^0+/, "") || "0";
  if (whole.length > 9) return { cents: null, issue: "invalid_amount" };
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0"));
  if (magnitude >= STORED_BOUND) return { cents: null, issue: "invalid_amount" };
  const cents = match[1] === "-" ? -magnitude : magnitude;
  return { cents, issue: cents === 0n ? "zero_amount" : null };
}

export interface InitialImportKind {
  kind: TransactionKind | null;
  kindSource: "bank" | "default" | null;
  issue: "choose_type" | null;
}

/** Initial type only; candidate review and explicit owner decisions are separate gates. */
export function classifyImportAmount(cents: bigint | null, bankKind?: TransactionKind): InitialImportKind {
  if (cents === null || cents === 0n || cents <= -STORED_BOUND || cents >= STORED_BOUND) {
    return { kind: null, kindSource: null, issue: null };
  }
  if (bankKind !== undefined) {
    const compatible = bankKind === "transfer" || (bankKind === "purchase" ? cents < 0n : cents > 0n);
    return compatible
      ? { kind: bankKind, kindSource: "bank", issue: null }
      : { kind: null, kindSource: null, issue: "choose_type" };
  }
  return cents < 0n
    ? { kind: "purchase", kindSource: "default", issue: null }
    : { kind: null, kindSource: null, issue: "choose_type" };
}

export interface ImportReviewGates {
  excluded: boolean;
  hasValidationIssues: boolean;
  reviewRequired: boolean;
  duplicateStatus: "none" | "suspected" | "confirmed";
  duplicateDecision: "include" | "exclude" | null;
  transferReviewPending: boolean;
}

/** The caller supplies decisions validated against the current evidence snapshot. */
export function deriveImportRowState(input: ImportReviewGates): "ready" | "held" | "excluded" {
  if (input.excluded || input.duplicateDecision === "exclude") return "excluded";
  if (input.hasValidationIssues || input.reviewRequired || input.transferReviewPending
    || input.duplicateStatus === "confirmed"
    || (input.duplicateStatus === "suspected" && input.duplicateDecision !== "include")) return "held";
  return "ready";
}

/** Negative amounts can be purchases or transfers; positive ones refunds, income or transfers. */
export function kindAllowsAmount(kind: TransactionKind, cents: bigint): boolean {
  if (kind === "transfer") return true;
  return kind === "purchase" ? cents < 0n : cents > 0n;
}

export type RowIssueCode =
  | "invalid_date" | "invalid_amount" | "fractional_cent" | "zero_amount" | "non_usd"
  | "missing_merchant" | "before_tracking_start" | "choose_type"
  | "suspected_duplicate" | "confirmed_duplicate" | "possible_transfer" | "suggestion_changed";

/** The money issues, which share one field and cannot be told apart from a null amount. */
const MONEY_ISSUES: ReadonlySet<string> = new Set([
  "invalid_amount", "fractional_cent", "zero_amount", "non_usd",
]);

export function isMoneyIssue(code: string): boolean {
  return MONEY_ISSUES.has(code);
}

/** The issues that must be corrected before a row can be added to the ledger. */
export function isValidationIssue(code: RowIssueCode): boolean {
  return MONEY_ISSUES.has(code) || code === "invalid_date" || code === "missing_merchant"
    || code === "choose_type" || code === "before_tracking_start";
}

export interface RowIssueInput {
  postedDate: string | null;
  /**
   * The account's current tracking start. A row dated before it is held for
   * coverage rather than corrected: the date is right and the account's
   * coverage is short, which only a baseline change can fix.
   */
  trackingStartDate: string;
  cents: bigint | null;
  merchant: string | null;
  kind: TransactionKind | null;
  /**
   * The money issue already recorded for this row. A null amount cannot say
   * which of the money issues produced it, so the original reason is carried
   * forward until the owner supplies a new amount.
   */
  retainedMoneyIssue: RowIssueCode | null;
  duplicateStatus: "none" | "suspected" | "confirmed";
  duplicateDecision: "include" | "exclude" | null;
  transferPending: boolean;
  changedSuggestions: readonly string[];
}

/**
 * Every reason this row is not simply ready, derived from its current values
 * rather than accumulated. Order is stable so two equal rows read the same.
 */
export function deriveRowIssues(input: RowIssueInput): RowIssueCode[] {
  const issues: RowIssueCode[] = [];
  if (input.postedDate === null) issues.push("invalid_date");
  else if (input.postedDate < input.trackingStartDate) issues.push("before_tracking_start");
  if (input.cents === null) issues.push(input.retainedMoneyIssue ?? "invalid_amount");
  else if (input.cents === 0n) issues.push("zero_amount");
  if (input.merchant === null) issues.push("missing_merchant");
  if (input.kind === null && input.cents !== null && input.cents !== 0n) issues.push("choose_type");
  if (input.duplicateStatus === "confirmed") issues.push("confirmed_duplicate");
  else if (input.duplicateStatus === "suspected" && input.duplicateDecision === null) {
    issues.push("suspected_duplicate");
  }
  if (input.transferPending) issues.push("possible_transfer");
  if (input.changedSuggestions.length > 0) issues.push("suggestion_changed");
  return issues;
}

export function importIssueField(code: string): "postedDate" | "money" | "merchant" | "kind" | "category" | null {
  if (code === "invalid_date") return "postedDate";
  if (MONEY_ISSUES.has(code)) return "money";
  if (code === "missing_merchant") return "merchant";
  if (code === "choose_type") return "kind";
  return null;
}

export function importIssueMessage(code: string): string {
  return {
    invalid_date: "This date could not be read. Correct it to include the row.",
    invalid_amount: "This amount could not be read. Correct it to include the row.",
    fractional_cent: "This amount is not a whole number of cents. Correct it to include the row.",
    zero_amount: "This row has no amount. Correct it or leave it out.",
    non_usd: "This row is not in US dollars.",
    missing_merchant: "This row has no description. Add one to include it.",
    before_tracking_start: "This row is earlier than this account's tracking start.",
    choose_type: "Choose income, refund or transfer.",
    suspected_duplicate: "This may already be in your ledger. Decide whether to include it.",
    confirmed_duplicate: "Your bank says this is already imported. It can only be left out.",
    possible_transfer: "This may be one side of a transfer. Confirm or reject the match.",
    suggestion_changed: "The suggestion for this row changed. Review it again.",
  }[code] ?? "This row needs review.";
}

export interface RowIssueDto { code: string; field: string | null; message: string }

export function importIssueDto(code: string): RowIssueDto {
  return { code, field: importIssueField(code), message: importIssueMessage(code) };
}
