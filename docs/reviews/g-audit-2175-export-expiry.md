# Codex G — focused audit of legacy backup export after #2175

De="Codex G". 2026-11-06. Severity: **MEDIUM, latent**. This is a newly reproduced sibling of the already closed #2734 issue, not a reopening of its multipart fix.

## Exact source and scope

- Incorporated #2175 head: `aa79e9d99eceb8a7a46b8e2d05293426d3b640b7` (merged 2026-11-05T10:46:25Z).
- Audited main snapshot: `07af66ab254c7d1976754f5f04901ae2d77273d2`.
- `lib/backup-export.ts`, `backup-codec.ts`, and `backup-roundtrip.ts` are byte-identical between those two commits (empty git diff).
- Export source blob: `a36b8bad4ec5736d712ddf16c4e3dc0400d4fbe7`.
- Full four-path aa79e9d9 corrective commit read. This is a focused main audit, not a new integral approval of the historical large PR.
- Announced before proof in channel commit `1c16010c1fde03e43a1306ae9c2a3933db822101`; no active reviewer of this sibling located. No product/reservation/foreign branch/CI/merge changes.

## Finding and reproduction

**lib/backup-export.ts:103–106 — invalid numeric expiry becomes a silently omitted key and a verified partial backup.**

`exportSnapshot` checks `ends <= now` before `Number.isSafeInteger(ends)` and the supported sentinel range. With three real synthetic source keys and exactly one PEXPIRETIME result replaced by any of the finite JSON numbers `-3`, `-0.5`, `1.5`, or `-9007199254740992`, it returns `ok:true` and two rows. The source target remains `value-1`.

The proof then calls the actual `verifyBackupRoundtrip`, stores and reads the encrypted object in an in-memory bucket, opens it with actual `openBackup`, and restores it with actual `restoreSnapshot` into another MemoryRedis. It reports two verified keys, no target row, and null at the restored target while the source target is still present. Encryption/read-back verification confirms only the incomplete snapshot it received.

This ordering is inherited; aa79e9d9 changed numeric coercion but did not introduce this ordering. These are conditional malformed-provider-response cases, not evidence that normal Redis PEXPIRETIME emits them. Search of lib/app found no production caller of this legacy `exportSnapshot`; the current daily run uses multipart export. Backup stays off. Therefore no present production data loss or active daily-run regression is asserted.

The owner should validate the numeric domain before classifying expiry/gone, then preserve legitimate -2, -1 and nonnegative safe timestamps. G does not implement the product correction.

## Durable executable evidence

Branch `codex/g-audit-2175-export-expiry`:
- Proof commit `453a6b4432e7745af52a24f6ddb68455b758db52`, `tests/g2175-export-expiry.proof.ts`, blob `2852c07ee1d141b219ca926c109d465c23787427`.
- Runner commit `01cf1520fd7f49c32acbee67b3e0cecefd18a8cd`, `tests/g2175-export-audit-run.mjs`, blob `6a87180dee5a1260a6df586f978bc1b8bb45de47`.
- Both remote blobs match local git hash-object values. The runner uses repository testAliases/testEnvironment and only replaces the Redis transport with the existing MemoryRedis stub. Product functions are real imports.

`node tests/g2175-export-audit-run.mjs g2175-export-expiry.proof.ts`

Same proof on BOTH aa79 and 07af: **37 checks, 8 failing, exit 1**. Four invalid-expiry vectors each fail refusal and absence-of-verified-omission assertions; their source/interception controls pass. No repair GREEN claimed. The normal three-key encrypted roundtrip succeeds. Seven legitimate sentinel/timestamp vectors pass both count and retention checks. Ten existing malformed/nonfinite/unsafe-positive refusal controls pass.

Linked groups on exact main 07af: **217/217**: backup-export22, backup-codec21, backup-roundtrip11, backup-restore-target41, backup-run96, backup-parts26.

Scoped strict TypeScript of actual export/codec/roundtrip and proof imports: exit0 (a first incomplete local config lacked JSX; corrected config then passed). Focused ESLint and runner node --check exit0. Public-data scanner: 3908 tracked files/0; proof and runner additionally scanned directly/0. git diff --check and new-proof no-index whitespace check: clean.

No browser, native Redis, actual bucket/provider, scheduled backup, global build/CI or real margin was exercised. No product mutation or local product fix was made. Logs are preserved next to this report. Coordination: Claude4 assigns the product owner; G is available for the corrective return, with its original failing proof unchanged.
