# Review summary cardinality and read proof

Proof only, Codex Z, 8 November 2026. No product change or supplier access.

Frozen main: `2c36c6be1585d1c7140db333082799b9f27b8fc2`.
`lib/review-ai-summary.ts` blob `4f5a5ea1e7e62eb66e9468241902b3e3639d0d4e`;
`tests/store-data-registry.ts` blob `961b96d34978202d5687b4bf643ee20dda7feaa8`;
`lib/redis-memory.ts` blob `b1356f72ab4e511d93d622b91c903237ce7068f3`.
These sources are unchanged. The only new test is
`tests/z-review-summary-read-bound.test.ts`; this directory contains its receipts.

## Result and cause

Proposed MEDIUM contract finding, pending coordinator/R2 classification and source
ownership. The registry at `tests/store-data-registry.ts:517` claims at most three
theme entries and four KiB for a product summary. The real producer can exceed
both in a schedule with expired leases and unavailable cleanup transport.
`lib/review-ai-summary.ts:139` reads every theme entry, without LIMIT.

Every producer first obtains its real lock and reads its real snapshot. The test
pauses it immediately before the keeping pipeline dispatch, after its real model
answer and validations. MemoryRedis's supported clock advances 121 seconds before
the next producer starts, expiring the actual 120-second lock. No lock value,
summary head or theme entry is seeded or forged. The suspended producers then
resume in order. Their original ZADD and EXPIRE run before KEEP checks whether the
lease is still theirs. The stale KEEP returns zero. A subsequent complete ZREM
cleanup request fails before dispatch; no partial pipeline result is invented.
Only the last producer still holds its lease and keeps its head.

| Schedule | Models / jobs | Kept / failed | Theme entries | Theme payload bytes | Decoded read JSON bytes |
| --- | --- | --- | --- | --- | --- |
| 16 healthy serial requests | 1 / 1 | 1 / 0 | 1 | 301 | 426 |
| 16 expired snapshots, cleanup works | 16 / 16 | 1 / 15 | 1 | 301 | 426 |
| 4 expired snapshots, cleanup unavailable | 4 / 4 | 1 / 3 | 4 | 1,204 | 1,428 |
| 16 expired snapshots, cleanup unavailable | 16 / 16 | 1 / 15 | 16 | 4,816 | 5,436 |

The final real read dispatches exactly three commands: GET head,
ZRANGEBYSCORE themes -inf +inf, GET weekly mark. It reads sixteen entries even
though the registry budgets for three. The actual stored theme strings alone
exceed the four KiB capacity. The measured read bytes serialize the decoded
MemoryRedis reply; they are a payload lower bound, **not** a captured Upstash HTTP
envelope, supplier invoice or price estimate. Four KiB is a registered storage
capacity, not a separately documented wire-byte allowance. The wire comparison
is a regression oracle anchored to that same small-record premise.

All actual model calls remain counted. Immediately before every synthetic model
dispatch the real monthly counter reads 1 through 16 respectively. The proof
does not claim free AI calls, absent request admission, exhausted company funding,
or financial loss. The route's existing guardStoreWrite and withinEssentialLimit
are not bypassed or changed; this test invokes the producer and read functions
directly, rather than certifying the authenticated route.

## Limits and corrective direction

The four-producer schedule requires a maximum simulated suspension of 363 seconds;
the sixteen-producer stress schedule requires 1,815 seconds. They advance the Redis
clock without waiting and do not certify that a deployed function survives those
durations. Deployment lifetime, process suspension, transport scheduling and
actual provider billing are unverified. Expired leases/paused functions are an
explicitly handled case in lib/redis-lock.ts; nevertheless, the long stress result
must not be represented as an observed deployment incident or an unbounded dollar
loss. The proof establishes what these producer functions permit under the stated
schedule, and falsifies their unconditional three-entry comment.

A repair should fence theme insertion together with KEEP, and independently bound
the reader's transfer with an explicit overflow/unknown result. A truncated set
must not silently become "no summary" when the head's entry lies outside the
page. Neither a larger registry budget nor a changed customer price/limit/flag is
a demonstrated repair. No product patch is included: source overlap/ownership and
the proposed classification still need the coordinator's disposition. This proof
is the fifth own unit; no sixth unit may be opened while the other four holds
remain active.

## Validation

Final proof: **10 assertions, 6 controls passing and 4 ceiling assertions RED**.
Final post-typing runtime check is preserved in final-red-run.log; the final
portable-runner check is in portable-runner-red.log, with the same 10/4 result
and 1,474/37 volume. Earlier logs are retained, never replaced with a claimed
GREEN. Display logs normalize trailing whitespace only; raw-evidence.json keeps
each original string and its SHA-256 for reversible, byte-exact recovery.
The first fixture used a 41-character title, rejected by the existing 40-character
rule. fixture-initial.log is an invalid fixture/control failure, not the qualified
RED. Shortening that synthetic title preserved the four-theme expectation.
The first type run exposed a closure-narrowing TS2339; types-initial.log retains
it. An explicitly typed observation getter fixes that test typing, without an
oracle cast or changed assertion. Final scoped types: one root, 446 sources,
ES2017/strict/Bundler, zero unfiltered diagnostics. ESLint on the new test: exit 0.

Five unchanged linked suites passed: review-ai-summary (82),
review-ai-summary-rules (30), review-summary-read-exact (15),
review-summary-read-slots (12), review-summary-keep-receipts (5): **144 checks**.
Their own command/model volumes are preserved in linked.log. No CI query, retry,
queue, merge, official PR promotion, independent-review approval or nine-green
certificate is claimed.

The runner installs command/mock guards before loading the bundled graph:
20,000 nested MemoryRedis dispatches and 100 mocked HTTP calls per child,
120-second timeout, 512 MiB heap, 256 KiB output. External fetch defaults to refusal;
only the test's explicit mock is allowed, and external sockets are refused.
Types use 120 seconds/1 GiB. No budget was raised. Final proof volume: 1,474
commands and 37 mocked calls, no ceiling hit. Source instrumentation adds only a
pre-dispatch counter to MemoryRedis.run; it does not change command results.

Reproduce from this frozen tree, with repository dependencies available:

```sh
node docs/reviews/z-review-summary-read-bound/runner.mjs z-review-summary-read-bound.test.ts
timeout 120s node --max-old-space-size=1024 docs/reviews/z-review-summary-read-bound/types.mjs
node docs/reviews/z-review-summary-read-bound/runner.mjs review-ai-summary.test.ts review-ai-summary-rules.test.ts review-summary-read-exact.test.ts review-summary-read-slots.test.ts review-summary-keep-receipts.test.ts
```

The proof command intentionally exits 1 until the finding is disposed or fixed;
do not merge this proof branch into main as a passing product fix.
