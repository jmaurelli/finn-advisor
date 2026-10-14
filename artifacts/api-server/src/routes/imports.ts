import { Router, type IRouter, type Request, type Response } from "express";
import { withWriteTransaction } from "@workspace/db";

import type { AppDependencies } from "../deps.js";
import { creationDigest } from "../domain/digest.js";
import { etag, requireIfMatch } from "../domain/versions.js";
import {
  BulkTypeBody, BulkTypeResult, ImportBatchDto, ImportCreateResult, ImportFormatList, ImportPage,
  ImportRefreshResult, ImportRowPage, ImportRowPatch, ImportRowResult,
} from "../lib/import-schemas.js";
import { CommitImportResponse, CreateImportFollowUpBody, CreateImportFollowUpResponse,
  DiscardImportResponse, ListImportRowsQueryParams } from "@workspace/api-zod";
import { createImportFollowUp } from "../services/import-follow-ups.js";
import { deletePendingImportUploads, discardImport } from "../services/import-retention.js";
import { easternDate } from "../domain/dates.js";
import { commitImport } from "../services/import-posting.js";
import { bulkSetRowType, listImportRows, refreshImport, saveImportRow } from "../services/import-review.js";
import { problem } from "../lib/problem.js";
import { checkedResponse, respond, sendChecked } from "../lib/respond.js";
import { requireAtLeastOneProperty, validateBody } from "../lib/validate.js";
import { readSessionCookie, requireCsrf, requireSession } from "../middlewares/session.js";
import { lookupSession } from "../auth/sessions.js";
import { ImportBusyError } from "../imports/admission.js";
import { MultipartError, readMultipartUpload } from "../imports/multipart.js";
import { sanitizeDisplayFilename, UploadStoreError } from "../imports/upload-store.js";
import type { ImportAdapter } from "../imports/adapters.js";
import { findAccount, requireAccount } from "../services/ledger.js";
import {
  createReceivedBatch, failBatch, findFileClaim, importBatchDto, importCreateResult,
  importFailureOf, listImports, markUploadDeleted, parseStoredUpload, publishPreviewUnlessClaimed,
  requireBatch, type ImportBatchRow,
} from "../services/imports.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function importRoutes(deps: AppDependencies): IRouter {
  const router = Router();
  const context = () => ({ db: deps.db, now: deps.clock.now(), newId: deps.newId });

  router.get("/import-formats", requireSession, (_req, res) => {
    respond(res, deps.config, ImportFormatList, 200, { items: deps.adapters.list() });
  });

  router.get("/imports", requireSession, (req, res) => {
    respond(res, deps.config, ImportPage, 200, listImports(deps.db, filters(req), pageLimit(req), cursorOf(req)));
  });

  router.get("/imports/:importId", requireSession, (req, res) => {
    const row = requireBatch(deps.db, importId(req));
    res.setHeader("ETag", etag(row.version));
    respond(res, deps.config, ImportBatchDto, 200, importBatchDto(deps.db, row));
  });

  router.get("/imports/:importId/rows", requireSession, (req, res) => {
    const raw = req.query;
    if (Object.values(raw).some(value => typeof value !== "string")) {
      throw problem({ status: 400, code: "invalid_request", title: "Unusable filter",
        detail: "Supply each filter or page option once, as a single value." });
    }
    const query = ListImportRowsQueryParams.safeParse(raw);
    if (!query.success) {
      throw problem({ status: 400, code: raw["cursor"] === undefined ? "invalid_request" : "invalid_cursor",
        title: "Unusable list options", detail: "Check the row state, cursor and page size." });
    }
    respond(res, deps.config, ImportRowPage, 200,
      listImportRows(deps.db, deps.clock.now(), importId(req), query.data));
  });

  router.patch("/imports/:importId/rows/:rowId", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    requireAtLeastOneProperty(req.body);
    const patch = validateBody(ImportRowPatch, req.body);
    const id = importId(req);
    const rowId = pathUuid(req, "rowId", "There is no row with that id in this import.");
    const outcome = withWriteTransaction(deps.db, () => saveImportRow(context(), id, rowId, expected, patch,
      body => checkedResponse(ImportRowResult, body)));
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, 200, outcome.body);
  });

  router.post("/imports/:importId/rows/bulk-type", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const input = validateBody(BulkTypeBody, req.body);
    const id = importId(req);
    const outcome = withWriteTransaction(deps.db, () => bulkSetRowType(context(), id, expected,
      { rowId: input.rowId.toLowerCase(), kind: input.kind },
      body => checkedResponse(BulkTypeResult, body)));
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, 200, outcome.body);
  });

  router.post("/imports/:importId/refresh", requireSession, requireCsrf, (req, res) => {
    const expected = requireIfMatch(req.headers["if-match"]);
    const id = importId(req);
    const outcome = withWriteTransaction(deps.db, () => refreshImport(context(), id, expected,
      body => checkedResponse(ImportRefreshResult, body)));
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, 200, outcome.body);
  });

  router.post("/imports/:importId/commit", requireSession, requireCsrf, (req, res) => {
    const id = importId(req);
    const outcome = withWriteTransaction(deps.db, () => {
      const now = deps.clock.now();
      const session = lookupSession(deps.db, readSessionCookie(req), now);
      if (session.state !== "active") throw problem({ status: 401,
        code: session.state === "expired" ? "session_expired" : "not_authenticated",
        title: "Sign in required", detail: "Sign in again before confirming this import." });
      return commitImport({ db: deps.db, now, today: easternDate(now), newId: deps.newId }, id,
        req.headers["if-match"], body => checkedResponse(CommitImportResponse, body));
    });
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, 200, outcome.body);
  });

  router.post("/imports/:importId/discard", requireSession, requireCsrf, async (req, res) => {
    const id = importId(req);
    const expected = requireIfMatch(req.headers["if-match"]);
    const outcome = withWriteTransaction(deps.db, () => discardImport(context(), id, expected,
      body => checkedResponse(DiscardImportResponse, body)));
    await deletePendingImportUploads(deps);
    res.setHeader("ETag", etag(outcome.version));
    sendChecked(res, 200, outcome.body);
  });

  router.post("/imports/:importId/follow-ups", requireSession, requireCsrf, (req, res) => {
    const parent = importId(req);
    const input = validateBody(CreateImportFollowUpBody, req.body);
    const outcome = withWriteTransaction(deps.db, () => createImportFollowUp(context(), parent,
      input.id.toLowerCase(), body => checkedResponse(CreateImportFollowUpResponse, body)));
    if (outcome.status === 201) res.setHeader("Location", `/api/imports/${outcome.id}`);
    sendChecked(res, outcome.status, outcome.body);
  });

  /**
   * The order of work here is the security property: the session, the origin
   * and the CSRF token are settled by middleware before this handler runs, and
   * the destination account and format are checked when the file part begins,
   * before any of its bytes are stored.
   *
   * The whole job - receiving the bytes and parsing them - holds one of a
   * small number of slots, so concurrent uploads cannot multiply the memory a
   * single one is allowed.
   */
  router.post("/imports", requireSession, requireCsrf, async (req, res, next) => {
    try {
      await deps.importJobs.run(() => createImport(deps, context, req, res));
    } catch (error) {
      if (!req.complete && !req.destroyed) {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
      }
      next(translate(error));
    }
  });

  return router;
}

