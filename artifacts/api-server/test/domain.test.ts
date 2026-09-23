import { describe, expect, it } from "vitest";
import { ChangeAccountBaselineBody, CreateAccountBody } from "@workspace/api-zod";

import {
  aggregateMoney,
  AGGREGATE_BOUND,
  formatMinorUnits,
  money,
  MoneyFormatError,
  parseMinorUnits,
  parseMoney,
  STORED_BOUND,
} from "../src/domain/money.js";
import {
  addDays,
  assertCalendarDate,
  dayBefore,
  DateFormatError,
  easternDate,
  easternMonth,
  isCalendarDate,
  isYearMonth,
  monthEnd,
  nextMonthStart,
} from "../src/domain/dates.js";
import {
  COUNTER_BOUND,
  CounterOverflowError,
  etag,
  nextCounter,
  requireIfMatch,
} from "../src/domain/versions.js";
import { creationDigest } from "../src/domain/digest.js";
import { ProblemError } from "../src/lib/problem.js";

describe("canonical money", () => {
  const accepted = ["0", "1", "-1", "1234", "-1234", "99999999999", "-99999999999"];
  for (const text of accepted) {
    it(`accepts ${text}`, () => {
      expect(parseMinorUnits(text)).toBe(BigInt(text));
    });
  }

  const rejected: Array<[string, string]> = [
    [" 1", "leading whitespace"],
    ["1 ", "trailing whitespace"],
    ["+1", "leading plus"],
    ["01", "leading zero"],
    ["-01", "negative leading zero"],
    ["-0", "negative zero"],
    ["1.00", "decimal point"],
    ["1e3", "exponent"],
    ["1,000", "separator"],
    ["", "empty"],
    ["--1", "double sign"],
    ["0x10", "hexadecimal"],
    ["١٢٣", "non-ascii digits"],
  ];
  for (const [text, why] of rejected) {
    it(`rejects ${why}`, () => {
      expect(() => parseMinorUnits(text)).toThrow(MoneyFormatError);
    });
  }

  it("rejects a value longer than any canonical aggregate before converting it", () => {
    expect(() => parseMinorUnits("9".repeat(5000))).toThrow(MoneyFormatError);
  });

  it("keeps a value larger than Number.MAX_SAFE_INTEGER exact", () => {
    const exact = 9007199254740993n;
    expect(formatMinorUnits(parseMinorUnits("9007199254740993"))).toBe("9007199254740993");
    expect(aggregateMoney(exact).amountMinor).toBe("9007199254740993");
    // The point of the bigint pipeline: as a number this value is not even
    // representable, and would come back one cent short.
    expect(String(Number("9007199254740993"))).toBe("9007199254740992");
  });

  it("holds stored values under 10^11 and refuses the bound itself", () => {
    expect(money(STORED_BOUND - 1n).amountMinor).toBe("99999999999");
    expect(() => money(STORED_BOUND)).toThrow(MoneyFormatError);
    expect(() => money(-STORED_BOUND)).toThrow(MoneyFormatError);
  });

  it("holds aggregates under 10^18 and refuses the bound itself", () => {
    expect(aggregateMoney(AGGREGATE_BOUND - 1n).amountMinor).toBe("999999999999999999");
    expect(() => aggregateMoney(AGGREGATE_BOUND)).toThrow(MoneyFormatError);
  });

  it("reads a Money DTO and refuses another currency or an aggregate-sized amount", () => {
    expect(parseMoney({ amountMinor: "-2500", currency: "USD" })).toBe(-2500n);
    expect(() => parseMoney({ amountMinor: "100", currency: "EUR" })).toThrow(MoneyFormatError);
    expect(() => parseMoney({ amountMinor: "100000000000", currency: "USD" })).toThrow(
      MoneyFormatError,
    );
  });
});

