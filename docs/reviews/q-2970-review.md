# Independent Q review: #2970

Frozen PR head: `69d9ba69868e6bdba0d56ccbf54d14b7d9333efa` (OPEN, not draft at preflight; no reviews, comments or requested reviewers). Author RED: `7f23b349667f17db89548b2eea004ed1dc70e283`. Source parent / merge base: `5c07315505e1d53ee6401021601cd688fa98ecda`; the preflight base snapshot was newer, `8f73f9d31b1cc912bb127ce9259601d739732981`.

The coordinator announced this exact head and reserved these three evidence paths before diff/source/test access: channel commit `b4eb3fa1bdaaeb7bfd9dacab635ef9406b0a7c19`, blob `706954ec58b88dd24f6f0b8af74bbaf7fe3529c6`. Q read the applicable main instructions and the entire two-file diff (80 additions, 2 deletions). Only independent evidence is changed. Formal review and channel disposition belong to the coordinator.

## Result and residual finding

**Proposed LOW, inherited and conditional on malformed transport replies:** an unread store still silently becomes the all-stores request form when a successful synthetic Redis HTTP response has no result slot. The fix correctly distinguishes a rejected store read from confirmed absence. It does not distinguish a fulfilled but incomplete response from that absence.

At `app/privacy/delete/page.tsx:63–72`, only a rejection sets `storeUnread`. The unchanged `lib/store.ts:1194–1202` destructures each pipeline result without checking that its slot exists. A handle lookup returning `[]` or `[undefined]` yields `null`; a missing owner-record lookup also parses as `null`. The real REST decoder (`lib/redis.ts:25–56`) accepts JSON `[]` and maps `[{}]` to `[undefined]`. None of these paths rejects. The page therefore has no unread notice/status, restores the instruction to use the same store-footer link, and posts a hidden `scope=all` instead of the healthy default `scope=store`.

The causal proof uses the real page, `storeForHandle` and production Redis HTTP-result decoder, backed by MemoryRedis only at a synthetic HTTP boundary. It injects literal HTTP-200 JSON `[]` at the handle or owner lookup, and `[{}]` at the handle lookup. No ordinary Redis null is relabeled unknown. The positive absence control uses the real missing-key null from MemoryRedis and retains the existing all-stores page, as intended. The exact same proof bytes and desired assertions run on RED and final:

| Scenario | RED unread notice | Final unread notice | Final hidden all-stores scope | Final loop instruction | Commands per version |
| --- | --- | --- | --- | --- | ---: |
| `healthy` | false | false | 0 | false | 6 |
| `handle-throw` | false | true | 1 | false | 5 |
| `owner-throw` | false | true | 1 | false | 6 |
| `handle-empty` | false | false | 1 | true | 5 |
| `owner-empty` | false | false | 1 | true | 6 |
| `handle-missing-result` | false | false | 1 | true | 5 |
| `absent` | false | false | 1 | true | 5 |
| `recovery` | false | true | 1 | false | 7 |

RED: 8 tests, 6 desired-invariant failures, 2 healthy/known-absence controls passing. Final: 8 tests, 3 desired-invariant failures, 5 passing. The three residual failing assertions require an unread notice for the incomplete response; they do not assert the observed failure as desired behavior. Rejected handle reads, rejected owner reads and recovery of the same store URL are fixed. Recovery returns the scoped default on the same URL after the synthetic connection failure is removed.

This is a narrow request-page reliability/scope-presentation issue, not a demonstrated deletion beyond a person's confirmed grant. Every own case observes zero page writes and zero confirmation actions. The page's wider request remains separated from deletion by an emailed link and an explicit confirmation page. `app/api/privacy/erase/route.ts:30–38` chooses the request handle from the submitted scope; `lib/erasure-request.ts:234–249` resolves the grant's exact store list; the page lists those stores before its confirm action; `confirmErasure` iterates `grant.s`, retaining unresolved stores. No claim is made that a healthy remote Redis service normally produces these malformed responses, that anyone's data was actually deleted, or that a legal or financial consequence occurred.

The PR description says the form is not offered with a wider scope, but the actual fix keeps the all-stores request form and explicitly explains that alternative in its notice. This wording discrepancy alone is not a second finding. The implemented improvement is that thrown reads no longer widen the request *without a word*. The conditional residual above is supported by the production decoder and real page observations, not by treating the PR title as a complete contract.

## Original author evidence and linked checks

The new author test `tests/honest-privacy-delete.test.ts`, frozen blob `c75735c13f31c60a486b4213aac919e2c0163e4f`, is credited to its author. Q independently ran its unchanged bytes on both source versions: RED has 5 checks / 2 failures / 3 controls; final passes 5/5. Q did not rebrand that original result as a new finding.

Final focused consumers:

| Existing test file | Result |
| --- | --- |
| `erasure-confirmation-page.test.ts` | exit 0; forged/verified/tampered receipt rendering assertions pass |
| `erasure-grant-evidence.test.ts` | 2 Node tests pass |
| `erasure-preview-recovery.test.ts` | 4 Node tests pass |
| `erasure-request-full.test.ts` | 21 checks pass |
| `erasure-request-scope-all.test.ts` | 11 checks pass |

The last two initially failed only because the minimal projection lacked their native `readFileSync("app/privacy/page.tsx")` fixture. That exact file was materialized from the frozen head and only those failed setup cases were rerun. Other passing tests were not repeated. The selected consumers exercise unverified completion, retained exact grants, temporary preview failure/recovery, request capacity and uniform public responses. The separate directory-scanning/static inventories (`email-site-fields`, person-data registry, security page) were identified by source search but not run; no broad-inventory or full-suite result is claimed.