async function createImport(
  deps: AppDependencies,
  context: () => { db: AppDependencies["db"]; now: number; newId: () => string },
  req: Request,
  res: Response,
): Promise<void> {
  if (req.is("multipart/form-data") !== "multipart/form-data") {
    throw new MultipartError("not_multipart");
  }
  let adapter: ImportAdapter | undefined;
  let accountId: string | undefined;

  const upload = await readMultipartUpload(req, {
    headers: req.headers as Parameters<typeof readMultipartUpload>[1]["headers"],
    requiredFields: ["accountId", "formatId"],
    authorize: fields => {
      // Re-read the account here rather than trusting anything cached: this is
      // the last point before bytes are stored.
      accountId = canonicalUuid(fields["accountId"]);
      const account = requireAccount(deps.db, accountId);
      if (account.archived_at !== null) {
        throw problem({ status: 409, code: "reactivation_required", title: "Account is archived",
          detail: "Reactivate this account before importing into it." });
      }
      adapter = deps.adapters.get(fields["formatId"] ?? "");
      if (adapter === undefined) {
        throw problem({ status: 422, code: "unsupported_file_format", title: "Format not available",
          detail: "That bank format is not available for import yet." });
      }
      if (adapter.accountKind !== account.kind) {
        throw problem({ status: 422, code: "unsupported_file_format", title: "Format does not fit this account",
          detail: "That bank format is for a different kind of account." });
      }
    },
    consume: file => deps.uploads.receive(file),
  });

  const received = upload.accepted;
  const filename = sanitizeDisplayFilename(upload.filename);

  // Receiving a large file takes time, and the checks made when it started can
  // have gone stale meanwhile: the session may have expired and the account may
  // have been archived. Both are rechecked before anything is written, and the
  // bytes are discarded rather than left behind if either has.
  await recheckAfterReceipt(deps, req, accountId!, received.storageKey);

  // The same file, already handled for this account, is that earlier outcome
  // rather than a second preview. The bytes just received are redundant.
  const claimed = findFileClaim(deps.db, accountId!, received.sha256);
  if (claimed !== undefined) {
    await deps.uploads.remove(received.storageKey);
    sendExisting(deps, res, requireBatch(deps.db, claimed));
    return;
  }

  const batch = withWriteTransaction(deps.db, () => createReceivedBatch(context(), {
    accountId: accountId!,
    adapter: adapter!,
    filename,
    sha256: received.sha256,
    byteSize: received.byteSize,
    storageKey: received.storageKey,
    creationDigest: creationDigest({ accountId: accountId!, sha256: received.sha256, formatId: adapter!.id }),
  }));

  // Parsing happens outside any transaction, against the bytes already on
  // disk, so the read can be repeated deterministically after a restart.
  let parsed;
  try {
    parsed = await parseStoredUpload(adapter!, await deps.uploads.read(received.storageKey));
  } catch (error) {
    const failure = importFailureOf(error);
    if (failure === undefined) throw error;
    withWriteTransaction(deps.db, () => { failBatch(context(), batch, failure); });
    const failed = requireBatch(deps.db, batch.id);
    res.setHeader("Location", `/api/imports/${batch.id}`);
    res.setHeader("ETag", etag(failed.version));
    respond(res, deps.config, ImportCreateResult, 201, importCreateResult(deps.db, failed, "created"));
    return;
  }

  // One write publishes every row, the status and the file claim together -
  // or, if a simultaneous upload of the same file got there first, gives way
  // to it rather than publishing a second preview of the same bytes.
  const owner = withWriteTransaction(deps.db,
    () => publishPreviewUnlessClaimed(context(), batch, parsed, received.sha256));
  if (owner === batch.id) {
    const ended = requireBatch(deps.db, batch.id);
    res.setHeader("Location", `/api/imports/${batch.id}`);
    res.setHeader("ETag", etag(ended.version));
    respond(res, deps.config, ImportCreateResult, 201, importCreateResult(deps.db, ended, "created"));
    return;
  }
  if (owner !== null) {
    await deps.uploads.remove(received.storageKey);
    withWriteTransaction(deps.db, () => {
      markUploadDeleted(deps.db, received.storageKey, deps.clock.now());
    });
    sendExisting(deps, res, requireBatch(deps.db, owner));
    return;
  }

  const published = requireBatch(deps.db, batch.id);
  res.setHeader("Location", `/api/imports/${batch.id}`);
  res.setHeader("ETag", etag(published.version));
  respond(res, deps.config, ImportCreateResult, 201, importCreateResult(deps.db, published, "created"));
}

