import { describe, expect, it } from "vitest";
import {
  budgetPercentUsed, budgetTimeline, resolveBudget, simulateBudgetChange,
  validateBudgetChange, validateBudgetConfiguration,
  type BudgetChange, type BudgetConfiguration,
} from "../src/domain/budgets.js";
import { easternMonth } from "../src/domain/dates.js";
import { STORED_BOUND } from "../src/domain/money.js";

const empty: BudgetConfiguration = { regular: [], monthly: [] };
const absent = { state: "absent", amount: null, source: null };
const amount = (value: bigint, source = "regular") => ({ state: "amount", amount: value, source });
const plan: BudgetConfiguration = {
  regular: [
    { month: "2026-06", state: "amount", amount: 20000n },
    { month: "2026-01", state: "amount", amount: 10000n },
    { month: "2026-08", state: "stopped", amount: null },
  ],
  monthly: [
    { month: "2026-03", state: "amount", amount: 0n },
    { month: "2026-04", state: "skip", amount: null },
    { month: "2026-09", state: "amount", amount: 5000n },
  ],
};

describe("budget resolution", () => {
  it.each([
    ["2025-12", absent], ["2026-01", amount(10000n)], ["2026-02", amount(10000n)],
    ["2026-03", amount(0n, "monthly")], ["2026-04", absent], ["2026-05", amount(10000n)],
    ["2026-06", amount(20000n)], ["2026-08", absent], ["2026-09", amount(5000n, "monthly")],
    ["2026-10", absent],
  ])("resolves %s with exception priority and no rollover", (month, expected) => {
    expect(resolveBudget(plan, month)).toEqual(expected);
  });

  it("distinguishes a recurring zero from a missing plan", () => {
    expect(resolveBudget(empty, "2026-01")).toEqual(absent);
    expect(resolveBudget({ regular: [{ month: "2026-01", state: "amount", amount: 0n }], monthly: [] },
      "2026-12")).toEqual(amount(0n));
  });

  it("supports standalone monthly amounts and skips without inventing a regular budget", () => {
    const monthlyOnly = { regular: [], monthly: plan.monthly };
    expect(resolveBudget(monthlyOnly, "2026-03")).toEqual(amount(0n, "monthly"));
    expect(resolveBudget(monthlyOnly, "2026-04")).toEqual(absent);
    expect(resolveBudget(monthlyOnly, "2026-05")).toEqual(absent);
  });

  it("applies an archive cutoff ahead of exceptions but preserves earlier months", () => {
    const lifecycle = { archived: true, cutoffMonth: "2026-03" };
    expect(resolveBudget(plan, "2026-02", lifecycle)).toEqual(amount(10000n));
    expect(resolveBudget(plan, "2026-03", lifecycle)).toEqual(absent);
    expect(resolveBudget(plan, "2026-09", lifecycle)).toEqual(absent);
    expect(resolveBudget(plan, "2026-03", { ...lifecycle, archived: false })).toEqual(amount(0n, "monthly"));
  });

  it("rejects invalid months rather than comparing malformed calendar strings", () => {
    for (const month of ["2026-00", "2026-13", "2026-1", "1899-12", "3000-01"]) {
      expect(() => resolveBudget(plan, month)).toThrow();
    }
  });
});

