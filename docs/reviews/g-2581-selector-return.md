# Codex G return review #2581

Exact product head: 5ba3f7aeb28bd2ebc013e33fe5529a5fb6ec31fa. Prior reviewed head: 2b6fdb4a26a34d9c862e9ecc34cd0b3fdcbf422f. Nominal request6673672138, prior LOW5789920827. Full corrective delta read: one commit, three files, product6lines plus original13-line proof and15-line launcher. Prior full-PR reviews retained; this is the corrective return, not a new certification of inherited main changes.

## Verdict

Prior functional LOW5789920827 CLOSED in the demonstrated vectors. No new HIGH/MEDIUM established. One LOW remains in automatic regression coverage: tests/g-2581-variation-selector.proof.ts:1 is outside tests/run.mjs:23 (*.test.ts only). package.json and .github/workflows have no direct launcher/proof reference. This correction has no discovered test that distinguishes fixed and buggy behavior. Adopt the exact original assertions in a discovered *.test.ts; preserve emoji and legitimate-script controls. Do not weaken predicates or merely rename expectations.

Reproduction: on the complete prior source2b6, the unchanged original proof78ce232afe743d29aecaea91e2c532fef810b650 yields6 checks/3 failures. On5ba it yields6/6. Yet ad-creative-check48, terms-check-rules82, meta-ads105 and terms-check-panel21 all yield256/256 on BOTH heads. Thus a rollback of the Mn correction is invisible to those relevant canonical tests. This is test coverage LOW, not an assertion that the current functional correction failed.

## Independent evidence

- Original proof and launcher byte-identical to396306e98a47f100c249a70147d86e519ec94747; proof blob78ce232afe743d29aecaea91e2c532fef810b650. Expected3 RED failures reproduced on complete2b6,6/6 on exact5ba. No original assertion edited.
- Additional tests/g2581-selectors-all-fields.proof.ts: all256 variation selectors (16 BMP+240 supplementary), each in headline/text/description/button, using REAL checkAdText; plus12 positive controls for emoji/ZWJ, accented Latin, Cyrillic with combining mark, Arabic/Hebrew direction marks, Greek brands and Mongolian shapes. SAME1036-check file: prior2b6 has1024 failures and12 passing controls; current5ba1036/1036. Those1024 failures are parameterized executions of the SAME fixed defect, not1024 independent findings.
- Ten linked files,373 checks,0 failures/skip on5ba: ad-creative-check48, terms-check-rules82, meta-ads105, terms-check-panel21, ad-autopilot-rules30, ad-campaign-plan27, ad-creative-test-rules26, ad-spend-guard14, creative-report11, original joined-scripts9. The latter retains the previous Cf fix. The four canonical groups256/256 were also actually rerun on2b6.
- Scoped strict TypeScript (product modules, original/extra/previous evidence and imports) exit0; focused ESLint exit0; public-data scanner3752 tracked/0 corrections; git diff2b6..5ba --check exit0. No full TSC/build/CI/browser/native Redis/provider/ad serving or financial-margin certification. Pure helper remains without productive caller in app/lib/components in this tree (rg found only its own definition). No claim of paid ad execution.

## Reproduce

On an own detached copy of either exact head, copy tests/g2581-selectors-all-fields.proof.ts from this branch; on prior2b6 also copy the unchanged original proof and g-proof-run.mjs from396306e9. Install the repository dependencies, then:

    node tests/g-proof-run.mjs g-2581-variation-selector.proof.ts g2581-selectors-all-fields.proof.ts

Each process is isolated by the unchanged launcher. Before source changes, freeze a canonical variant containing the same6 assertions and demonstrate6/3 on2b6 then6/6 on a new corrective head. No product changes by G. No reservation, foreign ref/CI/PR state changes, provider/account/contact or merge. CX72 and all future integration/head-specific checks remain applicable.
