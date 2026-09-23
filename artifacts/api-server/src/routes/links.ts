import { Router, type IRouter, type Request } from "express";
import { withWriteTransaction } from "@workspace/db";
import type { AppDependencies } from "../deps.js";
import { easternDate } from "../domain/dates.js";
import { etag, requireIfMatch } from "../domain/versions.js";
import {
  RefundLink, RefundLinkBody, RefundLinkResult, TransferPair, TransferPairBody, TransferPairResult, UnlinkResult,
} from "../lib/link-schemas.js";
import { problem } from "../lib/problem.js";
import { checkedResponse, respond, sendChecked } from "../lib/respond.js";
import { validateBody } from "../lib/validate.js";
import { requireCsrf, requireSession } from "../middlewares/session.js";
import {
  createRefundLink, createTransferPair, deleteRefundLink, deleteTransferPair, refundLinkDto, requirePair,
  requireRefundLink, transferPairDto,
} from "../services/links.js";

export function linkRoutes(deps: AppDependencies): IRouter {
  const router = Router();
  const context = () => ({ db: deps.db, now: deps.clock.now(),
    today: easternDate(deps.clock.now()), newId: deps.newId });

  router.post("/transfer-pairs", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(TransferPairBody, req.body);
    const outcome = withWriteTransaction(deps.db, () => createTransferPair(context(), input,
      body => checkedResponse(TransferPairResult, body)));
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, outcome.status, outcome.body);
  });

  router.get("/transfer-pairs/:linkId", requireSession, (req, res) => {
    const id = linkId(req, "transfer pair");
    const result = deps.db.transaction(() => {
      const pair = requirePair(deps.db, id);
      return { version: pair.version, body: transferPairDto(deps.db, pair) };
    })();
    res.setHeader("ETag", etag(result.version));
    respond(res, deps.config, TransferPair, 200, result.body);
  });

  router.delete("/transfer-pairs/:linkId", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = linkId(req, "transfer pair");
    sendChecked(res, 200, withWriteTransaction(deps.db, () => deleteTransferPair(context(), id, expected,
      body => checkedResponse(UnlinkResult, body))));
  });

  router.post("/refund-links", requireSession, requireCsrf, (req, res) => {
    const input = validateBody(RefundLinkBody, req.body);
    const outcome = withWriteTransaction(deps.db, () => createRefundLink(context(), input,
      body => checkedResponse(RefundLinkResult, body)));
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, outcome.status, outcome.body);
  });

  router.get("/refund-links/:linkId", requireSession, (req, res) => {
    const id = linkId(req, "refund link");
    const link = requireRefundLink(deps.db, id);
    res.setHeader("ETag", etag(link.version));
    respond(res, deps.config, RefundLink, 200, refundLinkDto(link));
  });

  router.delete("/refund-links/:linkId", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = linkId(req, "refund link");
    sendChecked(res, 200, withWriteTransaction(deps.db, () => deleteRefundLink(context(), id, expected,
      body => checkedResponse(UnlinkResult, body))));
  });

  return router;
}

function linkId(req: Request, noun: string): string {
  const id = req.params["linkId"];
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: `There is no ${noun} with that id.` });
  }
  return id.toLowerCase();
}
