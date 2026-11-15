# Trying the plan checkout in test mode (444 [TS2])

Design written by Claude 6 on 15 November 2026, from the code on main (c7d83ef202) and from the store test mode design, [docs/store-test-mode.md](store-test-mode.md) (443 [TS1], on main since its review; its unit 8 is this item). It records what exists, what TS1 decides, how TS2 reuses it, the gate that keeps a real subscription impossible, how a test session is kept apart from real ones, the units, their tests and the open questions. Only unit 1 is built with it; nothing here is on for anybody.

## What the item asks

A creator in test mode can go through the plan subscription screen of any plan (Store, Studio, Scale), monthly or yearly, in every payment method offered, in Stripe's test mode, seeing what they would see subscribing for real, with no charge and no paid right switched on. PLANS_ON_SALE and every gate stay as they are: with the locks closed, a real subscription stays impossible.

## What exists (reuse, do not rebuild)

| Piece | Where | What it does today |
| --- | --- | --- |
| The real plan checkout | `app/api/billing/checkout/route.ts` → `createBillingCheckout` in `lib/billing.ts` | Owner only (`creatorFrom(request, "billing")`). Refuses while `PLANS_ON_SALE` is false, before Stripe is asked. Otherwise reserves contract funding, then opens a `mode=subscription` Checkout Session on **our own** account with `STRIPE_SECRET_KEY` (`onPlatform`), `locale=en`, `payment_method_collection=always`, the trial when `trialOfferedTo` says so, 3D Secure on a yearly first payment, the price from `ensurePrice` (or inline), and `metadata[store]`/`subscription_data[metadata][store]`/`[tier]` |
| Payment methods | the same session | No `payment_method_types` is sent, so Stripe shows the methods enabled in the account's payment method configuration **for the key's mode** |
| The way back | `app/api/billing/return/route.ts` → `readStartedSubscription` | Reads the session with `STRIPE_SECRET_KEY` and writes the subscription onto the store (`setSubscription`). It does not read `livemode` |
| Finding a store's plan | `findStoreSubscriptions`, `syncSubscriptions` (`lib/billing.ts`, `lib/billing-sync.ts`) | Subscription Search by `metadata['store']:'<handle>'` with `STRIPE_SECRET_KEY`. There are no Stripe webhooks: everything is read back by polling |
| A key that can only be a test key | `demoKey()` in `lib/demo-account.ts` | `STRIPE_DEMO_SECRET_KEY`, taken only when it starts with `sk_test_`/`rk_test_` |
| Test mode for a store's sales | `sellsInTestMode` in `lib/stripe-connect.ts` | The demo's account, or the whole site on a test key. Sales only, on the creator's connected account; it has nothing to do with our own plan billing |

## What TS1 decides for TS2 (its unit 8)

- "Try the plan checkout" appears only while `STORE_TEST_MODE_ON` is true and the store is in test mode (TS1 unit 1). While the switch is false, nothing of TS2 appears in the studio (VR).
- It has **a route and signing of its own on a test key**: `onPlatform` signs with the live platform key.
- The real route `app/api/billing/checkout` is **not touched** and keeps refusing while `PLANS_ON_SALE` is false.
- Its return does not pass through `/api/billing/return`; if a test session ever reached that route, the route refuses it (`livemode: false`).
- Tests: a test subscription never changes `planOf`, the limits or any gate, and every payment method offered is reached.
- **The key is the owner's choice** (TS1, "What depends on the owner"): `STRIPE_DEMO_SECRET_KEY` if its account matches the live platform's settings, or a new test key of the platform's own account in Vercel as `STRIPE_TEST_SECRET_KEY`.

TS1's design is sound for TS2 and nothing in it contradicts what TS2 needs. One gap it leaves, which TS2 closes below: a test key and the live platform key can belong to **the same** Stripe mode (today the whole site may run on a test key), and then the real readers would see the test objects. TS2 therefore opens only when the two keys are in different modes.

## How TS2 reuses it (no second checkout)

- **One body, two signers.** `createBillingCheckout` is split (unit 2) into a pure `planCheckoutBody(choice, …)` that both the real and the test checkout use, so the screen is built from the same fields: plan line, locale, payment method collection, trial, 3D Secure on a year, currency. The real checkout adds what only a real one has (`customer`, `metadata[store]`, `[tier]`, the funding grant); the test checkout adds its mark and its own way back. `onPlatform` gains a signer argument with the live key as its default, so every existing caller is unchanged; `ensurePrice` keeps one price cache per mode.
- **The same price list.** The test price is made by `ensurePrice` under the same lookup key on the test key, and used only when its amount matches `lib/plan.ts`, exactly as the real one. No price is typed.
- **The same trial.** Whether the trial is shown is `trialOfferedTo` read with the live key, read-only, as the real route reads it, so the test screen says what the real one would. A read that fails opens nothing (no guess either way).
- **No second store, no second studio page.** The button sits beside the real one on the studio's plan section (`app/studio/page.tsx`), drawn only under the switch.

## The gate that keeps a real subscription impossible

Built in unit 1 (`lib/plan-test-checkout.ts`, `decidePlanTestCheckout`), and every condition must hold, or nothing opens and Stripe is not asked:

