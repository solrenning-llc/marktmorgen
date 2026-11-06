# D2 independent financial review: PR 2742

Exact product head: `1a1f7c171b8692cf06c9fc60eb56468caf9da146`.
Product tree: `5defc8208695a2e9d86ddd9b4c0e937073b2b40b`.
Author RED: `ccce1856aa04cdacbb063f574fb9ee2526f4852b`.
Reservation/claim channel commits: `85ad446f`, `be415c32`.
Verdict: **MEDIUM; not cleared**.

## Finding: incomplete object rows still authorize a refund

`lib/plan-refund.ts:109-112` rejects non-object rows but accepts any object.
The customers/search consumer at 229-231 silently skips a row without an
email; charges/search at 246-248 silently skips a row without a usable
created time. The own-charge history at 198-200 silently drops partial
charge evidence too.

The exact-envelope responses used by the proof have object search_result
(or list), has_more false, a bounded data array and, for searches,
next_page null. Replacing only the data row with {} or an object missing
one required identity/time field still returns a decided guarantee.
Calling the actual refundPlanPayment with the same ambiguous evidence
returns ok true and emits one successful stand-in refund for each of the
customer-search and card-search scenarios. Partial own-charge histories
instead become a decided none. Unknown history must remain unknown;
it does not certify that the same person/card never paid earlier.

This is a residual of the boundary hardened by this PR, reproduced on the
author RED too, not a claim of a newly introduced regression or a real
provider exploit.

Requested repair: validate each endpoint's required identity, relationship,
status/time fields before filtering/projecting financial evidence. An
incomplete or contradictory row must return unknown before authorizing
refundPlanPayment. Preserve valid empty lists, declined charges, trial
invoices with explicit charge:null, the existing policy and paid-read cap.
Promote regression cases and replay the immutable proof unchanged.

## Reproduction

```sh
node proofs/d2/run-2742-rows.mjs final d2-review-2742-rows.proof.ts
node proofs/d2/run-2742-rows.mjs red d2-review-2742-rows.proof.ts
node proofs/d2/run-2742-rows.mjs red plan-refund-read.test.ts
node proofs/d2/run-2742-rows.mjs final plan-refund-read.test.ts plan-refund-rules.test.ts plan-refund-flow.test.ts plan-refund-route.test.ts plan-refund-page.test.ts plan-refund-write.test.ts
node node_modules/typescript/bin/tsc --noEmit -p proofs/d2/tsconfig-2742-rows.json
```

- Final immutable proof: **15 checks, 10 causal failures, 5 controls pass** on
  both exact product and author RED. Two actual writer cases make a
  simulated refund where refusal/no refund is expected.
- Author 44-check reader: 3 causal failures on the author RED source,
  44/44 on final. The three original assertions are unchanged; search
  stand-in envelope corrections account for the reader test's other delta.
- Six final linked groups: 44+67+47+28+15+22 = **223/223**.
- Directed strict TypeScript follows imports from product/tests/proof:
  **0 diagnostics**; scoped ESLint **0**.
- Public data scanner with three staged proof artifacts: **3809 tracked,
  0 corrections**; staged diff check clean. The prose report was added
  afterwards and is scanned again before publication.
- The initial exploratory old-payment control used an unsorted shared
  invoice fixture as if sorted, producing two harness failures. Before
  freezing the proof, replaced that control scenario with one actual old
  payment and its correct outside_window outcome. All six financial row
  assertions were unchanged, and four actual writer assertions were added.
  The final 10 failures are causal; the initial control failures are not
  counted as product defects.

No author product, branch, PR head or CI edited. No native Redis, Stripe,
email provider, browser, client-bundle build, full global TSC, deployment,
real account, payment or external contact performed. All money writes
above are recorded only by the existing synthetic provider stand-in.
