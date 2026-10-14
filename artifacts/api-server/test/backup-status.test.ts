/**
 * The backup readout, which reports work the application does not do.
 *
 * The cases that matter are the unhappy ones: no file, a corrupt file, and a
 * local copy that is fine while the off-host copy is not. A readout that only
 * works when backups are healthy would be worthless precisely when it is
 * needed.
 */
import { writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GetBackupStatusResponse } from "@workspace/api-zod";
import {
  BACKUP_STALE_AFTER_MS, backupStatusPath, readBackupStatus,
} from "../src/services/backup-status.js";
import { startTestServer, type TestServer } from "./harness.js";

const NOW = Date.parse("2026-05-02T12:00:00Z");
const iso = (at: number): string => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");

let api: TestServer;
beforeEach(async () => {
  api = await startTestServer();
  await api.login();
});
afterEach(async () => { await api.close(); });

/** Writes a status file beside the running server's data directory. */
async function writeStatus(body: unknown): Promise<void> {
  const target = backupStatusPath(api.dataDir);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, typeof body === "string" ? body : JSON.stringify(body), "utf8");
}

const ok = (destination: string, at: number) => ({
  destination, lastSuccessAt: iso(at), lastAttemptAt: iso(at), errorCode: null,
});

describe("reading the status file", () => {
  it("reports a missing file as missing, with both destinations unknown", async () => {
    await rm(backupStatusPath(api.dataDir), { force: true });
    const status = await readBackupStatus(api.dataDir, NOW);
    expect(status.statusFile).toBe("missing");
    expect(status.destinations.map(d => [d.destination, d.state]))
      .toEqual([["local", "unknown"], ["independent", "unknown"]]);
    // Nothing is invented for a destination the file never mentioned.
    for (const d of status.destinations) {
      expect([d.lastSuccessAt, d.lastAttemptAt, d.errorCode]).toEqual([null, null, null]);
    }
  });

  it.each([
    ["not JSON at all", "{{{"],
    ["JSON of the wrong shape", { formatVersion: 1, destinations: "nope" }],
    ["a future format version", { formatVersion: 2, destinations: [] }],
    ["an unknown key", { formatVersion: 1, destinations: [], extra: true }],
    ["an unknown destination", { formatVersion: 1, destinations: [ok("offsite", NOW)] }],
    ["a malformed error code", { formatVersion: 1, destinations: [
      { destination: "local", lastSuccessAt: null, lastAttemptAt: null, errorCode: "Quota Exceeded" }] }],
  ])("reports %s as unreadable rather than reading it optimistically", async (_label, body) => {
    await writeStatus(body);
    const status = await readBackupStatus(api.dataDir, NOW);
    expect(status.statusFile).toBe("unreadable");
    expect(status.destinations.every(d => d.state === "unknown")).toBe(true);
  });

  it("always reports both destinations, even when the file names one", async () => {
    await writeStatus({ formatVersion: 1, destinations: [ok("local", NOW)] });
    const status = await readBackupStatus(api.dataDir, NOW);
    expect(status.statusFile).toBe("readable");
    expect(status.destinations.map(d => [d.destination, d.state]))
      .toEqual([["local", "ok"], ["independent", "unknown"]]);
  });
});

describe("deriving each destination's state", () => {
  const statesFor = async (destinations: unknown[], now = NOW) => {
    await writeStatus({ formatVersion: 1, destinations });
    const status = await readBackupStatus(api.dataDir, now);
    return Object.fromEntries(status.destinations.map(d => [d.destination, d.state]));
  };

  it("calls a recent success ok and an old one stale", async () => {
    expect((await statesFor([ok("local", NOW - 1000)]))["local"]).toBe("ok");
    expect((await statesFor([ok("local", NOW - BACKUP_STALE_AFTER_MS + 1000)]))["local"]).toBe("ok");
    expect((await statesFor([ok("local", NOW - BACKUP_STALE_AFTER_MS - 1000)]))["local"]).toBe("stale");
  });

  it("lets an error code outrank an old success", async () => {
    // The last thing that happened failed. Reporting ok because something
    // worked on Tuesday is how a broken backup goes unnoticed.
    const states = await statesFor([{
      destination: "independent", lastSuccessAt: iso(NOW - 1000),
      lastAttemptAt: iso(NOW), errorCode: "quota_exceeded",
    }]);
    expect(states["independent"]).toBe("failed");
  });

  it("separates never having run from having run and not finished", async () => {
    expect((await statesFor([{ destination: "local", lastSuccessAt: null,
      lastAttemptAt: null, errorCode: null }]))["local"]).toBe("never_run");
    expect((await statesFor([{ destination: "local", lastSuccessAt: null,
      lastAttemptAt: iso(NOW), errorCode: null }]))["local"]).toBe("failed");
  });

  it("does not let a healthy local copy mask a failing independent one", async () => {
    // The whole point of reporting per destination. There is deliberately no
    // overall roll-up that could read as green here.
    const states = await statesFor([
      ok("local", NOW - 1000),
      { destination: "independent", lastSuccessAt: iso(NOW - 3 * 24 * 60 * 60 * 1000),
        lastAttemptAt: iso(NOW), errorCode: "quota_exceeded" },
    ]);
    expect(states).toEqual({ local: "ok", independent: "failed" });
  });
});

describe("the route", () => {
  it("answers the contract's shape and forbids caching", async () => {
    await writeStatus({ formatVersion: 1, destinations: [
      ok("local", NOW - 1000),
      { destination: "independent", lastSuccessAt: null, lastAttemptAt: iso(NOW),
        errorCode: "quota_exceeded" },
    ] });
    const response = await api.request("/api/backup-status");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(() => GetBackupStatusResponse.parse(response.body)).not.toThrow();
    const body = response.body as { statusFile: string; destinations: { destination: string; state: string }[] };
    expect(body.statusFile).toBe("readable");
    expect(body.destinations.map(d => `${d.destination}:${d.state}`))
      .toEqual(["local:ok", "independent:failed"]);
  });

  it("answers a signed-out reader with 401, like every other read", async () => {
    const response = await api.request("/api/backup-status", { omitCookie: true });
    expect(response.status).toBe(401);
  });

  it("still answers when no backup has ever reported", async () => {
    // The state the service is in today: no backup job exists yet. A screen
    // asking this must get an answer, not an error.
    await rm(backupStatusPath(api.dataDir), { force: true });
    const response = await api.request("/api/backup-status");
    expect(response.status).toBe(200);
    expect(() => GetBackupStatusResponse.parse(response.body)).not.toThrow();
    expect((response.body as { statusFile: string }).statusFile).toBe("missing");
  });
});
