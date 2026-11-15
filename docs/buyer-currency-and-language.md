# The buyer's language and currency at checkout (22 [E5], with 208 [SH5] and 393 [CX4])

Design written by Claude 2 on 1 November 2026, from the code on main, and corrected the same day after an independent review. Nothing is built by this document. It records what exists, what Stripe's own pages say (read that day), the parts of E5, how they meet 208 [SH5] and 393 [CX4], and the units, so nothing is built twice.

## What E5 asks

- The checkout uses the browser's language, among the languages the store already offers.
- Prices in the buyer's currency, in two ways the creator chooses between (owner's decision of 14 November 2026, below), with no exchange cost for the platform.

Until 14 November 2026 the second line read "prices in several currencies, set by the creator, with no automatic conversion". That wording is kept here as history; the sections below that say "Adaptive Pricing stays off" or "E5 asks for no automatic conversion" are read under the decision that follows.

## The owner's decision of 14 November 2026, 22h (Fortaleza)

Received through the coordinator's task to Claude 1 cloud E on 15 November 2026. It changes the request of item 22 [E5], which asked for no automatic conversion.

- **(a) Automatic, the default.** Stripe's Adaptive Pricing converts the price into the buyer's currency, and the buyer pays the conversion charge. The creator does nothing.
- **(b) Manual, an option.** The creator sets their own price per currency, in `currency_options`. Stripe uses a manual price before the automatic one in that currency.

**Why:** to sell to the EU, the UK, Canada and the rest of the world from the first day. A buyer who meets a price in a currency they do not use leaves more often, and the competitor Stan already shows prices in the buyer's currency by automatic conversion.

**What does not change:** everything stays off behind a new key, `BUYER_CURRENCY_LIVE = false` (lib/buyer-currency.ts). While it is false, every checkout keeps `adaptive_pricing[enabled]=false` (`inTheCurrencyShown`, lib/instant-pay.ts) and charges in the store's currency, as today. The buyer always sees the currency and the final amount before paying (on Stripe's page, which shows the converted total, and on ours, which says so once the key is on). Our reports never convert an amount on their own. No price, limit, commission, PLANS_ON_SALE, OPENING_REQUESTED, tax gate, art. 9a, commercial review or stripePlatformEligibilityReady moves.

## 208 [SH5]: Stripe's answers, read on 15 November 2026

Read by Claude 1 cloud E on 15 November 2026 from Stripe's own pages, in their Stripe-hosted Checkout variants: Adaptive Pricing (docs.stripe.com/payments/checkout/adaptive-pricing), Adaptive Pricing for Connect (docs.stripe.com/connect/currencies/adaptive-pricing), Manual currency prices (docs.stripe.com/payments/checkout/localize-prices/manual-currency-prices), Adaptive Pricing and Stripe Tax (docs.stripe.com/tax/calculating/adaptive-pricing), Direct charges (docs.stripe.com/connect/direct-charges), Connect currencies (docs.stripe.com/connect/currencies) and the Checkout Session reference (docs.stripe.com/api/checkout/sessions/create). Quotes are Stripe's words. Where a page says nothing, it is written "not stated", and an unknown fails until proven in test mode on a connected account.

### 1. Direct charges on a connected account whose fees Stripe collects; who pays the conversion

- Connect: "Adaptive Pricing lets customers of your connected accounts pay in their local currency." It is managed "for your connected accounts on Checkout in your connect settings in the Dashboard", and per session (`adaptive_pricing[enabled]`).
- Who pays: "Neither you nor your connected accounts directly pay any additional Stripe fees for Adaptive Pricing." "The Stripe-provided exchange rate you present to your customers includes a 2–4% conversion fee." "Your customer doesn't pay this fee if they choose to pay in your integration currency." So the buyer pays it, inside the converted price; never Marktmorgen, never the creator.
- The condition: "Adaptive Pricing requires your integration currency to be the settlement currency of the merchant of record on the charge." On a direct charge (`Stripe-Account` header, "This header indicates a direct charge for your connected account") the merchant of record is the creator's account, so the store's currency must be a currency that account settles in. Unknown means off.
- **Not stated:** direct charges, destination charges, `on_behalf_of` or `controller.fees.payer` (our `fees_collector: "stripe"`, lib/stripe-connect.ts) by name. Nothing on the pages excludes them; the test-mode proof on a connected account below is still needed before the key turns on.
- Reporting: what Stripe reports reflects "what your customer paid in your integration currency", with `presentment_amount` and `presentment_currency` beside it. So a sale converted automatically is recorded in the store's own currency, and the readers of unit 2 meet no new currency from (a). Only (b) puts a sale in another currency.

