# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 604 [WP3] unit 1 (pure "Apply first" rules: personal single-use purchase link; channel C4-20261110-0026-C1-1) | claude4/wp3-apply-first-rules | `lib/apply-first-rules.ts`, `tests/apply-first-rules.test.ts`, `docs/reservations/claude4.md` | 10/11/2026 00h26 |
| Claude 4 | 604 [WP3] unit 2 ("Apply first" applications kept: day ceiling before any write, creator list, approve/decline over the record as read, person deletion and copy; no checkout, no email) | claude4/wp3-apply-first-store | `lib/apply-first-store.ts`, `tests/apply-first-store.test.ts`; own additive lines only in `lib/person-data.ts`, `lib/person-erasure.ts`, `lib/person-copy.ts`, `tests/store-data-registry.ts`, `tests/plan-cost-registry.ts` (NOT_A_COST), `lib/data-families.ts`, `tests/person-copy-world.test.ts` (EXPECTED_EMPTY); `docs/reservations/claude4.md` | 10/11/2026 |
