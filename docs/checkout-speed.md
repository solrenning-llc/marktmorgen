# Checkout speed (277 [H3-2])

What happens between a buyer's click on **Buy** and Stripe's payment page, which part of it is ours, and how CI keeps our part from growing. Units 1 to 7, 15 November 2026.

## The path

1. The buyer presses Buy on the product page, the checkout link or the embedded checkout. Each is a plain form posted to `POST /api/store/checkout` (`app/api/store/checkout/route.ts`). The cart's Buy posts to `POST /api/store/cart` (`app/api/store/cart/route.ts`), and a call's chosen time to `POST /api/store/book` (`app/api/store/book/route.ts`).
2. **Our part.** The route checks the request, reads the store and the product, makes the Stripe Checkout Session on the creator's own account, and answers with a redirect (303) to Stripe's page.
3. **Stripe's part.** The buyer's browser loads Stripe's hosted payment page from Stripe's servers.

## The budget, in CI

`tests/checkout-speed-budget.test.ts` counts our part. It does not time it, because a timer depends on the machine and would make CI fail at random. Measured on main on 15 November 2026, the routes make these calls before they answer:

| What | One plain product (`POST /api/store/checkout`) | A cart of two plain products (`POST /api/store/cart`) |
| --- | --- | --- |
| Database round trips | 7 | 8 |
| Database commands | 10 | 12 |
| Requests to Stripe | 1 (`POST /checkout/sessions`) | 1 (`POST /checkout/sessions`) |

Unit 3 holds three more cases of `POST /api/store/checkout` the same way, each with one request to Stripe:

| Case | Database round trips | Database commands |
| --- | --- | --- |
| A box checked at checkout (an extra product) | 7 | 10 |
| Bought as a gift | 8 | 11 |
| A fixed bundle | 7 | 10 |

Unit 4 adds three more, also with one request to Stripe each:

| Case | Database round trips | Database commands |
| --- | --- | --- |
| A price option (with its own delivery) | 7 | 10 |
| A bundle the buyer builds (two picked of three) | 7 | 10 |
| A payment plan (three monthly payments) | 8 | 11 |

Unit 5 holds the recurring and the early money, one request to Stripe each; the test also checks that each took its own kind of session:

| Case | Database round trips | Database commands |
| --- | --- | --- |
| A monthly subscription (`mode=subscription`) | 7 | 10 |
| A pre-order of a coming-soon product | 7 | 10 |

Unit 6, one request to Stripe each; the test checks that the physical product's session asks for the delivery address and the course's does not:

| Case | Database round trips | Database commands |
| --- | --- | --- |
| A course | 7 | 10 |
| A physical product (shipped to North America) | 7 | 10 |

Unit 7, a paid call booked at a chosen time (`POST /api/store/book`), does more before its redirect: it holds the time for the buyer first and reads the paid calls already booked from Stripe.

| Case | Database round trips | Database commands | Requests to Stripe |
| --- | --- | --- | --- |
| A paid call | 15 | 17 | 2 (`GET /checkout/sessions`, then `POST /checkout/sessions`) |

The work the route leaves for after its answer (`after()`: counting the visit, the A/B tests) runs while the buyer is already on the way to Stripe, so it is not in the budget. A change that adds a wait before the redirect fails this test, and whoever raises a figure says why in the same change. A lower figure is welcome, and the budget is then lowered to it.

## Summary (277 [H3-2], units 1 to 7)

Every way a buyer pays is held to a budget in CI: a plain product, a cart, an extra checked at checkout, a gift, a fixed bundle, a price option, a bundle the buyer builds, a payment plan, a monthly subscription, a pre-order, a course, a physical product and a paid call. For each, `tests/checkout-speed-budget.test.ts` (37 checks) counts the database round trips, commands and requests to Stripe before the redirect, checks that the case took its own path where that path differs, and fails if any figure grows. Lowering each ceiling by one was checked to fail.

Not in the budget: the work after the answer (`after()`), Stripe's own page, and the buyer's device and network. Not done: looking up Stripe's address ahead of the click (below), left for when the Buy-button files are free.

## What is not ours

- **Stripe's page.** How fast Stripe's hosted page loads is up to Stripe and the buyer's network. We promise no time for it, here or anywhere a buyer or creator can read.
- **The buyer's device and network.** A slow phone or connection slows every step, ours included.

## Looking up Stripe's address ahead of the click (not done)

Browsers can be told to look up a domain's address early (`dns-prefetch`) or to open a connection to it early (`preconnect`).

- **`preconnect` is not used.** It would open a secure connection to Stripe for every visitor of a product page, including people who never buy. That hands the visitor's IP address to a third party before any click, which the privacy policy does not cover today.
- **`dns-prefetch`** only asks the visitor's own address resolver, not Stripe, so it does not tell Stripe about the visitor. It belongs on the pages with a Buy button only, which today are `app/[handle]/p/[product]/page.tsx` and `components/store-product.tsx`. On 15 November 2026, 32 open pull requests changed those files or the store's layout, so it is left for a later unit, once those are in. Whether it needs a line in the privacy policy is checked then.

## What this unit does not change

No price, limit, commission, flag or gate. No new supplier, request or stored data: the test only counts what the route already does.
