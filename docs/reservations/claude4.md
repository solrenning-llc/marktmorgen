# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | Rule 24 sweep: the welcome offer counter is raised only on an exact "OK" (marks-exact-small) | claude4/marks-exact-small | `lib/welcome-offer-send.ts` (welcomeFor only), `tests/welcome-offer-count-exact.test.ts` | 08/11/2026 19h31 |
| Claude 4 | AX274 studio audit (cloud P): editing a product from its card keeps the keyboard focus (WCAG 2.4.3) | claude4/ax-studio-product-edit-focus | `components/product-editor.tsx` (only a new effect beside ProductEditor's editingId state and an id on the card's Edit button), `tests/product-edit-focus.test.ts` | 11/11/2026 15h49 |
| Claude 4 | AX274 studio audit (cloud P): removing a product from its card keeps the keyboard focus (WCAG 2.4.3); stacked on #3771 | claude4/ax-studio-product-remove-focus | `components/product-editor.tsx` (ProductEditor's remove question: refs and an effect beside removingId, ids on Add something to sell and the card's Remove, the question's ref and tabIndex, Keep it), `tests/product-remove-focus.test.ts` | 11/11/2026 16h16 |
