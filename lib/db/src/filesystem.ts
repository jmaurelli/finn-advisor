import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import { DatabaseSetupError } from "./errors.js";

/**
 * Filesystem types SQLite's locking cannot be trusted on. A network or
 * userspace filesystem can silently break the single-writer guarantee the
 * whole design depends on, so the data directory is refused outright.
 */
const REFUSED_FILESYSTEM_TYPES = new Set([
  "9p",
  "afs",
  "beegfs",
  "ceph",
  "cifs",
  "coda",
  "fuse",
  "fuseblk",
  "fusectl",
  "gfs2",
  "glusterfs",
  "lustre",
  "ncpfs",
  "nfs",
  "nfs4",
  "ocfs2",
  "smb2",
  "smb3",
  "smbfs",
  "virtiofs",
]);

function isRefusedType(fstype: string): boolean {
  return REFUSED_FILESYSTEM_TYPES.has(fstype) || fstype.startsWith("fuse.");
}

interface MountEntry {
  mountPoint: string;
  fstype: string;
}

export function parseMountinfo(contents: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    const [before, after] = line.split(" - ");
    if (after === undefined) continue;
    const mountPoint = before.split(" ")[4];
    const fstype = after.trim().split(" ")[0];
    if (mountPoint === undefined || fstype === undefined) continue;
    entries.push({ mountPoint: unescapeMountField(mountPoint), fstype });
  }
  return entries;
}

/** mountinfo octal-escapes space, tab, newline and backslash. */
function unescapeMountField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) =>
    String.fromCharCode(parseInt(code, 8)),
  );
}

function containsPath(mountPoint: string, path: string): boolean {
  if (mountPoint === path) return true;
  const prefix = mountPoint.endsWith(sep) ? mountPoint : mountPoint + sep;
  return path.startsWith(prefix);
}

/**
 * Resolves the filesystem type backing `path` by finding the longest matching
 * mount point, and throws when it is one we refuse to put the ledger on.
 * On a host without /proc/self/mountinfo the check cannot run; that is
 * reported rather than silently skipped.
 */
export function assertLocalFilesystem(
  path: string,
  mountinfoPath = "/proc/self/mountinfo",
): string {
  // The real path, not the requested one: `resolve` normalizes `..` but does
  // not follow symlinks, so a link into a network mount would otherwise be
  // matched against the link's own location and wrongly accepted.
  let absolute: string;
  try {
    absolute = realpathSync(resolve(path));
  } catch {
    absolute = resolve(path);
  }

  let contents: string;
  try {
    contents = readFileSync(mountinfoPath, "utf8");
  } catch {
    throw new DatabaseSetupError(
      "Cannot determine the filesystem of the data directory; refusing to open the ledger",
    );
  }

  let best: MountEntry | undefined;
  for (const entry of parseMountinfo(contents)) {
    if (!containsPath(entry.mountPoint, absolute)) continue;
    if (best === undefined || entry.mountPoint.length >= best.mountPoint.length) {
      best = entry;
    }
  }

  if (best === undefined) {
    throw new DatabaseSetupError(
      "No mount point matches the data directory; refusing to open the ledger",
    );
  }
  if (isRefusedType(best.fstype)) {
    throw new DatabaseSetupError(
      `The data directory is on a ${best.fstype} filesystem, where SQLite locking is unsafe; use local storage`,
    );
  }
  return best.fstype;
}
