# Checkout speed (277 [H3-2])

What happens between a buyer's click on **Buy** and Stripe's payment page, which part of it is ours, and how CI keeps our part from growing. Unit 1, 15 November 2026.

## The path

1. The buyer presses Buy on the product page, the checkout link or the embedded checkout. Each is a plain form posted to `POST /api/store/checkout` (`app/api/store/checkout/route.ts`).
2. **Our part.** The route checks the request, reads the store and the product, makes the Stripe Checkout Session on the creator's own account, and answers with a redirect (303) to Stripe's page.
3. **Stripe's part.** The buyer's browser loads Stripe's hosted payment page from Stripe's servers.

## The budget, in CI

`tests/checkout-speed-budget.test.ts` counts our part. It does not time it, because a timer depends on the machine and would make CI fail at random. For one plain product, measured on main on 15 November 2026, the route makes these calls before it answers:

| What | At most |
| --- | --- |
| Database round trips | 7 |
| Database commands | 10 |
| Requests to Stripe | 1 (`POST /checkout/sessions`) |

The work the route leaves for after its answer (`after()`: counting the visit, the A/B tests) runs while the buyer is already on the way to Stripe, so it is not in the budget. A change that adds a wait before the redirect fails this test, and whoever raises a figure says why in the same change. A lower figure is welcome, and the budget is then lowered to it.

This unit covers the plain product only. Options, bundles, gifts, extras and the cart go through more checks and are left for a later unit, measured the same way.

## What is not ours

- **Stripe's page.** How fast Stripe's hosted page loads is up to Stripe and the buyer's network. We promise no time for it, here or anywhere a buyer or creator can read.
- **The buyer's device and network.** A slow phone or connection slows every step, ours included.

## Looking up Stripe's address ahead of the click (not done)

Browsers can be told to look up a domain's address early (`dns-prefetch`) or to open a connection to it early (`preconnect`).

- **`preconnect` is not used.** It would open a secure connection to Stripe for every visitor of a product page, including people who never buy. That hands the visitor's IP address to a third party before any click, which the privacy policy does not cover today.
- **`dns-prefetch`** only asks the visitor's own address resolver, not Stripe, so it does not tell Stripe about the visitor. It belongs on the pages with a Buy button only, which today are `app/[handle]/p/[product]/page.tsx` and `components/store-product.tsx`. On 15 November 2026, 32 open pull requests changed those files or the store's layout, so it is left for a later unit, once those are in. Whether it needs a line in the privacy policy is checked then.

## What this unit does not change

No price, limit, commission, flag or gate. No new supplier, request or stored data: the test only counts what the route already does.
