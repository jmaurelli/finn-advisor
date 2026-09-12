# Personal Finance Prototype

A responsive frontend prototype for a single-user personal finance workspace. It uses realistic local sample data to demonstrate reviewing an overview, browsing and correcting transactions, managing monthly category limits, maintaining categorization rules, and inspecting CSV import history.

## Run

From the workspace root:

```bash
pnpm --filter @workspace/personal-finance run dev
```

The Replit preview workflow supplies the required `PORT` and `BASE_PATH` values.

## Structure

- `src/App.tsx` — route-aware application shell and page composition
- `src/components/` — reusable navigation, controls, feedback states, and data presentation
- `src/pages/` — overview, transactions, budgets, categories, imports, and settings screens
- `src/data/` — domain types, sample records, and mock data-access functions
- `src/index.css` — centralized visual tokens and responsive styles

## Backend integration seam

The prototype intentionally has no production backend, authentication, bank connections, CSV parser, or AI features. The `src/data/` layer keeps domain models and mock data-access functions separate from the UI; a future implementation can replace those functions with typed API calls without changing page structure or interaction design.

## Assumptions

- The app represents one local user, so account and preference screens are presentation-only.
- Values are shown in USD and the sample month is June 2026.
- Month navigation changes the displayed month context while the prototype keeps the sample records local; the included sample month is March 2025.
- Rollover behavior is intentionally not represented because it remains undecided.
- Import validation is represented as sample status and warnings; no file is actually uploaded or parsed.