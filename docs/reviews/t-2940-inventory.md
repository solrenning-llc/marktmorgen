# Independent review: #2940 accessibility inventory bookkeeping

Reviewer: Codex T, independent of the author. Claimed before reading the diff in PR comment `6696438729`; this evidence path was reserved in channel commit `14e35c4c1c84dbcf843212b80b19bcee53958a37` before writing.

Exact reviewed head: `56d5a42d8522571914b77f47ae6d60539af6cc09`.

Exact compared base: `5c07315505e1d53ee6401021601cd688fa98ecda`.

## Verdict

**APPROVE this exact head: no high, medium or low finding.** The complete two-file diff corrects a stale generated page-template counter, from 137 to the actual 138, and updates the accessibility statement's review fingerprint to its actual current inputs. It changes no review status, gap, route, browser test, public conformity claim, price, limit, permission, gate, or provider operation.

This is a source/bookkeeping review. No browser, axe, assistive-technology or conformance audit was executed or inferred. Approval does not certify the head's CI status, merge, deployment or availability to customers.

## Causal proof

The review used an isolated checkout at the exact head. The production files remained read-only. Base versions of the two changed files were supplied to canonical tests in memory; direct inventory-file reads were also served that exact base content. Everything else is identical between these snapshots. Only verbose failure diagnostics were truncated, without changing assertions. Final tests used the actual head versions and the repository's canonical esbuild CJS aliases.

| Check | Base | Reviewed head |
| --- | --- | --- |
| `tests/accessibility-inventory.test.ts` | 16 checks, one failure: generated inventory stale | 16/16 passing |
| `tests/accessibility-statement.test.ts` | 77 checks, one failure: review digest stale | 77/77 passing |

Independent generator verification used the real `generateInventory` export, not a manually edited expected count:

- The actual `app/**/page.tsx` walk contains **138** files; the inventory has **138** distinct page-template sources.
- `routeInventory.pageTemplates` is 137 at base and 138 at head.
- The complete generated head JSON equals the checked-in head JSON byte for byte.
- Generating from the base inventory yields exactly the head inventory. All other inventory content, including page rows, review statuses and recorded gaps, is unchanged.
- `node scripts/accessibility-route-inventory.mjs` passes without `--write`.

Independent fingerprint verification used Node's SHA-256 over the actual canonical basis: `JSON.stringify({ openWork, statuses: pageTemplates.map(t => t.status), checks: ACCESSIBILITY_CHECKS })`. The basis is 11,441 bytes and produces **`d2e1956c15bd55d1`**, matching both `statementDigest()` and the new `STATEMENT_REVIEW.digest`. The public counts remain **138 total / 0 reviewed**; all ten open gaps remain recorded. The review date remains November 6, 2026, consistent with this review. The counter itself is not part of the fingerprint basis; these are two independently verified stale-bookkeeping corrections.

## Other verification

- Scoped strict TypeScript passed, exit 0 with no diagnostics: a temporary configuration extended this checkout's `tsconfig.json`, preserved its normal alias/module/JSX settings, set `strict: true`, `noEmit: true`, `incremental: false`, and included the statement library, both relevant tests, the accessibility page and their actual imported closure. Command: `node_modules/.bin/tsc --project "$type_config" --pretty false`. The temporary configuration was removed; no generated artifact was retained.
- `node_modules/.bin/eslint lib/accessibility-statement.ts` passed.
- `git diff --check` passed. The existing generator, JSON parsing and byte comparison validate the JSON artifact.
- `python scripts/check_public_data.py` passed: 4,133 tracked files, zero files requiring correction, including this staged review artifact.
- Runtime verification used local source files and rendering only, with no network, payment, account, provider or paid operation. No new storage or privacy lifecycle is introduced.
- No full suite or unrelated framework repair was run. The known unrelated main failures are not represented as fixed by this PR.

Local causal logs: `/tmp/t-2940-base-accessibility-inventory.test.ts.log`, `/tmp/t-2940-base-accessibility-statement.test.ts.log`, `/tmp/t-2940-head-accessibility-inventory.test.ts.log`, `/tmp/t-2940-head-accessibility-statement.test.ts.log`; strict type log `/tmp/t-2940-types.log` is empty. The four test logs total less than 16 KiB; each process had a 120-second timeout and 128-KiB captured-output ceiling.

