# Zapier: a Create Discount Code action (378 [TB4], complement WG (c), one unit)

## What changes
- `zapier/index.js` gains the action **Create Discount Code** over the existing `POST /api/v1/codes`: code, percent or amount off, optional uses and smallest order, sent as text exactly as `readCodeAsked` (lib/discount-input.ts) reads them. A percent code never carries an amount typed beside it.
- Its answer is held to the shape `codeOut` gives (id, code, `active: true`, a known `off`); any other 2xx answer is `unconfirmed_response`, never "done" (rule 24, as the other three actions).
- The API's own refusals pass through unchanged: a read-only key is `read_only`, a store not taking payments is `not_selling` (today every store, because `PLANS_ON_SALE` is false), letters already used on the creator's Stripe are `taken`, so a repeated run makes no second code.
- docs/zapier-app.md lists the action.

## Tests
- RED (3f9e8d46bb): tests/zapier-writes-exact.test.ts (malformed and near answers unconfirmed, healthy answers returned whole, request body as typed) and tests/zapier-app.test.ts (four actions; real route refuses `not_selling` and `read_only`) fail on main (no such action).
- GREEN: zapier-app, zapier-writes-exact, zapier-response, zapier-hook-signature, r34-hook-own-id: 0 failed files. eslint clean; `npx next typegen` and `tsc --noEmit` clean.

## State (VR)
Tested on a branch only. The Zapier app is not published (57 [K3-ZAPIER], the owner's step), and no store can make a code while `PLANS_ON_SALE` is false, so nothing reaches a customer yet.

## Cost
No new cost: each call is the API's own write, taken from the store's API allowance before Stripe is called (`codeMakeWork`, app/api/v1/codes/route.ts), as for a code made in the studio.

## Acessibilidade
No site screen changes. Field labels and help texts in plain US English (3.1.5); the error messages are the API's own. 0→0 steps in the studio.

## Not changed
No price, visible limit, commission, flag, gate or webhook event.
