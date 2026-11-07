# PR 3113 independent privacy review — Codex J

Subject3b6a5cd32d8dfbdff7425f026d8a8de48329fd3c, base09dd1ece44482e239e4d10bd690d9e46ab1e2fcc. Original correction confirmed; CONDITIONAL INHERITED MEDIUM PROPOSED for R2/coordinator reproduction/classification before repair or unconditional clearance.

## Residual partial deletion loses recovery discovery

lib/inbox.ts578–586 batches DEL of conversation/messages/token with ZREM of their index. Redis REST pipeline is not an atomic transaction; lib/redis.ts throws when any entry has an error, but later commands can already have run. The test seeds two REAL fileContact conversations through MemoryRedis. Only for the DEL+ZREM batch, it executes the REAL second ZREM, skips the failed DEL and throws. No synthetic success, retained JSON or token is forged. The first erasure throws, as desired. After restoring healthy storage, the next forgetInboxPerson reads the index without Ana, returns0 normally and leaves her original conversation/messages/token intact. Real visitorThread(token) still reads it; Ben remains indexed. The first failure is honest, but it cannot be reached on retry. Source caller person-erasure catches a thrown module as incomplete; a subsequent normal return is a completed module. Whole erasePerson HTTP/job not executed, no live server or actual erasure incident claimed.

SAME separate two-test proof SHA2567e70dd4f01434df1b39abc493aadd7ed09568dc84d4c7a68e268cc8d1e6c49b6: final1PASS/1FAIL, base module ONLY in final graph1PASS/1FAIL. Healthy control removes Ana/token and keeps Ben, retry0; partial first throws/indexlosesAna/retry0/retainedtrue/visitorStillReadabletrue. This is ONE conditional inherited class, not a new regression or multiple findings. R2/coordinator must execute the SAME proof/classify/dispose same PR or followup BEFORE repair. Do not automatically close by author report or relax the failed expectation. Preserve discovery until deletion confirmation, or an atomic/otherwise recoverable protocol; no product fix by J.

## Qualified correction and execution

Whole two-file diff read; leaseN1637 permits exactly added redis-reply imports, readInbox, forgetInboxPerson and helpers. No request guard/gates/counters/fileContact/send/reply hunk changed. Exact readers reject malformed index/slot shapes before unindexing; known null alone drops an expired index entry. Synthetic erasure reply-format failures reject as intended. Original16 SHA25607b7985de9752d02a88b7dba2951f0452074dcf4c8cd1649c39ba7bf8d7e0fcc BYTE-IDREDf2aa142121: old inbox module in FINALgraph16/15FAIL→current16PASS. Linked inbox32+inbox-checked6 PASS,54 ordinary current PASS. Own two-case residual is separate RED, not included in green total.

Runtime canonical aliases/environment with network blocked before graph (negative controls). 20,000 MemoryRedis.run including nested/setup and 100 assigned fetch calls BEFORE dispatch perchild, 120s/512MiB V8/256KiB logs. Counts: original16 old/head812run0HTTP; finalprobe old/head127run0HTTP; linkedinbox388run10mockHTTP; checked0/0. Zero real provider. Initial probe123run0HTTP did not yet read visitorThread; retained separately. Only the two probe modes rerun after adding that causal reachability observation, plus directed types/own lint; unchanged passing16/linked not rerun.

Actual tsconfig ES2017 strict/Bundler3roots877sources0diagnostics, explicitexit0 at512MiB, imported types resolved/dependency bodies not separately checked, not globalTSC. eslint five paths exit0/0errors/ONEunusedwithReplyFor warning in own frozen helper; finalownprobe lint same0/onewarning. Officialscanner4323tracked0, initial productdiff0. Finalstagedchecks and own-file scan recorded below when saved. No browser/AT/nativeRedisLua/liveChat/provider/CI/wholecopy/fullprivacy/MR certification. Caller person-erasure/person-copy and inbox route source inspected; public door not executed. Malformed kept JSON/retention/other unrelated erasure modules not globally cleared.

## Provenance

C6-1650 request. ChannelCXJ-20261107-1655-C4-1/CAS451a1425673ca199bf7160eb1d2616121c632ede/blob47593a35dc5d95f72e261c9e562cd9818282f16a FULL4218986exact andPR6712275178 BEFOREdiff/source/tests. Serial0agents. Only own evidence paths; authorref/source/CI/productpush/main/queue/merge untouched. Replay copy proof/runner/types to EXACTsubject; old09dd object required. No rerun unchanged head without a causal reason.

Final staged diff check exit0; official scanner4328tracked/0 corrections includes all five own evidence files. Original raw logs retained in /tmp.
