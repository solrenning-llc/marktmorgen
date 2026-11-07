# J focal return: inbox erasure recovery (#3113)

Subject: **00248858bc0a6064b308a5e0e6987a91bd2ddd5f**, corrective delta from **3b6a5cd32d8dfbdff7425f026d8a8de48329fd3c**. Requested by author comment 6712772477. J original MEDIUM: review 5814674643. Date: 7 November 2026, 18:04 Fortaleza.

## Result

The conditional inherited MEDIUM is closed for this exact corrective subject: a failed deletion leaves the discovery index in place, and a healthy retry deletes the records and token. A lost deletion reply or failed index removal is also recovered. This is a focal confirmation, not a global erasure/privacy, production Redis, retention, delivery or financial certification. No additional severity finding demonstrated in this corrective delta.

The entire corrective diff was read: lib/inbox.ts and the new tests/r24-inbox-erase-order.test.ts. The records DEL is dispatched and its exact count checked before the separate index ZREM. Counts above the number of submitted keys/ids are refused. Only exactly-null conversation slots are pruned. Codex N's lease still covers these erasure/read/helper hunks; no request guard, gates, counters, fileContact or send/reply code changed. The known trim() batch ordering is outside these hunks and remains the author's separate rule-30 note, not closed by this focal.

## Frozen original and separate disposition

The frozen two-case J diagnostic remains byte-identical, SHA-256 7e70dd4f01434df1b39abc493aadd7ed09568dc84d4c7a68e268cc8d1e6c49b6. It produces 1 PASS/1 FAIL on both subjects. On 3b6a, the injected batch failure leaves retained=true and visitorStillReadable=true after retry=0. On 00248858, injected=0, first=1, retry=0, retained=false, visitorStillReadable=false: its hook only matches a combined DEL/ZREM batch, which no longer exists.

I acknowledge an additional limitation in my original oracle: it requires visitorStillReadable===partial as a historical observation, while later requiring retained===false. That visitor observation is incompatible with successful recovery in the partial case. The old failing trace still demonstrates the inherited defect, but the frozen diagnostic is not a universal GREEN oracle for a corrected implementation. It is preserved, not weakened or relabeled as passing. The author's explanation is accepted.

A separately named proof, tests/j-3113-return.proof.ts (SHA-256 16849ae639e97bea62ac0b9ecb0707020d420ec75d80e405d32bd2b22be7edb5), uses the same real fileContact/MemoryRedis Ana+Ben seeding and matches the DEL operation regardless of batch layout. The recovery disposition checks that after retry the visitor can no longer read, messages/token/conversation are gone and the index contains exactly Ben. Six scenarios: healthy; DEL failure before application; DEL applied with reply lost; ZREM failure before application; ZREM applied with reply lost; ZREM reply above submitted ids. This is a separate disposition plus additional recovery cases, not six new independent findings or the original two passing unchanged.

Same final proof, replacing ONLY lib/inbox.ts with 3b6a in the final graph: **6 cases, 3 FAIL -> 6 PASS**. In the focal DEL-failure case: old index loses Ana/retry=0/data and visitor readable; fixed index retains Ana/first throws/retry=1/data and token gone/visitor null. The fault is reached exactly once in both graphs. The phase before retry confirms that the data really remained after the injected DEL failure, not a vacuous healthy deletion. The independent author test's generic failure reproduces the same causal ordering and is valid for the new two-step implementation.

## Permanent and linked checks

| Check | 3b6a inbox in final graph | Exact 00248858 |
| --- | --- | --- |
| Frozen J diagnostic2 | 1 PASS / 1 FAIL | 1 PASS / 1 FAIL (hook/oracle limitation above) |
| Separate recovery6 | 3 PASS / 3 FAIL | 6 PASS |
| Author permanent erase-order7 | 5 PASS / 2 FAIL | 7 PASS |
| Original permanent inbox-exact16 | historical causal RED preserved, not replayed here | 16 PASS |
| inbox32 + inbox-checked6 | not replayed unchanged | 38 PASS |
| person-erasure32 + person-copy20 | not replayed old | 52 PASS |

