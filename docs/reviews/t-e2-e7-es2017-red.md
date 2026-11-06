# E2 and E7 — durable ES2017 type RED

Reservation: `61533c47a2d67fe66d1a3294deb5d56ca9aa5330`. Evidence-only branch: `codex/t-e2-e7-es2017-red`. Base: `5c07315505e1d53ee6401021601cd688fa98ecda`.

## Observed failure

The original product module and test from each exact snapshot were checked with that snapshot's actual repository `tsconfig.json`. Both checks produced precisely one error:

| Unit | Original snapshot | File and location | Diagnostic |
| --- | --- | --- | --- |
| E2 | `149a6fdf0c2808f525601cb5588674ebcf1a1abd` | `tests/community-challenge-rules.test.ts:82:18` (`1000n`) | TS2737: BigInt literals are not available when targeting lower than ES2020. |
| E7 | `ac2c48d5de338c73d5c4d93143af8fa9deb5455c` | `tests/course-access-expiry-rules.test.ts:29:53` (`0n`) | TS2737: BigInt literals are not available when targeting lower than ES2020. |

This is a compile-time incompatibility in the test fixtures. It is not evidence of a runtime failure in either helper. Previous scoped validation with an ES2022 target did not establish compatibility with the repository's ES2017 target and masked these errors.

## Actual execution

The read-only Compiler API experiment completed in **3.13 seconds** (tool wall time 3.128746901 seconds), before the original environment was replaced. It used the installed real TypeScript package and the original local Git objects. A virtual CompilerHost overlaid only the original module and original test for each snapshot.

Compiler options were parsed directly from each snapshot; none were overridden. Observed options included:

- `target: ES2017`;
- `strict: true`, `noEmit: true`;
- `module: ESNext`, `moduleResolution: Bundler`;
- `lib.dom.d.ts`, `lib.dom.iterable.d.ts`, `lib.esnext.d.ts`;
- the remaining original JSX, path-alias, isolated-module and configuration settings.

The programs requested pre-emit diagnostics only. The host rejected writes; no emit, build-info cache, worktree, product mutation or provider request was made. Each program had exactly two root files:

- E2: `lib/community-challenge-rules.ts` and its test;
- E7: `lib/course-access-expiry-rules.ts` and its test.

## Reproduction driver

`scripts/t-e2-e7-es2017-types.mjs` packages the same CompilerHost approach. From a clone with installed repository dependencies and both original commits already available:

```sh
node scripts/t-e2-e7-es2017-types.mjs
```

The defaults are the exact original E2 and E7 snapshots above. Expected compile outcome: one TS2737 diagnostic per test and a nonzero exit status. This is the RED, not a failing provider/network setup.

For a later authorized GREEN, the same script accepts two full commit SHAs in E2, E7 order. It still reads each snapshot's real configuration and refuses a changed ES2017/strict/ESNext/Bundler/noEmit setup rather than raising the target or suppressing diagnostics.

The newly packaged CLI was syntax-checked successfully through `node --check --input-type=module` on stdin, without creating a file. **The packaged CLI has not been re-executed against the original clone:** after the recorded RED, the environment was replaced and `/workspace/scratch/369886b90de6`, its Git objects and its installed dependencies were no longer available. The original experiment's observed diagnostics above remain separate from this packaging validation. No lint, public-data scanner or full-project type pass is claimed for the packaged files.

## State and boundaries

Only this evidence document and its reproduction script are added. Product refs, both helper sources, both test literals, prices, allowances, permissions, flags and gates remain unchanged. No GREEN, repair, merge, CI pass or publication of the product is claimed. Literal changes wait for the coordinating agent's acknowledgement of this durable RED.

Accessibility: evidence-only documentation and local developer tooling; no customer UI steps or decisions changed. Descriptive headings and an explicit diagnostic table are provided. No rendering, assistive-technology testing or accessibility-conformance claim is made.

## Hosted CI causal receipts — 6 November 2026

This is additional read-only evidence from the already captured CI snapshot, not another execution or a post-fix GREEN claim. The existing proof driver (blob `589bc8ac6`) and both product PR heads remain unchanged by this documentation append.

