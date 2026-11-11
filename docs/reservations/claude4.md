# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 (nuvem Q) | AX274 Part A item 5: the demo store's sample PDFs are tagged, in a language, with tables and lists, text at 7:1 | claude4/ax-pdf-demo-files | `lib/demo-file.ts`, `lib/demo-file-source.ts`, `lib/demo-file-build.ts`, `scripts/demo-files.mjs`, `tests/ax-pdf-demo-files.test.ts` | 11/11/2026 15h58 |
| Claude 4 (nuvem Q) | AX274 Part A item 5: tables and lists in generated PDFs are tagged as tables and lists (PDF/UA 7.5, 7.6; WCAG 1.3.1) | claude4/ax-pdf-table-tags | `lib/tagged-pdf.ts`, `tests/ax-pdf-table-tags.test.ts` | 11/11/2026 15h51 |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | Rule 24 sweep: the welcome offer counter is raised only on an exact "OK" (marks-exact-small) | claude4/marks-exact-small | `lib/welcome-offer-send.ts` (welcomeFor only), `tests/welcome-offer-count-exact.test.ts` | 08/11/2026 19h31 |
