import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { DatabaseBusyError } from "@workspace/db";

import { MAX_JSON_BODY_BYTES } from "./config.js";
import type { AppDependencies } from "./deps.js";
import { ProblemError, sendProblem } from "./lib/problem.js";
import { securityHeaders } from "./lib/security.js";
import {
  rejectForwardingHeaders,
  requestContext,
  requireJsonContentType,
  requireSameOrigin,
} from "./middlewares/context.js";
import { attachSession } from "./middlewares/session.js";
import { accountRoutes } from "./routes/accounts.js";
import { healthRoutes } from "./routes/health.js";
import { preferencesRoutes } from "./routes/preferences.js";
import { sessionRoutes } from "./routes/session.js";
import { summaryRoutes } from "./routes/summary.js";
import { accessLog, logger } from "./lib/logger.js";

export function createApp(deps: AppDependencies): Express {
  const app = express();

  // No proxy is in front of this yet, so forwarded headers are not trusted.
  app.set("trust proxy", false);
  app.set("x-powered-by", false);
  app.set("etag", false);

  const api = express.Router();
  api.use(requestContext(deps));
  api.use(securityHeaders);
  api.use(accessLog(deps));
  api.use(rejectForwardingHeaders);
  api.use(cookieParser());
  api.use(requireJsonContentType);
  // Origin before the parser: a cross-origin write should be refused without
  // buffering its body first.
  api.use(requireSameOrigin(deps));
  api.use(express.json({ limit: MAX_JSON_BODY_BYTES, strict: true, type: "application/json" }));
  api.use(attachSession(deps));

  api.use(healthRoutes(deps));
  api.use(sessionRoutes(deps));
  api.use(preferencesRoutes(deps));
  api.use(accountRoutes(deps));
  api.use(summaryRoutes(deps));

  // Anything unmatched under /api is a problem document, never Express's HTML.
  api.use((_req: Request, res: Response, next: NextFunction) => {
    void res;
    next(
      new ProblemError({
        status: 404,
        code: "not_found",
        title: "Not found",
        detail: "There is nothing at this address.",
      }),
    );
  });

  api.use(errorHandler(deps));

  app.use("/api", api);

  // Outside /api there is no application. It still gets the request id and
  // the same hardening, so "every response" means every response.
  app.use(requestContext(deps));
  app.use(securityHeaders);
  app.use((req: Request, res: Response, next: NextFunction) => {
    next(
      new ProblemError({
        status: 404,
        code: "not_found",
        title: "Not found",
        detail: "There is nothing at this address.",
      }),
    );
    void req;
  });
  app.use(errorHandler(deps));

  return app;
}

function errorHandler(deps: AppDependencies) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ProblemError) {
      sendProblem(req, res, error.problem);
      return;
    }
    if (error instanceof DatabaseBusyError) {
      sendProblem(req, res, {
        status: 503,
        code: "service_busy",
        title: "Busy",
        detail: "Another change is being saved. Try again in a moment.",
        retryAfterSeconds: error.retryAfterSeconds,
      });
      return;
    }

    const status = (error as { status?: number; statusCode?: number }).status ??
      (error as { statusCode?: number }).statusCode;
    const type = (error as { type?: string }).type;
    if (status === 413 || type === "entity.too.large") {
      sendProblem(req, res, {
        status: 413,
        code: "payload_too_large",
        title: "Too large",
        detail: "That request was larger than this service accepts.",
      });
      return;
    }
    if (status === 400 || type === "entity.parse.failed") {
      sendProblem(req, res, {
        status: 400,
        code: "invalid_request",
        title: "Could not read the request",
        detail: "The request body was not valid JSON.",
      });
      return;
    }

    // Unexpected: the details go to the log with the request id, and the
    // client gets the id and nothing else.
    logger.error({ err: error, requestId: res.locals["requestId"] }, "unhandled error");
    void deps;
    sendProblem(req, res, {
      status: 500,
      code: "internal_error",
      title: "Something went wrong",
      detail: "Something went wrong. The request id below identifies this failure in the log.",
    });
  };
}
