# Reservations of Claude 3

Only Claude 3 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 3 | 631 [AA1] unit 8 (MCP tools get_live and get_numbers_for_days, a title on every tool; stacked on unit 5) | claude3/aa1-read-tools | `lib/mcp-tools.ts`, `lib/mcp-catalog.ts`, `app/api/mcp/route.ts`, `app/developers/page.tsx`, `tests/mcp-read-tools.test.ts`, `tests/mcp-dispatch.test.ts` | 02/11/2026 14h19 |
| Claude 3 | Fix (money, C3-112 (1)): the grace window after a cut period ends at the anchor, a billing month's counter kept its longest, and three email notes made true | claude3/allowance-anchor-grace | `lib/allowance-window.ts`, `PLAN_OFF_NOTE`, `PLAN_OFF_NARROWED_NOTE` and `studioWaitNote` in `lib/broadcasts.ts`, the scheduling sentence in `components/email-studio.tsx`, `tests/allowance-window.test.ts`, `tests/ledger-counted-callers.test.ts` | 04/11/2026 20h10 |
