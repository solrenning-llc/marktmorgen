# D2 focal return — PR #2692

Exact corrected head:45aa165c1738683c3b578b9e4df9f2b63f49a229. **D2's duplicate-refund MEDIUM is CLOSED BY UNCHANGED PROOF; the PR is NOT cleared overall.**

The complete delta from5caa7807 is only lib/plan-refund-flow.ts and its permanent test. partsOutcome retains a cross-page refund-ID set, requires each observed refund to belong to the queried charge, and returns unknown before contradictory evidence can settle the plan.

Immutable proof2ff8feda8e2b32d03d52e00708dcb88431c8312a, tests/d2-review-2692-evidence.test.ts, remains byte-for-byte blobce1670bf4d5fa0bc241c4cd917761afc7701809a. It now passes9/9 on45aa. In the real daily job, one partial refund stays active with its note preserved when the same ID is replayed on two charge pages; the distinct-refund control still settles correctly. No provider is contacted.

The author's permanent regression is byte-identical between RED5a6888896779a35cf4bb509b5e16e1b4f79aaa37 and corrected45aa: blob4afb0f8e1d0c9fb27d3e8135d66f8d95fb76c74f. Only lib/plan-refund-flow.ts differs between these two source trees. Reproduced the exact RED library against the unchanged tests: author90checks/3causal failures and independent9/3. Corrected author90/90 and independent9/9.

Focal linked read41 + write22 + rules67 + route28 + page15 pass, for272/272 counted checks including the author's90 and the independent9. Strict scoped TypeScript with actual transitive imports, focused ESLint, staged scanner3801/0 and diff checks pass. The initial review's allowance suites and actual268/268 client bundles are historical evidence; they were not re-certified as a global or outage-rendering check in this focal return. No native Redis, Stripe, browser, global TypeScript or deployment claim.

**Other findings remain open.** R2's allowanceUsed whole-page-error MEDIUM affects the four studio consumers; neither this delta nor the successful-fixture tests repair/clear it. The author has requested nominal permission/owner delivery for an unavailable/retry UI, preserving paid admission. R2's additional charge-validation compatibility question is also outside this proof's clearance; this return does not verify the pinned Stripe schema or waive that question.

H2 had claimed the second full financial review before G's later channel announcement; C2 and D2 informed both. Coordination must preserve one second-review controller, not add a third mandatory review. Two explicit financial clearances, all finding dispositions and nine exact-head successful workflows remain necessary before normal expected-head incorporation. No author branch/product/CI was changed.
