import { Router, type IRouter } from "express";
import { GetMonthSummaryResponse } from "@workspace/api-zod";

import type { AppDependencies } from "../deps.js";
import { isYearMonth } from "../domain/dates.js";
import { problem } from "../lib/problem.js";
import { respond } from "../lib/respond.js";
import { requireSession } from "../middlewares/session.js";
import { monthSummary } from "../services/summary.js";

export function summaryRoutes(deps: AppDependencies): IRouter {
  const router = Router();

  router.get("/summary", requireSession, (req, res) => {
    const month = req.query["month"];
    if (!isYearMonth(month)) {
      throw problem({
        status: 400,
        code: "invalid_request",
        title: "Missing or unusable month",
        detail: "This request needs a month in the form YYYY-MM.",
      });
    }
    respond(
      res,
      deps.config,
      GetMonthSummaryResponse,
      200,
      monthSummary(deps.db, month, deps.clock.now()),
    );
  });

  return router;
}
