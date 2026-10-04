/**
 * The shipping bank formats, measured against real export shapes.
 *
 * The fixtures in `fixtures/bank-formats/` came out of the sanitizer that
 * produced the evidence these declarations were written from: real header,
 * real column order, real delimiter and quoting, real line endings, real field
 * counts, real date syntax, real category vocabularies - and every merchant,
 * amount, balance and account number fabricated.
 *
 * So these tests prove the envelope, which is what the fixtures can prove: the
 * header matches exactly, every row of a real-shaped file normalizes, and the
 * declared policies behave. They deliberately do not assert that a particular
 * row is a purchase, because the sanitizer randomized the signs and shuffled
 * the vocabularies; the direction semantics were verified against the real
 * exports by correlation and are recorded in each `evidenceNote`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ImportFormatError, matchHeader, normalizeRow, PRODUCTION_ADAPTERS,
  type AdapterRow, type ImportAdapter,
} from "../src/imports/adapters.js";
import { CHASE_CHECKING, CHASE_CREDIT_CARD } from "../src/imports/adapters-production.js";
import {
  BOA_CHECKING, BOA_CREDIT_CARD, CAMPUS_USA_CHECKING, SHELVED_ADAPTERS,
} from "../src/imports/adapters-shelved.js";
import { SYNTHETIC_ADAPTERS } from "../src/imports/adapters-synthetic.js";
import { readImportCsv } from "../src/lib/import-csv.js";

/** What ships. */
const SHIPPING: { id: string; adapter: ImportAdapter; name: string }[] = [
  { id: CHASE_CHECKING.id, adapter: CHASE_CHECKING, name: "chase-checking/chase-checking-activity.csv" },
  { id: CHASE_CREDIT_CARD.id, adapter: CHASE_CREDIT_CARD, name: "chase-credit-card/chase-credit-card-activity.csv" },
];

/**
 * Verified but not shipped, because the owner's scope is Chase only. Still
 * measured against their fixtures: a shelved format that quietly rots is not
 * ready to be restored, and restoring one is meant to be a one-line change.
 */
const SHELVED: { id: string; adapter: ImportAdapter; name: string }[] = [
  { id: CAMPUS_USA_CHECKING.id, adapter: CAMPUS_USA_CHECKING, name: "campususa-checking/CampusUSA.csv" },
  { id: BOA_CHECKING.id, adapter: BOA_CHECKING, name: "boa-checking/boa-checking.csv" },
  { id: BOA_CREDIT_CARD.id, adapter: BOA_CREDIT_CARD, name: "boa-credit/boa-credit.csv" },
];

const FIXTURES = [...SHIPPING, ...SHELVED];

/** Fixtures whose every row is an ordinary transaction. */
const CLEAN_FIXTURES = FIXTURES.filter(f => f.id !== BOA_CHECKING.id);

const fixtureBytes = (name: string): Buffer =>
  readFileSync(new URL(`./fixtures/bank-formats/${name}`, import.meta.url));

/** Runs a whole fixture through the real CSV reader and the adapter. */
const readFixture = (adapter: ImportAdapter, name: string): Promise<AdapterRow[]> =>
  readFixtureBytes(adapter, fixtureBytes(name));

const readFixtureText = (adapter: ImportAdapter, text: string): Promise<AdapterRow[]> =>
  readFixtureBytes(adapter, Buffer.from(text, "utf8"));

/**
 * The same record handling as `parseStoredUpload`: the header is the first
 * record after the declared preamble, and row numbers count from it.
 */
async function readFixtureBytes(adapter: ImportAdapter, bytes: Buffer): Promise<AdapterRow[]> {
  const rows: AdapterRow[] = [];
  let columns: ReturnType<typeof matchHeader> | undefined;
  await readImportCsv((async function* () { yield new Uint8Array(bytes); })(),
    (fields, recordNumber) => {
      const headerRecord = adapter.preambleLines + 1;
      if (recordNumber < headerRecord) return;
      if (recordNumber === headerRecord) { columns = matchHeader(adapter, fields); return; }
      const row = normalizeRow(adapter, columns!, fields, recordNumber - headerRecord);
      if (row !== null) rows.push(row);
    });
  return rows;
}

const failureOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ImportFormatError) return error.code;
    throw error;
  }
  return "no error";
};

const columnsOf = (adapter: ImportAdapter): ReturnType<typeof matchHeader> =>
  matchHeader(adapter, adapter.header);

describe("the shipping formats", () => {
  it("are the Chase formats only, and nothing synthetic or shelved", () => {
    // The owner's scope is Chase: the Bank of America and Campus USA accounts
    // are pre-allocated whole to a category rather than imported row by row.
    expect(PRODUCTION_ADAPTERS.map(a => a.id))
      .toEqual(["chase-checking-activity", "chase-credit-card-activity"]);
    const synthetic = new Set(SYNTHETIC_ADAPTERS.map(a => a.id));
    const shelved = new Set(SHELVED_ADAPTERS.map(a => a.id));
    for (const adapter of PRODUCTION_ADAPTERS) {
      expect(synthetic.has(adapter.id), `${adapter.id} is synthetic`).toBe(false);
      expect(shelved.has(adapter.id), `${adapter.id} is shelved`).toBe(false);
    }
  });

  it("keep the shelved formats verified and ready to restore", () => {
    // Deleting them would throw away evidence taken from real statements held
    // in a volatile directory. Restoring one must stay a one-line change.
    expect(SHELVED_ADAPTERS.map(a => a.id)).toEqual(
      ["campus-usa-checking", "bank-of-america-checking", "bank-of-america-credit-card"]);
    for (const adapter of SHELVED_ADAPTERS) {
      expect(adapter.evidence, adapter.id).toBe("verified");
      expect(adapter.evidenceNote.length, adapter.id).toBeGreaterThan(80);
    }
  });

  it("each claim evidence, and none claims more than it has", () => {
    for (const adapter of [...PRODUCTION_ADAPTERS, ...SHELVED_ADAPTERS]) {
      // A shipping format that only ever saw fabricated rows would be a lie
      // the owner cannot see; this is the gate that keeps one out.
      expect(adapter.evidence, adapter.id).toBe("verified");
      expect(adapter.evidenceNote.length, adapter.id).toBeGreaterThan(80);
      // Nothing may claim a bank identifier: none of the three exports has one,
      // so duplicate detection rests on the evidence digest, not on an id.
      expect(adapter.identity, adapter.id).toBeNull();
      // Every declared column must be a real column of the declared header.
      for (const retained of adapter.retained) {
        expect(adapter.header, adapter.id).toContain(retained.column);
      }
      expect(adapter.header, adapter.id).toContain(adapter.dateColumn);
      expect(adapter.header, adapter.id).toContain(adapter.merchantColumn);
    }
  });

  it("never retain a whole account number", () => {
    // Any column whose name suggests an account or card number must be masked.
    for (const adapter of [...PRODUCTION_ADAPTERS, ...SHELVED_ADAPTERS]) {
      for (const retained of adapter.retained) {
        if (/account|card/i.test(retained.column)) {
          expect(retained.retain, `${adapter.id} ${retained.column}`).toBe("last_four");
        }
      }
    }
  });
});