/** The one preview or completed import this account already has for these bytes. */
function sendExisting(deps: AppDependencies, res: Response, existing: ImportBatchRow): void {
  const disposition = existing.status === "committed" ? "existing_completed" : "existing_preview";
  res.setHeader("ETag", etag(existing.version));
  respond(res, deps.config, ImportCreateResult, 200, importCreateResult(deps.db, existing, disposition));
}

/**
 * The state of the world after an asynchronous receipt, re-read rather than
 * remembered. Discards the bytes before refusing, so a refused upload leaves
 * nothing to clean up later.
 */
async function recheckAfterReceipt(
  deps: AppDependencies,
  req: Request,
  accountId: string,
  storageKey: string,
): Promise<void> {
  const discardAndThrow = async (failure: unknown): Promise<never> => {
    await deps.uploads.remove(storageKey);
    throw failure;
  };

  const session = lookupSession(deps.db, readSessionCookie(req), deps.clock.now());
  if (session.state !== "active") {
    await discardAndThrow(session.state === "expired"
      ? problem({ status: 401, code: "session_expired", title: "Signed out",
        detail: "The session ended while the file was uploading. Sign in again and retry." })
      : problem({ status: 401, code: "not_authenticated", title: "Sign in required",
        detail: "Sign in to continue." }));
  }

  const account = findAccount(deps.db, accountId);
  if (account === undefined) {
    await discardAndThrow(problem({ status: 404, code: "not_found", title: "Not found",
      detail: "There is no account with that id." }));
  } else if (account.archived_at !== null) {
    await discardAndThrow(problem({ status: 409, code: "reactivation_required", title: "Account is archived",
      detail: "This account was archived while the file was uploading. Reactivate it and retry." }));
  }
}

