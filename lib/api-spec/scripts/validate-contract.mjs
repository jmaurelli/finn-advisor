// Contract checks for openapi.yaml (TDD sections 2-9). Exits non-zero on any failure.
//  1. Every example (media types, parameters, headers) validates against its schema.
//  2. Every operation has a success example and an error example, correct security,
//     and If-Match/412/428 on updates and deletes.
//  3. Money, date and strictness rules reject known-bad values.
//  4. Every operation named in the TDD blueprint exists (plus two declared additions).
//  5. Error coverage: every operation has a 4xx example, every problem code is shown
//     somewhere, and every "NNN `code`" promised in a description is declared with
//     an example of that code.
//  6. The synthetic ledger fixtures marked `x-ledger: current` add up: balances,
//     month summary, budget usage, review counts, links and checkpoints.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = process.env.CONTRACT_SPEC ?? path.resolve(here, "..", "openapi.yaml");
const doc = YAML.parse(readFileSync(specPath, "utf8"), { maxAliasCount: -1 });

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addFormat("binary", true);
ajv.addFormat("password", true);
ajv.addKeyword("discriminator");
ajv.addKeyword("example");
ajv.addSchema(doc, "https://money-desk.invalid/openapi.json");

const failures = [];
const fail = (msg) => failures.push(msg);
let examplesChecked = 0;

