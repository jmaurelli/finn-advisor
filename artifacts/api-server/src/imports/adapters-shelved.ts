/**
 * Verified bank formats that are not shipped.
 *
 * The owner's current scope is Chase only: the Bank of America and Campus USA
 * accounts are pre-allocated whole to a category (groceries and misc), so
 * their transactions are not imported row by row. These three declarations are
 * kept rather than deleted because the evidence behind them is expensive to
 * reproduce - it came from real statements held outside the repository, in a
 * volatile directory that may not survive - and because each is already
 * verified and tested against a sanitized fixture of its real shape.
 *
 * To ship one, add it to `PRODUCTION_ADAPTERS` in `adapters.ts` and move its
 * entry in `import-adapters-production.test.ts` from the shelved list to the
 * shipping one. Nothing else is needed; re-reading a statement is not needed.
 *
 * These are NOT synthetic. They describe real banks and carry real evidence,
 * which is why they live here and not in `adapters-synthetic.ts`.
 */
import type { ImportAdapter } from "./adapters.js";

/**
 * Campus USA Credit Union checking, exported as CSV with CRLF line endings.
 *
 * Unsigned `Debit` and `Credit` columns, exactly one filled per row - verified
 * across 61 rows, where neither "both filled" nor "neither filled" occurred
 * once. The owner confirmed `Debit` is money leaving the account, which is
 * what `debit_credit` means.
 *
 * `Status` showed only "Posted". The pending word, if this export has one, is
 * unknown, so `pending` is deliberately empty: an unlisted status refuses the
 * whole file rather than being treated as posted. That is the fail-closed side
 * of the unknown, and it is why declaring `status: null` would be worse - it
 * would silently post a pending row as settled.
 *
 * `Account Number` is retained as a last four only, whatever the file holds.
 */
export const CAMPUS_USA_CHECKING: ImportAdapter = {
  id: "campus-usa-checking",
  version: 1,
  label: "Campus USA checking (CSV)",
  providerKey: "campus_usa",
  accountKind: "checking",
  evidence: "verified",
  evidenceNote:
    "Header, CRLF line endings, MM/DD/YYYY dates and debit/credit exclusivity read "
    + "from a real 61-row export. Debit filled on 53 rows, Credit on 8, never both and "
    + "never neither; both columns unsigned. Outflow direction confirmed by the owner "
    + "('debit is leaving'). Status was 'Posted' in all 61 rows, so the pending word is "
    + "unknown and is not declared. 'Check' was empty in every row. No preamble.",
  preambleLines: 0,
  header: ["Account Number", "Post Date", "Check", "Description", "Debit", "Credit", "Status", "Balance"],
  allowTrailingEmptyColumn: false,
  blankRows: "fail",
  dateColumn: "Post Date",
  dateFormat: "MM/DD/YYYY",
  merchantColumn: "Description",
  amount: { style: "debit_credit", debitColumn: "Debit", creditColumn: "Credit" },
  status: { column: "Status", posted: ["Posted"], pending: [] },
  type: null,
  identity: null,
  retained: [
    // Never the whole number, whatever the column contains.
    { column: "Account Number", retain: "last_four" },
    { column: "Post Date", retain: "value" },
    { column: "Check", retain: "value" },
    { column: "Description", retain: "value" },
    { column: "Debit", retain: "value" },
    { column: "Credit", retain: "value" },
    { column: "Status", retain: "value" },
    { column: "Balance", retain: "value" },
  ],
};
/**
 * Bank of America checking, "Download transactions" as CSV.
 *
 * The only format so far with a **preamble**: five summary lines carrying the
 * account description and its beginning, credit, debit and ending balances,
 * then a blank separator, then the header. Those six records are skipped
 * unread - they hold account identifiers, so matching or retaining them would
 * be worse than ignoring them.
 *
 * Its first data row is a **beginning-balance marker**: a real date and a
 * description saying so, a populated running balance, and an **empty
 * `Amount`**. That row has no amount to read, so it arrives as a held row with
 * `invalid_amount` and the owner excludes it. It is not skipped, because the
 * only rule that would skip it - "empty amount" or "description mentions a
 * balance" - would also skip a genuine transaction one day, and silently
 * dropping a financial row is worse than asking about one every import.
 *
 * No status column, so no pending signal - the same gap as both Chase exports.
 */
