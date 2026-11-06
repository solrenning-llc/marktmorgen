# Store API i-m audit: evidence checkpoint

Frozen source: `5c07315505e1d53ee6401021601cd688fa98ecda`.
Specific evidence reservation receipt: channel `b045ba558bb56469b70a13c281d34f07d6d4f084`, blob `9ab556871dfb3d6434f995f33abd0a91adf9defa`.

Scope for this first runtime unit: only membership pause/resume acknowledgements. Eight synthetic scenarios: a healthy pause and resume, then HTTP 200 empty object, wrong subscription id and unchanged contradictory subscription for each operation. The real POST route, pause/resume helpers, rules and Stripe adapter are read directly from frozen Git blobs. Authentication, admission, member selection, email transport and cache clearing are explicit local boundaries. No production source is modified, and no real account or provider is operated. The runner compiles in memory, executes through stdin, blocks every unexpected fetch destination and has a 120-second/256-KiB child limit; each case has a 2,000-synthetic-call ceiling.

## Contract checked before runtime

Official public Stripe documentation read on November 6, 2026:

- https://docs.stripe.com/api/subscriptions/update — success returns the updated Subscription object; the example includes its subscription id, `object: "subscription"` and `pause_collection`. `error_if_incomplete` uses HTTP 402 when a required payment fails.
- https://docs.stripe.com/billing/subscriptions/pause-payment — collection pause uses behavior/resumes_at and collection resumes by clearing pause_collection. Subscription status can stay active.

The proof's local contract is inferred from those documented fields and repository rule 24: missing, wrong-object or contradictory update evidence cannot establish confirmed pause/resume. It does not require subscription status paused. The actual account's default API version was not inspected, and this unit does not propose changing a version or billing parameter.

## Observed result: unconfirmed subscription update is announced as success

Location: `lib/membership-pause.ts:59-78` and `:105-112`; the HTTP 200 response body from `onAccount` is discarded. The actual route maps the returned `ok` to `paused` or `resumed` at `app/api/store/manage/pause/route.ts:61-67`. `lib/stripe-account.ts:130-142` returns any JSON body from an HTTP-success response, without a Subscription-specific check.

One execution of the eight reserved cases produced **2 passing healthy controls and 6 expected adverse failures**. The same membership remains unchanged in the explicit local backend for each adverse response. Nevertheless, the real route announces success. A malformed/stale pause acknowledgement also reaches the actual confirmation-email call path, through the local email stand-in, and the cache-clear boundary.

| Action | HTTP 200 acknowledgement | Backend changed | Redirect status | Confirmation email calls | Synthetic provider calls | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Pause | Correct Subscription and requested state | Yes | paused | 1 | 2 | Healthy control passed |
| Pause | Empty object | No | paused | 1 | 2 | Expected adverse failure |
| Pause | Another Subscription id | No | paused | 1 | 2 | Expected adverse failure |
| Pause | Same id, original contradictory state | No | paused | 1 | 2 | Expected adverse failure |
| Resume | Correct Subscription and requested state | Yes | resumed | 0 | 1 | Healthy control passed |
| Resume | Empty object | No | resumed | 0 | 1 | Expected adverse failure |
| Resume | Another Subscription id | No | resumed | 0 | 1 | Expected adverse failure |
| Resume | Same id, original contradictory state | No | resumed | 0 | 1 | Expected adverse failure |

Every case made one synthetic Subscription POST. Total: eight POSTs, twelve local provider calls, zero Redis commands and zero external network requests. The test child reported 36.97 ms; the complete launcher call finished in approximately 0.54 seconds. No ninth case or broader runtime sweep was executed. The 120-second and 256-KiB limits were not approached. Assertions and expected results were not changed after execution.

Reproduce with Node/esbuild dependencies available:

```
Q_PAUSE_REPO=/path/to/read-only/repository \
Q_PAUSE_DEPENDENCIES=/path/to/node_modules \
node proofs/q/store-api-i-m-pause.mjs
```

The runner reads the fixed Git commit directly, so a working-tree checkout cannot silently change the tested source. It compiles the actual route/helper/adapter/rules and actual membership email words in memory. The proof replaces auth/member selection, request admission, date formatting, catalog title lookup, email transport and cache clearing at explicitly scoped import boundaries. It does not test those mechanisms. The stand-in updates its stored Subscription only for the healthy controls; malformed/stale replies leave it unchanged. This demonstrates the code's unsupported success decision under uncertain evidence; it is not a claim that real Stripe returned these bodies or that a real subscription was changed.

No production repair is included. **Severity remains unassigned pending independent Revisor 2 execution**, which is required before a financial implementation proceeds.

## Static audit ledger and deferred scope

The frozen main tree contains 35 routes under the i-m prefixes. Five occupied main routes were excluded from this independent candidate read: image, link-image, letters, mail and meta-ads. Thirty other route sources were read statically. The shared OPEN inventory at 21:34:14 UTC contained 217 PRs with matched metadata/file heads; it was reused rather than re-enumerated. Existing PRs also occupy several imported helpers, so those paths were coordination-only and no overlapping repair was started.

The `keys` route was classified from source as product license-key management, distinct from the API-key work in #2899. Its helper is occupied by #2868. Contact-import work in #2438 remains excluded. Potential letter-grant and partial leave-count behaviors are deferred static leads, not runtime findings or graded issues in this unit. No occupied page is changed or duplicated.

No native Redis, real Stripe account, payment, account setting, price, quota, gate, CI, browser journey, deployment or global TypeScript verification was performed. The successful esbuild compilation is not a TypeScript certification. The artifact branch contains evidence only.
