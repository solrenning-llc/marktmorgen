# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 486 [IT3] unit 1 (the rules of the studio's search of actions, "What do you want to do?"; no screen yet) | claude4/it3-action-search-rules | `lib/studio-actions.ts`, `tests/it3-studio-actions.test.ts` | 10/11/2026 00h26 |
| Claude 4 | 486 [IT3] unit 2 (the actions as the first group, "Things to do", of the studio's one search box of 766 [STN13], found in the browser; stacked on #3450, needs #3525) | claude4/it3-search-actions-group | `lib/studio-search-actions.ts`, `lib/studio-actions-gallery.ts`, `lib/studio-actions-offered.ts`, `lib/studio-actions.ts`, `tests/it3-studio-search-actions.test.ts`, `tests/it3-studio-actions.test.ts` (imports only); small changes in Claude 6's `lib/studio-search-rules.ts`, `lib/studio-search.ts`, `components/studio-search.tsx`, `components/studio-header.tsx` | 10/11/2026 07h19 |