export const BOA_CHECKING: ImportAdapter = {
  id: "bank-of-america-checking",
  version: 1,
  label: "Bank of America checking (CSV)",
  providerKey: "bank_of_america",
  accountKind: "checking",
  evidence: "verified",
  evidenceNote:
    "Header, CRLF line endings, MM/DD/YYYY dates and the six-record preamble read from a "
    + "real export the owner authorized reading directly. Of its 5 data rows, 4 carried "
    + "negative amounts and 1 was the beginning-balance marker with an empty Amount and a "
    + "populated Running Bal. Outflow confirmed negative by the owner ('debit is leaving') "
    + "and consistent with every amount in the file being negative. The sample contained no "
    + "credit, so a positive amount in this format is unexercised and will be put to the "
    + "owner as a type question. No status column and no identifier column.",
  preambleLines: 6,
  header: ["Date", "Description", "Amount", "Running Bal."],
  allowTrailingEmptyColumn: false,
  blankRows: "fail",
  dateColumn: "Date",
  dateFormat: "MM/DD/YYYY",
  merchantColumn: "Description",
  amount: { style: "signed", column: "Amount", outflow: "negative" },
  status: null,
  type: null,
  identity: null,
  retained: [
    { column: "Date", retain: "value" },
    { column: "Description", retain: "value" },
    { column: "Amount", retain: "value" },
    { column: "Running Bal.", retain: "value" },
  ],
};

/**
 * Bank of America credit card, "Download transactions" as CSV.
 *
 * `Reference Number` is the closest thing to a bank transaction identifier any
 * export in this project has produced: 23 digits, all distinct across the
 * sample, no shared prefix. **It is deliberately not declared as one.**
 *
 * An identity match sets a row's duplicate status to `confirmed`, and a
 * confirmed duplicate cannot be included - the review refuses it with 409
 * `duplicate_source_identity`, "It can only be left out". That is correct for
 * an identifier the bank guarantees unique, and it makes a genuine transaction
 * permanently unimportable with no owner override if the identifier ever
 * repeats. Five values are enough to show the column looks like an identifier
 * and nowhere near enough to earn unoverridable treatment. The decisive
 * evidence is two downloads of an overlapping date range: that would show both
 * that the number is stable across downloads and that it does not repeat.
 * Until then the column is retained as evidence and read as nothing.
 *
 * `Address` is the merchant's city and state, fixed-width padded by the bank,
 * and empty on some rows - a payment has no location. It is retained but never
 * required.
 */
export const BOA_CREDIT_CARD: ImportAdapter = {
  id: "bank-of-america-credit-card",
  version: 1,
  label: "Bank of America credit card (CSV)",
  providerKey: "bank_of_america",
  accountKind: "credit_card",
  evidence: "verified",
  evidenceNote:
    "Header, CRLF line endings and MM/DD/YYYY dates read from a real export the owner "
    + "authorized reading directly. Of its 5 rows, 4 were negative and 1 positive, "
    + "consistent with purchases negative and a payment positive, so outflow is negative. "
    + "No preamble. 'Reference Number' was 23 digits and distinct on all 5 rows but is NOT "
    + "declared as an identity: an identity match is unoverridable, and 5 rows cannot show "
    + "the value is stable across downloads or non-repeating. 'Address' was empty on 1 row. "
    + "No status column, so no pending signal.",
  preambleLines: 0,
  header: ["Posted Date", "Reference Number", "Payee", "Address", "Amount"],
  allowTrailingEmptyColumn: false,
  blankRows: "fail",
  dateColumn: "Posted Date",
  dateFormat: "MM/DD/YYYY",
  merchantColumn: "Payee",
  amount: { style: "signed", column: "Amount", outflow: "negative" },
  status: null,
  type: null,
  identity: null,
  retained: [
    { column: "Posted Date", retain: "value" },
    { column: "Reference Number", retain: "value" },
    { column: "Payee", retain: "value" },
    { column: "Address", retain: "value" },
    { column: "Amount", retain: "value" },
  ],
};

/** Everything verified but not currently shipped. */
export const SHELVED_ADAPTERS: readonly ImportAdapter[] =
  [CAMPUS_USA_CHECKING, BOA_CHECKING, BOA_CREDIT_CARD];
