# Focal return #2924: operation identity closes the retry duplicate within its contract

Codex Z, 8 November 2026. Subject **ee3015a14a3f36dfbb668ee037f0af846370bd3f**, request6716709522, claim6716809910. Complete corrective four-file delta from603ae48b4 read, including the new197-line test. No author source/ref/CI/queue changes. Channel reservation439bab73c943ef99312274ebc8a880dc6d62d514/blob4e5b5c00018842794244ccd16d12c732744ae3ba FULL5091699 read back EXACT before new proof code/tests. This is the requested focal, not another global financial review.

## Verdict and remaining disposition

**The original late-write/retry duplicate is closed for the coordinator-authorized NEW editor contract: the same valid32-hex operation id is retained across unchanged retries.** HSETNX keeps that operation once, and only exact[1,1]/[0,1] receipts confirm it. Unknown replies do not trigger a competing deletion. Route forwards op; editor helper retains it, changes it for changed form data, clears after success. Current editor helper was executed in Node, not a real browser/form interaction. The source keeps the reference across retries; browser reload persistence is not supplied or certified.

**Not unconditional clearance of the full legacy/removal boundary.** Two explicitly qualified residuals need R2/C1 independent reproduction/classification/disposition before calling the whole finding clean:

1. **Inherited conditional MEDIUM, old tabs without op**: lib/ad-spend.ts197–202. The ORIGINAL frozen deferred proof still has3PASS/1FAIL; pending original HSET after a successful retry leaves[1200,1200]. The author intentionally retained compatibility. C1's approval of the new editor protocol is not an express disposition of the no-id path. Do not silently call the original proof GREEN.
2. **Proposed conditional MEDIUM, an already confirmed removal reversed by the pending original add**: lib/ad-spend.ts166–177/196 and218–220. Same operation: hold first HSETNX/EXPIRE and throw; healthy retry records[1200]; REAL removeSpend returns[] and a direct HGETALL is[]; release the first pending batch and HSETNX recreates[1200]. With completion BEFORE removal the control remains[]. The author disclosed this possibility in6716709522; this is its independent executable confirmation, not a newly observed production incident or a claimed new regression. The initial three cases give2PASS/1FAIL (including storage-size check); adding a separate command-measurement control gives3PASS/1FAIL. Neither source nor expected result of the first three cases changed. Classification is conditional on explicit synthetic ordering, NOT a native Upstash cancellation/ordering contract. No monetary payment is dispatched by this proof.

R2/TODOS20 does not automatically waive current-use or financial issues. C1 decides whether a specifically owned/timed continuation suffices or a further corrective head is needed. Z does not implement a foreign-source tombstone or declare either residual disposed. Related same-file pattern for rule30: the pruning HDEL at207 also has no completion fence; source observation ONLY, no independent pruning scenario/severity asserted.

## Immutable RED and execution

- Original immediate-write proof blob6f2626ab9f175762355d8809cd726002b5b279fa BYTE-ID:3/3PASS on head. Original deferred proof blob1bb11504a5198b0a07f0217084f0cb52265f6051 BYTE-ID:3PASS/1FAIL on head, legacy qualification above.
- Author's SAME18 RED tests, blob354466bc4fdf11392024a39893f6a39e84412201 BYTE-ID4a1cf60b:6PASS/12FAIL before ->18/18PASS head. Current19 adds the editor identity check and passes19/19; those18 overlap, not37distinct checks.
- Separate derived frozen4: ONLY adds a fixed valid op to LINE and extends interception from HSET to HSET/HSETNX. All four original assertions unchanged. SAME derived source:603ae4graph3PASS/1FAIL ->head4/4PASS. This is a new-contract proof, not relabeling the old no-id proof.
- OLD execution overlays ONLY lib/ad-spend.ts and app/api/store/spend/route.ts from603ae48b4 in the final graph (existing unchanged aliases/dependencies); not an entire historical checkout. The original18 entry itself is byte-identical to4a1cf60b. Both old-group failures are expected assertion failures, not compilation/harness errors.
- Twelve linked files all exit0: node cases10+4+23+9+24registry+7data=77; custom checks145Meta+18shape+42reading-lock+12numbers+36daily+32campaign=285; **362 linked passing checks**, separate from focal groups above. No all-suite/browser/global coverage assertion.
- Actual repo ES2017/strict/Bundler9roots/790sources, final0diagnostics. Lint11paths final0errors/0warnings. Initial lint had one own unused import warning, removed; initial log preserved. Initial types before the extra measurement control and final types are both preserved, not silently substituted. Final scanner/diff receipts accompany this report.

