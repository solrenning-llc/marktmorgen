# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 767 [STN14] unit 1 (rules of the sales filters, and the total and average of what is filtered) | claude4/stn14-sales-filter-rules | `lib/sales-filter-rules.ts`, `tests/sales-filter-rules.test.ts` | 09/11/2026 15h32 |
| Claude 4 | 767 [STN14] unit 3 (saved sales filters per store: save, list, rename, delete; stacked on #3460) | claude4/stn14-saved-filters | `lib/sales-filters.ts`, `app/api/store/sales-filters/route.ts`, `tests/sales-filters.test.ts`, `lib/sales-filter-rules.ts`, `lib/data-families.ts` (one family), `tests/store-data-registry.ts` (one entry), `lib/agent-coverage.ts` (two rows), `tests/locked-deletes.test.ts` (two rows) | 09/11/2026 16h46 |
