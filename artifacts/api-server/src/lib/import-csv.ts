import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate } from "node:timers/promises";
import { CsvError, parse } from "csv-parse";

export const IMPORT_CSV_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 25000,
  maxColumns: 100,
  maxFieldBytes: 16384,
});

type CsvFailureCode = "unsupported_encoding" | "malformed_csv" | "limit_exceeded" | "unreadable_file";

export class ImportCsvError extends Error {
  constructor(readonly code: CsvFailureCode) {
    // Parser errors can contain bank fields. Neither message nor cause retains them.
    super({ unsupported_encoding: "Use a UTF-8 CSV file.", malformed_csv: "The CSV structure could not be read.",
      limit_exceeded: "The CSV exceeds an import limit.", unreadable_file: "The CSV could not be read." }[code]);
    this.name = "ImportCsvError";
  }
}

async function* decode(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > IMPORT_CSV_LIMITS.maxFileBytes) throw new ImportCsvError("limit_exceeded");
    for (let offset = 0; offset < chunk.byteLength; offset += 16384) {
      let text: string;
      try { text = decoder.decode(chunk.subarray(offset, offset + 16384), { stream: true }); }
      catch { throw new ImportCsvError("unsupported_encoding"); }
      yield text;
      await setImmediate();
    }
  }
  try { yield decoder.decode(); }
  catch { throw new ImportCsvError("unsupported_encoding"); }
}

/** Emits the header as record 1; adapters validate its exact shape. No preamble guessing. */
export async function readImportCsv(
  source: AsyncIterable<Uint8Array>,
  onRecord: (fields: readonly string[], recordNumber: number) => void | Promise<void>,
): Promise<void> {
  let records = 0;
  let consumerFailed = false;
  let consumerError: unknown;
  const parser = parse({
    bom: false,
    cast: (value, context) => {
      if (typeof context.column !== "number" || context.column >= IMPORT_CSV_LIMITS.maxColumns
        || Buffer.byteLength(value, "utf8") > IMPORT_CSV_LIMITS.maxFieldBytes) {
        throw new ImportCsvError("limit_exceeded");
      }
      return value;
    },
    max_record_size: IMPORT_CSV_LIMITS.maxColumns * IMPORT_CSV_LIMITS.maxFieldBytes,
    // Envelope variations belong to verified adapters, not the CSV grammar.
    relax_column_count: true,
    on_record: (fields: string[]) => {
      records += 1;
      if (records > IMPORT_CSV_LIMITS.maxRows + 1) throw new ImportCsvError("limit_exceeded");
      return fields;
    },
  });
  try {
    await pipeline(Readable.from(decode(source)), parser, async rows => {
      let recordNumber = 0;
      for await (const fields of rows) {
        recordNumber += 1;
        try { await onRecord(fields as string[], recordNumber); }
        catch (error) { consumerFailed = true; consumerError = error; throw error; }
      }
    });
    if (records === 0) throw new ImportCsvError("unreadable_file");
  } catch (error) {
    if (consumerFailed) throw consumerError;
    if (error instanceof ImportCsvError) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "CSV_MAX_RECORD_SIZE") throw new ImportCsvError("limit_exceeded");
    if (error instanceof CsvError) throw new ImportCsvError("malformed_csv");
    throw new ImportCsvError("unreadable_file");
  }
}
