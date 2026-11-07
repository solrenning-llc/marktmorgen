# Second money review of #3099

Subject `55cb544e3e55814a62810b372ed27250ac6ce55e`, tree `d2f65eba03e550356c7d38237a561da9c08af511`, base `1d7cbe8dda5d35d049c699def9919b89a6376ef5`. First C6 review/focal6712088601/6712309813 credited. T claim6712504043 and accepted channel RES74d0f336 preceded source/diff/test work. C1-1633 own/focal priorities reconciled; #3117 second position was already claimed by S, so T inspected no source there.

## Verdict

No additional HIGH/MEDIUM demonstrated in the reviewed three-path delta. One new conditional LOW in the new rescheduling path: `lib/closed-store-data.ts:600,611` awaits ZADD XX but never validates its reply. If the reschedule is not applied and its slot is null/unknown, eraseClosed reports done, the old due score remains and another hourly invocation tries the store again. Thus the claimed 20-hour interval is conditional on an acknowledged reschedule. Suggest rejecting an unknown acknowledgement instead of silently certifying that it moved back. XX can legitimately answer 0, so do not require exactly 1 merely because the memory stand-in returns 1.

Independent diagnostic uses actual eraseClosed, a real synthetic store and owner-key fault; it substitutes **only** the rescheduling response `[null]`, without applying that ZADD. Healthy control: one owner read across two invocations an hour apart; unknown result: two owner reads (expected one). Both keep the store reachable. Concurrent unmark control remains absent after XX. Five checks: four controls PASS, one conditional interval assertion FAIL; 43 MemoryRedis commands / zero HTTP. No queue loss, deletion of a live calendar, production bill, increased financial loss, unbounded loop or real provider failure is demonstrated. Each invocation still has its per-run limit; this is a bounded retry-cadence/acknowledgement LOW, not a new cost coefficient or margin certificate. No T source fix.

The original unreadable-store defect and the host-other-stores defect are corrected in this delta: thrown reads keep the store due, preparation throws before deleting another live store's calendar, and per-store catch lets other readable stores proceed. C6's existing LOWs remain open and credited: marksOf/readAllListings/readFlows/readCourses/readTeam unknown defaults, closeStoreRecord preceding BATCH_KEY HSET, and MemoryRedis ZADD's inaccurate count/combined-flag behavior. The dependent exact store reader/#2878 and #2560 rewrite are not globally approved or assumed merged. Nil versus malformed store records remains qualified as in the PR.

## Execution

SAME final permanent `tests/closed-store-unknown.test.ts` blob `2cfe2ffc61254fb69fd2e31a3e818f601be63ba6`, with ONLY the base closed-store-data module in the FINAL graph: **10 checks / 5 FAIL**, 345 MemoryRedis commands / zero HTTP; actual head **10 PASS**, 295 commands / zero HTTP. Final XX stand-in retained in that causal comparison; this is not execution of the author's original three-case RED checkout or C6's private proof.

Current related groups: closed-store28, host-calendar-removal1, host-calendar-read-evidence25, closing-families4, store-data-registry7, review-stop-exact31. With the new permanent10, **106 PASS**, 8668 MemoryRedis commands / 21 mocked fetches. The five-case conditional diagnostic is separate, not GREEN or part of 106. Actual tsconfig ES2017/strict/Bundler three-root imported closure480: zero diagnostics/emit with 1024MiB. ESLint all three changed source/test files plus own proof: exit0. Runner/type-driver syntax and subject/staged whitespace checks passed. Scanner result is recorded in the formal review after staging four own files.

Copy the runner, type driver and proof into an unchanged exact subject checkout; the evidence branch adds four own paths and is not the subject. Runtime children admit only named files and reject another HEAD/protected-source changes. Before dispatch:20,000 MemoryRedis.run commands including nested operations,100 mocked fetches,120s/512MiB/256KiB per child; default fetch and node HTTP(S) are refused. No real Redis/Lua/provider, route integration, browser, CI, deployment or global financial audit. Existing exact lock dependencies retained; no install/config changes.

```sh
node scripts/t-review-3099.mjs red closed-store-unknown.test.ts
node scripts/t-review-3099.mjs head closed-store-unknown.test.ts closed-store.test.ts host-calendar-removal.test.ts host-calendar-read-evidence.test.ts closing-families.test.ts store-data-registry.test.ts review-stop-exact.test.ts
node scripts/t-review-3099.mjs head t-3099-backoff.proof.ts # expected one conditional failure
node --max-old-space-size=1024 scripts/t-review-3099-types.cjs
```

Fresh native main `09dd1ece44482e239e4d10bd690d9e46ab1e2fcc`: normative/reservation/inbox/queue diff against previously read1d7 is empty. C1-1630 annual refunded-first-period ceiling70 applies via C2 only; month15/unsubscribed0.40 and visible quotas unchanged. No T price/limit/flag/gate/ref/CI/queue operation. Main-vermelho issue search empty before publication. Final exact gates, valid independent opinions, dependencies and coordinator queue disposition remain separate.
