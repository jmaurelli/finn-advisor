# GUI review — 2026-09-12

Source: GitHub main `7cf1967` (Build personal finance prototype). Review branch: `review/replit-dev-readiness`.

## Result

The static GUI builds and renders after regenerating the incomplete upstream dependency lockfile. Full workspace typecheck and build passed locally. No finance backend is connected. This is suitable for a synthetic-data GUI review, not functional financial use.

Browser validation passed 16 checks: five direct deep-link routes, merchant search, uncategorized filtering, manual correction, category creation, rule creation/disable, budget editing, reset on refresh, mobile overflow/navigation, and absence of JavaScript runtime errors. Desktop (1440x1000) and mobile (390x844) overview screenshots were inspected. This verifies rendering and selected interactions, not owner acceptance or pixel equivalence to Replit.

Evidence is in `review-output/browser-checks.json`, `desktop-overview.png`, and `mobile-overview.png`. The preview uses the existing Tallywell branding and Alex Morgan fixtures.

## Remaining gaps

- A clean upstream install fails because its lockfile is truncated. The regenerated lockfile changes dependency resolution; preserve and review it before sharing deployment instructions based on it.
- Server02 deployment is now verified: frozen install, full typecheck/build, 16 browser checks, and service restart passed under humanlayer. Evidence: `review-output/server02-*`. Reboot and owner visual acceptance remain untested.
- UI state resets on refresh. No persistence, real CSV import/review, export, authentication, or financial API exists.
- Period changes do not filter data; settings do not apply; rule changes do not categorize transactions. Several displayed counts are hardcoded.
- US/Eastern date rendering moves date-only values back one day. Monetary signs/types, refunds, and payroll counts require an approved financial contract.
- Existing OpenAPI describes only `/api/healthz`; no finance integration contract exists yet. See HUMANLAYER-HANDOFF.md for exact source locations, required capabilities, and unresolved decisions.

The review updates documentation and build reproducibility only; it preserves the designed UI and leaves backend decisions to HumanLayer. No changes have been pushed to GitHub.
