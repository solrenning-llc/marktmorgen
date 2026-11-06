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
