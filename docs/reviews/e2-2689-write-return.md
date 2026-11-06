# E2 focal return: PR2689 write containment WIP

Reviewed WIP: bffede24fc6d4440bcf034bbe04e736bbf5c23ab.
PR2689 itself still has head481e26c64c0b3031645c85c8c46b7cd1bb8f71b2.
Complete two-path delta read. This is a focal return, not a replacement full review.

## Result

LOW residual: lib/stats-notes.ts:97-100 and addNote:137-145.
The new containment retains the first landed note when HLEN is1. This prevents growth when the retry also fails its post-write reading, but a retry after reading recovers successfully inserts a second identical note under a new random ID and returns success. The first operation's failure is still returned to the caller. The route app/api/store/notes/route.ts catches it and answers500; route behavior was inspected, not executed in this proof.

The actual addNote/readNotes functions with the author's MemoryRedis world reproduce:
1. HSET lands; HGETALL returns incomplete[]; addNote rejects; HLEN1.
2. Restore exact HGETALL replies; readNotes returns the first note, length1.
3. Retry the same day/text; addNote succeeds; final readNotes contains2 matching notes.
The intermediate read is observational only; it mutates no state.

Same unchanged independent proof: RED sourcec56bb18c and final WIP both4assertions/1failure+3controls. This is a residual inherited class, not a regression introduced by the corrective.
Do not solve it by globally deduplicating identical text/day, which can be legitimate separate user operations. An operation identity/reconciliation or truthful unconfirmed-result flow needs to distinguish retry from a new addition. I do not prescribe an unbounded new IO or alter the author's implementation.

## What is closed

Author's final test blob is unchanged from its RED:74checks/11causal failures on sourcec56bb18cbe3eaaf266c7b113eeeaf91ec72c508c,74/74 final. Repeated unavailable reads no longer grow an existing/malformed history; cleanup targets only this attempt's ID and exact HLEN/HDEL results.

The UI LOW in app/studio/page.tsx:1081 remains independently open and owned/coordinated by S/A3/C1. Earlier two MEDIUMs in review5792923067 remain closed by5793080643. No new grave/medium is claimed here; no blanket clean release.

## Reproduction and checks

Proof branch codex/e2-review-2689-write-return:
- tests/e2-2689-recovered-retry.proof.ts
- tests/e2-2689-return-run.mjs
- tests/e2-2689-return-tsconfig.json

Run final:
node tests/e2-2689-return-run.mjs stats-notes-read-evidence.test.ts e2-2689-recovered-retry.proof.ts

For RED source overlay only (test/world unchanged):
E2_STATS_SOURCE=/path/to/c56bb18c/lib/stats-notes.ts node tests/e2-2689-return-run.mjs stats-notes-read-evidence.test.ts e2-2689-recovered-retry.proof.ts

Linked stats-note-date, numbers-four, plan-cost-registry and store-data-registry pass; numbers-four64, store-data7. Focused strict tsc via the proof config passes with transitive imports. Focused ESLint passes. Scanner3807tracked/0, staged diff check clean. Initial guessed stats-notes.test.ts invocation was a missing-test BUILD error, not counted; initial standalone tsc lacked path mappings, corrected with explicit config, not counted green.

Synthetic in-memory Redis/transport only. No native Redis, actual browser, provider, CI, global build/typecheck, deployment or external delivery claim. No author product/branch/reservation/CI changed.
