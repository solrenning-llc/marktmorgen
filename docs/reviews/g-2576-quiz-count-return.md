# Codex G — #2576 quiz receipt return

Exact e0fb9be86d847103afae9fabb4cb672dd6777151, return from c9a4484c8cc86d2b8b75937b6487bfea5ac6959a requested6673715740. Entire corrective delta3files45+/5- read: quiz validator, original22-line G proof, runner. Previous two full G reviews5780743195/5789991573 read and retained, including contacts Q /blankInLists coordination limits.

## Previous MEDIUM closed

Original tests/g-2576-quiz-nested-replies.proof.ts at23f2e7658503453861c458edf952ca52cbcc472e, blob942b28dc2cdabb238dffda803f024ab61fb93166, byte-identical on both copies: c9 9checks/3failures -> e0 9/9. Values with holes/getters are refused without executing the getter; the pass is retained for a healthy retry. Confirmed absence still succeeds. plainList is now applied to every relevant inner array before every/reduce.

## MEDIUM residual — internally contradictory/unsafe count releases room for retained data

lib/quiz.ts:598–613 accepts any nonnegative Number.isInteger(gone), sums it as records, and releases the bytes declared by passed/values. It does not validate whether the atomic receipt's fields agree or whether its count is safe/possible for the requested keys.

Real markPassed writes one pass and accounts208bytes. One lesson requests exactly three keys: passed set, tries, result. Replace only SET_AND_VALUES_TAKE response, before applying it, by [[[lessonId],[null,null],gone]], where gone is0,2,99 or9007199254740992. A nonempty passed list proves its set existed; both scalar values are absent. The exact script reads them and calls DEL of those three keys in the same Redis turn, so the count for that content must be1. 99 exceeds even the number of requested keys; the last number is unsafe.

On both c9 and e0:
- exactly one intended injection, actual pass retained (SISMEMBER1);
- helper returns the supplied0/2/99/9007199254740992 without an UnknownReply;
- actual dataUsed falls208 ->0 although the pass is still stored;
- restored healthy transport deletes the actual pass on retry.

Frozen new proof tests/g2576-quiz-count-consistency.proof.ts@866e1228dd5675b505da1546fe67b82f2d13dc96:23checks/8causal failures on BOTH exact heads;15controls pass, including transport boundary, retained pass, healthy retry, known actual deletion, room release and true absence. Four vectors of ONE residual receipt-consistency family, not eight findings. It is inherited, not introduced by the plainList correction. No valid complete empty receipt is required to be refused: [[],[null,null],0] remains a passing control. This is not an undetectable demand to catch a provider lying with an otherwise consistent receipt; the injected values are internally impossible.

Require a safe count consistent with the passed-set/scalar contents and requested distinct keys before counting/remitting room. Unknown preserves the affected course's room and propagates incomplete. Preserve exact known absence and confirmed courses.

The new proof exercises forgetQuizPerson and real MemoryRedis/dataUsed directly; it does not newly run erasePerson for this quiz case or claim a full deletion journey. Original notes proof with actual erasePerson remains7/7 as linked.

## Validation and limits

Six linked files259/259: quiz-attempts28, quiz-record-evidence64, person-erasers-room37, room-give-back-races65, erasure-exact-replies58, original g-2576-unknown-erasure7. Original9proof separately as above.
Strict scoped TypeScript with quiz/exact/take imports+bothproofs0; ESLint changed product and bothproofs0; public-data scanner3759tracked/0; corrective diff-check0.
No complete global CI/build/browser/provider/real person/account, full margin or universal object validation certification. No product/reservation/foreign refs/CI/merge changes by G.

Native check limitation: Redis7.4.2 public source was cloned at a0a6f23d997b024689ba157916837f493a593a34 and compiled in an owned /tmp directory. The attempted isolated Redis server could not create a Unix socket: Operation not permitted, and exited. The parallel top-level build also failed to produce redis-cli; no native EVAL scenario ran. No alternate listener, permission escalation or bypass was attempted. The unexecuted native harness is not evidence and is not published as validated. Source inspection script_lua.c confirms RESP2 null-bulk ->Lua false and Lua false ->null, so the initial question about missing scalar positions is not a reported defect. Receipt-count inconsistency follows the actual repository Lua contract; its concrete JS/room effects are the executed MemoryRedis proof above.
