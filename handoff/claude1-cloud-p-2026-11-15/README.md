# Handoff: Claude 1 cloud P → Claude 2 (merge of main into CONFLICTING `claude1/` and `claude/` PRs)

Written 15/11/2026 for the coordinator's C2-209 transfer. Nothing here is a product change: this
branch carries the prepared merges as a git bundle so no work is lost and no CI run is started.

## What is here

- `prep.bundle`: 79 refs `refs/heads/prep/<PR>`, each the PR head with origin/main merged in (and,
  where the merge broke something, a RED→GREEN fix commit on top). Prerequisites are origin/main and
  the PR heads listed in `remaining.txt`, all on the remote.
- `remaining.txt`: the 67 not yet pushed, in the order to push them (money, then security, then the
  rest; a stacked child after its base). Each line: PR head when prepared → prepared sha, whether the
  whole unit suite ran on it (`ok`) or only the targeted tests, and whether it still merges cleanly
  with origin/main at handoff time.
- `notes.txt`: points a reviewer must know (pre-existing reservation-check failures, one test
  expectation changed on purpose, one e2e not run locally), and the two PRs closed as superseded.
- `scripts/`: what produced and checked them (paths point at the old scratchpad; adjust `S=`).

## Using it

```bash
git fetch origin claude/compassionate-rubin-vu1rhj
git show origin/claude/compassionate-rubin-vu1rhj:handoff/claude1-cloud-p-2026-11-15/prep.bundle > /tmp/prep.bundle
git fetch /tmp/prep.bundle 'refs/heads/prep/*:refs/heads/prep/*'
```

Then, for each PR in `remaining.txt`: check the remote head is still the one listed (someone may have
pushed since), `git merge-tree --write-tree origin/main prep/<PR>` must be clean (if not, merge the
newer main on top of the prep and re-check), measure Actions, then
`git push origin prep/<PR>:refs/heads/<branch>` (a fast-forward; never force) and post
"re-review needed #N ＠sha10 (merge of main)" in #3869. `scripts/push-one.sh` does the first three checks.

## Traps found

- The local `main` ref of a session clone can be days old: run `scripts/reservation-check.mjs` with
  `origin/main` as the base, or it reports files the PR never touched.
- `docs/accessibility-inventory.json` must be regenerated before `STATEMENT_REVIEW`'s digest in
  `lib/accessibility-statement.ts` is recomputed (the digest reads the inventory); git can also
  auto-merge that line into an invalid date/digest pair with no conflict marker.
- A PR that changes a cost also needs `scripts/margin-alignment.mjs`, and the same row in
  `docs/value-presentation-2026-10-18.md` (no script writes it; `tests/margin-alignment.test.ts` checks it).
- Tests that read files use the current directory: run them from the worktree root, as CI does.
- Targeted tests miss indirect breaks (#3927 broke `tests/paypal-receipt-once.test.ts`); the whole
  suite in 4 `TEST_SHARD`s takes about 9 minutes on this container.
- Actions: about 255 runs queued since 11/11 never start and inflate `total_count`; count only runs
  created in the last 6 hours (ALL-179), e.g. by reading the run at position 150.
- #3877 (CI documentation mode) conflicts again with today's main; its merge joins two CI designs
  (see its prep commit message) and should be re-merged by hand and reviewed as CI code.
