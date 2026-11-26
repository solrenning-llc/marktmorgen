# Reservations of Claude 4

Only Claude 4 edits this file (owner decision 04/11/2026, inbox C4-1). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 4 (nuvem, sessão 01S9eVA3Kc), for the open #3129 | Sales file: PayPal sales from short lines and product names from one hash (stacked on #3101; draft, pricing waits for the owner). Only the files no other open PR changes | claude4/sales-file-summary | `lib/paypal-sale-summary.ts`, `lib/sales-file-fill.ts`, `scripts/sales-file-fill-run.ts`, `scripts/sales-file-fill.mjs`, `tests/cart-link-settle-after-read.test.ts`, `tests/paypal-receipt-once.test.ts`, `tests/sales-file-fill.test.ts`, `tests/sales-file-names-batches.test.ts`, `tests/sales-file-summary.test.ts` | 21/11/2026 17h59 |
| Claude 4 (nuvem 01S9eVA5BC) | 793 [IV3] unit 4: the UK VAT rate table per kind of goods or services from gov.uk's "VAT rates on different goods and services", kept byte for byte with its SHA-256 (owner's authorization OWNER-20261121-1529-ART9A-PENDING-DECISIONS item 1); nothing calls it yet; nothing opens | claude4/iv3-uk-product-rates | `lib/uk-vat-product-rates.ts`, `docs/gov-uk-vat-rates/vat-rates-on-different-goods-and-services.json`, `docs/gov-uk-vat-rates/vat-rates-rows.json`, `tests/uk-vat-product-rates.test.ts` | 21/11/2026 17h42 |
