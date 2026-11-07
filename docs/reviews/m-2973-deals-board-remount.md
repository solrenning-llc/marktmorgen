# Independent review of #2973

Source: `c76d5faa75126f0625f57c51b5109e704503e45b`, base `8f73f9d31b1cc912bb127ce9259601d739732981`. Claim `6698885885` and channel reservation `d48119de0a5890e8c8cbb690666e2a8aa00dcf0a` preceded every diff/source read. The unanswered R2 request was preserved; no accepted independent claim was found in the fresh full channel or timeline.

This is a small, sequential review requested by V, under C4-3080. No subagent, product modification, workflow change, browser installation, PR push, merge or CI retry accompanies it. These artifacts remain LOCAL until the freeze is released.

## Source review

The new helper takes the epoch returned by `mount`, waits for that exact committed epoch, then uses the existing title gate. The Board's single layout callback installs its own refresh closure before publishing readiness. The passive-effect assignment was removed. Each new mount still creates a distinct Board; the world, write reset, synthetic API and rendered product props are preserved.

The entire E2E file outside the mount helper is byte-identical between the actual base and head: base `ea45ece741530b3c203e3e8f589ef2412abaf713`, head `20301a0bbe22ac46ae159cad9f1a76ed5129bbc2`. This preserves all existing interactions, focus assertions, explicit timeouts, existing waits, contexts and browser teardown. The added readiness wait is not represented as a browser result.

## Directed executions

The exact current author test is Gitblob `3f415216afc4a4dc6a56d39bf01857696ad8e45c`. Its ten identical assertions were applied to the exact source snapshots from refresh-ownership RED `d33ad10ffdafbbc8669105a23efc054a83789dc0` and current head.

| Scope | Controlled RED source | Head |
| --- | --- | --- |
| Current author assertions | 10 checks, 2 failures | 10/10 |
| Independent instrumented protocol | 8 checks, 2 failures | 8/8 |

The original RED test blob is `14f33b14714b6b3b9615f12d77c03444438cd8a1`: one regex on line 63 differs from the current file. It was broadened to allow another statement inside the same layout callback; the two separate ownership/order checks remain. This review uses the SAME final assertions on both snapshots, not a claim of replaying an untouched signed RED tree or reproducing all historical runs.

The independent proof executes the exact reviewed E2E helper and exact reviewed layout callback, with instrumented TEST ports. Before the callback, an old title cannot release the helper. At the actual readiness assignment, the proof observes which refresh setter owns the Board. The RED source still calls owner 4; head calls owner 5 both then and on the following refresh. The mount port, scheduler and loading setter are explicitly controlled boundaries. No production component was extracted or replaced to claim a user-facing result. This is NOT a React commit, DOM, accessibility or WebKit execution.

The four small child processes completed in 0.413 seconds total (including preparation), with 3,449 log bytes. Each used heap 256 MiB, a 20-second child deadline, finite measured cgroup admission with at least 768 MiB free, and an aggregate 128 KiB log cap. Measured headroom before each child was 1,317,343,232 / 1,316,028,416 / 1,311,289,344 / 1,311,199,232 bytes. Verified input was 95,025 bytes. The own proof measured zero network attempts and two bounded synthetic timer allocations at head; no real timer was scheduled by that port. No Redis, paid product read/write, mail, provider or application business operation was invoked. Monetary cost remains unmeasured.

Paired log SHA256: `c8a000ed35e9b6655e3fe7b2d4244c23ca78b445857219c2113e8292418e81bb`. Executed own proof Gitblob: `6c1ca64a0179818e8d1ea4e359315121d8df64e3`; executed runner: `5f0615f18d36895a735ee799f91244de6dc65c26`. An earlier Python orchestration attempt could not find Node in its sanitized PATH; no Node child or assertion started. It is not a product RED. The successful run used the absolute installed Node executable.

## Scoped validation and limits

