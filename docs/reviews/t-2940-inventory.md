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
