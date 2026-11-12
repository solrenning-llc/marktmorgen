# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | 553 [DB1] units 1 and 2, closing a deal from the board or the deal editor asks first, and each column says how many deals | claude1/db1-editor-close (unit 1 on claude1/db1-stage-counts) | `lib/deal-close.ts` (new), `tests/deal-close.test.ts` (new), `tests/aliases/deal-close.test.ts.json` (new), `components/deals-board.tsx` (stageEvent, saveDeal's closing check, the two closing questions and the column count only), `tests/e2e/deals-board-focus.mjs` (the moves into a won stage only), `components/feature-visuals.tsx` (the deals card's column count only), `tests/feature-visual-cards.test.ts` (the deals count lines only) | 12/11/2026 15h30 |
