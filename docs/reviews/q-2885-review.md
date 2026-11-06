# Independent review: PR #2885

Reviewed head: `b78630bac135cc6c8fe4c4a9b4556a91c870c036`.
Base and RED parent: `1721109f1d2d3930cde6c54f6fe71412648043e3`.
Author RED commit: `63c88674c44c0598b28ed183d495dad8cd8c59de`.
Review authorization and own-file reservation were announced before reading the diff in channel commit `ea4a72609f7be9ec2142dcaff91066d2e25f759a`.

## Verdict

No new HIGH or MEDIUM finding in the complete two-file diff. The transport-envelope correction works in the author's unchanged RED and in an independent authenticated export exercise. One **LOW, conditional, inherited residual** remains within the stated "unreadable is never not started" behavior: invalid serialized records are still represented as confirmed absence. This is not a regression introduced by the diff. The coordinator must explicitly disposition this residual before treating the review as clean without qualification.

The earlier Revisor 1 clean reading is credited; the execution below is independent evidence, not a repetition claimed on that reviewer's behalf. No formal GitHub review or author-ref/CI action was submitted by this work.

## LOW residual: unreadable serialized text still exports as no Path

At `lib/path.ts:165`, a string passes the new envelope check and is passed straight to `parsePath`. The parser returns null for empty text, invalid JSON and unsupported records (`lib/path.ts:105-119`). The real authenticated GET then produces HTTP 200 with `path: null` (`app/api/store/path/route.ts:78-83`), identical to a confirmed missing Redis value.

The independent proof injects `['']`, `['{broken']`, `['null']` and `['{}']` only at the existing GET of the store's Path. For each case it executes the real `readPath` and the real authenticated export GET, while the valid underlying record remains unchanged. Each case still returns reader null / export 200 / a `path` property. The same defect occurs on the base: it is inherited and conditional on an unusable serialized value, not evidence of a live corruption incident, remote exploit or healthy Redis producing bad replies.

Direction for the author, not implemented here: keep confirmed Redis null as absence, but reject a non-null string when the existing parser cannot recognize a Path. Preserve compatible legacy record parsing. The pure parser's existing null contract need not be changed to fix the read boundary.

## Execution

| Check | Base | Reviewed head | Interpretation |
| --- | --- | --- | --- |
| Author's exact RED test | 6 checks, 5 failures | Same 6 checks, all pass | Its blob is byte-identical in RED and head: `a4f2dc2bd2137436d26eef99ef6e665009052619`. |
| Independent proof | 50 checks, 24 failures | Same 50 checks, 12 failures | Twelve transport-envelope assertions are repaired; twelve semantic-record assertions expose the inherited LOW residual. No assertion was removed or weakened. |
| Eight direct linked test files | Not rerun | 228 custom checks pass | Growth record, reminder, return record, board, concurrency, studio reminder, facts and wording source. |
| Plan cost registry | Not rerun | 24 Node tests pass | Initial sparse workspace attempt was 22/24 solely because exact `vercel.json` and documentation sources were absent. Exact head files were materialized and only that check was repeated; the initial result is retained in the review record. |
| ESLint | Not rerun | 4 files, no warnings/errors | Both changed files and the two new executable proof files. |
| Runner syntax | Not rerun | Pass | `node --check proofs/q/review-2885.mjs`. |
| Actual client graphs | Not rerun | 271/271, no failures | Repository browser bundler, real sources, no server stubs or Node polyfills. This is a compilation check, not browser interaction. |

Independent scenario observations, with the same synthetic setup and assertions before/after:

| GET reply | Base reader / export | Head reader / export |
| --- | --- | --- |
| `[null]` | null / 200, `path: null` | Same confirmed-absence control |
| `[valid Path JSON]` | record / 200, real answers | Same; private revision omitted |
| `[]` | null / 200, `path: null` | UnknownReplyError / 503, no `path` |
| `[valid JSON, null]` | record / 200 | UnknownReplyError / 503, no `path` |
| Sparse array of length 1 | null / 200, `path: null` | UnknownReplyError / 503, no `path` |
| `[0]` | null / 200, `path: null` | UnknownReplyError / 503, no `path` |
| Each of the four invalid-text replies above | null / 200, `path: null` | Same inherited residual |

Every independent scenario reached both real Path reads, used seven synthetic Redis commands, and retained the original valid source record byte-for-byte. Authentication uses the actual session and creator access functions. Only Redis is replaced for this path by the repository's MemoryRedis fixture; the runner also preserves the repository's standard test aliases. External fetch is forbidden by the runner. The proof uses no real account, secret, provider, payment or customer data.

## Consumer review and limits

The complete diff changes `lib/path.ts` and adds `tests/path-read-exact.test.ts`. I also read the existing direct consumers: start/visit/join/leave in `lib/path.ts`, Path reminder and studio invitation helpers, the export/POST route and both studio Path pages. Export catches a thrown read as 503; the pages have explicit failed-read states; reminders catch it as unavailable. Existing catch/fallback behavior in other callers was not rewritten or certified globally.

The new test's introductory comment says the board route answers 503. The existing POST outer catch actually answers 500 (`app/api/store/path/route.ts:66-68`); both refuse the operation. This is a documentation accuracy note, not a new MEDIUM data-loss finding, and the authenticated runtime proof here exercises GET rather than POST.

No strict TypeScript project check, browser interaction, screen reader, native Redis/Lua, production deployment, logs, complete CI run or profitability review was performed. Esbuild execution and the real client graph compilation do not replace those checks. The productive diff adds no Redis command; the independent proof does not establish complete provider or company funding. No price, visible limit, policy, gate, provider, account or productive source was changed by this review.

## Reproduce

From a checkout of the reviewed head with its normal dependencies:

```sh
git show 1721109f1d2d3930cde6c54f6fe71412648043e3:lib/path.ts > /tmp/q-2885-parent-path.ts
node proofs/q/review-2885.mjs --author --parent-source /tmp/q-2885-parent-path.ts
node proofs/q/review-2885.mjs --author
node proofs/q/review-2885.mjs --parent-source /tmp/q-2885-parent-path.ts
node proofs/q/review-2885.mjs
node proofs/q/review-2885.mjs --linked
```

The independent proof intentionally exits nonzero on the inherited residual. Reproduction must preserve the failures, controls and exact reviewed source; it must not relabel that run as fully passing.