describe.each(CLEAN_FIXTURES)("$id against its real export shape", ({ adapter, name }) => {
  it("matches the header exactly", async () => {
    const rows = await readFixture(adapter, name);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("reads every row without an envelope failure", async () => {
    const rows = await readFixture(adapter, name);
    expect(rows).toHaveLength(12);
    expect(rows.map(row => row.rowNumber)).toEqual([...Array(12).keys()].map(i => i + 1));
  });

  it("parses every date and merchant, and leaves no amount unreadable", async () => {
    const rows = await readFixture(adapter, name);
    for (const row of rows) {
      expect(row.issues, `row ${String(row.rowNumber)}`).not.toContain("invalid_date");
      expect(row.issues, `row ${String(row.rowNumber)}`).not.toContain("invalid_amount");
      expect(row.issues, `row ${String(row.rowNumber)}`).not.toContain("missing_merchant");
      expect(row.issues, `row ${String(row.rowNumber)}`).not.toContain("non_usd");
      expect(row.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.merchant).not.toBeNull();
      expect(row.cents).not.toBeNull();
    }
  });

  it("retains only the declared columns, and the merchant survives quoting", async () => {
    const rows = await readFixture(adapter, name);
    for (const row of rows) {
      expect(Object.keys(row.sourceFields).sort())
        .toEqual(adapter.retained.map(r => r.column).sort());
    }
    // The fixture carries a merchant with a comma and one with inner quotes;
    // both must arrive whole rather than split or stripped.
    const merchants = rows.map(row => row.merchant ?? "");
    expect(merchants.some(m => m.includes(","))).toBe(true);
    expect(merchants.some(m => m.includes('"'))).toBe(true);
  });

  it("refuses a header with a renamed column", () => {
    const renamed = [...adapter.header];
    renamed[renamed.length - 1] = "Something Else";
    expect(failureOf(() => matchHeader(adapter, renamed))).toBe("header_mismatch");
  });
});

describe.each(FIXTURES)("$id header and retention", ({ adapter, name }) => {
  it("matches its header and retains exactly the declared columns", async () => {
    const rows = await readFixture(adapter, name);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row.sourceFields).sort())
        .toEqual(adapter.retained.map(r => r.column).sort());
    }
  });

  it("refuses a header with a renamed column", () => {
    const renamed = [...adapter.header];
    renamed[renamed.length - 1] = "Something Else";
    expect(failureOf(() => matchHeader(adapter, renamed))).toBe("header_mismatch");
  });
});

describe("Bank of America checking's preamble", () => {
  it("skips the summary block and reads the header beneath it", async () => {
    const rows = await readFixture(BOA_CHECKING, "boa-checking/boa-checking.csv");
    // Six records of account summary and a blank separator, then the header,
    // then the marker row and twelve transactions.
    expect(BOA_CHECKING.preambleLines).toBe(6);
    expect(rows).toHaveLength(13);
    // Row numbering starts at the first record after the header, so a row still
    // points at the same physical line of the file.
    expect(rows.map(row => row.rowNumber)).toEqual([...Array(13).keys()].map(i => i + 1));
  });

  it("retains nothing from the preamble, which carries the account summary", async () => {
    const rows = await readFixture(BOA_CHECKING, "boa-checking/boa-checking.csv");
    for (const row of rows) {
      expect(Object.keys(row.sourceFields)).toEqual(
        expect.arrayContaining(["Date", "Description", "Amount", "Running Bal."]));
      expect(Object.keys(row.sourceFields)).toHaveLength(4);
    }
  });

  it("holds the beginning-balance marker rather than dropping it", async () => {
    const rows = await readFixture(BOA_CHECKING, "boa-checking/boa-checking.csv");
    const marker = rows[0]!;
    // The marker has no amount to read. Silently skipping a financial row is
    // worse than asking about one, so it arrives as a problem for the owner.
    expect(marker.cents).toBeNull();
    expect(marker.issues).toContain("invalid_amount");
    expect(marker.postedDate).not.toBeNull();
    // Every other row is an ordinary transaction.
    for (const row of rows.slice(1)) {
      expect(row.cents, `row ${String(row.rowNumber)}`).not.toBeNull();
      expect(row.issues, `row ${String(row.rowNumber)}`).not.toContain("invalid_amount");
    }
  });

  it("fails the file when the preamble is missing, rather than reading a row as the header", async () => {
    // Without its summary block the first record is the header, which is not
    // what the declaration says record seven is: the file is not this format.
    const whole = fixtureBytes("boa-checking/boa-checking.csv").toString("utf8");
    const withoutPreamble = whole.split("\r\n").slice(6).join("\r\n");
    await expect(readFixtureText(BOA_CHECKING, withoutPreamble)).rejects.toThrow();
  });
});

