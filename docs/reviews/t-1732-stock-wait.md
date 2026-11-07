# PR #1732 — focal stock recount wait review

Reviewed 7 November 2026 by Codex T. Author request: channel C2 11:09 Fortaleza and comment 6707985871. Claim 6708002794 preceded source/diff/test inspection. Channel reservation c94103c1288f56dbd42bafab8d5723517aa1edfb preceded evidence code. Its first CAS failed; the successful retry followed more than 120 seconds and a fresh full-prefix read.

## Scope and verdict

Exact head: `cd9ccd48799057b4937c154a0f2d224fdd05ab84`.

Focal delta: `796026ca..cd9ccd48`, specifically Claude 5's remaining LEVE in comment 6697735462: repeated Stripe queries after the settling HDEL fails. **That LEVE is closed by independent execution at this head. No new HIGH, MEDIUM or LOW finding was demonstrated in this bounded focal review.** This is one independent focal opinion, not a second complete financial review of the historical PR or its stack. Credit for the earlier financial findings and their disposition stays with the earlier reviewers. Author/coordinator must establish applicable reviews and nine final exact-head gates before queueing; this review performs no queue/merge operation.

The corrective commit `ebfaea33a9811d6517f9edd645f59d41314cc9aa` changes only `lib/stock.ts` (five additions, one removal) after the author's 98-line permanent test was added. On a second refusal, the guard returns `busy` before starting the settling wave. It removes the now-dead `round > 0` condition below. This is conservative if stock genuinely sold out between rounds: the next click obtains a fresh count rather than presenting guessed availability.

`lib/stock.ts` was read through admission, release, recount and binding; the unchanged `onAccount` timeout path was inspected. Each GET uses `CHECK_MS=2000`, `MAX_CHECKS=5`; limited products settle in parallel. The guard prevents a second settling wave within the click. No actual two-second timing or real-provider latency experiment is claimed.

## Same permanent test: causal RED then GREEN

`tests/stock-recount-stripe-wait.test.ts` is byte-identical in durable RED `5fa71e30` and final head: blob `9a00568ffef139ac5fc4869fd3a1bc04df11e0c7`. No test assertion or fixture was changed by T.

The C5 original was a narrative/unpublished synthetic proof, so this is the author's permanent reproducer independently executed, **not the original C5 bytes**.

Runner: `scripts/t-review-1732.mjs`. Copy it onto the exact reviewed head before replay. It enforces that head, uses canonical `testAliases`/`testEnvironment`, and substitutes only the older stock module for RED; all other graph inputs remain the final head. Thus RED is an old-module-in-final-graph comparison, not an entire old checkout.

| Execution | Assertions | Result | Observed command budget |
| --- | --- | --- | --- |
| Same test, stock module from `796026ca` | 7 | 1 failure, 6 controls pass | 47 MemoryRedis.run, 15 mock fetches |
| Same test, exact final head | 7 | All pass | 46 MemoryRedis.run, 10 mock fetches |

The failing assertion was exactly `expected 5; got 10` Stripe GETs in the refused-settling-write case. Both executions returned `busy` and opened nothing. The successful-settling control opened on the first click with five GETs; the still-open-hold control returned sold out with zero GETs. The total mock counts in the table include the successful control's separate five GETs.

The RED log:

```text
The write that settles the lapsed holds is refused, reads still answer
  ok    the click is told to press again, never Sold out
  ok    nothing is opened
  FAIL  Stripe is asked about the lapsed holds once, never a second wave
        expected 5
        got      10
Controls: what is known decides as before
  ok    the settling write accepted: the first click opens
  ok    after one wave of Stripe checks
  ok    a unit held by a checkout still open: Sold out
  ok    and Stripe is not asked
7 checks, 1 failing.
```

## Linked regressions at the exact final head

Fifteen files passed: focal 7; cart-stock 50; stock-hold-write-confirmation 5; review-g2-cart-stock-races 16; lock-acknowledgment 7; stripe-read-ceiling 3; stock-reading 2; stock-availability-required 2; stock-expiry-confirmation 1; review-pf1-cross-lock 2; demo-store 84; plan-cost-registry 24; cart 20; cart-physical 28; checkout-recovery-journey 24. Total **275 assertions/checks (7 focal + 268 linked)**. This includes the unchanged 70-command cart-stock ceiling. It does not certify the whole financial model or registry assumptions merely because the registry suite passes.

Final-head suites were serial, isolated child processes. Their summed observations were 2593 MemoryRedis.run calls (including nested script dispatch/setup) and 112 mock fetches; adding the causal RED makes 2640/127. Guards apply **before each dispatch**, per child: 20000 Redis/100 mock fetches, 120 seconds, 512 MiB Node heap, 256 KiB captured output. No child hit its ceiling. Build graph rejects `lib/redis.ts`; fetch starts blocked, tests install local mocks, and native HTTP/HTTPS request/get entry points throw. No Redis/Stripe/SES/provider request or real payment was made. This measures harness commands, not provider billing.

## Integration and static checks

The final merge has parents `ebfaea33a9811d6517f9edd645f59d41314cc9aa` and `599cc66292ce6e97f2dcb1edd68c2a87979dd80a`. Native `git merge-tree --write-tree` independently produced exactly the final tree `67588aad47d35052ccec618218f10b64e322f291`. Stock, Stripe account and the new permanent test are unchanged by that merge. Stripe account blob is `294dca96f2a14d5a607cdc0711f01280466c9fe4` both before and after the focal interval.

The full historical interval includes 317 paths from main; those unrelated main changes are **not** 317 paths independently reviewed here. The focal corrective commit and permanent test were read completely, and linked tests use the actual final graph.

- TypeScript actual repository options: ES2017, strict, Bundler, noEmit; roots stock module and permanent test, 411-source closure, zero diagnostics, exit 0.
- ESLint module/test/own runner: exit 0, zero errors/warnings after removing one unused import in the own runner. Product files unchanged.
- Syntax check and whitespace check: exit 0.
- Official public-data scanner: full tracked head 4256 files, zero corrections. Own report/runner receive a separate directed scan before publication.
- Node v24.22.1. Installed and lock versions match: TypeScript5.9.3, esbuild0.28.2, ESLint9.39.5, eslint-config-next16.4.2. No dependency installation/configuration change.

Execution qualification: the scanner ignores `--help` and began its full scan; its completion briefly overlapped the TypeScript check before both explicit exit-0 receipts were collected. Tests themselves remained serial; no subagents were used. An initial package-version metadata lookup hit an exports restriction and was replaced by a direct package-file read, without installation or test replay.

Not certified: full historical money review, all 317 main paths, global TypeScript/build/client graph, browser/accessibility, hosted CI, queue composition, native Redis, real Stripe, production latency, global margin/cost sufficiency or deployment. No author source/ref/CI mutation or commercial setting change. No new product defect or price/limit/flag adjustment is proposed.
