/**
 * Response checking against `openapi.yaml` itself, plus per-operation status
 * coverage.
 *
 * The handlers already validate against the generated zod schemas, but those
 * are a translation. This compiles the contract document with Ajv, the way the
 * contract's own check script does, so a response is measured against what the
 * owner approved rather than against a derivative.
 *
 * `Coverage` exists because a checklist of hand-picked cases cannot show what
 * it forgot. It records every status a suite actually observed and lets the
 * suite assert, at the end, that each declared status was either exercised or
 * listed as unreachable with a stated reason.
 */
import { readFileSync } from "node:fs";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const SPEC_ID = "https://money-desk.invalid/openapi.json";

export interface SpecOperation {
  operationId: string;
  responses: Record<string, unknown>;
}

export const spec = YAML.parse(
  readFileSync(new URL("../../../lib/api-spec/openapi.yaml", import.meta.url), "utf8"),
  { maxAliasCount: -1 },
) as { paths: Record<string, Record<string, SpecOperation>> };

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addFormat("binary", true);
ajv.addFormat("password", true);
ajv.addKeyword("discriminator");
ajv.addKeyword("example");
ajv.addSchema(spec as unknown as Record<string, unknown>, SPEC_ID);

const compiled = new Map<string, ValidateFunction>();

/** Validates a value against a named contract schema, or throws with the reasons. */
export function validateAgainst(schemaName: string, value: unknown): void {
  let validate = compiled.get(schemaName);
  if (validate === undefined) {
    validate = ajv.compile({ $ref: `${SPEC_ID}#/components/schemas/${schemaName}` });
    compiled.set(schemaName, validate);
  }
  if (!validate(value)) {
    throw new Error(`${schemaName}: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
}

export function operationOf(template: string, method: string): SpecOperation {
  const operation = spec.paths[template]?.[method];
  if (operation === undefined) throw new Error(`the contract has no ${method} ${template}`);
  return operation;
}

export const declaredStatuses = (template: string, method: string): string[] =>
  Object.keys(operationOf(template, method).responses);

function pointer(ref: string): unknown {
  let node: unknown = spec;
  for (const segment of ref.replace(/^#\//, "").split("/")) {
    node = (node as Record<string, unknown>)[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) throw new Error(`unresolvable $ref ${ref}`);
  }
  return node;
}

function resolve(node: unknown): Record<string, unknown> {
  let current = node as Record<string, unknown>;
  while (typeof current["$ref"] === "string") current = pointer(current["$ref"] as string) as Record<string, unknown>;
  return current;
}

/**
 * The schema name the contract gives this operation's response, so a test
 * cannot check a body against a schema of its own choosing.
 */
export function responseSchemaName(template: string, method: string, status: number): string | undefined {
  const declaration = operationOf(template, method).responses[String(status)];
  if (declaration === undefined) return undefined;
  const content = resolve(declaration)["content"] as Record<string, { schema?: unknown }> | undefined;
  if (content === undefined) return undefined;
  const entry = Object.values(content)[0];
  if (entry?.schema === undefined) return undefined;
  const ref = (entry.schema as { $ref?: string }).$ref;
  return ref === undefined ? undefined : ref.split("/").pop();
}

export interface ObservedResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

/** A status a test deliberately produces that the operation does not declare. */
export interface UndeclaredStatus {
  operationId: string;
  status: number;
  /** Why it happens, and where the decision about it is recorded. */
  reason: string;
}

export class Coverage {
  private readonly seen = new Set<string>();

  constructor(private readonly undeclared: readonly UndeclaredStatus[] = []) {}

  /**
   * Records one response and checks it against the contract: the status is
   * declared (or knowingly undeclared), the body matches the declared schema,
   * and a problem document carries the problem media type and `no-store`.
   */
  check(template: string, method: string, response: ObservedResponse): ObservedResponse {
    const operation = operationOf(template, method);
    const status = String(response.status);
    const known = this.undeclared.find(
      entry => entry.operationId === operation.operationId && entry.status === response.status,
    );
    if (operation.responses[status] === undefined && known === undefined) {
      throw new Error(
        `${operation.operationId} answered ${status}, which the contract does not declare`
        + ` (declares ${Object.keys(operation.responses).join(", ")}): ${response.text.slice(0, 300)}`,
      );
    }
    this.seen.add(`${operation.operationId} ${status}`);

    if (response.status >= 400 && response.status !== 204) {
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("application/problem+json")) {
        throw new Error(`${operation.operationId} ${status} used content type ${type}`);
      }
      if (response.headers.get("cache-control") !== "no-store") {
        throw new Error(`${operation.operationId} ${status} did not forbid caching`);
      }
    }
    const schema = known === undefined ? responseSchemaName(template, method, response.status) : "Problem";
    if (schema !== undefined) validateAgainst(schema, response.body);
    return response;
  }

  observed(operationId: string, status: number): boolean {
    return this.seen.has(`${operationId} ${status}`);
  }

  /**
   * Declared statuses that no test produced, ignoring those the caller lists
   * as unreachable. The value is the stated reason, so an unreachable status
   * cannot be excluded silently.
   */
  missing(
    operations: readonly [string, string][],
    unreachable: Record<string, string>,
  ): string[] {
    const gaps: string[] = [];
    for (const [template, method] of operations) {
      const operation = operationOf(template, method);
      for (const status of Object.keys(operation.responses)) {
        const key = `${operation.operationId} ${status}`;
        if (this.seen.has(key) || unreachable[key] !== undefined) continue;
        gaps.push(key);
      }
    }
    return gaps;
  }

  /** Listed exclusions that turned out to be reachable after all. */
  staleExclusions(unreachable: Record<string, string>): string[] {
    return Object.keys(unreachable).filter(key => this.seen.has(key));
  }
}
