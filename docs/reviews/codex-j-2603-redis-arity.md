# Independent review of #2603 — Redis command arity

Exact head: ebd5f2727f28f859e7cf3092e3313d7f6b725b58.
Reviewer: Codex J. Before-work claim: 435ad190006aaedec02fe228aca287ecc7e93c5f.

## Decision

SEM GRAVE/MÉDIO / PODE ENTRAR after the nine final successful aggregates on the exact head and a fresh clean expected-head merge check. One inherited LOW simulator-coverage limitation is recorded below; it is not a production defect or a regression introduced by this guard.

I read the complete two-file diff, arity guard placement, relevant command handlers and pipeline implementation. Removing only the new guard makes every other byte of lib/redis-memory.ts identical to the parent. No script implementation changes. Minimum-length and HSET pair checks precede live(key), so incomplete commands cannot convert a prior string into another data structure. ZADD option scanning rejects incomplete option/pair tails before key access. This is scoped validation, not complete Redis behavioral equivalence.

## RED/GREEN and native oracle

The original author RED 4e511a5551b130fab0275bad47f8f9ecc3ab1bc5 was checked out and run unchanged with REDIS_ARITY_SERVER=/tmp/marktmorgen-redis-7.4.12/src/redis-server:
- RED: 28 tests, 26 causal failures, two passing controls, no skips. Native Redis confirms all 23 malformed vectors.
- Exact final: 28/28, no skips, including that same native oracle.
- Test blob is identical at both commits: 7f411165ba273ff2b7de881b480d92c7737697af.

Independent frozen proof [cbffc4f0](https://github.com/solrenning-llc/marktmorgen/blob/cbffc4f0a8fcf83237c824cf18eeccbac413c114/tests/j-review-2603-option-arity.test.ts) adds ten vectors for larger incomplete HSET pairs, mixed-case HMGET and incomplete CH/GT/LT/INCR/combined ZADD options. One Node test fails at its first missing-exception assertion on the original source; the unchanged test passes all ten vectors on the final source, checking exact native error wording and preserved existing/empty keys. This is one failing case, not ten separately reproduced RED cases.

A private pre-freeze prototype initially expected insertion order from keys(). That expectation was wrong: lines58–59 explicitly sort the keys. Correction was explained before editing in channel e21e1280; only the new prototype expectation was fixed to the established sorted contract. That prototype failure is excluded from product RED evidence. Frozen proof cbffc4f0 was subsequently run unchanged on original and final.

## Inherited LOW: two other variadic removals remain permissive

lib/redis-memory.ts:1062 (SREM) and :1123 (ZREM) still accept a key without members, whereas Redis7 rejects both with command-specific wrong-number errors. They are absent from the new minimum table at :103–105. This is the same test-double coverage pattern; I found no malformed production caller in this review and do not elevate it to a production or medium-severity finding. The current patch's nine-command improvement can merge without asserting all Redis arities are covered; V/C1 can assign a small subsequent extension.

Durable exact-source proof: [125642cd](https://github.com/solrenning-llc/marktmorgen/blob/125642cd7caf0f1779fddb8a9618113b3eaa25fd/tests/j-review-2603-remaining-arity.test.ts).
Both commands are queried against an owned real Redis7.4.12, then against MemoryRedis. On BOTH original and final sources: two Node tests, one valid-removal control passes, one aggregate parity assertion fails with both missing rejections. Thus this is explicitly inherited, remains RED, and is not counted among green checks. No product fix was made by the reviewer.

## Related checks and limits

Related verification: resend-fallback-budget9, shipment-mail-outbox38 custom checks, order-confirmation-checkpoint6, contract-funding57, order-data15 custom checks, reservation-check15 passing plus one explicit local-only skip. With original arity28 and independent option case1, this is 116 passing Node tests plus 53 passing custom checks, with the one local-only skip separately stated. The inherited LOW's two tests are separately 1 pass/1 fail and excluded.

Strict scoped TypeScript checks both author/new tests, the LOW proof and imported real MemoryRedis implementation: exit0. ESLint changed implementation/test and both J proofs: exit0. Public-data scanner via private index including both J proofs: 3705 files/0 corrections; real author index unchanged. Entire product diff and both proof diff checks: exit0. Ordinary repository test aliases/environment and assertions retained, with temporary output in /dev/shm because root storage is full. All owned native Redis children terminated in finally.

I did not repeat V's full1,169-file audit, full TypeScript/typegen, browser/client bundles or hosted CI. Their reported PHP ENOENT remains the author's explicitly disclosed baseline limitation; no full-suite-green certification is made here. No browser/provider/payment/account/deployment result. No author product/ref/reservation/CI alteration.
