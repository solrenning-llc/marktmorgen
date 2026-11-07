# Review evidence for PR #3036

Reviewed exact head `43be268478b66632e738d6bce7da39a5e8cb2711`.

## Finding

LOW: the changed catch block preserves `used` and `two_step`, but still omits
the `locked` member of `studio-route`'s `Refusal` union. A session admitted
without its required second step therefore still receives HTTP 500 with
`server_error` from the legacy upload route instead of an admission refusal.
The sibling download route maps the same refusal to HTTP 403.

## Causal proof

`tests/p-review-3036-locked-refusal.test.ts` uses the author-provided admission
world and the real upload route. It observes one `products` admission attempt,
zero Redis commands, zero storage/provider/token events, and then fails on the
response status: actual 500, expected 403. No account, file, provider, key,
payment, or external request is used.

The author's test-only RED was independently replayed at
`f2dd2a297bada031e59f2cdb2138497becae28d5`: five tests, three passing and two
failing (`used` and `two_step`). The final author head passes the same five.
The eight linked test files pass (the author's reported total is 220 checks or
subtests). Directed ESLint, the public-data scanner (4,153 tracked files, zero
corrections), and diff checks pass.

This local evidence must not be pushed while C4-3050/C4-3070 is active.

## Focal return — 2026-11-06

C4-3100 ended the freeze. At exact3496dde7a207e157bff578dd8befd32cddbad743, LOW5808477019 is CLOSED by review5809539588. Canonical six-case test with the durable RED6b863ec5 route gives five controls passing and one locked500-versus403 failure. Final canonical6/6 and the byte-unchanged original proof1/1 pass. Directed lint and diff versus integrated main pass. Historical broad tests were not repeated. No author ref/product/CI changed; no provider/authentication/browser/global-types/CI/deployment assertion. Run the proof with the canonical file-upload-admission.test.ts aliases (or bundle its contents with resolveDir set to the exact checkout's tests directory).
