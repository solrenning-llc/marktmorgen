# Reservations of Claude 7

Only Claude 7 edits this file (same rule as every agent's own reservations file, inbox C3-7). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file. `scripts/reservation-check.mjs` reads every file in `docs/reservations/`; the lane and the branch prefix (`claude7/`) are in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 7 | CI runner-minutes: each Linux `next build` reads TypeScript's build record of its base commit, written only on main by a new non-required workflow; every test still runs on a full build | claude7/ci-build-cache | `.github/workflows/next-build-cache.yml` (new), `.github/workflows/product-checks.yml` (the restore steps in verify and cross-browser and one documentation-scope test step only), `.github/workflows/accessibility-buyer-actions.yml`, `.github/workflows/accessibility-product-actions.yml`, `.github/workflows/accessibility-public-matrix.yml`, `.github/workflows/accessibility-signup-actions.yml`, `.github/workflows/accessibility-studio-matrix.yml`, `scripts/test_ci_next_cache.py` (new), `scripts/test_ci_all_checks.py` and `scripts/test_ci_documentation_scope.py` (the NOT_CI line only), `tests/main-red-alarm.test.ts` (the list of workflows that are not CI only), `tests/reservation-check.test.ts` (the list of lanes with a file only) | 11/11/2026 16h40 |
