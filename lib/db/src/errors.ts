/**
 * Typed database errors. The API layer maps these onto contract problem codes;
 * nothing here ever carries SQL text, file paths or row payloads.
 */

export class DatabaseBusyError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds = 1) {
    super("The database is busy with another write");
    this.name = "DatabaseBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class DatabaseSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSetupError";
  }
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/** better-sqlite3 surfaces SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT in `code`. */
export function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}
