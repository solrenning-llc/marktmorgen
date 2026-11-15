# 361 [AP1] — Selling emails for the creator: design (unit 0)

Design only: nothing here is built, switched on or sent. Written by Claude 4 (nuvem V) on 15 November 2026 from the code on `main` that day. Symbols are named so they can be found; line numbers move.

The item asks for five templates in the existing automation engine. The creator switches each one on separately, approves its text, and nothing is on by default. The source the item cites (Patreon Autopilot, read 24 October 2026) is not re-read here. Patreon's claimed uplift is its own statement, not a forecast for Marktmorgen, and nothing below counts on it.

## What exists today

**The flow engine** (`lib/flows.ts`, `lib/flow-rules.ts`, `lib/flow-limits.ts`):
- Triggers (`FLOW_TRIGGERS`): joined, product, bought, tagged, finished, form, started, abandoned, stage, signed, paid_request. None is time-based or tier-based, and none counts back from an end date.
- A step is an email or an action, with conditions (`StepIf`: has, lacks, buyer, lead, tag, clicked, finished and the rest) and a goal.
- Each person starts a flow once: a 400-day claim.
- Limits: `ACTIVE_FLOWS_BY_TIER` = Store 0, Studio 10, Scale 20 (trial 3), and `DAILY_RUNS_BY_TIER`. A template built as a flow is unavailable on Store unless the engine's limits change, which is a visible-limit change this item does not authorize.
- Consent: `isMailable` (agreed and not unsubscribed) is checked at enrollment, and `tokensFor` checks it again at send time.
- Metering: flow emails go through `sendTo` in `lib/mail.ts`, which reserves from the monthly allowance and sends with `{ by: "monthly" }`. The newer store senders (`lib/yearly-ask.ts`, `lib/winback-send.ts`, `lib/member-nudge.ts`, `lib/welcome-offer-send.ts`) use `{ by: "store", kind: "email" }` with `takeAllowance`. The item's quota wording (309 [EM1], the store's quota with SES) matches the latter, so a template that sends must reserve from the store's quota before each send, whichever path it uses.

**Memberships** (`lib/tier-rules.ts`, `store.tiers`):
- Tiers are 2 to 6 paid recurring products.
- Their order is read from price (`direction`), not stored.
- A tier cannot carry a yearly price (`canTier` refuses `product.yearly`).
- There is no free membership level: "free" people are contacts with `source: "free"` (`lib/contacts.ts`) or free-product claimants.

**Locked content:**
- Community posts have no tier lock and no creator-chosen preview (`lib/community.ts` Post).
- Spaces can be limited to products and shown locked by name only (`lib/community-locked.ts`).

**Discounts on the creator's account** (`lib/store-checkout.ts`):
- One discount per checkout, chosen in a fixed order: welcome, win-back, intro, fair, sale, returning code, promotion code.
- `makeSaveCoupon` makes a `once` (first payment only) or `repeating` coupon, with no `redeem_by` and no `max_redemptions` (deliberately).
- The welcome offer (`lib/welcome-offer*.ts`) already gives a percent off the first payment (`WELCOME_PERCENTS` 10 to 50) for one product, to a free-product claimant. Its window comes from `WELCOME_HOURS` (up to 168 hours, 7 days) and is enforced on our side; the checkout opens none after it.

**Annual price** (`lib/yearly-price.ts`):
- A monthly product may carry a fixed yearly price (`activeYearly`).
- `lib/yearly-ask.ts` already emails running monthly members, from the third payment, once per membership, at the creator's yearly price, with no discount. It runs from the daily job and is refused when a member already has a discount (`yearlyChoice`).

**Access end** (`lib/membership-manage.ts`):
- `endsAtOf` reads `cancel_at`, or the period end when the subscription ends at period end, from the creator's Stripe subscription.
- Fixed terms are kept in metadata (`ends_after`, `lib/fixed-end-rules.ts`).
- There is no member reminder before the end, and no single "effective access date".
- `lib/course-access-expiry-rules.ts` is unused.

## Each template: what exists, what is missing, the safe shape

| Template | Exists | Missing | Safe shape |
| --- | --- | --- | --- |
| (a) Invite to the tier above, no discount | Tier switch with Stripe's prorated preview (`lib/tier-switch.ts`); consent and metering | A tier-above lookup that is not just price order; a creator-chosen preview of a locked post; a flow condition on a member's tier | The creator picks, per tier, one post and writes or approves a short excerpt shown in the email. The email links to the existing switch page. Nothing is unlocked by the email. |
| (b) First month off for free members, 7 days, creator cap | The welcome offer: first payment only, up to 168 hours, enforced at checkout | Built for free-product claimants and one product; no creator cap; no free member level | Extend the welcome offer rather than add a second discount path. The creator's cap is a maximum percent among `WELCOME_PERCENTS`. The 7 days are enforced on our side as today, and the checkout refuses after. Renewal price is said in the email. |
| (c) Up to 5 paid-content previews, one a day, to free joiners | "joined" trigger, `source: "free"`, step delays | A preview-content field; a list of up to 5 picked by the creator; an enforced one-a-day spacing | Five steps of one flow with 24-hour delays, each built from a preview the creator approved. Enforce at most one a day per person in the send path, not only by the step delay. Stop on unsubscribe, purchase or tier change, and never pick private content automatically. |
| (d) Annual offer with a creator discount | `lib/yearly-ask.ts`, `activeYearly`, the yearly switch | A creator-chosen discount on the yearly price; tiers cannot have yearly prices | A `once` coupon on the yearly switch's first charge, made by the same path as the save offer. Shown only when `activeYearly` exists. Never for a member already discounted (`yearlyChoice`). It extends `lib/yearly-ask.ts` rather than adding a second annual email. |
| (e) 24 hours before access ends | `endsAtOf`, `ends_after`, the per-membership sent marks of `lib/member-nudge.ts` and `lib/yearly-ask.ts`, the daily jobs | A scheduler keyed to an end date; one effective end that accounts for renewal, reversal and grace | A daily (or hourly) job reads members whose `endsAtOf` falls 24 to 48 hours ahead, re-reads the subscription just before sending, and sends only if the end still holds. One mark per membership and end date, so there is never a second one. It is kept apart from the existing service notices (dunning, card expiry). |

## Cost and margin (MR)

Every template sends email, so each send reserves from the store's email quota before it goes, and a template stops when the quota is used.
- (a), (c) and (e) read memberships or subscriptions from the creator's Stripe account. Those reads must be priced and capped like `lib/yearly-ask.ts`'s (per run, per store) and entered in `tests/plan-cost-registry.ts` before they run.
- (b) and (d) make coupons on the creator's account. Each coupon creation is a Stripe call, capped per send.
- None of it may be counted as free. No result from Patreon's figures is used to approve margin.

## Order of units, smallest risk first

1. **(e)**, the reminder before access ends: no discount, a clear benefit, and patterns that already exist (`member-nudge`, `yearly-ask`). Behind a creator switch, off by default.
2. **(d)**, the annual offer with a creator discount: extends `yearly-ask` and the yearly switch; money, so done at high effort.
3. **(b)**, free members' first month: extends the welcome offer; money.
4. **(a)**, the tier-above invite: needs the post preview field first.
5. **(c)**, the five previews: needs the same preview field and the one-a-day guard.

Every unit: RED test first, synthetic services only, AX274 for the studio switch and the emails (HTML and plain text), and nothing on by default. No change to prices, visible limits, commission, `PLANS_ON_SALE`, the tax gate, art. 9a or the commercial review.
