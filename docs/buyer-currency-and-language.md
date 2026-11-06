# The buyer's language and currency at checkout (22 [E5], with 208 [SH5] and 393 [CX4])

Design written by Claude 2 on 1 November 2026, from the code on main, and corrected the same day after an independent review. Nothing is built by this document. It records what exists, what Stripe's own pages say (read that day), the parts of E5, how they meet 208 [SH5] and 393 [CX4], and the units, so nothing is built twice.

## What E5 asks

- The checkout uses the browser's language, among the languages the store already offers.
- Prices in several currencies, set by the creator, with no automatic conversion and no exchange cost for the platform.

## What exists

| Piece | Where | Today |
| --- | --- | --- |
| A store's language | `store.language`, `lib/store-language.ts` (7 languages), the buyer words in `lib/buyer-words` | **One language per store.** Every page of the store, its emails and its checkout speak it. Stripe's Checkout is opened in it (`locale: LANGUAGES[store.language].stripe`, `lib/store-checkout.ts`). |
| A store's currency | `store.currency`, `lib/money.ts` (each currency's rules: decimals, minimum charge, price range) | **One currency per store.** The checkouts of a product, the cart, a tip, a call and a call package send `price_data` in `store.currency`. Pay what you want already uses a Price on the creator's account (`lib/pay-what-you-want.ts`, `pwywPriceId`). Payment requests use the currency kept with the request. The offer after paying is a PaymentIntent in `store.currency` (`lib/upsell.ts`). Tier and yearly switches make Prices in `store.currency`. About 100 files outside the tests read `store.currency`. |
| Automatic conversion | `inTheCurrencyShown`, `lib/instant-pay.ts` | **Every Checkout already sets `adaptive_pricing[enabled]=false`** (product, cart, tip, payment request, call, call package, billing), so the buyer pays exactly the amount shown, with no 2–4% conversion charge. |
| No exchange for the platform | `fees_collector: "stripe"`, `lib/stripe-connect.ts` | Direct charges on accounts whose fees Stripe collects: a conversion fee, where there is one, is never the platform's. |
| Site languages | `docs/site-languages.md` | Translating the platform has an approved design and a deferred launch. It says "Store buyer language is a separate existing feature": stores with several languages are neither built nor designed anywhere. |

## Part 1: the checkout's language

A store offers one language, so "the browser's language among the store's" is the store's language, and that is what Checkout already opens in. **Nothing is missing today.** The part becomes real only when a store can offer more than one language, which is neither built nor designed. At that point the checkout takes the buyer's choice of the store's languages. It does not take Stripe's own browser detection, which could open Checkout in a language the store does not speak: Stripe's reference for `locale` says "If blank or `auto`, the browser's locale is used" (docs.stripe.com/api/checkout/sessions/create, read on 1 November 2026).

## Part 2: prices in several currencies

What Stripe's page "Manual currency prices" (docs.stripe.com/payments/checkout/localize-prices/manual-currency-prices, Stripe-hosted variant, read on 1 November 2026) says:

