import pino from "pino";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AppDependencies } from "../deps.js";

const isProduction = process.env["NODE_ENV"] === "production";

// Tests are silent whatever LOG_LEVEL the surrounding shell happens to carry;
// test output should be assertions, not a request log.
const isTest = process.env["NODE_ENV"] === "test" || process.env["VITEST"] !== undefined;

export const logger = pino({
  level: isTest ? "silent" : (process.env["LOG_LEVEL"] ?? "info"),
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

/**
 * Route template, status and duration only.
 *
 * Deliberately not the URL: a logged path can carry a transaction id or a
 * search term, and this log is meant to be safe to read, ship and keep.
 */
export function accessLog(deps: AppDependencies): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = deps.clock.now();
    res.on("finish", () => {
      logger.info(
        {
          method: req.method,
          route: routeTemplate(req),
          status: res.statusCode,
          durationMs: deps.clock.now() - startedAt,
          requestId: res.locals["requestId"],
        },
        "request",
      );
    });
    next();
  };
}

function routeTemplate(req: Request): string {
  const template = (req.route as { path?: string } | undefined)?.path;
  return template === undefined ? `${req.baseUrl}/*` : `${req.baseUrl}${template}`;
}
