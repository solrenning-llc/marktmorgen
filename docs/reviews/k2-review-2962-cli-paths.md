# Independent review of #2962: CLI entry paths

Reviewed head: `3a0f3b8c2833028180e882a4ae539763d84a0ac3`, tree `03696b2d7bda9db69bb2032859c061ab9909c94c`. PR claim `6697904730` preceded source/diff/tests. Own evidence writes followed successful channel reservation `f51ee3423718469b642d10b07ef7481a694875de`. The advertised base was `8f73f9d31b1cc912bb127ce9259601d739732981`; actual merge base is `5c07315505e1d53ee6401021601cd688fa98ecda`. The complete three-dot PR diff contains only `cli/marktmorgen.mjs` and `tests/cli-entry.test.ts`.

## Result and explicit related-test limitation

**No new grave/medium finding was demonstrated in the entrypoint repair.** The same twenty author assertions produce ten failures against the exact original CLI and 20/20 passes against this head. Actual Linux executions cover help and a keyless tool in folders with a space, a percent sign, non-ASCII text and a plain control, plus a differently named symbolic link and an import-only control. The new real-path comparison addresses the old URL/path mismatch without the old basename-only execution condition.

The related `tests/cli.test.ts` is **not green**. It aborts at the first direct real MCP tools/list response, when it reads `listed.result.tools` from a reply without that result. The observed error is `TypeError: Cannot read properties of undefined (reading 'tools')`. An explicit baseline counterexample using the same unchanged test, MCP implementation, store fixtures, aliases, environment and guards, with only the CLI overlaid from the author RED, fails identically at the same expression. Both executions dispatch 16 synthetic Redis commands and one in-process request before failing.

This same-wiring comparison does not attribute the observed linked failure to the changed CLI guard. It does **not** establish an inherited main failure or a new MCP product finding: the underlying fixture, harness or MCP response cause remains unresolved. Linked validation is **incomplete**, not passing. No test, commercial gate, fixture, approval flag, account or provider configuration was changed to bypass it. Current hosted checks and merge readiness remain unverified; the exact-head full CI gates must still resolve this limitation.

## Original RED and actual execution

Original author RED: `4f8cc43514505ff4db6c14dbbc441d8da0efc6db`. The exact new test blob `6462e4a2ec0298b5b6d4ca39ca34039c6eb5a324` is identical in that RED and the final head. The original CLI blob is `81b00a4ea3d252fceeff1aee15e0841749cb0baf`; final CLI blob is `11884fee8e261141996bec28949c7b8cfe9b354a`. The immutable author test was compiled once and run against separate copies of those exact CLI files. No author assertion or expectation was changed.

The first execution batch used 23 test subprocesses: two author wrapper processes, their twenty CLI child processes, and one related-test process. On the related failure, the independent extra import scenario was not run. The last admitted subprocess, number 24, was used for the causally justified CLI-preimage baseline of that same linked test; the twenty author assertions were not repeated during recovery.

| Execution | Actual result |
| --- | --- |
| Same author test with original CLI | 20 assertions, 10 failures |
| Same author test with final CLI | 20/20 passing |
| Unchanged CLI/MCP related test, final CLI | TypeError at first tools/list reply; not passing |
| Same related test, only CLI preimage overlaid | Identical TypeError under the same wiring; root cause unresolved |
| Prepared named-importer/compound-path extra control | **Not executed**; subprocess budget exhausted |

These are twenty unique author assertions through two source versions, not forty independent cases. The original author's own import-only and symlink controls did run and pass on the final CLI. No independent extra importer scenario, Windows execution, preserve-symlinks flag, case-insensitive filesystem, loopback server or network-backed CLI call is asserted.

## Admissions and evidence runner

The runner admits at most 24 test subprocesses before launch, including the ten nested CLI children reserved for each author wrapper. The nested children have deadlines and output limits installed by the wrapper without changing the test bytes. All author CLI child environments contain PATH only: help/keyless invocations require no real key and stop before any outside request.

The linked-test wrapper admits at most 5,000 synthetic commands before each MemoryRedis dispatch and at most eight in-process requests with string bodies no larger than 4 KiB. The observed failing final and baseline runs each use 16 commands and one request, including fixture setup. Their original test's synthetic key/store data stay in MemoryRedis; no real account, key, payment, provider or outside contact is created. Network fetch is intercepted by that unchanged test and no outside request is used. No TCP listener is started.

The original runtime batch and the one-process recovery each enforce a 120-second deadline and 128-KiB output bound. Their retained logs are 3,942 and 1,212 bytes respectively, 5,154 bytes total. Source/Git, compilation and quality-tool processes are tooling rather than those 24 test children. Recovery was separately admitted after the observed failure and required a second isolated esbuild service after the original runner exited: this is an explicit tooling admission change, not additional paid business work or an extra test child. Node 24.22.1 was used.

`proofs/k2/review-2962-cli-paths.mjs` now reproduces the twenty author RED/final assertions and both expected related failures in a fresh bounded 24-child run. The actual recovery invocation used its baseline-only mode, which explicitly records the 23 prior children and launches only child 24. A zero runner exit means that those declared results were reproduced; it does not mean the linked test is green.

```sh
timeout 120s node proofs/k2/review-2962-cli-paths.mjs /absolute/exact-source
# Recovery used after the recorded 23-child first batch:
timeout 120s node proofs/k2/review-2962-cli-paths.mjs /absolute/exact-source --linked-baseline-only
```

The reserved `tests/k-review-2962-cli-paths.proof.ts` contains the prepared independent named-importer/compound-path control. Its TypeScript and lint checks pass, but it is deliberately not called by the final runner and is not runtime evidence. Its planned original-CLI counterpart was also not executed. The file is retained with this explicit limitation rather than claiming an unrun adversarial result or exceeding the admission.

## Source exactness and quality checks

Execution used a complete detached source checkout of this exact head, with own installed dependencies linked separately. The baseline overlay changes only the CLI bytes; it does not substitute the MCP handler, test body, store reader or authorization logic. The rest of the two-path PR closure is unchanged from the merge base.

| Path | Exact reviewed blob |
| --- | --- |
| `cli/marktmorgen.mjs` | `11884fee8e261141996bec28949c7b8cfe9b354a` |
| `tests/cli-entry.test.ts` | `6462e4a2ec0298b5b6d4ca39ca34039c6eb5a324` |
| `tests/cli.test.ts` | `c5c5cbc56c07fc6fdd39f60cdc93d65702c653f3` |
| `app/api/mcp/route.ts` | `7b2370d13c96a3521d58fa582dfb3029b13c4cf8` |

Actual scoped TypeScript over the CLI, author entry test and own prepared proof roots reports zero diagnostics under the repository ES2017 configuration. Repository allowJs/checkJs behavior was preserved; this is not a new strict-JavaScript or whole-project audit. Directed ESLint passes on the two author paths and both own executable paths, including a focused rerun after the evidence runner's recovery change. Runner syntax and native three-dot source diff checks pass. The directed public-data detector reports five paths and zero corrections over both author paths and all three own evidence/report paths; own evidence whitespace checks report zero diagnostics.

No source belonging to the author was edited, no remote ref/PR/CI was changed, and no full suite or production build was run. This head has no rendered accessibility change; the exit/output behavior above is the actual tested user contract. No complete journey, AAA, hosted nine-check state, money, cost-model integrity or merge certification is made.
