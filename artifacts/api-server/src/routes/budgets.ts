import { Router, type IRouter, type Request } from "express";
import { withWriteTransaction } from "@workspace/db";

import type { AppDependencies } from "../deps.js";
import { easternDate, isYearMonth } from "../domain/dates.js";
import { etag } from "../domain/versions.js";
import {
  ApplyBudgetChangeBody, BudgetChangeApplyResult, BudgetChangeBody, BudgetChangePreview, BudgetMonth, BudgetPlan,
} from "../lib/budget-schemas.js";
import { problem } from "../lib/problem.js";
import { checkedResponse, respond, sendChecked } from "../lib/respond.js";
import { validateBody } from "../lib/validate.js";
import { requireCsrf, requireSession } from "../middlewares/session.js";
import { applyBudgetChange, createBudgetPreview } from "../services/budget-changes.js";
import { budgetPlanDto, budgetPlanVersion } from "../services/budget-plans.js";
import { budgetMonth } from "../services/budgets.js";
import { requireCategory } from "../services/categories.js";

export function budgetRoutes(deps: AppDependencies): IRouter {
  const router = Router();
  const context = () => ({ db: deps.db, now: deps.clock.now(),
    today: easternDate(deps.clock.now()), newId: deps.newId });
  /**
   * Re-read inside the write transaction: a category archived between the
   * request arriving and the change being written is seen here, not missed.
   */
  const category = (req: Request) => requireCategory(deps.db, categoryId(req));

  router.get("/budgets", requireSession, (req, res) => {
    const month = req.query["month"];
    if (!isYearMonth(month)) {
      throw problem({ status: 400, code: "invalid_request", title: "Missing or unusable month",
        detail: "This request needs a month in the form YYYY-MM." });
    }
    respond(res, deps.config, BudgetMonth, 200, budgetMonth(deps.db, month));
  });

  router.get("/budget-plans/:categoryId", requireSession, (req, res) => {
    const row = category(req);
    const version = budgetPlanVersion(deps.db, row.id);
    // A category that never had a budget has no version to match on, so it
    // gets no ETag rather than an invented one.
    if (version !== null) res.setHeader("ETag", etag(version));
    respond(res, deps.config, BudgetPlan, 200, budgetPlanDto(deps.db, row));
  });

  router.post("/budget-plans/:categoryId/preview-change", requireSession, requireCsrf, (req, res) => {
    const request = validateBody(BudgetChangeBody, req.body);
    const result = withWriteTransaction(deps.db, () =>
      createBudgetPreview(context(), category(req), request, body => checkedResponse(BudgetChangePreview, body)));
    sendChecked(res, 201, result.body);
  });

  router.post("/budget-plans/:categoryId/apply-change", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(ApplyBudgetChangeBody, req.body);
    const body = withWriteTransaction(deps.db, () =>
      applyBudgetChange(context(), category(req), input.previewId,
        value => checkedResponse(BudgetChangeApplyResult, value)));
    sendChecked(res, 200, body);
  });

  return router;
}

function categoryId(req: Request): string {
  const id = req.params["categoryId"];
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no category with that id." });
  }
  return id.toLowerCase();
}
