import { describe, expect, it } from "vitest";
import {
  createAdapterRegistry, matchHeader, normalizeRow, parseSourceDate,
  PRODUCTION_ADAPTERS, summarizeFormat, ImportFormatError,
  type AdapterRow, type ColumnIndex, type ImportAdapter,
} from "../src/imports/adapters.js";
import {
  SYNTHETIC_ADAPTERS, SYNTHETIC_CHECKING, SYNTHETIC_IDENTIFIED_CHECKING, SYNTHETIC_STATUS_CARD,
} from "../src/imports/adapters-synthetic.js";
import { readImportCsv } from "../src/lib/import-csv.js";

const checkingColumns = (): ColumnIndex => matchHeader(SYNTHETIC_CHECKING, SYNTHETIC_CHECKING.header);
const cardColumns = (): ColumnIndex => matchHeader(SYNTHETIC_STATUS_CARD, SYNTHETIC_STATUS_CARD.header);

const checkingRow = (fields: readonly string[], rowNumber = 1): AdapterRow | null =>
  normalizeRow(SYNTHETIC_CHECKING, checkingColumns(), fields, rowNumber);
const cardRow = (fields: readonly string[], rowNumber = 1): AdapterRow | null =>
  normalizeRow(SYNTHETIC_STATUS_CARD, cardColumns(), fields, rowNumber);

const failureOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ImportFormatError) return error.code;
    throw error;
  }
  return "no error";
};

describe("header matching", () => {
  it("accepts exactly the declared columns, with or without a byte-order mark", () => {
    expect([...checkingColumns()]).toEqual([["Date", 0], ["Description", 1], ["Amount", 2], ["Type", 3]]);
    const withBom = ["﻿Date", "Description", "Amount", "Type"];
    expect(matchHeader(SYNTHETIC_CHECKING, withBom).get("Date")).toBe(0);
  });

  it.each([
    ["renamed", ["Date", "Memo", "Amount", "Type"]],
    ["reordered", ["Description", "Date", "Amount", "Type"]],
    ["missing a column", ["Date", "Description", "Amount"]],
    ["one column too many", ["Date", "Description", "Amount", "Type", "Balance"]],
    ["differently cased", ["date", "Description", "Amount", "Type"]],
    ["padded", [" Date", "Description", "Amount", "Type"]],
    ["empty", []],
  ])("refuses a header that is %s", (_label, header) => {
    expect(failureOf(() => matchHeader(SYNTHETIC_CHECKING, header))).toBe("header_mismatch");
  });

  it("refuses a duplicated column name rather than picking one of them", () => {
    const twice: ImportAdapter = { ...SYNTHETIC_CHECKING, header: ["Date", "Amount", "Amount", "Type"] };
    expect(failureOf(() => matchHeader(twice, ["Date", "Amount", "Amount", "Type"]))).toBe("header_mismatch");
  });

  it("tolerates a trailing separator only where the format declares it", () => {
    const header = [...SYNTHETIC_STATUS_CARD.header, ""];
    expect(matchHeader(SYNTHETIC_STATUS_CARD, header).size).toBe(6);
    expect(failureOf(() => matchHeader(SYNTHETIC_CHECKING, [...SYNTHETIC_CHECKING.header, ""])))
      .toBe("header_mismatch");
  });
});

describe("dates", () => {
  it.each([
    ["01/02/2026", "2026-01-02"], ["12/31/2999", "2999-12-31"],
    ["02/29/2028", "2028-02-29"], ["01/01/1900", "1900-01-01"],
  ] as const)("reads %s as %s", (text, expected) => {
    expect(parseSourceDate(text, "MM/DD/YYYY")).toBe(expected);
  });

  it.each([
    "02/29/2026", "02/31/2026", "04/31/2026", "13/01/2026", "00/10/2026",
    "01/00/2026", "1/2/2026", "01/02/26", "2026-01-02", "12/31/1899",
    "01/01/3000", "", " 01/02/2026", "01/02/2026 ",
  ])("refuses the non-date %s", text => {
    expect(parseSourceDate(text, "MM/DD/YYYY")).toBeNull();
  });

  it("reads the declared ISO syntax and no other", () => {
    expect(parseSourceDate("2026-02-29", "YYYY-MM-DD")).toBeNull();
    expect(parseSourceDate("2028-02-29", "YYYY-MM-DD")).toBe("2028-02-29");
    expect(parseSourceDate("02/29/2028", "YYYY-MM-DD")).toBeNull();
  });

  it("holds a row whose date does not exist instead of moving it", () => {
    const row = checkingRow(["02/29/2026", "SYNTHETIC MARKET", "-45.99", "DEBIT"])!;
    expect(row.postedDate).toBeNull();
    expect(row.issues).toEqual(["invalid_date"]);
    // The unreadable value is still available for the owner to correct.
    expect(row.sourceFields["Date"]).toBe("02/29/2026");
  });
});

