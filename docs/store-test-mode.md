# Store test mode (443 [TS1], with 444 [TS2])

Design written by Claude 2 on 1 November 2026, from the code on main, and corrected the same day after an independent review. Nothing is built by this document. It records what test mode can reuse, the choices it needs, the gaps as units, and what depends on the owner, so nothing is built twice.

## What the item asks

- **(a) Switch and selling.** Every creator, with or without a paid plan, can switch "Test mode" on and off in their own store. While it is on, the store sells only in Stripe's test mode (test card 4242 4242 4242 4242), with the same checkout, delivery, emails, orders, refunds and reports as a real store. No real money moves and no real card is taken.
- **(b) Honesty.** The store says it is a test store, with no charge, before any payment form. No test sale counts in public numbers, platform statistics, reviews or buyer counts.
- **(c) No abuse.** Purchase and delivery emails go only to addresses the creator has verified: no email to anyone else, no review and no real sale. Test orders stay apart and marked as tests after test mode is switched off.
- **(d) Cost.** A funded exposure with automatic daily and monthly ceilings on orders, emails, files and AI calls, computed first. Unknown fails.
- **444 [TS2].** The creator in test mode can go through the plan subscription screen of any plan, in every payment method offered, in Stripe's test mode, with no charge and no paid right switched on. PLANS_ON_SALE and every gate stay as they are.

## What already exists (reuse, do not rebuild)

