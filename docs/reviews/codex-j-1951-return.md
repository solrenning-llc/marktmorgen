# Independent J return evidence for #1951

Reviewed product: fd95cf2c5e1249110abec28edb9ea29d8aec14a8. No product/ref/CI edits.

The ORIGINAL J proof 707ad0e8 / blob6c974937c471aafd0ec95fafabb2e63ccc7ed862 was copied without change. The partial-GET case passes503. The unacknowledged-write case no longer reaches its SET interceptor; later SET/DEL barriers no longer observe Lua effects, and the unchanged file reaches the existing120-second local runner bound (SIGTERM). It is not4/4 closed.

The author's explicitly adapted assistant-memory-route-evidence.test.ts was run unchanged on old0cae3e95:4tests/4failures, including held208/required464 and held0/required224. Exact final4/4. The adapter recognizes old SET/DEL or new MEMORY_WRITE/MEMORY_FORGET scripts and permits the documented busy refusal while retaining content/room assertions.

Exact G2 originals are preserved on this branch with credit, not claimed as new J authorship:
- review-g2-memory-boundaries.test.ts, originald429402a, blobbcf9e68ceb57b8ac9d8daa5a267b6b07833594f7:4tests/1control/3failures. Two causal residuals: unknown-kind row discarded by a successful write; expired old writer shrinks successor record's room to224 while528required. Third old case now fails in the concurrent-writer precondition (correctbusy under v2), not a reproduced old deletion window.
- review-g2-memory-forget-v2.test.ts, originala3b62572, bloba3827eae90116d7748d9fec1ad9c2d8b357e170c:2tests/1control/1causal failure after advancing only MemoryRedis11seconds; fresh record448bytes, held0. Immediate old window is closed, TTL-expiry quota return is not.

Existing tracked tests/locked-deletes.test.ts is the permanent proof of a separate missing-classification check:115checks/2failures, missing HELD assistant-memory and ACTIONS assistant-memory:add,edit,forget,remove. No auth bypass established. This file is unmodified and already present in the exact product tree.

Twelve normal groups176checks pass: route-evidence4, store-evidence8, route27, store57, rules28, agent-coverage13, data-registry7, closing-families4, closing-cost6, pricing-optimization7, pricing-usage-proposal7, margin-alignment8. The first selection used nonexistent pricing-usage.test.ts; not counted, correctpricing-usage-proposal then ran7/7. Strict directed module/route/imports/proofs types exit0, ESLint0errors/1inherited unusedGET warning in author adaptedproof, trackedscanner3629/0, diffcheck0. Untracked local reviewproofs outside scanner. No browser/nativeRedis/provider/model/globalTSC/build/fullCI claimed.

The two MEDIUM residuals consolidate G2 parent#1949 findings; do not count them twice. The new LOW is classification coverage, not a changed permission. Main-only/generated historical pricing differences were read and historical table tests passed; no real price or profitability approval.
