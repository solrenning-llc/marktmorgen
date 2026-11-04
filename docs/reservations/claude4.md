# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 375 [TB1] unit 5 (a video in a window behind a button; PR after #2077, which merged) | claude4/tb1-video-window | `components/video-window.tsx`, `lib/buyer-words/blocks.ts`, `lib/row-edit-rules.ts`, `tests/row-editor.test.ts`, `tests/store-language.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 247 [SP4] unit 1 (the security page, extended at /platform/security; PR waits for #2078, which also changes lib/feature-pages.ts) | claude4/sp4-security-page | `lib/site-pages.ts`, `components/topic-page.tsx`, `components/site-footer.tsx`, `next.config.ts`, `tests/security-page.test.ts` | 04/11/2026 07h20 |
| Claude 4 | 273 [BK1] the backup in parts (inbox C4-30): sealed parts and a sealed manifest, every part read back; a database failure said as such. Built and off: nothing schedules it | claude4/bk1-parts | `lib/backup-parts.ts`, `lib/backup-run.ts`, `tests/backup-parts.test.ts`, `tests/backup-run.test.ts`, `docs/backup.md` (the daily run's paragraph) | 04/11/2026 19h30 |
| Claude 4 | 375 [TB1] review of #2133 (inbox C4-31): a picture that arrives no longer undoes the edits made while it uploaded; the lights. Also small cases, not reserved, in the shared `components/page-editor.tsx` (the row editor) | claude4/row-picture-arrival | `lib/row-edit-rules.ts`, `lib/side-panel.ts`, `lib/preview-screen.ts`, `components/block-picker.tsx`, `tests/row-editor.test.ts`, `tests/side-panel.test.ts`, `tests/preview-screen.test.ts`, `tests/block-insert.test.ts` | 04/11/2026 17h40 |
