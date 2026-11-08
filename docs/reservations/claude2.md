# Reservations of Claude 2

Only Claude 2 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 2 | 513 [PF1], the cart with physical products and stock (stacked; #1730 and #1732) | claude2/pf1-cart-stock, claude2/pf1-stock-hold-lock | `app/[handle]/p/[product]/page.tsx`, `app/[handle]/page.tsx`, `components/store-cart.tsx`, `lib/buyer-words/cart.ts`, `lib/cart-rules.ts`, `lib/checkout-recovery.ts`, `lib/shipping.ts`, `lib/stock.ts`, `tests/cart-physical.test.ts`, `tests/cart-stock.test.ts`, `tests/cart.test.ts`, `tests/stock-hold-write-confirmation.test.ts`, `tests/stock-reading.test.ts`, the cart rows of `tests/plan-cost-registry.ts` and of `tests/test-config.mjs`, and the cart answer in `lib/help-content.ts` | 31/10/2026 |
