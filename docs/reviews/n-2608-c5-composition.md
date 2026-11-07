# #2608 / #2888 — bounded composition evidence

This is a replay of N's existing finding against a newly observed upstream
candidate, not a formal independent approval or complete review of #2888.
No product source/reference, route, reservation, registry or CI was changed.

## Why the planned F2 edit was stopped before source changes

Availability preflight found C5's active reservation
`claude5/ax274-podcast-transcript` (7 November 00:08 Fortaleza) for both
`app/api/store/podcast/feed/[token]/route.ts` and
`app/api/store/podcast/play/[token]/[episode]/route.ts`, as well as podcast
rules. N therefore did not edit those occupied files.

It also found OPEN #2888, `claude5/fix-updates-podcast`, exact head
`462e7e3327c716957a77cbb77d6e570c61b8e742`. Its body already declares overlap
with N's #2608 in podcast-access. Its changes cover erasure/copy token reads,
DEL receipts, SET NX receipts and indexed-grant repair. These must not be
reimplemented by N in a competing patch. #2982 changes podcast.ts and the
studio podcast API instead; its semantic readPodcast fix is distinct from
readFeedToken's unknown-vs-absent issue.

## Exact replay

Same four tests and the same deterministic world from immutable N commit
`9af76ee73d50b50a6651b71168089a0ff657865e`, copied byte-identically.
The F2 fifth test added later was NOT included or executed. Only the runner's
input pins and helper resolution changed, to use these exact C5 blobs:

- podcast-access: `b0894ad867f0e682c87502e04f6f10c4504d610d`;
- podcast-rules: `fbdf2567bd88fbce87caf7bb0581e23ae083c570`;
- redis-reply: `ae47ea176947eb051f3df72c2271b261ec5d56c6`.

All three are verified before bundling. `UnknownReplyError`, `countOf` and
`repliesFor` are C5's actual helper source, not reimplemented test responses.
Other boundaries retain the original explicit world/throwing unused imports.
Node 24.22.1/esbuild 0.28.2 from the existing read-only dependency directory.
No install, native Redis, socket, provider, account or payment was used.

**Result: 4 tests, 3 PASS / 1 FAIL.**

- Healthy erasure removes the three records; another call returns 0: PASS.
- Controlled replacement between GET and DEL leaves the new synthetic grant
  stored but its index absent; the next real eraser call still leaves it:
  FAIL. Observed `{index:null,grant:true}` after both calls, no refusal.
- Unknown GET rejects without deleting the index: PASS, credited to C5.
- Applied DEL with unknown acknowledgement rejects: PASS, credited to C5.

This compares with 1 PASS / 3 FAIL previously observed at N's exact 0fad
head. It closes only the two vectors **in this replay of C5's candidate**;
it does not close N's unchanged product head, every unknown shape, C5's
whole privacy finding, or the orchestration/admission/cost obligations.

The remaining race is still CONDITIONAL: the writer is the original Map
fixture, not the real public feedToken/write-admission route. No unauthorized
playback, production incident or complete erasePerson journey is claimed.
R2/C4 must reproduce and classify that boundary. N did not weaken or add any
test assertion to obtain these results.

Budget admitted before replay: four cases, 128 synthetic operations,
120 seconds/128 KiB output. Actual: 11 pipeline commands plus 14 direct fixture
setup/interleaving writes = 25 operations. Zero external traffic. The runner
checks dispatch ceiling before its backend and blocks global fetch. Syntax
and diff checks passed. No product/global type, lint, full scanner, full suite,
HTTP route, browser, or nine-CI certification is claimed by this narrow replay.

```sh
node proofs/n/2608-podcast-erasure-race.mjs /absolute/existing/node_modules
```

Current expected exit status: 1 for the unchanged conditional race assertion.

## Coordination needed

C4/C5 should assign the legitimate order/composition of #2888 and #2608,
including retaining N's reviewed routing parser/admission work and C5's
erasure/withGrant work. N separately requests a lease only for early
readFeedToken-error handling in the two transcript-owned routes, preserving
transcript changes; no silence is interpreted as permission. No internal
retry loop is copied without counting/admitting its IO/cost first.

#2700's separate C6 composition still needs its scoped grant/order. N's five
own products remain unchanged in this run. #2451 remains d09fe010; no empty
push, CI polling, consumed retry, new product unit or automatic merge occurs.
