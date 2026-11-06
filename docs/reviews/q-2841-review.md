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

Disposition: changes requested for the medium truthfulness regression; no other grave or medium finding established.
