# Reservations of Claude 2

Only Claude 2 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 2 | 520 [LB1] unit 5 (deposit: "The rest is paid at the salon") | claude2/lb1-deposit | `lib/call-deposit.ts`, `tests/call-deposit.test.ts`, and the deposit parts of `lib/call-setup.ts`, `lib/calls.ts`, `components/call-editor.tsx`, `app/[handle]/book/[product]/page.tsx`, `lib/buyer-words/booking.ts` (stacked on its own open PRs #1733–#1736) | 02/11/2026 12h59 |
| Claude 2 | 634 [GL2], unit 1 (saved agreement templates: the rules) | claude2/gl2-agreement-templates | `lib/agreement-template-rules.ts`, `tests/agreement-templates.test.ts` and the export of `clean` in `lib/agreement-rules.ts` | 02/11/2026 21h03 |