### 2. With `application_fee_amount` and `subscription_data[application_fee_percent]` (the commission, lib/platform-share.ts, off while COMMISSION_LIVE is false)

- **Adaptive Pricing with either fee: not stated** on the Adaptive Pricing pages. Direct charges: "The currency of `application_fee_amount` depends upon a few multiple currency factors"; Connect currencies: "Currency conversion (FX) can occur in payments, transfers, payouts, application fees". Nothing says in which currency the fee is taken when the buyer pays in a converted currency, or who bears an exchange on it.
- Under SR5 (AGENTS.md, Stripe's answer of 27 October 2026), the platform takes no application fee from accounts outside Brazil, so no commission is planned on those checkouts.
- **Reading used:** a session that carries any application fee stays in the store's currency, with Adaptive Pricing off, until a test-mode proof shows the fee and its currency. An unknown exchange on the fee could become an exchange cost of the platform, which the design forbids.

### 3. `currency_options` and the application fee: what a manual-price checkout does with the commission on

- Manual currency prices: "Price localization isn't available for Checkout Sessions that: Use manual tax rates. Use `payment_intent_data.application_fee_amount` or `payment_intent_data.transfer_data.amount`." Not stated: whether such a session errors or falls back, and anything about `subscription_data.application_fee_percent`.
- "Manually defined multi-currency prices override Adaptive Pricing for those currencies, even if it's enabled." Connect: "if a price has currency_options for EUR and GBP, Adaptive Pricing won't convert to EUR or GBP, but it can still convert to other currencies like CAD or JPY."
- Missing amounts: when a currency is not on every line, "the Session presents to the customer in the default currency".
- **Treatment proposed (not switched on):** with any application fee on the session, a manual-price checkout falls back to **the store's currency**, not to the automatic one: the manual price cannot localize (Stripe's limitation), and the automatic one is unproven with a fee (point 2). So the decision is made by our code before the session is sent, never left to Stripe's silent fallback, and the buyer is charged what our page shows. With no fee (the case under SR5 outside Brazil), a manual price is used in its currencies and the automatic one converts the rest. The rule is `buyerCurrencyPlan` in lib/buyer-currency.ts, with its tests; nothing turns it on.

### 4. Tax and refunds in another currency

