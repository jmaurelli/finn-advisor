/**
 * How many uploads this service will work on at once.
 *
 * The upload store bounds how many *stored* objects may exist and how many
 * receipts may be in flight, but receiving is only the first half of an
 * upload: the same request then reads its bytes back and runs the whole file
 * through a grammar and an adapter, which costs roughly six times the file in
 * heap. Nothing above the store bounded how many requests could be doing that
 * simultaneously, so a handful of concurrent maximum-size uploads could hold
 * far more memory than any single one of them was allowed.
 *
 * This is the missing bound: a slot is taken for the whole job - authorize,
 * receive, parse and publish - and released on every path out, including a
 * failure. A request that finds no slot free is refused immediately, before a
 * byte of its body is read, with the same "busy, retry" answer the store
 * already gives when it is out of room.
 *
 * Refusing rather than queueing is deliberate. A queued upload holds its
 * socket and its bytes open while it waits, which is the cost this bound
 * exists to avoid; the owner can retry in a moment instead.
 */

/** Raised instead of admitting a job when every slot is occupied. */
export class ImportBusyError extends Error {
  constructor(readonly limit: number) {
    // No request detail here: this message reaches the client.
    super("Another import is already being processed.");
    this.name = "ImportBusyError";
  }
}

export interface ImportAdmission {
  /**
   * Runs one import job while holding a slot. Throws `ImportBusyError`
   * without running the job when none is free.
   */
  run: <T>(job: () => Promise<T>) => Promise<T>;
  /** How many jobs hold a slot right now. */
  active: () => number;
  limit: () => number;
}

export interface ImportAdmissionOptions {
  /**
   * Concurrent import jobs allowed. Two, so that the deduplication race
   * between two uploads of the same file stays reachable - it is a real
   * behaviour of this endpoint - without letting parse memory multiply.
   */
  limit?: number;
}

export function createImportAdmission(options: ImportAdmissionOptions = {}): ImportAdmission {
  // `active >= NaN` is false for every value, so a non-finite limit would
  // quietly remove the bound rather than narrow it.
  const requested = options.limit ?? 2;
  const limit = Number.isFinite(requested) ? Math.max(1, Math.trunc(requested)) : 2;
  let active = 0;
  return {
    // The counter is read and raised with no await in between, so two
    // overlapping requests can never both see the same free slot.
    run: async <T>(job: () => Promise<T>): Promise<T> => {
      if (active >= limit) throw new ImportBusyError(limit);
      active += 1;
      try {
        return await job();
      } finally {
        active -= 1;
      }
    },
    active: () => active,
    limit: () => limit,
  };
}
