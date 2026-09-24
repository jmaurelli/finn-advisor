import type { Request, Response } from "express";

/**
 * RFC 9457 problem responses. Every failure leaves the API through here, so
 * there is exactly one place that decides what a client is allowed to see:
 * a code, a short sentence and the request id. Never SQL, stacks, file paths
 * or the request body.
 */
export type ProblemCode =
  | "invalid_request"
  | "invalid_cursor"
  | "cursor_filter_mismatch"
  | "not_authenticated"
  | "session_expired"
  | "invalid_credentials"
  | "origin_rejected"
  | "csrf_invalid"
  | "not_found"
  | "client_id_conflict"
  | "reactivation_required"
  | "account_in_use"
  | "active_transactions_before_start"
  | "category_archived"
  | "category_protected"
  | "category_in_use"
  | "category_name_taken"
  | "rule_set_changed"
  | "rule_target_ineligible"
  | "transfer_pair_linked"
  | "refund_already_linked"
  | "unlink_confirmation_required"
  | "kind_change_confirmation_required"
  | "kind_sign_mismatch"
  | "preview_stale"
  | "month_in_past"
  | "budget_ineligible_category"
  | "preview_expired"
  | "scope_too_large"
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

/**
 * Why a command was refused, named concretely: "6 transactions and 1
 * checkpoint", not "this account is in use". Up to 20 example ids per kind,
 * so a large history does not turn an error into a data dump.
 */
export interface BlockingReference {
  kind:
    | "transaction"
    | "import"
    | "checkpoint"
    | "rule"
    | "transfer_leg"
    | "source_identity"
    | "budget"
    | "import_row";
  count: number;
  ids: string[];
}

export interface ProblemOptions {
  status: number;
  code: ProblemCode;
  title: string;
  detail: string;
  fieldErrors?: FieldError[];
  blocking?: BlockingReference[];
  currentVersion?: string;
  retryAfterSeconds?: number;
  /** Exactly the links a change would invalidate, for the owner to confirm. */
  requiredUnlinks?: { transferPairIds: string[]; refundLinkIds: string[] };
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
  if (options.blocking !== undefined && options.blocking.length > 0) {
    body["blocking"] = options.blocking.slice(0, 20);
  }
  if (options.requiredUnlinks !== undefined) body["requiredUnlinks"] = options.requiredUnlinks;
  if (options.currentVersion !== undefined) body["currentVersion"] = options.currentVersion;
  if (options.retryAfterSeconds !== undefined) {
    body["retryAfterSeconds"] = options.retryAfterSeconds;
    res.setHeader("Retry-After", String(options.retryAfterSeconds));
  }
  void req;
  res.status(options.status).type("application/problem+json").send(JSON.stringify(body));
}
