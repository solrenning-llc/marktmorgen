# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/side-panel-switch.tsx`, `tests/e2e/block-picker-wide.mjs`, `tests/e2e/us-english-composer.mjs` (waits for the editor to hydrate before opening the picker), `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | r24 fresh-2 unit 4 (lesson comments read exactly: comments on, names, the studio's list and count of new comments) | claude4/r24-lesson-comments-reads | `lib/lesson-comments.ts`, `app/studio/course/[product]/page.tsx` (only the comments read and markSeen), `app/studio/page.tsx` (only newCommentsFor), `components/course-comments-studio.tsx`, `components/course-toggle.tsx`, `components/product-editor.tsx` (only the newComments prop), `tests/lesson-comments-exact.test.ts` | 10/11/2026 |
| Claude 4 | r24-fresh-2 unit 3 (rule 24: a spent recovery link, rescue link or code whose read or session failed is not called expired, nor an error page) | claude4/r24-auth-unknown-status | `app/api/auth/lost/confirm/route.ts`, `app/api/auth/rescue/route.ts`, `app/api/auth/code/route.ts`, `tests/auth-unknown-status.test.ts` | 10/11/2026 01h39 |
| Claude 4 | Rule 24 sweep: the welcome offer counter is raised only on an exact "OK" (marks-exact-small) | claude4/marks-exact-small | `lib/welcome-offer-send.ts` (welcomeFor only), `tests/welcome-offer-count-exact.test.ts` | 08/11/2026 19h31 |
| Claude 4 | Rule 24: an unreadable two-step lock is never unlocked (keptListed reads its three replies exactly) | claude4/r24-locked-until-exact | `lib/two-step.ts` (keptListed only), `tests/r24-locked-until-kept-exact.test.ts` | 10/11/2026 04h19 |
