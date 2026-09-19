// Behavioral checks of the generated zod schemas (lib/api-zod), which the
// server will use to validate requests. Run after codegen:
//   node scripts/check-generated-zod.ts
import * as api from "../../api-zod/src/generated/api.ts";

const failures: string[] = [];
let checks = 0;

function expect(label: string, schema: { safeParse(v: unknown): { success: boolean } }, value: unknown, ok: boolean) {
  checks++;
  if (schema.safeParse(value).success !== ok) failures.push(`${label}: expected ${ok ? "accept" : "reject"} ${JSON.stringify(value)}`);
}

const account = {
  id: "20000000-0000-4000-8000-000000000001",
  kind: "checking",
  providerKey: "chase",
  displayName: "Synthetic Checking",
  trackingStartDate: "2026-04-01",
  openingBalance: { amountMinor: "200000", currency: "USD" },
};
const withOpening = (amountMinor: unknown) => ({ ...account, openingBalance: { amountMinor, currency: "USD" } });
const withStart = (trackingStartDate: unknown) => ({ ...account, trackingStartDate });

expect("account ok", api.CreateAccountBody, account, true);
for (const good of ["0", "-1", "99999999999", "-99999999999"]) expect("money", api.CreateAccountBody, withOpening(good), true);
for (const bad of ["-0", "+5", "01", "1.5", "1e3", " 5", "100000000000", 5, 5n])
  expect("money", api.CreateAccountBody, withOpening(bad), false);
expect("currency", api.CreateAccountBody, { ...account, openingBalance: { amountMinor: "1", currency: "EUR" } }, false);
for (const good of ["2026-04-02", "2028-02-29", "1900-01-01"]) expect("date", api.CreateAccountBody, withStart(good), true);
for (const bad of ["2026-02-31", "2026-02-29", "2026-04-31", "2026-13-01", "2026-4-2", "0000-01-01", "3000-01-01", "", null])
  expect("date", api.CreateAccountBody, withStart(bad), false);
expect("unknown field", api.CreateAccountBody, { ...account, unexpected: true }, false);

// Nullable fields and discriminated unions.
expect("note null", api.UpdateTransactionNoteBody, { note: null }, true);
expect("note missing", api.UpdateTransactionNoteBody, {}, false);
expect("repair void", api.CreateRepairPreviewBody, { action: "void", reason: "Wrong account" }, true);
expect("repair unknown action", api.CreateRepairPreviewBody, { action: "delete", reason: "x" }, false);
expect("budget skip", api.PreviewBudgetChangeBody, { change: "skip_month", month: "2026-12" }, true);
expect("budget negative", api.PreviewBudgetChangeBody, { change: "set_regular", fromMonth: "2026-10", amount: { amountMinor: "-1", currency: "USD" } }, false);

// Headers keep the spec's casing; the server adapter maps Node's lowercased
// `if-match` to `If-Match` before validating. Query strings arrive as strings.
expect("if-match", api.UpdateTransactionNoteHeader, { "If-Match": '"4"' }, true);
expect("if-match weak", api.UpdateTransactionNoteHeader, { "If-Match": 'W/"4"' }, false);
expect("if-match missing", api.UpdateTransactionNoteHeader, {}, false);
expect("unknown query", api.ListTransactionsQueryParams, { limit: "50", sort: "amount" }, false);
expect("unknown nested field", api.CreateAccountBody, { ...account, openingBalance: { amountMinor: "1", currency: "USD", cents: 1 } }, false);
expect("limit string", api.ListTransactionsQueryParams, { limit: "50" }, true);
expect("limit too big", api.ListTransactionsQueryParams, { limit: "500" }, false);
expect("lifecycle", api.ListTransactionsQueryParams, { lifecycle: "void" }, true);
expect("lifecycle bad", api.ListTransactionsQueryParams, { lifecycle: "false" }, false);

// Partial updates must parse to exactly the keys that were sent: a schema
// default would silently reset an unmentioned field (e.g. a rule's scope).
const partials: Array<[string, { parse(v: unknown): unknown }, Record<string, unknown>]> = [
  ["UpdateRuleBody", api.UpdateRuleBody, { enabled: false }],
  ["UpdateAccountBody", api.UpdateAccountBody, { displayName: "Renamed" }],
  ["UpdateCategoryBody", api.UpdateCategoryBody, { color: "#1F6F5F" }],
  ["UpdatePreferencesBody", api.UpdatePreferencesBody, { density: "compact" }],
  ["UpdateImportRowBody", api.UpdateImportRowBody, { excluded: true }],
];
for (const [name, schema, sent] of partials) {
  checks++;
  const keys = Object.keys(schema.parse(sent) as object).sort().join(",");
  if (keys !== Object.keys(sent).sort().join(",")) failures.push(`${name} added fields on a partial update: ${keys}`);
}
// Known generator gap (orval drops minProperties/uniqueItems): the server must
// enforce these by hand. These checks fail loudly if orval starts enforcing
// them, so the handwritten rule can then be removed.
const gaps: Array<[string, boolean]> = [
  ["UpdateAccountBody accepts {} (minProperties dropped)", api.UpdateAccountBody.safeParse({}).success],
  ["ReorderRulesBody accepts duplicate IDs (uniqueItems dropped)", api.ReorderRulesBody.safeParse({ ruleSetRevision: "3", orderedRuleIds: [account.id, account.id] }).success],
];
for (const [label, stillAccepted] of gaps) {
  checks++;
  if (!stillAccepted) failures.push(`generator gap closed, remove the handwritten server rule: ${label}`);
}

// Responses keep money and dates as strings (no bigint or Date coercion).
const parsed = api.GetAccountResponse.parse({
  ...account,
  maskedSuffix: "0001",
  status: "active",
  archivedAt: null,
  currentBalance: { amountMinor: "9007199254740993", currency: "USD" },
  balanceAsOf: "2026-05-02",
  lastImportedPostedDate: null,
  reconciliation: { latestStatus: null, needsRecheckCount: 0, differenceCount: 0 },
  version: "4",
  ledgerRevision: "12",
  createdAt: "2026-04-03T13:00:00Z",
  updatedAt: "2026-05-01T12:00:00Z",
});
checks++;
if (parsed.currentBalance.amountMinor !== "9007199254740993" || typeof parsed.trackingStartDate !== "string")
  failures.push("response parse changed money or date representation");

console.log(`generated zod checks: ${checks}`);
if (failures.length) {
  console.error(failures.map((f) => `- ${f}`).join("\n"));
  process.exit(1);
}
console.log("generated zod checks passed");
