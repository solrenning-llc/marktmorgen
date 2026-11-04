# Subscription Checkout billing mode — 4 November 2026

CX-47 fixes new memberships and finite installment subscriptions created by lib/store-checkout.ts. Their existing connected-account Checkout POST now sends subscription_data[billing_mode][type]=classic and Stripe-Version:2025-09-30.clover together. The version is pinned at that request boundary, including existing retries; the generic onAccount client's other requests keep their existing explicit/default versions. One-off payment creation is unchanged.

Classic matches the subscription-update semantics this integration already uses. The pin is a compatibility choice, not a claim that Clover is the newest version: it supports the existing Checkout branding field and the discount API already pinned in this repository. No existing flexible subscription is migrated, and this patch alone cannot correct an already-created flexible subscription. That remaining population needs separate read-only inspection and coordination before any migration decision.

Official Stripe sources read on 4 November 2026:

- [Clover change: flexible becomes the default](https://docs.stripe.com/changelog/clover/2025-09-30/billing-mode-default-flexible): the request-version default changes at2025-09-30.clover, including subscriptions made by Checkout; specifying classic preserves the older mode explicitly.
- [Billing modes](https://docs.stripe.com/billing/subscriptions/billing-mode): classic supports older integration behavior; existing flexible subscriptions cannot be migrated back to classic.
- [Checkout Session creation, pinned Clover reference](https://docs.stripe.com/api/checkout/sessions/create?api-version=2025-09-30.clover): request-level version example and Checkout parameters.
- [API versioning](https://docs.stripe.com/api/versioning): the Stripe-Version request header overrides the account default; webhook versions are configured separately.

The new regression reaches the real createCheckout → onAccount → mocked fetch boundary and captures both the HTTP header and form body. Monthly/yearly membership, finite installments and an existing tax-document retry fail before the fix; an ordinary one-off sale stays on its prior contract. Original price, currency, schedule, connected account and absence of destination/commission routing are asserted. No real provider, customer, account default or webhook was changed; no price, visible limit, commission, flag, gate or resource allowance changed. This patch adds no provider call, Redis command, persisted record or retry. Full supplier/lifetime costs and account-specific eligibility are not inferred from synthetic tests.

Merged Meta #2019's obsolete own reservation is removed here as requested by CX-42; other agents' reservation rows are preserved.
