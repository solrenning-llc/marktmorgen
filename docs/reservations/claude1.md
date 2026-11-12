# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 (cloud) | 232 [CA1], the original unit 4c, part 1: a new page photo, review photo and import refused once a plan has ended or its costs are paused | claude/friendly-pascal-9ecomf | lib/plan-standing.ts, app/api/store/photo/route.ts, app/api/store/review/route.ts, app/api/store/import/route.ts, app/api/store/import/funnel/route.ts, lib/imports.ts, lib/import-limits.ts, lib/studio-messages.ts, components/import-tool.tsx, components/clickfunnels-funnel.tsx, app/terms/page.tsx, tests/plan-ended-new-costs.test.ts, tests/review-photo-paused.test.ts, tests/partner-copy.test.ts, tests/clickfunnels-faq.test.ts | 12/11/2026 12h40 |
