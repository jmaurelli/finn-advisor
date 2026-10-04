/**
 * Fabricated formats, for tests and probes only.
 *
 * These describe files this project invented, so they exercise every declared
 * policy - signed and split amounts, both date syntaxes, a status column, a
 * bank type vocabulary, a masked column, ragged and blank lines - without
 * claiming anything about a real bank. They are deliberately absent from
 * `PRODUCTION_ADAPTERS`: the owner must not be able to point a real export at
 * a format whose semantics nobody verified.
 */
import type { ImportAdapter } from "./adapters.js";

/** Signed single amount column with a two-word bank type vocabulary. */
export const SYNTHETIC_CHECKING: ImportAdapter = {
  id: "synthetic-canonical-checking",
  version: 1,
  label: "Synthetic canonical CSV (checking)",
  providerKey: "other",
  accountKind: "checking",
  evidence: "synthetic_only",
  evidenceNote: "Fabricated in this repository. No real bank export was examined.",
  preambleLines: 0,
  header: ["Date", "Description", "Amount", "Type"],
  allowTrailingEmptyColumn: false,
  blankRows: "fail",
  dateColumn: "Date",
  dateFormat: "MM/DD/YYYY",
  merchantColumn: "Description",
  amount: { style: "signed", column: "Amount", outflow: "negative" },
  status: null,
  type: {
    column: "Type",
    // DEBIT states the direction; CREDIT does not say whether money arrived as
    // income, a refund or a transfer, so it carries no type evidence.
    words: { DEBIT: "purchase", CREDIT: null },
    unknown: "fail",
  },
  identity: null,
  retained: [
    { column: "Date", retain: "value" },
    { column: "Description", retain: "value" },
    { column: "Amount", retain: "value" },
    { column: "Type", retain: "value" },
  ],
};

/** Split unsigned columns, a status column, an ISO date and a masked number. */
export const SYNTHETIC_STATUS_CARD: ImportAdapter = {
  id: "synthetic-status-card",
  version: 1,
  label: "Synthetic status CSV (credit card)",
  providerKey: "other",
  accountKind: "credit_card",
  evidence: "synthetic_only",
  evidenceNote: "Fabricated in this repository. No real bank export was examined.",
  preambleLines: 0,
  header: ["Post Date", "Description", "Debit", "Credit", "Status", "Account Number"],
  allowTrailingEmptyColumn: true,
  blankRows: "skip",
  dateColumn: "Post Date",
  dateFormat: "YYYY-MM-DD",
  merchantColumn: "Description",
  amount: { style: "debit_credit", debitColumn: "Debit", creditColumn: "Credit" },
  status: { column: "Status", posted: ["Posted"], pending: ["Pending", "Authorized"] },
  type: null,
  identity: null,
  retained: [
    { column: "Post Date", retain: "value" },
    { column: "Description", retain: "value" },
    { column: "Debit", retain: "value" },
    { column: "Credit", retain: "value" },
    // The number itself is never stored, whatever the file contains.
    { column: "Account Number", retain: "last_four" },
  ],
};

/**
 * A format that declares a bank identifier, so identity matching has something
 * to exercise. The identifier column is its own; no amount, balance, check
 * number or description stands in for one.
 */
export const SYNTHETIC_IDENTIFIED_CHECKING: ImportAdapter = {
  id: "synthetic-identified-checking",
  version: 1,
  label: "Synthetic identified CSV (checking)",
  providerKey: "other",
  accountKind: "checking",
  evidence: "synthetic_only",
  evidenceNote: "Fabricated in this repository. No real bank export was examined.",
  preambleLines: 0,
  header: ["Reference", "Date", "Description", "Amount"],
  allowTrailingEmptyColumn: false,
  blankRows: "fail",
  dateColumn: "Date",
  dateFormat: "YYYY-MM-DD",
  merchantColumn: "Description",
  amount: { style: "signed", column: "Amount", outflow: "negative" },
  status: null,
  type: null,
  identity: { column: "Reference", namespace: "synthetic_identified" },
  retained: [
    { column: "Reference", retain: "value" },
    { column: "Date", retain: "value" },
    { column: "Description", retain: "value" },
    { column: "Amount", retain: "value" },
  ],
};

export const SYNTHETIC_ADAPTERS: readonly ImportAdapter[] = [
  SYNTHETIC_CHECKING, SYNTHETIC_STATUS_CARD, SYNTHETIC_IDENTIFIED_CHECKING,
];
