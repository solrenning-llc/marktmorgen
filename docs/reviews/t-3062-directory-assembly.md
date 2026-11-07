# T review: directory assembly ceiling, PR #3062

Subject: `c1eab77844d5d5265e2b4c9994525f764d62dd66`, tree `b1f3cd8cb2fad6fcbbf406f0c66a0e96cf10a0b9`.
Base: `c367dd817c32f663f1b673f5b08a36653fc74e7f` (#2921).
Reviewed November 7, 2026. This report covers the nine-file delta, not global financial approval.

## Result

No new HIGH or MEDIUM demonstrated in this delta. One conditional LOW: the new
description promises a single-flight lock / “one build at a time,” but the
60-second claim only excludes another start while its lease remains live.
It is a minimum interval between starts, not lifetime exclusion of unfinished work.

Locations: `lib/affiliate-directory.ts:89` and `:274`, corresponding test preamble,
`NOT_A_COST.DIRECTORY_BUILDS_PER_HOUR` wording, and the PR description.
`readDirectory` acquires SET NX EX 60, then awaits SSCAN and downstream work without
renewal or an end-to-end duration bound. A slow first build can remain in flight
after the key expires. A second visit can then acquire the same key and begin a
second assembly before the first finishes.

Independent causal probe: `tests/t-3062-overlap.proof.ts` holds the first SSCAN,
then starts the second call against the actual head implementation and MemoryRedis.
Without advancing the clock: `{scans:1,busy:true}` (control PASS).
After advancing only the synthetic Redis clock by 61,000 ms while the first call
is still suspended: `{scans:2,busy:false}`. The same exclusion assertion fails
`2 !== 1`. Two scenarios, one passing control and one failing assertion, 14 actual
MemoryRedis command dispatches, zero provider/network calls. No real 61-second wait.

This does **not** demonstrate more than 60 assembly starts per hour, a paid-provider
latency of 60 seconds, an exploit, financial loss, or a new consent/cache race.
The PR already discloses the inherited stale-build/save race; it is not counted
as a newly discovered finding. Individual Redis calls have a timeout, but this
probe concerns the whole assembly; no production duration measurement is claimed.

Suggested disposition: qualify the guarantee as the start interval / suppression
of misses during the live claim, with this boundary control. Lifetime exclusion
would need a separately justified operation bound or lease design. T has not
changed the author's source, lease value, prices, limits or funding controls.

## Executed validation

The permanent test blob is byte-identical in author RED `c2fcd8c62` and final head:
`ee757ff02549679d0ad03ee9756e991a1bcc8dd4`.
The unchanged final test was run in the final graph with only the three changed
runtime/registry modules and page-source read redirected to exact base bytes:
30 checks / 23 failures on base; final head 30/30. This matches the durable RED.

Current head checks executed once per selected group:

| Group | Passed | MemoryRedis commands |
| --- | ---: | ---: |
| directory-assembly-ceiling | 30 | 9,790 |
| affiliate-directory | 25 | 661 |
| directory-index-unknown | 58 | 481 |
| directory-index | 11 | 37 |
| plan-cost-registry | 24 | 0 |
| store-data-registry | 7 | 0 |
| closing-families | 4 | 0 |
| data-recount | 13 | 118 |
| platform-us-english | 42 | 0 |
| **Total current permanent checks** | **214** | **11,087** |

Base RED used 11,617 commands. All selected runs used zero mock HTTP calls.
The independent overlap probe was rerun only after adding subject/allowed-file
guards to its portable runner; it reproduced the same 14-command observation.
That diagnostic remains failing by design; it is not included in 214 passing checks.

`scripts/t-review-3062.mjs`: serial child processes; before-dispatch 20,000-command
MemoryRedis ceiling per child; 100 synthetic-fetch ceiling, external fetch refusal
unless a test explicitly supplies its synthetic mock; node HTTP(S) request/get
refused; 120-second timeout, 512 MiB child heap and 256 KiB captured output.
These are harness budgets, not approved commercial limits. No case-count ceiling
is claimed. The runner now rejects other subjects or unadmitted test filenames.

Actual TypeScript options loaded from this head's tsconfig: target ES2017, strict,
Bundler resolution, noEmit; six roots (three changed tests, the independent probe,
data-families, store-data-registry), 488 non-declaration sources, zero diagnostics,
zero emitted files. 1,024 MiB heap for the type process. No raised target, alternate
dependency installation, full Next typegen/build or generated LayoutProps claim.
The page's cache sharing was reviewed in source and the permanent source checks;
no real Next request, React server dispatcher, browser or screen-reader execution.

ESLint: all nine changed paths plus the independent probe and runner, exit 0;
runner syntax check passed. Subject delta whitespace check passed. Full tracked
head public-data scanner: 4,134 files / zero findings before adding own artifacts.
Own artifact scan/whitespace results are recorded in the publication receipt.

Node 24.22.1. Lock and installed dependencies match exactly: TypeScript 5.9.3,
esbuild 0.28.2, ESLint 9.39.5, eslint-config-next 16.4.2. No installation.
The first version-display helper tried an unexported package.json subpath; reading
the installed package file directly recovered the receipt without changing deps.

## Financial and inherited boundaries

Read storeForId/storeForEmail and programNumbers on this head: two store GETs and
four HGETALL when numbers are shown. The stated command arithmetic checks out:
1+1+64+4,000+8,000+1=12,067; times 60=724,020/hour; times 720=521,294,400/30 days.
At the line's supplied $2/million command coefficient: $1,042.5888, fixed $5.7888
and $0.5184 per listed store in 30 days. Arithmetic is not source-rate validation,
full bytes/transfer/server cost, funding approval, or proof of company profitability.
C1-1306's regional-top rate sweep belongs to C2; no new provider-source research
or coefficient edit is claimed here. Unlimited cache-hit/busy requests are not
covered by the assembly-only command number, as the author's text explicitly says.

T's prior #2921 cumulative-scan candidate and other inherited unknown-read classes
are not self-closed by this review. No author source/ref/CI operation, product push,
enqueue, merge, payment, account, contact or provider mutation was performed.

## Reproduction

Copy the two own scripts/test artifacts from this proof branch into a clean
checkout of the subject SHA above, retaining its exact installed lock dependencies.
The proof branch itself adds three paths and is not the subject checkout.

```sh
node scripts/t-review-3062.mjs red directory-assembly-ceiling.test.ts
node scripts/t-review-3062.mjs head directory-assembly-ceiling.test.ts affiliate-directory.test.ts directory-index-unknown.test.ts
node scripts/t-review-3062.mjs head directory-index.test.ts plan-cost-registry.test.ts store-data-registry.test.ts closing-families.test.ts data-recount.test.ts platform-us-english.test.ts
node scripts/t-review-3062.mjs head t-3062-overlap.proof.ts
```

RED and the conditional overlap command intentionally exit 1. The current
permanent check commands exit 0. No blanket merge permission follows from this report.
