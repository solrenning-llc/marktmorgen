# Nominal focal #2924: exact receipts fixed; pending transport remains conditional

Codex Z, 7 November 2026. Exact author head `206cb747189987197b5a02a6f870381f2b517abf`, requested in comment6712181651. Previous focal5813793608 and evidencee73da231 remain preserved. Claim6712768821 preceded corrective source/diff; channel RES CXZ-1747 atf1d0e2b2 preceded new proof code/execution. This is a return to the original review, not another global financial opinion.

## Verdict

The previously demonstrated, immediately applied-write and empty-receipt cases are corrected. The SAME frozen three-case proof changes from 1PASS/2FAIL before to 3PASS now. The author's SAME ten-case test (blob198101d2, identical in RED4cc53de91 and fix206cb747) changes from 1PASS/9FAIL to 10PASS. Exact [1,1] is required; a known cleanup count refuses the add; an unknown cleanup receipt throws. Existing lines are preserved in the covered cases.

**Overall conditional: one proposed MEDIUM in the remaining in-flight write case, lib/ad-spend.ts:128-145 and158-163.** The cleanup is not a fence against an original request that has not yet completed. The real transport in lib/redis.ts uses a client timeout/AbortSignal; source inspection establishes no server-side cancellation acknowledgment or ordering/fencing contract. The proof models an unresolved transport completion explicitly. It does not establish that this ordering occurs on Upstash, or that a real expense has been duplicated.

1. The first HSET/EXPIRE is pending, and the client receives an error. The adapter records the pending commands without executing them yet.
2. The real MemoryRedis HDEL runs on the empty hash and returns0. Current code returns `{ok:false,reason:"unavailable"}`. The route turns this into503/unavailable; the editor source's fallback says “That did not save. Try again.” HTTP/editor were inspected, not executed by this new proof.
3. A healthy retry records1200 cents under a new id. Then the pending first HSET/EXPIRE is allowed to finish. Real addSpend plus MemoryRedis leave [1200,1200], although there was one expense.

The SAME additional four-case proof gives head2PASS/2FAIL, before3PASS/1FAIL: the duplicate already existed in the old module, while the corrective HDEL0 newly presents it as a known not-saved refusal. The healthy control and failure-before-dispatch control pass on both. Two failed assertions are one conditional class, not two incidents. This is not the already-covered immediate applied-write/lost-receipt injection, a random-id collision, or a real network experiment. No production source was changed.

Revisor2/C1: reproduce this exact proof and classify/dispose the remaining transport-ordering assumption before unconditional clearance. A server-side operation identity/fence or reconciliation protocol would need its own reviewed implementation. This reviewer does not implement an author fix or claim that another bare read/delete closes an unresolved write.

## Verification and boundaries

- Frozen original write proof: 3/2FAIL before ->3PASS head, byte-identical6f2626ab9f175762355d8809cd726002b5b279fa. MemoryRedis.run23->22, zero HTTP.
- Author10:9FAIL before ->10PASS head, identical198101d2c910c0cad16e83966163203a82fea851. run95->141, zero HTTP.
- New deferred proof4, blob1bb11504a5198b0a07f0217084f0cb52265f6051:1FAIL before ->2FAIL head, run29->32, zero HTTP. Source/assertions unchanged between before and head.
- Linked head: meta-lines-exact23, meta-spend-review9, meta-ads145, numbers-ask12, daily-cashflow36, campaign-results32, prior separate derived6 all pass. With original3+author10: **276 ordinary passing checks across9 files**. Do not add the new4 or frozen6 to that number.
- Frozen original partial-spend6 remains5PASS/1FAIL because its pure daily adapter expects a return where the strict reader throws; this was disclosed before the older separate derived proof (comment6710084539). Original blob0e8630924edc21f537e193747920d1b3767ba21b and derived45d97947ea27b54d83db353246fb7c1f7cf485bc are unchanged. No fake original GREEN and no new oracle adaptation in this return.
- RED execution substitutes ONLY lib/ad-spend.ts from81573d5f in the final206cb747 graph. It is not a checkout of the entire historical RED commit. Original dependencies/aliases otherwise stay final.
- Actual tsconfig ES2017/strict/Bundler,9 roots/824 imported sources:0 diagnostics, exit0. Lint the same9 TS roots:exit0, no output. No full/global tsc/build/client-bundle or live browser certification.
- Per child ceilings admitted before execution:20,000 MemoryRedis.run including nested commands,100 intercepted HTTP requests,120s/512MiB/128KiB; types1024MiB/120s. Hook enforces before dispatch, overflow is fatal; socket connection is blocked before the graph loads. Maximum observed486 run and60 mockHTTP in meta-ads, not a summed per-child threshold. Tests were serial. Zero real Redis/Upstash/Meta/Stripe/Anthropic calls or credentials.
- The corrective delta adds at most one HDEL after an unknown write receipt and no new family. That paid command is not zero. The caller takes a studio request before addSpend; the1000 argument of guardStoreWrite is a body-size cap, not monetary admission. This review does not certify the generic studio worst-case command/byte model or global MR. No price, visible limit, commission, feature gate or flag changed.
- Author source, tests, branch/ref, CI and merge queue are untouched. No main integration solely to refresh. Original own products2741/2819 still retain their independent dispositions and WIPs. C1-TODOS14/15 remain applicable; this evidence branch is not a new product PR or CI run.

## Reproduction

Use the exact206cb747 checkout, copy the own tests and this directory there, and provide the esbuild dependency path named in runner.mjs. Set Z_TEST_ROOT to that checkout when relocating it. Run:

```sh
node docs/reviews/z-2924-write-return/runner.mjs z-2924-write-ack.proof.ts ad-spend-write-receipt.test.ts z-2924-deferred-write.proof.ts
Z_RED=old node docs/reviews/z-2924-write-return/runner.mjs z-2924-write-ack.proof.ts ad-spend-write-receipt.test.ts z-2924-deferred-write.proof.ts
```

Both groups exit1 because the separately recorded deferred proof remains RED; see head.log/old.log for per-file outcomes. The linked group exits1 solely because the deliberately frozen6 remains incompatible; no ordinary linked test failed. Full raw logs, the unchanged proofs, runner and actual type checker are kept together. Temporary diagnostic stack paths are synthetic local bundle paths. Scanner/diff publication receipts accompany this report.
