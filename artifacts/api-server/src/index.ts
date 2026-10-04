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
import { recoverInterruptedImports, STAGING_MAX_AGE_MS } from "./services/import-recovery.js";
import { cleanupImports } from "./services/import-retention.js";
import { logger } from "./lib/logger.js";

/** How long a request already in flight has to finish before its socket goes. */
const SHUTDOWN_GRACE_MS = 5000;
/** Last resort if the graceful close still has not completed. */
const FORCED_EXIT_MS = 10000;

async function main(): Promise<void> {
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

  // Storage and interrupted-import recovery both happen before the socket
  // opens: no request may reach an import whose bytes were never verified, and
  // no request may reach financial data while recovery is still deciding what
  // an interrupted upload amounted to.
  await deps.uploads.initialize();
  const recovered = await recoverInterruptedImports(deps);
  if (recovered.failed > 0 || recovered.reparsed > 0) {
    logger.info(recovered, "recovered interrupted imports");
  }

  const app = createApp(deps);
  const server = app.listen(config.port, config.bindAddress, () => {
    logger.info(
      { port: config.port, address: config.bindAddress, environment: config.environment },
      "Money Desk API listening",
    );
  });

  let maintenance: Promise<void> | undefined;
  const hourly = setInterval(
    () => {
      if (maintenance !== undefined) return;
      try {
        purgeExpiredSessions(db, deps.clock.now());
      } catch (error) {
        logger.error({ err: error }, "expired session cleanup failed");
      }
      // Abandoned staging bytes are this process's own litter; nothing
      // financial depends on them.
      maintenance = (async () => {
        await cleanupImports(deps);
        await deps.uploads.cleanStaging(STAGING_MAX_AGE_MS, deps.clock.now());
      })().catch(() => {
        logger.error("import cleanup will be retried");
      }).finally(() => { maintenance = undefined; });
    },
    60 * 60 * 1000,
  );
  hourly.unref();

  // Stop taking new work, let what is in flight finish, then close the
  // database so the write-ahead log is checkpointed away.
  //
  // `server.close` waits for every open connection, and a request whose body
  // is still arriving - an upload the owner was part-way through - never ends
  // on its own. Without a bound on that wait, every such shutdown fell through
  // to the forced path below: ten seconds of delay and a failure exit code for
  // what is an ordinary stop. So in-flight requests get a grace period and are
  // then closed, which lets the graceful path finish properly. An upload cut
  // off this way leaves its batch mid-receipt, and startup recovery settles it
  // from the stored bytes rather than from optimism.
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    clearInterval(hourly);
    server.close(() => {
      void (async () => {
        await maintenance;
        closeLedger(db);
        process.exit(0);
      })();
    });
    setTimeout(() => {
      logger.info("closing connections that were still in flight");
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS).unref();
    // Last resort, if even that does not let the close complete.
    setTimeout(() => {
      closeLedger(db);
      process.exit(1);
    }, FORCED_EXIT_MS).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

try {
  await main();
} catch (error) {
  logger.error({ err: error }, "startup failed");
  process.exitCode = 1;
}