Real strict TypeScript passed for the exact current author test and independent proof, using the original head configuration, real installed Node declarations and two explicit roots. The first pass was 23.840 seconds / zero diagnostics. Focused lint then rejected three unused parameter warnings in the own proof. Local evidence-root commit `4554516671f93ff06ef6cda9197b43a23d1771f5` preserves the exact executed proof/runner/report before that cleanup; it is NOT the product source tree and has no remote ref.

Only three unused parameter declarations were removed from the own test ports. Assertions, source extraction, event order and bodies were unchanged. Final strict checking passed exit0 / 1.602 seconds / log0; final focused lint of the author test and two own executable artifacts passed exit0 / 2.813 seconds / log0, with the actual ESLint configuration and no rule disabled. Cgroup headroom was 1,491,804,160 and 1,460,015,104 bytes, respectively. The original skipLibCheck setting was retained; this does not certify third-party declarations. Current proof Gitblob: `dfa08ab00fe2730b85fb60c99afe542c2a082f41`, SHA256 `af9e2fdb8b1e7f6ef27d6b75207d48551402f48b532abcc0b9964892eda90f75`.

The paired runtime was not repeated after this lint-only parameter cleanup. Its measured results belong to original proof `6c1ca64...` in local ancestor A, not a new functional run of the current proof. No repository-wide typecheck, production component type closure or browser matrix is claimed. Public-data and whitespace checks are reported separately below.

No new finding was demonstrated in the three-file test-only diff. The source proof supports readiness and refresh ownership without weakening the existing E2E assertions. Actual hosted Chromium/Firefox/WebKit focus behavior and the final nine CI checks remain required by the author and coordinator. This review does not authorize a merge during C4-3050/3070/3080.

## Reproduction inputs

Only three review artifacts are needed: this report, `tests/m-2973-deals-board-remount.proof.ts`, and `proofs/m/review-2973-deals-board-remount.mjs`. The runner also takes explicitly prepared SOURCE snapshots already available on GitHub: under `SNAPSHOTS/head` and `SNAPSHOTS/red`, the three reviewed paths at current head and `d33ad10...`, respectively. It verifies every full Gitblob SHA before using a file. No unpublished fixture JSON or hidden generated source is required. The canonical head TypeScript configuration is embedded in the runner.

With exact preinstalled dependencies supplied, without authorizing a new execution:

    node --max-old-space-size=256 proofs/m/review-2973-deals-board-remount.mjs --snapshots SNAPSHOTS --dependencies EXACT_NODE_MODULES

The measured environment used esbuild 0.28.2 and TypeScript 5.9.3. Dependencies were already present and only linked into this own review directory; nothing was installed or changed in the shared dependency tree. The runner removes its own temporary directory in a finally block. All four required outcome receipts were observed; no temporary remained after the run. Runtime results belong to the executed hashes above.

The canonical public-data scanner's findings function (SHA256 `6ae1393f74b1849b4b84cf97f7b38bff1875d5032dba4342d94c73f93b665c7e`) was run with an explicit allowlist: three review artifacts and six exact source snapshots, all zero occurrences. Its Git enumerator was not run; this is not a repository-wide scan. Directed `git diff --check` returned zero diagnostics. Local evidence commits contain only the three reserved review artifacts and no product tree or source snapshot files. Source snapshots and logs are retained locally for reproduction; there is no published evidence ref under the freeze.

## Publication after MAIN VERDE

Published after C4-3100 without a new execution or broader review. The two remote evidence commits preserve the executed local A artifacts first, then the lint-cleaned local B proof and this report's full earlier prefix. Their parent starts from the exact reviewed c76d5faa source tree, so remote commit/tree IDs differ from the local three-artifact-only evidence roots; only the same three reserved review paths are added. The original local A/B commits and bundle remain preserved. This publication does not move the author's #2973 branch, certify a later head or remeasure browser behavior. Historical freeze/local-only statements above describe their original timestamps.
