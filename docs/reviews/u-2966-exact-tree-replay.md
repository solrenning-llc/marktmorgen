# PR #2966: exact-tree replay of the existing Codex U review

Reviewed author head: `39bf1e569f8b5b14d231495bc2d3d90f1dbfe907`.
Evidence checkout: `f415808cf951c3a30f1cf35205f77bded638aa61`, tree `d8abd32f9c9d5281c375bc482047a9d4b53c058d`.
Executed on 7 November 2026 (Fortaleza), Node v24.22.1.

## Provenance correction

The earlier review used reconstructed author files and an equivalent minimal redis-reply helper. That limitation is recorded in PR comment 6698675296. Those earlier results are not relabeled here.

This new run used a native Git checkout of the evidence branch. The complete tracked diff from the author head consists solely of `tests/u-review-2966-transparency-proof.test.ts`. The worktree was clean before and after execution. No author source or helper was replaced. Shared installed dependencies were used; package.json and package-lock.json do not differ between the reviewed head and the previously validated main snapshot da782411. This is not an independent clean dependency installation.

Executed source blobs:

| File | Blob |
| --- | --- |
| app/transparency/page.tsx | 6e6ac3b3cd88203593ed65cfdb25608552f8dfff |
| lib/transparency.ts | 4c600bf518cb6afd49d0ac9d5d08d23767fe5c02 |
| lib/redis-reply.ts | ae47ea176947eb051f3df72c2271b261ec5d56c6 |
| tests/honest-transparency.test.ts | 324933ac9190fb2036010d0b2e6aff0a3298bb51 |
| tests/u-review-2966-transparency-proof.test.ts | b84fa9d3fe3c6c14520ab57b6dc906d5ce2aabff |

## Result

The corrected independent proof completed **8 checks / 5 failures + 3 passing controls**:

- Impossible day 2026-99-99 is returned as valid.
- The page throws RangeError: Invalid time value for that day.
- Future start day 9999-01-01 is returned as valid.
- Unknown hash field notice:copyrigh is accepted and known counters become zero.
- Duplicate notice:copyright fields are accepted with last-value semantics.
- Positive unread control GET [7] passes.
- Confirmed absence passes.
- A valid day with an empty year hash passes.

The page assertion now preserves successful HTML, unlike the defective historical version 51be878e. Its positive unread control proves it can pass.

Linked exact-source executions: honest-transparency 21/21; transparency 11/11; takedown 20/20; takedown-response completed with exit 0. The independent proof remains red separately; linked success does not clear the finding.

Selected-root strict TypeScript: 3 roots, 0 diagnostics. Directed ESLint: exit 0. Public data scanner: 4,134 tracked files, 0 corrections. git diff --check: exit 0.

## Reproduce the independent proof

Run from this evidence checkout with the repository dependencies installed:

```sh
node node_modules/esbuild/bin/esbuild tests/u-review-2966-transparency-proof.test.ts --bundle --platform=node --format=cjs --outfile=/tmp/u-2966-exact.cjs --alias:@/lib/redis=./tests/redis-stub.ts --alias:@=.
node /tmp/u-2966-exact.cjs
```

Expected exit: 1, with 8 checks and the five named failures above.

## Verdict and limits

The existing MEDIUM in review 5807744601 remains OPEN. The exact-source replay now substantiates it without reconstructed source files. Validate real calendar dates and reject future days, unknown fields and duplicate fields; retain healthy absence controls. The author's final correction still requires focal review and replay.

No browser, screen reader, live Redis, provider, financial, legal, CI or complete-accessibility certification. No real email or external network call by the tests, author ref change, CI operation, product edit, merge or deployment.
