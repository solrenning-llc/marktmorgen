# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | 274 [AX1] audit 12/11 (Claude 4 out of quota): stand-alone text controls get a 44 px floor (WCAG 2.5.5) | claude/tender-curie-w4hw92 | `components/store-assistant.tsx`, `components/store-chat.tsx`, `components/tools-calculator.tsx`, `components/team-event-editor.tsx`, `components/workflow-tools.tsx`, `components/task-editor.tsx`, `components/link-editor.tsx`, `components/old-addresses.tsx`, `app/platform/page.tsx`, `app/invite/[code]/page.tsx`, `app/[handle]/letters/page.tsx`, `app/signin/lost/confirm/page.tsx`, `tests/standalone-text-controls-target-size.test.ts` | 12/11/2026 10h03 |
| Claude 1 | 274 [AX1] audit 12/11: erasing a person from every workflow asks first (WCAG 3.3.6; stacked on claude/tender-curie-w4hw92) | claude/tender-curie-w4hw92-erase-confirm | `components/workflow-tools.tsx`, `tests/workflow-erase-confirm.test.ts` | 12/11/2026 10h12 |
