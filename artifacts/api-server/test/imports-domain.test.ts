import { describe, expect, it } from "vitest";
import {
  classifyImportAmount,
  deriveImportRowState,
  parseSourceAmount,
} from "../src/domain/imports.js";

describe("exact source decimal amounts", () => {
  it.each([
    ["1", 100n], ["1.2", 120n], ["1.23", 123n], ["-1.23", -123n],
    ["0.29", 29n], ["1.23000", 123n], ["-0.01000", -1n],
    ["0001.20", 120n], ["999999999.99", 99999999999n],
    ["-999999999.99", -99999999999n],
  ] as const)("parses %s without floating point", (text, cents) => {
    expect(parseSourceAmount(text, "USD")).toEqual({ cents, issue: null });
  });

  it.each(["0", "0.00", "-0", "-0.0000"])("holds zero %s", text => {
    expect(parseSourceAmount(text, "USD")).toEqual({ cents: 0n, issue: "zero_amount" });
  });

  it.each(["0.001", "-0.009", "1.23001", "999999999.999"])("never rounds %s", text => {
    expect(parseSourceAmount(text, "USD")).toEqual({ cents: null, issue: "fractional_cent" });
  });

  it.each([
    "", " ", "1 ", " 1", "+1", ".50", "1.", "1e2", "1,000.00",
    "$1.00", "(1.00)", "--1", "NaN", "Infinity", "1\n", "0x10",
    "1000000000", "-1000000000.00", "9".repeat(16385),
  ])("holds invalid or out-of-range input %#", text => {
    expect(parseSourceAmount(text, "USD")).toEqual({ cents: null, issue: "invalid_amount" });
  });

  it("checks currency without exposing or converting the source value", () => {
    for (const currency of ["EUR", "usd", "", null]) {
      expect(parseSourceAmount("12.34", currency)).toEqual({ cents: null, issue: "non_usd" });
    }
    for (const text of [12.34, null, undefined, {}, true]) {
      expect(parseSourceAmount(text, "USD")).toEqual({ cents: null, issue: "invalid_amount" });
    }
  });

  it("accepts bounded harmless zeros but refuses an oversized source field", () => {
    expect(parseSourceAmount("1." + "0".repeat(16382), "USD")).toEqual({ cents: 100n, issue: null });
    expect(parseSourceAmount("1." + "0".repeat(16383), "USD")).toEqual({ cents: null, issue: "invalid_amount" });
  });

  it("round-trips a deterministic sample of exact signed cents", () => {
    for (let cents = -10001n; cents <= 10001n; cents += 37n) {
      const magnitude = cents < 0n ? -cents : cents;
      const text = `${cents < 0n ? "-" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}00`;
      expect(parseSourceAmount(text, "USD")).toEqual({ cents, issue: null });
    }
  });
});

describe("initial import type suggestions", () => {
  it("defaults negative movements to purchase and holds positive movements", () => {
    expect(classifyImportAmount(-8000n)).toEqual({ kind: "purchase", kindSource: "default", issue: null });
    expect(classifyImportAmount(8000n)).toEqual({ kind: null, kindSource: null, issue: "choose_type" });
  });

  it.each(["refund", "income", "transfer"] as const)("uses verified bank evidence for %s", kind => {
    expect(classifyImportAmount(8000n, kind)).toEqual({ kind, kindSource: "bank", issue: null });
  });

  it("never flips the sign to make a bank type fit", () => {
    expect(classifyImportAmount(8000n, "purchase")).toEqual({ kind: null, kindSource: null, issue: "choose_type" });
    expect(classifyImportAmount(-8000n, "refund")).toEqual({ kind: null, kindSource: null, issue: "choose_type" });
    expect(classifyImportAmount(-8000n, "income")).toEqual({ kind: null, kindSource: null, issue: "choose_type" });
    expect(classifyImportAmount(-8000n, "transfer")).toEqual({ kind: "transfer", kindSource: "bank", issue: null });
  });

  it("does not classify an invalid or zero amount", () => {
    for (const cents of [null, 0n, 100000000000n, -100000000000n]) {
      expect(classifyImportAmount(cents, "transfer")).toEqual({ kind: null, kindSource: null, issue: null });
    }
  });
});

describe("import review state", () => {
  const ready = { excluded: false, hasValidationIssues: false, reviewRequired: false,
    duplicateStatus: "none" as const, duplicateDecision: null, transferReviewPending: false };

  it("holds every unresolved gate independently", () => {
    expect(deriveImportRowState(ready)).toBe("ready");
    for (const patch of [
      { hasValidationIssues: true }, { reviewRequired: true }, { transferReviewPending: true },
      { duplicateStatus: "suspected" as const }, { duplicateStatus: "confirmed" as const },
    ]) expect(deriveImportRowState({ ...ready, ...patch })).toBe("held");
  });

  it("requires a decision for suspected duplicates, never automatically excludes", () => {
    expect(deriveImportRowState({ ...ready, duplicateStatus: "suspected", duplicateDecision: "include" })).toBe("ready");
    expect(deriveImportRowState({ ...ready, duplicateStatus: "suspected", duplicateDecision: "exclude" })).toBe("excluded");
    expect(deriveImportRowState({ ...ready, duplicateStatus: "confirmed", duplicateDecision: "include" })).toBe("held");
    expect(deriveImportRowState({ ...ready, duplicateStatus: "confirmed", duplicateDecision: "exclude" })).toBe("excluded");
  });

  it("explicit exclusion permits invalid rows to remain out of the posting", () => {
    expect(deriveImportRowState({ ...ready, excluded: true, hasValidationIssues: true,
      reviewRequired: true, transferReviewPending: true, duplicateStatus: "confirmed" })).toBe("excluded");
  });

  it("duplicate inclusion cannot waive a separate validation or review issue", () => {
    expect(deriveImportRowState({ ...ready, duplicateStatus: "suspected", duplicateDecision: "include",
      hasValidationIssues: true })).toBe("held");
    expect(deriveImportRowState({ ...ready, duplicateStatus: "suspected", duplicateDecision: "include",
      reviewRequired: true })).toBe("held");
  });
});
