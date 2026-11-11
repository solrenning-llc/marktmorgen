# Exact API-key access and revocation evidence

Codex Q; synthetic PR verification on 6 November 2026. This is not deployment or customer-availability evidence.

## Problem and benefit

A creator's genuine paused key could resolve as live after a partial four-read reply. A revocation could return success while its deletion trip had not applied. These conditional transport anomalies undermine the creator's access controls. Refusing unknown access evidence and reporting unconfirmed revocation protects private store data and confidence in integrations, without a new paid operation.

Independent Revisor 2 executed both original proofs at `b75be596764973ec33f024ee5f267eb608dc3cb4` in channel cycle214: six revocation tests/four causal failures/two controls; three resolution tests/one causal failure/two controls. Both were classified MEDIUM conditional security findings. This does not establish an attacker-controlled transport or malformed replies from a healthy Redis server.

The reservation preceded code in channel commit `dc64b99f6b92de304290b31b2305700a73263945`. The complete inventory had146 open PRs,1443 changed-file entries and zero errors; no overlapping reservation or PR in the five product paths. S's general A1 sweep explicitly excludes this earlier Q slice.

## Resulting behavior

- `revokeKey` validates its single record lookup and four deletion receipts. Each single-key/field receipt must be numeric0 or1. Unknown returns false; it never automatically repeats a deletion.
- After a key was found in the studio, false becomes `revoke_unconfirmed`, HTTP503 and an instruction to try again. It never means “already gone” or triggers the success toast. A missing key confirmed before the attempt retains its existing response.
- `resolveKey` requires exact one- and four-command envelopes, with the correct nullable string slots, valid usage count and readable team structure. A hold read as text outside the known values (a later version's, after a rollback) is not unknown evidence: as on main (#3096, tests/r24-api-key-hold-team.test.ts) it reads as the hold `unknown`, which refuses the key while the owner can still see and revoke it, and the API answers such a key, like any key whose state did not read, 503 `unavailable` before the rate, allowance or touch. Invalid members/invitations cannot make `parseTeam` discard the two-step rule by throwing. A confirmed missing key remains unauthorized; unknown evidence throws `UnknownReplyError`.
- The API guard converts that known uncertainty to503 before rate/allowance/touch admission. Complete healthy live, paused, revoked and cross-store behavior remains covered by the original proofs and related tests.

There is no new command, data family, retention, provider call, visible limit, price or funding policy. Existing revocation cleanup and API admission costs remain unchanged. This is not a global cost or profitability certification.

## Durable RED and unchanged controls

Base: `638741bb9964c8ecb4cb542ab84753fcf6a604ce`.

- `86c47f72515c04cd4d84ad11620ec314be65229a` contains only the three new regression files, before the product repair. Actual original source:20 tests,16 causal failures,4 controls pass.
- `c1919d7006c355b95b4426a00fa204cebc7eb56e` expands the test to28. The exact original four source blobs were supplied to esbuild from the base commit without overwriting the local worktree:24 causal failures,4 controls pass. The initial repaired source passed28/28.
- `dda07f1fc1f8f3988bf28c6d0fda91a643c20f3e` adds two malformed team-entry cases. Both fail against the intermediate repair before the team-entry guard; the extra validation follows this durable test commit.
- The original revocation proof remains byte-identical to `71bf6eb035c71325f93691468c1647178b46e026`; the original pause-resolution proof remains byte-identical to `2fabdc4986a2b4ce930e919654499f13e9db1791`. The canonical regression imports both, not rewritten copies of their assertions.

The suite executes actual creation, pause CAS, resolution, API guards and studio POST with MemoryRedis and synthetic sessions/stores. It covers unknown replies before application, deletion applied with its acknowledgement lost, receipt bounds, healthy retry, refusal before admission and cross-store isolation. Keys exist only in fixture memory; values are never logged or committed.

## Accessibility and verification limits

The existing two-click revocation task remains two clicks, with the same confirmation decision. An uncertain response preserves the existing retry interaction and uses the current error presentation, rather than a false success message. No new control, focus movement, motion or layout is introduced. Human testing, screen-reader/zoom/contrast/AAA and browser behavior have not been certified for this repair.

All36 canonical files directly importing the changed API boundaries passed1170 checks, including the30-test permanent regression, API36 and second-step187. Their inherited synthetic failure-path diagnostics include unsupported webhook EVAL; those messages are not native webhook/Redis evidence. Strict scoped TypeScript covering the five source files, three tests and transitive imports passed with the repository config and generated Next route types. Global TypeScript was attempted and killed with exit137 without a diagnostic; it is not certified. Directed ESLint and diff checks passed; the canonical public-data scanner checked4127 tracked files with zero corrections. Current-main integration and independent exact-head review remain pending. Nine final exact-head checks and normal author-only merge gates remain mandatory.

No native Redis, real HTTP service, external provider/account, payment, real person data or production journey was used. Other API-key writers/readers remain outside this narrow two-finding repair and are not silently certified exact.

## Current-main integration verified

Main `1721109f1d2d3930cde6c54f6fe71412648043e3` was integrated once before opening the product PR, preserving all nine own source/test/document blobs. The native merge tree `a0819960b5a6607afd5493ba830f0d7b9ebb450e` matched the API-created union exactly; integration commit `3210210f9ba0696ffe9d312fc1d3c0a44fb5d1ac` has parents `4cbce23f6931089816225d5a1cf996805fd3d2c0` and that main. Post-integration focal30, API36 and second-step187 passed; official client bundles271/271, regenerated route types and strict scoped TypeScript passed. The later documentation commit adds only this verification record; the tested source is unchanged. This does not change the global TypeScript137 limitation or certify hosted CI. Independent review and nine final exact-head checks remain required.

## Review correction: creation rollback uncertainty

Revisor2 cycle232 independently reran the original proofs and confirmed the two MEDIUM repairs. Its remaining LOW concerned the existing creation rollback, which ignored its receipt. The correction remains in the same PR #2899; the earlier head `4416c11461fe2cde5ec38251fce780a5d76e8dbf` is preserved.

The additional scope was reserved before code in channel commit `ea4a72609f7be9ec2142dcaff91066d2e25f759a`. Durable RED branch `codex/q-api-key-rollback-red`, commit `05efbb01d99e4acca6be1f2966b8d31010e54371`, adds only the expanded test to the earlier product head. Five new tests produce four causal failures and one healthy control. A real second writer fills the last place between the first writer's count and write; the one rollback is then healthy, unapplied with an unknown reply, applied with its acknowledgement lost, or rejected by the synthetic transport. The actual studio creation endpoint is exercised separately with an unknown count followed by an unconfirmed rollback. No key value is exposed or logged.

Only exact numeric0/1 receipts for both rollback operations confirm that cleanup. Unknown or throwing rollback now returns `make_unconfirmed`, HTTP503 and “We could not confirm this change. Reload your keys before trying again.” It does not automatically repeat the cleanup, say that nothing changed, or silently pretend that an existing extra row is absent. Healthy confirmed rollback retains full/unavailable behavior. The proof explicitly observes that an unapplied rollback can leave the extra row: this is not a claim that all concurrent writes have been made atomic.

The same complete regression now passes35/35. Affected linked API36, second-step187, agent23, SG2 replies125, cost24 and data7 pass; directed lint and strict scoped types pass. The global TypeScript137 limitation still applies. No new command, visible limit, data family, retention, provider or paid operation was added. Independent review and nine NEW checks on the corrective final head supersede results from the earlier head.

## Review correction: creation write receipts

Claude6 independently reviewed exact head `a92847d639677ca4bfb59423f360ed4822e8ac3c` in comment6696578060. The two MEDIUM repairs and the rollback correction had no blocking finding; one inherited LOW remained: creation inspected the count but ignored the SET and HSET receipts, potentially announcing an unusable key as made. The follow-up was reserved before writing in channel commit `a924b4fdbca19c3de4a9e1782d135ae78a7cb718`.

Durable test-only RED `codex/q-api-key-create-receipt-red@463322519f7f9f417e3d116cb47c1c327ee76668` adds nine cases to the unchanged35:36 pass and8 fail. The test is blob `9f1ac568140269f72a92cae24de801125f50f855`. A final test-only extension `869e4f397dab5e954b712e70f626b7b9aa434fbb`, blob `e12580fb0b87d335dbbaa6e4d691de600ddcdbd5`, preserves those cases and adds creation applied before a transport exception:36 pass and9 fail against the exact earlier `api-keys.ts` source. No earlier assertion was weakened. The ten new cases stay within the announced synthetic command and execution ceilings.

Creation now confirms only an exact three-slot envelope with SET equal to `OK` and HSET numeric0 or1, after preserving the existing post-write count and rollback decision. Unknown write evidence returns `make_unconfirmed`; it does not reveal a new secret, claim creation, or repeat the writes. A transport exception follows the existing unknown-count cleanup path. Only both confirmed cleanup receipts allow the existing unavailable/no-change outcome; uncertain cleanup still returns `make_unconfirmed`. This adds no command to the existing worst-case creation/cleanup trip and does not claim atomic creation.

The local executor was reset after the initial RED and44/44 GREEN. The RED was already durable. A fresh clone repeated the exact final45-case RED (36 pass/9 fail) and then the same45/45 GREEN. All39 selected files (37 directly affected tests and the two cost/data registries) passed1227 checks; this is focused coverage, not the full repository suite. Regenerated Next route types, strict scoped TypeScript on the five source files/three tests and transitive imports, directed lint, and diff checks passed. The public-data scanner checked4131 tracked files with zero corrections. The earlier global TypeScript137 limitation remains; global types, native Redis, a real provider, hosted CI and human accessibility were not certified here. The source/UI outside this focal creation receipt change is unchanged. A qualified corrective review and nine NEW final exact-head SUCCESS checks remain required before merge.
