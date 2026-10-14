# Bank format evidence (sanitized)

Real export **shapes**, fabricated export **values**. These are the files an
import adapter's tests measure a declaration against.

## File names

Deliberately neutral. Chase names its own download `ChaseNNNN_Activity_YYYYMMDD.csv`,
where `NNNN` is the account's last four digits; the fixtures drop that so no
fragment of a real account number lives in the repository. The bank's naming
pattern is recorded here instead, which is the part worth keeping.

## Provenance

Produced on 2026-09-24 by `sanitize-bank-export.py` from real statements held
outside the repository. Copied here on 2026-10-01 from
`/var/tmp/bank-format-evidence/`, which is volatile; these copies are the
durable record. Checksums matched at the time of copying, and each file was
confirmed to differ from the raw statement it came from.

**No real merchant, amount, balance, account number or name is in these files.**
Every data row was generated. What survives from the real export is structure:
the header row and its column order, the delimiter and quoting style, the line
endings, the field count per row, the date syntax, and — for columns the
sanitizer classified as vocabularies — the set of distinct code values.

## What is evidence and what is not

**Trustworthy:** the header, column order, date syntax, line endings, the
trailing-field count, and the preserved vocabularies. The sanitizer emits
vocabulary values by cycling (`codes[row % len(codes)]`), so with twelve rows
every distinct value the real file contained appears at least once — the sets
below are complete *for the statement they came from*, though a statement with
no refunds cannot show a refund code.

**Not trustworthy, do not infer from the rows:** the sign of any amount, which
of the debit/credit columns a given row used, which category or type goes with
which merchant, and anything in a column the sanitizer filled with invented
text. Amount signs in particular are random here. The real sign convention has
to come from the owner or the bank's documentation, and getting it wrong
imports every row backwards without erroring.

## The three files

| Directory | Header | Rows | Endings |
| --- | --- | --- | --- |
| `chase-checking/` | `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #` (7) | 8 fields — one trailing empty | LF |
| `campususa-checking/` | `Account Number,Post Date,Check,Description,Debit,Credit,Status,Balance` (8) | 8 fields | CRLF |
| `chase-credit-card/` | `Transaction Date,Post Date,Description,Category,Type,Amount,Memo` (7) | 7 fields | LF |

Preserved vocabularies: `chase-checking` `Details` = CREDIT, DEBIT, DSLIP;
`campususa-checking` `Status` = Posted; `chase-credit-card` `Type` = Sale,
`Category` = Bills & Utilities, Shopping.

`chase-checking`'s `Type` column was **not** preserved — the sanitizer filled it
with truncated invented merchant text, so that vocabulary is still unknown. Do
not read the values in that column as anything.

Bank of America checking and credit card have raw statements but no sanitized
output yet, so neither can be declared.
