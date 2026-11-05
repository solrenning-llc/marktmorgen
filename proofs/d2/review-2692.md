# D2 financial review — PR #2692

Codex D2 — financial review of exact head 5caa7807f1611f7893379ad7084e07b320abc0c3: **MEDIUM — not cleared for merge**.

In partsOutcome, refund IDs are deduplicated inside each individual refundPage, but not across the pages fetched for distinct noted charges (lib/plan-refund-flow.ts:216–226). Two otherwise valid pages repeating the same refund ID are independently added toward both debts. The function returns found/settled with twice the amount, although the evidence describes only one unique refund.

This is observable through the real daily flow: create a two-payment partial refund with the existing paidShop fixture (only one refund succeeds), confirm honest charge pages keep the plan active, then supply the same successful refund ID on both charge pages. finishPlanRefunds cancels the subscription and deletes the pending note, with only one actual refund recorded. A repeated ID attached to distinct charge pages is contradictory evidence and must remain unknown before settlement. Please preserve one cross-page set of refund IDs and refuse repetition (and preserve charge identity when validating it), with a permanent regression. Do not infer a second refund.

Immutable proof: branch codex/d-review-2692-refund-evidence, commit 2ff8feda8e2b32d03d52e00708dcb88431c8312a, tests/d2-review-2692-evidence.test.ts. Reproduce with `node proofs/d2/run-2692.mjs final d2-review-2692-evidence.test.ts`: **9 checks, 3 causal failures, 6 controls pass**. The unchanged proof also yields9/3 against the author's RED library sources: inherited defect in exactly the reader changed here, not a newly introduced regression.

The entire four-path diff and allowanceUsed callers were read. Author tests are byte-identical to RED6f7eb8f4: allowance114/33 and refund81/28 on RED,195/195 on final. Nine linked counted suites336/336; total531 passing counted checks plus store-allowance and allowance-window assertion suites. Scoped strict TypeScript with transitive imports, focused ESLint, scanner including staged reviewer files3801/0, diff checks pass. Actual browser-bundle check268/268 passes, so these node:util additions did not break the current client graphs. No real Stripe/Redis/browser/global TypeScript or deployment certification.

Reviewer launcher correction: first linked invocation used nonexistent essential-studio.test.ts and stopped after the two focal suites; corrected to essential-studio-allowance and broadcast-allowance-window, then all eleven remaining groups passed. No absent test was counted.

No author file, branch, CI or policy was changed. Repeat the immutable proof on the corrected head before closing this MEDIUM. A second independent financial clearance and nine exact-head green workflows remain required.

Published review:5793009445.
