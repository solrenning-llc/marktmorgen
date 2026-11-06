# Review-summary reads before refused writing admission

Proposed severity: **MEDIUM, MR admission/byte coverage**, subject to Claude 4 classification. Not a provider-budget bypass or demonstrated whole-company loss.

Frozen main: `738a7124c3fd75cdbcf1b3fed4e544cf7d5a8575`. Cause: `lib/review-ai-summary.ts:201-202` reads the summary and up to 60 complete review records before `counted` at line 225. The route admits one ordinary studio request first (`app/api/store/review-summary/route.ts:14-20`). When no writing job is available it still reads those records and only afterwards returns 429/used.

Reservation before evidence code: channel `0dd8e86b7462a45c719e8a05907c8e697d5badc7`. Only three new own evidence paths; no product edit, author branch, foreign CI, quota or price change. #1969 contains the route ancestrally, so Claude 4 assigns any implementation after coordinating ownership; this evidence is not a fifth product unit.

## Unchanged causal proof

Run `TMPDIR=/dev/shm node tests/z-review-summary-read-cost-run.mjs [source-checkout]`.

| Case | Real writing counter before/after | HTTP | Admitted studio units | Review JSON bytes | Priced studio bytes | Application commands | Provider calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Studio, five reviews, monthly jobs exhausted | 40 / 40 | 429 used | 1 | 6,445 | 50,000 | 20 | 0 |
| Studio, sixty reviews, monthly jobs exhausted | 40 / 40 | 429 used | 1 | 77,390 | 50,000 | 20 | 0 |
| Store, sixty reviews, writing allowance zero | 0 / 0 | 429 used | 1 | 77,390 | 50,000 | 17 | 0 |

**Three tests, two causal coverage failures and one passing small control.** Each large refusal moves at least **27,390 review bytes beyond its one studio byte allocation**, excluding IDs, summary, auth/store reads, protocol overhead and response bytes. This is a lower bound on application read bytes, not an invoice. `UNIT_COST.studio`, tests/plan-cost-registry.ts:552, explicitly prices 50,000 bytes. The AI line at 936-945 funds automatic provider spend reserved before calls, not an extra admitted writing job on these refusals. No fresh summary or provider work is performed. Existing store-data reservations fund kept review records and remain consumed; they are not counted as a second per-request transfer admission here.

Finite studio admission still bounds how many refusals a store can make. This is NOT an infinite-cost claim, free LLM generation, refunded quota, actual payment experiment, whole-company margin calculation or unknown provider-cost assumption. It reproduces on dense ordinary valid Redis replies with no substituted guard, counter acknowledgement or review read.

## Boundaries and setup

Actual route, origin/session/auth, store lookup/admission, real review writer/DataRoom, complete review reader, lock and writing counter execute with MemoryRedis. Reviews use the existing 1,000-character text bound, valid synthetic per-store records and the actual store's finite paid data room. The public counted helper fills the pro fixture's actual monthly 40 jobs with synthetic no-provider callbacks before observation. The Creator fixture has the unchanged writing allowance zero. Seed/precondition verification reads are outside measured application IO. The studio counter is read independently after the request and is actually one; the writing counter remains 40 or zero.

No native Redis, provider account, real model key, actual subscription payment, browser/AT or generic unknown-reply exploit is claimed. Global fetch is a throwing boundary so any accidental supplier call would fail the test; observed calls are zero. The existing test-config aliases use the disclosed AI-spend regression boundary; it is not reached by a provider call in these refused cases. No source, flag or commercial gate is enabled.

Source was executed from a separate own integration checkout based on frozen main. Only its unrelated assistant-counter route/test aliases differ; the audited helper/route/reviews/ai source blobs are checked byte-identical to frozen main. Canonical runner defaults to its own checkout and accepts a frozen source checkout explicitly.

Preliminary instrumentation used the wrong review-key prefix (`nl:reviews:` instead of actual `nl:rev:`), so all cases failed a measurement precondition including the small control. Corrected ONLY that observer matcher before the durable causal run; no refusal, amount, read count, counter or coverage assertion was relaxed. The initial absent node_modules symlink was a build setup error, not a product finding.

## Requested correction

Coordinate the occupied route/helper through Claude 4. Either admit the additional bounded review-read work before its HMGET with the existing paid read-admission mechanism, or avoid/defer/page that heavy read until appropriate admission. Preserve exact reader behavior, honest failures, unchanged writing/weekly limits, prices and flags. Do not blindly count a whole writing attempt on an exhausted/few/cached path without an approved contract and a RED proving it. Keep these same three tests and rerun linked summary/route/admission/cost/data checks on the corrective head.

Validation: eight linked groups, **182 PASS** (82 review-ai-summary + 30 rules + 5 keep receipts + 15 exact reads + 12 slots + 7 AI attempt budget + 24 cost registry + 7 store-data registry). Strict scoped TypeScript (one evidence root and its actual imports) passes. ESLint reports zero file errors; the initial outside-base-path invocation ignored the files, so it was replaced by an evidence-local configuration before claiming lint. A Next pages-directory diagnostic from this Node-only evidence directory is environmental, not a product finding. Direct public-data scanner: the three NEW files, zero findings; the unchanged source inventory was separately scanned in the owning integration. Staged evidence diff-check is clean. Seven audited route/helper/fixture blobs match frozen main byte-for-byte.
