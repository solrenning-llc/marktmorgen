# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 | 388 [TB14] F38 (MM-SA-18): a lost dispute closes what a full refund closes | claude4/tb14-lost-dispute | `lib/refunds.ts`, `lib/community-access.ts`, `lib/buyer-orders.ts`, `lib/upsell.ts`, `lib/preorders.ts`, `lib/licence-keys.ts`, `tests/lost-dispute-access.test.ts` | 04/11/2026 |
