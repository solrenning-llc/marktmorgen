> **SUPERSEDING ADDENDUM — 9 November 2026, after the initial opinion. NOT READY TO MERGE.**
>
> After publishing the initial bounded review 5821692430, Z read the new ROOT messages and C2's first financial review 6732247045. C2 identified that prevention can block a dispute without refunding the payment; C6 accepted this and announced the corrective work at ROOT 01:31. This is C2's finding, not an independently reproduced new Z finding. The initial policy-limited opinion MUST NOT count as a clean financial approval of this head, or of #3318's same prevented-as-returned assumption. Keep both pending the actual corrective delta and focal review.
>
> Z then independently opened the official [2025-08-27 Basil changelog](https://docs.stripe.com/changelog/basil/2025-08-27/add-preventions-to-dispute), [prevention guide](https://docs.stripe.com/disputes/get-started/prevention), and [versioned dispute object](https://docs.stripe.com/api/disputes/object?api-version=2025-08-27.basil), on 9 November 2026 UTC. The changelog distinguishes block from resolution; the guide separates network blocking through CE 3.0 from refund-based resolution and states RDR excludes already-refunded transactions. Thus the earlier enum-only evidence was insufficient to support an unconditional returned-money interpretation. The versioned object documents that balance transactions record withdrawals and reinstatements. Nested case-type expansion was unavailable through the reader (the first unexpanded page collapsed it; the explicit .md expansion failed); exact field wording in C2's review remains attributed to C2, not falsely claimed as Z's own retrieval.
>
> Existing Z runtime results below remain valid ONLY for the synthetic assumptions tested. They do not establish correct block/resolution classification. No new runtime or capped-root replay was performed on receiving the peer finding. Z does not duplicate C6's correction, change a provider version/flag, or claim to have verified the proposed balance-transaction helper. No live incident is asserted. The conditional refund/dispute double-count observation remains separate from the confirmed need to distinguish prevention modes.
>
> Original immutable report and raw evidence remain at e7f83a78b90fa93c921ed4977a7cee7027f08142. This addendum supersedes any broader interpretation of its verdict; all logs, initial harness correction, heads and budget history are retained.

# Codex Z — SECOND independent money review of #3321

Subject: `7a21f016143c736242c4fa38499c6bd2a2bdee0f`; parent RED: `f235f3bdbb8505b1a14e616f169b120b9830cd58`.

Verdict: **no new proven implementation finding within the existing prevented-as-returned policy**. This is a bounded technical opinion, not independent proof that every Stripe prevention mode moves funds this way or that a particular API version can return that state. The documented source/composition limits below remain explicit. No merge, queue, CI query, retry, provider call, financial-policy change, or author file/ref write was performed.

## Reservation and independence

Claim 6732119897, SECOND-role clarification 6732156909; C6 retained C2 FIRST/Z SECOND. C6 relayed Z's exact reservation at ROOT 01:25 after request 6732195228. Before any subject source/diff/native fetch/worktree/test, FULL 7,311,932-character ROOT readback matched immutable tip `92a2d541f7ee266f10c55c508e39954a6b644da9`, blob `196102299c1b88273e91dd5b108a6589c8abc340` at 04:27:27 UTC. Own legacy folder/branch name says first-review; the actual assignment and this opinion are SECOND. No C2 technical verdict was consulted in preparing this review. Only new files in this evidence directory are authored by Z.

## RED and bounded execution

Same FINAL test graph/oracles in both versions, substituting ONLY `lib/retained-revenue.ts` and `lib/share-settle.ts` with parent contents for OLD. No test stripping, cap partition, larger ceiling, or historical capped-root replay.

- Corrected independent whole eight-case root: OLD 4 pass/4 fail, HEAD 8 pass/0 fail. One case is explicitly an observational composition probe, not a normative behavior claim. OLD 30 mock HTTP/0 nested Redis; HEAD 38/0.
- Unchanged author permanent five node:test cases: OLD 1 pass/4 fail, HEAD 5 pass. OLD 17 mock HTTP/0 nested Redis; HEAD 20/0. The permanent test blob is identical between parent RED and head (source-snapshots.json).
- `retained-revenue.test.ts`: 33 repository checks pass, 308 ALL nested Redis run calls/17 mock HTTP. `share-lost-dispute.test.ts`: four node:test cases pass, 0 Redis/48 mock HTTP. These are separate complete bounded roots; 33 repository checks and 17 final node:test cases use different counting units and are not added as equivalent tests. The eight own cases include one observational case.
- Initial own harness logs are retained. It incorrectly indexed a channel omitted when net is zero; the repaired assertion checks the unchanged zero-net requirement by summing presented channels. Referral credit spelling was corrected from invalid `link` to existing `click`. Only this complete eight-case root was rerun OLD/HEAD. No ceiling was exhausted, reset, or raised. Initial HEAD own 7/8 is not claimed as passing. `harness-correction.json` records both hashes.
- Every semantic child: 20,000 ALL nested `MemoryRedis.run` cap and 100 mock HTTP attempts checked before dispatch; 120 seconds, 512 MiB V8 heap, 256 KiB output. All children remained below ceilings. Real fetch and sockets denied before graph; compiler/lint also preloaded network denial. No install, live Stripe, Redis, or paid service access.
- The declared 170 linked tests were not executed by Z. Larger expanded-evidence/report roots were not admitted or split. No prior budget grant was borrowed.

## What was checked

The actual stats dispute reader feeds the retained-revenue arithmetic, and the actual affiliate dispute reader feeds `settleLine`: an independent synthetic 10,000-cent prevented outcome changes retained revenue and earned commission from retained to zero. Won/inquiry/unknown/case variants/legacy behavior remains bounded by existing reader policy; no new unknown-is-zero permission is introduced by this delta (existing unknown-status behavior in those readers is outside this opinion).

`settleFee` on prevented uses the existing difference calculation, account-bound/charge-bound/currency-bound pinned reads, matching fee refund receipt, and same `share-back:<fee>:<refunded>:<difference>` key as lost. A fee confirmed fully refunded performs no further reads or writes. Two repeat requests use the same key; an unconfirmed foreign refund receipt rejects and retries the same difference/key. Synthetic requests do not prove a real provider enforces exactly-once effects. Partial/foreign/duplicate/unknown dispute evidence and unknown charge amounts/currency cause no refund POST. Linked lost-dispute controls retain their behavior.

## Source and composition limitations

`primary-provenance.json` reuses independently fetched immutable official stripe-node source evidence from Z's completed #3318 review: current enum contains prevented; legacy charge_refunded was removed as not fully operational. The official API description says prevention of a formal chargeback. Neither enum membership nor that wording establishes that all prevention modes refund money, or guarantees it appears at pinned `2024-06-20`. This review does not request a provider contact/account/financial-policy decision and does not represent those questions as solved.

An explicit synthetic SAME-payment fixture with a 10,000-cent succeeded refund AND a 10,000-cent prevented dispute demonstrates the author's declared composition limit: OLD retained revenue 0, HEAD -10,000, affiliate commission still 0 because `settleLine` clamps the refund to the sale total. Actual readers and retained-revenue arithmetic are used; no live co-occurrence has been established. This is a conditional accounting hazard already disclosed in the PR, not a newly confirmed live financial defect or an assertion that negative window revenue is always wrong. No de-duplication is added here.

## Static verification and artifact scope

Dependency audit of this subject's lock: 454 installed package versions match, 102 optional platform packages absent, zero required missing/mismatches; read-only donor, no installation. Type check uses the subject's real strict ES2017/Bundler options, incremental false, eight roots/843 graph sources, zero unfiltered diagnostics, 120 seconds/1024 MiB heap. Scoped lint passes. Public-data scanner and staged diff check are recorded alongside this report, after all new evidence files are staged. Raw logs are preserved base64 before line and whole-file trailing-whitespace normalization; no semantic rerun for artifact formatting.

The five authored product units and every exhausted runtime/CI retry remain held as recorded in the canonical checkpoint. Review evidence is not a sixth authored product unit. Author source/ref and feature/price/limit/commission switches remain unchanged.
