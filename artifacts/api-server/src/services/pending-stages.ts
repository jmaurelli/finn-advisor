/**
 * Things this build cannot do yet, declared rather than remembered.
 *
 * Two kinds of gap live here, and they fail loudly in two different ways.
 *
 * A *storage* placeholder reports zero or nothing because the table it would
 * read does not exist. `PENDING_PLACEHOLDERS` names each one next to that
 * table, and a test asserts the table is still absent; creating it fails that
 * test and names the placeholder to revisit. Stage 5's import tables arrived,
 * so every entry that was waiting on them has been replaced with a real value
 * and the list is now empty.
 *
 * An *implementation* placeholder has its storage but not its behaviour: the
 * request is refused instead of half-done. `UNIMPLEMENTED_BEHAVIOURS` names
 * each one, and a test asserts the refusal still happens. Implementing the
 * behaviour fails that test, which is the prompt to delete the entry. Posting a
 * baseline `heldRows` selection was the last one, so that list is now empty too.
 *
 * Neither kind may be satisfied by quietly ignoring a field: a request that
 * asks for work this build cannot do is refused, never reported as done.
 */

export interface PendingPlaceholder {
  /** The table whose arrival makes this placeholder wrong. */
  table: string;
  /** Where the placeholder is, and what it currently reports. */
  where: string;
  stage: string;
}

/**
 * Empty: stage 5 created the import tables, and the six counts and checks that
 * were waiting on them now read real data - open import and held row counts in
 * the month summary, imports and bank identities blocking an account deletion,
 * and retained import rows blocking a category deletion.
 */
export const PENDING_PLACEHOLDERS: PendingPlaceholder[] = [];

export interface UnimplementedBehaviour {
  /** What is asked for, and what happens instead. */
  where: string;
  /** The stage that implements it. */
  stage: string;
}

/**
 * Empty: stage 5 phase 4 implemented the last entry, posting a baseline
 * `heldRows` selection in the same transaction as the new tracking start.
 */
export const UNIMPLEMENTED_BEHAVIOURS: UnimplementedBehaviour[] = [];

/** The distinct tables that must not exist while the placeholders stand. */
export function pendingTables(): string[] {
  return [...new Set(PENDING_PLACEHOLDERS.map((entry) => entry.table))].sort();
}
