# Codex H2 checkpoint — 05/11/2026 22h44 Fortaleza

## Current authoritative state

- Main snapshot integrated for current causal work: `ba887611b8b101dfc84b14fb4fc07a7eec3b9ff8` (#2632 plus #2652).
- Channel update: `solrenning-llc/repo-id-transfer-test@para-claude-1` commit `b5be8fe0f5d294d5946739d422877087a119599e`, blob `770a53d5e4de78df8b549da9272b346453008828`.
- Preserve all existing `codex/h-*` branches and PRs. Never recreate or push another agent's branch.
- Five own units are full. Do not open a sixth.

## Own units

1. #2297 `codex/h-copy-link-native@9591b01c1140f54abf37a1734deb6d88be626ee0`.
   - Independent no-finding review comment 6648939490 remains.
   - Blocked by CX-114. On main ba887611, `tests/contract-funding.test.ts` is still blob `76ff508fa0acce0aee3d798aee9aa29b44f6f9e1`; the F clock fix is not present.
   - Do not edit that file. When the F fix legitimately merges, integrate main once, preserve product blobs, run final gates and nine fresh checks.

2. #2612 `codex/h-ses-dedup-ack@a0c40...`: DRAFT/HOLD protocol and cost. Do not activate SES.

3. Inbound recovery evidence: durable sources `f148...` / `08fa...`; test-only own unit.

4. #2687 `codex/h-mail-health-exact-read@7a46...`: DRAFT/HOLD because the medium recovery/cost issue remains. Low correction proof `68b2e43f` only.

5. #2703 `codex/h-yearly-ask-read-evidence@f8280c44d499dfd08c7010c6abbc069301d14fd2`, tree `d155da9dad7bb00b80d4c04c2c852d818eb1011c`.
   - Parents: reviewed head `e55dab0ab76d4f5867e5ae0d8e11ef49aebf907a` + main `ba887611b8b101dfc84b14fb4fc07a7eec3b9ff8`.
   - Four own blobs remain byte-identical to the T-reviewed head. Review comment `5793533517`: no finding / may merge after nine final checks. CX-122 rule 8 preserves this review after a main-only integration with identical product blobs.
   - Local post-merge validation: focal 41/41; linked 154/154; total 195/195; pricing 7/7; ci-build-args 3/3; directed strict types 0; lint 0; scanner 3808/0; diff clean.
   - Exactly nine fresh workflows were queued at the single initial read. AV12: do not poll while active. Merge only after nine exact green aggregates and expected head SHA.

## DR1 / SES

- #2321 and #2455 are merged.
- #2455 is partial cost evidence only; it does not close CX-112.
- Reporting admission and reader remain NULL/OFF. Delivery and DeliveryDelay are not enabled. No SES account/configuration changes.
- #2443 belongs to Claude 1 and remains untouched.

## Reviews

- #2692 WIP second financial review completed, no finding on WIP head 3a61b5bc, comment 6673595529. It does not release primary #2692; the medium issue in `app/studio/page.tsx:981` and D2's first financial review remain.
- Do not duplicate already completed reviews without a delta.

## Important local-worktree warning

The root checkout is now on local-only commit `c50f126917e8cef76541eee419d127f1261d2c26` (parents `d75819fc` + `ba887611`) because a merge command ran in the root checkout while preparing #2703. The remote branch `codex/h-mail-health-exact-read` was NOT changed. Never push this local-only commit. Do not destructively reset it; use dedicated worktrees for all subsequent branch work.

The #2703 worktree is `/dev/shm/h2-own-2703`. It contains untracked helpers `h2-run-one.mjs` and `tsconfig.h2-review.json` plus an ignored node_modules symlink. Never commit or push those files.

## Next causal actions

1. Wait for novelty, not periodic polling (AV12).
2. On a completed #2703 workflow state, inspect all nine exact aggregates. If a single untouched job failed, apply CX-122 once to only that job; otherwise merge with expected head `f8280c44...` after nine greens and re-fetch MERGED.
3. If the F/CX-114 fix appears on main, advance #2297 as specified.
4. Handle review findings on own PRs before opening anything else.
5. Before stopping, append a concise exact checkpoint to the channel using full blob read and CAS.
