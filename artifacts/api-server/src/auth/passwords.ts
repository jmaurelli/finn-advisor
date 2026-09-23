import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * Argon2id parameters, measured on server02 rather than assumed: 64 MiB with
 * three passes costs about 145 ms here, against 62 ms for the 19 MiB OWASP
 * baseline. For one owner signing in occasionally, that delay is unnoticeable
 * and it makes an offline attack on a stolen hash far more expensive.
 */
/** `Algorithm.Argon2id`, written as its value because the package exports a
 * const enum, which this build cannot inline. */
const ARGON2ID = 2;

export const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

/**
 * A hash of a value nobody knows, verified against when no owner password
 * exists yet, so "no password set" and "wrong password" take the same time
 * and cannot be told apart from outside.
 */
let decoyHash: string | undefined;

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

/** Verification reads the parameters recorded in the stored hash, so a later
 * change to ARGON2_OPTIONS does not lock the owner out of an older hash. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(storedHash, password);
  } catch {
    return false;
  }
}

export async function verifyAgainstDecoy(password: string): Promise<false> {
  decoyHash ??= await argon2Hash("money-desk-no-credential-configured", ARGON2_OPTIONS);
  await verifyPassword(decoyHash, password);
  return false;
}
