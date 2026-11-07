# T second financial review — #2895

Exact head `4b720b12906609aff0567ca74285ad9f570f19df`, tree
`889d5de6bb4a55087a16a3a00da0baee9321ed9f`, base `2a0a5ff45f2b48be32a2ef83a0134b2697d19142`.
C6-1342/1343 requested a second independent review; C6/6710045978 is the first
on this head. Claim 6710498574 and channel RES 0d5ec094/8f6cec28 preceded source,
diff and tests. All six changed paths and the 49ee8c53 merge delta were read.

## Result and boundaries

No new HIGH/MEDIUM demonstrated in the reviewed delta; one additional conditional
LOW in the new pending-mark acknowledgement. The hand-over-before-removal fix
remains effective: actual return and delivery callers throw on product-gone false;
settle marks pending before recording and delivering, then removes pending last.
The merged stillPending guard returns from askPending (not an illegal continue);
unknown/not-pending does not deliver, and an actual hand-over failure reaches the
per-order catch and increments stuck without blocking later orders/refund checks.
Only the production return route calls captureOrder; its handOver argument is supplied.

LOW, `lib/paypal-sales.ts:630-632`: the single-member ZADD NX reply is checked with
countOf, so an impossible count 2 passes. Its exact reply domain is 0 or 1; the
new source comment also says so. Independent probe `t-2895-pending-count.proof.ts`
runs actual captureOrder with synthetic paid PayPal data and actual MemoryRedis;
only the ZADD result slot in the two-command pipeline is replaced after execution.
Control reply1 → `{ok:true,handed:1}` PASS. Invalid reply2 produces the same result;
the expected unknown/error and zero hand-over assertion FAILS. SET NX still
answers actual OK. Two scenarios, 24 commands, three synthetic HTTP mocks, zero
providers. This is not a normal Redis response, a live exploit, an extra capture,
or proof of duplicate money/unauthorized payment. It establishes incomplete exact
reply validation only. Suggested author fix: require the actual 0/1 domain before
hand-over, preserving SET NX and retry behavior. T changed no author source.

The acknowledged inherited MEDIUM (paid product removed, open record eventually
expires without terminal outcome) is NOT closed here. The 25-oldest-order window,
stuck-only-log and optional default handOver concerns remain. C6's newly reported
repending race/extra work remains credited to C6; its separate proof was not run
or declared T execution. No #2909 junction, full provider/funding/profitability,
all-flow security or production opening certification follows from this review.
Coordinator disposition, dependencies, two valid financial reviews and final
exact-head gates remain prerequisites for queue admission by the authorized owner.

## Executed evidence

Same final paypal-handover-first test, with ONLY route and paypal-delivery from
3208fad1 in the final graph: 13 tests, 3 fail (removed-product pending assertions);
current head13/13. This is a scoped old-source experiment, not a full old checkout.
Independent source mutation removes ONLY `if (!still) return;`: final
paypal-handover-exact10/1 FAIL (race test8); actual head10/10. This mutation is a
diagnostic, not an author RED commit, and never touches the working source.

| Current permanent groups | Pass | MemoryRedis | HTTP mocks |
| --- | ---: | ---: | ---: |
| handover-first | 13 | 851 | 35 |
| handover-exact | 10 | 246 | 20 |
| sales-exact | 65 | 228 | 23 |
| refunds-exact | 27 | 17 | 0 |
| paypal-sales | 67 | 325 | 42 |
| plan-cost-registry | 24 | 0 | 0 |
| platform-us-english | 42 | 0 | 0 |
| Total | 248 | 1,667 | 120 |

Old-source experiment864 commands/33 mocks; guard mutation249/20. New LOW probe
is separate, one passing control/one failing assertion, not included in 248 PASS.
No unchanged prior T review/test was replayed: T had not reviewed this head.

Actual head tsconfig: ES2017, strict, Bundler, noEmit; four roots (three affected
tests plus own probe), 421 non-declaration source files, zero diagnostics/emit,
1,024 MiB type-process heap. Lint all six changed paths plus runner/probe: exit0;
runner syntax and subject diff whitespace pass. Final own-artifact diff and
tracked scanner receipt accompany publication. No full Next build/browser/Lua or
real Redis/PayPal execution. Exact lock=installed TS5.9.3/esbuild0.28.2/ESLint9.39.5/
config-next16.4.2, Node24.22.1; no installation or account/provider contact.

Runner `scripts/t-review-2895.mjs` requires this exact checkout and unchanged
subject source; admits only the listed files; serial children, 20k MemoryRedis
dispatch ceiling checked before each command, 100 synthetic fetches, 120s,
512 MiB heap and 256 KiB output per child. Default fetch and HTTP(S) request/get
refuse network; explicit mocks only. No case-count cap claimed. Copy own runner
and probe into exact head; proof branch adds three paths and is not the subject.

```sh
node scripts/t-review-2895.mjs gone-red paypal-handover-first.test.ts
node scripts/t-review-2895.mjs guard-mutant paypal-handover-exact.test.ts
node scripts/t-review-2895.mjs head paypal-handover-first.test.ts paypal-handover-exact.test.ts paypal-sales-exact.test.ts paypal-refunds-exact.test.ts paypal-sales.test.ts plan-cost-registry.test.ts platform-us-english.test.ts
node scripts/t-review-2895.mjs head t-2895-pending-count.proof.ts
```

First, second and last commands intentionally exit1; the permanent head groups
exit0. No author ref/source/CI operation, product push, enqueue or merge by T.