describe("signed amounts and the bank's own type words", () => {
  it("normalizes a purchase the bank marked DEBIT", () => {
    expect(checkingRow(["05/01/2026", "SYNTHETIC MARKET", "-45.99", "DEBIT"])).toEqual({
      rowNumber: 1,
      sourceFields: { Date: "05/01/2026", Description: "SYNTHETIC MARKET", Amount: "-45.99", Type: "DEBIT" },
      postedDate: "2026-05-01",
      merchant: "SYNTHETIC MARKET",
      cents: -4599n,
      kind: "purchase",
      kindSource: "bank",
      identity: null,
      issues: [],
    });
  });

  it("asks the owner about money arriving, because CREDIT does not say why", () => {
    const row = checkingRow(["05/02/2026", "SYNTHETIC ONLINE CREDIT", "25.00", "CREDIT"])!;
    expect(row.cents).toBe(2500n);
    expect({ kind: row.kind, kindSource: row.kindSource, issues: row.issues })
      .toEqual({ kind: null, kindSource: null, issues: ["choose_type"] });
  });

  it("never flips a sign to agree with the bank's word", () => {
    const row = checkingRow(["05/02/2026", "SYNTHETIC REFUND", "25.00", "DEBIT"])!;
    expect(row.cents).toBe(2500n);
    expect(row.issues).toEqual(["choose_type"]);
    expect(row.kind).toBeNull();
  });

  it("inverts only where the format declares that outflows are written positive", () => {
    const inverted: ImportAdapter = {
      ...SYNTHETIC_CHECKING,
      amount: { style: "signed", column: "Amount", outflow: "positive" },
      type: null,
    };
    const columns = matchHeader(inverted, inverted.header);
    const row = normalizeRow(inverted, columns, ["05/01/2026", "SYNTHETIC MARKET", "45.99", "X"], 1)!;
    expect(row.cents).toBe(-4599n);
    expect({ kind: row.kind, kindSource: row.kindSource }).toEqual({ kind: "purchase", kindSource: "default" });
    // The retained source keeps what the bank wrote, not the normalized sign.
    expect(row.sourceFields["Amount"]).toBe("45.99");
  });

  it.each([
    ["-45.999", "fractional_cent"],
    ["0.00", "zero_amount"],
    ["1,045.99", "invalid_amount"],
    ["$45.99", "invalid_amount"],
    ["(45.99)", "invalid_amount"],
    ["", "invalid_amount"],
  ] as const)("holds the amount %s as %s", (text, issue) => {
    const row = checkingRow(["05/01/2026", "SYNTHETIC MARKET", text, "DEBIT"])!;
    expect(row.issues).toContain(issue);
    if (issue !== "zero_amount") expect(row.cents).toBeNull();
  });

  it("keeps an unusable amount unclassified rather than defaulting its type", () => {
    const row = checkingRow(["05/01/2026", "SYNTHETIC MARKET", "abc", "DEBIT"])!;
    expect({ kind: row.kind, kindSource: row.kindSource }).toEqual({ kind: null, kindSource: null });
    expect(row.issues).toEqual(["invalid_amount"]);
  });

  it("refuses a file using a type word the declaration never saw", () => {
    expect(failureOf(() => checkingRow(["05/01/2026", "SYNTHETIC MARKET", "-45.99", "ACH"])))
      .toBe("header_mismatch");
  });

  it("drops an unlisted type word where the format declares its vocabulary incomplete", () => {
    const lenient: ImportAdapter = {
      ...SYNTHETIC_CHECKING,
      type: { column: "Type", words: { DEBIT: "purchase" }, unknown: "ignore" },
    };
    const columns = matchHeader(lenient, lenient.header);
    const row = normalizeRow(lenient, columns, ["05/01/2026", "SYNTHETIC MARKET", "-45.99", "ACH"], 1)!;
    expect({ kind: row.kind, kindSource: row.kindSource }).toEqual({ kind: "purchase", kindSource: "default" });
  });
});

