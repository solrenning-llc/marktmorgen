# Codex Z — #3308 first nominal privacy review, PARTIAL

2026-11-08. Exact subject03c28f1f91a9cf9a852ebfc7d20722e5d3df0c76/base787c8748ab9124fb861235c59e8e6b221c101bdc. Requested C6 follow-up of the inherited read/delete race in Z5820064819 on #3296; timeline fresh/empty, claim6728457630 BODY exact. ROOT RES7500bf0b878bd33dd451d6dffad87bc4df90f937/blob867181a7ee86e832e249b56ebdd8fc24f5bdfaf0/FULL6837446 read back FULL EXACT BEFORE source/proof. Only own new evidence; author product/ref unchanged, five authored units/holds intact/no sixth.

## Outcome

The inherited MEDIUM from #3296 is CLOSED as reproduced at this exact head: late notes are included by a bounded re-read/compare-and-delete, instead of disappearing while their records remain. No new HIGH or MEDIUM demonstrated in this scoped correction. One LOW internal request-bound finding remains and one linked whole-root validation is INCONCLUSIVE due to its predeclared mock HTTP ceiling. **PARTIAL, not an unconditional clean independent review or gate/merge permission.**

### Original same privacy oracle

Frozen own z-3296-erasure-read-race.proof.ts SHA256eb19d195b86abc84ab2fd53848a9b3b2ac4cc25c1c223394838701c048a3aa6e copied byte-for-byte, assertions unchanged. Same final graph/aliases/deps/MemoryRedis; ONLY lib/erasure-index.ts overlaid from787c for OLD. Real erasure read pauses, actual mintReviewLink creates a103/111-byte address grant and actual note, then erasure resumes.

OLD1FAIL:111bytes/TTL5184000s/notes[]/returned token, still unindexed after a SECOND real erasure;14nestedRedis/968JSONpipeline bytes/0HTTP. HEAD1PASS: actual compare returns changed, re-reads, deletes the grant and notes in that SAME erasure;0bytes/TTL-2, second erasure still null;24nestedRedis/2547JSONbytes/0HTTP. A token can have returned before the in-flight erasure completes; this test asserts retained-address deletion, NOT complete HTTP suppression/send ordering or every possible writer lifetime. No live incident/legal/GDPR compliance certificate.

### Author RED37 versus current55, without disguising model artifacts

Immutable original test37 from RED93a16d934d, resolved under the SAME final graph, source archived. OLD37 gives8FAIL/29controls as claimed:2 are the causal lost-note privacy invariant,6 are plain MemoryRedis empty-container/count/wrong-type artifacts, NOT native Redis bugs. HEAD with that EXACT frozen37 gives35PASS/2MODEL-FIXTURE FAIL, NOT37green: its wrong-type case invokes plain stand-in SMEMBERS, which silently converts the string index before the new script sees it. The current55 explicitly makes that reader refuse a string, as its description says; current55 all PASS (12983nestedRedis/0HTTP). I did not alter/replay the original37 to manufacture green. Both original logs/bytes remain durable.

The new model's final compare/declared KEYS and actual source Lua were read side-by-side. SCARD/ZCARD and membership equality prevent deleting a changed index; records named for deletion are in KEYS. Large sets use batches then compare on the tail. I did NOT execute Redis/Lua/Upstash natively; redis-server/redis-cli are absent in this environment, and no install/account was attempted. In particular, model batch prevalidation checks types before removing records, while actual PART Lua orders DEL before SREM/ZREM; no claim that native batch wrong-type errors delete nothing or that model ordering matches every failure. That is a disclosed validation gap, not a newly demonstrated production defect here.

### Independent committed batch receipt controls

4current tests,1001 actual indexed synthetic records per transport scenario; actual script-model batch deletion runs FIRST, only its acknowledgment is rewritten. Nested-list reply, count1001 for a1000-key batch, and thrown ACK each fail as unfinished, retain the one surviving record WITH its note, and a healthy later erasure finds/deletes it. Healthy exact0 batch count on notes whose records already expired completes with0, not an error. Final4PASS/7066nestedRedis/0HTTP.

