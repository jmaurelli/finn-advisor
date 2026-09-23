import { Router, type IRouter, type Request, type Response } from "express";
import { withWriteTransaction } from "@workspace/db";
import type { AppDependencies } from "../deps.js";
import { easternDate } from "../domain/dates.js";
import { etag, requireIfMatch } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import { checkedResponse, respond, sendChecked } from "../lib/respond.js";
import {
  CategorizeBody, CategorizeResult, HistoryPage, Transaction, TransactionPage, TransactionResult, UpdateNoteBody,
} from "../lib/transaction-schemas.js";
import { ClassifyBody, ClassifyResult, RefundCandidatePage, TransferCandidateList } from "../lib/link-schemas.js";
import { validateBody } from "../lib/validate.js";
import { requireCsrf, requireSession } from "../middlewares/session.js";
import {
  categorizeTransaction, classifyTransaction, returnTransactionToRules, updateTransactionNote, type CommandOutcome,
} from "../services/corrections.js";
import { refundCandidates, transferCandidates } from "../services/link-candidates.js";
import { listTransactions } from "../services/transaction-list.js";
import { requireTransaction, transactionDto } from "../services/transactions.js";
import { transactionHistory } from "../services/transaction-history.js";
import { ApplyBody, RepairBody, RepairPreview, RepairResult } from "../lib/repair-schemas.js";
import { applyRepair, createRepairPreview, getRepairPreview } from "../services/repairs.js";

export function transactionRoutes(deps: AppDependencies): IRouter {
  const router = Router();
  const context = () => ({ db: deps.db, now: deps.clock.now(),
    today: easternDate(deps.clock.now()), newId: deps.newId });
  const send = (res: Response, outcome: CommandOutcome) => {
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, 200, outcome.body);
  };

  router.get("/transactions", requireSession, (req, res) => {
    // One read transaction: the page and the whole-scope totals share a snapshot.
    const body = deps.db.transaction(() => listTransactions(deps.db, req.query))();
    respond(res, deps.config, TransactionPage, 200, body);
  });

  router.post("/transactions/:transactionId/repair-previews", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(RepairBody, req.body);
    const id = transactionId(req);
    const result = withWriteTransaction(deps.db, () => createRepairPreview(context(), id, input,
      body => checkedResponse(RepairPreview, body)));
    res.setHeader("Location", `/api/transaction-repairs/${result.id}`);
    sendChecked(res, 201, result.body);
  });
  router.get("/transaction-repairs/:repairId", requireSession, (req, res) => {
    const id = repairId(req);
    const body = deps.db.transaction(() => getRepairPreview(deps.db, id, deps.clock.now()))();
    respond(res, deps.config, RepairPreview, 200, body);
  });
  router.post("/transaction-repairs/:repairId/apply", requireSession, requireCsrf, (req, res) => {
    const { confirmUnlinking } = validateBody(ApplyBody, req.body);
    const id = repairId(req);
    const body = withWriteTransaction(deps.db, () => applyRepair(context(), id, confirmUnlinking,
      value => checkedResponse(RepairResult, value)));
    sendChecked(res, 200, body);
  });

  router.post("/transactions/:transactionId/categorize", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const input = validateBody(CategorizeBody, req.body);
    const id = transactionId(req);
    send(res, withWriteTransaction(deps.db, () => categorizeTransaction(context(), id, expected, input,
      body => checkedResponse(CategorizeResult, body))));
  });

  router.post("/transactions/:transactionId/return-to-rules", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = transactionId(req);
    send(res, withWriteTransaction(deps.db, () => returnTransactionToRules(context(), id, expected,
      body => checkedResponse(TransactionResult, body))));
  });

  router.post("/transactions/:transactionId/classify", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const input = validateBody(ClassifyBody, req.body);
    const id = transactionId(req);
    send(res, withWriteTransaction(deps.db, () => classifyTransaction(context(), id, expected, input,
      body => checkedResponse(ClassifyResult, body))));
  });

  router.get("/transactions/:transactionId/transfer-candidates", requireSession, (req, res) => {
    const id = transactionId(req);
    const body = deps.db.transaction(() => transferCandidates(deps.db, id, req.query))();
    respond(res, deps.config, TransferCandidateList, 200, body);
  });

  router.get("/transactions/:transactionId/refund-candidates", requireSession, (req, res) => {
    const id = transactionId(req);
    const body = deps.db.transaction(() => refundCandidates(deps.db, id, req.query))();
    respond(res, deps.config, RefundCandidatePage, 200, body);
  });

  router.patch("/transactions/:transactionId/note", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const { note } = validateBody(UpdateNoteBody, req.body);
    const id = transactionId(req);
    send(res, withWriteTransaction(deps.db, () => updateTransactionNote(context(), id, expected, note ?? null,
      body => checkedResponse(TransactionResult, body))));
  });

  router.get("/transactions/:transactionId", requireSession, (req, res) => {
    const id = transactionId(req);
    const result = deps.db.transaction(() => {
      const row = requireTransaction(deps.db, id);
      return { version: row.version, body: transactionDto(deps.db, row) };
    })();
    res.setHeader("ETag", etag(result.version));
    respond(res, deps.config, Transaction, 200, result.body);
  });
  router.get("/transactions/:transactionId/history", requireSession, (req, res) => {
    const id = transactionId(req);
    const body = deps.db.transaction(() => transactionHistory(deps.db, id, req.query))();
    respond(res, deps.config, HistoryPage, 200, body);
  });
  return router;
}

function transactionId(req: Request): string {
  const id = req.params["transactionId"];
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no transaction with that id." });
  }
  return id.toLowerCase();
}

function repairId(req: Request): string {
  const id = req.params["repairId"];
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no repair with that id." });
  }
  return id.toLowerCase();
}
