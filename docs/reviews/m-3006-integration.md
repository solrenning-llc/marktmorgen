# PR #3006: reviewed CI fixes integrated with main

Exact published subject: `71c43e9f65f10571137dfd39a8dfe5d54a2c4067`.
Tested/published tree: `0d07093148a503aad9d1489ea779f4c5493312fd`.
Local commit `d37b6068c5bd8d0cae9c39beb7cb980622a04591` has the same tree; it is not the published commit ID.

Under C1-CODEX-38, M preserved the original branch and the EXISTING corrective candidate `7d8f8ad6d36ba495321a1853762a20afa35f6783`, including C4's qualified independent focal 6717273778. Main `c166ceeef0361fd84fe546de84aa1212dcafea18` merged automatically, with no conflict. Only lib/data-families.ts and the plan/store-data test registries changed from the candidate within the PR's 15 paths; the other 12 blobs are identical to that reviewed candidate, including all discount logic, button classes, guard table and e2e fixtures. No fresh policy, price, allowance, commission, gate or provider behavior was selected by M.

## Existing corrections preserved

- e8476164f4: align the existing Cancel button label within its 44px box.
- 4da49eb072: register the route's ALREADY EXISTING settings guard in both delete-scan tables. The authorization guard itself is unchanged.
- 7d8f8ad6d3: confirmed synthetic discount replies include schedules; malformed cases remain malformed for their own reasons, with an additional missing-schedules case. No browser assertion was removed.

## Executed evidence

RED is an actual isolated checkout of the pre-fix merge d31f0f76e1, not an invented/recreated test:
- tap-targets: 5/6 passing, one causal failure naming the Cancel button's missing alignment;
- locked-deletes: 114/116 passing, two causal missing-table failures.

Integrated tree: 15 files, 411 passing observations with overlap: tap-targets 6; locked-deletes 116; ck3-schedule-review 31; ck3-scheduled-discount 80; discount-confirmation 30; discount-impact 8; discount-provider-list 14; discount-rules 30; discount-stop-acknowledgment 12; member-discount 14; person-data-registry 20; plan-cost-registry 26; store-data-registry 7; closing-families 4; data-recount 13.

Actual semantic TypeScript: 11 roots plus all imports, 1297 source files, 599 repository blob pins, zero diagnostics, none filtered. ESLint on all 15 changed TS/TSX/MJS files: exit 0. Both e2e files pass node --check. Public-data script: 4646 tracked files, zero findings. Own whitespace diff against main: clean.

All test graphs ran serially with source pins and network denied before imports. Per child: 20000 nested MemoryRedis operations, 20000 pipeline commands, 100 admitted mock HTTP requests, 120 seconds, 512 MiB heap and 256 KiB captured output. Largest completed counts: 1199 nested operations, 1044 pipeline commands, 25 mock HTTP requests. No ceiling reached, raised, reset or retried. Types: 120 seconds/1024 MiB heap. Lint: 120 seconds/768 MiB. Syntax: 30 seconds each. Scanner: 60 seconds. Reused lock-matched dependencies; no installation or provider call.

## Durable archive

proofs/m/3006-integration/evidence.json.gz.b64 reversibly contains 28 entries: both bounded runner sources, type runner, all raw RED/GREEN/validator logs, result ledgers, source/graph metadata hashes and bounds. Base64-decode, gunzip, verify uncompressed JSON SHA-256:

`a851d34a4eb4effa31f64e5e3c944bdf3b911ae988fe2e4fc81e9c917e6ed7b0`

74780 raw bytes; 17904 gzip bytes; 23872 base64 characters. No raw log was omitted. Bundles and full esbuild metadata are reproducible from the pinned trees; they are not represented as archived, only their hashes are.

## Remaining gates

Request another Codex's focused independent review of the automatic integration, retaining C4's existing candidate review and its bounds. Then require nine mandatory successful checks on this exact head, including the actual Firefox/WebKit jobs. Local syntax/fixture checks do not certify those browsers. Browser, screen reader, native Redis/Lua, production, full build and global commercial/cost validation were not performed by M. One expected-old-head CAS branch advance, no force, CI retry/cancellation, queue admission or merge.
