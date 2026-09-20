import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";

import type { AppDependencies } from "../deps.js";
import { problem } from "../lib/problem.js";

/** Every response carries a request id, which is the only thread a problem
 * response gives the owner to quote back when something goes wrong. */
export function requestContext(deps: AppDependencies): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    const requestId = deps.newId();
    res.locals["requestId"] = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
  };
}

export function fallbackRequestId(res: Response): string {
  const existing = res.locals["requestId"];
  if (typeof existing === "string") return existing;
  const generated = randomUUID();
  res.locals["requestId"] = generated;
  return generated;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isWrite(req: Request): boolean {
  return WRITE_METHODS.has(req.method);
}

/**
 * Writes must be same-origin, login included: an attacker's page must not be
 * able to spend the owner's cookie, and a missing `Origin` is treated as a
 * failure rather than waved through.
 */
export function requireSameOrigin(deps: AppDependencies): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!isWrite(req)) {
      next();
      return;
    }
    const origin = req.get("origin");
    if (origin !== deps.config.allowedOrigin) {
      next(
        problem({
          status: 403,
          code: "origin_rejected",
          title: "Request rejected",
          detail: "This request did not come from the Money Desk page.",
        }),
      );
      return;
    }
    next();
  };
}

/**
 * While nothing is trusted in front of this service, a forwarding header can
 * only have been added by something pretending to be a proxy, so the request
 * is refused rather than interpreted. The proxy stage replaces this with an
 * explicit, narrow trust configuration.
 */
const FORWARDING_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "x-real-ip",
];

export function rejectForwardingHeaders(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const present = FORWARDING_HEADERS.find((name) => req.get(name) !== undefined);
  if (present === undefined) {
    next();
    return;
  }
  next(
    problem({
      status: 400,
      code: "invalid_request",
      title: "Could not read the request",
      detail: "This request carried headers that only a trusted proxy may set.",
    }),
  );
}

/** Writes carry JSON only; anything else is refused before it is parsed. */
export function requireJsonContentType(req: Request, _res: Response, next: NextFunction): void {
  if (!isWrite(req)) {
    next();
    return;
  }
  const declared = req.get("content-type");
  if (declared === undefined) {
    // A write with no body at all (logout, activity) needs no content type.
    if (req.get("content-length") === undefined || req.get("content-length") === "0") {
      next();
      return;
    }
  }
  if (declared !== undefined && req.is("application/json") === "application/json") {
    next();
    return;
  }
  next(
    problem({
      status: 415,
      code: "unsupported_media_type",
      title: "Unsupported format",
      detail: "Send this request as application/json.",
    }),
  );
}