describe("Bank of America credit card", () => {
  const columns = (): ReturnType<typeof matchHeader> => columnsOf(BOA_CREDIT_CARD);
  const row = (fields: readonly string[]): AdapterRow | null =>
    normalizeRow(BOA_CREDIT_CARD, columns(), fields, 1);
  const base = ["03/02/2026", "74512345678901234567890", "SYNTH GROCERY", "SYNTH CITY    FL", "-42.50"];

  it("reads a purchase as money out and a payment as money in", () => {
    expect(row(base)?.cents).toBe(-4250n);
    expect(row(base.map((v, i) => (i === 4 ? "250.00" : v)))?.cents).toBe(25000n);
  });

  it("does not treat the reference number as a bank identity", () => {
    // An identity match is unoverridable: a confirmed duplicate can only be
    // left out. 5 sample values cannot earn that, so the column is evidence
    // only. Declaring it would need two overlapping downloads to compare.
    expect(BOA_CREDIT_CARD.identity).toBeNull();
    expect(row(base)?.identity).toBeNull();
    // It is still kept, so the evidence is there when that comparison happens.
    expect(row(base)?.sourceFields["Reference Number"]).toBe("74512345678901234567890");
  });

  it("accepts a row whose address is empty, because a payment has no location", () => {
    const payment = base.map((v, i) => (i === 3 ? "" : i === 4 ? "250.00" : v));
    // The amount still reads, the merchant still reads, and nothing complains
    // about the location. The positive amount asks for a type, as it should.
    expect(row(payment)?.cents).toBe(25000n);
    expect(row(payment)?.merchant).not.toBeNull();
    expect(row(payment)?.issues).toEqual(["choose_type"]);
  });

  it("takes no kind from the bank, so a credit asks the owner", () => {
    const credit = row(base.map((v, i) => (i === 4 ? "250.00" : v)));
    expect([credit?.kind, credit?.kindSource]).toEqual([null, null]);
    expect(credit?.issues).toContain("choose_type");
  });
});

describe("Chase checking's envelope", () => {
  const columns = (): ReturnType<typeof matchHeader> => columnsOf(CHASE_CHECKING);
  const row = (fields: readonly string[]): AdapterRow | null =>
    normalizeRow(CHASE_CHECKING, columns(), fields, 1);

  it("tolerates the trailing comma every data row carries", () => {
    // The real export's rows have one field more than its header. Without
    // allowTrailingEmptyColumn every row of every Chase file is malformed.
    const withTrailing = ["DEBIT", "03/02/2026", "COFFEE", "-4.25", "DEBIT_CARD", "100.00", "", ""];
    expect(row(withTrailing)?.cents).toBe(-425n);
    expect(withTrailing).toHaveLength(CHASE_CHECKING.header.length + 1);
  });

  it("still refuses a row that is short, or long by more than the trailing field", () => {
    expect(failureOf(() => row(["DEBIT", "03/02/2026", "COFFEE", "-4.25", "DEBIT_CARD", "100.00"])))
      .toBe("malformed_csv");
    expect(failureOf(() => row(
      ["DEBIT", "03/02/2026", "COFFEE", "-4.25", "DEBIT_CARD", "100.00", "", "", ""])))
      .toBe("malformed_csv");
  });

  it("reads a debit as money out and a credit as money in", () => {
    expect(row(["DEBIT", "03/02/2026", "COFFEE", "-4.25", "DEBIT_CARD", "0", ""])?.cents).toBe(-425n);
    expect(row(["CREDIT", "03/02/2026", "PAYROLL", "1200.00", "ACH_CREDIT", "0", ""])?.cents).toBe(120000n);
  });

  it("takes a kind from the bank only where the word means one", () => {
    const card = row(["DEBIT", "03/02/2026", "COFFEE", "-4.25", "DEBIT_CARD", "0", ""]);
    expect([card?.kind, card?.kindSource]).toEqual(["purchase", "bank"]);
    const out = row(["DEBIT", "03/02/2026", "TRANSFER OUT", "-50.00", "CHASE_TO_PARTNERFI", "0", ""]);
    expect([out?.kind, out?.kindSource]).toEqual(["transfer", "bank"]);
    // Money leaving by ACH could be a purchase or a transfer out, so the word
    // carries no kind and the sign decides.
    const ach = row(["DEBIT", "03/02/2026", "UTILITY", "-80.00", "ACH_DEBIT", "0", ""]);
    expect([ach?.kind, ach?.kindSource]).toEqual(["purchase", "default"]);
    // Money arriving could be income or a transfer in: the owner is asked.
    const credit = row(["CREDIT", "03/02/2026", "UNKNOWN IN", "80.00", "ACH_CREDIT", "0", ""]);
    expect([credit?.kind, credit?.kindSource]).toEqual([null, null]);
    expect(credit?.issues).toContain("choose_type");
  });

  it("asks about the card refund shape instead of posting it as a purchase", () => {
    // The real export had exactly one positive Details=DEBIT row, Type=DEBIT_CARD.
    // DEBIT_CARD maps to purchase, which a positive amount contradicts, so the
    // row reaches the owner rather than being posted the wrong way round.
    const refund = row(["DEBIT", "03/02/2026", "STORE REFUND", "12.99", "DEBIT_CARD", "0", ""]);
    expect(refund?.kind).toBeNull();
    expect(refund?.issues).toContain("choose_type");
  });

  it("drops the evidence of a word it has never seen rather than refusing the file", () => {
    const unseen = row(["DEBIT", "03/02/2026", "WIRE", "-500.00", "WIRE_OUTGOING", "0", ""]);
    expect([unseen?.kind, unseen?.kindSource]).toEqual(["purchase", "default"]);
  });
});

