# 601 [KB22] U11: multi-line creator invoice (design check)

Date: 2026-11-06. Author: Claude 5. State: queued/design only. Nothing here changes a price, limit, commission, flag or gate.

## Verdict: already on main; no new build needed

Multi-line payment requests (the creator's "invoice") exist on `origin/main` (5c0731550), so U11 as written in `docs/reviews/c5-kb22-audit.md` is satisfied by existing code. It is not a gap.

## What exists (read from main, not run)

- `lib/payment-request-rules.ts`: `RequestLine` (`text`, `quantity`, `cents`), `MAX_LINES = 10`, `MAX_LINE_TEXT = 120`, `MAX_QUANTITY = 100`, `linesTotal`, `readDraft` (refuses 0 lines, more than 10, empty text, bad quantity, bad amount, total outside the currency/product bounds). `REQUEST_LIMITS` per plan (open/kept: 20/200, 100/1,000, 300/3,000) and `MAX_PER_PERSON = 24` are untouched.
- `lib/payment-requests.ts` (~line 240): the Checkout Session is created on the creator's own Stripe account (`onAccount`, Stripe-Account header) with one `line_items[i]` per line (`price_data`, `unit_amount`, `product_data[name]`, `quantity`). No money passes through Marktmorgen; no application fee.
- `components/payment-requests-studio.tsx` and `app/api/store/payment-requests`, `app/api/store/pay-request`, `app/[handle]/pay/[request]` carry the form, the buyer page and the payment.
- `tests/payment-requests.test.ts` already covers several lines, European decimal amounts, quantities multiplied, and the total bound.

## Overlap check

- `claude2/gr1-invoice-payments` (6b6f507b4) is an ancestor of main: already merged, diff against main is empty. It concerns the buyer ledger and membership invoice payments (270 [GR1]), not creator invoices.
- `claude4/r24-payment-requests` differs from main by one lib file and one test (reminders unread); not about lines.
- `claude/nc1-payments` differs only by FAQ tests. 569 [NC1] (no wrongful charge) is a separate item and does not touch line items.

## Remaining difference

None required by the U11 acceptance text: lines sum to the charge (`linesTotal`), one direct charge on the creator's account, `REQUEST_LIMITS` unchanged. Two optional checks the audit could add, left for the owner or a later unit, not built here:

1. Confirm in a synthetic test that the sum of `line_items` unit_amount x quantity sent to Stripe equals `request.total` (the existing test checks `readDraft`'s total; the Stripe body is the other half).
2. Confirm the studio form's "add line" control meets AX274 (keyboard, 44 x 44 px targets, labels per line, announce add/remove). Not verified here.

## Data model, limits, cost, accessibility, acceptance

- Data: a request holds `lines[]` of at most 10 entries; stored in the existing request store (Redis keys in `lib/payment-request-store.ts`). No new field.
- Limits: unchanged (above). Line count is bounded, so storage per request is bounded.
- Cost reads: no new supplier spend; Stripe reads happen on the creator's account. No new row in `tests/plan-cost-registry.ts`. Unknown costs are not claimed to be zero; this unit adds none.
- Accessibility: see optional check 2. Unperformed; recorded as a gap, not as passing.
- Acceptance (already largely met): a synthetic request with 3 lines creates one Checkout Session on the creator's account whose line_items total equals `request.total`, refuses 11 lines, and leaves `REQUEST_LIMITS` equal to the values above.

Not run: no tests executed for this document; no claim that the feature works for a customer.
