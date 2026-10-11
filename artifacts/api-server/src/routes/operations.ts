/**
 * Operational readouts: what the application can say about work done around
 * it rather than by it.
 */
import { Router, type IRouter } from "express";
import { GetBackupStatusResponse } from "@workspace/api-zod";

import type { AppDependencies } from "../deps.js";
import { respond } from "../lib/respond.js";
import { readBackupStatus } from "../services/backup-status.js";
import { requireSession } from "../middlewares/session.js";

export function operationsRoutes(deps: AppDependencies): IRouter {
  const router = Router();

  router.get("/backup-status", requireSession, async (_req, res, next) => {
    try {
      const status = await readBackupStatus(deps.config.dataDir, deps.clock.now());
      respond(res, deps.config, GetBackupStatusResponse, 200, status);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
