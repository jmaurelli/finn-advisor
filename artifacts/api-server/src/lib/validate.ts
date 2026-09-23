import type { ZodType } from "zod";

import { problem, type FieldError } from "./problem.js";

/**
 * Validates a request body against the contract's generated schema and turns
 * a failure into the contract's 422, with per-field detail and nothing echoed
 * back from the payload itself.
 */
export function validateBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const fieldErrors: FieldError[] = result.error.issues.slice(0, 50).map((issue) => ({
    path: `/${issue.path.join("/")}`,
    code: issue.code === "unrecognized_keys" ? "unknown_field" : "invalid_value",
    message: issue.message.slice(0, 300),
  }));

  throw problem({
    status: 422,
    code: "validation_failed",
    title: "Some values could not be accepted",
    detail: "Check the highlighted fields and try again.",
    fieldErrors,
  });
}

/**
 * `minProperties` is not carried into the generated zod schemas (a known gap
 * in the generator, recorded in the design), so an empty patch body is
 * checked by hand rather than silently accepted as a no-op write.
 */
export function requireAtLeastOneProperty(body: unknown): void {
  if (typeof body === "object" && body !== null && Object.keys(body).length > 0) return;
  throw problem({
    status: 422,
    code: "validation_failed",
    title: "Nothing to change",
    detail: "Include at least one field to change.",
    fieldErrors: [{ path: "/", code: "empty_patch", message: "At least one field is required." }],
  });
}
