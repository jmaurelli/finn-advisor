import type { NextFunction, Request, RequestHandler, Response } from "express";

import { SESSION_COOKIE_NAME } from "../config.js";
import type { AppDependencies } from "../deps.js";
import { lookupSession, verifyCsrf, type SessionRecord } from "../auth/sessions.js";
import { problem } from "../lib/problem.js";
import { isWrite } from "./context.js";

declare module "express-serve-static-core" {
  interface Request {
    session?: SessionRecord;
    csrfToken?: string;
    sessionExpired?: boolean;
  }
}

export function readSessionCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[SESSION_COOKIE_NAME];
}

/**
 * Attaches the session when the cookie resolves to a live one. Looking at a
 * session does not extend it: only `POST /session/activity` and financial
 * writes do, which is what makes the 30-minute idle deadline mean anything
 * on a page that polls.
 */
export function attachSession(deps: AppDependencies): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const lookup = lookupSession(deps.db, readSessionCookie(req), deps.clock.now());
    if (lookup.state === "active") {
      req.session = lookup.session;
      req.csrfToken = lookup.csrfToken;
    }
    req.sessionExpired = lookup.state === "expired";
    next();
  };
}

export function requireSession(req: Request, _res: Response, next: NextFunction): void {
  if (req.session !== undefined) {
    next();
    return;
  }
  next(
    req.sessionExpired === true
      ? problem({
          status: 401,
          code: "session_expired",
          title: "Signed out",
          detail: "The session ended. Sign in again to continue.",
        })
      : problem({
          status: 401,
          code: "not_authenticated",
          title: "Sign in required",
          detail: "Sign in to continue.",
        }),
  );
}

/** Every authenticated write needs the per-session token as well as the cookie. */
export function requireCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (!isWrite(req)) {
    next();
    return;
  }
  if (req.csrfToken !== undefined && verifyCsrf(req.csrfToken, req.get("x-csrf-token"))) {
    next();
    return;
  }
  next(
    problem({
      status: 403,
      code: "csrf_invalid",
      title: "Request rejected",
      detail: "This request was missing its security token. Reload the page and try again.",
    }),
  );
}
