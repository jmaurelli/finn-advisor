import { describe, expect, it } from "vitest";

import {
  AssignmentTextError,
  evaluateAssignment,
  INCOME_CATEGORY_ID,
  matchesRule,
  normalizeMatchText,
  normalizeMerchantText,
  normalizeRulePattern,
  UNCATEGORIZED_ID,
  type AssignmentRule,
} from "../src/domain/assignment.js";

const rule: AssignmentRule = {
  id: "60000000-0000-4000-8000-000000000001",
  revision: 2n,
  position: 1n,
  matchType: "contains",
  normalizedPattern: "market",
  accountId: null,
  appliesTo: "purchases_and_refunds",
  categoryId: "30000000-0000-4000-8000-000000000002",
};
const input = { accountId: "20000000-0000-4000-8000-000000000001", kind: "purchase" as const, normalizedMerchant: "synthetic market" };

describe("merchant and pattern normalization", () => {
  it("normalizes NFKC, whitespace and case without modifying the source", () => {
    const source = " \uff33\uff39\uff2e\uff34\uff28\uff25\uff34\uff29\uff23\u00a0\tMARKET\n ";
    expect(normalizeMerchantText(source)).toBe("synthetic market");
    expect(source).toContain("\uff33");
    expect(normalizeRulePattern(source)).toBe("synthetic market");
  });

  it("pins locale-independent casing and does not invent fuzzy matching", () => {
    expect(normalizeMatchText("I \u0130 Stra\u00dfe CAF\u00c9")).toBe("i i\u0307 stra\u00dfe caf\u00e9");
    expect(normalizeMatchText("Cafe\u0301")).toBe("caf\u00e9");
    expect(normalizeMatchText("Stra\u00dfe")).not.toBe(normalizeMatchText("STRASSE"));
    // Greek final sigma folds to the ordinary sigma, whatever the capitalized source position.
    expect(normalizeMatchText("\u039f\u0394\u039f\u03a3")).toBe("\u03bf\u03b4\u03bf\u03c3");
    expect(normalizeMatchText("\u03bf\u03b4\u03bf\u03c2")).toBe("\u03bf\u03b4\u03bf\u03c3");
    expect(normalizeMatchText("\u03a3")).toBe("\u03c3");
  });

  it.each(["", " ", "\t\n", "\u00a0\u3000"])("rejects an empty normalized pattern %j", (pattern) => {
    expect(() => normalizeRulePattern(pattern)).toThrow(AssignmentTextError);
  });

  it("bounds original patterns and merchants, not normalization expansion", () => {
    expect(normalizeRulePattern("\ufb03".repeat(256))).toBe("ffi".repeat(256));
    expect(normalizeMerchantText("\ufb03".repeat(2000))).toBe("ffi".repeat(2000));
    expect(() => normalizeRulePattern("a".repeat(257))).toThrow(AssignmentTextError);
    expect(() => normalizeMerchantText("a".repeat(2001))).toThrow(AssignmentTextError);
    expect(() => normalizeMerchantText("")).toThrow(AssignmentTextError);
  });

  it("counts Unicode code points at source limits", () => {
    expect(normalizeRulePattern("\u{1f6d2}".repeat(256))).toHaveLength(512);
    expect(() => normalizeRulePattern("\u{1f6d2}".repeat(257))).toThrow(AssignmentTextError);
    expect(normalizeMerchantText("\u{1f6d2}".repeat(2000))).toHaveLength(4000);
    expect(() => normalizeMerchantText("\u{1f6d2}".repeat(2001))).toThrow(AssignmentTextError);
  });

  it.each(["%", "_", ".*", "[ab]", "a+b", "a\\b"])("matches %j literally", (pattern) => {
    const literal = { ...rule, normalizedPattern: pattern };
    expect(matchesRule(literal, input.accountId, "purchase", `before ${pattern} after`)).toBe(true);
    expect(matchesRule(literal, input.accountId, "purchase", "something else")).toBe(false);
  });
});

describe("deterministic assignment", () => {
  it("uses the first match and retains its exact revision", () => {
    const later = { ...rule, id: "60000000-0000-4000-8000-000000000002", position: 2n };
    expect(evaluateAssignment(input, [rule, later])).toEqual({
      origin: "rule", categoryId: rule.categoryId, ruleId: rule.id, ruleRevision: 2n,
    });
    expect(evaluateAssignment(input, [later, rule]).ruleId).toBe(later.id);
  });

  it("distinguishes exact matching from contains", () => {
    expect(evaluateAssignment(input, [{ ...rule, matchType: "exact" }]).origin).toBe("unassigned");
    expect(evaluateAssignment({ ...input, normalizedMerchant: "market" }, [{ ...rule, matchType: "exact" }]).origin).toBe("rule");
  });

  it("checks account and purchase/refund scopes before matching", () => {
    expect(evaluateAssignment(input, [{ ...rule, accountId: "another-account" }]).origin).toBe("unassigned");
    expect(evaluateAssignment(input, [{ ...rule, accountId: input.accountId }]).origin).toBe("rule");
    expect(evaluateAssignment(input, [{ ...rule, appliesTo: "refunds" }]).origin).toBe("unassigned");
    expect(evaluateAssignment(input, [{ ...rule, appliesTo: "purchases" }]).origin).toBe("rule");
    expect(evaluateAssignment({ ...input, kind: "refund" }, [{ ...rule, appliesTo: "purchases" }]).origin).toBe("unassigned");
    expect(evaluateAssignment({ ...input, kind: "refund" }, [{ ...rule, appliesTo: "refunds" }]).origin).toBe("rule");
    expect(evaluateAssignment({ ...input, kind: "refund" }, [rule]).origin).toBe("rule");
  });

  it.each([UNCATEGORIZED_ID, rule.categoryId])("preserves a manual choice of %s", (categoryId) => {
    const current = { origin: "manual" as const, categoryId, ruleId: null, ruleRevision: null };
    expect(evaluateAssignment({ ...input, current }, [rule])).toEqual(current);
    expect(evaluateAssignment({ ...input, current }, [])).toEqual(current);
  });

  it("clears prior rule attribution on no match", () => {
    const current = evaluateAssignment(input, [rule]);
    expect(evaluateAssignment({ ...input, current }, [])).toEqual({
      origin: "unassigned", categoryId: UNCATEGORIZED_ID, ruleId: null, ruleRevision: null,
    });
  });

  it.each(["income", "transfer"] as const)("uses system classification for %s", (kind) => {
    expect(evaluateAssignment({ ...input, kind }, [rule])).toEqual({
      origin: "system", categoryId: kind === "income" ? INCOME_CATEGORY_ID : null, ruleId: null, ruleRevision: null,
    });
    expect(matchesRule(rule, input.accountId, kind, "market")).toBe(false);
  });

  it("does not treat an invalid empty stored pattern as a catch-all", () => {
    expect(evaluateAssignment(input, [{ ...rule, normalizedPattern: "" }]).origin).toBe("unassigned");
  });
});