## Scope, cost and accessibility

The production diff adds error tracking, a notice and conditional text. It adds no Redis command or new provider call. Own matched cases use the same 5–7 commands on RED and final; these counts include fixture creation. Source search found no changed-file reference in `tests/plan-cost-registry.test.ts`. No margin certification or provider price/account assumption was made.

The real server element tree has one `role="status"` notice on each fixed rejected-read branch, and no such notice for healthy/confirmed-absent controls. Text is explicit and does not depend only on color. The main request still asks for an address and submits an emailed-link request; its changed failed-store state explains the wider alternative. No browser, keyboard, screen reader, contrast, focus, zoom, human usability or AAA compliance was tested. The presence of `role="status"` does not independently certify an assistive-technology announcement.

## Execution and reproducibility

Own budget is exactly at most 8 distinct scenarios, 2,000 explicit commands per scenario, 16,000 total, 120 seconds per file and 256 KiB stored output per file. The executable proof checks both command ceilings and the scenario count. Actual own use: 45 commands per source version, 90 total, 5–7 per scenario. The eight scenarios are the same on both versions. The own proof performs no erasure, provider call or database write while rendering the page; synthetic fixture creation is counted separately from observed page writes. All HTTP requests terminate inside a mocked fetch handler that permits only `https://q2970.invalid/pipeline` and delegates commands to MemoryRedis. It exercises the production REST decoder without making a real HTTP connection; no native Redis or deployed service is certified. Existing linked tests retain their supplied synthetic transport and in-memory fixtures.

The owned disk projection is `/workspace/scratch/q-review2970-privacy-scope`. It uses a read-only Git object alternate to the coordinator's shared clone, plus its own immutable head fetch with `--no-write-fetch-head`; shared refs/index/source and the earlier #2860 evidence were not changed. Exact imported source bytes and required native fixtures are projected from Git. esbuild uses the repository's test aliases and `jsx: "automatic"`, emits with `write:false`, and the CJS bundle is passed on stdin. Only the Q proof overrides the Redis alias to the production `lib/redis.ts`; author and existing tests retain the standard MemoryRedis alias. The test's incomplete-JSON injection therefore crosses the production HTTP decoder rather than bypassing it at the page API.

Reproduction requires Node 24 (used: v24.22.1), Git, esbuild and compatible repository test dependencies. A normal checkout can use its own installed dependencies. A fresh owned projection may instead create its own `node_modules` symlink to an existing dependency directory, e.g. `ln -s /absolute/path/to/existing/node_modules node_modules`; never replace or clean another checkout's dependencies. Set `Q_REVIEW_REPO` to a local source repository containing the selected immutable commit and its imported blobs. The runner sets `GIT_NO_LAZY_FETCH=1`, so missing Git objects are setup failures rather than implicit network retrievals.

From the evidence checkout/projection:

```sh
Q_REVIEW_REPO=/path/to/local/source-repo Q_REVIEW_SOURCE_REF=7f23b349667f17db89548b2eea004ed1dc70e283 node proofs/q/review-2970.mjs honest-privacy-delete.test.ts
Q_REVIEW_REPO=/path/to/local/source-repo Q_REVIEW_SOURCE_REF=69d9ba69868e6bdba0d56ccbf54d14b7d9333efa node proofs/q/review-2970.mjs honest-privacy-delete.test.ts
Q_REVIEW_REPO=/path/to/local/source-repo Q_REVIEW_SOURCE_REF=7f23b349667f17db89548b2eea004ed1dc70e283 node proofs/q/review-2970.mjs q-2970-privacy-scope.proof.ts
Q_REVIEW_REPO=/path/to/local/source-repo Q_REVIEW_SOURCE_REF=69d9ba69868e6bdba0d56ccbf54d14b7d9333efa node proofs/q/review-2970.mjs q-2970-privacy-scope.proof.ts
```

The Q proof intentionally exits 1 for the residual desired-invariant failures. No product source or author test was weakened to make it green. No CI was read, retried, canceled or changed; no global TypeScript, lint, client bundle audit, full suite, production deployment or customer availability was certified.

Frozen source identity: page blob `b5993aee5f3d0d210ab98be49ec20c6111db47a8`; Redis decoder blob `3a6aaa809fc78bfe1202e44a6c5fdd8abb02bac6`; store reader blob `5f84d8564cfca3bb89c12a85de7b70fdca4fcbc1`.

## Local receipts

Complete logs are retained locally; the causal observations and runnable proof above are the published evidence. SHA-256 receipts include the setup failures rather than concealing them.

| Log under `proofs/q/` | SHA-256 |
| --- | --- |
| `author-red.log` | `17ba3b88abe3111a9a83892e47b95b5318a0794d9bbe7c160064b1a0208d0862` |
| `author-and-linked-final.log` | `645620c41bc0e7b88ecdd0b20a2e7ba9bc5c5a0dcd7e70b77b625625fb34ccd3` |
| `linked-fixtures-final.log` | `04016eb2f249a8a823a871927209fcfea7371d4cc5b9dfb8d46c8fc35439255e` |
| `own-red.log` | `aaeb502846fb83d762a31b5c4b0f065e5e8e04d14bcdc4609050e30cf764478b` |
| `own-final.log` | `df8089c3fcd7704eff8d67ea705dd5f08a1332c3cd62374afde1ed36ccab48a5` |
