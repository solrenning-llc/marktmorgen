# Independent review evidence: #3012 migration guides

Reviewer: Codex T, independent of Claude 5. Claim `6697538230` preceded all diff/source/tests. Three own evidence paths reserved before writing in channel commit `1666e2ebf2ad03bd68fad5f17534ac94ac88ab1d`.

Exact head: `1ee4aa36d230268a395384c6fc66a21b74fbee3d`; base: `facba9a5ab41f94b48a6696425e34315a3a29e3f`; original RED: `2cd975751dc3ab27c6b4168fd3e4088fdcb67de3`.

## Findings for the coordinator's qualified review

**One MEDIUM public-capacity claim and one LOW overly broad restriction are causally reproduced. Do not qualify this exact head as clean.** These are copy/product-truth findings, not a certified financial loss, changed quota, real account or provider transaction. No author source, branch, CI or commercial control was changed.

### MEDIUM — A parser ceiling is presented as capacity available today

Both new guides place `Your list, up to 50,000 a file` under **What comes across on its own**, with a **Working today** badge. They mention that paid plans are not on sale but do not explain the effective shared monthly row admission. They also advertise 20,000 past buyers per file. `MOVE_CAPABILITIES` checks `IMPORT_LIMITS` and the pure `startProblem`; those do not establish that the upload can pass the actual route's separate row budget.

The independent proof uses a real synthetic owner/session, real studio authorization and **POST `/api/store/import`**, without mocking its admission, overriding a quota or changing any flag. For the same planless store and same 50,000-row contacts job:

1. `start`: HTTP **200**.
2. Upload exactly the existing **1,000-row** monthly allowance: HTTP **200**.
3. Upload one further row: HTTP **429**, `error: "rows_month"`, `limit: 1000`.

The authenticated, same-job within-budget control rules out an authentication/store/general gate failure. The refusal comes from `takeImportRows`/`importRowsFor`, used by the real route. Existing `IMPORT_ALLOWANCES.creator.rows` is 1,000; rows are shared across kinds. The largest existing paid monthly figure is 20,000. No value was changed for the proof. The public file parser ceiling must not imply that all those rows can actually be brought over today. Explain the effective existing import allowance and qualifying conditions in the guides, with a test of that sentence against route admission; changing policy is not requested or authorized.

### LOW — The multi-price prohibition excludes courses the product actually grants

Both guides say: **Calls and products with several prices cannot be given to past buyers/students.** The existing classifier explicitly permits multi-price courses and podcasts. The proof creates a real synthetic course with one saved lesson, attaches it to a product, and adds two options using existing setters. A real purchases import without email completes with `state: "done"` and `counts.added: 1`.

Using the freshly re-read post-import store, `importedFor` confirms the stored grant and the actual `paidCourses` entitlement reader includes that product. Thus this is an actual completed import and recognized course entitlement, not just a preview/classifier result. Keep the real prohibition for calls and multi-price downloads, but describe the existing course/podcast exception. No course page/browser visit or payment was executed.

## Reproduction, controls and limits

Before execution: at most **60 cases per process, 5,000 synthetic commands, 120 seconds, 256 KiB captured output and zero provider HTTP**. The runner enforces the command ceiling before each in-memory Redis pipeline, and loads reviewed modules from exact native Git objects in memory. Its fetch guard prevents provider requests; existing linked tests use their synthetic services. No full suite, browser, axe, deployment, account, message or provider action was run.

```sh
node scripts/t-review-3012.mjs 1ee4aa36d230268a395384c6fc66a21b74fbee3d t-3012-migration-guides.proof.ts
node scripts/t-review-3012.mjs 2cd975751dc3ab27c6b4168fd3e4088fdcb67de3 cf2-move-pages.test.ts
node scripts/t-review-3012.mjs 1ee4aa36d230268a395384c6fc66a21b74fbee3d cf2-move-pages.test.ts
node scripts/t-review-3012.mjs 1ee4aa36d230268a395384c6fc66a21b74fbee3d feature-mechanisms.test.ts
node scripts/t-review-3012.mjs 1ee4aa36d230268a395384c6fc66a21b74fbee3d clickfunnels-import.test.ts
```

| Execution | Actual result | Synthetic commands |
| --- | --- | --- |
| Own causal copy expectations | Two cases, two failures, including successful controls described above | 159 |
| Original author RED | Bundle fails because the new migration module does not exist; no runtime assertion count claimed | No runtime |
| Final author test | 58/58 pass | 0 |
| Existing feature mechanisms | 2/2 Node tests pass | 0 |
| Existing ClickFunnels import behavior | 56/56 pass | 501 |

The original author test is **not byte-identical** to final: one assertion changed from checking each body for its limit to checking title plus body. The figure is visibly in the title, so this is a location adjustment, not proof that the advertised effective capacity is correct. Both snapshots and the missing-module original RED were examined. No claim of 58 executable original RED failures is made.

An initial own fixture read an old pre-import store snapshot whose `pastBuyers` flag was false; that observation was excluded. The final fixture re-reads the persisted store and requires both the actual grant and entitlement. No production code or expectation was relaxed. The two final failures are unmet copy expectations, not failing healthy runtime controls.

## Remaining verification and source boundaries

- All six changed files were read. The two new pages enter the existing feature-page mechanism/sitemap machinery without menu entries; ClickFunnels is reused. No existing runtime import implementation changes in this PR.
- Scoped strict **actual ES2017** TypeScript passed with no diagnostics. A temporary config extended the repository config, set `strict/noEmit` and `incremental: false`, and included all three changed production roots, both canonical TS tests, the own proof and actual imported dependencies. Command: `node_modules/.bin/tsc --project "$type_config" --pretty false`; temporary config removed.
- ESLint over the six author paths plus the two executable evidence paths passed; the final own-path lint also passed after adding the entitlement assertion. The changed browser script passed `node --check`; no browser result is inferred. The recovered read-only dependency versions match the exact lock: TS 5.9.3, esbuild 0.28.2, ESLint 9.39.5, eslint-config-next 16.4.2.
- `python scripts/check_public_data.py` passed: 4,141 tracked files, zero requiring correction, including the three staged review artifacts. Staged `git diff --check` passed.
- **Static observation only, not another executed finding:** the guide says every excluded row is listed with its number/reason. `note` and `reportCsv` cap detail at existing `MAX_REPORT_ROWS=5000`, with an explicit summary for further unlisted rows. No 5,001-row report execution was performed; do not report one.
- **External research supplied by the root coordinator, not execution here:** on November 6, 2026 the named `help.gumroad.com/article/268-customer-dashboard` and `/74-the-analytics-dashboard` URLs redirected to generic `gumroad.com/help` in the web tool. The indexed canonical article URLs use `https://gumroad.com/help/article/...`. This supports a cautious LOW source-link observation, without claiming every real browser behaves identically. The root's official-source research corroborates UTC/date-buffer/Do-not-contact guidance and Teachable's owner-email/user-export and individual-file course-export steps. Transaction-export email versus device download differs by current Teachable flow; do not call a universal falsehood. These are external research notes for the coordinator's final review, not substitute runtime evidence.

Logs retained in `/tmp/t-3012-{proof,red,head,mechanisms,linked-import,types}.log`. No formal GitHub review was submitted by this worker. Exact-head checks, merge and publication remain the author's separate obligations.
