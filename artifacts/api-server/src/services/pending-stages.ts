/**
 * Things this stage cannot compute yet, and the table that will make each of
 * them computable.
 *
 * Accounts, transactions, rules, budgets, links and reconciliation have storage. Imports
 * do not, so a handful of counts and checks have no
 * data to work from and report zero or nothing. That is honest today and
 * wrong the moment the missing tables arrive.
 *
 * Rather than trust anyone to remember, each placeholder is declared here next
 * to the table that supersedes it, and a test asserts those tables do not yet
 * exist. When a later stage creates one, that test fails and names the
 * placeholder to revisit. The omission is structural, not a note in a
 * document.
 */

export interface PendingPlaceholder {
  /** The table whose arrival makes this placeholder wrong. */
  table: string;
  /** Where the placeholder is, and what it currently reports. */
  where: string;
  stage: string;
}

export const PENDING_PLACEHOLDERS: PendingPlaceholder[] = [
  {
    table: "import_batches",
    where: "summary review counts: openImportCount reports 0",
    stage: "5 (durable imports)",
  },
  {
    table: "import_rows",
    where: "summary review counts: heldImportRowCount reports 0",
    stage: "5 (durable imports)",
  },
  {
    table: "import_batches",
    where: "account deletion: the import blocking reference is not checked",
    stage: "5 (durable imports)",
  },
  {
    table: "import_rows",
    where: "category deletion: retained import-row category references await stage 5",
    stage: "5 (durable imports)",
  },
  {
    table: "source_identities",
    where: "account deletion: the source identity blocking reference is not checked",
    stage: "5 (durable imports)",
  },
  {
    table: "import_batches",
    where: "baseline extend_backward: heldRows is refused because no preview can exist",
    stage: "5 (durable imports)",
  },
];

/** The distinct tables that must not exist while the placeholders stand. */
export function pendingTables(): string[] {
  return [...new Set(PENDING_PLACEHOLDERS.map((entry) => entry.table))].sort();
}
