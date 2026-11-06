# Independent Codex G review — #2699, L8

Exact head: 2486e8e89eeeeb268d5d6717f74e25c9c1767b00. Claim before source/diff/tests: channel bff559daee5914d458b788f25568b3519db13d7e. Decision: **ONE MEDIUM, NOT MAY MERGE**.

Read the complete 11-path own delta, 1,103 additions / 50 deletions, over L1 base e8d85fcb65e777ae18212db9d5abb7211bb7858d: six implementation files and five new test files. redis-count and redis-reply blobs are byte-identical to the previously G-reviewed L1 source 6e557067 (2742c19e and 8f7534b6 respectively); this does not reopen or globally certify L1, its outreach cost caveat or the independently controlled shared-helper follow-up.

## MEDIUM — an unconfirmed or unsuccessful refund becomes permanently settled

lib/closing-refunds.ts:300–307, giveBackUnused; settled predicate :52 and unusedRows :55–62.

After POST /refunds, the function handles only status pending separately. Every other response is treated as done without proving identity, payment, amount/currency or a completed status. Through actual giveBackUnused, actual claimHandle and actual paid-period read/write, valid synthetic paid evidence of 1,000 cents covering 30 days creates an unused 500-cent amount at its midpoint. The exact GET balance, payment intent and refund-list controls answer consistently. Replace only the POST response, with no refund applied in the provider fixture:

- empty object;
- failed status;
- requires_action status;
- canceled status;
- succeeded object naming another payment intent;
- succeeded object with textual amount.

Every case returns one entry in done, failed:0, persists paid.r=done and disappears from actual unusedRows on the next read, while the synthetic provider's refunded amount stays zero. Thus the promised refund is recorded complete and its reconciliation work is lost. The normal control applies exactly 500 in the provider fixture, returns coherent refund evidence, and completes exactly once.

Proof: tests/g2699-refund-response.proof.ts@48c01cad31f7d4bc594b4b5e29d481a978d8e085; runner tests/g2699-run.mjs@91fca86b778dde3cec7242dd2ba13bdc26ed1206, on own branch codex/g-review-2699-refund-evidence. Run node tests/g2699-run.mjs g2699-refund-response.proof.ts: **27 checks / 12 causal failures / 15 passing checks and controls**. Each six-case vector has two failures: false completed result and no recoverable remaining row. Exact request/amount and fixture ledger checks pass. The SAME proof on full prior 99528efdc source also yields 27/12: **inherited financial boundary used by the function this delta changes; not a newly introduced regression**.

Correction must require coherent refund evidence before done, retain/reconcile an unknown outcome through the same existing operation/idempotency identity, and distinguish incomplete/failed states. Do not blindly POST another refund after an uncertain response. No price, cap, fee, flag or gate change is needed for this finding. Author/controller remains responsible for code and policy.

Primary source read 2026-11-06: https://docs.stripe.com/api/refunds/object . It defines amount as an integer, identifies the refunded payment, and distinguishes successful, pending, action-required, failed and canceled refund states. No claim of a live Stripe response or real-money loss. The new fixture is deterministic and has no real provider action.

## Reproduced REDs and linked checks

Full prior RED source 99528efdc: SAME author sg2-l8-usage-marks 48 checks / 35 failures; exact reviewed head 48/48. Full prior RED source a3336423e: SAME author watch-resync 16/15 failures, credit-giveback 14/7 failures; final 16/16 and 14/14. No implementation overlay or missing-export failure is presented as causal RED.

All five new ordinary groups pass: counts188 + credit14 + usage25 + marks48 + resync16 = **291**. Fourteen additional groups pass **577** (493 custom checks + 84 node tests): watch64, traffic75, renewal73, delivery-watch11, cost24, margin39, usage-meter6, video-usage-notice4, store-closing-fair103, closing-refunds-unknown25, plan-closing90, review-after-purchase20, review-list-read28, picked-reviews15. Total ordinary final validation **868 passing, 0 fail/skip in 19 groups**. These ordinary successes do not clear the new 27/12 refund evidence.

Two exploratory group names closing-credit.test.ts and closing-buyers.test.ts did not exist. Their bundle lookup errors were task selection errors, not product/CI failures; the actual available related groups listed above were then run. No check is counted for a nonexistent file. Source strict TypeScript / actual imports / new evidence: zero diagnostics. Focused ESLint: zero. Public-data scanner: 3,844 tracked files / zero findings; three own proof/runner files checked separately with the same findings function, zero. Own and source diff-check clean.

## Ungraded release exploration — not a second finding

A derivative of the author's 48-check usage-marks test adds a releaseLock fallback barrier: synthetic EVAL failure, captured own GET, then an arbitrarily installed successor value before DEL. It yields 50 checks / 1 failure, while all 48 original runtime assertions remain unchanged (14 static is calls confirmed identical by TypeScript AST). Stored as tests/g2699-release-race.exploratory.ts@2e727c077451a63d199db5550863dabc72e7bd64.

This demonstrates the generic helper's check-then-delete limitation, but it does NOT demonstrate a legitimate successor acquisition within the newly acquired mark's 400-day TTL. Its raw replacement step was not established through the actual production acquisition protocol. **No degree or product blocker is assigned to this exploration.** Do not repeat it as a confirmed monthly-billing race. Generic releaseLock is inherited and shared; no shared-file edit was attempted. The refund-response proof alone supports the blocking MEDIUM.

## Limits and rule 30

No author product/ref/reservation/CI change or merge. No real Stripe, SES, Bunny, Redis-native instance, browser/hosted journey, global build/verify or CI run. Local cost tests do not certify current real company margin. This PR touches giveBackUnused, an outgoing-money boundary; its author's old one-review summary does not waive the required qualified financial reviews or nine exact-head checks.

C5 already inventoried malformed refund LIST fallback at closing-refunds:251 and invoice-payment lists at:100; these are existing controller candidates, not duplicated as new findings here. This new proof concerns the POST refund RESULT and permanent settled state. Related pending/ours paths :254–258 and intentOf :100 are static same-class triage candidates, not additional independently reproduced findings. Assignment remains with C4/C1. The raw source fallback in usage-billing:234 and whole-folder readings in watch:127 are static candidates only, not certified exploits or extra financial findings.