**113 ordinary current checks PASS** (7+16+32+6+32+20); separate recovery6 overlaps and is not added as new unique coverage. Frozen2 is not included as GREEN. Author permanent7 SHA-256 6590750fce1db2c517bcac46be92d35f6dfe53c8ce3ca5c11912cf4e48d216ac is byte-identical to RED7dab5846af. Permanent16 SHA-256 07b7985de9752d02a88b7dba2951f0452074dcf4c8cd1649c39ba7bf8d7e0fcc is byte-identical to REDf2aa142121. No assertion in either permanent file was edited.

person-erasure ran the repository's broader synthetic fixtures, not the new DEL fault through whole erasePerson/HTTP. Two existing Blob SDK deletion attempts logged missing-credential errors and deferred cleanup; there was no provider request or claimed successful Blob deletion. Keep those stderr lines in the raw evidence. No production deletion was exercised.

## Bounds and verification

Every runtime child: 120 seconds, Node V8 heap512MiB, stdout/stderr maxBuffer256KiB; MemoryRedis.run incl nested/setup hard20,000 BEFORE dispatch; any assigned global fetch mock hard100 BEFORE dispatch. net/TLS/http/https blocked before graph load, with negative controls. Node24.22.1. No provider/real Redis/Stripe/SES/Blob/browser/AT/nativeLua/CI operations. These are V8 heap/output/time bounds, not a claim of a hard RSS/whole-process memory quota.

Observed run/mock: frozen old127/0, frozen current126/0; separate recovery old416/0/current428/0; permanent7 old441/0/current440/0; original16 current813/0; inbox388/10; checked0/0; person-erasure3332/2; person-copy152/0. No bound reached. The runtime status JSON captures all child exit codes (expected RED/frozen1, current valid tests0).

Directed actual repo TypeScript options: ES2017, strict, Bundler, five roots,879 loaded sources, imported types resolved,0 diagnostics and explicit exit0 at512MiB. Only root bodies are checked, not every dependency body or global tsc. Lint7paths exit0, zero errors, one unused-helper warning ONLY in the frozen original proof (preserved). Source diff check exit0. Official tracked scanner4324/0; final evidence scanner and staged diff results are recorded in the output. Explicit per-command statuses are preserved, not inferred from empty output.

## Replay and provenance

New source checkout: exact00248858, originalproof+new runner/types/derived copied before execution. Evidence branch retains its historical3b6a source base and prior J evidence unchanged. Before replay COPY scripts/j-3113-return.mjs, scripts/j-3113-return-types.mjs, tests/j-3113-return.proof.ts and the unchanged tests/j-3113-partial-erase.proof.ts into exact00248858; old3b6a Git object required. Runner accepts head or old-modules and a strict test allowlist, guards tracked product delta, uses canonical testAliases/testEnvironment and overlays ONLY old lib/inbox.ts for causal checks.

Reservation CXJ-20261107-1800-C4-1 accepted CAS1cb2193a88f562ddb7e0e65cac2e466e7605ebc6/blob b161836f54812aac2a3129fe59aa38956539f801 with FULL exact readback before source/code/tests. PR claim6712929405 preceded all source work. Earlier channel1757 attempt409 NOTPUBLISHED; retry waited>=120seconds from20:58UTC, FULL fresh/prefix+delta read. C1-1737 express author disposition observed, no productive grant to J. Direct recipients remain C4/C6; external coordination provenance conflict preserved. C1-1733/1746 new-PR pause observed; this focal has no product PR or CI push. Main fetched45bddafa; AGENTS/CLAUDE/inbox/queue/reservations unchanged from09dd. No source/author ref/CI/retry/cancel/product push/main integration/merge/enqueue/worker changed.
