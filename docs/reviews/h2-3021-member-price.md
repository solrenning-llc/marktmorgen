# H2 second independent financial review — #3021

Product: `b6055d9861d7dd1926ce1a35cc333e85d3eda23b`.
Unit-1 base/dependency: `9bddeaf88053d5fa3f598d16deb779287dc8be74`, #2999,
still OPEN when checked. Requested by C4-20261107-0226-TODOS-1; announced
before source in channel commit `da590b1838e4d457cf983038642f9add18533de7`
and PR claim 6702906267. First reviewer rv31/6697979216 is credited.

## Verdict

No new HIGH/MEDIUM product or financial finding demonstrated in this diff.
This is the requested second financial review, not a duplicate general review.
**Current head is not ready for the merge queue:** the existing CodeQL HIGH
at the test helper and the failed product aggregate still require author
action; the stacked #2999 dependency is also unmerged. No approval here
dismisses an alert or substitutes for the required final checks.

The author should correct the test helper, preserve all assertions, and
request the focal return on the new candidate. Final composition/retarget,
applicable reviews and nine final checks belong to that exact candidate.
C4-0226 prohibits direct merges; enqueue only after C4 announces FILA LIGADA.

## Read and exercised

Read all seven changed paths, including all seven language dictionaries and
the generated inventory delta. Also read the unit-1 member proof and claim,
checkout guards/discount selection, sale/fair-price arithmetic, buyer-read
admission and registry entry, active plans/bumps, bundle picking, the product
page's existing dynamic inputs, and the PayPal boundary.

- The page was already dynamic: its headers/country and A/B-cookie inputs
  existed in the base. The new member proof is not wrapped in a shared cache.
  This is source verification, not a live cache/CDN experiment.
- The page gates the proof by actual eligibility; plans, active bumps and
  pick-your-own bundles are behaviorally excluded with active fixture controls.
- For all 18 member percentages in three sale/fair-price contexts, actual
  BuyBox markup and actual createCheckout payload select the same best
  percentage. The independent cent oracle uses integer cents and subtraction
  of the rounded discount. This verifies the request prepared for Stripe,
  not a live Stripe invoice or tax/fee computation. An additional 2,701-cent
  product at 50% exercises the half-cent boundary: the button shows 1,350
  cents and the checkout retains basis2,701/coupon50.
- The proved email is absent from markup and fixed in the member checkout
  payload. Unknown membership, canceled membership and forged claim controls
  do not grant a member price.
- Anonymous and missing-billing-window cases perform zero provider calls.
  The existing admission precedes learner/Stripe reads; its six public units
  are registered, and the implementation caps address variants at two calls.
  No private account price, monthly margin or live funding coverage is certified.
- The hidden member field is checked again by memberClaim before checkout;
  gift/group/preorder/bump/plan refusals precede their productive operations.
  PayPal's exclusion is explicit in the rendered note.

## Reproducible validation

Official aliases/environment are used. Product modules are loaded from the
exact immutable SHA above; the evidence branch stores the same product blobs.
Stripe is a strict synthetic fetch responder, Redis is actual MemoryRedis,
and no external fetch is delegated. Admission/Store/checkout/SSR use their
real reachable implementation with the repository's existing test aliases.
The paid-period fixture is synthetic, not a live funded contract. These runs
do not certify positive production contract admission or all monthly costs.

| Entry | Result | Pipeline commands | Synthetic HTTP |
| --- | --- | ---: | ---: |
| Author sz4-u2-product-page | 58/58 | 81 | 0 |
| Author member-price | 76/76 | 306 | 28 |
| H2 independent render/proof/checkout matrix, including rounding edge | 182/182 | 357 | 132 |
| Linked digital-consent | 93/93 | 193 | 21 |
| Linked product-structured-data | 2 node:test cases passed | 0 | 0 |

That is 409 custom checks plus two node:test cases in the qualifying runs,
with 937 pipeline commands and 181 mock HTTP calls across those processes.
Counters measure dispatched synthetic pipeline commands, not native Redis
internal commandstats. Each process enforced 20,000 commands/200 mock HTTP;
proof assertions are capped at 1,000. Linux command:

```sh
timeout 120s node --max-old-space-size=512 proofs/h2/3021-member-price-run.mjs
```

The launcher also accepts each table entry's filename. The unchanged author
construction test was compiled against the pre-feature base: build failed
because member-price.tsx and buyer-words/member-price.ts were absent. This is
construction RED, not 58 runtime failures or an exploit. No product finding
is inferred from that build failure.

The initial independent runtime run passed 180 checks but its fixture used
readListing where createCheckout expects Product. Directed TypeScript found
TS2345. The fixture was strengthened to readProduct (no cast, no weakened or
removed assertion), then the same 180 assertions passed with 323 commands.
Two half-cent-boundary assertions were subsequently added; the final 182
passed. Neither preliminary fixture run is included in the qualifying table.

Final strict diagnostics: seven TS/TSX roots, 1,205 actual imported sources,
zero root diagnostics; not global tsc/build. ESLint eight author/evidence
code paths is clean with max-warnings 0; the changed fixture was checked again.
Official public-data scanner: 4,141 tracked files including the three new
evidence paths, zero corrections. Native diff-check is clean.
No browser, native Redis, real provider, buyer data or financial total used.

## Existing CI distinction, checked 2026-11-07 05:55Z

Raw check-runs on exact b6055d98 show:

- All checks (codeql), job 128221269181: success.
- Separate CodeQL security check 128217823082: failure, one HIGH new alert.
- Existing annotation 4498803783 / alert145 is at
  tests/sz4-u2-product-page.test.ts:45, the local text-only HTML-stripping helper.
  It is not an export or served product sanitizer. H2 did not dismiss it or
  claim that the green aggregate overrules this failed security check.
- All checks (product-checks), job128221388183: failure; cause not diagnosed
  or rerun by H2. The other eight aggregators were successful in that snapshot.

Author product, tests, branch refs and CI remain unchanged by this review.
