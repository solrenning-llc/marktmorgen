# Review of #2920 — inert optional course expiry

Reviewed head: `ac2c48d5de338c73d5c4d93143af8fa9deb5455c`; PR base: `5c07315505e1d53ee6401021601cd688fa98ecda`. Claim preceded diff/source/tests: PR comment `6696253297`, channel `2648e4c05bf3080bd4c388ad4020fa3832c12dd0`. The full two-file diff was read. #2915 belongs to J and was not reviewed.

**Result: no demonstrated grave/medium runtime finding; one LEVE in the new test's TypeScript compatibility.** The classifier itself meets its explicitly inert contract. This is not a claim of course access integration, authorization or a completed E7 feature.

## LEVE — new test does not typecheck under the repository target

`tests/course-access-expiry-rules.test.ts:29` adds the literal `0n`. The exact head's `tsconfig.json` targets ES2017 and includes `**/*.ts`. A real TypeScript program over the two exact changed files, with that configuration and installed Node typings, reports exactly:

```text
TS2737, tests/course-access-expiry-rules.test.ts:29:
BigInt literals are not available when targeting lower than ES2020.
```

This is executable proof, not merely source matching. In `tests/k-2920-expiry.proof.ts`, the real-target compatibility test fails while the three independent runtime tests pass. A virtual-only control replacing the literal with `BigInt(0)` yields zero diagnostics under the same target and preserves the same bigint value and every author assertion. No author file, compiler target or assertion was changed by this review.

Requested correction: express the same invalid bigint input using `BigInt(0)`, preserve the immutable original RED, and request a focal return on the new test blob. Do not raise the repository target or remove the bigint case to hide the diagnostic.

The product-checks workflow calls the normal Next build through `scripts/ci-build.mjs`; the head's Next config does not set `ignoreBuildErrors`. This review did not run a full Next build or inspect/claim a hosted failure. The observed fact is the local exact-configuration diagnostic, which contradicts the PR's unqualified scoped-types-green statement.

## Runtime and RED verification

The module has no imports and accepts only integer milliseconds within the inclusive JavaScript Date range. This bound lies within the safe-integer range. Invalid clocks are checked before absent expiry; null/undefined expiry is unspecified only with a valid clock. Equality is expired. Strings, boxed numbers, symbols, bigint, objects and fractions are not coerced. No ambient clock, IO or permission side effect is used.

The immutable author RED `b8213c1efb0a3220416509c4bc93a116460c13d5` adds only the test. Its blob `4b6ff29d0db691fe5b7cb3b716947ad6a88f10da` is byte-identical in the reviewed head. Replayed with that exact test and absent new module: **11/11 fail for the named missing export**. Replayed with the exact final module: **11/11 pass**. Both native Node and canonical esbuild compilation produced these results; these are repeated methods over the same cases, not 22 independent cases.

Independent proof: **5 Node tests: 4 pass, 1 causal RED**. Runtime coverage includes the complete 7×7 ordered endpoint relation, revoked/trapping proxies without inspection, and an ambient `Date.now` that throws. The additional passing test is the virtual constructor-form TypeScript control. Only the real unchanged author-test compatibility assertion fails.

## Exactness and limits

This used a bounded two-file source snapshot, not a full checkout of each historical commit. Both changed files were fetched at the exact head and checked with Git blob hashes before execution. The module has no import closure. The actual head's tsconfig, canonical test wiring and discovery files were separately fetched and match the frozen base snapshot; no module stub substituted the classifier or compiler. Search of the frozen base's app/components/lib found no existing importer of this new module. No unrelated cohort/preview tests or full suite were rerun merely to increase counts.

Reproduce:

```sh
TMPDIR=/tmp node proofs/k2/review-2920.mjs /path/to/exact-two-file-snapshot /path/to/frozen-base
```

The runner checks source/test/config blob identities; a future focal return can supply the independently verified corrected author-test blob as its fourth argument. Runtime/build budget: 120 seconds total; combined logs capped at 128 KiB (observed 24,184 bytes). Zero productive Redis/provider/network requests or local HTTP server. Compiler/test filesystem IO and one ephemeral compiled test bundle are explicit; temporary copies are removed. Execution used Node 24.22.1.

An initial attempt to feed absolute paths through the generic helper joined them to the base path and produced two file-not-found mounting errors. Those are excluded. The corrected compiler program uses actual absolute roots and returns the single TS2737 diagnostic described above.

