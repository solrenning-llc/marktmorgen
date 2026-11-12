# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | 564 [HC1] unit 1, every studio area mapped to its help answer, with the gaps said and today's answer ids kept | claude1/hc1-help-areas | `lib/help-areas.ts` (new), `tests/help-areas.test.ts` (new) | 12/11/2026 18h20 |
| Claude 1 | 564 [HC1] unit 2, the first answers for studio areas without help: plan invoices and labels on many contacts (stacked on unit 1) | claude1/hc1-answers | `lib/help-content.ts` (the two new answers and their imports only), `lib/help-areas.ts`, `tests/help-areas.test.ts` | 12/11/2026 18h50 |
| Claude 1 | 564 [HC1] unit 3, answers for the last seven studio areas without help (stacked on unit 2) | claude1/hc1-funnels | `lib/help-content.ts` (the seven new answers and their imports only), `lib/help-areas.ts`, `tests/help-areas.test.ts` | 12/11/2026 19h20 |
