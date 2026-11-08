# PR 3215: bounded verification decomposition

Subject: `f78f7e2c1f831b272c9f1dcd7baf23d4e7f5a7c2` (fresh GET: open, unmerged).
Reviewer: Codex S. Continuation of PARTIAL comment 6724566096, not a new independent financial review.
Reservation: channel commit `81d29342f7b89ff363298884177615f827669809`, read back exactly before generation or execution; PR claim 6727824099.

## Result

**22 original assertions passed in eight independent scenarios; five original assertions remain unexecuted by S under the original ceiling. This is PARTIAL, not a clean full-suite verdict.**

C4-1725 authorized decomposition retaining every oracle and rejected a 1,000-mock ceiling. The manifest retains both complete original source files, Git blob IDs, SHA-256 identities, all 27 assertion expressions byte for byte in original order, their scenario mapping, and the five unexecuted expressions. The generator rejects missing, reordered or modified assertion expressions. Fixture sizes (600 active memberships, 150 past-due memberships, 5,050 trials) are unchanged.

| Original source | Executed original assertions | Not dispatched |
| --- | ---: | ---: |
| dunning-cursor-after-send.test.ts | 13 | 2 |
| billing-reminder-marks.test.ts | 9 | 3 |
| Total | 22 | 5 |

Every selected scenario already begins with its original Redis clear/reset and creates its own unique fixture identities. Dunning's original threeStores declaration is copied unchanged into each derived main. Billing's selected scenarios explicitly initialize the lists and email behavior they use; earlier scenarios leave no required state. Shared unused fixture helpers/imports are referenced with `void` only to satisfy lint; no helper is called by those references. All assertions, their values, scenario bodies, fixture sizes and production code are unchanged. Initial lint warnings and all intermediate passing execution logs are retained. Only roots changed to add these inert references were repeated. No historical capped whole suite was repeated.

Each semantic child admits 20,000 nested MemoryRedis.run calls, 100 mock HTTP attempts, 120 seconds, 512 MiB heap and 256 KiB output before execution. Fetch and sockets deny external network before the test graph executes. The guard counts before forwarding, including nested Redis calls. Final maxima: 541 nested Redis calls and 22 mock HTTP attempts/forwarded calls, in separate children. No cap fired; no counter reset, increase or borrowed grant. Types admit 120 seconds/1,024 MiB; static logs record their own limits.

## Remaining five assertions

1. Dunning's original 150-member scenario asserts that **one** recoverFailedPayments invocation updated 100 distinct subscriptions, then that the next invocation reaches the other 50. The unchanged fixture calls POST /subscriptions/:id and the email mock for each newly handled subscription (payment-recovery.ts:303-348); reaching 100 on that first invocation therefore requires at least 200 mock dispatches, plus listing requests. Splitting this invocation, reducing the fixture or suppressing a dispatch would change the original contract. This is a source-derived lower bound, not a newly executed capped result. Both assertions remain unexecuted here.
2. Billing's original 5,050-trial scenario includes three successive calls sharing its cursor and marks, asserting 5,000/50/5,000 inspected entries and no duplicate email. The literal scenario exceeds 100 cumulative mock dispatches. A correct persisted multi-process checkpoint design has not been implemented or verified. All three assertions remain unexecuted here; no fresh process with cleared fixture state is presented as the original sequence.

C1/C4 disposition is still needed for these five S coverage gaps: credit the independent C2 full-suite verification/required CI or prescribe an approved state-preserving bounded plan. No larger ceiling is requested or assumed.

## Prior evidence and independent peer evidence

S's durable cursor focal `b8c17be026efab114d3c8307bfe8075d606ebc78` remains authoritative for the existing 16 own and 39 linked passing checks. Its historical whole-suite cap results remain INCONCLUSIVE, not ordinary product failures and not newly rerun REDs. The original RED/corrective lineage remains there unchanged.

Claude 2's independent focal 6727465571 reports both HIGH findings closed and full dunning 15 / billing 12 passing on this subject. Those are **C2's executions**, not S's. C2 retains a LOW: after an initially unreadable first member, a later run may reach it in run four instead of run two because of the anti-pinning rule; no demonstrated loss or duplicate. This document does not silently close that LOW.

The previous S focal closes the two demonstrated HIGH vectors in its scope. This decomposition adds coverage, does not reopen them and does not claim another financial review, a whole-suite GREEN, nine current CI checks, queue admission or merge authorization.

## Reproduction and boundaries

Run `node proofs/s/3215-decomp/generate.mjs`, then invoke `run.mjs` once per scheduled manifest file, serially under the stated admission. `checks.mjs` records types, lint, scanner and diff checks. Dependencies were read-only: 454 installed packages matched the subject lock; zero required missing/version mismatches; Node 24.22.1, Next 16.4.5, TypeScript 5.9.3, esbuild 0.28.2, ESLint 9.39.5; no install.

Only new S proof/test/report paths were written. No author product, test, branch or PR head was changed. No providers, actual emails/payments, CI retry/cancel, queue, merge, commercial values, flags, reservation documents, personal data or automation changes.
