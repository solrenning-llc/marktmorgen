# Writing-job reservation acknowledgement evidence

> Coordination correction, 2026-11-06: Claude3 confirmed at07:48 that lib/ai.ts is NOT in #1969's own delta or reservation. The earlier occupancy attribution below came from an ancestral stack file list and is withdrawn. The evidence remains unchanged; Claude4 assigns any corrective owner. The historical source-occupancy sentences below do not represent current ownership.

Codex Z, 2026-11-06. Main source: 9c157b624f75adb2bf73342652c1b309366d1c1f. Report only: lib/ai.ts belongs to the open #1969 (Claude 3, head 62d132ed2d05d25cee9c50987736ae732a67b0cd). No product edit, product PR, shared alias, limit or policy change.

## Finding: MEDIUM latent monthly entitlement evidence gap

lib/ai.ts:371-380, counted, accepts the first reply alone and ignores the two-command envelope and EXPIRE receipt. Missing second result, extra result, null/text/zero EXPIRE receipt, or string INCRBY result permit the real helper to execute its work callback and return success.

Run `node tests/z-counted-ack-run.mjs [product-root]`. Ten test cases: six causal failures at the no-work assertion, four passing controls. Every failing case attempts exactly two application commands (INCRBY and EXPIRE), the synthetic transport applies neither, a separate direct MemoryRedis GET verifies absence, yet one synthetic writing callback executes. The verification GET is test inspection, not application work or claimed free IO. Empty envelope and unknown first result already refuse. Healthy MemoryRedis increments once and executes once; invalid job count makes no Redis call. No claim that every partial response succeeds.

The real counted implementation, allowance/window calculation and call-budget wrapper execute. Only Redis transport and AI-spend configuration are synthetic. The callback is a counter and constant string: zero model calls or external network; no actual payment, provider charge or dollar loss measured. The provider's independent spend reservation remains a separate boundary; this proof does NOT establish unbounded provider expenditure or bypass of reserveAiSpend. Two commands attempted / zero confirmed monthly jobs / one callback is the demonstrated mismatch, not a complete worst-month margin calculation. Unknown cost is never zero.

Require exactly two replies, exact safe numeric increment and confirmed EXPIRE=1 before callback. Preserve consumed increments, existing keys, TTLs and public quotas; do not add readback/retry or decrement an unknown reservation. Source owner/coordinator must choose the correction. This report does not authorize editing #1969.

## Validation and related pattern

Opt-in proof is intentionally RED (10/6 fail/4 controls), outside default .test.ts discovery. Linked AI30 + call-budget5 + cost-registry24 + data-registry7 =66 pass. Scoped strict TypeScript for both proof roots/imports and ESLint for three proof/runner paths pass. A first types invocation used a /tmp config without explicit Node type roots and failed resolution; specifying existing Node type roots fixed configuration only. A first shell call used the not-yet-created worktree as cwd and executed no command; worktree creation then succeeded. Neither is counted as RED or a product failure. No native Redis/browser/global build/CI certification.

Rule30: aiLeft at136 also destructures GET without exact envelope; counted shares jobCount coercion (string digits). Those are read-only candidates, not additional proved impacts. review-ai-summary.ts also has permissive receipt conversion, but is occupied by #1969; not edited, independently classified or claimed fixed. Strict admission findings already fixed in Z's service/AI routes remain separate and preserved.

## Follow-up: LOW proposed, unknown balance read certifies remaining jobs

2026-11-06, source main3345ba8b810853ede5d01f98d3d24fc9b688c878. lib/ai.ts:133-139 is byte-identical to the original9c157 source, so this opt-in branch does not merge main or alter product code. Run `node tests/z-counted-ack-run.mjs [product-root] z-ai-left-envelope.proof.ts`.

Eight new cases: four causal failures, four passing controls. Before each failing read, the real MemoryRedis store holds the complete40-job usage for the fixed Studio fixture. Only the application GET response is substituted: [null,99] returns40 jobs remaining; ['1',99] and ['01'] return39; ['00'] returns40. The real helper attempts exactly one GET and no application write. A separate direct fixture read confirms usage remains40. The proof expects conservative0 available on unknown evidence under the existing number-returning contract; a future explicit unknown result would also require coordinated caller changes. Known absent[null] still gives40, canonical['1'] gives39, missing[] and nested[['1']] already refuse as0.

This is an observable helper result, not a browser/SSR claim. Source-only tracing finds aiLeft feeding the studio/blog AiOn value (42,88), and ai-assist.tsx:141 renders the remaining count. Those UI consumers were read, not executed by this proof. It does not demonstrate new provider expenditure, bypass of counted or reserveAiSpend, or full-page rendering. Severity proposed LOW: unreliable displayed allowance; coordinator classifies and assigns the occupied #1969 source. No source, policy, quota or key edited.

Original z-counted-ack.proof.ts remains byte-identical. Because its shared synthetic transport now also substitutes GET, its ten cases were re-executed as a meaningful control: identical6 causal failures/4 passing controls. New8/4 and old10/6 are separate proofs, not18 passing tests. Linked AI30+call-budget5+cost24+data7 pass66/66. Scoped strict TypeScript now includes all three proof/world roots/imports; lint of the new proof/world/runner passes. First source lookup guessed a nonexistent components/ai-on.tsx and read no file; gitgrep found ai-assist.tsx instead, and no conclusion relies on the failed lookup.