## Nominal merge return: 4bb52476224a2e00f2b672de879b870e4f2bb18d

This is a read-only focal return requested by the author after combining the already reviewed #2931 test fix with main. The coordinating reviewer announced the nominal return before diff inspection. Target head: `4bb52476224a2e00f2b672de879b870e4f2bb18d`; supplied PR base: `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`. No author ref, source, CI or head was altered.

**Focal conclusion: no high, medium or low finding demonstrated in the three scoped paths. Transfer is qualified, not a claim that every original artifact is byte-identical.** The statement and imported Stripe test are byte-identical to their respective reviewed versions. The inventory has exactly one static, merge-derived source-list addition, inspected below. No new tests, generator run, build, types, lint, scanner, browser or accessibility audit were executed or claimed on this return.

### Exact blob receipts

| Scoped path | Reviewed source | New head | Result |
| --- | --- | --- | --- |
| `lib/accessibility-statement.ts` | Original #2940 head `56d5a42d8522571914b77f47ae6d60539af6cc09`: `41e8e260ad55cae76796888c49ae0c41a668e1a8` | `41e8e260ad55cae76796888c49ae0c41a668e1a8` | BYTE-ID |
| `tests/stripe-list-lot1.test.ts` | Reviewed #2931 head `44aa73d359b367a4aa6acd5d90cbca07a5749505`: `fb38e3815376ee71733e9bb1de3dcfbfbba154d8` | `fb38e3815376ee71733e9bb1de3dcfbfbba154d8` | BYTE-ID; retains C2's review, not a new test run here |
| `docs/accessibility-inventory.json` | Original #2940: `8c606dbdd79164a0b1ef7a08a0bfffb89496953d` | `efec7662bb94f87e4a5ccd2671e0c305105bae51` | NOT BYTE-ID; bounded JSON delta inspected |

Both complete inventory blobs were read through fetch_blob and matched their file readings. In-memory JSON comparison proves that **only `componentSources` changes**, from 359 to 360 unique, sorted entries, adding `components/cart-link-builder.tsx` and removing nothing. Every other top-level value is equal: schemaVersion, sourceRevision, brief, purpose, standard, source, pageTemplates, boundaryTemplates, apiRouteSources, openWork, currentEvidence, layoutTemplates and routeInventory. There is no change to recorded review statuses, gaps, page rows, page-template count or the fingerprint inputs previously examined. This static equality is not a rerun of the generator or a fresh correctness claim for all current main inputs.

Git tree metadata confirms that the added path already belongs to the supplied main base. The complete `components` subtree is **`d735e4d021b3bfcfc8f79791d2786336e3bba5bf` on both main `c366e58` and head `4bb5247`**. Its untruncated entry for `cart-link-builder.tsx` is mode 100644, blob `4a10c5a4ac59ce0b216daf819abdcbbd1ef4c958`, size 13,259 bytes. Only tree metadata was inspected; the component source blob was not read or reviewed in this return.

### Merge provenance and review boundary

The exact Git commit graph contains two successive merge commits:

1. `56a8d9959b2d45e61df1e6a8c621b4ce104c461d`: parents are the original reviewed #2940 `56d5a42d8522571914b77f47ae6d60539af6cc09` and reviewed #2931 `44aa73d359b367a4aa6acd5d90cbca07a5749505`. Its message explains carrying the unchanged test-only #2931 fix to resolve the mutually red suites.
2. `4bb52476224a2e00f2b672de879b870e4f2bb18d`: parents are that merge and main `c366e58ab40a1d9c9f4a42f60e62eb0ec1f67a92`. Head tree: `b7dc9c1035c57dd3496bbcb4dbaead7ccab9768a`; main tree: `f82aaaf7410dbaf997375b2682b5c447c5624a31`.

Under CX-122.8, the original T review `5807496602` and its previously observed 93/93 checks remain historical evidence for the unchanged reviewed content, with the one inventory addition explicitly qualified above. C2's independent review of #2931 remains responsible for the imported, exact same Stripe test. These receipts do not turn old test results into newly executed results on `4bb5247`, do not review unrelated main changes, and do not establish nine final CI successes or merge eligibility. The coordinating author retains gate and final-check decisions.
