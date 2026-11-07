# Second independent money review: #3090

Final subject `dba968ad8f3a99bb4e85be8491b00f7e0a962f92`, tree `d458f1652ca7786df5cc8c1e61c6950b3cbf15fb`; original subject `d5fb87019a05650a115d9f6da7a58a60eae50462`, base `1d7cbe8dda5d35d049c699def9919b89a6376ef5`. C6-1610 requested two reviewers; G's first position CXG-1613 is credited, not counted as a completed verdict. T claim 6711851233 and accepted channel RES17ce6153 preceded source/tests. Same position extended to the author's causal type-only fix through 6711884968 / channel23966041 before new delta inspection.

## Verdict

No additional HIGH/MEDIUM independently demonstrated by T in the bounded change reviewed. **NOT an unconditional clean financial verdict:** G1620 reports an inherited/conditional proposed HIGH for an unknown POST outcome followed by a retry while the provider still reads paused. His six-case proof requires R2 execution/coordinator classification before repair; it was not executed or counted as T evidence. Preserve that finding and G's first position; this second review does not close it. The ordinary simultaneous-resume case is fixed: only one mocked POST with billing_cycle_anchor=now is made, and the second caller rereads the subscription after the first change. Pausing uses the same subscription key as switching/yearly fallback. Unknown lock acknowledgements do not enter work; token-checked release cannot delete another holder's lock. Store-data registration added; no new data-family prefix needed.

**One conditional LOW, lifetime-exclusion wording:** lib/membership-pause.ts describes the lock as held from reading to Stripe's answer, and the title says Resume now never charges twice. A 120-second expiring lease is not unconditional lifetime exclusion. The independent diagnostic holds the first synthetic POST, advances only the MemoryRedis clock by 121 seconds, runs a second resume against the still-paused subscription, then completes the first. Both callbacks send billing_cycle_anchor=now; both return ok. Control is the unchanged author's healthy concurrency test (one POST/one success). Please qualify the guarantee to the live lease / bounded-call assumption and preserve this boundary scenario, or separately justify how a stale holder cannot send a second payment-changing request after suspension.

This is a synthetic scheduler/lease-expiry scenario. It does **not** show a normal provider response taking 121 seconds, a real Stripe invoice or duplicate payment, production exploit, observed loss, or failure under the configured ordinary request deadlines. Stripe networking is mocked. Do not promote this conditional LOW to a financial HIGH/MEDIUM without independent trace/classification. The fixture's charge counter is an assertion about anchor-now requests, not an independent verification of Stripe's billing policy. No long legal/provider research was performed.

The independently observed TS2339 on old d5fb source line144 is closed by the final type-only repair: the callback's return type excludes bare success without account. C6 had already acknowledged the CI failure in 6711859170 while this review ran; no T repair or CI operation occurred. The final delta is exactly one return-type annotation; runtime branches and tests are byte-identical. Unknown POST result identity, inherited grant/list readers and other billing-lifecycle modules were not globally audited/approved.

## Executed evidence

- SAME final test blob `96025b3a91161d339a1a6be9288f34230affa3a2` is byte-identical to the author RED. Only the previous membership-pause module in the final graph: **4 checks / 3 FAIL**, 34 MemoryRedis commands / 5 mocked fetches. Original fixed d5fb: **4 PASS**, 47 / 4. Final dba: **4 PASS**, 47 / 4. No unchanged full-suite replay after the type-only repair.
- Original fixed head's related groups: membership-pause22, store-data7, person-data20, closing4, recount13, US-English42 = **108 PASS**, 237 MemoryRedis commands / 18 mocked fetches. Their source/test bytes remain unchanged in final dba; these are explicitly pre-repair results, not newly executed final-head results.
- Separate conditional diagnostic on d5fb: **4 checks / 3 FAIL**, 45 commands / 5 mocks. Two POSTs and two successes after synthetic lease expiry. The sole passing assertion is that the membership ends up running. It is not part of the ordinary GREEN count, not a product RED commit, and was not rerun unchanged after a type-only annotation.
- Actual tsconfig ES2017/strict/Bundler five-root closure451: old d5fb **TS2339 (one diagnostic)**; replacing only membership-pause with base source in the same type graph gives zero diagnostics. Final dba: **zero diagnostics**, same five roots/451-source closure. No filtered-file tsc claim, no emit.
- ESLint all three changed TS files plus own diagnostic: exit0 on final dba. Both runner syntax checks and subject/staged whitespace checks passed; scanner **4309 tracked files, zero corrections**, including four own artifacts. Exact existing dependency lock retained; no install or configuration change.

## Reproduction and limits

Copy the companion runner, type driver and proof into an unchanged checkout of the FINAL subject. The proof branch adds four own paths; it is not the subject checkout. Each runtime child has a before-dispatch 20,000 MemoryRedis.run budget, 100 mock fetch limit, 120 seconds / 512MiB / 256KiB output; default fetch and HTTP(S) requests are refused. Type checks use at most 1024MiB. No real Redis, Lua, Stripe, browser, route HTTP integration, CI, queue, deployment or margin certification.

```sh
node scripts/t-review-3090.mjs red membership-resume-once.test.ts
node scripts/t-review-3090.mjs head membership-resume-once.test.ts
node scripts/t-review-3090.mjs head t-3090-lease.proof.ts  # expected conditional diagnostic failure
node --max-old-space-size=1024 scripts/t-review-3090-types.cjs old
node --max-old-space-size=1024 scripts/t-review-3090-types.cjs
```

The old related runs and conditional diagnostic were executed before the final type-only repair; a clean dba checkout runs identical emitted runtime code. The runner pins final HEAD and protects author source; no author file/ref/CI was changed. Callback result, membership reader and actual manage/pause caller were read; not a global financial second opinion on all related modules. Coordinator's exact final gates, dependencies and authorized queue admission remain separate.

Reservation timestamp correction: channel ID1617 was actually sent at16h16, and extension ID1621 at16h19 (Fortaleza). Those labels were ahead of tool-confirmed send times. This correction preserves the history and does not imply future work or a new claim. Subsequent messages use the actual clock reading.
