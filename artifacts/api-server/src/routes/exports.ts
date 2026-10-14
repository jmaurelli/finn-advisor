/**
 * Downloads. Both are reads of a snapshot, both are attachments, and neither
 * may be cached: a stale copy of someone's ledger is worse than a slow one.
 */
import { Router, type IRouter } from "express";
import { ExportLedgerJsonResponse } from "@workspace/api-zod";

import type { AppDependencies } from "../deps.js";
import { easternDate } from "../domain/dates.js";
import { exportTransactionsCsv } from "../services/exports-csv.js";
import { exportLedger } from "../services/exports-ledger.js";
import { respond } from "../lib/respond.js";
import { requireSession } from "../middlewares/session.js";

/**
 * The filename is quoted and built from a fixed pattern plus a calendar date,
 * so there is nothing in it that could carry a quote, a newline or a path
 * separator into the header.
 */
function attach(filename: string): string {
  return `attachment; filename="${filename}"`;
}

export function exportRoutes(deps: AppDependencies): IRouter {
  const router = Router();

  router.get("/exports/transactions.csv", requireSession, (req, res) => {
    const file = exportTransactionsCsv(deps.db, req.query as Record<string, unknown>,
      easternDate(deps.clock.now()));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", attach(file.filename));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(file.body);
  });

  router.get("/exports/ledger.json", requireSession, (_req, res) => {
    const now = deps.clock.now();
    const body = exportLedger(deps.db, now, easternDate(now));
    res.setHeader("Content-Disposition", attach(`money-desk-ledger-${easternDate(now)}.json`));
    res.setHeader("Cache-Control", "no-store");
    // Validated against the contract like every other response: an export the
    // document does not describe is a worse failure than a slow one.
    respond(res, deps.config, ExportLedgerJsonResponse, 200, body);
  });

  return router;
}