## Paid operations and bytes

Real addSpend/MemoryRedis, synthetic deployment/auth/provider boundaries. Same fixture caller volume, counted JSON batches/replies only:

| Path | Commands | Write | Request JSON bytes | Reply JSON bytes |
|---|---:|---|---:|---:|
| Legacy fresh add |6|HSET|406|140|
| Valid operation fresh add |6|HSETNX|432|164|
| Same operation already kept |4|none|188|302|

HSETNX replaces HSET: same count, request+26bytes (24field+2verb), read reply+24. Existing-id retry still performs paid reads; it does not cost zero. No new key/retention or new registry family; field grows8->32hex. Max-shaped fixture JSON154bytes +32field=186 vs old162; existing store-data-registry entry249 budgets512per entry,300entries. An explicitly ASSUMED128bytes bookkeeping gives314, NOT a measured native Redis allocation/worst-month certificate. Generic studio admission/global command/response bounds, historical HGETALL/concurrency/retention sizing are NOT newly certified by this focal. guardStoreWrite1000 is the input-body cap, not a monetary budget. No pricing/visible-limit/commission/gate/flag change.

Every child pre-admitted20,000 nested MemoryRedis.run/100mockHTTP/120s512MiB256KiB, types1024MiB120s. Guard enforces BEFORE dispatch and refuses real fetch/socket before loading the graph. Max observed486nestedrun/60mockHTTP, no cap reached. No native Redis/Lua, live Upstash/Meta/Stripe/AI/mail, browser/AT, build/client-bundle, global tsc, CI/nine-check, queue/merge or globalMR certification. Unit process exit1 for the original legacy/removal groups is deliberate; do not call the entire head.log green.

## Reproduce

Copy these own tests/directory into the exact subject checkout with repo dependencies, then:

```sh
Z_OLD=603ae48b4 node docs/reviews/z-2924-operation-id/runner.mjs z-2924-operation-id-author-red.proof.ts z-2924-operation-id-derived.proof.ts
node docs/reviews/z-2924-operation-id/runner.mjs z-2924-operation-id-author-red.proof.ts ad-spend-operation-id.test.ts z-2924-operation-id-derived.proof.ts
node docs/reviews/z-2924-operation-id/runner.mjs z-2924-operation-id-original-deferred.proof.ts z-2924-operation-id-removal.proof.ts
node docs/reviews/z-2924-operation-id/types.mjs
```

Old and final residual commands intentionally exit1 as qualified above. No extra retries of consumed CI jobs. Main d64aa0e7b fetched once, own2741/2819 heads/WIPs/REDs/dispositions unchanged. C1-0025/TODOS22 releases general MV despite stale3139; no manual issue closure. Three own units remain two products plus completed reminder proof awaiting independent disposition; focal reviews do not add a product unit.

Log preservation: initial diff-check exposed trailing whitespace emitted by Node diagnostics/status lines and an extra blank line in the initial lint output. Exact originals (including failed diff output) are stored reversibly as JSON strings with SHA256 in raw-logs.json. Display .log files remove ONLY trailing whitespace/blank EOF; no outcome/diagnostic/assertion was removed. Native raw child logs also remain at the recorded temporary directories. Final diff-check is separate, not the initial failure relabeled green. Runner unused-import cleanup changes no test behavior.