const esc = (s) => s.replace(/~/g, "~0").replace(/\//g, "~1");
const deref = (obj) => {
  let cur = obj;
  while (cur && cur.$ref) {
    const parts = cur.$ref.replace(/^#\//, "").split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    cur = parts.reduce((o, k) => o[k], doc);
  }
  return cur;
};
const validatorCache = new Map();
const validatorAt = (pointer) => {
  if (!validatorCache.has(pointer)) validatorCache.set(pointer, ajv.compile({ $ref: `https://money-desk.invalid/openapi.json#${pointer}` }));
  return validatorCache.get(pointer);
};
const schemaPointer = (holderPointer, holder) =>
  holder.schema.$ref ? holder.schema.$ref.slice(1) : `${holderPointer}/schema`;

function checkExample(label, pointer, value) {
  examplesChecked++;
  const v = validatorAt(pointer);
  if (!v(value)) fail(`${label}: example invalid: ${ajv.errorsText(v.errors, { separator: "; " })}`);
}

function examplesOf(media) {
  const out = [];
  if (media.example !== undefined) out.push(["example", media.example]);
  for (const [name, ex] of Object.entries(media.examples ?? {})) out.push([name, deref(ex).value]);
  return out;
}

// ---------------------------------------------------------------- operations
const methods = ["get", "post", "put", "patch", "delete"];
const seenIds = new Set();
const unauthenticated = new Set(["healthCheck", "readinessCheck", "getSession", "login"]);
const noClientErrors = new Set(["healthCheck", "readinessCheck", "getSession"]);
const codesShown = new Set();
let operationCount = 0;

for (const [route, item] of Object.entries(doc.paths)) {
  const shared = item.parameters ?? [];
  for (const method of methods) {
    const op = item[method];
    if (!op) continue;
    operationCount++;
    const id = op.operationId;
    const label = `${method.toUpperCase()} ${route} (${id})`;
    if (!id) fail(`${label}: missing operationId`);
    if (seenIds.has(id)) fail(`${label}: duplicate operationId`);
    seenIds.add(id);
    if (!op.summary || !op.tags?.length) fail(`${label}: summary and tags required`);

    // Security: reads need the session cookie; writes also need CSRF.
    const security = op.security ?? doc.security;
    const schemes = security.map((req) => Object.keys(req).sort().join("+"));
    if (!unauthenticated.has(id)) {
      const want = method === "get" ? "sessionCookie" : "csrfToken+sessionCookie";
      if (schemes.length !== 1 || schemes[0] !== want) fail(`${label}: security must be exactly ${want}, got ${schemes}`);
    }

    // Parameters and their examples.
    const rawParams = [...shared, ...(op.parameters ?? [])];
    const params = rawParams.map(deref);
    params.forEach((p, i) => {
      if (p.in === "path" && !route.includes(`{${p.name}}`)) fail(`${label}: path parameter ${p.name} not in route`);
      if (p.example === undefined) return;
      const ptr = p.schema.$ref ? p.schema.$ref.slice(1) : rawParams[i].$ref ? `${rawParams[i].$ref.slice(1)}/schema` : null;
      if (ptr) checkExample(`${label} param ${p.name}`, ptr, p.example);
      else fail(`${label} param ${p.name}: example on an inline operation parameter is not checkable; use a component`);
    });
    for (const m of route.matchAll(/\{(\w+)\}/g)) {
      if (!params.some((p) => p.in === "path" && p.name === m[1])) fail(`${label}: route parameter ${m[1]} undeclared`);
    }

    // If-Match on updates/deletes, with 412 and 428 responses.
    const hasIfMatch = params.some((p) => p.in === "header" && p.name === "If-Match");
    if ((method === "patch" || method === "delete") && !hasIfMatch) fail(`${label}: update/delete must require If-Match`);
    if (hasIfMatch && !(op.responses["412"] && op.responses["428"])) fail(`${label}: If-Match requires 412 and 428 responses`);

    // Request body examples.
    const body = op.requestBody && deref(op.requestBody);
    if (body) {
      for (const [mediaType, media] of Object.entries(body.content)) {
        const ptrBase = `/paths/${esc(route)}/${method}/requestBody/content/${esc(mediaType)}`;
        const exs = examplesOf(media);
        if (mediaType === "multipart/form-data") continue; // binary parts cannot be expressed as JSON examples
        if (!exs.length) fail(`${label}: request ${mediaType} has no example`);
        for (const [name, value] of exs) checkExample(`${label} request ${name}`, schemaPointer(ptrBase, media), value);
      }
    }

    // Responses: at least one success and one error, each with examples.
    let successExample = false;
    let errorExample = false;
    let clientErrorExample = false;
    const codesByStatus = {};
    for (const [status, rawResponse] of Object.entries(op.responses)) {
      const response = deref(rawResponse);
      const responseBase = rawResponse.$ref ? rawResponse.$ref.slice(1) : `/paths/${esc(route)}/${method}/responses/${status}`;
      for (const [hname, rawHeader] of Object.entries(response.headers ?? {})) {
        const h = deref(rawHeader);
        if (h.example !== undefined && h.schema.$ref) checkExample(`${label} ${status} header ${hname}`, h.schema.$ref.slice(1), h.example);
      }
      const isSuccess = status.startsWith("2");
      if (!response.content) {
        if (isSuccess && status === "204") successExample = true;
        else fail(`${label}: ${status} has no content`);
        continue;
      }
      for (const [mediaType, media] of Object.entries(response.content)) {
        const exs = examplesOf(media);
        if (!exs.length) fail(`${label}: ${status} ${mediaType} has no example`);
        const ptr = schemaPointer(`${responseBase}/content/${esc(mediaType)}`, media);
        for (const [name, value] of exs) {
          checkExample(`${label} ${status} ${name}`, ptr, value);
          if (mediaType === "application/problem+json") {
            if (String(value.status) !== status) fail(`${label} ${status} ${name}: problem status ${value.status} does not match`);
            if (value.type !== `urn:money-desk:problem:${value.code}`) fail(`${label} ${status} ${name}: type/code mismatch`);
            (codesByStatus[status] ??= new Set()).add(value.code);
            codesShown.add(value.code);
          }
        }
        if (exs.length && isSuccess) successExample = true;
        if (exs.length && !isSuccess) errorExample = true;
        if (exs.length && status.startsWith("4")) clientErrorExample = true;
        if (!isSuccess && Number(status) < 500 && mediaType !== "application/problem+json") fail(`${label}: ${status} must use application/problem+json`);
      }
    }
    if (!successExample) fail(`${label}: no success example`);
    if (!errorExample) fail(`${label}: no error example`);
    if (!clientErrorExample && !noClientErrors.has(id)) fail(`${label}: no 4xx error example`);
    for (const m of (op.description ?? "").matchAll(/\b([45]\d\d)\s*`([a-z_]+)`/g)) {
      if (!codesByStatus[m[1]]?.has(m[2])) fail(`${label}: description promises ${m[1]} ${m[2]} but no such response example is declared`);
    }
  }
}

// ---------------------------------------------------------------- blueprint coverage (TDD section 8)
const expected = `healthCheck readinessCheck getSession login recordSessionActivity logout
listAccounts createAccount getAccount updateAccount deleteAccount getAccountBalance changeAccountBaseline
archiveAccount reactivateAccount listCheckpoints createCheckpoint getCheckpointHistory recheckCheckpoint
getMonthSummary listTransactions getTransaction getTransactionHistory categorizeTransaction
returnTransactionToRules classifyTransaction updateTransactionNote createRepairPreview getRepairPreview
applyRepair listTransferCandidates listRefundCandidates createTransferPair getTransferPair deleteTransferPair
createRefundLink getRefundLink deleteRefundLink listCategories createCategory getCategory updateCategory
deleteCategory getCategoryArchiveImpact archiveCategory reactivateCategory listRules createRule getRule
updateRule reorderRules archiveRule getRuleHistory createRuleRun getRuleRun listRuleRunRows applyRuleRun
listBudgets getBudgetPlan previewBudgetChange applyBudgetChange listImportFormats listImports createImport
getImport listImportRows updateImportRow bulkSetImportRowType refreshImport commitImport discardImport
createImportFollowUp getPreferences updatePreferences exportTransactionsCsv exportLedgerJson getBackupStatus`.split(/\s+/);
// Additions beyond the section 8 table: single-record reads that supply the ETag
// needed to unlink with If-Match.
const additions = ["getTransferPair", "getRefundLink"];
for (const id of expected) if (!seenIds.has(id)) fail(`blueprint operation missing: ${id}`);
for (const id of seenIds) if (!expected.includes(id)) fail(`operation not in blueprint list: ${id}`);
const blueprintCount = expected.length - additions.length;
for (const code of doc.components.schemas.ProblemCode.enum) if (!codesShown.has(code)) fail(`problem code ${code} has no example on any operation`);

// ---------------------------------------------------------------- negative and positive value checks
const S = (name) => validatorAt(`/components/schemas/${name}`);
const expectValues = (schema, good, bad) => {
  const v = S(schema);
  for (const x of good) if (!v(x)) fail(`${schema} should accept ${JSON.stringify(x)}`);
  for (const x of bad) if (v(x)) fail(`${schema} should reject ${JSON.stringify(x)}`);
};
expectValues("MinorUnits",
  ["0", "1", "-1", "-8000", "99999999999", "-99999999999"],
  ["", "-0", "+5", "01", "-01", " 5", "5 ", "1.5", "1e3", "100000000000", "-100000000000", 5, null, "0x10"]);
expectValues("NonZeroMinorUnits", ["-1", "8000"], ["0", "-0"]);
expectValues("NonNegativeMinorUnits", ["0", "45000"], ["-1", "-0"]);
expectValues("AggregateMinorUnits", ["0", "-999999999999999999", "999999999999999999"], ["01", "1.0", "1000000000000000000", "9999999999999999999", "-9223372036854775808"]);
expectValues("LocalDate",
  ["2026-04-02", "2028-02-29", "1900-01-01", "2999-12-31"],
  ["2026-02-31", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-4-2", "not-a-date", "", "0000-01-01", "1899-12-31", "3000-01-01", "2026-04-02T00:00:00Z", null]);
expectValues("YearMonth", ["2026-04", "2026-12"], ["2026-13", "2026-4", "2026-04-01", ""]);
expectValues("Timestamp", ["2026-05-02T14:00:00Z", "2026-05-02T14:00:00.123Z"], ["2026-05-02T14:00:00-04:00", "2026-05-02", "2026-05-02 14:00:00Z"]);
expectValues("EntityVersion", ["1", "42", "999999999999999999"], ["0", "01", "-1", 4, "1000000000000000000"]);
expectValues("Revision", ["0", "7"], ["01", "1000000000000000000"]);
expectValues("RuleRunScope",
  [{ accountId: null, categoryId: null, month: null, from: "2026-04-01", to: null }],
  [{ accountId: null, categoryId: null, month: null, from: "0001-01-01", to: null }, { accountId: null, categoryId: null, month: null, from: null, to: "2026-02-30" }]);
expectValues("Transaction", [], [{ ...deref(doc.components.examples.Fixture_T1).value, voidedAt: "2026-05-02T14:00:00+02:00" }]);
expectValues("UpdateRuleRequest", [{ enabled: false }], [{}]);
expectValues("ETagValue", ['"4"'], ["4", 'W/"4"', '"0"']);
expectValues("Money",
  [{ amountMinor: "-8000", currency: "USD" }],
  [{ amountMinor: "-8000", currency: "EUR" }, { amountMinor: -8000, currency: "USD" }, { amountMinor: "-80.00", currency: "USD" }, { amountMinor: "-8000", currency: "USD", extra: 1 }, { amountMinor: "-8000" }]);
expectValues("CreateAccountRequest", [], [{
  id: "20000000-0000-4000-8000-000000000001", kind: "checking", providerKey: "chase", displayName: "X",
  trackingStartDate: "2026-04-01", openingBalance: { amountMinor: "0", currency: "USD" }, unexpected: true,
}]);
expectValues("CategorizeRequest", [{ categoryId: "30000000-0000-4000-8000-000000000010" }], [{ categoryId: "not-a-uuid" }, {}]);
expectValues("RepairRequest",
  [{ action: "void", reason: "Wrong account" }],
  [{ action: "void" }, { action: "delete", reason: "x" }, { action: "void", reason: "" }]);
expectValues("BudgetChangeRequest",
  [{ change: "skip_month", month: "2026-12" }],
  [{ change: "set_regular", fromMonth: "2026-10", amount: { amountMinor: "-1", currency: "USD" } }, { change: "set_month", month: "2026-12" }]);
expectValues("CategoryName", ["Groceries"], ["", "   ", "x".repeat(61)]);
expectValues("Cursor", ["abc-DEF_123"], ["", "has space", "a+b/c="]);

// ---------------------------------------------------------------- ledger fixture consistency
{
  const ex = doc.components.examples;
  const current = (pred) => Object.entries(ex).filter(([, e]) => e["x-ledger"] === "current" && pred(e.value)).map(([n, e]) => [n, e.value]);
  const txs = current((v) => v.merchant !== undefined).map(([, v]) => v);
  const accounts = current((v) => v.trackingStartDate !== undefined && v.kind !== undefined).map(([, v]) => v);
  const summary = ex.GetMonthSummary_april.value;
  const budgets = ex.ListBudgets_april.value;
  const n = (m) => BigInt(m.amountMinor);
  const eq = (label, got, want) => { if (got !== want) fail(`ledger: ${label} is ${want}, fixtures give ${got}`); };
  const active = txs.filter((t) => t.lifecycle === "active");
  const ids = new Set(txs.map((t) => t.id));
  if (ids.size !== txs.length) fail("ledger: duplicate current transaction IDs");
  const balanceAt = (acct, date) => active.filter((t) => t.accountId === acct.id && t.postedDate >= acct.trackingStartDate && t.postedDate <= date)
    .reduce((s, t) => s + n(t.money), n(acct.openingBalance));
  for (const a of accounts) {
    eq(`${a.displayName} currentBalance`, balanceAt(a, a.balanceAsOf), n(a.currentBalance));
    const last = active.filter((t) => t.accountId === a.id).map((t) => t.postedDate).sort().pop() ?? null;
    if (last !== a.lastImportedPostedDate) fail(`ledger: ${a.displayName} lastImportedPostedDate ${a.lastImportedPostedDate} vs ${last}`);
  }
  const month = summary.month;
  const inMonth = active.filter((t) => t.postedDate.startsWith(month));
  const sum = (list) => list.reduce((s, t) => s + (n(t.money) < 0n ? -n(t.money) : n(t.money)), 0n);
  const purchases = inMonth.filter((t) => t.kind === "purchase");
  const refunds = inMonth.filter((t) => t.kind === "refund");
  eq("summary purchases", sum(purchases), n(summary.spending.purchases));
  eq("summary refunds", sum(refunds), n(summary.spending.refunds));
  eq("summary net", sum(purchases) - sum(refunds), n(summary.spending.net));
  eq("summary income", sum(inMonth.filter((t) => t.kind === "income")), n(summary.income));
  const uncId = ex.Fixture_UncategorizedCategory.value.id;
  const byCat = (id) => sum(purchases.filter((t) => t.categoryId === id)) - sum(refunds.filter((t) => t.categoryId === id));
  for (const c of summary.categories) {
    eq(`summary category ${c.categoryId} net`, byCat(c.categoryId), n(c.net));
    eq(`summary category ${c.categoryId} count`, BigInt(inMonth.filter((t) => t.categoryId === c.categoryId).length), BigInt(c.transactionCount));
  }
  const listed = new Set([...summary.categories.map((c) => c.categoryId), uncId]);
  if (purchases.concat(refunds).some((t) => !listed.has(t.categoryId))) fail("ledger: a spending category is missing from the summary");
  eq("summary uncategorized net", byCat(uncId), n(summary.uncategorized.net));
  for (const a of summary.accounts) {
    const acct = accounts.find((x) => x.id === a.accountId);
    eq(`summary balance ${acct.displayName}`, balanceAt(acct, `${month}-31`), n(a.balance));
  }
  eq("review uncategorizedCount", BigInt(active.filter((t) => t.categoryId === uncId).length), BigInt(summary.review.uncategorizedCount));
  eq("review unmatchedTransferCount", BigInt(active.filter((t) => t.kind === "transfer" && !t.transferPairId).length), BigInt(summary.review.unmatchedTransferCount));
  // Budgets: every line uses the same month's spending; lines + unbudgeted + uncategorized = summary net.
  let budgetNet = 0n;
  for (const line of budgets.items) {
    eq(`budget ${line.categoryId} net`, byCat(line.categoryId), n(line.net));
    eq(`budget ${line.categoryId} remaining`, n(line.limit) - n(line.net), n(line.remaining));
    const pct = n(line.limit) === 0n ? null : Number((n(line.net) * 100n + n(line.limit) / 2n) / n(line.limit));
    if (pct !== line.percentUsed) fail(`ledger: budget ${line.categoryId} percentUsed ${line.percentUsed} vs ${pct}`);
    budgetNet += n(line.net);
  }
  eq("budget total net", budgetNet, n(budgets.totals.net));
  eq("budgets + unbudgeted + uncategorized", budgetNet + n(budgets.unbudgetedNet) + n(budgets.uncategorizedNet), n(summary.spending.net));
  // Links point at transactions that agree with them.
  const byId = Object.fromEntries(txs.map((t) => [t.id, t]));
  const pair = ex.Fixture_TransferPairP1.value;
  for (const leg of pair.legs) {
    const t = byId[leg.transactionId];
    if (!t || t.transferPairId !== pair.id || t.kind !== "transfer" || t.money.amountMinor !== leg.money.amountMinor || t.postedDate !== leg.postedDate) fail(`ledger: pair leg ${leg.transactionId} disagrees with its transaction`);
  }
  if (n(pair.legs[0].money) + n(pair.legs[1].money) !== 0n) fail("ledger: pair legs are not equal and opposite");
  const link = ex.Fixture_RefundLinkL1.value;
  if (byId[link.refundId]?.refundLink?.linkId !== link.id || byId[link.purchaseId]?.linkedRefundCount !== 1) fail("ledger: refund link disagrees with its transactions");
  // The reconciled checkpoint matches the calculated balance on its closing date.
  const cp = ex.Fixture_CheckpointReconciled.value;
  const cpAcct = accounts.find((a) => a.id === cp.accountId);
  eq("checkpoint current balance", balanceAt(cpAcct, cp.closingDate), n(cp.currentCalculatedBalance));

  // Checkpoint status is derived exactly as the TDD defines it.
  const checkpoints = current((v) => v.closingDate !== undefined && v.statementBalance !== undefined && v.status !== undefined).map(([, v]) => v);
  const derive = (c, acct) => {
    if (!c.latestCheck) return "not_checked";
    if (!c.latestCheck.matched) return "difference";
    return balanceAt(acct, c.closingDate) === n(c.latestCheck.calculatedBalance) ? "reconciled" : "needs_recheck";
  };
  for (const c of checkpoints) {
    const acct = accounts.find((a) => a.id === c.accountId);
    if (derive(c, acct) !== c.status) fail(`ledger: checkpoint ${c.id} status ${c.status} vs derived ${derive(c, acct)}`);
    eq(`checkpoint ${c.id} current difference`, n(c.currentCalculatedBalance) - n(c.statementBalance), n(c.currentDifference));
  }
  for (const a of accounts) {
    const own = checkpoints.filter((c) => c.accountId === a.id).sort((x, y) => x.closingDate.localeCompare(y.closingDate));
    const latest = own.length ? own[own.length - 1].status : null;
    if (a.reconciliation.latestStatus !== latest) fail(`ledger: ${a.displayName} reconciliation.latestStatus ${a.reconciliation.latestStatus} vs ${latest}`);
    eq(`${a.displayName} needsRecheckCount`, BigInt(own.filter((c) => c.status === "needs_recheck").length), BigInt(a.reconciliation.needsRecheckCount));
    eq(`${a.displayName} differenceCount`, BigInt(own.filter((c) => c.status === "difference").length), BigInt(a.reconciliation.differenceCount));
  }
  eq("review needsRecheckCount", BigInt(checkpoints.filter((c) => c.status === "needs_recheck").length), BigInt(summary.review.needsRecheckCount));
  eq("review differenceCount", BigInt(checkpoints.filter((c) => c.status === "difference").length), BigInt(summary.review.differenceCount));

  // Imports: open previews and their held rows.
  const imports = current((v) => v.formatId !== undefined && v.rowCounts !== undefined).map(([, v]) => v);
  const open = imports.filter((i) => i.status === "preview");
  eq("review openImportCount", BigInt(open.length), BigInt(summary.review.openImportCount));
  eq("review heldImportRowCount", BigInt(open.reduce((s, i) => s + i.rowCounts.held, 0)), BigInt(summary.review.heldImportRowCount));
  for (const i of imports) {
    const c = i.rowCounts;
    if (c.ready + c.held + c.excluded !== c.total) fail(`ledger: import ${i.id} row counts do not add up`);
    if (i.result && (i.result.added + i.result.excluded !== i.result.rows || i.result.rows !== c.total)) fail(`ledger: import ${i.id} result does not match its rows`);
    const posted = txs.filter((t) => t.importId === i.id).length;
    if (i.status === "committed" && posted !== i.result.added) fail(`ledger: import ${i.id} added ${i.result.added} but ${posted} current transactions reference it`);
  }

  // Budget totals.
  const lim = budgets.items.reduce((s, l) => s + n(l.limit), 0n);
  eq("budget total limit", lim, n(budgets.totals.limit));
  eq("budget total remaining", lim - budgetNet, n(budgets.totals.remaining));
  const totalPct = lim === 0n ? null : Number((budgetNet * 100n + lim / 2n) / lim);
  if (totalPct !== budgets.totals.percentUsed) fail(`ledger: budget total percentUsed ${budgets.totals.percentUsed} vs ${totalPct}`);

  // Rules: positions, current-assignment counts and first-match attribution.
  const rules = current((v) => v.pattern !== undefined && v.appliesTo !== undefined).map(([, v]) => v)
    .filter((r) => r.status === "active").sort((a, b) => a.position - b.position);
  rules.forEach((r, i) => { if (r.position !== i + 1) fail(`ledger: rule positions are not 1..${rules.length}`); });
  const norm = (s) => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const firstMatch = (t) => rules.find((r) => r.enabled
    && (r.accountId === null || r.accountId === t.accountId)
    && (r.appliesTo === "purchases_and_refunds" || r.appliesTo === `${t.kind}s`)
    && (r.matchType === "exact" ? norm(t.merchant) === norm(r.pattern) : norm(t.merchant).includes(norm(r.pattern))));
  for (const r of rules) {
    eq(`rule ${r.id} currentAssignmentCount`, BigInt(active.filter((t) => t.assignment.ruleId === r.id).length), BigInt(r.currentAssignmentCount));
  }
  for (const t of active.filter((t) => t.kind === "purchase" || t.kind === "refund")) {
    const hit = firstMatch(t);
    if (t.assignment.origin === "rule" && (hit?.id !== t.assignment.ruleId || hit?.categoryId !== t.categoryId)) fail(`ledger: ${t.id} attributed to rule ${t.assignment.ruleId} but first match is ${hit?.id}`);
    if (t.assignment.origin === "unassigned" && (hit || t.categoryId !== uncId)) fail(`ledger: ${t.id} is unassigned but rule ${hit?.id} matches`);
  }
}

// ---------------------------------------------------------------- report
console.log(`operations: ${operationCount} (blueprint ${blueprintCount} + ${additions.length} declared additions)`);
console.log(`problem codes shown: ${codesShown.size}/${doc.components.schemas.ProblemCode.enum.length}`);
console.log(`examples validated: ${examplesChecked}`);
if (failures.length) {
  console.error(`\n${failures.length} contract check failure(s):`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("contract checks passed");
