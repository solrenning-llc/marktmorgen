# Independent financial review: PR #2965

Reviewed exact head `8e6c4c2a79b84fd2bdc75e93b97f292e92b84f7c`, tree `4f41aa1b28fc68f2b110935974710f88e4e154e8`, on 2026-11-07. Requested second review: C6's 12:27 channel message. Claim `6709900807` preceded source/diff/tests; channel receipt `b9b873478ba4fa391bc37944c118dc0ce6e29aed` followed one rejected 409 and a fresh full UTF-8 read. C6's independent review `6698106395` is retained.

## Verdict

No blocking finding demonstrated in the six-file delta. The count must be an exact one-reply array containing a safe non-negative integer. Unknown evidence refuses currency changes and tax activation before either setting writer. Other exceptions keep the existing 500 path; healthy running-series controls remain 409. The two changed studio messages accurately describe these refusals and retain their existing alerts. This is an independent second financial review of this delta, subject to the exact-head checks and coordinator's merge-queue rules; it is not a live payment, full margin, tax-compliance or accessibility certification.

Read all six changed files, both complete routes and components, `redis-reply.ts`, `redis.ts`, `store-request.ts`, relevant `setTax`/`setCurrency`, test wiring and all runningSeries/seriesOpenKey references. The existing Stripe null-currency sibling is already handled by #2993 and is not reattributed here. No author source/ref/test, pricing, limit, flag, account, CI or queue mutation.

## Reproduction and results

The review copy is a native `git archive` of the exact head. Its independently initialized index's `git write-tree` equals the target tree above, before adding the review artifacts. This avoids a mixed historical module graph. Dependency symlink is local tooling only; no external provider is contacted.

- Frozen original test `95180a58b71887a0a5e1716a48a1aaf344b9b474`, recovered byte-for-byte from original RED `f84d7c33c7d683052cb068fc76c6ae68696e2be4`: **29 checks / 25 failures** with the three old backend modules and two old component reads, then **29/29** on the final graph. Its only later permanent-test change is the synthetic Stripe account identifier (`8a1c5c91315f8124a18e573f74ec102249c45106`); assertions are unchanged. The old graph's successful currency write then encounters Next's `after` outside-request harness restriction; the RED still directly observes mutated state, and that stderr is preserved. No live Next request is claimed.
- Current permanent: **29/29**, 157 MemoryRedis dispatches. Linked currency route **16/16**, 144 dispatches; currency FAQ **16/16**, zero dispatches.
- Independent qualified boundary proof: **69/69**, 386 dispatches and 68 fully synthetic HTTP responses. Fifteen malformed reply vectors cover both routes, typed unknown and unchanged currency/tax/IDs/invoices, including sparse/inherited/getter/Proxy envelopes. Four safe-integer controls retain exact values, two ordinary-error controls stay 500, two healthy series controls stay 409. Getter/Proxy reflection effects remain zero after Promise delivery.
- Thus **130 current checks** (29+16+16+69), plus the separate overlapping frozen original 29. Do not add the overlapping 29 as new coverage.
- Real repository ES2017/strict/bundler TypeScript configuration, seven initial roots/imports: exit 0; separately added qualified proof root/imports: exit 0. Lint six author paths plus original proof/runner: exit 0; qualified proof lint: exit 0. Official scanner: **4,255 tracked files, zero findings**. Own added artifacts checked separately. Six-file source `git diff --check`: exit 0.

### Preserved failed diagnostic

Original independent proof `2d13c75d8bd0679faa198979ef3bd35ab7308df5` remains unchanged: **69 checks / 4 failures**. Its Proxy `get` trap threw on the `then` lookup made by JavaScript Promise assimilation, before the async Redis result reached `runningSeries`. Both routes returned 500 and all settings stayed unchanged; this did not establish a product failure. Disposition `6709974629` was posted before creating a separately named derivative.

Qualified proof `cf12320f0267bd639f945e0d31ed80c575d46aa0` changes only that Proxy handler: `then` returns undefined; any other get still increments the effect counter, and descriptor traps still throw. All 69 assertions are unchanged. It passes with no validator reflection effects. This is an explicit harness correction, not a repaired product or a silently greened original. Two earlier esbuild setup failures (invalid relative aliases, then missing node_modules lookup for /tmp originals) occurred before tests; the final runner supplies a scoped resolver and nodePaths without changing tests or deadlines.

## Launcher

Copy the review runner and proofs onto exact head before running. The evidence branch also retains exact-head source. Recover the original artifacts:

```sh
git show f84d7c33c7d683052cb068fc76c6ae68696e2be4:tests/series-count-unknown.test.ts > /tmp/p2965-original.test.ts
git show f84d7c33c7d683052cb068fc76c6ae68696e2be4:lib/call-series-open.ts > /tmp/p2965-old-call-series-open.ts
git show f84d7c33c7d683052cb068fc76c6ae68696e2be4:app/api/store/tax/route.ts > /tmp/p2965-old-tax-route.ts
git show f84d7c33c7d683052cb068fc76c6ae68696e2be4:app/api/store/currency/route.ts > /tmp/p2965-old-currency-route.ts
git show f84d7c33c7d683052cb068fc76c6ae68696e2be4:components/tax-editor.tsx > /tmp/p2965-old-tax-editor.tsx
git show f84d7c33c7d683052cb068fc76c6ae68696e2be4:components/payments-panel.tsx > /tmp/p2965-old-payments-panel.tsx
P2965_ORIGINAL=1 P2965_OLD=1 node proofs/p-2965-run.mjs series-count-unknown.test.ts
P2965_ORIGINAL=1 node proofs/p-2965-run.mjs series-count-unknown.test.ts
node proofs/p-2965-run.mjs series-count-unknown.test.ts call-series-currency-route.test.ts currency-faq.test.ts
node proofs/p-2965-run.mjs p-2965-series-boundaries.proof.ts
node proofs/p-2965-run.mjs p-2965-series-boundaries-qualified.proof.ts
```

The failing original probe and RED are expected to exit 1. The runner enforces 20,000 MemoryRedis.run dispatches per child **before** executing each command, including nested dispatches, 120 seconds, 512 MiB and 256 KiB output. Children run serially. The extra proof's synthetic fetch handler caps mock responses at 100 before dispatch; all its responses are local mocks. No real Redis/Lua, Stripe, mail, account, payment, browser/AT, global MR or full CI execution. Root setup/dependency archive work is not billed provider IO. Complete final stdout/stderr and check logs are retained in `p-2965-series-count-output.txt`; obsolete setup errors are described above rather than presented as product REDs.


## Final coordination correction — 13:41 Fortaleza

Final timeline reconciliation after formal P review 5813699380 revealed C4's clean review **6709896330**, posted shortly before claim 6709900807 but absent from P's initial timeline snapshot. C6+C4 already provide the two financial opinions. P's review is **redundant additional evidence**, not the missing second review, and requires no further review or waiting. The initial claim/full channel check was made; a fresh timeline recheck before verdict was missed. The evidence, results and preserved failed diagnostic remain valid within their stated limits. No product/ref/CI/queue action was taken. The report above records the historical rationale and is superseded only on review-count/necessity by this append. The coordinator is notified; no tests are replayed for this metadata correction.
