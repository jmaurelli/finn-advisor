import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseSetupError } from "../src/errors.js";
import { assertLocalFilesystem, parseMountinfo } from "../src/filesystem.js";
import { closeLedger, ledgerPath, openLedger } from "../src/open.js";
import { createTemporaryLedger, type TemporaryLedger } from "../src/testing.js";

let ledger: TemporaryLedger | undefined;

afterEach(() => {
  ledger?.close();
  ledger = undefined;
});

describe("connection factory", () => {
  it("opens with the pragmas the design depends on", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1n);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2n);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(250n);
  });

  it("round-trips an integer beyond double precision exactly", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;
    db.exec("CREATE TABLE amounts (cents INTEGER NOT NULL) STRICT");
    db.prepare("INSERT INTO amounts VALUES (?)").run(9007199254740993n);

    const row = db.prepare("SELECT cents FROM amounts").get() as { cents: bigint };
    expect(row.cents).toBe(9007199254740993n);
  });

  /**
   * The mutation check for safe integers: with the guard disabled the same
   * value comes back wrong, which is what the startup self-test exists to
   * catch. If this test ever passes with equality, the self-test is useless.
   */
  it("loses that integer when safe integers are switched off", () => {
    ledger = createTemporaryLedger({ migrated: false });
    const { db } = ledger;
    db.exec("CREATE TABLE amounts (cents INTEGER NOT NULL) STRICT");
    db.prepare("INSERT INTO amounts VALUES (?)").run(9007199254740993n);

    db.defaultSafeIntegers(false);
    const row = db.prepare("SELECT cents FROM amounts").get() as { cents: number };
    expect(typeof row.cents).toBe("number");
    // Compared as BigInt, because the two values are the same double.
    expect(BigInt(row.cents)).not.toBe(9007199254740993n);
    expect(BigInt(row.cents)).toBe(9007199254740992n);
    db.defaultSafeIntegers(true);
  });

  it("creates the ledger file inside the data directory", () => {
    ledger = createTemporaryLedger({ migrated: false });
    expect(existsSync(ledgerPath(ledger.dataDir))).toBe(true);
  });

  it("removes the write-ahead log when it closes cleanly", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "money-desk-wal-"));
    try {
      const db = openLedger({ dataDir });
      db.exec("CREATE TABLE t (a INTEGER) STRICT");
      db.prepare("INSERT INTO t VALUES (1)").run();
      expect(existsSync(`${ledgerPath(dataDir)}-wal`)).toBe(true);

      closeLedger(db);
      expect(existsSync(`${ledgerPath(dataDir)}-wal`)).toBe(false);
      expect(existsSync(`${ledgerPath(dataDir)}-shm`)).toBe(false);
      expect(existsSync(ledgerPath(dataDir))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("filesystem guard", () => {
  const mountinfo = [
    "25 30 0:24 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
    "41 25 0:41 / /mnt/nas rw,relatime shared:2 - nfs4 10.0.0.5:/vol rw",
    "42 25 0:42 / /mnt/drive rw,relatime shared:3 - fuse.rclone rclone rw",
    "43 25 0:43 / /mnt/with\\040space rw,relatime shared:4 - cifs //server/share rw",
  ].join("\n");

  it("parses mount points including escaped spaces", () => {
    const entries = parseMountinfo(mountinfo);
    expect(entries).toContainEqual({ mountPoint: "/mnt/with space", fstype: "cifs" });
  });

  it("accepts a local filesystem", () => {
    expect(assertLocalFilesystem("/var/lib/money-desk", writeMountinfo(mountinfo))).toBe(
      "ext4",
    );
  });

  it.each([
    ["/mnt/nas/money-desk", "nfs4"],
    ["/mnt/drive/money-desk", "fuse.rclone"],
    ["/mnt/with space/money-desk", "cifs"],
  ])("refuses %s", (path, fstype) => {
    expect(() => assertLocalFilesystem(path, writeMountinfo(mountinfo))).toThrow(
      new RegExp(`${fstype.replace(".", "\\.")} filesystem`),
    );
  });

  it("refuses when the filesystem cannot be determined", () => {
    expect(() =>
      assertLocalFilesystem("/var/lib/money-desk", "/nonexistent/mountinfo"),
    ).toThrow(DatabaseSetupError);
  });
});

function writeMountinfo(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "money-desk-mounts-"));
  const path = join(dir, "mountinfo");
  writeFileSync(path, contents);
  return path;
}