At the historical snapshot completed **2026-11-06 22:00:01 UTC**, PR #2915 was OPEN at `149a6fdf0c2808f525601cb5588674ebcf1a1abd`, and PR #2920 was OPEN at `ac2c48d5de338c73d5c4d93143af8fa9deb5455c`. Each head returned all 35 check runs on one 100-item page: nine Documentation scope successes, two real-reader job failures and 24 queued checks. The required aggregate state was **0/9 successful, 1 queued and 8 absent** on each head. Documentation scope successes are not All checks aggregates. Raw mergeability was null/unknown on both product PRs; that is not evidence of a conflict. Dependencies #2931, #2894 and #2940 were OPEN and unmerged at that snapshot; no later gate state is asserted here.

Four job logs and their step summaries were then fetched through the GitHub job-log and job-step tools, without native execution, rerun, cancellation, provider call or another status poll. All four fail at **step 5, Run node scripts/ci-build.mjs**, after npm ci succeeds. Tooling/browser installation, real-reader configuration, reader preflight and speech assertions (steps 6–13) are skipped. These jobs did not reach browser or assistive-technology runtime; this is a compiler failure, not evidence of a reader defect, backend fault or flake.

| Product head | Runner | Run / job | Diagnostic line and timestamp |
| --- | --- | --- | --- |
| #2915 / `149a6fdf` | macOS | [42296713408 / 128175771366](https://github.com/solrenning-llc/marktmorgen/actions/runs/42296713408/job/128175771366) | Log line 201, 2026-11-06T21:58:38.0921820Z |
| #2915 / `149a6fdf` | Windows | [42296713408 / 128175771230](https://github.com/solrenning-llc/marktmorgen/actions/runs/42296713408/job/128175771230) | Log line 210, 2026-11-06T21:55:17.7865610Z |
| #2920 / `ac2c48d5` | macOS | [42296829569 / 128175069030](https://github.com/solrenning-llc/marktmorgen/actions/runs/42296829569/job/128175069030) | Log line 200, 2026-11-06T21:55:28.4846690Z |
| #2920 / `ac2c48d5` | Windows | [42296829569 / 128175068920](https://github.com/solrenning-llc/marktmorgen/actions/runs/42296829569/job/128175068920) | Log line 220, 2026-11-06T21:54:05.2756494Z |

Both #2915 jobs report exactly:

```text
tests/community-challenge-rules.test.ts(82,18): error TS2737: BigInt literals are not available when targeting lower than ES2020.
```

Both #2920 jobs report exactly:

```text
tests/course-access-expiry-rules.test.ts(29,53): error TS2737: BigInt literals are not available when targeting lower than ES2020.
```

Each diagnostic is followed by `Failed to type check.` and exit code 1. Exit lines are #2915 macOS 204 / Windows 213, and #2920 macOS 203 / Windows 223.

The logs also prove checkout provenance. #2915 macOS line 116 and Windows line 126 explicitly check out the merge of `149a6fdf0c2808f525601cb5588674ebcf1a1abd` into `5c07315505e1d53ee6401021601cd688fa98ecda`, at PV8 source `04983c21a7475955c6ba3f376c99ba93c3a0df55`. #2920 macOS line 116 and Windows line 136 explicitly check out the merge of `ac2c48d5de338c73d5c4d93143af8fa9deb5455c` into that same base, at PV8 source `2b950c01ff9bdde0db7b8355d6fbcaaf05ac6612`.

These hosted diagnostics confirm the actual build/type failures at the two authored test locations independently identified by J and K2. They support preserving the diagnostic RED and making the proposed same-value BigInt-constructor test corrections under the existing ES2017 configuration. They do not establish that any corrected head, complete build, browser matrix, real-reader path or nine final aggregates has passed. No product source, test, driver, PR head, CI run or gate was changed to obtain these receipts.

### Coordinator-reported native follow-up

After the preserved original RED, the coordinating author reports native GREEN and the follow-up product promotions `32ab` and `da698`. Those are coordinator-provided follow-up identifiers; this documentation-only worker did not execute the native GREEN or re-query those heads. The original RED and the four hosted failures above remain preserved as their historical evidence. No post-fix hosted GREEN, final independent return, nine successful aggregates, merge or customer availability is asserted by this append.
