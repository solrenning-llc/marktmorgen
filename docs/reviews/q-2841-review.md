# Independent review of #2841

Reviewed product head: `62f243d3e836040422a178fa933fd39f42ace680`.
Announcement and evidence-path reservation receipt, before reading the diff: channel commit `70ea61a44330b128110cde7ed05bf61579cf2df5`.
All five changed-file patches were read. Author source, branch, PR, reservations and CI were not changed. No CI state or logs were consulted.

## Finding: medium — unknown product totals become an assertion of absence

Location: `app/studio/reviews/page.tsx:208-211`, new empty-state title and sentence.

The new heading says **“No product totals yet”**, followed by a sentence saying the product appears once it has a review. This state is also reached when the existing `summaries` reader cannot establish the totals: `lib/reviews.ts:198-208` turns a missing, null, object, textual or truncated HGETALL response into an empty Map; invalid summary JSON also becomes zero counts through `parseSummary`. Consequently, a store with five saved reviews is told that it has no product totals yet.

The reader's permissiveness is inherited. The regression in this PR is replacing the previously neutral “No product review totals are available in this view” with an assertion about absence. The same six independent vectors pass against the pre-implementation RED commit `1f9c212cc8` and fail against the reviewed head. Keep the wording neutral unless a known empty result has been established, or represent unavailable totals separately. This review does not authorize changing the occupied reader.

Durable reproducer: `tests/q-2841-empty.proof.ts`; launcher: `proofs/q/review-2841.mjs`.

```
TMPDIR=/dev/shm node proofs/q/review-2841.mjs
# reviewed head: 10 tests, 4 pass, 6 fail

Q2841_NAME_PATTERN='unknown real summaries' TMPDIR=/dev/shm node proofs/q/review-2841.mjs
# pre-implementation 1f9c212cc8: 6 tests, 6 pass
```

The proof renders the actual blog/reviews page functions and uses the actual persisted-summary reader against MemoryRedis. Auth, unrelated service reads, the catalog listing and editor widgets are explicit synthetic boundaries. The control first writes five reviews' aggregate totals and verifies the real reader produces the product and “5 counted”; only then does each vector inject an unknown HGETALL envelope. No real provider or person data is used. The inherited ask-link visibility also reacts to a malformed empty Map; that pre-existing behavior is not presented as a second regression.

## Validation

- Author RED `1f9c212cc8`: 31 checks, 16 failing; run before head tests.
- Reviewed head: 14 canonical linked files, 294 passing checks: wg16-studio-empty 32; wg16-empty-state 31; empty-screens 6; reviews-faq 14; review-ai-summaries-studio 30; review-overview 14; review-themes 13; review-qr 8; review-ai-summary 82; phone-preview 24; ai-writing-faq 11; review-summary-unavailable-page 3; blog-read-unavailable-page 10; accessibility-inventory 16.
- Independent controls: actual blog h1/h2/h3; all three creation links individually fed into the actual page's query route and reaching the new-editor slot; action hidden while writing; unread blog and existing post stay unavailable; reviews queue/all/off-page/unknown distinctions; settings-role action visibility; actual focusable jump target; known persisted product totals. All four control tests pass.
- ESLint on all five changed files and the independent proof: clean. `git diff --check`: clean.
- The canonical public-data script was attempted but stopped on a missing tracked `.github/dependabot.yml` outside the sparse checkout. It is not reported as passed. A separate canonical-pattern scan of the five changed files and three proof files reports zero findings.

## Limits

An optional Chromium test of the actual server-rendered anchor was attempted. Chromium could not launch: `process_singleton_posix.cc` reported `socket() failed: Operation not permitted`. Browser focus behavior is therefore unverified here. The proof checks the real markup, not an authenticated Next deployment or a real browser journey. No global TypeScript run, native Redis, real service, screen reader, human accessibility study, rendered contrast measurement, zoom/reflow/forced-colors matrix or complete AAA audit was performed. This is PR testing, not a claim of deployment or customer availability.

Original disposition: changes requested for the medium truthfulness regression; no other grave or medium finding established.

## Corrective return — 105f3e3839dda6311980a22cd9f2e59def1ca335

Return announcement receipt, before reading the new diff: channel commit `dc64b99f6b92de304290b31b2305700a73263945`, blob `ccbbcb7d77cebdfefb410bea001347ef14becb6d`.

The entire four-file delta from the original reviewed head was read. The sole product change restores the neutral sentence “No product review totals are available in this view” and removes the unsupported empty-state heading and prediction. The existing permissive summary reader is unchanged. This resolves the reported medium regression.

The author copied the launcher byte-identically (`1058d18bd0baac022ae63f0031e638cc19e1bc92`) and copied the independent test with one explicit contract correction: its zero-state control now expects the neutral sentence instead of requiring the removed h2 “No product totals yet”. The six adverse envelopes and their expected results are unchanged. The studio component test similarly replaces the assertions requiring that heading/empty-state component with the neutral sentence. These changes reflect the requested fix; they are not a new defect or weakened adverse assertions.

The original independent proof remains byte-identical: `d5bbd85a60024bdee1d62d79ba6ca5b2dacf7230`. It was replayed with the original filter and all six vectors passed. The local evidence checkout stayed based on `c33f9576476531e19fbd424293def0463a87b6eb`; the two changed product/test files were restored from the corrective head into this reviewer's worktree. Their exact Git blob hashes were checked against the corrective commit: reviews page `abd56062bc20403eb2a380fcc9c3f8908bf04610`, studio test `99fa56cd33ad59eb8ed8c9c2564d4e12c7b41b12`. All other product files are identical between these commits. This preserves the original independent proof while executing the corrected product source.

```
git restore --source=105f3e3839dda6311980a22cd9f2e59def1ca335 --worktree -- app/studio/reviews/page.tsx tests/wg16-studio-empty.test.ts
Q2841_NAME_PATTERN='unknown real summaries' TMPDIR=/dev/shm node proofs/q/review-2841.mjs
# original proof d5bbd85a: 6 tests, 6 pass
```

The author's adapted proof `f93331a0d` also passed all 10 tests when loaded directly from its corrective Git blob with an esbuild onLoad boundary; the original local test was never replaced. Four pertinent canonical files passed 54 checks: wg16-studio-empty 31; empty-screens 6; reviews-faq 14; review-summary-unavailable-page 3. ESLint on the changed page, changed studio test and preserved independent test was clean; `git diff --check` was clean. Browser, public-data and global types were not rerun; the original verification limits still apply. Author branch, PR, CI, channel and reservations were not modified by this return.

Corrective disposition: the medium is resolved; no new grave or medium finding established. **May merge**, subject to the coordinator's normal required checks. This is a source-and-tests review of the exact corrective head, not a deployment or customer-availability claim.