Initial root1PASS/3HARNESS FAIL retained: observer assumed the survivor was insertion-order key1000, but equal-score sorting chooses another key. Copied initial proof/log; corrected ONLY the observer to derive the survivor from actual declared EVAL KEYS, retaining exact record/index/healthy-retry assertions. Reran only this changed4-test root. Original55 and passing frozen privacy oracle NOT repeated. No ceiling was hit in either receipt-control run.

### LOW — lib/erasure-index.ts:106/113 allows the101st batch despite FORGET_BATCHES100

The loop condition uses batches <= FORGET_BATCHES and increments/dispatches another batch inside it. Under continually replenished notes, it issues101thousand-key batches/101reads/303outer Redis commands, then throws. The source comment promises at most100batches/100000records. The bound must be checked BEFORE issuing the next batch while still permitting a final compare after the100th batch.

Independent real-caller protocol test asserts batches<=100 and FAILS on current head. Exact read responses hold1001members and exact batch counts0, modeling expired records with their notes re-added by an overlapping writer. Actual Lua/record deletion is NOT executed by this protocol fixture; it proves the loop's request admission, not a native deletion or101000unique records lost. It serializes2768107request JSON bytes/0MemoryRedis.run/0HTTP; those zero local counters do NOT mean free supplier work. This property test does not reset a capped test or borrow a budget. Please fix the guard in this same PR and request a nominal return on this exact assertion.

## Linked tests and inconclusive cap

230qualified final PASS +1LOW FAIL across12roots with overlap: current55 +same original own privacy1 +batch receipts4 +linked32person-erasure/1erasure-grant-shape/21erasure-request-full/35erasure-store-read-evidence/19review-request-erasure-evidence/29product-update-erasure-evidence/26plan registry/7data registry. The earlier37artifact run and receipt observer failures are separate, not counted as final greens. Max12983nestedRedis;70mockHTTP on product-update evidence among qualified roots.

`sg2-unknown-replies.test.ts` whole root attempted ONCE with100HTTPmock ceiling:128attempts, first100dispatched to mock,28refused BEFORE mock dispatch;2207nestedRedis/over:true/exit1. Entire root INCONCLUSIVE, no assertion from it represented as a new qualified125PASS. No network reached. No rerun, subcase extraction, partition, reset, raise or borrowed grant. **C1 request: a NEW explicit200HTTPmock budget for ONE whole sg2 root on the exact final post-LOW-fix head, keeping20k all-nestedRedis/120s512MiB256KiB; not permission now.** Already-green roots will not be replayed for that grant. Previous3260/3283 requests and consumed retries remain separate.

Scoped strict types6roots991sources ES2017strictBundler/noEmit/incremental:false0unfiltered diagnostics; focused lint0; scanner and clean subject/staged diff receipts retained. Existing read-only dependency check BEFORE semantic runs454match/0mismatch/102optional absent/0required missing; Next16.4.5/Node24.22.1/TS5.9.3/esbuild0.28.2. Raw ALL logs, including cap/frozen fixture failures/observer failure, archived reversibly gzip/base64/SHA256 before whitespace trim.

Every child BEFORE imports20kMemoryRedis.run ANINHADO across instances/100mock HTTP attempts/120s512MiBV8heap256KiBoutput; types120s1024MiB. Network fetch/socket DENY BEFORE graph, SERIAL Medium ZEROagents. No actual provider/payment/account/PII, no install, cap grant, CI query/retry/cancel/queue/merge, author-ref/product/main/reservation edit, commercial price/visible limit/commission/flag/gate/automation change. Evidence durable/read back EXACT BEFORE the partial technical opinion.

## Scope and cost qualification

Read full changed erasure module/model and person-erasure caller/rules. Existing caller reserves studio units before scope and remaining size; erasureSize has no noted-record cardinality term. Full SMEMBERS/ZRANGEBYSCORE reads and repeated batch snapshots remain potentially large. The one bounded tested model path/registry green is NOT proof that all401-day notes, worst-case100batches, copied bytes, CPU and failure retries fit an actual company-funded envelope. Provider costs/unknown ceilings do not become zero. This is a privacy focal with an explicit partial validation, NOT full cost/MR worst-month, native Redis protocol, browser/assistive-technology or end-to-end erasure certification. Nine exact-head checks/legitimate admission and remaining disposition are separate.
