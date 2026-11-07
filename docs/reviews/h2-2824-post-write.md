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

The product branch remains unchanged at the above head while this RED is
preserved on the existing `codex/h-email-sync-disconnect-red` branch.
