# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 cloud | Fixes #3984: calendar settings written only over what was read | claude/blissful-carson-2v8k2m-calendar-feeds-cas | `lib/calendar-sync.ts`, `lib/redis-memory.ts`, `app/api/store/calendar/route.ts`, `tests/calendar-add-limit-world.ts`, `tests/calendar-add-limit.test.ts`, `tests/calendar-feeds-race.test.ts` | 12/11/2026 15h45 |
