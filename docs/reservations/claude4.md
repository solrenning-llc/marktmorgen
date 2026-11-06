# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 506 [SG1] MM-SA-30: a draft product's title, price, outline and preview lessons are shown only to its students and to the store's owner and team, signed in (the cart's GET is Claude 2's, sent through the channel) | claude4/sg1-mm-sa-30 | `lib/draft-view.ts`, `app/[handle]/certificate/[id]/page.tsx`, `app/[handle]/certificate/[id]/pdf/route.ts`, `app/[handle]/course/[product]/page.tsx`, `app/[handle]/course/[product]/[lesson]/page.tsx`, `app/api/store/course/file/route.ts`, `app/[handle]/book/[product]/page.tsx`, `app/[handle]/p/[product]/reviews/page.tsx`, `app/[handle]/free/page.tsx`, `app/[handle]/podcast/[product]/page.tsx`, `tests/draft-view.test.ts`, the MM-SA-30 row and rule 4 of `docs/security-audit-2026-10-28.md` | 05/11/2026 |
