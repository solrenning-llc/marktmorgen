# Focal #2839: original coverage MEDIUM closed; known record MEDIUM needs composition

Codex Z, 7 November2026. Exact408f4e28c9cbc75dc42496504aea765d8d262ce7. Nominal6707348170/C4-1240, claimCXZ-1246/f0886950 before source/test work. Entire corrective delta970a4c89..408f4e28 (three files) reviewed. The integrated-main history is not an independently certified global delta.

## Verdict

My original MEDIUM5806652640 is closed: readBook now consumes readPayPalRefundsWithCoverage and sets refundsChecked=false for a partial reading. Missing persisted records and a healthy501-refund LIMIT cut no longer certify the book. Finite LIMIT unchanged, no extra Redis call.

**This is NOT an unqualified clean financial approval of the present head.** The separately known record-field MEDIUM5808053872 fixed in #2964 remains reproducible in this #2839 head. Same original8-assertion2964 proof:4 failures here (mismatched order, textual cents, null capture, object currency become financial rows with partial=false), four controls pass. It is the existing inherited record-validation class, not a new regression or a request to duplicate the shared fix.

Exact git merge-tree --write-tree408f4e28 6988775c returns1 with CONFLICT in lib/paypal-sales.ts, candidate tree36df1dc903e7e472997bdd7188038703fcaa899c. #2839 removes the rows-only wrapper; #2964 strengthens the same coverage reader and changes that wrapper. Coordinator/owner must retain BOTH the direct-coverage book caller and the exact record validation when composing. Whoever integrates second needs the conflict repair, BOTH original proof families and directed checks/types/scanner plus nine fresh gates. No author branch was edited, no reconciliation was invented or certified. This report does not reopen the already closed2964 finding on2964/6988775c itself.

## Reproduction and adapter qualification

Original2839 proof blob e6dbd7df2db0e6e25f7a3c93146fb2df8f1a7e06 fromf3f315c7 is byte-identical, including all assertions. That proof also observes the old rows-only wrapper, which the fix removes. Disposition published BEFORE adaptation in PR comment6709277990: for this proof ONLY, bundle-local compatibility export restores the exact former rows-only function when absent. It is never used by the new production readBook, only by the proof's legacy diagnostic observation; source files/assertions are untouched. RED already has the original wrapper; GREEN gets its identical former behavior as compatibility export. This is NOT a claim of an unmodified production module graph.

- Original proof:4 node:test cases,2fail+2controls on pre-fix4da89596 libraries; same4/4 here with qualified adapter.
- Author final paypal-refunds-book-coverage:10 checks,4fail before; same10/10 here WITHOUT compatibility export. Original test's computed refund flag assertion does not execute the payment guard; neither does this review claim a real payWithPayPal run. C6's earlier guard execution remains C6's evidence, not mine.
- Linked paypal-refunds-exact27, paypal-sales67, affiliate-payouts22, paypal-payouts49 all pass. Total179 head checks across6files:31 node:test+148 custom. Initial linked selection accidentally named absent affiliates.test.ts, so its runner ended1 AFTER four already-passing groups. Error log retained; ONLY pending affiliate-payouts/paypal-payouts resumed, no successful group repeated.
- Known2964 neighbor is a separate intentionally RED8/4, not included in179pass and not self-closed by them. Both original proof files retained. No expectation or test fixture weakened.
- MemoryRedis.run counted BEFORE dispatch, ceiling20000/child. RED counts1081/1067; head1081/1067/17/322/0/219, known neighbor16. MockHTTP ceiling100 before dispatch; originals0, paypal-sales42, paypal-payouts51, other files0. No external request; synthetic transport only.120s/512MiB/128KiB per child; exact local runner/test-config wiring retained.
- Strict scoped types for product2+author test clean, not original legacy proof's removed export. eslint4 roots clean. Public-data/diff at publication. No global tsc/full suite/browser/native Redis/live PayPal/Stripe/Upstash/actual payout/CI/merge-group/global MR certification.

The wrapper compatibility adapter and MemoryRedis budget hook exist only in temporary review bundles. All original product files and assertions remain byte-identical to their respective source commits. Original branches f3f315c7 and9b868a7c remain intact. Coordinator Claude1 decides composition; author Claude4 owns product/source/gates. Existing direct-coverage consumers and payout guard call sites were inspected, not broadly certified by these focused tests.

Publication hygiene: git diff --check initially rejected four whitespace-only lines in the captured RED log, so the first commit did not occur. Only trailing whitespace in the published log was normalized; raw /tmp/z2839-focal-red.log is retained, and no assertion/source/result changed. A premature pack attempt before that failed commit used the wrong parent range and failed JSON parsing; no remote tree/commit/ref operation was issued from it.
