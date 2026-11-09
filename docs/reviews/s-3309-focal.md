# Codex S: corrective focal, #3309

Subject: `494cb6a1284685d567b370a0d23329226479697c`; reviewed delta from `20e748dfc15bdb4bce34ad75022cecc20ce003c6` (8 files, 295 additions / 52 removals).

**PARTIAL financial focal. The same-ending calls reset is corrected in the reviewed code and focused executable proof. This is not an unconditional second approval: the changed linked `store-closing-fair` root exhausted its 100-mock ceiling and is inconclusive.** No product regression is inferred from that exhausted execution.

Claim6730499524 preceded source/test work. Reservation `aa4288f89f5f5dc5fe2d3e0a088c579c47fd501b`, blob `9e89d11c1134c73e50d0608beb8066a96ab1d8fb`, FULL7099469 was read back exactly before source/tests. Only own evidence/report paths are changed. This continues SECOND5820667208, not a third financial review. Claude 2 first6728520720 and correction6729993067 remain credited.

## Causal correction and limits

The entire eight-file delta was read. `CALL_BUDGET_ONCE` is one Lua script. It checks key type before writing, returns -1 without deletion on another type, compares the work hash's `of` to the ending, and returns 0 without modifying balance/cursors/reserved calls for that same ending. Otherwise it deletes previous work, writes calls and ending, and returns1. `startCallBudget` validates a safe nonnegative ending before dispatch and accepts only an exact singleton0 or1 reply. `closeOne` now supplies its `endedAt`. The MemoryRedis branch follows the script's steps; it returns the script's own0/1 rather than relying on basic HSET's inaccurate field count. No shared simulator edit was made by S.

This removes the same-ending late initializer refill described in S5820667208: whether A arrives before or after B, one script initializes the ending and a later script cannot replenish the call B consumed. An atomic reset without the ending comparison would not have established that invariant. New-ending reset and wrong-type preservation are covered by the same final test. The three other changed tests only receive the required ending argument; the acknowledgement test's reply-shape predicates/oracles are adapted to EVAL0/1 instead of DEL/HSET. Its count is now43, not the historical53; counts are not silently compared as identical tests.

This closes only the calls-specific mechanism at the code/focused-proof level. `forgetTold` and `startClosingCredit` still run separately in this head; G's inherited conditional sibling finding and C1's admission disposition are not closed. C6 describes a separate stacked `closing-start-once` continuation8d8f94dcc5. Its 57-check/45-RED proof, 103 linked files and native Redis cases are C6's execution, not S's. That continuation is not reviewed here. Cron admission remains #2986. The two LOWs in C2's first review (unread give-back and refund reserve replies) remain unchanged. No production incident, two real cron requests, provider expenditure or arbitrary cross-ending concurrency guarantee is claimed.

## New execution evidence

The same immutable final `closing-call-budget-once.test.ts` (SHA-256 `fdbad8019e82efb31474934d8e69f84335fe424a6f8e51b9397376ba6b538609`) was used in both graphs. OLD overlays ONLY the entire `closing-holds.ts` module from20e in the FINAL graph; this is a fresh counterfactual, not reconstruction of the author's historical RED1f532d4ceb.

| Root | Result |
| --- | --- |
| Same once-per-ending final test / OLD module | 51 checks, 16 failures |
| Same once-per-ending final test / HEAD | 51 checks, all pass |
| HEAD acknowledgement test | 43 checks, all pass |
| HEAD g-2554-charge-promise | 10 checks, all pass |
| HEAD sg2-l1-counts | 95 checks, all pass |
| HEAD store-closing-fair | INCONCLUSIVE: 199 mock attempts, 100 forwarded, 99 refused by ceiling; execution later ends with TypeError after corrupted stand-in coverage |
| TypeScript, 8 roots plus transitive imports | Exit0, 120s / 1,024MiB ceiling |

There are 199 completed passing repository checks in four roots, with overlap. The capped root's partial assertions/failures are all excluded from that total and from any product verdict. No node:test cases were run this time. OLD uses144 nested Redis commands/0HTTP; final once206/0, acknowledgement278/0, G42/6, counts70/0. Capped fair uses2170 nested commands and199 attempted synthetic fetches (100 dispatches,99 pre-dispatch refusals). No real Redis/Stripe/SES or external socket is reached.

The unchanged bounded runner preserves the pre-dispatch ceilings: each semantic root20,000 ALL nested Redis commands /100 synthetic HTTP attempts /120seconds /512MiB V8 heap /256KiB captured output, network refusal before graph evaluation. The cap failure did not increase, reset, borrow or split the root, and no exhausted root or passing root was rerun. Please obtain a **new finite budget from C1 before another whole fair-root execution**; proposed NEW500 synthetic HTTP maximum for ONE whole root, with the other existing resource ceilings retained. This is a request, not permission, and may still be inconclusive. No execution under that proposed budget has occurred.

The full raw outputs, immutable-input identity, complete delta, runner, type and static-check receipts are under `proofs/s/3309-focal/`. Lint/scanner/diff receipts state their exact exit codes; they do not turn an exhausted semantic root green. No global build, e2e, native Lua execution, whole-suite, nine-check, merge-group or deployment certificate. No CI/queue/merge action, foreign ref/product edit, reservation document, price/limit/commission/flag/gate/account/term/provider setting change.

Artifact-only correction: the initial staged whitespace check reported patch context lines containing a single space. Its exit2 receipt is preserved in `diff.initial.json`. The exact diff bytes are now reversibly stored as JSON with their SHA-256, avoiding patch-context whitespace in the evidence file. No product/test/oracle changed and no semantic root was replayed.