1. `STORE_TEST_MODE_ON` is true (passed by the caller; TS1 unit 1 owns the constant, which stays false).
2. The store is in test mode, read as a boolean. A store whose mode could not be read is refused.
3. The choice is a plan and an interval of `lib/plan.ts` (`parseTier`, `parseCycle`).
4. The test key is a **test** key (`sk_test_`/`rk_test_`), from the one place that reads it (`planTestKey`). A live key, a malformed one or none refuses.
5. The live platform key is a **live** key (`sk_live_`/`rk_live_`). Stripe keeps test and live objects apart, so every reader that signs with the live key (the real return, the daily sync, the subscription search, the trial history) can never see an object the test checkout made. While the site itself runs on a test key, or has no key, the two would not be apart, and nothing opens.

What the gate never reads or changes: `PLANS_ON_SALE`, `OPENING_REQUESTED`, the tax gate, art. 9a, the commercial review, `stripePlatformEligibilityReady`, `PRO_ON_SALE`. The real route keeps refusing whatever the test gate says, and the test gate signs only with a key that cannot take real money: a real subscription is impossible from it by construction, not by a flag.

## How a test session is kept apart from real ones

- **Never at the real Stripe account's live objects.** Signed only with the test key; the store's live `stripeCustomerId` is never sent (the test checkout uses `customer_email` with the creator's sign-in address, which is already confirmed by sign-in, as TS1 counts it).
- **Never read as a plan.** It carries `metadata[plan_test]=1` and never `metadata[store]`, `metadata[tier]` or a funding grant, so even a reader that could see it would find no store in it. The real way back refuses a session with `livemode` not exactly `true` (unit 4).
- **Never activates anything.** Its own way back reads the session with the test key and writes nothing onto the store: no `setSubscription`, no `planOf`, no limit, no trial, no funding reservation (`reserveContractFunding` is not called: no real obligation exists).
- **Never counted.** No sale, no revenue, no subscriber count, no Path figure, no benchmark, no company number reads test-key objects; the readers that count already sign with the live key.
- **Ended at once.** The way back ends the test subscription on the test key, so no test renewal goes on; a sweep ends any left behind (closed tab).
- **No email.** Marktmorgen sends none for a test plan checkout. Whether Stripe sends any customer email in test mode is not yet read from its dated documentation: unit 4 reads it and, if it can, turns those emails off on the test session or refuses to open.

## Units (tests first, each its own PR)

1. **The decision** (this branch). `planTestKey()` and `decidePlanTestCheckout(input)`: open only with the five conditions above, with the mode `"test"` and the key; otherwise one named reason. Pure, no Stripe, no Redis.
   Tests: every condition alone refuses; an unknown store mode refuses; a live, malformed or missing test key refuses; a test or missing live key refuses; every plan × interval opens with mode `"test"` and the test key, never the live key; `PLANS_ON_SALE` and the real route are untouched.
2. **One body, two signers.** `planCheckoutBody` out of `createBillingCheckout`; `onPlatform` with a signer (default live); `ensurePrice` cached per mode.
   Tests (stand-in Stripe): the real checkout's request is byte-for-byte what it was for every plan × interval, with and without a trial; the test body has the same screen fields, no `customer`, no `metadata[store]`/`[tier]`/funding, has `metadata[plan_test]`, and is signed with the test key only.
3. **The test route and its ceiling.** `app/api/billing/test-checkout` (read `node_modules/next/dist/docs` route handler guide first): owner only, the decision, a ceiling of test checkouts per store per day and per month admitted before Stripe is asked, then the session. Its cost line goes into `nonPayingWorst` (tests/plan-cost-registry.ts) and the exposure review; unknown fails.
   Tests: refused without each condition and past the ceiling with no Stripe request; a failed trial read opens nothing; the real route still answers `billing=not-open`.
4. **The way back, and the real one closed to tests.** `app/api/billing/test-return`: reads the session with the test key, ends its subscription, writes nothing, sends the creator to the studio with "This was a test. Nothing was charged and your plan did not change." `readStartedSubscription` refuses a session whose `livemode` is not exactly `true`.
   Tests: the store record is identical before and after; `planOf`, limits and gates unchanged; a `livemode: false` or missing `livemode` session at `/api/billing/return` writes nothing.
5. **Every payment method offered.** Before opening, the enabled methods of the payment method configuration are read in both modes; if the test mode does not offer every method the live one does, the studio says which are missing instead of claiming the same screen. A read that fails opens nothing.
   Tests: equal sets open; a method missing in test is named; an unreadable list refuses.
6. **The studio button.** "Try the plan checkout" beside each plan, under the switch only, with the test notice before it. Acessibilidade section (AX274) with its own checks.
7. **The sweep.** Ends test subscriptions left by a closed tab, on the test key, bounded per run.

## Open questions (Depende do dono)

- **Which test key**, as in TS1: `STRIPE_DEMO_SECRET_KEY` reused, or a new test key of the platform's own account as `STRIPE_TEST_SECRET_KEY`. Unit 1 reads only `STRIPE_TEST_SECRET_KEY`: with neither decided nor set, nothing opens. "Exactly what they would see" needs the platform's own test mode (same branding and settings); a sandbox's key may differ.
- **The site's own key.** While `STRIPE_SECRET_KEY` is a test key, TS2 stays closed (condition 5). Should it, instead, be allowed in that state with the separation proved another way? The default here is closed.
- **Payment methods in test mode** must be switched on by the owner in Stripe to match live; agents touch no Stripe setting.
- **The ceiling** of test plan checkouts per store (proposed: 5 a day, 20 a month), to be computed into `nonPayingWorst` in unit 3.

## Accessibility

Unit 1 has no screen. Units 4 and 6 carry their own Acessibilidade sections: the test notice in text before the button and on the way back, never by color alone; the button a real control with a name that says it is a test; the result announced in a live region.
