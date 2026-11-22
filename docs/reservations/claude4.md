# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 (nuvem, sessão 01S9eVA3Kc), for the open #3129 | Sales file: PayPal sales from short lines and product names from one hash (stacked on #3101; draft, pricing waits for the owner). Only the files no other open PR changes | claude4/sales-file-summary | `lib/paypal-sale-summary.ts`, `lib/sales-file-fill.ts`, `scripts/sales-file-fill-run.ts`, `scripts/sales-file-fill.mjs`, `tests/cart-link-settle-after-read.test.ts`, `tests/paypal-receipt-once.test.ts`, `tests/sales-file-fill.test.ts`, `tests/sales-file-names-batches.test.ts`, `tests/sales-file-summary.test.ts` | 21/11/2026 17h59 |
| Claude 4 (nuvem, sessão 01S9eVA5BC) | 793 [IV3] unit 2 item (a): Terms and pricing text on the VAT collected, option A (OWNER-20261122-0022) | claude4/iv3-vat-fee-terms | `app/pricing/page.tsx`, `app/terms/page.tsx`, `lib/vat-fee-words.ts`, `tests/vat-fee-words.test.ts` | 22/11/2026 00h35 |
