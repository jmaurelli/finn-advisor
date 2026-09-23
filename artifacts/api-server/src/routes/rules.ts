import { Router, type IRouter, type Request } from "express";
import { withWriteTransaction, type SqliteDatabase } from "@workspace/db";
import { CreateRuleBody, ReorderRulesBody, Rule, RuleHistory, RuleList, RuleResult, UpdateRuleBody } from "../lib/rule-schemas.js";
import { CreateRuleRunBody, RuleRun, RuleRunResult, RuleRunRows } from "../lib/rule-run-schemas.js";
import { applyRuleRun, getRuleRun, listRuleRunRows, prepareRuleRun, publishRuleRun, ruleRunSnapshot } from "../services/rule-runs.js";
import type { AppDependencies } from "../deps.js";
import { easternDate } from "../domain/dates.js";
import { etag, requireIfMatch, versionMismatch } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import { checkedResponse, respond, sendChecked } from "../lib/respond.js";
import { requireAtLeastOneProperty, validateBody } from "../lib/validate.js";
import { requireCsrf, requireSession } from "../middlewares/session.js";
import { financeRevision } from "../services/ledger.js";
import {
  activeRules, archiveRule, assignmentCounts, createRule, listRules, reorderRules, requireRule, ruleDto,
  ruleHistory, ruleOverlaps, ruleSetRevision, singleRuleDto, updateRule, type RuleRow,
} from "../services/rules.js";

export function ruleListBody(db: SqliteDatabase, rows: RuleRow[]) {
  const counts = assignmentCounts(db);
  return {
    items: rows.map(row => ruleDto(row, counts.get(row.id) ?? 0n)),
    ruleSetRevision: String(ruleSetRevision(db)), financeRevision: String(financeRevision(db)),
  };
}

export function ruleResultBody(db: SqliteDatabase, row: RuleRow) {
  return {
    rule: singleRuleDto(db, row), overlaps: ruleOverlaps(db, row),
    ruleSetRevision: String(ruleSetRevision(db)), financeRevision: String(financeRevision(db)),
  };
}

export function ruleRoutes(deps: AppDependencies): IRouter {
  const router = Router();
  const context = () => ({ db: deps.db, now: deps.clock.now(),
    today: easternDate(deps.clock.now()), newId: deps.newId });
  const requireExecutionSession = (req: Request) => {
    const now = deps.clock.now();
    const active = deps.db.prepare(`SELECT 1 FROM sessions s JOIN owner_credentials c ON c.id = 1
      WHERE s.id = ? AND s.credential_generation = c.generation AND s.idle_expires_at > ? AND s.absolute_expires_at > ?`)
      .get(req.session?.id ?? "", now, now);
    if (active === undefined) throw problem({ status: 401, code: "session_expired", title: "Signed out",
      detail: "The session ended. Sign in again to continue." });
  };
  const expectVersion = (id: string, expected: bigint) => {
    const row = requireRule(deps.db, id);
    if (row.version !== expected) throw versionMismatch(row.version);
    return row;
  };

  router.get("/rules", requireSession, (req, res) => {
    const status = req.query["status"] ?? "active";
    if (typeof status !== "string" || !["active", "archived", "all"].includes(status)) {
      throw problem({ status: 400, code: "invalid_request", title: "Unknown filter",
        detail: "Choose active, archived or all rules." });
    }
    respond(res, deps.config, RuleList, 200, ruleListBody(deps.db, listRules(deps.db, status)));
  });

  router.post("/rules", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(CreateRuleBody, req.body);
    const result = withWriteTransaction(deps.db, () => {
      const created = createRule(context(), input);
      return { status: created.status, version: created.row.version,
        body: checkedResponse(RuleResult, ruleResultBody(deps.db, created.row)) };
    });
    res.setHeader("ETag", etag(result.version));
    sendChecked(res, result.status, result.body);
  });

  router.post("/rules/reorder", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(ReorderRulesBody, req.body);
    const body = withWriteTransaction(deps.db, () => {
      reorderRules(context(), input);
      return checkedResponse(RuleList, ruleListBody(deps.db, activeRules(deps.db)));
    });
    sendChecked(res, 200, body);
  });

  router.get("/rules/:ruleId", requireSession, (req, res) => {
    const row = requireRule(deps.db, ruleId(req));
    res.setHeader("ETag", etag(row.version));
    respond(res, deps.config, Rule, 200, singleRuleDto(deps.db, row));
  });

  router.patch("/rules/:ruleId", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    requireAtLeastOneProperty(req.body);
    const patch = validateBody(UpdateRuleBody, req.body);
    const id = ruleId(req);
    const result = withWriteTransaction(deps.db, () => {
      const row = updateRule(context(), expectVersion(id, expected), patch);
      return { version: row.version, body: checkedResponse(RuleResult, ruleResultBody(deps.db, row)) };
    });
    res.setHeader("ETag", etag(result.version));
    sendChecked(res, 200, result.body);
  });

  router.post("/rules/:ruleId/archive", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = ruleId(req);
    const result = withWriteTransaction(deps.db, () => {
      const row = archiveRule(context(), expectVersion(id, expected));
      return { version: row.version, body: checkedResponse(RuleResult, ruleResultBody(deps.db, row)) };
    });
    res.setHeader("ETag", etag(result.version));
    sendChecked(res, 200, result.body);
  });

  router.get("/rules/:ruleId/history", requireSession, (req, res) => {
    const row = requireRule(deps.db, ruleId(req));
    respond(res, deps.config, RuleHistory, 200, ruleHistory(deps.db, row));
  });
  router.post("/rule-runs", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(CreateRuleRunBody, req.body);
    const prepared = prepareRuleRun(context(), input.scope);
    const result = withWriteTransaction(deps.db, () => {
      requireExecutionSession(req);
      return publishRuleRun(context(), prepared, body => checkedResponse(RuleRun, body));
    });
    res.setHeader("Location", `/api/rule-runs/${result.id}`);
    sendChecked(res, 201, result.body);
  });
  router.get("/rule-runs/:ruleRunId", requireSession, (req, res) => {
    const body = ruleRunSnapshot(deps.db, () => getRuleRun(deps.db, runId(req), deps.clock.now()));
    respond(res, deps.config, RuleRun, 200, body);
  });
  router.get("/rule-runs/:ruleRunId/rows", requireSession, (req, res) => {
    const body = ruleRunSnapshot(deps.db, () => listRuleRunRows(deps.db, runId(req), deps.clock.now(), req.query));
    respond(res, deps.config, RuleRunRows, 200, body);
  });
  router.post("/rule-runs/:ruleRunId/apply", requireSession, requireCsrf, (req, res) => {
    const body = withWriteTransaction(deps.db, () => {
      requireExecutionSession(req);
      return applyRuleRun(context(), runId(req), value => checkedResponse(RuleRunResult, value));
    });
    sendChecked(res, 200, body);
  });
  return router;
}

function runId(req: Request): string {
  const id = req.params["ruleRunId"];
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no rule run with that id." });
  }
  return id.toLowerCase();
}

function ruleId(req: Request): string {
  const id = req.params["ruleId"];
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no rule with that id." });
  }
  return id.toLowerCase();
}