describe("pure budget changes", () => {
  it("replaces only the selected regular month, retaining later changes and all exceptions", () => {
    const original = structuredClone(plan);
    const changed = simulateBudgetChange(plan, { change: "set_regular", fromMonth: "2026-01", amount: 30000n }, "2026-01");
    expect(changed.removed).toEqual([]);
    expect(changed.plan.regular).toEqual([
      { month: "2026-01", state: "amount", amount: 30000n },
      { month: "2026-06", state: "amount", amount: 20000n },
      { month: "2026-08", state: "stopped", amount: null },
    ]);
    expect(changed.plan.monthly).toEqual(plan.monthly);
    expect(resolveBudget(changed.plan, "2026-06")).toEqual(amount(20000n));
    expect(resolveBudget(changed.plan, "2026-03")).toEqual(amount(0n, "monthly"));
    changed.plan.monthly[0]!.month = "2025-01";
    expect(plan).toEqual(original);
  });

  it("sets and replaces a historical monthly entry without starting recurrence", () => {
    const first = simulateBudgetChange(empty, { change: "set_month", month: "2025-12", amount: 123n }, "2026-02").plan;
    const second = simulateBudgetChange(first, { change: "set_month", month: "2025-12", amount: 0n }, "2026-02").plan;
    expect(second).toEqual({ regular: [], monthly: [{ month: "2025-12", state: "amount", amount: 0n }] });
    expect(resolveBudget(second, "2026-01")).toEqual(absent);
    const skipped = simulateBudgetChange(second, { change: "skip_month", month: "2025-12" }, "2026-02").plan;
    expect(skipped.monthly).toEqual([{ month: "2025-12", state: "skip", amount: null }]);
  });

  it.each<BudgetChange>([
    { change: "set_month", month: "2026-03", amount: 123n },
    { change: "skip_month", month: "2026-03" },
  ])("$change preserves unrelated regular and monthly configuration", change => {
    const original = structuredClone(plan);
    const result = simulateBudgetChange(plan, change, "2026-10");
    expect(result.plan.regular).toEqual([plan.regular[1], plan.regular[0], plan.regular[2]]);
    expect(result.plan.monthly).toEqual([
      change.change === "set_month" ? { month: "2026-03", state: "amount", amount: 123n }
        : { month: "2026-03", state: "skip", amount: null },
      plan.monthly[1], plan.monthly[2],
    ]);
    expect(result.removed).toEqual([]);
    expect(resolveBudget(result.plan, "2026-02")).toEqual(amount(10000n));
    expect(resolveBudget(result.plan, "2026-04")).toEqual(absent);
    expect(resolveBudget(result.plan, "2026-09")).toEqual(amount(5000n, "monthly"));
    expect(plan).toEqual(original);
  });

  it("stop retains earlier monthly history and removes entries beyond the twelve-month horizon", () => {
    const extended: BudgetConfiguration = {
      regular: [...plan.regular, { month: "2999-12", state: "amount", amount: 99n }],
      monthly: [...plan.monthly, { month: "2026-01", state: "amount", amount: 1n },
        { month: "2026-02", state: "skip", amount: null },
        { month: "2999-12", state: "amount", amount: 88n }],
    };
    const result = simulateBudgetChange(extended, { change: "stop", fromMonth: "2026-03" }, "2026-03");
    expect(result.plan.monthly).toEqual(extended.monthly.slice(3, 5));
    expect(resolveBudget(result.plan, "2026-01")).toEqual(amount(1n, "monthly"));
    expect(resolveBudget(result.plan, "2026-02")).toEqual(absent);
    expect(result.removed).toHaveLength(7);
    expect(result.removed.slice(-2)).toEqual([
      { kind: "regular", entry: extended.regular[3] },
      { kind: "monthly", entry: extended.monthly[5] },
    ]);
    expect(resolveBudget(result.plan, "2999-12")).toEqual(absent);
  });

  it("stops monthly-only plans, repeats a stop, and restarts only through a deliberate regular change", () => {
    const first = simulateBudgetChange({ regular: [], monthly: plan.monthly },
      { change: "stop", fromMonth: "2026-03" }, "2026-03");
    expect(first.plan).toEqual({ regular: [{ month: "2026-03", state: "stopped", amount: null }], monthly: [] });
    const repeated = simulateBudgetChange(first.plan, { change: "stop", fromMonth: "2026-03" }, "2026-03");
    expect(repeated.plan).toEqual(first.plan);
    expect(repeated.removed).toEqual([{ kind: "regular", entry: first.plan.regular[0] }]);
    const restarted = simulateBudgetChange(repeated.plan,
      { change: "set_regular", fromMonth: "2026-03", amount: 0n }, "2026-03");
    expect(restarted.plan).toEqual({ regular: [{ month: "2026-03", state: "amount", amount: 0n }], monthly: [] });
    expect(resolveBudget(restarted.plan, "2027-01")).toEqual(amount(0n));
  });

  it("stop removes both kinds at and after the boundary and never resurrects later changes", () => {
    const original = structuredClone(plan);
    const result = simulateBudgetChange(plan, { change: "stop", fromMonth: "2026-03" }, "2026-02");
    expect(result.removed).toEqual([
      { kind: "monthly", entry: plan.monthly[0] }, { kind: "monthly", entry: plan.monthly[1] },
      { kind: "regular", entry: plan.regular[0] }, { kind: "regular", entry: plan.regular[2] },
      { kind: "monthly", entry: plan.monthly[2] },
    ]);
    expect(result.plan).toEqual({ regular: [
      { month: "2026-01", state: "amount", amount: 10000n },
      { month: "2026-03", state: "stopped", amount: null },
    ], monthly: [] });
    expect(resolveBudget(result.plan, "2026-02")).toEqual(amount(10000n));
    for (const month of ["2026-03", "2026-06", "2026-09", "2027-01"]) {
      expect(resolveBudget(result.plan, month, { archived: false, cutoffMonth: null })).toEqual(absent);
    }
    expect(plan).toEqual(original);
  });

  it("stop removes a regular entry exactly at the boundary and reports both same-month entries", () => {
    const both: BudgetConfiguration = { regular: [{ month: "2026-03", state: "amount", amount: 1n }],
      monthly: [{ month: "2026-03", state: "skip", amount: null }] };
    const result = simulateBudgetChange(both, { change: "stop", fromMonth: "2026-03" }, "2026-03");
    expect(result.removed.map(entry => entry.kind)).toEqual(["regular", "monthly"]);
    expect(result.plan.regular).toEqual([{ month: "2026-03", state: "stopped", amount: null }]);
    expect(result.plan.monthly).toEqual([]);
  });

  it.each<BudgetChange>([
    { change: "set_regular", fromMonth: "2026-03", amount: 1n },
    { change: "stop", fromMonth: "2026-03" },
  ])("rechecks $change against the Eastern month at execution", change => {
    expect(() => validateBudgetChange(change, easternMonth(Date.parse("2026-04-01T03:59:59Z")))).not.toThrow();
    expect(() => validateBudgetChange(change, easternMonth(Date.parse("2026-04-01T04:00:00Z")))).toThrow(/past/);
  });

  it.each([-1n, STORED_BOUND])("rejects inadmissible cents %s", value => {
    expect(() => simulateBudgetChange(empty, { change: "set_month", month: "2026-01", amount: value }, "2026-01")).toThrow();
  });

  it("validates stored configuration amounts and duplicate keys before simulation", () => {
    expect(() => validateBudgetConfiguration({ regular: [...plan.regular, plan.regular[0]!], monthly: [] })).toThrow(/Duplicate/);
    expect(() => validateBudgetConfiguration({ regular: [], monthly: [
      { month: "2026-01", state: "amount", amount: -1n },
    ] })).toThrow();
  });
});

