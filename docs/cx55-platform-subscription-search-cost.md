# CX-61: two-read platform subscription recovery

Decision: CX-61, 2026-11-04, superseding the stopped CX-55 block-search diagnosis preserved below. Codex B2 resumed from remote 8b849340 (08:32:38 Fortaleza), with no later commit on that branch when checked. The functional correction and its cost are now prepared together for #1478; independent review and all nine required checks remain mandatory.

## Behavior and evidence

- Search asks only for the current and previous addresses, bounded by the existing MAX_ADDRESSES = 10. Released history never adds Search clauses or calls.
- A second GET lists status=all, limit=100 and expanded customers for the customerId captured before either read. No captured customer means no second call and no adoption by email under a released name. Other stores and add-ons paid by the same customer are outside this store's recovery.
- Every page needs explicit own has_more=false, at most 100 dense own rows and no contradictory cursor before any cash activation. Overlap is deduplicated; contradictory billing evidence refuses adoption. Harmless fractional tax fields do not become billing-identity conflicts. Unknown released-name evidence refuses recovery rather than silently becoming an empty history; a regression reproduces that distinction before the correction.
- The captured address/customer/email identity is also used by ownership and activation after both awaits. An identity acquired or changed during either request cannot broaden ownership.
- Independent late-plan cleanup in plan-closing still runs when Search refuses. Unknown Search or List coverage never advances final closing to removed. The independent customer fallback also refuses incomplete pages before it can activate a funded plan; its new regression failed before that correction. The three CX-53 regressions remain covered, including long released history and a canceled foreign DeletedCustomer with no owned customer.

[Stripe List subscriptions](https://docs.stripe.com/api/subscriptions/list), read 2026-11-04: customer filters by customer ID; status=all includes canceled subscriptions; limit is at most 100. This implementation deliberately refuses has_more rather than fetching a third page. It does not claim strongly consistent Stripe Search.

## Independent-review corrections

The Revisor 2's medium finding was reproduced with failing tests before these corrections:

- A valid canceled DeletedCustomer from a prior owner of a current/previous name, or a terminal row with no captured customer identity, is ignored rather than permanently blocking checkout. Its row is never adopted, the missing email never becomes ownership evidence, and unknown own funding still refuses. [Stripe customer deletion](https://docs.stripe.com/api/customers/delete), read 2026-11-04, states that deletion cancels subscriptions and prevents later customer operations.
- File retention may finish while a refund remains in the independent UNDO_KEY queue only after that queue entry was read and Stripe confirmed the plan stopped. The existing settlement call reports this observation in memory; no new provider/Redis operation, persisted field, supplier, quota, deadline or cost rate is added. A journey test proves the refund fails once, the store is erased and the independent worker refunds exactly once afterward.
- A missing queue acknowledgement previously let the helper report returned while the plan remained active. A new regression failed before correction; a returned result now requires a positive confirmed done timestamp.

Counterexamples remain explicit: returning can mean an unreadable queue or refused cancellation with an active subscription. Those states remain held. Unknown Search/List coverage (including has_more=true) also remains held as CX-61 expressly requires. No new day limit, forced removal or funded-exposure approval is invented. The generic indefinite-retention concern is still with Claude 1 for a decision consistent with these requirements; this source must not be merged while that review is unresolved. Unknown financed exposure remains unknown, never zero.

## Function-memory cost

[Vercel function pricing](https://vercel.com/docs/functions/usage-and-pricing), read 2026-11-04: memory is billed during I/O waits; its regional table's highest memory rate is $0.0183 per GB-hour. This row uses that rate instead of relying on an unverified IAD1 deployment. Existing CPU/invocation/other cost lines remain intact.

```
GETs per event <= 2
wait per GET = STRIPE_TIMEOUT_MS / 1000 = 20 seconds
modeled function memory = 2 GB
memory per event = 2 * 20 * 2 * 0.0183 / 3600
                 = $0.00040666666666666667
shared checkout/deletion events <= ESSENTIAL_PER_DAY * DAY_WINDOWS = 320
scheduled closing events <= DAY_WINDOWS = 32
added worst billing window = (320 + 32) * memory per event
                           = $0.14314666666666667
added annual payment profile = 12 * added worst billing window = $1.71776
```

The line is charged only to checkout, deletion and scheduled closing, never to visits. Checkout/deletion share their existing essential counter. The 2 GB profile is the repository's existing function-memory model, not verification of the live deployment configuration. Post-cancellation exposure across later unpaid windows still needs its own funded review.

[Stripe pricing](https://stripe.com/pricing), read 2026-11-04, does not establish an endpoint-specific zero tariff. stripeGetFeeUsd remains null. The memory ceiling is a priced component, never a declaration that the unknown endpoint fee or company-wide costs are zero, or that real profitability is certified.

## Validation and generated analysis

The exact runtime now passes 44 billing metadata tests, including two-read counts at 1/10/11/21/40/1000 released names, ten current names, captured ownership, cross-store isolation, incomplete own pages, overlap, funding acknowledgement and fractional tax fields. Three new CX-61 cases failed against the block-search source before the runtime fix; the overlap fractional-field regression also failed before its correction. store-closing-fair passes 103 checks, plan-closing 88, closing-plan-guard 52 and closing-plan-routes 15. plan-margin passes all 39 tests with the existing MR and cost room; the complete cost registry passes 23 and this row's own tests pass 2. These synthetic model checks do not certify live taxes, missing reviews, fixed LLC costs or commercial opening.

The new cost exposed a historical optimization oracle discrepancy: it used rounded printed shares and omitted the solver's five-cent reserve while claiming to enumerate the same problem. A new regression failed before correction. The oracle now enumerates the same raw shares, linear budgets and objective as the solver, with printed-rights validation retained afterward. All seven optimization tests and eight margin-alignment tests pass. Generated financial documents and the current model rows in value-presentation are refreshed without changing any published price, allowance, commission, flag or protection. Historical assumptions remain explicitly historical.

Reproduce with the repository runner for the named tests and:

```
node scripts/diagnose_platform_subscription_search.mjs
node scripts/diagnose_platform_subscription_search.mjs --checks
```

The diagnostic runner's netOf output is a compatibility-model remainder, not the owner's LC profit calculation or a supplier bill. No real Stripe request, account operation or payment is part of validation. No new UI steps or decisions (0 to 0); no human accessibility test or certification claimed.

---

## Preserved CX-55 diagnosis (superseded by CX-61)

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


## CX-67 implementation and review boundary

Closing now reuses one captured subscription observation: Search and the
customer List are each fetched once; the independent positive customer fallback
and final customer-plan guard consume that same evidence, not a third List.
The held-store reconfirmation, company retention exposure and aggregate monthly
report are documented in `docs/funded-exposure-review.md` under CX-67. The real
policy, full supplier/tax cost and reviewed global case ceiling stay null.
The two-read memory component is unchanged in checkout/deletion/closing; extra
held retries and full retained stores belong to company exposure separately.
