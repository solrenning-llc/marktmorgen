# Reservations of Codex

Only Codex edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Codex | CX-19/CX-22 recovery of own digital access foundation, route excluded; no activation | codex/p1-physical-option-origin (preservation, no PR) | `lib/order-confirmation-outbox.ts`, `lib/person-data.ts`, `lib/shipment-mail-outbox.ts`, `lib/single-digital-access.ts`, `lib/store-checkout.ts`, `tests/single-digital-access-renewal-world.ts`, `tests/single-digital-access-renewal.test.ts`, `tests/single-digital-access-targeted-world.ts`, `tests/single-digital-access-targeted.test.ts`, `docs/e5-money-readers.md`, `docs/p1-foundation-recovery.md` | 03/11/2026 |
| Codex | CX-19 exception, only nl:orders:link:@lib/single-digital-access.ts descriptive row, all foreign rows preserved | codex/p1-physical-option-origin | `tests/store-data-registry.ts` (one row only) | 03/11/2026 |
