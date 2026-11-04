# Platform plan ownership and bounded recovery — CX-86 / CX-96

## Ownership proof

A Stripe customer may pay for several stores. Neither a shared customer nor a name released by one store proves that a subscription belongs to that store. New checkout sessions, their subscriptions and both restart creation paths carry the store's immutable `statsId` as `metadata[store_id]`. Captured store/customer identities are used throughout an observation; a conflicting explicit identity on overlapping responses makes that subscription unknown.

For a legacy subscription without `store_id`, recorded name ownership must contain its creation time: acquisition <= created < release, or an open interval after acquisition. `handleOwnership` records actual acquisitions and releases in epoch milliseconds. `created` is interpreted in Stripe's whole epoch seconds. Its complete second must fit inside the recorded interval; a second straddling acquisition or release remains unknown. Old records receive no inferred acquisition date; releasing an undated old alias records a null beginning. Reacquisition appends an interval, and changing back to an alias still owned does not invent an acquisition. `releasedHandles: string[]` continues to preserve historical sales lookup. The release-only timestamp summary cannot establish ownership.

Missing evidence stays unknown. Checkout returns `billing=unknown`, with no funding reservation or new checkout, when it cannot exclude a duplicate obligation. A cached active snapshot alone cannot claim `already`. Closing retains unknown coverage in the existing held-store path and aggregate owner report. No unknown legacy subscription is adopted, canceled or refunded. A removed store's existing closing marker now includes its immutable identity; an unbound legacy marker cannot authorize a money operation. Newly proved undo entries retain an internal proof version; older unproved entries wait for manual review rather than authorizing cancellation or refund from a queue pointer alone.

## Independent complete observations

Search queries only the current and previous names, at most the existing `MAX_ADDRESSES = 10`. The captured customer's List API supplies released names and excludes other stores of that customer. Both observations use pages of at most 100 rows, at most 10 pages each. Search sends the opaque `next_page` as the following request's `page`; List uses its last ID as `starting_after`. Repeated cursors, malformed own data, contradictions, a failed page or a final `has_more=true` refuse completeness. There is no eleventh request and no new customer allowance.

No adoption or absence proof is allowed until both observations are complete. Independently proved owned rows remain eligible for stopping a late charge when the other observation fails; incomplete coverage still prevents deletion. Ambiguous overlapping IDs are never stopped. The same validated List is reused by the closing guard; recovery does not add an unpriced duplicate List read.

## Registered cost ceiling

`lib/platform-plan-rules.ts` is the shared source for runtime pagination and the cost registry. Each GET uses the full `STRIPE_TIMEOUT_MS = 20,000`,2 GB and the highest published regional memory rate US$0.0183/GB-hour. Recovery costs at most 20 GETs, or800 GB-seconds: US$0.0040666667 per event. Closing additionally counts its existing subscription detail read:21 GETs,840 GB-seconds, US$0.00427. The plan row charges recovery only to the shared checkout/deletion essential-event allowance and closing to its scheduled events, never visits. Existing CPU/invocation/storage/other rows remain counted separately.

The held-store model uses the same21-read ceiling and preserves the existing50 company-wide daily attempts and one attempt/store/UTC day. The store's ownership history shares the already charged full `MAX_STORE_BYTES` record; it creates no new key or expiry. Closing marker identity and undo proof version remain within the existing records and are described in the data registry. Complete post-cancellation funding, actual region and endpoint tariff remain unknown where not reviewed. The Stripe endpoint fee stays null; no complete profit or funding approval is inferred from this memory calculation. The deliberate CX-67/CX-69 retention exception remains unchanged.

Official API sources read4 November2026: [Search subscriptions](https://docs.stripe.com/api/subscriptions/search), [List subscriptions](https://docs.stripe.com/api/subscriptions/list), [Vercel Functions usage and pricing](https://vercel.com/docs/functions/usage-and-pricing). [Stripe pricing](https://stripe.com/pricing) does not establish an endpoint-specific zero fee.

## Validation and review boundary

Permanent regressions cover shared-customer cross-store identities, unknown acquisition history, a subscription older than the store, reacquisition intervals, own-data/getter isolation, captured identities, removed-store markers, unproved undo queues, pagination/cursors/page ceiling, contradictory overlaps, and independently stopping an owned late plan on incomplete coverage. The foreign-owner test must fail if its final ownership filter is replaced with `terminalOwn || true`.

No real provider/account/payment action is used by these tests. Prices, visible limits, commissions, sales flags and gates are unchanged. Final approval requires independent Codex A3 and Revisor3 review of the exact head plus all nine required check aggregates.
