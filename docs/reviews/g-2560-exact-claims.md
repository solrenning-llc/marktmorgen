# Independent review — #2560

Reviewer: Codex G. Exact source: eaaa2a65e084c961547bfb5f115c9535ac2b548e. Claim: channel commit 844a86bc90b724487891c776d5270ec029fdd30d, before diff/source/test work. Decision: **TWO MEDIUM findings, NOT MAY MERGE**.

Read the complete 19-path delta (2,565 additions, 149 deletions) from merge base ba310cc2c9021032f745d801c1e2fee989f19c16, including all eight new test files and removed implementation. Reviewed the ordinary readers called by the exact-reader/closing changes, the Redis client, store record removal, contact writer and official test aliases. No author branch, source, reservation or CI changed.

## M1 — unknown write receipts can lose the walk or falsely confirm erasure

lib/closed-store-data.ts:1109, with :383–388 and :1112; also :315–316, :796 and :1230–1236.

The new keep callback ignores the HSET result before removing the store record. Use the REAL claimHandle and upsertContact (valid free source; the actual Store supplied for data-room admission) to create a store and one personal contact. Suppress only the HSET of that store into nl:closed:batch and return [null] or [1,0]. The source record is deleted, the store is removed from nl:closed:due, no batch entry exists, HLEN of its contact hash is 1, and eraseClosed reports done:true / failed:0. A later healthy run leaves the same orphaned personal data and no retry. These are abnormal transport receipts, not a claim that Redis naturally returns them; the repository client maps such result envelopes without validating command cardinality. This is exactly the required unknown-response boundary.

A second vector suppresses only the DEL containing that genuine contact hash and returns [null]. The real walk reports finished:1 and the real closing state contains erased, while HLEN remains 1. DEL is inherited, now used by the altered completion flow; this review does not attribute its original introduction to this PR.

Unknown must not authorize source destruction, cursor advancement or completion. Confirm the durable entry before deleting its only discoverable source; keep recovery evidence for an applied-but-unacknowledged write, and do not finish an unconfirmed deletion. Validate exact supported receipts and reconcile uncertainty without guessing absence. This is one receipt/completion root, with the batch and final-delete effects demonstrated separately.

## M2 — the cached absence guard is not tied atomically to deletion

lib/closed-store-data.ts:453–463, :774–784, :791–803; same check-then-delete pattern at :710–728 is a static sibling candidate, not a separately reproduced index finding.

At the REAL refGuard GET, capture the genuine absent result. Before releasing that response to the old walk, use REAL claimHandle to open a new store under the same owner key. Seed its valid monthly order counter with string 5 under nl:orders:n:<storeFolder>:2026-11 and a distinguishable pause-key value. The new store exists and has a new sid. Release the old absent response. The old walk then deletes both keys and reports its old store finished. The explicit guard goal is to keep keys derived from the shared owner key for the new store; a once-per-run cached GET leaves a race until the later DEL.

The assertion about the order counter uses valid stored counter state, not a real paid order. The pause value is only a distinguishable marker; no complete pause/restart journey or money movement is claimed. Both are deleted in the same deterministic barrier scenario. Preserve operation/generation identity through the destructive action, atomically with the relevant owner condition or an equivalent shared fencing protocol; another unbound GET alone does not eliminate the race. Count any corrective commands before claiming cost coverage.

## Durable proof and validation

Own branch: codex/g-review-2560-exact-claims. Proof commit aca3d593a1781c7b821674be59490d2c205ec469; runner commit fff3025b43f00418e8c59d2db28bfd5de8b0e68e.

Run: node tests/g2560-run.mjs g2560-write-race.proof.ts

Result: **17 checks, 7 causal failures, 10 passing checks/controls**. Two batch vectors each fail immediate preservation and later recovery (4); unconfirmed DEL fails truthful completion (1); deterministic reopening loses two new-store keys (2). Genuine contact creation, precise injection hits, new-store identity and ordinary exact closure pass. Proof uses actual product logic through synthetic MemoryRedis; no product replacement or weakened expectation.

Causal previous-code RED: the SAME unchanged tests/review-sg2a-closed.test.ts from final source ran on own detached 0deaef36e copy: 6 checks / 3 failures (original store retained after declared erased, orphan sequence statistics, ended-subscription pagination never completes); exact reviewed source: 6/6. This is behavioral RED, not the original author's missing-export build failure. The eight final new groups pass 98/98. Twelve other linked groups pass 645/645 (596 custom checks, 49 node tests): closed-store, plan-closing, closing-plan-guard, closing-cost, closing-families, plan-margin, store-closing-fair, closing-plan-routes, review-reminder, sign-in-history-rules, stats-report, shipping. Total ordinary green: **743**, 0 failure/skip.

Scoped strict TypeScript including actual implementation imports and new proof: 0 diagnostics. Focused ESLint: 0 errors; two inherited unused-import warnings in lib/store.ts (MAX_JOIN_HEADING/MAX_JOIN_LINE), explicitly not reported as zero warnings. Own proof/runner lint: 0. Public-data scanner: 3,837 tracked files / 0 findings; own proof/runner scanned separately with the same findings function, 0. Source and own diff checks clean.

The first local proof attempt failed to bundle due to top-level await with the CJS runner; wrapping the body in async main fixed only execution wiring. Its input source was corrected from invalid form to supported free and the actual Store passed for room admission before freezing the proof. No assertion was weakened. The first successful 16-check exploratory version was expanded with the valid order-counter assertion to the final 17/7 version. Only final proof/results are authoritative.

No native Redis, real Upstash/Stripe/SES, provider account, browser, hosted journey, global build/verify or CI rerun was performed. The ordinary funding/margin tests passing do not certify real company margin or the unknown operational exposure described by this PR. Existing reservation collision with B2 and owner-policy decisions remain coordination matters.

Rule 30: ignored mutation acknowledgements also occur in the new pruning/moveToKept bookkeeping (:979–985, :1017–1021, :1201–1210); check-then-prune uses the same refFree observation (:710–728). These are static candidates for the author to inspect within the same module, not additional reproduced findings. Unchanged shared readers' malformed-input fallbacks are already acknowledged in the PR body and are not claimed as new discoveries.
