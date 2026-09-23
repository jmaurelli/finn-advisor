import { Router, type IRouter, type Request } from "express";
import { withWriteTransaction } from "@workspace/db";
import {
  CreateCategoryBody, CreateCategoryResponse, GetCategoryResponse, ListCategoriesResponse,
  ReactivateCategoryResponse, UpdateCategoryBody, UpdateCategoryResponse,
} from "../lib/category-schemas.js";
import { ArchiveCategoryBody, ArchiveCategoryResult, CategoryArchiveImpact } from "../lib/rule-schemas.js";
import type { AppDependencies } from "../deps.js";
import { easternDate } from "../domain/dates.js";
import { etag, requireIfMatch, versionMismatch } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import { checkedResponse, respond, sendChecked } from "../lib/respond.js";
import { requireAtLeastOneProperty, validateBody } from "../lib/validate.js";
import { requireCsrf, requireSession } from "../middlewares/session.js";
import {
  archiveCategory, categoryArchiveImpact, categoryDto, createCategory, deleteCategory, listCategories,
  reactivateCategory, requireCategory, updateCategory,
} from "../services/categories.js";
import { financeRevision } from "../services/ledger.js";
import { ruleSetRevision, singleRuleDto } from "../services/rules.js";

export function categoryRoutes(deps: AppDependencies): IRouter {
  const router = Router();
  const context = () => ({ db: deps.db, now: deps.clock.now(),
    today: easternDate(deps.clock.now()), newId: deps.newId });
  const resultBody = (row: ReturnType<typeof requireCategory>) => ({
    category: categoryDto(row), financeRevision: String(financeRevision(deps.db)),
  });
  const expectVersion = (id: string, expected: bigint) => {
    const row = requireCategory(deps.db, id);
    if (row.version !== expected) throw versionMismatch(row.version);
    return row;
  };

  router.get("/categories", requireSession, (req, res) => {
    const status = req.query["status"] ?? "active";
    if (typeof status !== "string" || !["active", "archived", "all"].includes(status)) {
      throw problem({ status: 400, code: "invalid_request", title: "Unknown filter",
        detail: "Choose active, archived or all categories." });
    }
    respond(res, deps.config, ListCategoriesResponse, 200, {
      items: listCategories(deps.db, status).map(categoryDto),
      financeRevision: String(financeRevision(deps.db)),
    });
  });

  router.post("/categories", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(CreateCategoryBody, req.body);
    const result = withWriteTransaction(deps.db, () => {
      const created = createCategory(context(), input);
      return { status: created.status, version: created.row.version,
        body: checkedResponse(CreateCategoryResponse, resultBody(created.row)) };
    });
    res.setHeader("ETag", etag(result.version));
    sendChecked(res, result.status, result.body);
  });

  router.get("/categories/:categoryId", requireSession, (req, res) => {
    const row = requireCategory(deps.db, categoryId(req));
    res.setHeader("ETag", etag(row.version));
    respond(res, deps.config, GetCategoryResponse, 200, categoryDto(row));
  });

  router.patch("/categories/:categoryId", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    requireAtLeastOneProperty(req.body);
    const patch = validateBody(UpdateCategoryBody, req.body);
    const id = categoryId(req);
    const result = withWriteTransaction(deps.db, () => {
      const row = updateCategory(context(), expectVersion(id, expected), patch);
      return { version: row.version, body: checkedResponse(UpdateCategoryResponse, resultBody(row)) };
    });
    res.setHeader("ETag", etag(result.version));
    sendChecked(res, 200, result.body);
  });

  router.delete("/categories/:categoryId", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = categoryId(req);
    withWriteTransaction(deps.db, () => deleteCategory(context(), expectVersion(id, expected)));
    res.status(204).end();
  });

  router.get("/categories/:categoryId/archive-impact", requireSession, (req, res) => {
    const row = requireCategory(deps.db, categoryId(req));
    respond(res, deps.config, CategoryArchiveImpact, 200,
      categoryArchiveImpact(deps.db, row, easternDate(deps.clock.now())));
  });

  router.post("/categories/:categoryId/archive", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const input = validateBody(ArchiveCategoryBody, req.body);
    const id = categoryId(req);
    const result = withWriteTransaction(deps.db, () => {
      const archived = archiveCategory(context(), expectVersion(id, expected), input);
      return { version: archived.row.version, body: checkedResponse(ArchiveCategoryResult, {
        category: categoryDto(archived.row),
        rulesChanged: archived.rulesChanged.map(rule => singleRuleDto(deps.db, rule)),
        ruleSetRevision: String(ruleSetRevision(deps.db)), budgetPlan: null,
        financeRevision: String(financeRevision(deps.db)),
      }) };
    });
    res.setHeader("ETag", etag(result.version));
    sendChecked(res, 200, result.body);
  });

  router.post("/categories/:categoryId/reactivate", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = categoryId(req);
    const result = withWriteTransaction(deps.db, () => {
      const row = reactivateCategory(context(), expectVersion(id, expected));
      return { version: row.version, body: checkedResponse(ReactivateCategoryResponse, resultBody(row)) };
    });
    res.setHeader("ETag", etag(result.version));
    sendChecked(res, 200, result.body);
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
