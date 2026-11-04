# Reservations of Claude 3

Only Claude 3 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 3 | 631 [AA1] unit 8 (MCP tools get_live and get_numbers_for_days, a title on every tool; stacked on unit 5) | claude3/aa1-read-tools | `lib/mcp-tools.ts`, `lib/mcp-catalog.ts`, `app/api/mcp/route.ts`, `app/developers/page.tsx`, `tests/mcp-read-tools.test.ts`, `tests/mcp-dispatch.test.ts` | 02/11/2026 14h19 |
| Claude 3 | 639 [GL7](6) unit 1: tasks about a person, rules, storage in the CRM and the studio route | claude3/gl7-person-tasks | `lib/person-tasks.ts`, `tests/person-tasks.test.ts`, `app/api/store/person-tasks/route.ts`, `lib/crm.ts` | 03/11/2026 17h02 |
| Claude 3 | 639 [GL7](6) unit 2: tasks on a person's page in the studio | claude3/gl7-person-tasks-screen | `components/person-tasks.tsx`, `tests/person-tasks-screen.test.ts`, `app/studio/people/page.tsx` | 03/11/2026 18h22 |
| Claude 3 | 639 [GL7](6) unit 3: the tasks agenda on the studio's buyers page | claude3/gl7-person-agenda | `lib/person-agenda.ts`, `tests/person-agenda.test.ts`, `app/studio/people/page.tsx` | 03/11/2026 20h53 |
| Claude 3 | 639 [GL7](4) unit 1: companies as CRM records with the people linked to them (rules, storage, route) | claude3/gl7-companies | `lib/crm-companies.ts`, `app/api/store/companies/route.ts`, `tests/crm-companies.test.ts`, the forget line in `lib/crm.ts` | 03/11/2026 21h33 |
| Claude 3 | 639 [GL7](4) unit 2: the company a person works at, on their page in the studio | claude3/gl7-companies-screen | `components/person-company.tsx`, `lib/crm-companies-rules.ts`, `tests/person-company-screen.test.ts`, the Company section in `app/studio/people/page.tsx` | 03/11/2026 21h36 |
| Claude 3 | 639 [GL7](6) unit 3: the tasks agenda on the studio's buyers page | claude3/gl7-person-agenda | `lib/person-agenda.ts`, `tests/person-agenda.test.ts`, `app/studio/people/page.tsx`, `components/tasks-agenda.tsx` | 03/11/2026 20h53 |