describe("budget review calendar and display math", () => {
  it.each(["2026-12", "2028-02", "2999-01"])("returns exactly twelve calendar months from %s", start => {
    const timeline = budgetTimeline(empty, plan, start);
    expect(timeline).toHaveLength(12);
    expect(timeline[0]!.month).toBe(start);
    const expectedEnd = { "2026-12": "2027-11", "2028-02": "2029-01", "2999-01": "2999-12" }[start];
    expect(timeline[11]!.month).toBe(expectedEnd);
    expect(new Set(timeline.map(row => row.month)).size).toBe(12);
  });

  it("records independently resolved before and after values, including zero", () => {
    const timeline = budgetTimeline(empty, plan, "2026-01");
    expect(timeline[2]).toEqual({ month: "2026-03", before: absent, after: amount(0n, "monthly") });
  });

  it("reviews every consecutive month across a leap February using a simulated change", () => {
    const before: BudgetConfiguration = { regular: [{ month: "2027-12", state: "amount", amount: 123n }], monthly: [] };
    const after = simulateBudgetChange(before, { change: "skip_month", month: "2028-02" }, "2028-03").plan;
    const months = ["2027-12", "2028-01", "2028-02", "2028-03", "2028-04", "2028-05",
      "2028-06", "2028-07", "2028-08", "2028-09", "2028-10", "2028-11"];
    expect(budgetTimeline(before, after, "2027-12")).toEqual(months.map(month => ({
      month, before: amount(123n), after: month === "2028-02" ? absent : amount(123n),
    })));
  });

  it("refuses an unrepresentable twelve-month review without shortening it", () => {
    expect(() => budgetTimeline(empty, empty, "2999-02")).toThrow();
  });

  it.each([
    [0n, 0n, null], [1n, 0n, null], [0n, 100n, 0], [1n, 200n, 1], [-1n, 200n, -1],
    [1n, 201n, 0], [-1n, 201n, 0], [12345n, 10000n, 123], [-12345n, 10000n, -123],
    [9007199254740993n, 100n, null],
  ])("rounds signed %s / %s safely", (net, limit, expected) => {
    if (net === 9007199254740993n) expect(() => budgetPercentUsed(net, limit)).toThrow(/safe display/);
    else expect(budgetPercentUsed(net, limit)).toBe(expected);
  });

  it("preserves an exact large numerator and the safe integer boundary", () => {
    expect(budgetPercentUsed(9007199254740993n, 10000n)).toBe(90071992547410);
    expect(budgetPercentUsed(9007199254740991n, 100n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => budgetPercentUsed(-9007199254740992n, 100n)).toThrow();
    expect(() => budgetPercentUsed(1n, -1n)).toThrow();
  });
});
