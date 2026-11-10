# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | Rule 24 sweep: the welcome offer counter is raised only on an exact "OK" (marks-exact-small) | claude4/marks-exact-small | `lib/welcome-offer-send.ts` (welcomeFor only), `tests/welcome-offer-count-exact.test.ts` | 08/11/2026 19h31 |
| Claude 4 | 623 [SZ7] unit 1 (rules for back-in-stock, low-stock and per-buyer limits, no I/O) | claude4/sz7-stock-alert-rules | `lib/stock-alert-rules.ts`, `tests/stock-alert-rules.test.ts` | 10/11/2026 15h16 |
| Claude 4 | 623 [SZ7] unit 2 (the back-in-stock list kept, with erasure and copy; no route or email) | claude4/sz7-stock-alert-store | `lib/stock-alerts.ts`, `tests/stock-alerts.test.ts` | 10/11/2026 15h28 |
| Claude 4 | 623 [SZ7] unit 3 (the "Email me when it's back" routes, its page and emails, and the restock email from the email job; the box stays off the product page) | claude4/sz7-stock-alert-routes | `lib/stock-alert-send.ts`, `lib/buyer-words/stock-alert.ts`, `app/api/store/stock-alert/route.ts`, `app/api/store/stock-alert/confirm/route.ts`, `app/api/store/stock-alert/leave/route.ts`, `app/[handle]/back-in-stock/page.tsx`, `tests/stock-alert-routes.test.ts`, `tests/stock-alert-restock.test.ts`, one block in `app/api/cron/mail/route.ts` | 10/11/2026 16h40 |