describe("split amount columns, status and masking", () => {
  const posted = (debit: string, credit: string): AdapterRow | null =>
    cardRow(["2026-04-05", "SYNTHETIC HARDWARE", debit, credit, "Posted", "4111111111111234"]);

  it("reads a debit as money leaving and a credit as money arriving", () => {
    expect(posted("80.00", "")!.cents).toBe(-8000n);
    const credit = posted("", "80.00")!;
    expect(credit.cents).toBe(8000n);
    expect(credit.issues).toEqual(["choose_type"]);
  });

  it.each([
    ["both filled", "80.00", "80.00"],
    ["neither filled", "", ""],
    ["a sign inside an unsigned column", "-80.00", ""],
  ])("holds a row with %s instead of inventing an amount", (_label, debit, credit) => {
    const row = posted(debit, credit)!;
    expect(row.cents).toBeNull();
    expect(row.issues).toContain("invalid_amount");
  });

  it("retains only declared columns and never a whole account number", () => {
    const row = posted("80.00", "")!;
    expect(row.sourceFields).toEqual({
      "Post Date": "2026-04-05",
      Description: "SYNTHETIC HARDWARE",
      Debit: "80.00",
      Credit: "",
      "Account Number": "1234",
    });
    // Declared but unretained: the status drove the decision and is not kept.
    expect(Object.hasOwn(row.sourceFields, "Status")).toBe(false);
    expect(JSON.stringify(row.sourceFields)).not.toContain("4111111111111");
  });

  it.each(["", "12", "**** **** **** 5678", "x"])("masks the account number %s to at most four digits", value => {
    const row = cardRow(["2026-04-05", "SYNTHETIC HARDWARE", "80.00", "", "Posted", value])!;
    expect(row.sourceFields["Account Number"]!.length).toBeLessThanOrEqual(4);
    expect(row.sourceFields["Account Number"]).toBe(value.replace(/[^0-9]/g, "").slice(-4));
  });

  it("refuses the whole file when the bank has not posted a row yet", () => {
    for (const status of ["Pending", "Authorized"]) {
      expect(failureOf(() => cardRow(["2026-04-05", "SYNTHETIC HARDWARE", "80.00", "", status, "1234"])))
        .toBe("pending_records_unsupported");
    }
  });

  it("refuses a status word the declaration never saw rather than assuming it posted", () => {
    expect(failureOf(() => cardRow(["2026-04-05", "SYNTHETIC HARDWARE", "80.00", "", "Cleared", "1234"])))
      .toBe("header_mismatch");
  });
});

describe("merchants", () => {
  it("collapses display padding while the source field keeps the original", () => {
    const row = checkingRow(["05/01/2026", "  SYNTHETIC   MARKET \t#12 ", "-45.99", "DEBIT"])!;
    expect(row.merchant).toBe("SYNTHETIC MARKET #12");
    expect(row.sourceFields["Description"]).toBe("  SYNTHETIC   MARKET \t#12 ");
  });

  it.each(["", " ", "\t", "   \r  "])("holds a row whose description is blank (%j)", text => {
    const row = checkingRow(["05/01/2026", text, "-45.99", "DEBIT"])!;
    expect(row.merchant).toBeNull();
    expect(row.issues).toEqual(["missing_merchant"]);
  });

  it("bounds a very long description to the contract's limit", () => {
    const row = checkingRow(["05/01/2026", "M".repeat(3000), "-45.99", "DEBIT"])!;
    expect(row.merchant!.length).toBe(2000);
  });
});

describe("ragged and blank records", () => {
  it("refuses a record that does not carry the header's columns", () => {
    for (const fields of [["05/01/2026", "M", "-1.00"], ["05/01/2026", "M", "-1.00", "DEBIT", "extra"]]) {
      expect(failureOf(() => checkingRow(fields))).toBe("malformed_csv");
    }
  });

  it("skips a blank line only where the format declares them, without renumbering", () => {
    expect(cardRow([""], 4)).toBeNull();
    expect(cardRow(["", "", "", "", "", ""], 4)).toBeNull();
    expect(failureOf(() => checkingRow([""]))).toBe("malformed_csv");
  });

  it("accepts a declared trailing separator on a data row", () => {
    const row = cardRow(["2026-04-05", "SYNTHETIC HARDWARE", "80.00", "", "Posted", "1234", ""])!;
    expect(row.cents).toBe(-8000n);
  });
});