- Stripe Tax with Adaptive Pricing: "all tax calculation, tax reporting, and invoicing remain in your integration currency"; "Stripe Tax calculates tax on the original price you set, not the converted amount"; "the destination jurisdiction determines the filing currency in the tax reports" (taxed at the buyer's destination: the EU's OSS, the UK's VAT, Canada's GST/HST); "Tax reports show amounts in the `currency` on the `Price`"; "For indirect tax purposes, Stripe Tax treats the conversion fee as a non-taxable currency conversion cost". On a refund, "Stripe Tax calculates the tax reversal based on the `Price` currency and amount".
- So with (a), the tax counters (lib/tax-threshold.ts) and the art. 9a/OSS records keep reading the store's currency; Stripe converts the filing amount by the destination's rule, and we convert nothing.
- With (b), the Price is in the buyer's currency, and Stripe Tax needs `tax_behavior` set for that currency (Manual currency prices). The sale is then in another currency, and a tax counter that adds sales must take the official rule of that place to convert it, never a rate of ours (this document, "The money everywhere else"); unknown fails.
- Refunds with (a): "You or your connected accounts can issue a refund in your integration currency, and Stripe refunds your customer in the currency they used to make the payment." "The refund uses the same exchange rate as the original transaction, so there are no extra costs for you." **Not stated:** any time limit on that rate. With (b), the charge itself is in the buyer's currency and is refunded in it; there is no exchange.
- Subscriptions: "For cross-border subscriptions, Adaptive Pricing supports only card payments, Link, Apple Pay, and Google Pay." Not supported: `capture_method` manual, and "businesses using Elements with the Payment Intents API" (the offer after paying, lib/upsell.ts, is a PaymentIntent, so it keeps the order's own currency, as unit 2 already does).
- Turning it off: "Disabling Adaptive Pricing doesn't affect Checkout Sessions that have already been converted or active subscriptions paid in customers' local currencies." Whether `adaptive_pricing[enabled]=false` also stops localization by `currency_options` is still **not stated**; manual prices are only sent with Adaptive Pricing on, so it does not matter for (b).

### Still to prove in test mode, before the key turns on

1. A Checkout Session made with `adaptive_pricing[enabled]=true` on a test connected account with `fees_collector: "stripe"` converts, and its session and charge read back in the store's currency with `presentment_details`.
2. The same with `currency_options` on a Price of that account.
3. What Stripe does with a session that has an application fee and Adaptive Pricing on (the fee's currency).
4. Not a proof but a gate: the read of the account's settlement currency (`settlesInStoreCurrency`, lib/buyer-currency.ts) gets its cache and its request units (`takeBuyerRead`) in unit 3b, before the key turns on; today it is never called, because the key is false.

Each is a request to Stripe's test mode on a test account (as lib/verify-stripe.ts proves the site's other requests), never a live account, made by whoever may use the test keys; no agent creates an account for it.

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
- **Adaptive Pricing stays off** (history, written before the owner's decision of 14 November 2026: now it stays off only while `BUYER_CURRENCY_LIVE` is false). E5 asked for no automatic conversion, and the code already turns it off on every Checkout. Whether `adaptive_pricing[enabled]=false` also stops localization by `currency_options` is not said by Stripe: the reference only says "Defaults to your dashboard setting". Nor does the page say outright that manual prices localize on a direct charge on a connected account; it only restricts `application_fee_amount` and `transfer_data.amount`. Both are unknown and fail until proven in test mode on a connected account (as `lib/verify-stripe.ts` proves the site's other Stripe requests), before unit 2.
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

  It stays off today. (History, before the owner's decision of 14 November 2026:) E5's manual prices are not overrides on top of it: E5 asks for no automatic conversion, so its sessions keep it off, and only SH5's own creator switch could turn it on. Since that decision, Adaptive Pricing is the default and manual prices are overrides on top of it, in their own currencies, as Stripe describes; both stay off behind `BUYER_CURRENCY_LIVE`. The answers above, read on 15 November 2026, complete this part of 208 [SH5]. Taking part of SH5 into E5's unit 0 is a partial absorption, recorded on item 208 too. Anything only Stripe can answer goes to the owner's daily questions to Stripe, never sent by an agent.
- **393 [CX4]** asks for a price per **country**, beyond per currency. `currency_options` picks by currency, so two countries that share the euro get one price. A price per country needs the country detected by our own code and the price chosen before the session, with an honest note to the buyer, which is CX4's own work. The model below keeps room for it: an amount per currency now, per country later.

## Units (tests first)

0. **This design**, with 208 [SH5]'s answers from Stripe's Connect page above.
1. **The model, with no screen.** `currencyPrices` on a product and on every amount it carries (options, plans, bump, intro price, fixed coupons, shipping, year, packages, pay what you want), each held to that currency's own range (`priceInRange`) and to the currencies Stripe offers on the creator's account. Nothing shown, so nothing pretends to work. Also the test-mode proof of the two unknowns above.
2. **The money everywhere else** (inert while every order is in the store's currency): the inventory, then every reader taking the order's own currency, totals per currency, never converted, and the offer after paying and the subscription switches charging in the order's or subscription's currency. Each reader gets a test.
3. **The checkout and the fields, behind `BUYER_CURRENCY_LIVE = false`.** Split in two after the owner's decision of 14 November 2026:
   - **3a.** The key, the creator's choice between (a) automatic and (b) manual (automatic when unset), and the rule that decides each session (`buyerCurrencyPlan`, lib/buyer-currency.ts): off while the key is false; the store's currency when the session carries an application fee (point 3 above) or when the store's currency is not known to be a settlement currency of the creator's account; otherwise Adaptive Pricing on, with manual prices before it in their currencies. Wired on the product checkout after the share is set, so the rule reads the session it judges. Nothing is shown while the key is false.
   - **3b.** Option (b) on the checkout: every line as a Price with `currency_options` on the creator's account (on `pwywPriceId`'s model), shipping inline with its options, `tax_behavior` per currency; what the page says (the store's currency, and that Stripe shows the buyer's own amount and currency before paying); and the creator's fields, shown only while the key is on.
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
