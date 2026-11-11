# H2 focal correction evidence for #2824

Independent finding: Claude 5, comment 6701875994, product
`0adf6bbe1dc3bfe87bf8d6f46dbc8f1ba71ff7f6`.

Before any product correction, the unchanged product with the extended
`email-sync-exact-view.test.ts` produced **36 checks, 10 failures**. The
native route harness added **7 checks, 5 failures**. Total: 43 checks,
15 failures, 43 synthetic Redis pipeline commands. The connect route returned
500 while its configuration existed, and scheduled no connection security
notice. Save and both positive/negative connection tests also threw after
their writes. The negative test retained its bad-key record despite the throw.
The three invalid configuration-cell cases and invalid problem-cell case
also failed. Known-null, normal exact reads and original action controls passed.

Command, from this repository (Node 24.22.1):

```sh
node --max-old-space-size=512 tests/h2-2824-post-write-native.mjs
```

The runner executes the real email-sync source, POST route, secret-box crypto,
platform HTTP/safe-fetch and MemoryRedis. Auth normalization, store-reference
writes, catalog lookup, paid admission, request admission and notice delivery
are explicit synthetic boundaries in the launcher. Provider requests go only
to the permanent test's loopback HTTP server through the platform's test hook.
It awaits the permanent test entry point without changing its assertions.
It is **not** proof of authentication, paid funding, a delivered notice,
full Next.js behavior, browser rendering, semantic TypeScript, lint or build.
The editor check is a narrow source assertion, not a render test.

Execution ceiling: 150 assertions, 20,000 synthetic commands, 120 seconds,
512 MiB heap, no real provider or customer data. Actual RED ended in under one
second. An unavailable view is never retried by the proposed correction.

At initial RED preservation, the product branch was unchanged at the above
head. The evidence is on the existing `codex/h-email-sync-disconnect-red`
branch: initial `c932f6d1`, completed route evidence `9405d95d`.

## Local correction

`viewAfterWrite` attempts the existing display read once. If it fails, it
projects only the configuration already written, retains unknown history as
`log: null`, and marks a connection status not established by the action as
unavailable. Successful connect/test retain their confirmed cleared problem;
the negative target test retains its confirmed problem. No new Redis command,
provider request, allowance, price, flag or retention is introduced.

The generic removal notice now also runs when the previous label was unknown;
known absence still produces no duplicate notice. The Last sends warning is
neutral about whether a connection exists. Non-string/non-null config and
problem cells throw as unknown rather than becoming absence.

Validation on the local correction:

- Same native proof: 36/36 permanent checks plus 7/7 route checks; 43 synthetic
  pipeline commands, matching RED. Actual notice delivery remains stubbed.
- Official test aliases/environment and esbuild, full reachable graph:
  `email-sync-exact-view` RED 36/10 failures -> GREEN 36/36;
  `email-disconnect-idempotent` RED fails the new unknown-label notice
  assertion -> GREEN node:test 1/1. Existing auth, origin, size, admission,
  legacy-id, absent-connection and confirmed deletion controls remain present.
- Linked `l10b-email-sync` 18/18, `email-platform-faq` 16/16,
  `sg2-l8-watch-resync` 16/16.
- Strict semantic/syntactic diagnostics for five changed TS/TSX roots,
  795 imported source files, actual dependency types: 0 diagnostics.
  This is scoped verification, not a global tsc/build. The first directed
  pass found TS7022 on the new notice-counter assertion; an explicit number
  annotation resolved it without changing the assertion.
- ESLint on six changed code/test/launcher paths, max-warnings 0: clean.
  One unused launcher counter was removed before the final lint pass.
- Public-data scanner: 4,155 tracked paths after adding the two evidence files,
  0 corrections; diff-check clean.

Dependencies were restored from the existing npm cache using offline install,
without lifecycle scripts or a lockfile change. Test processes use 512 MiB;
the directed compiler uses 1 GiB, bounded to the five roots. No global build,
browser, native Redis, real provider, customer data or deployed action was run.
Independent focal review and nine NEW final checks remain mandatory.
