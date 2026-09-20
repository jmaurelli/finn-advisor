import type { Response } from "express";
import type { ZodType } from "zod";

import type { AppConfig } from "../config.js";

/**
 * Sends a response, checking it against the contract's own generated schema
 * outside production. A response that does not match what the contract
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
  if (config.environment !== "production") {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new Error(
        `Response does not match the contract: ${result.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
  }
  res.status(status).json(body);
}
