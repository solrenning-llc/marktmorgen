# Independent focal review of #3011

Reviewed head: `3815ab4077cab75a415cf7c513beb9dffec30a80`.
Scope: corrective delta from `2001d29b`, closing LOW `6697636961`.

Verdict: LOW closed; no new high, medium or low finding in this delta.
May merge after the author's nine exact final successful aggregate checks.
This does not certify deployment, customer availability or the deferred course facts.

## Causal evidence

- Durable author RED `b6eb04549f925ec502ec145b2015ffe10f7590e2`: canonical test has 41 checks, 2 failures (extra envelope slot and extra MGET slot).
- Same canonical final test: 41/41.
- New independent test in this evidence branch: same 41 checks against the RED reader have 16 failures; final reader passes 41/41.
- Vectors cover extra/missing replies, nonarrays, holes, inherited slots, getters, Proxies, wrong record types, exact frozen replies, known null, mismatched paths and no-video/no-command control.
- The proof supports both reader names so that its assertions are unchanged between the two public versions.

The first independent run had 40/41: the mock async function's Promise resolution probed the envelope Proxy's `then`. This happened before product validation. The fixture now distinguishes that Promise protocol probe from data access/reflection; all 41 business/data assertions remain. The harness correction was explained before editing in channel commit `b1fd56e1f8b2e0e74028d45c61683629b8aeada5`. No product, expectation, timeout or author test was changed.

## Validation

- Canonical course-facts: 41; stream: 148; auto-captions: 58; collection: 15; free-course video rules: 35; watch: 64. All passing.
- Additional stream-measurement assertion suite passed (no artificial numeric check count).
- Independent proof: 41. Thus 402 explicitly counted checks plus the measurement suite, eight test files in all.
- TypeScript: four selected roots (both source files, canonical test, independent test), strict repository options, zero diagnostics.
- ESLint: those same four paths, zero errors.
- Public-data scanner and diff check run on tracked final evidence.
- Native merge-tree against pinned main `80f4cbb60eb0abeb0964b3136e8f8574a02298c9` was clean, tree `5d479efc6eabca363bb1194cb6041e3335cde463`. The integration tree was not executed and is not a substitute for the author's CI.

## Reasoning and limits

`courseVideoLengths` admits exactly one pipeline reply and exactly one own data slot per requested key through `repliesFor`. It refuses the whole read on a wrong-typed slot. Known null or unreadable stored records provide no measured length; `courseVideoSeconds` then omits the whole total when any requested video is unknown. Moving the read out of `stream.ts` leaves the shared helpers pure. The correction keeps one MGET and performs no provider call, write, retry or new retention.

Only the corrective three-file delta and relevant readers were inspected in this focal return. The initial review's unchanged UI assertions are not newly certified here. All IO used synthetic repository fixtures; no native Redis, browser, screen reader, external provider or real account was exercised. No foreign source, ref or PR state was changed.
