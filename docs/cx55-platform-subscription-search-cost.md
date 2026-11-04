# CX-55: platform subscription search cost diagnosis

Read on 2026-11-04. This is a stopped financial diagnosis, not an approved cost ceiling, a bill, a tax certification or permission to merge #1478. The functional preparation is 35d5a75ed7e9e193bd1f055a11700c150247fcd0. Main integrated for this diagnosis: 492c8d987d5a0347778172be2b19c077d0f270d9. The queue conflict kept both sides.

## Sources and remaining unknowns

- [Stripe pricing](https://stripe.com/pricing?locale=en-US) lists payment fees per successful transaction. [Billing pricing](https://stripe.com/billing/pricing) lists subscription features included with a charge based on Billing volume. Neither page explicitly guarantees an endpoint-specific zero tariff for GET /v1/subscriptions/search. Other Stripe products do list per-API-call fees. The endpoint tariff remains unconfirmed (`stripeGetFeeUsd: null`); it is not silently priced at zero.
- [Vercel function pricing](https://vercel.com/docs/functions/usage-and-pricing) lists IAD1 memory at $0.0106 per GB-hour, including time waiting on I/O. The existing repository model uses that rate and 2 GB. The same official table lists a maximum regional memory rate of $0.0183 per GB-hour. [Region configuration](https://vercel.com/docs/functions/configuring-functions/region) says IAD1 is the default and can be overridden in project settings; this repository does not pin a region. Deployment region remains unverified.
- Repository facts: MAX_STORE_BYTES = 1,000,000; handles contain at least three ASCII characters; STRIPE_TIMEOUT_MS = 20,000; ESSENTIAL_PER_DAY = 10; DAY_WINDOWS = 32. Billing and deletion share the same daily essential counter. Closing runs once daily in vercel.json.

No supplier rate, price, quota, gate or flag was changed. The numerical rate below is the existing IAD1 model assumption, not a verified global or deployment-specific maximum. The budget already fails at this rate; a higher regional rate worsens it.

## Conservative requested profile

Each serialized handle needs at least three characters and two JSON quotes. Ignoring commas, field names, uniqueness constraints and all other store bytes gives a safe, deliberately loose upper bound, not an attainable maximum:

```
n_upper = floor(1,000,000 / 5) = 200,000
GETs_per_event = ceil(n_upper / 10) = 20,000
memory_per_GET = 20 seconds * 2 GB * ($0.0106 / 3,600) = $0.000118
memory_per_event = 20,000 * memory_per_GET = $2.355556
shared_checkout_and_delete_events = 10 * 32 = 320
scheduled_closing_events = 32
added_window_profile = (320 + 32) * memory_per_event = $829.155556
added_annual_profile = 12 * added_window_profile = $9,949.866667
```

Only checkout, deletion and closing are represented by the new `platform-subscription-search` line; visits receive no new charge. Checkout/deletion are counted together, not 320 each. CPU, invocation fees and existing costs are not erased. Stripe endpoint fees remain unknown. Repeated unpaid closing windows and funded post-cancellation exposure are not certified by a one-window count.

This sums a separate timeout for every GET as CX-55 requested. It is a planning ceiling, not observed duration or a claim that all waits fit one function invocation. A deployment-wide execution limit may give a tighter hosting bound, while also preventing a large history from completing; no such tighter deployment constraint was verified here.

A concrete address-only serialization witness has 99,999 distinct valid base-36 released handles plus current `harbor`: 653,397 bytes, leaving room for other store fields under 1 MB. This measures the address portion, not a public-writer lifecycle or a complete bill. Even the smaller 100,000-handle profile costs $376.888889 for the shared essential events alone, without any closing event; the Pro monthly model remainder would already become $-2.930866. Thus the failure is not solely an artifact of the deliberately loose 200,000-handle bound. The per-GET timeout sum remains a planning ceiling, subject to the execution-limit caveat above.

## Existing model result

Values are dollars per payment, from tests/plan-cost-model.ts and the complete current registry. Annual rows cover twelve windows. `netOf` is the repository's existing compatibility cost-model calculation; these are not certified live TX results. Baseline cost includes perPaymentCost. Unknown tax, deployment region, Stripe tariff and fixed LLC costs remain unknown.

| Tier | Interval | Price | Existing netOf | Baseline cost | Added memory profile | Model remainder after addition |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| creator | month | 69.000000 | 59.980000 | 2.572146 | 829.155556 | -771.747702 |
| creator | year | 690.000000 | 605.510000 | 28.903650 | 9,949.866667 | -9,373.260316 |
| pro | month | 449.000000 | 393.790000 | 19.831977 | 829.155556 | -455.197533 |
| pro | year | 4,490.000000 | 3,943.740000 | 224.058241 | 9,949.866667 | -6,230.184908 |
| scale | month | 999.000000 | 876.960000 | 43.802571 | 829.155556 | 4.001874 |
| scale | year | 9,990.000000 | 8,775.380000 | 497.749351 | 9,949.866667 | -1,672.236017 |

Five rows become negative. The positive Scale monthly remainder is not a certified margin. The current MR and existing room are not relaxed.

## Reproduce

```
node scripts/diagnose_platform_subscription_search.mjs
node scripts/diagnose_platform_subscription_search.mjs --checks
```

The diagnostic script uses the repository's actual test aliases and model. The registry integrity tests pass 19/19. A separate exhaustive byte-floor test uses the real handle validator to reject every quoted JSON string smaller than five bytes; it passes. The unchanged plan-margin tests fail 13/39 after adding the profile; this is the expected stop signal, not a passing build. Runtime tests in contract-billing-metadata cover exact GET counts at 1/10/11/21/40 handles, complete-page refusal before activation and the absence of provider writes.

Decision required under CX-55: do not send this diagnosis as a green #1478 correction. Review a tighter enforceable cost/progress design or explicit financing; never hide the added work in visits, use an average history length, invent a zero supplier fee, cut a right, change a price or weaken MR.
