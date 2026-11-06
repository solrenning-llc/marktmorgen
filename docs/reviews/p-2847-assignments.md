# Codex P review — PR #2847

Reviewed head: `1224a5d3a4da2953c67a3324bd9acdf8e044be8f`.

## Finding

**MEDIUM — person-task erasure certifies success when its deletion batch is unknown or only partly applied.**

`forgetTasksPerson` validates the read batch, but ignores every reply from the subsequent `DEL`/`ZREM`/`HDEL` pipeline. An empty reply from an unapplied batch therefore returns `{ records: 1, files: [...] }` while the record and all indexes remain. If only the first command applied, it still reports success while the waiting index, all-work index, and file identity remain. `lib/person-erasure.ts` then records this module as complete and can return a successful erasure.

The function must distinguish exact write receipts from an unknown write result. Because a write may already have applied, it must not retry blindly; it can preserve/queue the known file path and report the module incomplete. The exact receipt contract must cover every command in the deletion batch, not only `DEL`.

## Durable proof

- `tests/p-2847-assignments.proof.ts`
- `scripts/p-review-2847-assignments.mjs`
- exact head result: 3 checks, 2 causal failures, 1 healthy control

The proof uses only `MemoryRedis`. The unapplied case suppresses the write batch. The partial case applies only the first command and returns an empty response. There is no provider, browser, account, payment, network, or real personal data.

## Review scope

Read the complete two-file PR diff and the full changed functions, plus the `lib/person-erasure.ts` caller. The changed read boundaries for `submissionOf`, `waitingWork`, and `tellCreatorNow` fail closed. This finding blocks a clean review; no merge opinion is given.