- A Price can carry other currencies in `currency_options`, each with its own amount set by the seller. Checkout "automatically handles currency localization", by the customer's location, unless the session names a currency.
- Localization needs every price, shipping rate and discount in the session (and an upsell's price) to have that currency. With Stripe Tax, the `tax_behavior` must be set for that currency. Otherwise the session falls back to the default currency.
- It is not available for sessions that use manual tax rates or `payment_intent_data.application_fee_amount`.
- Stripe "recommends using Adaptive Pricing instead", and manual prices override Adaptive Pricing for their currencies.
- Fees: Stripe's standard fees apply, including "Currency conversion fee", on automatically converted transactions.

What that means here:

- **Every line a Price, not `price_data`.** `line_items.price_data` has no `currency_options` (Stripe's reference, read on 1 November 2026), and every line must carry the currency or the session falls back. So every line of a localized session becomes a Price on the creator's own account: the product, the order bump, added items, the cart's lines, options, payment plans and subscriptions. The model to reuse is `pwywPriceId` (`lib/pay-what-you-want.ts`), which already keys a Price by its shape, keeps it in Redis, sends an idempotency key, and remakes it when the creator archived it. Its shape must also hold the tax setting, because a Price's `tax_behavior` cannot be changed once set. Shipping can stay inline: `shipping_rate_data.fixed_amount.currency_options` exists, with `tax_behavior` per currency.
- **Every amount needs the creator's own amount in each currency**, or the session falls back. That covers options, payment plans, the order bump, an intro price (`lib/intro-coupon.ts`), fixed-amount coupons (`lib/discount.ts`), shipping, the year, packages, and pay what you want's minimum and suggestion (`currency_options.<currency>.custom_unit_amount` exists).
- **Adaptive Pricing stays off.** E5 asks for no automatic conversion, and the code already turns it off on every Checkout. Whether `adaptive_pricing[enabled]=false` also stops localization by `currency_options` is not said by Stripe: the reference only says "Defaults to your dashboard setting". Nor does the page say outright that manual prices localize on a direct charge on a connected account; it only restricts `application_fee_amount` and `transfer_data.amount`. Both are unknown and fail until proven in test mode on a connected account (as `lib/verify-stripe.ts` proves the site's other Stripe requests), before unit 2.
- **Not Checkout lines.** The offer after paying (`lib/upsell.ts`) and the subscription switches (`lib/tier-switch.ts`, `lib/yearly-switch.ts`) are API charges and Prices: Stripe "processes the amount and currency you explicitly provide". They must take the order's or the subscription's own currency, with the creator's amount in it, or a buyer who paid in euros is offered a charge in dollars.
- **No exchange cost for the platform.** These are direct charges on the creator's account, and the accounts are made with `fees_collector: "stripe"`. A conversion fee, where Stripe charges one, falls on that account, never on Marktmorgen's. The creator is told so beside the field.
- **Commission.** The restriction on `application_fee_amount` matters only if a commission ever goes live through an application fee. Today `COMMISSION_LIVE` is false, and under SR5 the Brazilian platform takes no application fee outside Brazil. Subscriptions would use `subscription_data[application_fee_percent]` (`lib/platform-share.ts`), which Stripe does not list as a restriction, but a fee in another currency could mean exchange for the platform. Recorded so that day stops neither localization nor the no-exchange rule silently.
- **The money everywhere else.** Several readers already take a sale's own currency: the thanks page, the purchase email and the tier switch. Some already keep other currencies apart: the numbers' "elsewhere" (`lib/stats.ts`), the buyer profile, affiliates, the Path and member health. Others suppose `store.currency`: the offer after paying, the sweep, and the numbers' main totals, which would put a euro sale under "elsewhere". So that unit starts with an inventory of each reader. No conversion may be made up to add amounts. Where a tax counter adds sales (`lib/tax-threshold.ts`, in CAD or NOK) or an art. 9a/OSS record needs one currency, the official rule of that place converts, never a made-up rate; unknown fails.
- **What the page says.** The store page, the cart and the structured data (`components/structured-data.tsx`, `priceCurrency`) show `store.currency`, while Checkout may show another currency by location. Before the checkout unit, the design decides what the page says (VR 2: nothing shown that is not what happens).

## How it meets 208 [SH5] and 393 [CX4]

- **208 [SH5]** studies Stripe's automatic conversion (Adaptive Pricing). Stripe's Connect page (docs.stripe.com/connect/currencies/adaptive-pricing, read on 1 November 2026) already answers much of it:
  - "Neither you nor your connected accounts directly pay"; the customer pays 2–4%;
  - refunds use the same exchange rate at no extra cost;
  - it lists countries;
  - the integration's currency must be a settlement currency of the seller;
  - international subscriptions are limited to cards, Link, Apple Pay and Google Pay;
  - it is controlled in the platform's Connect settings and per session.

  It stays off today. E5's manual prices are not overrides on top of it: E5 asks for no automatic conversion, so its sessions keep it off, and only SH5's own creator switch could turn it on. Taking part of SH5 into E5's unit 0 is a partial absorption, recorded on item 208 too. Anything only Stripe can answer goes to the owner's daily questions to Stripe, never sent by an agent.
- **393 [CX4]** asks for a price per **country**, beyond per currency. `currency_options` picks by currency, so two countries that share the euro get one price. A price per country needs the country detected by our own code and the price chosen before the session, with an honest note to the buyer, which is CX4's own work. The model below keeps room for it: an amount per currency now, per country later.

## Units (tests first)

0. **This design**, with 208 [SH5]'s answers from Stripe's Connect page above.
1. **The model, with no screen.** `currencyPrices` on a product and on every amount it carries (options, plans, bump, intro price, fixed coupons, shipping, year, packages, pay what you want), each held to that currency's own range (`priceInRange`) and to the currencies Stripe offers on the creator's account. Nothing shown, so nothing pretends to work. Also the test-mode proof of the two unknowns above.
2. **The money everywhere else** (inert while every order is in the store's currency): the inventory, then every reader taking the order's own currency, totals per currency, never converted, and the offer after paying and the subscription switches charging in the order's or subscription's currency. Each reader gets a test.
3. **The checkout and the fields, together.** Every line as a Price with `currency_options` on the creator's account (on `pwywPriceId`'s model), shipping inline with its options, `tax_behavior` per currency, Adaptive Pricing still off, what the page says decided, and only then the editor's fields, in the same PR.
4. **The language part**, once stores with several languages are designed and built.
5. **393 [CX4]**, the price per country, on the same model.

## Cost and margin

- No new supplier and no platform exchange cost.
- Each Price made on a creator's account is a Stripe request, and its Redis keys (as `nl:pwyw:*`) are not free. There is no checkout request budget to fold them into; the existing request units (`takeBuyerRead`) are the mechanism.
- The extra per-product amounts are a few bytes inside the product's record, within the store's data room.
- Unit 1 states the requests, keys and bytes in numbers; unknown fails.

## Accessibility for every unit

- Each unit's PR carries its own Acessibilidade section (AX274).
- The currency fields are labelled with the currency's name and code.
- A buyer is never shown a converted amount we made up: only the creator's own amounts, or Stripe's on its own page.
