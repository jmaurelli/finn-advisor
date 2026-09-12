# HumanLayer backend/frontend handoff

Reviewed upstream commit `7cf1967` on 2026-09-12. This document describes the actual frontend and requirements to resolve; it is **not an approved API contract**. Preserve the Replit GUI as the design reference. Backend framework, database, authentication, financial semantics, and deployment remain HumanLayer decisions.

## Existing integration assets

| File | Current role |
| --- | --- |
| `artifacts/personal-finance/src/domain/finance.ts` | TypeScript view models: Account, Category, Transaction, Budget, CategoryRule, ImportBatch |
| `artifacts/personal-finance/src/domain/mock-data.ts` | Synthetic March 2025 fixtures |
| `artifacts/personal-finance/src/domain/data-access.ts` | Six synchronous mock collection getters; no HTTP calls or mutation adapter |
| `artifacts/personal-finance/src/domain/store.tsx` | FinanceProvider loads arrays into React state; mutations update that state only; accounts are exported once at module load |
| `lib/api-spec/openapi.yaml` | OpenAPI 3.1, `/api` base, **only GET /healthz** |
| `lib/api-spec/orval.config.ts` | Generates React Query hooks and Zod schemas |
| `lib/api-client-react/src/custom-fetch.ts` | Fetch/error parsing and optional base URL/auth configuration; not wired to finance pages |
| `artifacts/api-server/` and `lib/db/` | Express health endpoint and PostgreSQL/Drizzle scaffold; no finance backend, not a binding architecture choice |

Pages use `useFinance`; they do not call the generated finance API (none exists). Migration requires asynchronous loading/error/empty states and mutation handling in the provider/adapter, reactive account loading, and replacement of page-level financial calculations. Simply replacing synchronous getters with promises will not work.

## UI capabilities the backend must support

| Area | Existing behavior | Contract to design |
| --- | --- | --- |
| Overview/accounts | Local balances, spending/income, budget progress, recent transactions | Account and period summary reads; canonical aggregation, sorting and reconciliation semantics |
| Transactions | Merchant/note search; all/uncategorized/manual/refund/transfer filters; category correction; optional merchant rule creation | Paginated/filterable reads; validated correction mutation; correction provenance and timestamp; define atomic correction-plus-rule behavior |
| Budgets | Create/edit category limit, fixed March 2025, calculated usage | Period-scoped reads and writes; category/month uniqueness, validation; rollover decision |
| Categories | Create/edit name, description and color; system categories hidden from editing | Validated category reads/writes, protected system categories, referential integrity |
| Rules | Create/edit merchant substring, enable/disable; sample match counts | Rule CRUD as required, priority/matching semantics, enabled-only application, manual correction precedence, accurate match counts |
| Imports | Expand synthetic batch warnings; start button only animates | File validation, preview, duplicate detection, held-row review, explicit commit, batch history, retry/idempotency |
| Settings/export | Presentation controls; export has no handler | Decide preference persistence/application and export format; identity/session endpoints if required |

Endpoint names, request/response schemas, and status/error bodies are still to be agreed. Expand OpenAPI after design approval, generate clients, and map backend representations to the UI models. Include real JSON examples and validation/error responses. Keep credentials out of client code and all `VITE_*` settings.

## Decisions and defects that must not become backend assumptions

- Money uses JavaScript numbers without an explicit currency per record. Purchases and payroll are positive, refunds negative, and payroll is typed as `purchase`. Define exact storage/transport precision, currency, debit/credit direction, income type, refund treatment, and transfer pairing before implementing finance calculations.
- Summary spending excludes refunds rather than netting them. Purchase count includes payroll. All records contribute regardless of selected month; month controls currently change only the label.
- `new Date('YYYY-MM-DD').toLocaleDateString(...)` shifts dates backward in US/Eastern (e.g. March 28 displays March 27). Preserve date-only semantics and use ISO timestamps for events; display strings such as `Today` are not an API format.
- Uncategorized state is inconsistent: a transaction can have a category and still have `source: uncategorized`; choosing the Uncategorized category currently marks it manual. Define a single invariant.
- Rule changes do not apply any categorization engine. The correction dialog can identify disabled rules as matches. The UI promise that manual corrections survive rule changes needs backend enforcement and tests.
- Category/month duplicate budgets, whitespace category/rule names, and special-category mutation need explicit validation. Zero/empty budgets must not yield invalid ratios.
- Sidebar review count and some overview/import text are hardcoded. Account balances do not reconcile automatically with transactions. Settings save feedback does not persist or affect formatting.
- Authentication, session expiry, authorization, loading failures, retries, conflicts, audit history, and persistence have no implemented UI integration.
- Dialogs lack focus trapping/Escape handling, and the hidden mobile sidebar remains a keyboard-accessibility concern; resolve before acceptance.

## Delivery and acceptance

Work in an isolated HumanLayer-owned worktree on server02, preserving existing work. Use synthetic data throughout GUI integration. Confirm the owner accepts the Tallywell name, sample identity, and screen design.

Produce a PRD/design and approved OpenAPI contract, implement the backend with automated validation, connect the frontend adapter, and prove persistence after refresh/restart. Test period boundaries and US/Eastern dates, income/refund/transfer math, rule precedence, category corrections, duplicate import prevention, explicit import commit, error/empty states, and authentication. Test desktop/mobile navigation and direct route refresh.

Keep development and production separate. Before server01 promotion, validate service restart/reboot, LAN/Tailscale access with deliberate firewall/TLS configuration, encrypted off-host backup, isolated restore, and rollback. Personal Google Drive via rclone/restic is the recorded backup direction; implement only after database design.
