import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseBusyError } from "../src/errors.js";
import { ledgerPath } from "../src/open.js";
import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";
import { withWriteTransaction } from "../src/transaction.js";

let ledger: TemporaryLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

describe("withWriteTransaction", () => {
  it("commits on success", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;

    withWriteTransaction(db, () => {
      db.prepare("UPDATE preferences SET density = 'compact', version = 2 WHERE id = 1").run();
    });

    const row = db.prepare("SELECT density FROM preferences WHERE id = 1").get() as {
      density: string;
    };
    expect(row.density).toBe("compact");
  });

  it("discards every write when the callback throws", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;

    expect(() =>
      withWriteTransaction(db, () => {
        db.prepare("UPDATE preferences SET density = 'compact' WHERE id = 1").run();
        throw new Error("deliberate failure");
      }),
    ).toThrow("deliberate failure");

    const row = db.prepare("SELECT density FROM preferences WHERE id = 1").get() as {
      density: string;
    };
    expect(row.density).toBe("standard");
    expect(db.inTransaction).toBe(false);
  });

  /**
   * SQLite keeps the transaction open after a constraint error, so an earlier
   * write in the same transaction would still commit without the explicit
   * rollback. This pins that behavior down.
   */
  it("discards the earlier write when a later statement violates a constraint", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;

    expect(() =>
      withWriteTransaction(db, () => {
        db.prepare("UPDATE preferences SET display_name = 'Renamed' WHERE id = 1").run();
        db.prepare("UPDATE preferences SET density = 'invalid' WHERE id = 1").run();
      }),
    ).toThrow(/CHECK constraint failed/);

    const row = db.prepare("SELECT display_name FROM preferences WHERE id = 1").get() as {
      display_name: string;
    };
    expect(row.display_name).toBe("Personal space");
  });

  it("rejects an async callback and leaves no open transaction", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;

    expect(() =>
      withWriteTransaction(db, () => Promise.resolve("nope")),
    ).toThrow(/synchronous callback/);
    expect(db.inTransaction).toBe(false);
  });

  it("refuses to nest", () => {
    ledger = createTemporaryLedger();
    const { db } = ledger;

    expect(() =>
      withWriteTransaction(db, () => {
        withWriteTransaction(db, () => undefined);
      }),
    ).toThrow(/already open/);
  });

  it("reports a typed busy error while another process holds the write lock", () => {
    ledger = createTemporaryLedger({ busyTimeoutMs: 250 });
    const { db, dataDir } = ledger;

    const holder = holdWriteLock(ledgerPath(dataDir), 3000);
    try {
      waitFor(() => holder.hasLock());
      const started = Date.now();
      let caught: unknown;
      try {
        withWriteTransaction(db, () => {
          db.prepare("UPDATE preferences SET density = 'compact' WHERE id = 1").run();
        });
      } catch (error) {
        caught = error;
      }
      const elapsed = Date.now() - started;

      expect(caught).toBeInstanceOf(DatabaseBusyError);
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(2500);
    } finally {
      holder.stop();
    }
  });
});

/**
 * A second OS process, not a second connection: the single-writer guarantee
 * this design relies on is a cross-process one.
 */
function holdWriteLock(file: string, milliseconds: number) {
  const driver = createRequire(import.meta.url).resolve("better-sqlite3");
  const flagFile = `${file}.locked`;
  const script = `
    const Database = require(${JSON.stringify(driver)});
    const fs = require("node:fs");
    const db = new Database(${JSON.stringify(file)});
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    db.prepare("UPDATE preferences SET version = version WHERE id = 1").run();
    fs.writeFileSync(${JSON.stringify(flagFile)}, "held");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, ${String(milliseconds)});
  `;
  const proc = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  return {
    hasLock: () => existsSync(flagFile),
    stop: () => {
      proc.kill("SIGKILL");
      rmSync(flagFile, { force: true });
    },
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the lock holder");
    sleepSync(25);
  }
}

/** The test body must stay synchronous to hold the connection in one tick. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