Review-artifact TypeScript/imports: zero diagnostics. Directed ESLint is clean on both author files and both own executable artifacts; runner syntax/diff checks are clean. Scanner is directed to the two author files and three own files, using the repository scanner's findings function; no global scanner/CI result is claimed. The intentionally failing compatibility proof is preserved for the author, not weakened.

Not executed: hosted CI, full production build, browser, screen reader, native Redis, actual course grants, provider, UI or future expiry integration. No AAA, complete journey, money or margin certification. No source/ref/PR/CI changes were made to the author.

## Provenance

| Path | Blob |
| --- | --- |
| `lib/course-access-expiry-rules.ts` | `0678b555bdabe6593eabb0031cf22295c7ea0c87` |
| `tests/course-access-expiry-rules.test.ts` | `4b6ff29d0db691fe5b7cb3b716947ad6a88f10da` |
| `tsconfig.json` | `f126992ca95c6da5359e547a2e58e92fccd3d02c` |
| `tests/test-config.mjs` | `46ddad8f5d5225f6b0e9b22d63310255ba652090` |
| `tests/run.mjs` | `13c4470bb862b816d88a449469980857a17ace7b` |
| `.github/workflows/product-checks.yml` | `875a808ed53fa24ef6b7c35cf11dd0f291760fef` |
| `scripts/ci-build.mjs` | `dbb59e3a01cdc8ee0307857f32b7084aaebae273` |
| `next.config.ts` | `eebe0821f9687a2b5187363b5512dcb0d7a9543a` |

## Focal return on da6988b4

Reviewed return head: `da6988b4f5d2a409c5269482453c5baf3933a436`, tree `8b6158b32c951adc9f589a143d519e921e983602`. The return claim, PR comment `6697413863`, preceded reading the new diff/source/tests. The earlier review, original new-feature RED and TS2737 reproduction above remain intact; this append does not relabel the missing-module replay as a TypeScript RED.

The complete `ac2c48d5..da6988b4` delta is one replacement in `tests/course-access-expiry-rules.test.ts:29`: `0n` becomes `BigInt(0)`. The new test blob is `993d3e8e0c4b45bbcc073e73a379bd0453316e28`. All eleven test cases and assertions are preserved. The module remains byte-identical at `0678b555bdabe6593eabb0031cf22295c7ea0c87`; the real tsconfig remains `f126992ca95c6da5359e547a2e58e92fccd3d02c`, including target ES2017. No new type-guard test, product change or new author TS-RED artifact occurs in this delta.

**Result: the original LEVE TS2737 finding is closed in this exact return. No new grave or medium finding was demonstrated.** The constructor retains the same bigint value in the invalid-input matrix. The contract remains pure, import-free and explicitly inert; this result grants no course access or future integration approval.

Execution used a complete detached return checkout and the recovered own dependencies, with Node 24.22.1. The independent proof and runner were restored unchanged from own review `82ee4207af5482b83772654933756cb1102ac0f5`: proof blob `c661d75c32586744233899972f571c3fa018dc1a`, runner blob `d4b373e969e4375ed2efe8eb0f839819a3f341fc`. The same runner's documented fourth argument pinned the independently verified new author-test blob; neither the original proof, provenance assertions nor repository compiler target was weakened.

The corrected author test again yields eleven named missing-export failures when the new contract is absent and 11/11 passes with the real module, through both native Node and canonical esbuild methods. These are the same eleven cases through repeated methods, not 22 unique cases, and the absent-contract replay is not evidence of TS2737. The unchanged independent proof now passes **5/5 Node tests**: three runtime tests and two real-target compiler assertions. The complete 7x7 endpoint relation, trapping/revoked proxies, explicit-clock behavior and bigint input remain covered. Actual TypeScript over the two author roots with the exact ES2017 config reports zero diagnostics. The constructor-form compiler control remains unchanged; on this corrected source it verifies the same compatible text.

Directed ESLint on the two author files passes. Native `git diff --check ac2c48d5 da6988b4` passes. The repository public-data detector reports five files and zero corrections over the two author files and three own evidence/report files. Runtime/compiler execution retained the original 120-second total deadline and 128-KiB combined-log admission; observed proof output was 22,283 bytes. No productive provider, Redis, HTTP or external network operation was part of those contract/compiler tests. Source recovery used Git separately.

No unrelated cohort/preview tests, full suite, full production build, browser, screen reader, native Redis, actual grants or provider flow was rerun. Current REST PR state and the nine hosted checks could not be verified because reads were rate limited; no OPEN, merge-ready or CI-green claim is made. No author source/ref/PR/CI was changed.