| Piece | Where | What it does today |
| --- | --- | --- |
| A store that sells in Stripe's test mode | `sellsInTestMode` in `lib/stripe-connect.ts:78`. Read by the store page, the product page, the tip box (its `rehearsal` prop), the embed, payment requests, the Path (`lib/path-facts.ts`) and `app/studio/path/page.tsx` | True for the demo's account, or when the whole site runs on a test key. A "rehearsal" notice is shown before paying on the store, product, tip, embed and payment-request pages. It is **not** shown yet on the booking page (`app/[handle]/book/[product]/page.tsx`, `components/slot-picker.tsx`, `components/session-picker.tsx`), on call packages or on the one-tap offer after paying |
| A key that can only ever be a test key | `demoKey()` in `lib/demo-account.ts`, `keyFor(account)` in `lib/stripe-account.ts:43`, through which every `onAccount` request passes | The demo's account is signed only with a key that must start with `sk_test_`/`rk_test_`. `keyFor` is synchronous and decides by the account id alone |
| The order's own mode | `livemode` on the Checkout Session, already read by `lib/path-facts.ts`, `lib/path-growth-money.ts` and `lib/dispute-purchase-review.ts` | Stripe marks every test session `livemode: false`; there is no need for a mark of our own |
| Orders without a webhook | `readOrder` in `lib/store-checkout.ts`, the five-minute sweep `lib/checkout-sweep.ts` | An order is read from its session by the thanks page and the sweep. The sweep also sends sales to the creator's webhooks, ad platforms and email platforms |
| The demo writing to no buyer | `canConfirm` in `lib/purchase-email.ts` (by the demo's account), and `isHouseStore` at the points that write to third parties or count: store-join, calls, inbox, store-contact, store-assistant, assistant-reminder, next-offer, checkout-sweep, thanks, benchmarks, affiliate-directory, `takesReviews` | The demo sends no buyer email and stays out of shared numbers. Other `isHouseStore` calls only put the store's name on the checkout or draw the demo's own words, and are **not** test-mode points |
| Paying nothing, bounded | `lib/free-pool.ts` (`admitNonPaying`), `lib/free-pool-rules.ts` (`FREE_POOL_BASE_STORES` 10), `NON_PAYING_ALLOWANCES` in `lib/store-allowance-rules.ts`, `TRIAL_VISITS`/`TRIAL_ORDERS` in `lib/order-rules.ts`, `nonPayingWorst` in `tests/plan-cost-registry.ts` | A store without a paid plan holds one of the month's shared places before it costs anything. Its figures are monthly windows: studio, API, inbox, email, transactional, integration, buyer and webhook. Visits and orders are capped only for a trial. **No AI and no uploads** for a store without a plan (`lib/ai-spend-policy.ts`, `lib/upload-budget-policy.ts`) |
| Confirming an address | `lib/recovery-address.ts` | A code emailed and typed proves an inbox |
| Stripe's own test accounts | docs.stripe.com/connect/testing, read on 1 November 2026 | "You can create multiple test accounts" through the Accounts API or the Dashboard, with test values for onboarding (`000000000` for an ID number, `address_full_match`, the date of birth `1901-01-01`, the SMS code `000-000`), and "Sandboxes might not enforce some capabilities" |

## The choices

### Whose Stripe account a test sale is made on

- **A. Every test store charges the demo's account.** It is the least work, but the creator would see an account that is not theirs. Their test buyers' names and addresses would sit beside every other store's on one account, read with one key, and every report would need a store filter on every read. **Not chosen.**
- **B. Each store gets a test account of its own** (recommended). It is created with a **test** platform key, and the creator goes through Stripe's onboarding with Stripe's own test values, as they will for real. Its id is kept beside the live one (`testStripeAccountId`). What the creator sees is then what a real creator sees, onboarding included, and nothing is shared between stores.

**Which test key.** `STRIPE_DEMO_SECRET_KEY` is already a test key used as a platform key with the `Stripe-Account` header (`lib/demo-store.ts`). It may be the platform's own test-mode key, or a sandbox's. B can reuse it only if its account's Connect settings match the live platform's (account type, onboarding, branding). Otherwise B needs a separate key. Which one is true is not visible from the code: **the owner says**.

### How a request knows it is a test

`keyFor(account)` cannot tell a test account from a live one by its id. So every request on a store's account goes through one function, `sellingAccount(store)`, which returns the account and the mode together, instead of reading `store.stripeAccountId` directly. Today `store.stripeAccountId` is read in about 270 places across about 90 files of `lib/` and `app/`. `keyFor` takes the mode and signs a test account only with a test key.

**Fail closed.** With `testMode` on and no test account ready (created and with charges enabled), no checkout opens, and the store never falls back to its live account under a test notice.

### PayPal

PayPal is a real-money path beside Stripe (`paypalReady` in `lib/paypal-sales.ts`, `byPayPal` on the product and store pages). In test mode it is **closed**: no test store offers live PayPal. A PayPal sandbox (`PAYPAL_ENV=sandbox` exists in `lib/paypal-sales.ts`) would be a separate decision of the owner's.

## Gaps against the item (each a unit, tests first)

1. **The switch, off in the code.** `STORE_TEST_MODE_ON = false`, in the pattern of `ZOOM_APPROVED`, until unit 7's review passes. While it is false, neither the switch nor "Try the plan checkout" appears in the studio (VR). A store field `testMode`, changed only by the store's owner (team roles), with the time it changed.
2. **The test account (B) and `sellingAccount`.**
   - "Set up test payments" in the studio creates the test account with the test key and opens Stripe's test onboarding.
   - `sellingAccount(store)` replaces every direct read of `store.stripeAccountId`, and `keyFor` takes its mode.
   - Tests: a live key never signs a test account; test mode without a ready test account opens no checkout.
   - The tests use the local stand-in (`STRIPE_CONNECT_API_BASE` on 127.0.0.1) and create no real test account.
3. **Selling in test mode.**
   - **Its own selling condition:** a test account with charges enabled, the store not suspended, and a free-pool place. It does not change `canSell` (which needs a paid plan) or any gate of real selling.
   - **Every path charges the test account:**
     - the product, with its gift, bundle, group and subscription forms (`lib/store-checkout.ts`), the funnel and the embed;
     - the cart, tips, payment requests, bookings and call packages;
     - the offer after paying (`lib/upsell.ts`, off-session);
     - card update (`lib/card-update.ts`) and subscription changes (`lib/tier-switch.ts`, `lib/yearly-switch.ts`, `lib/membership-pause.ts`, `lib/membership-manage.ts`);
     - refunds (`lib/refunds.ts`).
   - **Reading back:** the thanks page, the sweep, the buyer's orders, the library and the reports read from the same test account.
   - **Discount codes and coupons** (`lib/discount.ts`, `app/api/store/sale`, the intro, fair and save-offer coupons) are made on the test account too, or refused there with the reason. Without that, "the same checkout" is not met.
   - **PayPal is closed** (above).
4. **Honesty and counts (b).**
   - **The notice:** "This store is in test mode. Nothing is charged." It is in every buyer language (`lib/buyer-words`), before every payment form, including the booking page, call packages and the offer after paying, where it is missing today.
   - **The counts:** no session with `livemode: false` counts in public numbers, buyer counts, benchmarks, the Path's money, affiliates' commissions or the company's numbers. Each reader that counts orders has a test.
   - **Reviews:** no review is asked for or taken in test mode (`takesReviews` false). (c) forbids reviews, not only counting them.
5. **No email to anyone not confirmed (c).**
   - The creator confirms up to a few test buyer addresses by a code, as the recovery address does; the sign-in address counts already.
   - **One check inside `sendEmail`** (`lib/email.ts`), carrying the store's mode, refuses every recipient that is not confirmed while the store is in test mode. That covers:
     - the purchase and delivery emails;
     - gifts (`lib/gifts.ts`) and group purchases (`lib/group-buy.ts`);
     - bookings (`lib/calls.ts`) and review requests;
     - license keys (`lib/licence-keys.ts`) and preorders (`lib/preorders.ts`);
     - payment recovery (`lib/payment-recovery.ts`) and shipments (`lib/shipments.ts`);
     - membership and community notices.
   - **No other way out:** no test sale reaches the creator's webhooks, ad platforms or email platforms (the sweep).
   - **Closed in test mode:** the inbox, the assistant and the list stay closed at the points listed above. This is a departure from "the same as a real store" in (a), justified by (c), and is said on the switch.
6. **Switching off (c).** Test orders stay, marked by their own session's mode and kept apart: a "Test orders" view, never in the real list or exports unless asked. The test account is kept for the next test. Switching off never touches real orders.
7. **Cost (d).** The figures it needs do not all exist, so they are made here:
   - **A new ceiling on test orders,** daily and monthly, admitted in `lib/order-admission.ts` before the checkout opens, for every store in test mode, a trial and no plan included. Today `lib/order-admission.ts` does not count a trial or a store with no plan, and a trial's paid orders were limited only by costing their buyer a card payment, which a test card does not.
   - **Daily windows,** which do not exist (`lib/allowance-window.ts` is monthly), for orders, emails and file deliveries.
   - **A paid store in test mode** spends its plan's own order figure (`paidOrdersLimitFor`), and the studio says so, because it lowers what is left for real sales.
   - **AI and uploads stay at zero** for a store without a plan in test mode, unless a new funded line is computed into `nonPayingWorst`. Until then, test mode for such a store is limited to products without a new file (links, courses, calls); recorded in "Depends on the owner".
   - **The worst window** of a test store is added to `nonPayingWorst`, and the review in docs/funded-exposure-review.md gets a test-mode line.
   - **MR:** if the larger `nonPayingWorst` fails any unit, the switch stays false, no price or visible limit changes, and docs/margin-alignment is regenerated. Unknown fails.
8. **444 [TS2], the plan screen.**
   - In test mode, "Try the plan checkout" opens a subscription checkout for any plan and every payment method offered. It has a route and signing of its own on the test key: `onPlatform` signs with the live platform key (`lib/billing.ts`).
   - The real route `app/api/billing/checkout` is not touched and keeps refusing while PLANS_ON_SALE is false.
   - Its return does not pass through `/api/billing/return`. If it ever did, that route refuses a session with `livemode: false`.
   - Tests: a test subscription never changes `planOf`, the limits or any gate, and every payment method offered is reached.

## What depends on the owner

- **The test key.** Whether `STRIPE_DEMO_SECRET_KEY` belongs to an account whose Connect settings match the live platform's (then B reuses it), or a new **test** key is created in the platform's Stripe account and set in Vercel as `STRIPE_TEST_SECRET_KEY`. Agents create no key and touch no Stripe setting.
- **Turning it on.** `STORE_TEST_MODE_ON` changes to true only after unit 7's numbers are in the exposure review, in a reviewed PR.
- **Files and AI** for a store without a plan in test mode: zero (test mode without new files), or a new funded line.
- **PayPal sandbox** in test mode, or PayPal closed (the default here).
- **How many confirmed test addresses** a store may have (proposed: three, besides the sign-in address).

## Accessibility for every unit

- Each unit's PR carries its own Acessibilidade section (AX274).
- The switch is a real control with its state said in words, and with what test mode closes (inbox, assistant, list) said beside it.
- The test-mode notice is text, not color alone, placed before every payment form, in every buyer language.
- The "Test orders" view keeps the order list's own structure.
