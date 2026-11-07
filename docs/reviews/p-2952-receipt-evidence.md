# Independent second financial review of #2952

Exact reviewed head: `7f49bcf8c2bc860e51ddd5eed24d4aecaf415fba`.
Verdict: request changes, one MEDIUM validation finding and one LOW timestamp finding.
Only evidence files were added on the reviewer's branch. No author source or ref was changed.

## M1 — inconsistent monetary breakdowns become receipts

`lib/receipt-pdf.ts:127-135` accepts any nonnegative safe integer tax when the pre-tax formula already equals the total. It never checks whether the tax said to be included exceeds that total. With item subtotal 100, discount/shipping 0, tax 101, total/charge 100 and no refund, `receiptFrom` succeeds and the actual drawing path produces a 9,860-byte PDF. Its texts include both `Tax included in the prices above: $1.01` and `Total paid: $1`.

The same boundary accepts subtotal 100, discount 200, shipping 200, tax 0, total/charge 100. The receipt says subtotal $1, discount -$2, shipping $2 and total paid $1, and produces a 10,024-byte PDF. Shipping masks a discount exceeding the merchandise subtotal.

These are synthetic contradictory replies, not evidence that live Stripe emits them. The defect is the receipt boundary accepting internally incoherent figures despite its stated fail-closed contract. It does not move money or demonstrate cross-store disclosure. Refuse inconsistent breakdowns as `unreadable` before drawing, preserving ordinary tax-added, tax-included, untaxed, shipping and discount controls. The author should confirm the precise provider semantics for discounts before broadening any rule; the included-tax-greater-than-payment vector independently demonstrates M1.

## L1 — accepted timestamp crashes the drawing path

`lib/receipt-pdf.ts:148-157` only requires `created` to be a nonnegative safe integer. `Number.MAX_SAFE_INTEGER` passes, but `receiptTexts` then throws `RangeError` while formatting the resulting invalid JavaScript date. The route's read try/catch has ended before `receiptDrawable` calls that formatter. Validate the admitted timestamp against the date/rendering domain and return the existing unreadable state, rather than allowing an unhandled generation error. Do not invent a payment date.

## Reproduction and validation

- New permanent `tests/p-review-2952-receipt-evidence.test.ts`: 20 checks, 3 causal failures, 17 passing controls on the exact head. Two monetary assertions belong to M1; the timestamp assertion belongs to L1.
- Author original RED `6c2dc4ecf`: canonical test fails to bundle because both new production modules are absent, as expected. This is a missing-module RED, not 58 runtime failures.
- Canonical final `kb22-receipt-pdf`: 58/58.
- Linked final: tagged-pdf 28/28, stripe-list-lot1 58/58, accessibility-inventory 16/16. The old stripe-list failure does not reproduce on this integrated head.
- Scoped strict TypeScript, three selected roots, zero diagnostics. ESLint source/route/proof clean; final proof rechecked after adding the two PDF observations. Public-data scanner and diff check run on the tracked evidence.
- Full seven-file PR diff read, including the new route, sale mode and UI link, inventory and agent-coverage row. Both source files and canonical tests are byte-identical through the main-only merge from b82605c1.
- Read `creatorFrom`/`studioAccess`/`countStudio`: access and one request are admitted first; the route admits the remaining three units before its two bounded parallel account-scoped Stripe reads. No new productive IO or provider operation was performed in this review.
- Narrow sibling search for the same subtotal/discount/included-tax formula in receipt/PDF modules found only this new module; no additional sibling defect is claimed.

## Limits

All data and provider replies were synthetic. No live Stripe, native Redis, browser, screen reader or fiscal/legal certification was exercised. Structural PDF tests and actual PDF generation do not certify complete PDF/UA accessibility. This review does not enable, deploy, merge, enqueue or change a price, allowance, commission, flag, gate, account or term. Nine exact final checks and a qualifying corrective review remain the author's responsibility.