describe("calendar dates", () => {
  const real = ["2026-04-02", "2028-02-29", "2026-01-31", "1900-01-01", "2999-12-31"];
  for (const text of real) {
    it(`accepts the real date ${text}`, () => {
      expect(isCalendarDate(text)).toBe(true);
    });
  }

  const impossible = [
    "2026-02-31",
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-4-2",
    "2026-04-02T00:00:00Z",
    "not-a-date",
    "",
    "0000-01-01",
    "1899-12-31",
    "3000-01-01",
  ];
  for (const text of impossible) {
    it(`rejects ${text === "" ? "the empty string" : text}`, () => {
      expect(isCalendarDate(text)).toBe(false);
      expect(() => assertCalendarDate(text)).toThrow(DateFormatError);
    });
  }

  it("names which layer rejects an impossible date the contract's pattern allows", () => {
    // The contract's LocalDate regex is shape-only: 2026-02-31 matches it.
    const pattern = /^(19|2[0-9])[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
    expect(pattern.test("2026-02-31")).toBe(true);

    // Recorded rather than assumed: this is what the generated zod schema
    // actually does with it today, and what the domain layer does.
    const body = (trackingStartDate: string): unknown => ({
      id: "00000000-0000-4000-8000-000000000001",
      kind: "checking",
      providerKey: "chase",
      displayName: "Synthetic Checking",
      trackingStartDate,
      openingBalance: { amountMinor: "0", currency: "USD" },
    });
    // The same body with a real date passes, so the rejection below is about
    // the date and not about some other field being wrong.
    expect(CreateAccountBody.safeParse(body("2026-02-28")).success).toBe(true);

    const viaZod = CreateAccountBody.safeParse(body("2026-02-31"));
    expect(viaZod.success).toBe(false);
    expect(viaZod.error?.issues.some((issue) => issue.path.join("/") === "trackingStartDate")).toBe(
      true,
    );
    expect(isCalendarDate("2026-02-31")).toBe(false);
  });

  it("handles month boundaries without timezone arithmetic", () => {
    expect(nextMonthStart("2026-04")).toBe("2026-05-01");
    expect(nextMonthStart("2026-12")).toBe("2027-01-01");
    expect(monthEnd("2026-04")).toBe("2026-04-30");
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
    expect(dayBefore("2028-03-01")).toBe("2028-02-29");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
  });

  it("recognizes months and rejects near-misses", () => {
    expect(isYearMonth("2026-04")).toBe(true);
    expect(isYearMonth("2026-13")).toBe(false);
    expect(isYearMonth("2026-4")).toBe(false);
    expect(isYearMonth("2026-04-01")).toBe(false);
  });
});

describe("the eastern domain clock", () => {
  it("reports the Eastern date, not the UTC one, late in the evening", () => {
    // 2026-04-02 21:30 Eastern is 2026-04-03 01:30 UTC.
    const evening = Date.UTC(2026, 3, 3, 1, 30);
    expect(new Date(evening).toISOString().slice(0, 10)).toBe("2026-04-03");
    expect(easternDate(evening)).toBe("2026-04-02");
    expect(easternMonth(evening)).toBe("2026-04");
  });

  it("is right across the spring-forward transition", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00 Eastern.
    expect(easternDate(Date.UTC(2026, 2, 8, 6, 59))).toBe("2026-03-08"); // 01:59 EST
    expect(easternDate(Date.UTC(2026, 2, 8, 7, 1))).toBe("2026-03-08"); // 03:01 EDT
    expect(easternDate(Date.UTC(2026, 2, 8, 3, 59))).toBe("2026-03-07"); // 22:59 EST
  });

  it("is right across the fall-back transition", () => {
    // 2026-11-01: clocks fall back 02:00 -> 01:00 Eastern; 01:30 happens twice.
    expect(easternDate(Date.UTC(2026, 10, 1, 5, 30))).toBe("2026-11-01"); // 01:30 EDT
    expect(easternDate(Date.UTC(2026, 10, 1, 6, 30))).toBe("2026-11-01"); // 01:30 EST
    expect(easternDate(Date.UTC(2026, 10, 1, 3, 30))).toBe("2026-10-31"); // 23:30 EDT
  });

  it("rolls the month over at Eastern midnight, not UTC midnight", () => {
    expect(easternMonth(Date.UTC(2026, 5, 1, 3, 0))).toBe("2026-05"); // 23:00 on 31 May
    expect(easternMonth(Date.UTC(2026, 5, 1, 5, 0))).toBe("2026-06"); // 01:00 on 1 June
  });

  it("agrees with the 2027 transitions too", () => {
    expect(easternDate(Date.UTC(2027, 2, 14, 6, 59))).toBe("2027-03-14");
    expect(easternDate(Date.UTC(2027, 10, 7, 6, 30))).toBe("2027-11-07");
  });
});