describe("Campus USA's envelope", () => {
  const columns = (): ReturnType<typeof matchHeader> => columnsOf(CAMPUS_USA_CHECKING);
  const row = (fields: readonly string[]): AdapterRow | null =>
    normalizeRow(CAMPUS_USA_CHECKING, columns(), fields, 1);
  const base = ["1234567890", "03/02/2026", "", "GROCERY", "", "", "Posted", "500.00"];
  const withAmounts = (debit: string, credit: string): string[] =>
    base.map((v, i) => (i === 4 ? debit : i === 5 ? credit : v));

  it("treats the debit column as money leaving and the credit column as money arriving", () => {
    expect(row(withAmounts("42.50", ""))?.cents).toBe(-4250n);
    expect(row(withAmounts("", "42.50"))?.cents).toBe(4250n);
  });

  it("will not invent a subtraction when both or neither column is filled", () => {
    expect(row(withAmounts("42.50", "10.00"))?.issues).toContain("invalid_amount");
    expect(row(withAmounts("", ""))?.issues).toContain("invalid_amount");
  });

  it("refuses a sign inside the unsigned columns", () => {
    expect(row(withAmounts("-42.50", ""))?.issues).toContain("invalid_amount");
  });

  it("keeps only the last four of the account number", () => {
    expect(row(withAmounts("42.50", ""))?.sourceFields["Account Number"]).toBe("7890");
  });

  it("refuses the whole file on any status it has not verified", () => {
    // The pending word is unknown, so an unlisted status must fail closed
    // rather than be posted as settled.
    for (const status of ["Pending", "Authorized", "posted", ""]) {
      const fields = base.map((v, i) => (i === 4 ? "42.50" : i === 6 ? status : v));
      expect(failureOf(() => row(fields)), status).toBe("header_mismatch");
    }
  });
});

describe("Chase credit card's envelope", () => {
  const columns = (): ReturnType<typeof matchHeader> => columnsOf(CHASE_CREDIT_CARD);
  const row = (fields: readonly string[]): AdapterRow | null =>
    normalizeRow(CHASE_CREDIT_CARD, columns(), fields, 1);

  it("uses the posted date, not the transaction date", () => {
    expect(row(["03/02/2026", "03/05/2026", "COFFEE", "Food & Drink", "Sale", "-4.25", ""])?.postedDate)
      .toBe("2026-03-05");
  });

  it("reads a sale as money out", () => {
    expect(row(["03/02/2026", "03/02/2026", "COFFEE", "Food & Drink", "Sale", "-4.25", ""])?.cents)
      .toBe(-425n);
  });

  it("takes no kind from the bank at all, whatever the type word says", () => {
    // Four rows cannot enumerate Chase's card vocabulary, so this format
    // declares no type policy: the sign decides and a credit asks the owner.
    const sale = row(["03/02/2026", "03/02/2026", "COFFEE", "Food & Drink", "Sale", "-4.25", ""]);
    expect([sale?.kind, sale?.kindSource]).toEqual(["purchase", "default"]);
    for (const word of ["Payment", "Return", "Adjustment", "Fee", "Anything"]) {
      const credit = row(["03/02/2026", "03/02/2026", "X", "Food & Drink", word, "25.00", ""]);
      expect([credit?.kind, credit?.kindSource], word).toEqual([null, null]);
      expect(credit?.issues, word).toContain("choose_type");
    }
  });
});
