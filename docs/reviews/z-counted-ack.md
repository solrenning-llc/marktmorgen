# Writing-job reservation acknowledgement evidence

Codex Z, 2026-11-06. Main source: 9c157b624f75adb2bf73342652c1b309366d1c1f. Report only: lib/ai.ts belongs to the open #1969 (Claude 3, head 62d132ed2d05d25cee9c50987736ae732a67b0cd). No product edit, product PR, shared alias, limit or policy change.

## Finding: MEDIUM latent monthly entitlement evidence gap

lib/ai.ts:371-380, counted, accepts the first reply alone and ignores the two-command envelope and EXPIRE receipt. Missing second result, extra result, null/text/zero EXPIRE receipt, or string INCRBY result permit the real helper to execute its work callback and return success.

Run `node tests/z-counted-ack-run.mjs [product-root]`. Ten test cases: six causal failures at the no-work assertion, four passing controls. Every failing case attempts exactly two application commands (INCRBY and EXPIRE), the synthetic transport applies neither, a separate direct MemoryRedis GET verifies absence, yet one synthetic writing callback executes. The verification GET is test inspection, not application work or claimed free IO. Empty envelope and unknown first result already refuse. Healthy MemoryRedis increments once and executes once; invalid job count makes no Redis call. No claim that every partial response succeeds.

The real counted implementation, allowance/window calculation and call-budget wrapper execute. Only Redis transport and AI-spend configuration are synthetic. The callback is a counter and constant string: zero model calls or external network; no actual payment, provider charge or dollar loss measured. The provider's independent spend reservation remains a separate boundary; this proof does NOT establish unbounded provider expenditure or bypass of reserveAiSpend. Two commands attempted / zero confirmed monthly jobs / one callback is the demonstrated mismatch, not a complete worst-month margin calculation. Unknown cost is never zero.

Require exactly two replies, exact safe numeric increment and confirmed EXPIRE=1 before callback. Preserve consumed increments, existing keys, TTLs and public quotas; do not add readback/retry or decrement an unknown reservation. Source owner/coordinator must choose the correction. This report does not authorize editing #1969.

## Validation and related pattern

Opt-in proof is intentionally RED (10/6 fail/4 controls), outside default .test.ts discovery. Linked AI30 + call-budget5 + cost-registry24 + data-registry7 =66 pass. Scoped strict TypeScript for both proof roots/imports and ESLint for three proof/runner paths pass. A first types invocation used a /tmp config without explicit Node type roots and failed resolution; specifying existing Node type roots fixed configuration only. A first shell call used the not-yet-created worktree as cwd and executed no command; worktree creation then succeeded. Neither is counted as RED or a product failure. No native Redis/browser/global build/CI certification.

Rule30: aiLeft at136 also destructures GET without exact envelope; counted shares jobCount coercion (string digits). Those are read-only candidates, not additional proved impacts. review-ai-summary.ts also has permissive receipt conversion, but is occupied by #1969; not edited, independently classified or claimed fixed. Strict admission findings already fixed in Z's service/AI routes remain separate and preserved.
