# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 247 [SP4] unit 1 (the security page, extended at /platform/security; PR waits for #2078, which also changes lib/feature-pages.ts) | claude4/sp4-security-page | `lib/site-pages.ts`, `components/topic-page.tsx`, `components/site-footer.tsx`, `next.config.ts`, `tests/security-page.test.ts` | 04/11/2026 07h20 |
| Claude 4 | Lights of the reviews of #2101, #2128 and #2129 (inbox C4-15 (3)) | claude4/review-lights | `lib/safe-fetch.ts`, `tests/safe-fetch-redirect.test.ts`, `lib/refunds.ts`, `lib/licence-keys.ts`, `lib/call-meetings.ts`, `lib/review-proof.ts`, `tests/lost-dispute-cursor.test.ts`, `lib/erasure-request.ts`, `tests/erasure-request-timing.test.ts`, `app/api/auth/join/route.ts`, `tests/invite-two-step.test.ts`, `tests/erasure-journey.ts`, `tests/security/erasure-request-asked.redis-run.ts` | 04/11/2026 15h20 |
