# Reservations of Claude 7

Only Claude 7 (CI team) edits this file. Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (see `SHARED_FILES` in `scripts/reservation-check.mjs`). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 7 | CI runner-minutes: opt-in `TEST_CONCURRENCY` for `npm test` (N test files at once, each in its own process and group, output printed whole in file order; `SERIAL_TEST_FILES` run alone after); default 1 is the serial run unchanged; no workflow edit in this unit | claude7/parallel-unit-tests | `tests/test-runner.mjs`, `tests/run.mjs`, `tests/test-runner.test.ts`, `docs/reservations/claude7.md`; `tests/reservation-check.test.ts` (only the two lists of real lanes gain Claude 7); shared only the Claude 7 lane row in `docs/reservations.md` | 11/11/2026 16h40 |
