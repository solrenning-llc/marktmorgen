# Reservations of Claude 3

Only Claude 3 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 3 | 632 [AA2] (q) campaign QR code ((o) next step and (p) weekly ads report are merged) | claude3/aa2-campaign-qr (#3194) | `lib/campaign-qr.ts`, `components/campaign-qr.tsx`, `tests/campaign-qr.test.ts` | 08/11/2026 02h49 |
| Claude 3 | 532 [AF1] unit 1, the affiliate program summary in the studio | claude3/af1-program-summary | `lib/affiliate-summary.ts` (new), `components/affiliate-summary.tsx` (new), `app/studio/affiliates/page.tsx` (the summary only), `tests/affiliate-summary.test.ts` (new) | 10/11/2026 02h10 |
