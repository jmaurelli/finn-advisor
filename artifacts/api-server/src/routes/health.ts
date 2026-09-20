import { Router, type IRouter } from "express";
import { EXPECTED_SCHEMA_VERSION, schemaVersion } from "@workspace/db";
import { HealthCheckResponse, ReadinessCheckResponse } from "@workspace/api-zod";

import type { AppDependencies } from "../deps.js";
import { respond } from "../lib/respond.js";

export function healthRoutes(deps: AppDependencies): IRouter {
  const router = Router();

  // Liveness only: no database access, so it stays answerable while the
  // database is the thing that is broken.
  router.get("/healthz", (_req, res) => {
    respond(res, deps.config, HealthCheckResponse, 200, { status: "ok" });
  });

  router.get("/readyz", (_req, res) => {
    let database: "ok" | "unavailable" = "ok";
    let schema: "compatible" | "incompatible" | "unknown" = "unknown";
    try {
      const version = schemaVersion(deps.db);
      schema = version === EXPECTED_SCHEMA_VERSION ? "compatible" : "incompatible";
    } catch {
      database = "unavailable";
    }
    const ready = database === "ok" && schema === "compatible";
    const body = { status: ready ? "ready" : "not_ready", database, schema };
    if (!ready) res.setHeader("Retry-After", "30");
    respond(res, deps.config, ReadinessCheckResponse, ready ? 200 : 503, body);
  });

  return router;
}
