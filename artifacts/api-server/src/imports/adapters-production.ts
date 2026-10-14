/**
 * The bank formats that ship.
 *
 * Each declaration below was checked against a real export held outside this
 * repository. What was read from those exports was structure and vocabulary
 * only - header text and order, field counts, line endings, date syntax, the
 * distinct values of categorical columns, and the correlation between a
 * category and the sign of its amount. No merchant, amount, balance or account
 * number was read into this repository or into any transcript. The sanitized
 * counterparts in `test/fixtures/bank-formats/` carry the same structure with
 * every value fabricated, and are what the tests measure these against.
 *
 * `evidenceNote` records the sample actually seen, including its size, because
 * a vocabulary observed in one statement is complete for that statement and
 * not for the format. Where a vocabulary could not be enumerated with
 * confidence, the declaration says nothing about it rather than guessing: an
 * unmapped word yields no kind, the amount's sign decides, and a positive
 * amount still asks the owner.
 */
import type { ImportAdapter } from "./adapters.js";

/**
 * Chase checking, "Download account activity" as CSV.
 *
 * Data rows carry one field more than the header - every line ends with a
 * trailing comma - which is why `allowTrailingEmptyColumn` is on. There is no
 * preamble above the header; the two hand-written notes beside the evidence
 * disagreed about this and the file settles it at zero.
 *
 * `Details` (CREDIT/DEBIT/DSLIP) states direction only. `Type` is the column
 * that carries kind evidence, and the owner chose it. Twelve distinct values
 * appeared across 463 rows; only the four whose meaning is unambiguous are
 * mapped. `ACH_DEBIT` and `QUICKPAY_DEBIT` are money leaving but could be a
 * purchase or a transfer out, `ACH_CREDIT` and `DEPOSIT` could be income or a
 * transfer in, and `ATM` is cash with no matching kind at all - each is
 * recorded as carrying no kind evidence, so a negative amount still defaults
 * to a purchase and a positive one is put to the owner.
 *
 * `unknown: "ignore"` because twelve values from one statement is certainly not
 * Chase's whole vocabulary. A word this list has never seen drops its evidence
 * rather than refusing the file.
 */
export const CHASE_CHECKING: ImportAdapter = {
  id: "chase-checking-activity",
  version: 1,
  label: "Chase checking activity (CSV)",
  providerKey: "chase",
  accountKind: "checking",
  evidence: "verified",
  evidenceNote:
    "Header, field counts, LF line endings, MM/DD/YYYY dates and both category "
    + "vocabularies read from a real 463-row export dated 2026-09-24. Outflow sign "
    + "confirmed by correlation: all 68 Details=CREDIT rows positive, 392 of 393 "
    + "Details=DEBIT rows negative. The single positive DEBIT row was Type=DEBIT_CARD, "
    + "consistent with a card refund; it is mapped to purchase and so reaches the owner "
    + "as a type question rather than posting as a purchase. No preamble. "
    + "'Check or Slip #' was empty in every row, so its behaviour when populated is unverified.",
  preambleLines: 0,
  header: ["Details", "Posting Date", "Description", "Amount", "Type", "Balance", "Check or Slip #"],
  allowTrailingEmptyColumn: true,
  blankRows: "fail",
  dateColumn: "Posting Date",
  dateFormat: "MM/DD/YYYY",
  merchantColumn: "Description",
  amount: { style: "signed", column: "Amount", outflow: "negative" },
  status: null,
  type: {
    column: "Type",
    words: {
      DEBIT_CARD: "purchase",
      BILLPAY: "purchase",
      CHASE_TO_PARTNERFI: "transfer",
      PARTNERFI_TO_CHASE: "transfer",
      ACH_DEBIT: null,
      ACH_CREDIT: null,
      QUICKPAY_DEBIT: null,
      MISC_DEBIT: null,
      MISC_CREDIT: null,
      DEPOSIT: null,
      LOAN_PMT: null,
      ATM: null,
    },
    unknown: "ignore",
  },
  identity: null,
  retained: [
    { column: "Details", retain: "value" },
    { column: "Posting Date", retain: "value" },
    { column: "Description", retain: "value" },
    { column: "Amount", retain: "value" },
    { column: "Type", retain: "value" },
    { column: "Balance", retain: "value" },
    { column: "Check or Slip #", retain: "value" },
  ],
};


/**
 * Chase credit card, "Download transactions" as CSV.
 *
 * `Post Date` is the posted date and `Transaction Date` the authorization
 * date, confirmed by the owner; the posted date is the one the ledger uses.
 *
 * The export seen had only **four** rows, all `Type=Sale` and all negative. A
 * sale on a card is money leaving, so outflow is negative - the same direction
 * as the checking export, which is a useful consistency check. But four rows
 * cannot show `Payment`, `Return`, `Adjustment` or `Fee`, so this declaration
 * makes **no claim at all** about Chase's card type vocabulary: `type` is null,
 * the amount's sign decides, and every positive row is put to the owner. That
 * is a deliberately weaker declaration than the checking one, and it is why
 * `Category` is retained as evidence but never read as a kind.
 */
export const CHASE_CREDIT_CARD: ImportAdapter = {
  id: "chase-credit-card-activity",
  version: 1,
  label: "Chase credit card activity (CSV)",
  providerKey: "chase",
  accountKind: "credit_card",
  evidence: "verified",
  evidenceNote:
    "Header, LF line endings and MM/DD/YYYY dates read from a real export dated "
    + "2026-09-24 that contained only 4 rows. All 4 were Type=Sale with negative amounts, "
    + "so outflow is negative. Posted-date column confirmed by the owner as 'Post Date'. "
    + "The sample is far too small to enumerate the Type or Category vocabulary, so no "
    + "type policy is declared and no kind is ever taken from the bank here. "
    + "'Memo' was empty in every row.",
  preambleLines: 0,
  header: ["Transaction Date", "Post Date", "Description", "Category", "Type", "Amount", "Memo"],
  allowTrailingEmptyColumn: false,
  blankRows: "fail",
  dateColumn: "Post Date",
  dateFormat: "MM/DD/YYYY",
  merchantColumn: "Description",
  amount: { style: "signed", column: "Amount", outflow: "negative" },
  status: null,
  type: null,
  identity: null,
  retained: [
    { column: "Transaction Date", retain: "value" },
    { column: "Post Date", retain: "value" },
    { column: "Description", retain: "value" },
    { column: "Category", retain: "value" },
    { column: "Type", retain: "value" },
    { column: "Amount", retain: "value" },
    { column: "Memo", retain: "value" },
  ],
};
