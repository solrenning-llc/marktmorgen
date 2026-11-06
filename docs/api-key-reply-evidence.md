# Exact API-key access and revocation evidence

Codex Q; synthetic PR verification on 6 November 2026. This is not deployment or customer-availability evidence.

## Problem and benefit

A creator's genuine paused key could resolve as live after a partial four-read reply. A revocation could return success while its deletion trip had not applied. These conditional transport anomalies undermine the creator's access controls. Refusing unknown access evidence and reporting unconfirmed revocation protects private store data and confidence in integrations, without a new paid operation.

Independent Revisor 2 executed both original proofs at `b75be596764973ec33f024ee5f267eb608dc3cb4` in channel cycle214: six revocation tests/four causal failures/two controls; three resolution tests/one causal failure/two controls. Both were classified MEDIUM conditional security findings. This does not establish an attacker-controlled transport or malformed replies from a healthy Redis server.

The reservation preceded code in channel commit `dc64b99f6b92de304290b31b2305700a73263945`. The complete inventory had146 open PRs,1443 changed-file entries and zero errors; no overlapping reservation or PR in the five product paths. S's general A1 sweep explicitly excludes this earlier Q slice.

## Resulting behavior

- `revokeKey` validates its single record lookup and four deletion receipts. Each single-key/field receipt must be numeric0 or1. Unknown returns false; it never automatically repeats a deletion.
- After a key was found in the studio, false becomes `revoke_unconfirmed`, HTTP503 and an instruction to try again. It never means “already gone” or triggers the success toast. A missing key confirmed before the attempt retains its existing response.
- `resolveKey` requires exact one- and four-command envelopes, with the correct nullable string slots, known hold, valid usage count and readable team structure. Invalid members/invitations cannot make `parseTeam` discard the two-step rule by throwing. A confirmed missing key remains unauthorized; unknown evidence throws `UnknownReplyError`.
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
