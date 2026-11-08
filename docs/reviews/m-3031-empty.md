# PR #3031: local empty-note correction and retained REDs

Codex M, 2026-11-08. Official head remains `385317bcc1bc329c990d0199b12e22aeab4e8617`; its CI was active. No product ref was changed. This work continues that exact product tree through the preserved local integration commit, not a recreated PR.

Claude 2's nominal return `6727830216` closes the original HIGH and reports a new LOW: SAVE_NOTE deletes the note before releasing its storage. The correction moves HDEL after a successful noteRoom result, with the same ordering in MemoryRedis. Unknown release preserves the exact note for retry. No command, counter, cap or policy was added. The separate per-student LOW remains with C1.

Claim `6728076416` preceded technique. Channel RES `4d5bc80b34903ca6f2d20697591a1298c8af315a`, blob `05ba1120b6ec60c55bc8ac2261090dea3807cb8f`, FULL6755990 was read back exactly before source/test edits. One rejected CAS wrote nothing; retry followed133 seconds and a fresh full-prefix/delta read. Main44f4e252, norms/inbox/reservations remain byte-identical to the previous canonical reading. No other agent's reservation or product boundary was changed.

## Actual RED and partial result

The new permanent test has38 checks. Before the repair, local test-only commit `4d7a780ad0` gave **38/21 failures**. Local WIP `1db48a568be51ccea5c975a04e58505157660cdd`, tree `bee1976dc539327d55ecbdfde11c75ad94993ee4`, gives **38/15 failures**, not a green suite. No assertion or vector was removed or weakened. Both real logs and frozen source are archived. Local commit IDs are not claimed as remote-fetchable refs; the complete evidence and patch are published on the existing checkpoint branch.

For the original nonnumeric total `garbage`, all9 runtime checks now pass: the failed emptying preserves the exact note, slot and notes count; restoring the total lets the same request retry and free the slot/count; repeated emptying stays safe. Both Lua-source ordering guards now pass. These account for the six failures corrected by the patch. Runtime uses the real saveNote/readNote functions with MemoryRedis; the Lua body was inspected and checked statically, not executed natively by M.

**Fifteen amplified failures remain**, five each for totals `-1`, `1.5`, and empty text. Those are separate from the original nonnumeric-release ordering case. The existing shared TAKE_DATA in lib/store-data.ts:62 accepts tonumber values and clamps negative totals at:88; MemoryRedis.storeData at:1862 accepts Number values, including empty text as0. Thus those cases still answer saved rather than unknown, delete the note and make the original-value retry fail. The empty-text difference between Number and Lua tonumber is a source-based inference, not an independent native-Lua reproduction. These15 assertions are intentionally retained; they are not15 distinct classified product defects.

C1 must classify/dispose of those shared-total semantics and assign the shared producer/model change if required; M has not expanded this local fix into lib/store-data.ts or altered any other consumer. Related source-only rule30 observation: FORGET_NOTES in the same lesson-note module also deletes its hash before calling noteRoom. That erasure path was not independently reproduced or changed here, and is not represented as closed. The existing notes-count-invalid emptying contract remains unchanged.

## Bounded validation

Five linked files pass: sq1-lesson-notes85, sq1-lesson-notes-review76, sq1-lesson-notes-room42, store-data33 and redis-memory-arity27 plus1 explicit native-Redis skip: **263 passing observations with overlap**, separate from the new test's23 passes/15 failures. Actual semantic types:3 roots/829 sources/272 pins,0 diagnostics and0 filtered. Scoped lint0, public-data scanner4652/0, own whitespace0.

Before each runtime child:120s/512MiB/256KiB,20k nested Redis/20k pipeline/100 admitted mock HTTP, network denied before imports and persistent exceeded flag. Max4887 nested/1241 pipeline/0 mock HTTP; no cap reached/increased/reset. Types120s1024MiB, lint120s512MiB, scanner60s. Same read-only dependencies as the previously verified Next16.4.5 lock of this tree; no install/provider/native Redis/browser/fullbuild/global financial certification. Old closing-plan100mock inconclusive run and Studio lint768MiB OOM were not repeated, raised or relabeled green.

The official head remains untouched pending CI and the disposition above. This is WIP evidence, not a clean focal request or queue clearance. C2 can inspect the limited ordering repair; a new full-green claim requires resolving or explicitly disposing of the retained vectors, applicable independent return and exact final checks.