/** Store and parser failures become the contract's own declared responses. */
function translate(error: unknown): unknown {
  if (error instanceof ImportBusyError) {
    return problem({ status: 503, code: "service_busy", title: "Busy",
      detail: "Another import is still being processed. Try again in a moment.", retryAfterSeconds: 30 });
  }
  if (error instanceof MultipartError) {
    if (error.code === "file_too_large") {
      return problem({ status: 413, code: "payload_too_large", title: "Too large", detail: error.message });
    }
    if (error.code === "not_multipart") {
      return problem({ status: 415, code: "unsupported_media_type", title: "Unsupported format", detail: error.message });
    }
    return problem({ status: 422, code: "validation_failed", title: "That upload could not be read",
      detail: error.message });
  }
  if (error instanceof UploadStoreError) {
    // Exhaustive on purpose. A blanket 422 fallback used to answer "that
    // upload could not be read" to a broken disk, blaming the owner's file
    // for the store's fault; a new failure code must be classified here
    // rather than inheriting that answer.
    switch (error.code) {
      case "storage_capacity_exhausted":
        return problem({ status: 503, code: "service_busy", title: "Busy",
          detail: "Another import is still being stored. Try again in a moment.", retryAfterSeconds: 30 });
      case "upload_too_large":
        return problem({ status: 413, code: "payload_too_large", title: "Too large", detail: error.message });
      case "upload_incomplete":
        return problem({ status: 422, code: "validation_failed", title: "That upload could not be read",
          detail: error.message });
      case "storage_unavailable":
        // No Retry-After: an unusable store is not a wait-and-retry condition,
        // and a retry hint that cannot come true only wastes the owner's time.
        return problem({ status: 503, code: "storage_unavailable", title: "Upload storage unavailable",
          detail: "Uploads cannot be stored right now. This is a problem with the app's storage, not with your file." });
    }
  }
  return error;
}

function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no account with that id." });
  }
  return value.toLowerCase();
}

function pathUuid(req: Request, name: string, detail: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !UUID.test(value)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail });
  }
  return value.toLowerCase();
}

function importId(req: Request): string {
  const id = req.params["importId"];
  if (typeof id !== "string" || !UUID.test(id)) {
    throw problem({ status: 404, code: "not_found", title: "Not found", detail: "There is no import with that id." });
  }
  return id.toLowerCase();
}

function filters(req: Request): { accountId?: string; status?: string } {
  const result: { accountId?: string; status?: string } = {};
  const accountId = req.query["accountId"];
  if (accountId !== undefined) {
    if (typeof accountId !== "string" || !UUID.test(accountId)) {
      throw problem({ status: 400, code: "invalid_request", title: "Unusable filter",
        detail: "The account filter must be an id." });
    }
    result.accountId = accountId.toLowerCase();
  }
  const status = req.query["status"];
  if (status !== undefined) {
    const allowed = ["receiving", "parsing", "preview", "committed", "cancelled", "expired", "failed"];
    if (typeof status !== "string" || !allowed.includes(status)) {
      throw problem({ status: 400, code: "invalid_request", title: "Unusable filter",
        detail: "That is not an import status." });
    }
    result.status = status;
  }
  return result;
}

function pageLimit(req: Request): number {
  const raw = req.query["limit"];
  if (raw === undefined) return DEFAULT_LIMIT;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw problem({ status: 400, code: "invalid_request", title: "Unusable page size",
      detail: `Ask for between 1 and ${String(MAX_LIMIT)} records.` });
  }
  return limit;
}

function cursorOf(req: Request): { createdAt: number; id: string } | undefined {
  const raw = req.query["cursor"];
  if (raw === undefined) return undefined;
  const invalid = () => problem({ status: 400, code: "invalid_cursor", title: "The list position is not valid",
    detail: "Reload the list from the first page." });
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(raw)) throw invalid();
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw invalid();
    const parsed = JSON.parse(bytes.toString("utf8")) as { v?: unknown; createdAt?: unknown; id?: unknown };
    if (parsed.v !== 1 || typeof parsed.createdAt !== "number" || typeof parsed.id !== "string") throw invalid();
    return { createdAt: parsed.createdAt, id: parsed.id.toLowerCase() };
  } catch {
    throw invalid();
  }
}
