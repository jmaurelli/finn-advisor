import { Router, type IRouter, type Request } from "express";
import { withWriteTransaction } from "@workspace/db";
import {
  ArchiveAccountResponse,
  ChangeAccountBaselineBody,
  ChangeAccountBaselineResponse,
  CreateAccountBody,
  CreateAccountResponse,
  CreateCheckpointBody,
  CreateCheckpointResponse,
  GetAccountBalanceResponse,
  GetAccountResponse,
  GetCheckpointHistoryResponse,
  ListAccountsResponse,
  ListCheckpointsResponse,
  ReactivateAccountResponse,
  RecheckCheckpointResponse,
  UpdateAccountBody,
  UpdateAccountResponse,
} from "@workspace/api-zod";

import type { AppDependencies } from "../deps.js";
import { assertCalendarDate, easternDate } from "../domain/dates.js";
import { aggregateMoney } from "../domain/money.js";
import { balanceAt, lastPostedDate } from "../domain/balances.js";
import { etag, requireIfMatch, versionMismatch } from "../domain/versions.js";
import { problem } from "../lib/problem.js";
import { checkedResponse, respond, sendChecked } from "../lib/respond.js";
import { requireAtLeastOneProperty, validateBody } from "../lib/validate.js";
import { requireCsrf, requireSession } from "../middlewares/session.js";
import {
  createAccount,
  deleteAccount,
  listAccounts,
  setArchived,
  updateAccount,
} from "../services/accounts.js";
import {
  accountDto,
  baselineOf,
  financeRevision,
  requireAccount,
  type AccountRow,
} from "../services/ledger.js";
import { changeBaseline } from "../services/baselines.js";
import {
  checkpointDto,
  checkpointDtos,
  checkpointHistory,
  createCheckpoint,
  recheck,
  requireCheckpoint,
} from "../services/checkpoints.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function accountRoutes(deps: AppDependencies): IRouter {
  const router = Router();

  const context = (): {
    db: typeof deps.db;
    now: number;
    today: string;
    newId: () => string;
  } => ({
    db: deps.db,
    now: deps.clock.now(),
    today: easternDate(deps.clock.now()),
    newId: deps.newId,
  });

  router.get("/accounts", requireSession, (req, res) => {
    const status = statusFilter(req);
    const today = easternDate(deps.clock.now());
    const items = listAccounts(deps.db, status).map((row) => accountDto(deps.db, row, today));
    respond(res, deps.config, ListAccountsResponse, 200, {
      items,
      financeRevision: String(financeRevision(deps.db)),
    });
  });

  router.post("/accounts", requireSession, requireCsrf, (req, res) => {
    const body = canonicalId(validateBody(CreateAccountBody, req.body));

    const result = withWriteTransaction(deps.db, () => {
      const created = createAccount(context(), body);
      return {
        status: created.status,
        body: checkedResponse(CreateAccountResponse, {
          account: accountDto(deps.db, created.row, easternDate(deps.clock.now())),
          financeRevision: String(financeRevision(deps.db)),
        }),
        version: created.row.version,
      };
    });

    res.setHeader("ETag", etag(result.version));
    if (result.status === 201) res.setHeader("Location", `/api/accounts/${body.id}`);
    sendChecked(res, result.status, result.body);
  });

  router.get("/accounts/:accountId", requireSession, (req, res) => {
    const account = requireAccount(deps.db, accountId(req));
    res.setHeader("ETag", etag(account.version));
    respond(
      res,
      deps.config,
      GetAccountResponse,
      200,
      accountDto(deps.db, account, easternDate(deps.clock.now())),
    );
  });

  router.patch("/accounts/:accountId", requireSession, requireCsrf, (req, res) => {
    // Precondition before body, as elsewhere: telling the owner their edit is
    // malformed when the real problem is a missing version sends them down
    // the wrong path.
    const expected = requireIfMatch(req.headers["if-match"]);
    requireAtLeastOneProperty(req.body);
    const patch = validateBody(UpdateAccountBody, req.body);
    const id = accountId(req);

    const result = withWriteTransaction(deps.db, () => {
      const account = expectVersion(requireAccount(deps.db, id), expected);
      const updated = updateAccount(context(), account, patch);
      return {
        body: checkedResponse(UpdateAccountResponse, {
          account: accountDto(deps.db, updated, easternDate(deps.clock.now())),
          financeRevision: String(financeRevision(deps.db)),
        }),
        version: updated.version,
      };
    });

    res.setHeader("ETag", etag(result.version));
    sendChecked(res, 200, result.body);
  });

  router.delete("/accounts/:accountId", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = accountId(req);

    withWriteTransaction(deps.db, () => {
      const account = expectVersion(requireAccount(deps.db, id), expected);
      deleteAccount(context(), account);
    });

    res.status(204).end();
  });

  for (const [path, archived, schema] of [
    ["archive", true, ArchiveAccountResponse],
    ["reactivate", false, ReactivateAccountResponse],
  ] as const) {
    router.post(`/accounts/:accountId/${path}`, requireSession, requireCsrf, (req, res) => {
      const expected = requireIfMatch(req.headers["if-match"]);
      const id = accountId(req);

      const result = withWriteTransaction(deps.db, () => {
        const account = expectVersion(requireAccount(deps.db, id), expected);
        const changed = setArchived(context(), account, archived);
        return {
          body: checkedResponse(schema, {
            account: accountDto(deps.db, changed, easternDate(deps.clock.now())),
            financeRevision: String(financeRevision(deps.db)),
          }),
          version: changed.version,
        };
      });

      res.setHeader("ETag", etag(result.version));
      sendChecked(res, 200, result.body);
    });
  }

  router.get("/accounts/:accountId/balance", requireSession, (req, res) => {
    const account = requireAccount(deps.db, accountId(req));
    const asOf = requiredDate(req.query["asOf"], "asOf");
    const { balance, coverage } = balanceAt(deps.db, baselineOf(account), asOf);

    respond(res, deps.config, GetAccountBalanceResponse, 200, {
      accountId: account.id,
      asOf,
      coverage,
      // Null, not a fabricated zero: an uncovered date has no balance, and a
      // zero would be indistinguishable from a real zero balance.
      balance: balance === null ? null : aggregateMoney(balance),
      trackingStartDate: account.tracking_start_date,
      lastImportedPostedDate: lastPostedDate(deps.db, account.id),
      ledgerRevision: String(account.ledger_revision),
    });
  });

  router.post("/accounts/:accountId/baseline", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const body = validateBody(ChangeAccountBaselineBody, req.body);
    const id = accountId(req);

    const result = withWriteTransaction(deps.db, () => {
      const account = expectVersion(requireAccount(deps.db, id), expected);
      const outcome = changeBaseline(context(), account, body);
      return {
        body: checkedResponse(ChangeAccountBaselineResponse, {
          account: accountDto(deps.db, outcome.account, easternDate(deps.clock.now())),
          postedTransactionIds: outcome.postedTransactionIds,
          financeRevision: String(financeRevision(deps.db)),
        }),
        version: outcome.account.version,
      };
    });

    res.setHeader("ETag", etag(result.version));
    sendChecked(res, 200, result.body);
  });

  router.get("/accounts/:accountId/checkpoints", requireSession, (req, res) => {
    const account = requireAccount(deps.db, accountId(req));
    respond(res, deps.config, ListCheckpointsResponse, 200, {
      items: checkpointDtos(deps.db, account),
      financeRevision: String(financeRevision(deps.db)),
    });
  });

  router.post("/accounts/:accountId/checkpoints", requireSession, requireCsrf, (req, res) => {
    const body = canonicalId(validateBody(CreateCheckpointBody, req.body));
    const id = accountId(req);

    const result = withWriteTransaction(deps.db, () => {
      const account = requireAccount(deps.db, id);
      const created = createCheckpoint(context(), account, body);
      return {
        status: created.status,
        body: checkedResponse(CreateCheckpointResponse, {
          checkpoint: checkpointDto(deps.db, account, created.checkpoint),
          financeRevision: String(financeRevision(deps.db)),
        }),
        version: created.checkpoint.version,
      };
    });

    res.setHeader("ETag", etag(result.version));
    sendChecked(res, result.status, result.body);
  });

  router.get(
    "/accounts/:accountId/checkpoints/:checkpointId/history",
    requireSession,
    (req, res) => {
      const account = requireAccount(deps.db, accountId(req));
      const checkpoint = requireCheckpoint(deps.db, account.id, pathId(req, "checkpointId"));
      res.setHeader("ETag", etag(checkpoint.version));
      respond(
        res,
        deps.config,
        GetCheckpointHistoryResponse,
        200,
        checkpointHistory(deps.db, checkpoint),
      );
    },
  );

  router.post(
    "/accounts/:accountId/checkpoints/:checkpointId/recheck",
    requireSession,
    requireCsrf,
    (req, res) => {
      const expected = requireIfMatch(req.headers["if-match"]);
      const id = accountId(req);
      const checkpointId = pathId(req, "checkpointId");

      const result = withWriteTransaction(deps.db, () => {
        const account = requireAccount(deps.db, id);
        const checkpoint = requireCheckpoint(deps.db, account.id, checkpointId);
        if (checkpoint.version !== expected) throw versionMismatch(checkpoint.version);
        const updated = recheck(context(), account, checkpoint);
        return {
          body: checkedResponse(RecheckCheckpointResponse, {
            checkpoint: checkpointDto(deps.db, account, updated),
            financeRevision: String(financeRevision(deps.db)),
          }),
          version: updated.version,
        };
      });

      res.setHeader("ETag", etag(result.version));
      sendChecked(res, 200, result.body);
    },
  );

  return router;
}

