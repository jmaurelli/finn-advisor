export const UNCATEGORIZED_ID = "30000000-0000-4000-8000-000000000000";
export const INCOME_CATEGORY_ID = "30000000-0000-4000-8000-000000000001";

export type TransactionKind = "purchase" | "refund" | "income" | "transfer";
export type RuleMatchType = "contains" | "exact";
export type RuleAppliesTo = "purchases_and_refunds" | "purchases" | "refunds";

export class AssignmentTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentTextError";
  }
}

export function normalizeMatchText(text: string): string {
  // toLowerCase picks the Greek final sigma (U+03C2) by context; fold it to the
  // ordinary sigma so a capitalized or mid-word search still matches both ways.
  return text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase().replace(/\u03c2/gu, "\u03c3");
}

function boundedText(text: string, maximum: number, label: string): void {
  // Bound the original Unicode code points, not the potentially expanded NFKC result.
  if (text.length === 0 || text.length > maximum * 2 || [...text].length > maximum) {
    throw new AssignmentTextError(`${label} must contain 1 to ${maximum} characters.`);
  }
}

export function normalizeRulePattern(pattern: string): string {
  boundedText(pattern, 256, "Rule pattern");
  const normalized = normalizeMatchText(pattern);
  if (normalized.length === 0) throw new AssignmentTextError("Enter a rule pattern, not only spaces.");
  return normalized;
}

export function normalizeMerchantText(merchant: string): string {
  boundedText(merchant, 2000, "Merchant text");
  return normalizeMatchText(merchant);
}

export interface AssignmentRule {
  id: string;
  revision: bigint;
  position: bigint;
  matchType: RuleMatchType;
  normalizedPattern: string;
  accountId: string | null;
  appliesTo: RuleAppliesTo;
  categoryId: string;
}

export type Assignment =
  | { origin: "manual"; categoryId: string; ruleId: null; ruleRevision: null }
  | { origin: "rule"; categoryId: string; ruleId: string; ruleRevision: bigint }
  | { origin: "unassigned"; categoryId: typeof UNCATEGORIZED_ID; ruleId: null; ruleRevision: null }
  | { origin: "system"; categoryId: typeof INCOME_CATEGORY_ID | null; ruleId: null; ruleRevision: null };

export function matchesRule(
  rule: AssignmentRule,
  accountId: string,
  kind: TransactionKind,
  normalizedMerchant: string,
): boolean {
  if (kind !== "purchase" && kind !== "refund") return false;
  if (rule.accountId !== null && rule.accountId !== accountId) return false;
  if (rule.appliesTo === "purchases" && kind !== "purchase") return false;
  if (rule.appliesTo === "refunds" && kind !== "refund") return false;
  if (rule.normalizedPattern.length === 0) return false;
  return rule.matchType === "exact"
    ? normalizedMerchant === rule.normalizedPattern
    : normalizedMerchant.includes(rule.normalizedPattern);
}

/** Rules must be active, enabled, eligible and ordered by position by the caller. */
export function evaluateAssignment(
  input: {
    accountId: string;
    kind: TransactionKind;
    normalizedMerchant: string;
    current?: Assignment;
  },
  orderedRules: readonly AssignmentRule[],
): Assignment {
  if (input.kind === "income" || input.kind === "transfer") {
    return {
      origin: "system",
      categoryId: input.kind === "income" ? INCOME_CATEGORY_ID : null,
      ruleId: null,
      ruleRevision: null,
    };
  }
  if (input.current?.origin === "manual") return { ...input.current };
  const rule = orderedRules.find((candidate) =>
    matchesRule(candidate, input.accountId, input.kind, input.normalizedMerchant),
  );
  if (rule !== undefined) {
    return { origin: "rule", categoryId: rule.categoryId, ruleId: rule.id, ruleRevision: rule.revision };
  }
  return { origin: "unassigned", categoryId: UNCATEGORIZED_ID, ruleId: null, ruleRevision: null };
}
