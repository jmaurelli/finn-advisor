/**
 * The transaction CSV export.
 *
 * The things worth pinning are the ones a reader cannot check by eye: that the
 * file carries every matching row rather than a page, that a merchant name
 * cannot become a spreadsheet formula, that an amount keeps its sign, and that
 * an oversized export fails instead of arriving truncated.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  csvField, decimalDollars, EXPORT_COLUMNS, MAX_EXPORT_ROWS, neutralizeFormula,
} from "../src/services/exports-csv.js";
import { startTestServer, type TestServer } from "./harness.js";
import { createAccount, postTransaction, uuid } from "./finance-harness.js";

let api: TestServer;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
  await createAccount(api, { displayName: "Synthetic Checking" });
});
afterEach(async () => { await api.close(); });

const download = async (query = "") => {
  const response = await api.request(`/api/exports/transactions.csv${query}`);
  return { response, text: typeof response.text === "string" ? response.text : "" };
};

/** Parses the CSV back, so assertions are about records not about substrings. */
function records(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field); field = ""; rows.push(row); row = []; i += 1;
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(cells => Object.fromEntries(cells.map((v, i) => [header![i]!, v])));
}

describe("the file's shape", () => {
  it("has the contract's columns, in order, with CRLF records", async () => {
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02", amountMinor: "-8000" });
    const { response, text } = await download();
    expect(response.status).toBe(200);
    expect(text.split("\r\n")[0]).toBe(EXPORT_COLUMNS.join(","));
    // Every record is terminated, including the last.
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("is an attachment that must not be cached", async () => {
    const { response } = await download();
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition"))
      .toMatch(/^attachment; filename="money-desk-transactions-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("is a header row alone when nothing matches", async () => {
    const { response, text } = await download("?month=2020-01");
    expect(response.status).toBe(200);
    expect(text).toBe(`${EXPORT_COLUMNS.join(",")}\r\n`);
  });

  it("refuses a signed-out reader", async () => {
    const response = await api.request("/api/exports/transactions.csv", { omitCookie: true });
    expect(response.status).toBe(401);
  });
});

describe("what the rows say", () => {
  it("keeps each amount's sign as exact decimal dollars", async () => {
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02",
      amountMinor: "-8000", merchant: "SYNTHETIC MARKET" });
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-09",
      amountMinor: "3000", kind: "refund", merchant: "SYNTHETIC REFUND" });
    const byMerchant = new Map((records((await download()).text)).map(r => [r["merchant"]!, r]));
    expect(byMerchant.get("SYNTHETIC MARKET")!["amount"]).toBe("-80.00");
    expect(byMerchant.get("SYNTHETIC REFUND")!["amount"]).toBe("30.00");
  });

  it("resolves the account and category names, and leaves absent ones empty", async () => {
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02",
      amountMinor: "-8000", kind: "transfer", categoryId: null });
    const [row] = records((await download()).text);
    expect(row!["account_name"]).toBe("Synthetic Checking");
    expect(row!["account_id"]).toBe(uuid(1));
    // A transfer has no category, which is an empty cell and not the word null.
    expect([row!["category_id"], row!["category_name"]]).toEqual(["", ""]);
    expect([row!["transfer_pair_id"], row!["refund_link_purchase_id"]]).toEqual(["", ""]);
  });

  it("exports every matching row, not one page", async () => {
    // The list pages at 50 by default; the export must ignore that entirely.
    for (let i = 0; i < 60; i += 1) {
      postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02", amountMinor: "-100" });
    }
    expect(records((await download()).text)).toHaveLength(60);
  });

  it("applies the same filters as the list", async () => {
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02", amountMinor: "-100" });
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-05-02", amountMinor: "-200" });
    expect(records((await download("?month=2026-04")).text)).toHaveLength(1);
    expect(records((await download("?kind=refund")).text)).toHaveLength(0);
  });

  it("omits voided rows unless they are asked for, like the list", async () => {
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02",
      amountMinor: "-100", lifecycle: "void" });
    expect(records((await download()).text)).toHaveLength(0);
    const all = records((await download("?lifecycle=all")).text);
    expect(all).toHaveLength(1);
    expect(all[0]!["lifecycle"]).toBe("void");
  });
});

describe("a spreadsheet must not execute the file", () => {
  it.each([
    ["=SUM(A1:A9)", "'=SUM(A1:A9)"],
    ["+1234", "'+1234"],
    ["-SYNTHETIC", "'-SYNTHETIC"],
    ["@IMPORT", "'@IMPORT"],
    [" =LEADING SPACE", "' =LEADING SPACE"],
    ["\t=AFTER TAB", "'\t=AFTER TAB"],
    ["SYNTHETIC SHOP", "SYNTHETIC SHOP"],
    ["3M COMPANY", "3M COMPANY"],
  ])("neutralizes %j", (input, expected) => {
    expect(neutralizeFormula(input)).toBe(expected);
  });

  it("neutralizes a merchant end to end without touching the amount", async () => {
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02",
      amountMinor: "-8000", merchant: "=SYNTHETIC FORMULA SHOP" });
    const [row] = records((await download()).text);
    expect(row!["merchant"]).toBe("'=SYNTHETIC FORMULA SHOP");
    // The amount starts with `-` and must stay arithmetic: prefixing it would
    // defend against nothing and break every sum in the sheet.
    expect(row!["amount"]).toBe("-80.00");
  });

  it("quotes rather than breaks a merchant carrying commas, quotes or newlines", async () => {
    const awkward = 'PACE, PARKER AND "CO"';
    postTransaction(api.db, { accountId: uuid(1), postedDate: "2026-04-02",
      amountMinor: "-100", merchant: awkward });
    const [row] = records((await download()).text);
    expect(row!["merchant"]).toBe(awkward);
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("plain")).toBe("plain");
  });
});

describe("it fails rather than truncating", () => {
  it("refuses an export over the row limit with 413 and no body", async () => {
    // Counted before anything is written, so the refusal cannot arrive after
    // a partial file. Driven by stubbing the count rather than inserting
    // 100,001 rows.
    const real = api.db.prepare.bind(api.db);
    api.db.prepare = ((sql: string) => {
      const statement = real(sql);
      if (sql.includes("COUNT(*) AS n FROM transactions")) {
        return { ...statement, get: () => ({ n: BigInt(MAX_EXPORT_ROWS + 1) }) } as never;
      }
      return statement;
    }) as typeof api.db.prepare;
    try {
      const { response, text } = await download();
      expect(response.status).toBe(413);
      expect((response.body as { code: string }).code).toBe("payload_too_large");
      expect(text).not.toContain("posted_date,account_id");
    } finally {
      api.db.prepare = real as typeof api.db.prepare;
    }
  });

  it("rejects paging parameters the operation does not declare", async () => {
    // `cursor` and `limit` belong to the list, not here. Accepting them would
    // let an export quietly answer a narrower question than it was asked.
    for (const query of ["?limit=5", "?cursor=abc"]) {
      const { response } = await download(query);
      expect(response.status, query).toBe(400);
    }
  });

  it("rejects a malformed filter the same way the list does", async () => {
    expect((await download("?accountId=not-an-id")).response.status).toBe(400);
    expect((await download("?kind=invented")).response.status).toBe(400);
  });
});

describe("decimal formatting", () => {
  it.each([
    [-8000n, "-80.00"], [3000n, "30.00"], [-1n, "-0.01"], [1n, "0.01"],
    [-100n, "-1.00"], [99999999999n, "999999999.99"],
  ])("renders %s cents as %s", (cents, expected) => {
    expect(decimalDollars(cents)).toBe(expected);
  });
});
