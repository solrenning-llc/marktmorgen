# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 750 [CD1] unit 1 (pure rules for a buyer's file or video sent for review: settings, who may send, the check before any byte against the plan's storage, the review states and the reply) | claude4/cd1-submission-rules | `lib/submission-rules.ts`, `tests/submission-rules.test.ts` | 10/11/2026 03h59 |
| Claude 4 | 750 [CD1] unit 2 (the buyer's upload door on a lesson: vault path, open, sign, close and give up; the kept record with its time to live and byte ceiling) | claude4/cd1-submission-upload | `lib/submission-store.ts`, `app/api/store/course/submission/route.ts`, `tests/submission-store.test.ts`, `tests/submission-upload.test.ts`, `tests/submission-upload-world.ts`, `tests/aliases/submission-upload.test.ts.json` | 10/11/2026 04h19 |
| Claude 4 | Rule 24 sweep: the welcome offer counter is raised only on an exact "OK" (marks-exact-small) | claude4/marks-exact-small | `lib/welcome-offer-send.ts` (welcomeFor only), `tests/welcome-offer-count-exact.test.ts` | 08/11/2026 19h31 |
