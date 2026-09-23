import type { Response } from "express";
import type { ZodType } from "zod";

import type { AppConfig } from "../config.js";

function assertMatches<T>(schema: ZodType<T>, body: unknown): void {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `Response does not match the contract: ${result.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
}

/**
 * Sends a read response, checking it against the contract's own generated
 * schema outside production. A response that does not match what the contract
 * promises is a defect, and this makes it a loud one during development and
 * in tests rather than a surprise in the browser.
 */
export function respond<T>(
  res: Response,
  config: AppConfig,
  schema: ZodType<T>,
  status: number,
  body: unknown,
): void {
  if (config.environment !== "production") assertMatches(schema, body);
  res.status(status).json(body);
}

/**
 * Checks a write command's response inside its transaction, in every
 * environment (design section 4: "construct and validate response DTO before
 * committing"). A response the contract does not allow then rolls the change
 * back as an internal fault, instead of committing it and failing afterwards -
 * which would leave the owner with an error for a change that was saved.
 */
export function checkedResponse<T>(schema: ZodType<T>, body: unknown): unknown {
  assertMatches(schema, body);
  return body;
}

/** Sends a response already checked by `checkedResponse`. */
export function sendChecked(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}
