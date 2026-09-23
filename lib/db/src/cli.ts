/**
 * Migration CLI. This is the only way the schema ever changes: the API server
 * never migrates at startup.
 *
 *   pnpm --filter @workspace/db migrate --data-dir /path/to/data
 *   pnpm --filter @workspace/db migrate --data-dir /path/to/data --status
 */
import { closeLedger, openLedger } from "./open.js";
import { appliedMigrations, loadMigrations, migrate, schemaVersion } from "./migrate.js";

function argument(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index !== -1) return process.argv[index + 1];
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function main(): void {
  const dataDir = argument("data-dir");
  if (dataDir === undefined || dataDir === "") {
    console.error("Usage: migrate --data-dir <directory> [--status]");
    process.exitCode = 2;
    return;
  }

  const db = openLedger({ dataDir });
  try {
    if (process.argv.includes("--status")) {
      const applied = appliedMigrations(db);
      const available = loadMigrations();
      console.log(`schema version: ${String(schemaVersion(db))}`);
      for (const migration of available) {
        const record = applied.find((entry) => entry.id === migration.id);
        console.log(
          `  ${migration.name}: ${record === undefined ? "pending" : `applied ${new Date(record.appliedAt).toISOString()}`}`,
        );
      }
      return;
    }

    const result = migrate(db);
    if (result.appliedNow.length === 0) {
      console.log(`No pending migrations; schema version ${String(result.schemaVersion)}.`);
    } else {
      for (const name of result.appliedNow) console.log(`applied ${name}`);
      console.log(`Schema version is now ${String(result.schemaVersion)}.`);
    }
  } finally {
    closeLedger(db);
  }
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
