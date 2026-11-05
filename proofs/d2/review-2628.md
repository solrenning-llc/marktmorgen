# D2 independent review of PR #2628

Exact head: aba6a100806f0e1d549ab78d3bb4949e04931db0. SEM ACHADO / PODE ENTRAR after all nine exact-head workflow aggregates succeed and a normal merge is possible. No author branch, CI or product was changed.

Read the complete changed browser test and its real React harness. The only added line waits until the exact sentence is observable before the original complete assertion. Removing that one line reproduces the parent file byte-for-byte: same assertions, explicit deadlines, fixtures and browser cleanup. It introduces no fixed sleep, retry, assertion removal, product change or workflow timeout increase. A duplicate sentence, duplicate/missing notice or a change control still fails the original [1,1,0] comparison.

Evidence read directly from durable hosted RED logs:
- Job127153577499, head5bfc9de6d04d2e39361efaecd0dad4f952831541: expected[1,1,0], got[0,1,0],74checks/1failure(WebKit).
- Job127151615499, head12d8bd7c241db12992f362e614cb7127711a4158: expected[1,1,0], got[0,0,0],74checks/1failure(WebKit). This corrects the PR description's claim that both actual triples were[0,1,0]; it does not change the causal pending-render fix.

Independent deterministic proof, commit4da9536e835a20651c354551baf0a7637b0fcbd0 on codex/d-review-2628-observed-state, tests/d2-review-2628-observed-state.test.mjs: extracts and executes the exact changed block in a VM with an explicit pending-commit stand-in. Unchanged proof: parent5tests/3causal failures/2controls; final5/5. Covers late text with or without an existing notice, already-ready output, rejection of duplicate/missing notices and change controls, and failure when the sentence never arrives. The initial probe's cross-realm trace-array comparison was corrected by serializing the trace with the original comparator's own JSON semantics; expected triples and assertions were preserved, and this reviewer-only correction was explained in the channel before editing.

Node syntax checks, focused ESLint, scanner3738tracked files/0 corrections including staged proof, diff check and byte-identity check pass. No TypeScript file changed. Hosted WebKit127364725312 and Firefox127364712166 job metadata reports success; this is not a new local browser run or a claim to have extracted their final74-case output.

Limits: Chromium/Firefox/WebKit executables are absent locally. No real-browser, real-reader, human AAA, supplier, global suite, global TypeScript or deployment certification. The VM proof is a scheduling stand-in, not actual React/browser rendering. The required hosted product workflow remains cancelled after the unique verify retry; this review does not authorize a second retry, timeout change or bypass.
