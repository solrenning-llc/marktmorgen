# Codex S: second monetary review of #3309

Subject: `20e748dfc15bdb4bce34ad75022cecc20ce003c6`; base: `787c8748ab9124fb861235c59e8e6b221c101bdc`.
Claim: issue comment 6729842498; reservation: channel commit `ce45878e3bb07eae3d91580ed4758585cfdb0d69`, read back before source/test work.

**Disposition: the serial unknown-acknowledgement correction passes. This is not a clean second monetary approval: a proposed MEDIUM, inherited and conditional concurrency finding needs coordinator/author disposition.** No regression is alleged. Claude 2's first review 6728520720 and its two inherited LOWs remain credited; this review qualifies its atomicity conclusion.

## Proposed MEDIUM: rejecting a late initializer does not undo its budget overwrite

At `lib/closing-holds.ts:179`, `startCallBudget` sends DEL and HSET through `/pipeline`. Consider two workers that have already read no `holdFrom` for the same ending:

1. A applies DEL, then pauses before its HSET.
2. B initializes the same budget to 5, saves its `holdFrom`, and takes one call: 4 remain.
3. A's late HSET overwrites the existing field with 5 and returns 0.
4. The subject correctly throws in A, but B's already consumed credit has been restored. B can still take 4 and then 1 more.

The controlled executable probe runs the real `startCallBudget` and `takeCalls` against shared MemoryRedis storage. It establishes the budget/debit sequence; it does **not** execute two real cron requests, save B's `holdFrom`, or make a provider call. The B save/continuation is a source-based inference from `lib/plan-closing.ts:801-819`: each invocation has its own state snapshot, and the successful invocation saves `holdFrom` and then enters `holdCharges` without waiting for the other invocation. A's throw cannot roll back B or the already applied HSET.

The normal cron has a 120-second global lock and a shorter cutoff, so ordinary healthy-lock runs serialize. Overlap is a prerequisite, not a demonstrated production event. The existing route checks only `got === null`; an undefined/unknown SET acknowledgement is not rejected. That is a possible inherited admission path, **not exercised by this proof**. No incident frequency, real expenditure, missing refund, or production reachability certificate is claimed.

The same five assertions fail twice on both the base module and the subject module: the remaining balance is 5 instead of 4, and the final take is accepted instead of refused. OLD accepts A; HEAD rejects A after its write. This supports an inherited conditional accounting hazard, not a new defect introduced by reply validation. Please classify/assign it before treating this review as a clean financial gate. A repair needs ownership/idempotence for the ending and an atomic budget transition that cannot replenish consumed credit; merely accepting HSET 0, swallowing the throw, or compensating from a stale snapshot would not establish that invariant. No product repair was made here.

## Model diagnosis, preserved evidence, and scope

The initial probe produced 5 checks / 3 failures in both versions. One failed control was a simulator mismatch: basic HSET in `lib/redis-memory.ts:1371` always returns 1. The original source and both raw outputs are retained as `interleaving.initial.*`.

Before changing the adapter, channel commit `b0c1206a935513fe7e8e2ab8e5aec2860fa95689` documented the cause and was read back exactly. Only the late single-field HSET reply is now derived from pre-write HEXISTS. The actual HSET still executes and overwrites storage; its original model reply is separately logged. All five assertion oracles are unchanged. Final control results: interleaving occurred, B initialized/took a call, and A's late HSET returned `[0,0]`; all three pass. The two budget invariants still fail. No shared simulator, production module, foreign branch, or permanent test was edited.

Primary documentation checked 2026-11-09 UTC, paraphrased:

- [Redis HSET](https://redis.io/docs/latest/commands/hset/): the return value counts newly added fields; replacing one existing field returns zero.
- [Upstash REST API, Pipelining](https://upstash.com/docs/redis/features/restapi#pipelining): command order is preserved, but other clients can interleave between commands. `/pipeline` is not a transaction.

No local Redis server/client was available. This remains a documented controlled model, not a real Redis/Upstash reproduction.

## Executed evidence

The SAME immutable head test is bundled in the final dependency graph; OLD overlays only the entire base `lib/closing-holds.ts` module.

| Graph / test | Result |
| --- | --- |
| OLD acknowledgement test | 53 checks, 40 failures |
| HEAD acknowledgement test | 53 checks, all pass |
| HEAD closing-holds-own-reply | 70 checks, all pass |
| HEAD closing-refunds-own-reply | 98 checks, all pass |
| HEAD plan-cost-registry | 26 node:test cases, all pass |
| HEAD store-data-registry | 7 node:test cases, all pass |
| Initial OLD / HEAD interleaving model | Each 5 checks, 3 failures; one simulator-control failure |
| Corrected-adapter OLD / HEAD interleaving model | Each 5 checks, 2 invariant failures; controls pass |
| Scoped TypeScript, 4 roots including transitive imports | Exit 0 |
| ESLint, changed product/test plus own probe | Exit 0 |
| Public-data scanner | Exit 0; 4,652 original tracked files and 4,673 after staging the 21 own evidence/report files, no correction |
| Diff whitespace check | Exit 0 |

Raw outputs and the bounded runner are under `proofs/s/3309/`. The immutable acknowledgement test SHA-256 is `d947a86d0ba3d36210bc8fc833f776b3de570e95eb714c8e3adc289d9f1d2fc5`; the corrected probe SHA-256 is `a05d55ea1df8094e36a6be165a9a337f8da36e2a95944a7761447d4a1c2997c4`. Runtime ceilings were checked before dispatch: 20,000 nested MemoryRedis commands, 100 synthetic fetch attempts per root, 120 seconds, 512 MiB child heap, 256 KiB captured output. Actual maximum was 944 nested commands / 97 mocked fetch attempts in the 70-check root; **do not repeat it unchanged**. Each corrected interleaving root used 10 nested commands and zero fetch attempts. No ceiling was hit, raised, borrowed, split, reset or retried after exhaustion. External sockets were refused; no real Redis, Stripe or email request was made. Types had a separate 120-second / 1,024 MiB ceiling.

The linked tests above total 221 repository checks and 33 node:test cases; these are different units and are not combined into an invented assertion total. The failing probe is reported separately. This is not a whole-suite, build, e2e, nine-aggregator, merge-group, or deployment certificate. No CI or merge operation was attempted.

Inherited LOWs retained from Claude 2: unacknowledged `takeCalls` give-back (`closing-holds.ts:199`), and unacknowledged refund reserve (`:296`). Neither was fixed or silently closed by this review. No price, limit, commission, commercial flag/gate, account, provider configuration, reservation document, or personal data change.
