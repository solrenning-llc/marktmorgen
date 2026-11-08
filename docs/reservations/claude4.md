# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | Inventory finding 8 (numbers-email crons: a refused send, post or read lets the period go, bounded, nothing twice; rule 24) | claude4/cron-digest-claim-released | `app/api/cron/weekly/route.ts`, `app/api/cron/monthly/route.ts`, `lib/stats-report.ts`, `tests/numbers-email-retry.test.ts`, `tests/numbers-email-retry-world.ts`, `tests/numbers-email-claim-world.ts`, `tests/test-config.mjs` | 08/11/2026 19h04 |
