/**
 * Reports the outcome of backups the application does not perform.
 *
 * Backups are taken by a separate account on a schedule (Q14a-Q14h: a daily
 * local RAID5 repository plus an independently encrypted off-host copy). That
 * job writes a status file; this module reads it. The application never writes
 * it, never runs a backup, and never claims one happened.
 *
 * Two consequences follow from that split and are deliberate:
 *
 * - **An absent or malformed file is reported, not hidden.** `statusFile` says
 *   `missing` or `unreadable` and every destination falls to `unknown`. Today
 *   no backup job exists, so `missing` is the honest answer rather than an
 *   error, and the screen can say "no backup has reported yet" instead of
 *   failing to load.
 * - **Local success never masks an independent failure.** Both destinations are
 *   always reported, evaluated independently. There is no overall roll-up,
 *   because a green summary beside a three-day-old off-host copy is exactly
 *   the reassurance that should not be given.
 *
 * The file records timestamps and error codes; `state` is derived here, so the
 * policy question "how old is too old" lives with the application that knows
 * the schedule rather than with the shell script that writes the file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/** Where the backup account writes, beside the data directory it backs up. */
export const BACKUP_STATUS_FILENAME = "backup-status.json";

/**
 * Backups run daily, so one missed run is `stale` and not yet `failed`: the
 * window has to clear a late run plus the clock skew between two hosts without
 * calling a genuinely abandoned backup healthy. Two days does both.
 */
export const BACKUP_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export type BackupDestination = "local" | "independent";
export type BackupState = "ok" | "stale" | "failed" | "never_run" | "unknown";

/** Always both, always in this order, whatever the file contains. */
export const BACKUP_DESTINATIONS: readonly BackupDestination[] = ["local", "independent"];

const timestamp = z.string().datetime({ offset: false });

/**
 * What the backup account is expected to write. Unknown keys are rejected: a
 * file this application cannot fully account for is reported as `unreadable`
 * rather than read optimistically, because the one thing worse than no backup
 * status is a confident wrong one.
 */
const fileSchema = z.object({
  formatVersion: z.literal(1),
  destinations: z.array(z.object({
    destination: z.enum(["local", "independent"]),
    lastSuccessAt: timestamp.nullable(),
    lastAttemptAt: timestamp.nullable(),
    errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  }).strict()).max(2),
}).strict();

interface DestinationFacts {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  errorCode: string | null;
}

export interface BackupStatusResult {
  statusFile: "readable" | "missing" | "unreadable";
  readAt: string;
  destinations: {
    destination: BackupDestination;
    state: BackupState;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    errorCode: string | null;
  }[];
}

export const backupStatusPath = (dataDir: string): string =>
  path.join(dataDir, BACKUP_STATUS_FILENAME);

/**
 * `unknown` is for "this application cannot tell", which is not the same as
 * "no backup has ever run". Only the file saying so earns `never_run`.
 */
function deriveState(facts: DestinationFacts | undefined, now: number): BackupState {
  if (facts === undefined) return "unknown";
  // A recorded error outranks an old success: the last thing that happened
  // failed, and that is what the owner needs to see.
  if (facts.errorCode !== null) return "failed";
  if (facts.lastSuccessAt === null) {
    // Attempted and no success, with no error code to explain it: something
    // ran and did not finish, which is a failure however it is spelled.
    return facts.lastAttemptAt === null ? "never_run" : "failed";
  }
  const succeeded = Date.parse(facts.lastSuccessAt);
  if (Number.isNaN(succeeded)) return "unknown";
  return now - succeeded > BACKUP_STALE_AFTER_MS ? "stale" : "ok";
}

/**
 * Reads the status file and reports every destination. Never throws for a
 * missing or malformed file: that is a state to report, not a request that
 * failed. A genuine I/O fault on a file that exists is also reported as
 * `unreadable`, because the owner's question - "are my backups working" - is
 * answered the same way either way: this application cannot tell.
 */
export async function readBackupStatus(dataDir: string, now: number): Promise<BackupStatusResult> {
  const readAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  let parsed: z.infer<typeof fileSchema> | undefined;
  let statusFile: BackupStatusResult["statusFile"] = "readable";
  try {
    const text = await readFile(backupStatusPath(dataDir), "utf8");
    const result = fileSchema.safeParse(JSON.parse(text));
    if (result.success) parsed = result.data;
    else statusFile = "unreadable";
  } catch (error) {
    statusFile = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }

  const byDestination = new Map<string, DestinationFacts>(
    (parsed?.destinations ?? []).map(entry => [entry.destination, entry]),
  );
  return {
    statusFile,
    readAt,
    destinations: BACKUP_DESTINATIONS.map(destination => {
      const facts = byDestination.get(destination);
      return {
        destination,
        state: deriveState(facts, now),
        lastSuccessAt: facts?.lastSuccessAt ?? null,
        lastAttemptAt: facts?.lastAttemptAt ?? null,
        errorCode: facts?.errorCode ?? null,
      };
    }),
  };
}
