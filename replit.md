# Personal Finance

A responsive single-user personal finance workspace prototype for reviewing spending, correcting categories, managing monthly limits, and inspecting CSV imports.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build and run the API server on the configured loopback port
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run migrate --data-dir <dir>` — apply database migrations (the only way the schema changes; the server never migrates at startup)
- `pnpm --filter @workspace/api-server run owner:set-password --data-dir <dir>` — set the owner password (typed at the prompt)
- `pnpm run check` — contract checks, typecheck and tests
- The API server needs `MONEY_DESK_DATA_DIR`, `MONEY_DESK_BIND_ADDRESS`, `MONEY_DESK_PORT`, `MONEY_DESK_ALLOWED_ORIGIN` and `NODE_ENV`; it fails to start without them.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: SQLite (`better-sqlite3`, pinned, safe-integer mode), WAL, STRICT tables, checksummed SQL migrations
- Validation: Zod (`zod/v4`), generated from the OpenAPI contract
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/personal-finance/` — the deployable React + Vite frontend
- `artifacts/personal-finance/src/domain/` — replaceable local domain models, sample data, and mock data-access functions
- `artifacts/personal-finance/src/pages/` — route-level product screens
- `artifacts/personal-finance/src/components/` — reusable UI components
- `artifacts/personal-finance/README.md` — prototype scope, assumptions, and backend integration seam

## Architecture decisions

- The first build is frontend-only by design; local mock data demonstrates workflows without implying production persistence or integrations.
- The UI keeps the same page structure a future API-backed version can use, with data access isolated from presentation.
- Rollover behavior is intentionally left undecided rather than inferred in the budget screens.

## Product

The prototype provides an overview of current-month income, spending, remaining budget, and savings; searchable and filterable transactions with category correction; category limits and progress; reusable categorization rules; CSV import validation history; and personal settings.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