describe("the registry", () => {
  it("ships only formats whose evidence is real, and never a synthetic one", () => {
    // This assertion used to be `PRODUCTION_ADAPTERS` is empty, which was the
    // gate that kept an unverified format from shipping while none existed.
    // Three now do, so the gate becomes its opposite: everything here must
    // claim verified evidence, and nothing fabricated may appear. The formats
    // themselves are measured against real export shapes in
    // `import-adapters-production.test.ts`.
    expect(SYNTHETIC_ADAPTERS.every(a => a.evidence === "synthetic_only")).toBe(true);
    expect(PRODUCTION_ADAPTERS.length).toBeGreaterThan(0);
    expect(PRODUCTION_ADAPTERS.every(a => a.evidence === "verified")).toBe(true);
    const synthetic = new Set(SYNTHETIC_ADAPTERS.map(a => a.id));
    expect(PRODUCTION_ADAPTERS.some(a => synthetic.has(a.id))).toBe(false);
  });

  it("summarizes a format without leaking its column policy", () => {
    expect(summarizeFormat(SYNTHETIC_CHECKING)).toEqual({
      id: "synthetic-canonical-checking",
      version: 1,
      label: "Synthetic canonical CSV (checking)",
      providerKey: "other",
      accountKind: "checking",
      evidence: "synthetic_only",
      limits: { maxFileBytes: 10485760, maxRows: 25000, maxColumns: 100, maxFieldBytes: 16384 },
    });
  });

  it("looks formats up by id and reports an unknown one as absent", () => {
    const registry = createAdapterRegistry(SYNTHETIC_ADAPTERS);
    expect(registry.get("synthetic-status-card")).toBe(SYNTHETIC_STATUS_CARD);
    expect(registry.get("chase-checking")).toBeUndefined();
    expect(registry.list().map(f => f.id))
      .toEqual(["synthetic-canonical-checking", "synthetic-status-card", "synthetic-identified-checking"]);
  });

  it("reads a declared bank identifier and nothing else as one", () => {
    const columns = matchHeader(SYNTHETIC_IDENTIFIED_CHECKING, ["Reference", "Date", "Description", "Amount"]);
    const read = (fields: string[]) =>
      normalizeRow(SYNTHETIC_IDENTIFIED_CHECKING, columns, fields, 1);
    expect(read(["REF-001", "2026-05-01", "SYNTHETIC MARKET", "-45.99"])?.identity)
      .toEqual({ namespace: "synthetic_identified", bankTransactionId: "REF-001" });
    // A blank or absurd value is simply no identifier, not an invented one.
    expect(read(["", "2026-05-01", "SYNTHETIC MARKET", "-45.99"])?.identity).toBeNull();
    expect(read(["x".repeat(256), "2026-05-01", "SYNTHETIC MARKET", "-45.99"])?.identity).toBeNull();
    // And a format that declares none never produces one.
    expect(SYNTHETIC_CHECKING.identity).toBeNull();
  });

  it("refuses two formats sharing an id", () => {
    expect(() => createAdapterRegistry([SYNTHETIC_CHECKING, { ...SYNTHETIC_CHECKING, version: 2 }]))
      .toThrow(/duplicate import format id/);
  });

  it("declares ids the contract's pattern accepts", () => {
    for (const adapter of SYNTHETIC_ADAPTERS) expect(adapter.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });
});

describe("reading a whole synthetic file", () => {
  const read = async (text: string, adapter: ImportAdapter): Promise<AdapterRow[]> => {
    const rows: AdapterRow[] = [];
    let columns: ColumnIndex | null = null;
    await readImportCsv((async function* () { yield new TextEncoder().encode(text); })(), (fields, recordNumber) => {
      if (recordNumber === 1) {
        columns = matchHeader(adapter, fields);
        return;
      }
      const row = normalizeRow(adapter, columns!, fields, recordNumber - 1);
      if (row !== null) rows.push(row);
    });
    return rows;
  };

  it("numbers data rows from one, past a skipped blank line, with CRLF and a mark", async () => {
    const rows = await read(
      "﻿Post Date,Description,Debit,Credit,Status,Account Number\r\n"
      + "2026-04-05,SYNTHETIC HARDWARE,80.00,,Posted,4111111111111234\r\n"
      + "\r\n"
      + "2026-04-18,\"SYNTHETIC GROCER, INC\",40.00,,Posted,4111111111111234\r\n"
      + "2026-04-21,\"SYNTHETIC PAYMENT\nTHANK YOU\",,80.00,Posted,4111111111111234\r\n",
      SYNTHETIC_STATUS_CARD,
    );
    expect(rows.map(r => [r.rowNumber, r.merchant, r.cents])).toEqual([
      [1, "SYNTHETIC HARDWARE", -8000n],
      // The blank third line kept its number, so row 3 still points at line 4.
      [3, "SYNTHETIC GROCER, INC", -4000n],
      [4, "SYNTHETIC PAYMENT THANK YOU", 8000n],
    ]);
  });

  it("fails the file, not a row, when the header is not the selected format", async () => {
    await expect(read("Date,Memo,Amount\n05/01/2026,M,-1.00\n", SYNTHETIC_CHECKING))
      .rejects.toThrow(ImportFormatError);
  });

  it("surfaces a pending row as a whole-file refusal", async () => {
    await expect(read(
      "Post Date,Description,Debit,Credit,Status,Account Number\n"
      + "2026-04-05,SYNTHETIC HARDWARE,80.00,,Posted,1234\n"
      + "2026-04-06,SYNTHETIC PENDING,10.00,,Pending,1234\n",
      SYNTHETIC_STATUS_CARD,
    )).rejects.toMatchObject({ code: "pending_records_unsupported" });
  });
});
