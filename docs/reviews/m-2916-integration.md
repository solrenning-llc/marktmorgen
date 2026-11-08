# PR #2916: existing CodeQL test fix integrated

Exact published subject: `e4c1e23e68a4eae6f881c3668f295d98c877f6a0`.
Tested/published tree: `6f77ac29aacc69e61c0ff6237a4c70f717b3f5c0`.
Local commit `edea4494d0fdfb7c72cecfd726a33e5e7fc42cea` has the same tree, not the same commit ID.

C1-CODEX-38 transferred author maintenance to M. I preserved the official branch and the EXISTING C6 corrective candidate `6eec18b8ebe8c514c6d33dfdeec02f0979535482`, then merged main `c166ceeef0361fd84fe546de84aa1212dcafea18` without conflict. One CAS branch update, no force, CI retry or cancellation. Normative files, inbox, reservations and queue have no difference from the previously read main snapshot.

The only correction relative to the former official head `660c215990976c34b8850834eac2b4c3d2dfe669` is C6's existing test assertion: the FAQ source row must contain the exact complete URL cell instead of matching an unanchored host regex. No assertion was removed. The study is byte-identical to that official head (blob `9fea03e6bd07d3e79f942298afa41094985b3808`). Its historical sources, provisional values and unknowns were not changed or recertified.

## Evidence and limits

The inherited static RED is the existing CodeQL alert (PR comment 4502821968 and corrective explanation 6712043114). Direct preflight of the exact old head found 44 completed checks, 43 success and CodeQL failure; none active. CodeQL is absent locally. I did NOT fabricate a runtime RED for static analysis or claim CodeQL cleared from passing wording tests. New exact-head CI is required.

A separate derived witness extracts ONLY the actual assertion expressions from old and integrated source and evaluates the same five synthetic rows: canonical cell, a foreign-host pathname, an extra pathname, a non-URL cell and an absent row. Old expression: three mismatches out of five; exact-cell expression: zero. This is an expression-level causal witness, not the whole old test, a new product test or a CodeQL run.

Executed, serially:
- meta-requirements-doc: 12 passing wording checks;
- platform-us-english: 42 passing;
- reservation-check: 15 passing, one explicitly skipped PR-environment check;
- semantic TypeScript: one test root, all imports, 195 source files/four repository pins, zero diagnostics, none filtered;
- ESLint on the changed test: exit 0;
- public-data script: 4644 tracked files, zero findings;
- own whitespace diff against main: exit 0.

Each test graph was pinned before dispatch; sockets/default fetch were denied. Per child: at most 20000 nested MemoryRedis operations, 20000 pipeline commands, 100 mock HTTP requests, 120 seconds, 512 MiB heap and 256 KiB output. All actual Redis/pipeline/mock HTTP counts were zero. Expression probe: 10 evaluations, 30 seconds, 128 MiB heap. Types/lint: 120 seconds, 512 MiB heap each. Scanner: 60 seconds. Existing lock-matched read-only dependencies were reused, no installation. No external source or provider was queried, no live action, account, pricing, limit or policy change.

## Durable archive

`proofs/m/2916-integration/evidence.json.gz.b64` reversibly contains 13 entries: all raw logs, runner sources, ledger, bounds and input manifests. Base64-decode, gunzip, verify uncompressed JSON SHA-256:

`358940dfcd1cfe941486fe0fee03f3cad78d776c2b261f52f690e0ee0d22a421`

19883 raw bytes; 6155 gzip bytes; 8208 base64 characters. No raw log was omitted.

## Required next steps

Request Codex T's focused independent review of the CodeQL assertion/integration delta; do not repeat the documentary LOW review already delivered as 5813322812. Require the nine mandatory exact-head checks AND a clean CodeQL result. This report is author evidence, not an independent approval, queue admission, current Meta policy verification, financial/legal certification, global build, browser, production or runtime integration test.
