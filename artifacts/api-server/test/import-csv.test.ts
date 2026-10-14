import { describe, expect, it } from "vitest";
import { IMPORT_CSV_LIMITS, ImportCsvError, readImportCsv } from "../src/lib/import-csv.js";

async function* chunks(text: string | Uint8Array, size = 1024): AsyncGenerator<Uint8Array> {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function collect(text: string | Uint8Array, size?: number) {
  const records: Array<{ fields: readonly string[]; number: number }> = [];
  await readImportCsv(chunks(text, size), (fields, number) => { records.push({ fields, number }); });
  return records;
}

describe("bounded streaming CSV reader", () => {
  it("preserves strings, escaped quotes and embedded newlines across byte boundaries", async () => {
    expect(await collect('Date,Description,Amount\r\n2026-09-01,"Cafe, ""Example""\nShop",-1.20\r\n', 1)).toEqual([
      { fields: ["Date", "Description", "Amount"], number: 1 },
      { fields: ["2026-09-01", 'Cafe, "Example"\nShop', "-1.20"], number: 2 },
    ]);
  });

  it("accepts a BOM and split UTF-8 sequences without altering text", async () => {
    expect(await collect('\uFEFFDescription\nCaf\u00e9\n', 1)).toEqual([
      { fields: ["Description"], number: 1 }, { fields: ["Caf\u00e9"], number: 2 },
    ]);
  });

  it.each([new Uint8Array([0xff]), new Uint8Array([0xc3]), new Uint8Array([0xc3, 0x28]),
    new Uint8Array([0xff, 0xfe, 0x61, 0])])("rejects invalid UTF-8 %#", async bytes => {
    await expect(collect(bytes, 1)).rejects.toMatchObject({ code: "unsupported_encoding" });
  });

  it.each(['Header\n"unterminated', 'Header\n"secret"junk', 'Header\nse"cret'])
    ("rejects malformed quotes without retaining source details %#", async text => {
      let failure: unknown;
      try { await collect(text); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ImportCsvError);
      expect(failure).toMatchObject({ code: "malformed_csv" });
      expect(String(failure)).not.toContain("secret");
      expect(failure).not.toHaveProperty("cause");
    });

  it("does not silently fix ragged rows or skip blanks before adapter validation", async () => {
    expect((await collect("A,B\n1,2,\n\n")).map(row => row.fields)).toEqual([["A", "B"], ["1", "2", ""], [""]]);
  });

  it("rejects empty files", async () => {
    await expect(collect("")).rejects.toMatchObject({ code: "unreadable_file" });
  });

  it("enforces field limits in bytes, not characters", async () => {
    const maximum = "\u00e9".repeat(8192);
    expect((await collect(`Header\n${maximum}`))[1]!.fields[0]).toBe(maximum);
    await expect(collect(`Header\n${maximum}x`)).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("bounds an unterminated field before the file limit", async () => {
    await expect(collect('Header\n"' + "x".repeat(IMPORT_CSV_LIMITS.maxColumns * IMPORT_CSV_LIMITS.maxFieldBytes + 2)))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("accepts 100 columns and refuses the next field including empty ones", async () => {
    expect((await collect(Array(100).fill("x").join(",")))[0]!.fields).toHaveLength(100);
    await expect(collect(",".repeat(100))).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("accepts 25000 data rows plus a header and rejects the next row", async () => {
    let count = 0;
    await readImportCsv(chunks("Header\n" + "x\n".repeat(25000)), () => { count += 1; });
    expect(count).toBe(25001);
    await expect(readImportCsv(chunks("Header\n" + "x\n".repeat(25001)), () => {}))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects an oversized source chunk before parsing it", async () => {
    await expect(collect(new Uint8Array(IMPORT_CSV_LIMITS.maxFileBytes + 1), IMPORT_CSV_LIMITS.maxFileBytes + 1))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("counts total bytes across chunks", async () => {
    const row = "x".repeat(16383) + "\n";
    await expect(readImportCsv(chunks(row.repeat(641), 16384), () => {}))
      .rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("waits for the consumer and propagates consumer failures unchanged", async () => {
    const sentinel = new Error("consumer failure");
    const seen: number[] = [];
    await expect(readImportCsv(chunks("Header\na\nb\n"), async (_fields, number) => {
      await Promise.resolve();
      seen.push(number);
      if (number === 2) throw sentinel;
    })).rejects.toBe(sentinel);
    expect(seen).toEqual([1, 2]);
  });

  it("does not disclose stream errors", async () => {
    async function* broken(): AsyncGenerator<Uint8Array> { throw new Error("private-path-or-value"); }
    await expect(readImportCsv(broken(), () => {})).rejects.toEqual(new ImportCsvError("unreadable_file"));
  });
});
