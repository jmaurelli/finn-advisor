import {
  closeLedger,
  EXPECTED_SCHEMA_VERSION,
  openLedger,
  schemaVersion,
} from "@workspace/db";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { defaultDependencies } from "./deps.js";
import { purgeExpiredSessions } from "./auth/sessions.js";
import { logger } from "./lib/logger.js";

function main(): void {
  const config = loadConfig();
  const db = openLedger({ dataDir: config.dataDir });

  // The server never migrates. If the schema is not the one this build knows,
  // it says so and refuses to serve rather than guessing.
  const version = schemaVersion(db);
  if (version !== EXPECTED_SCHEMA_VERSION) {
    closeLedger(db);
    throw new Error(
      `The database schema is version ${String(version)} but this build expects ${String(
        EXPECTED_SCHEMA_VERSION,
      )}. Run the migration command.`,
    );
  }

  const deps = defaultDependencies(db, config);
  purgeExpiredSessions(db, deps.clock.now());

  const app = createApp(deps);
  const server = app.listen(config.port, config.bindAddress, () => {
    logger.info(
      { port: config.port, address: config.bindAddress, environment: config.environment },
      "Money Desk API listening",
    );
  });

  const hourly = setInterval(
    () => {
      try {
        purgeExpiredSessions(db, deps.clock.now());
      } catch (error) {
        logger.error({ err: error }, "expired session cleanup failed");
      }
    },
    60 * 60 * 1000,
  );
  hourly.unref();

  // Stop taking new work, let what is in flight finish, then close the
  // database so the write-ahead log is checkpointed away.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    clearInterval(hourly);
    server.close(() => {
      closeLedger(db);
      process.exit(0);
    });
    setTimeout(() => {
      closeLedger(db);
      process.exit(1);
    }, 10000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  main();
} catch (error) {
  logger.error({ err: error }, "startup failed");
  process.exitCode = 1;
}