function requiredDate(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw === "") {
    throw problem({
      status: 400,
      code: "invalid_request",
      title: "Missing date",
      detail: `This request needs a ${name} date.`,
    });
  }
  try {
    return assertCalendarDate(raw);
  } catch {
    throw problem({
      status: 400,
      code: "invalid_request",
      title: "Not a real date",
      detail: `The ${name} value is not a calendar date.`,
    });
  }
}

function pathId(req: Request, name: string): string {
  const id = req.params[name];
  if (typeof id !== "string" || !UUID.test(id)) {
    throw problem({
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "There is nothing with that id.",
    });
  }
  return id.toLowerCase();
}

function statusFilter(req: Request): string {
  const raw = req.query["status"];
  if (raw === undefined) return "active";
  if (typeof raw !== "string" || !["active", "archived", "all"].includes(raw)) {
    throw problem({
      status: 400,
      code: "invalid_request",
      title: "Unknown filter",
      detail: "That account filter is not one this service understands.",
    });
  }
  return raw;
}

function accountId(req: Request): string {
  const id = req.params["accountId"];
  if (typeof id !== "string" || !UUID.test(id)) {
    // A malformed id can never name a record, so it is a 404 rather than a
    // validation failure: there is nothing there either way.
    throw problem({
      status: 404,
      code: "not_found",
      title: "Not found",
      detail: "There is no account with that id.",
    });
  }
  return id.toLowerCase();
}

/**
 * Ids are stored in lower case. The contract's `uuid` format accepts either
 * case, and without this an upper-case id created a second account that the
 * lower-case spelling of the same id could not find (stage 2 review).
 */
function canonicalId<T extends { id: string }>(body: T): T {
  return { ...body, id: body.id.toLowerCase() };
}

function expectVersion(account: AccountRow, expected: bigint): AccountRow {
  if (account.version !== expected) throw versionMismatch(account.version);
  return account;
}
