import type { Request, Response } from "express";

/**
 * RFC 9457 problem responses. Every failure leaves the API through here, so
 * there is exactly one place that decides what a client is allowed to see:
 * a code, a short sentence and the request id. Never SQL, stacks, file paths
 * or the request body.
 */
export type ProblemCode =
  | "invalid_request"
  | "not_authenticated"
  | "session_expired"
  | "invalid_credentials"
  | "origin_rejected"
  | "csrf_invalid"
  | "not_found"
  | "version_mismatch"
  | "precondition_required"
  | "validation_failed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "login_throttled"
  | "service_busy"
  | "maintenance"
  | "internal_error";

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export interface ProblemOptions {
  status: number;
  code: ProblemCode;
  title: string;
  detail: string;
  fieldErrors?: FieldError[];
  currentVersion?: string;
  retryAfterSeconds?: number;
}

export class ProblemError extends Error {
  readonly problem: ProblemOptions;
  constructor(problem: ProblemOptions) {
    super(problem.detail);
    this.name = "ProblemError";
    this.problem = problem;
  }
}

export function problem(options: ProblemOptions): ProblemError {
  return new ProblemError(options);
}

export function sendProblem(req: Request, res: Response, options: ProblemOptions): void {
  const body: Record<string, unknown> = {
    type: `urn:money-desk:problem:${options.code}`,
    title: options.title,
    status: options.status,
    code: options.code,
    detail: options.detail,
    requestId: res.locals["requestId"] as string,
  };
  if (options.fieldErrors !== undefined && options.fieldErrors.length > 0) {
    body["fieldErrors"] = options.fieldErrors.slice(0, 50);
  }
  if (options.currentVersion !== undefined) body["currentVersion"] = options.currentVersion;
  if (options.retryAfterSeconds !== undefined) {
    body["retryAfterSeconds"] = options.retryAfterSeconds;
    res.setHeader("Retry-After", String(options.retryAfterSeconds));
  }
  void req;
  res.status(options.status).type("application/problem+json").send(JSON.stringify(body));
}
