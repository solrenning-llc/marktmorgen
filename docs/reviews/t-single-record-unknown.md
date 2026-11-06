# Unknown singular records become known absence

Evidence only, November 6, 2026. Codex T, assigned lib/*-store.ts rule30 lane. Reservation c819049c96ee7d87f036e4a49478531ceae675e6 preceded proof code. Frozen main 88471da71958bf17c71715964578bd5d471b6e9a. Exactly three new proof/report/runner files; no product source, global alias, reservation or foreign ref changes.

Run `node proofs/t/single-record-unknown.mjs [source-checkout]`. Intentionally failing opt-in evidence, not a product PR.

## Reproduction

Actual claimHandle, ensureStatsId, ensureStoreId and synthetic subscription writer create a fictional store. Actual createRequest/createAgreement writers, validators, fingerprints and data-room admission save one record of each family. Actual readRequest/readAgreement and requestOf/agreementOf consume them. Actual buyer page functions for /pay/[request] and /sign/[agreement] run with the existing synthetic Next request-context fixture and an explicit notFound sentinel; storage and buyer limiter remain real MemoryRedis implementations. No provider, checkout creation, payment, email, signature or real account operation is executed.

Only the targeted single GET reply changes after its actual MemoryRedis execution. Each case verifies one intercepted read and byte-identical stored record before/after; observer inspection is outside application IO/cost. Healthy buyer functions render through React server rendering and show the saved work/agreement body. This is not Next HTTP, browser hydration, native Redis or a real buyer journey.

## Result: 28 tests, 20 causal failures, eight passing controls

| Boundary | Inputs | Observed result |
| --- | --- | --- |
| readRequest (payment-request-store.ts:170–179), readAgreement (agreement-store.ts:199–208) | Missing envelope, false slot, malformed JSON | null returned despite the saved record |
| requestOf/agreementOf store-scoped wrappers | Same three inputs | Same false known absence |
| Four direct/scoped cases across both families | Extra outer slot | Healthy record accepted despite invalid envelope, not absence |
| Actual buyer functions | Missing envelope or malformed JSON, each family | Calls notFound while the saved record remains intact |

Sixteen observations establish false absence (including four actual buyer-function cases). Four establish extra-envelope acceptance only. Observations overlap; not 20 different lost records.

Eight controls: per family, healthy writer/direct+scoped readers/buyer rendering; confirmed null remains null/notFound; foreign-store and invalid identity remain refused; thrown transport already propagates. No bypass of store ownership, charge state, signature or an admission gate is demonstrated.

**Proposed LOW for availability/truthfulness**, final classification by coordinator/reproducer. Private pages already have noindex/nofollow; no SEO deindexing or public discovery impact is asserted. No monetary loss, unauthorized charge, signature, deletion, privacy leak, irreversible loss or whole-product certification. A stricter reader must preserve confirmed absence and remain distinct from the existing index/list APIs.

Existing payment-request-read-proof/agreement-read-proof test list/index/MGET readers, not these singular GET APIs. Directed static callers also include changeRequest/changeAgreement and signing/notification helpers; those mutation effects were NOT tested and have no severity assigned here. app/api audit belongs Codex C2; no duplicate route audit or source correction.

## Validation

Linked canonical suites: payment-requests64 + agreements59 + payment-request-reply59 + agreement-reply3 = **185 PASS**. Strict scoped TypeScript proof root and actual imports: zero diagnostics; ESLint two code paths and runner syntax: zero; diff clean. Public-data scanner: 4104 tracked files, zero corrections.

The first linked run completed payment-requests64, then esbuild could not write the next bundle because tmpfs was full. This was infrastructure, not a product failure. Removed only the agent's reproducible old t-2823-union-71511 archive; reran the three not-yet-executed suites, all passed. No assertions, timeouts or source changed. Durable #2823 evidence/source and every other agent's work remain untouched.

No new production IO/key/service/registry row/price/limit/commission/flag/gate. Unknown real infrastructure cost remains unknown. No full build, browser, native Redis, provider, real account/payment or global accessibility certification.
