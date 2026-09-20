import { Router, type IRouter, type Request } from "express";
import { withWriteTransaction } from "@workspace/db";
import { GetPreferencesResponse, UpdatePreferencesBody, UpdatePreferencesResponse } from "@workspace/api-zod";

import type { AppDependencies } from "../deps.js";
import { problem } from "../lib/problem.js";
import { respond } from "../lib/respond.js";
import { requireAtLeastOneProperty, validateBody } from "../lib/validate.js";
import { requireCsrf, requireSession } from "../middlewares/session.js";

interface PreferencesRow {
  display_name: string;
  density: string;
  version: bigint;
}

export function preferencesRoutes(deps: AppDependencies): IRouter {
  const router = Router();

  router.get("/preferences", requireSession, (_req, res) => {
    const row = readPreferences(deps);
    res.setHeader("ETag", etag(row.version));
    respond(res, deps.config, GetPreferencesResponse, 200, toBody(row));
  });

  router.patch("/preferences", requireSession, requireCsrf, (req, res) => {
    // Precondition first: telling the owner their edit is malformed when the
    // real problem is a missing version would send them down the wrong path.
    const expected = requiredIfMatch(req);
    requireAtLeastOneProperty(req.body);
    const patch = validateBody(UpdatePreferencesBody, req.body);

    const saved = withWriteTransaction(deps.db, () => {
      const row = readPreferences(deps);
      if (etag(row.version) !== expected) {
        throw problem({
          status: 412,
          code: "version_mismatch",
          title: "Someone else changed this first",
          detail: "These preferences changed since you loaded them. Reload and try again.",
          currentVersion: String(row.version),
        });
      }
      const next = {
        display_name: patch.displayName ?? row.display_name,
        density: patch.density ?? row.density,
        version: row.version + 1n,
      };
      deps.db
        .prepare(
          "UPDATE preferences SET display_name = ?, density = ?, version = ?, updated_at = ? WHERE id = 1",
        )
        .run(next.display_name, next.density, next.version, deps.clock.now());
      return next as PreferencesRow;
    });

    res.setHeader("ETag", etag(saved.version));
    respond(res, deps.config, UpdatePreferencesResponse, 200, toBody(saved));
  });

  return router;
}

/**
 * Express lowercases header names; the generated schema keys them as they
 * appear in the contract, so the mapping is done explicitly here rather than
 * relying on the two happening to agree.
 */
function requiredIfMatch(req: Request): string {
  const value = req.get("if-match");
  if (value === undefined || value.trim() === "") {
    throw problem({
      status: 428,
      code: "precondition_required",
      title: "Confirmation needed",
      detail: "Send the version you are changing (If-Match).",
    });
  }
  // Present but unusable is a bad request, not a missing precondition: the
  // client did send something, it just is not a version this API issued.
  if (!/^"[1-9][0-9]{0,17}"$/.test(value.trim())) {
    throw problem({
      status: 400,
      code: "invalid_request",
      title: "Could not read the request",
      detail: "The version supplied with this change was not in the expected form.",
    });
  }
  return value.trim();
}

function readPreferences(deps: AppDependencies): PreferencesRow {
  return deps.db
    .prepare("SELECT display_name, density, version FROM preferences WHERE id = 1")
    .get() as PreferencesRow;
}

function etag(version: bigint): string {
  return `"${String(version)}"`;
}

function toBody(row: PreferencesRow): Record<string, unknown> {
  return {
    displayName: row.display_name,
    density: row.density,
    currency: "USD",
    timezone: "America/New_York",
    version: String(row.version),
  };
}
