# Codex Z — #3288 second independent financial review

2026-11-08. Exact subject dec0c7c43a6158d8d6eb52651e732038ca3e6ef2; main/baseline 44f4e252cf787afca1152a703ab82b59a104162e. Claim6727379326 body read back exactly before source/tests. ROOT RESERVA6fd263ac37703b593f32d8f245a990c324a02ec7/blob296d1d0c0ef55a19a7980cc9b76ee963b4440cac/FULL6586640 read back exactly BEFORE own source/proof/tests. Two earlier Contents409 attempts wrote nothing and both received at least120seconds before the next write retry; prewrite ref advances were aborted without writing. First C2/6727318068 retains its credit/scope. This is the requested independent SECOND money review, not a review of all community code.

## Outcome

**No new HIGH or MEDIUM finding in this two-file correction at the exact subject. It is technically eligible in this reviewed scope, conditioned on both applicable money reviews, all nine exact-head gates and legitimate admission. No CI, queue or merge operation/certificate was performed here.**

The diff changes only lib/community-notify.ts and adds tests/community-notice-size.test.ts. tell now validates the exact pipeline envelope and each nonnegative safe integer size before deciding whether the existing list's room can be reused. Unknown means no data admission and no notification-list write; the exception is caught inside tell so its caller's already saved post/comment is not rejected. Valid, duplicate/self-filtered and fully funded100-row behavior remains unchanged. No price/visible limit/flag/gate/config/author source/ref was changed by Z.

## Independent causal proof and quantities

SAME final graph/test/dependency source in both runs, substituting ONLY lib/community-notify.ts from44f4e252 for OLD. This is not a wholesale checkout of an older main, shimmed handler or modified assertion set.

- Author four permanent tests: OLD2FAIL/2healthy controls -> head4PASS. Its malformed-shape loop stops at the first assertion failure on OLD; this is TWO failing Node cases, not thirteen independent old failures.
- Own24 independent cases: OLD19FAIL/5controls -> head24PASS. Twenty malformed cases cover missing/extra slots, null/undefined, text/object/nested counts, negative/fractional/nonfinite/unsafe counts, holes/inherited/getter slots, frozen malformed and mixed two-recipient replies. The getter case already throws safely into the old catch and is a passing control, not a newly closed financial exploit.
- OLD empty/OK/object/undefined/NaN/infinite/unsafe/hole/frozen-malformed replies send ZADD+trim without TAKE, leave one row and zero bytes in the actual store-data hash. Example OK:323serialized JSON pipeline bytes,3nested MemoryRedis.run calls (including the observer read), paid0/total0; this is a confirmed list growth without its720-byte reservation. HEAD sends only the56-byte one-command ZCARD batch, no TAKE/ZADD/trim, list0/paid0/total0. The injected ZCARD response is not dispatched to MemoryRedis, so nested0 here does NOT mean its attempted read had zero cost.
- OLD mixed unknown/missing/hole sends TWO notification rows but reserves only720bytes (+64slot overhead),3511–3517serialized batch bytes. HEAD refuses both before TAKE/write. OLD extra reply unnecessarily reserves1440 for one row; HEAD refuses rather than accepting malformed overcount as a valid receipt.
- Healthy frozen[0] control: actual TAKE_DATA EVAL reserves720bytes and the hash total784 BEFORE real ZADD; the observer sees720 at dispatch. Exactly ZCARD,TAKE,ZADD,trim. Duplicate member/self/empty recipients filter to two real rows:1440slot/1504total before the write, with no charge for a third recipient.
- Full ring control is funded through100 actual tell calls, not seeded with uncharged rows. Next tell reuses72000 existing bytes (total72064), sends ZCARD,ZADD,trim without another TAKE and retains100rows. No limit changed. All-self/empty target control dispatches zero product commands.

Per-case JSON pipeline bytes include the actual TAKE_DATA script where sent; they exclude protocol framing/replies and are not provider invoices or complete request bills. Nested command totals include fixture/assertion and observer reads. No paid ledger/cost is inferred merely from test-global counters: own proof reads the real cm:nt/# hash changed by the real in-memory TAKE_DATA implementation and checks it before real ZADD. The missing-size injection leaves a paid-read ATTEMPT, not a free operation. No HTTP/provider was used.

## Linked validation and bounds

178 successful assertions/subtests across six roots, with overlap: author4 + independent24 + notice-erasure-evidence7 + community-reads-unknown110(custom harness) + plan-cost-registry26 + store-data-registry7. Whole-root nested command totals respectively33,491,303,558,0,0; all HTTP counters0. OLD author29 and own564nested remain separate and are not included as green claims. No cap reached, retries, skipped/cancelled tests or decomposition. data registry still owns nl:cm:@lib/community-notify.ts; both registries pass unchanged.

Before EACH SERIAL child:20,000nested MemoryRedis.run across all instances,100mock HTTP attempts,120seconds,512MiB V8 heap,256KiB captured output; types120seconds/1024MiB. Default fetch and socket connect denied BEFORE the graph. All semantic children completed before the next. Matching read-only dependency donor checked before use:454installed versions match lock,0mismatch,102missing optional platform entries,0required missing. Node24.22.1, Next16.4.5, TS5.9.3, esbuild0.28.2, ESLint9.39.5. No install, auxiliary paid transport, subprocess server or vendor account.

Strict scoped types cover lib/community-notify.ts, the author test and own proof with real tsconfig noEmit/incremental:false; types.log has roots/source count/target/strict/Bundler and zero unfiltered diagnostics. Focused lint0. Official scanner and subject/staged diff receipts are retained; final gates must pass before the evidence commit. Raw OLD/head/types/lint bytes are reversibly preserved in raw-logs.json (gzip/base64 and SHA256); visible logs only strip trailing whitespace.

## Scope limits and retained qualifications

Source inspection includes all four tell calls after post/comment creation in app/api/store/community/route.ts, TAKE_DATA/store-data admission and the exact repliesFor/countOf helpers. Redis Lua was modeled by existing MemoryRedis, not independently executed on redis-server. No production Stripe/SES/Redis/phone/web-push/provider traffic, route/session/withinLimit end-to-end, build/browser/accessibility/full suite or complete MR worst-month proof is certified.

As in C2's first review, the following list-write ACK remains unchecked: an unknown ACK can retain excess room after a write failure. That is the preexisting safe overcount, not a claim that an unconfirmed write succeeded. The preexisting phone path after the catch is unchanged and still runs if phone is supplied; no-phone proofs do NOT certify zero side effects for that optional path. Concurrent full-ring deletion/funding lifetime and arbitrary unbounded caller inputs are outside this small correction; no unproved exploit/new classification is manufactured here. Registry green is a consistency check, not a global zero-cost certificate.

## Reproduce

At the exact subject with only this own directory and recorded read-only support:

- `Z_OLD=44f4e252cf787afca1152a703ab82b59a104162e node docs/reviews/z-3288-second-review/runner.mjs community-notice-size.test.ts z-3288-notice-room.proof.ts`
- `node docs/reviews/z-3288-second-review/runner.mjs community-notice-size.test.ts z-3288-notice-room.proof.ts community-notice-erasure-evidence.test.ts community-reads-unknown.test.ts plan-cost-registry.test.ts store-data-registry.test.ts`
- `python3 docs/reviews/z-3288-second-review/checks.py`

GitHub evidence tree/report must be durable and read back exactly BEFORE the formal verdict. Review only, no sixth own product unit, author mutation, CI polling/retry/cancel, integration/push to a PR, queue or merge.
