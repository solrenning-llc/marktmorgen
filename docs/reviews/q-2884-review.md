# Independent review of #2884

Reviewed head: `585f32cffdba3ff3683bbee9404bc119c4b36507`.
Nominal base: `1721109f1d2d3930cde6c54f6fe71412648043e3`.
Announcement and evidence-path reservation, before the diff: channel commit `ea4a72609f7be9ec2142dcaff91066d2e25f759a`.

Disposition: **May merge.** No grave or medium finding established in the reviewed change. The known linked-suite failure below remains visible and is not attributed to this PR.

## Scope and reasoning

The entire two-file PR diff was read, along with the complete changed module, exact-reply helpers and daily cron caller. The PR diff uses merge base `638741bb9964c8ecb4cb542ab84753fcf6a604ce`; a direct base-to-head comparison also includes unrelated main-branch ancestry changes, which are not changes introduced by this PR.

The new read requires exactly one pipeline result, a dense own-data array of strings, and an even field/value count before constructing the seen Map. Malformed evidence throws `UnknownReplyError` before any Stripe call. Confirmed empty pairs remain valid. The existing cron caller catches the exception, leaves `disputes` null, logs the failure and returns `ok: false` with HTTP 500 when billing is configured. It therefore does not turn this rejected read into a successful completed disputes run. No new Redis command was added.

This is an envelope/shape correction. It does not claim to validate every possible semantic field value in the existing seen-memory format, resolve all existing dispute-processing errors, or certify a complete product audit.

## Independent execution

All execution used this reviewer's own isolated worktree and the repository's unchanged `testAliases` and `testEnvironment`, with esbuild compilation and a separate Node child process for each file. Redis was MemoryRedis; Stripe was each test's explicit fetch stand-in. Nothing reached a real account or payment provider.

- Author RED `a14fc31db94cc1845a62c1fdc849c90a8ae4c9eb` was confirmed as a test-only commit and executed before head tests: **14 checks, 12 expected failures**, with both healthy reread controls passing. All six malformed envelopes incorrectly returned complete and called Stripe on that earlier implementation.
- The identical author test blob `4a0ed4d8692a41be9e1c2eba4f8bb1e675a87a3a` was then executed at the reviewed head: **14/14 pass**. No assertion or expected result was changed.
- Direct linked behavior: `plan-dispute.test.ts` **66/66 pass**, including known disputes, stale open rereads, record updates, outcome transitions, page/deadline bounds and unchanged public notices.
- Exact-helper tests: `redis-reply-envelope.test.ts` **23/23 pass** and `redis-reply-proxy-check.test.ts` **7/7 pass**. They cover the dense own-slot/Proxy boundary on which the changed read depends.
- These four files total **110 passing checks**.
- ESLint on `lib/plan-disputes.ts` and `tests/plan-disputes-seen-exact.test.ts`: clean. `git diff --check`: clean.

## Known linked-suite failure, reproduced on main

`stripe-list-lot1.test.ts` ran at both reviewed head `585f32cffdba3ff3683bbee9404bc119c4b36507` and main/base `1721109f1d2d3930cde6c54f6fe71412648043e3`. Both runs reported **58 checks, 1 failure**:

```
refunds read whole and readable: the refund is made once
expected [true, 1]
got      [false, 0]
```

The test's blob is identical on both commits: `4845b14c79ee8f870bc261b4a6ee348e1eb073ba`. The failing assertion belongs to the plan-refund control, outside the two-file PR diff. No causal regression from this PR was established. The suite is not reported as green, and its assertion was not changed or skipped. An initial compile attempt lacked a component outside the sparse checkout; after materializing that dependency, the unchanged full suite executed on both commits as reported above.

## Limits and state

No global TypeScript, browser matrix, native Redis, real Stripe request, deployment check, public-data scan or client-bundle sweep was executed in this review. esbuild compilation is not a TypeScript certification. The cron failure mapping was inspected in source; the entire multi-job cron was not executed end to end. There is no new interface, and this review makes no AAA or human-accessibility claim.

Author branch, source, PR, CI, reservations and channel were not changed. The existing author RED and linked tests were sufficient; no new test proof was created without a causal finding. This report records testing at a PR head, not incorporation, publication or customer availability.
