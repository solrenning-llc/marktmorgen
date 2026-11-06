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