describe("versions and ETags", () => {
  it("increments and formats", () => {
    expect(nextCounter(1n)).toBe(2n);
    expect(etag(7n)).toBe('"7"');
  });

  it("refuses to wrap at the counter bound instead of silently reusing a version", () => {
    expect(() => nextCounter(COUNTER_BOUND - 1n)).toThrow(CounterOverflowError);
    expect(() => etag(COUNTER_BOUND)).toThrow(CounterOverflowError);
  });

  it("separates a missing If-Match from a malformed one", () => {
    expect(requireIfMatch('"3"')).toBe(3n);

    const missing = (): unknown => requireIfMatch(undefined);
    expect(missing).toThrow(ProblemError);
    try {
      missing();
    } catch (error) {
      expect((error as ProblemError).problem.status).toBe(428);
    }

    for (const bad of ["3", 'W/"3"', '""', '"0"', '"03"', '"3', 42]) {
      try {
        requireIfMatch(bad);
        throw new Error(`expected ${String(bad)} to be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(ProblemError);
        expect((error as ProblemError).problem.status).toBe(400);
      }
    }
  });
});

describe("creation digests", () => {
  it("ignores key order but not values", () => {
    const one = creationDigest({ kind: "checking", displayName: "Synthetic" });
    const two = creationDigest({ displayName: "Synthetic", kind: "checking" });
    expect(one).toBe(two);
    expect(creationDigest({ kind: "savings", displayName: "Synthetic" })).not.toBe(one);
  });

  it("distinguishes an absent field from an explicitly null one", () => {
    expect(creationDigest({ a: 1 })).toBe(creationDigest({ a: 1, b: undefined }));
    expect(creationDigest({ a: 1, b: null })).not.toBe(creationDigest({ a: 1 }));
  });

  it("is stable across nesting and arrays", () => {
    const value = { rows: [{ b: 2, a: 1 }], money: { currency: "USD", amountMinor: "-1" } };
    expect(creationDigest(value)).toBe(
      creationDigest({ money: { amountMinor: "-1", currency: "USD" }, rows: [{ a: 1, b: 2 }] }),
    );
  });
});

describe("the generated baseline body", () => {
  it("accepts each mode", () => {
    expect(
      ChangeAccountBaselineBody.safeParse({
        mode: "correct_opening_balance",
        openingBalance: { amountMinor: "1000", currency: "USD" },
      }).success,
    ).toBe(true);
    expect(
      ChangeAccountBaselineBody.safeParse({
        mode: "extend_backward",
        trackingStartDate: "2026-01-01",
        openingBalance: { amountMinor: "1000", currency: "USD" },
      }).success,
    ).toBe(true);
  });

  it("does not enforce uniqueItems on held row ids, the known generator gap", () => {
    const duplicated = ChangeAccountBaselineBody.safeParse({
      mode: "extend_backward",
      trackingStartDate: "2026-01-01",
      openingBalance: { amountMinor: "1000", currency: "USD" },
      heldRows: {
        importId: "00000000-0000-4000-8000-000000000001",
        importVersion: "1",
        rowIds: [
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000002",
        ],
      },
    });
    // Recorded, not endorsed: the gap is real, so the service checks by hand.
    expect(duplicated.success).toBe(true);
  });
});
