/**
 * Sets or replaces the owner password.
 *
 *   pnpm --filter @workspace/api-server owner:set-password --data-dir <dir>
 *
 * The password is typed at the prompt, never passed as an argument or an
 * environment variable, so it cannot end up in the shell history, the process
 * list or a log. Changing it revokes every existing session.
 */
import { closeLedger, openLedger, withWriteTransaction, type SqliteDatabase } from "@workspace/db";

import { hashPassword } from "../auth/passwords.js";

const ETX = "";
const BACKSPACE = "";

function argument(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index !== -1) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** Reads a line without echoing it. */
async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = input.isRaw === true;
  input.setRawMode(true);
  input.resume();
  output.write(prompt);

  const value = await new Promise<string>((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          input.off("data", onData);
          resolve(buffer);
          return;
        }
        if (char === ETX) {
          output.write("\n");
          process.exit(130);
        }
        buffer = char === BACKSPACE ? buffer.slice(0, -1) : buffer + char;
      }
    };
    input.on("data", onData);
  });

  input.setRawMode(wasRaw);
  input.pause();
  output.write("\n");
  return value;
}

/**
 * Writes the new hash and bumps the credential generation in one transaction.
 * Sessions carry the generation they were created under, so every existing
 * sign-in stops being valid at the same instant the password changes.
 */
export function setOwnerPassword(db: SqliteDatabase, passwordHash: string, now: number): number {
  return withWriteTransaction(db, () => {
    const current = db
      .prepare("SELECT generation FROM owner_credentials WHERE id = 1")
      .get() as { generation: bigint } | undefined;
    const generation = current === undefined ? 1 : Number(current.generation) + 1;

    db.prepare(
      `INSERT INTO owner_credentials (id, algorithm, password_hash, generation, updated_at)
       VALUES (1, 'argon2id', ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         password_hash = excluded.password_hash,
         generation = excluded.generation,
         updated_at = excluded.updated_at`,
    ).run(passwordHash, generation, now);
    db.prepare("DELETE FROM sessions").run();
    return generation;
  });
}

async function main(): Promise<void> {
  const dataDir = argument("data-dir");
  if (dataDir === undefined || dataDir === "") {
    console.error("Usage: owner:set-password --data-dir <directory>");
    process.exitCode = 2;
    return;
  }
  if (!process.stdin.isTTY) {
    console.error("Run this from a terminal: the password is typed, never passed as an argument.");
    process.exitCode = 2;
    return;
  }

  const password = await readSecret("New password: ");
  const again = await readSecret("Repeat password: ");
  if (password !== again) {
    console.error("The two entries did not match. Nothing was changed.");
    process.exitCode = 1;
    return;
  }
  if (password.length < 12) {
    console.error("Use at least 12 characters. Nothing was changed.");
    process.exitCode = 1;
    return;
  }

  const db = openLedger({ dataDir });
  try {
    setOwnerPassword(db, await hashPassword(password), Date.now());
    console.log("Password saved. Every existing sign-in has been signed out.");
  } finally {
    closeLedger(db);
  }
}

if (process.argv[1]?.endsWith("set-password.ts") === true) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
