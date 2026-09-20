import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetSessionResponse,
  LoginBody,
  LoginResponse,
  RecordSessionActivityResponse,
} from "@workspace/api-zod";

import { SESSION_COOKIE_NAME } from "../config.js";
import type { AppDependencies } from "../deps.js";
import {
  createSession,
  currentCredentialGeneration,
  lookupSession,
  recordActivity,
  revokeSession,
  type SessionRecord,
} from "../auth/sessions.js";
import { verifyAgainstDecoy } from "../auth/passwords.js";
import { clearFailures, recordFailure, retryAfterSeconds } from "../auth/throttle.js";
import { isoTimestamp } from "../lib/clock.js";
import { problem } from "../lib/problem.js";
import { respond } from "../lib/respond.js";
import { readSessionCookie, requireCsrf, requireSession } from "../middlewares/session.js";
import { validateBody } from "../lib/validate.js";

export function sessionRoutes(deps: AppDependencies): IRouter {
  const router = Router();

  // Reading the session state must not extend the idle deadline, or a page
  // that polls would never time out. The session was resolved once by the
  // middleware; looking it up again here would be a second, divergent read.
  router.get("/session", (req, res) => {
    if (req.session === undefined) {
      if (req.sessionExpired === true) clearSessionCookie(res);
      respond(res, deps.config, GetSessionResponse, 200, { authenticated: false });
      return;
    }
    respond(
      res,
      deps.config,
      GetSessionResponse,
      200,
      sessionBody(deps, req.session, req.csrfToken!),
    );
  });

  router.post("/session/login", async (req, res, next) => {
    const body = validateBody(LoginBody, req.body);
    const source = sourceAddress(req);
    const now = deps.clock.now();

    const wait = retryAfterSeconds(deps.db, source, now);
    if (wait > 0) {
      next(
        problem({
          status: 429,
          code: "login_throttled",
          title: "Too many attempts",
          detail: "Too many sign-in attempts. Wait a moment and try again.",
          retryAfterSeconds: wait,
        }),
      );
      return;
    }

    const credential = deps.db
      .prepare("SELECT password_hash, generation FROM owner_credentials WHERE id = 1")
      .get() as { password_hash: string; generation: bigint } | undefined;

    const correct =
      credential === undefined
        ? await verifyAgainstDecoy(body.password)
        : await deps.verifyPassword(credential.password_hash, body.password);

    if (!correct || credential === undefined) {
      recordFailure(deps.db, source, deps.clock.now());
      next(
        problem({
          status: 401,
          code: "invalid_credentials",
          title: "Sign-in failed",
          detail: "That password is not correct.",
        }),
      );
      return;
    }

    // Any session the browser already had is replaced, not reused.
    const existing = lookupSession(deps.db, readSessionCookie(req), now);
    if (existing.state === "active") revokeSession(deps.db, existing.session.id);

    clearFailures(deps.db, source);
    const established = createSession(deps.db, {
      now: deps.clock.now(),
      newId: deps.newId,
      credentialGeneration: Number(credential.generation),
    });
    setSessionCookie(res, established.token, deps);
    respond(
      res,
      deps.config,
      LoginResponse,
      200,
      sessionBody(deps, established.session, established.csrfToken),
    );
  });

  router.post("/session/activity", requireSession, requireCsrf, (req, res) => {
    const session = recordActivity(deps.db, req.session!, deps.clock.now());
    respond(
      res,
      deps.config,
      RecordSessionActivityResponse,
      200,
      sessionBody(deps, session, req.csrfToken!),
    );
  });

  router.post("/session/logout", requireSession, requireCsrf, (req, res) => {
    revokeSession(deps.db, req.session!.id);
    clearSessionCookie(res);
    res.status(204).end();
  });

  return router;
}

function sessionBody(
  deps: AppDependencies,
  session: SessionRecord,
  csrfToken: string,
): Record<string, unknown> {
  return {
    authenticated: true,
    csrfToken,
    displayName: displayName(deps),
    serverTime: isoTimestamp(deps.clock.now()),
    idleExpiresAt: isoTimestamp(session.idleExpiresAt),
    absoluteExpiresAt: isoTimestamp(session.absoluteExpiresAt),
  };
}

function displayName(deps: AppDependencies): string {
  const row = deps.db
    .prepare("SELECT display_name FROM preferences WHERE id = 1")
    .get() as { display_name: string } | undefined;
  return row?.display_name ?? "Personal space";
}

/**
 * `__Host-` prefixed, so the browser itself enforces host-only, Secure and
 * Path=/. Browsers treat http://localhost as a secure context, which is how
 * development works without a weaker cookie mode existing at all.
 */
function setSessionCookie(res: Response, token: string, deps: AppDependencies): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
  });
  void deps;
}

function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
  });
}

/** Loopback only for now; the proxy stage decides how a forwarded address is trusted. */
function sourceAddress(req: Request): string {
  return req.socket.remoteAddress ?? "unknown";
}

export function currentGeneration(deps: AppDependencies): number | undefined {
  return currentCredentialGeneration(deps.db);
}
