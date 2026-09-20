/**
 * Live responses checked against the contract itself.
 *
 * The handlers already validate against the generated zod schemas, but those
 * are a translation. This file compiles `openapi.yaml` directly with Ajv, the
 * same way the contract's own check script does, so a response is measured
 * against the document the owner approved rather than against a derivative.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestServer, TEST_PASSWORD, type TestResponse, type TestServer } from "./harness.js";

const specPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../lib/api-spec/openapi.yaml",
);
const doc = YAML.parse(readFileSync(specPath, "utf8"), { maxAliasCount: -1 }) as Record<
  string,
  unknown
>;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addFormat("binary", true);
ajv.addFormat("password", true);
ajv.addKeyword("discriminator");
ajv.addKeyword("example");
ajv.addSchema(doc, "https://money-desk.invalid/openapi.json");

function validateAgainst(schemaName: string, value: unknown): void {
  const validate = ajv.getSchema(`https://money-desk.invalid/openapi.json#/components/schemas/${schemaName}`) ??
    ajv.compile({ $ref: `https://money-desk.invalid/openapi.json#/components/schemas/${schemaName}` });
  if (!validate(value)) {
    throw new Error(`${schemaName}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}

let api: TestServer;

beforeEach(async () => {
  api = await startTestServer();
});

afterEach(async () => {
  await api.close();
});

function expectProblem(response: TestResponse, code: string): void {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  validateAgainst("Problem", response.body);
  expect((response.body as { code: string }).code).toBe(code);
}

describe("responses match the contract", () => {
  it("healthz, readyz and the signed-out session", async () => {
    validateAgainst("HealthStatus", (await api.request("/api/healthz")).body);
    validateAgainst("ReadinessStatus", (await api.request("/api/readyz")).body);
    validateAgainst("SessionState", (await api.request("/api/session")).body);
  });

  it("sign-in, session state, activity and preferences", async () => {
    validateAgainst("SignedInSession", (await api.login()).body);
    validateAgainst("SessionState", (await api.request("/api/session")).body);
    validateAgainst(
      "SignedInSession",
      (await api.request("/api/session/activity", { method: "POST" })).body,
    );

    const preferences = await api.request("/api/preferences");
    validateAgainst("Preferences", preferences.body);

    const updated = await api.request("/api/preferences", {
      method: "PATCH",
      body: { displayName: "Household" },
      headers: { "if-match": preferences.headers.get("etag")! },
    });
    validateAgainst("Preferences", updated.body);
  });

  it("every error response is a valid problem document with no-store", async () => {
    expectProblem(await api.request("/api/preferences"), "not_authenticated");
    expectProblem(await api.request("/api/nothing-here"), "not_found");
    expectProblem(await api.login("wrong-password"), "invalid_credentials");
    expectProblem(
      await api.request("/api/session/login", {
        method: "POST",
        body: { password: TEST_PASSWORD },
        headers: { origin: "https://evil.example" },
      }),
      "origin_rejected",
    );
    expectProblem(
      await api.request("/api/session/login", {
        method: "POST",
        rawBody: "password=x",
        contentType: "application/x-www-form-urlencoded",
      }),
      "unsupported_media_type",
    );
    expectProblem(
      await api.request("/api/session/login", { method: "POST", body: { nope: 1 } }),
      "validation_failed",
    );

    await api.login();
    expectProblem(
      await api.request("/api/session/activity", { method: "POST", csrfToken: null }),
      "csrf_invalid",
    );
    expectProblem(
      await api.request("/api/preferences", { method: "PATCH", body: { density: "compact" } }),
      "precondition_required",
    );
    await api.request("/api/preferences", {
      method: "PATCH",
      body: { density: "compact" },
      headers: { "if-match": '"1"' },
    });
    expectProblem(
      await api.request("/api/preferences", {
        method: "PATCH",
        body: { density: "standard" },
        headers: { "if-match": '"1"' },
      }),
      "version_mismatch",
    );
  });
});
