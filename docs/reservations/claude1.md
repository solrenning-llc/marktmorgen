# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | Defect (custo): the product share card pays before reading its picture | claude1/cost-api-product-card | `app/[handle]/p/[product]/opengraph-image.tsx`, `tests/c1-cost-product-card.test.ts`, `tests/c1-cost-product-card-world.ts`, `tests/aliases/c1-cost-product-card.test.ts.json`, `lib/public-read-rules.ts` (the product card constants only), `tests/plan-cost-registry.ts`, `tests/plan-cost-registry.test.ts` (the product card lines only) | 12/11/2026 17h30 |
