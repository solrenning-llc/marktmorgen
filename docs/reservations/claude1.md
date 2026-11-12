# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | 291 [SQ2] unit 1, "Find a lesson" over a course's outline | claude1/sq2-find-lesson | `lib/lesson-find-rules.ts` (new), `components/course-find.tsx` (new), `tests/lesson-find.test.ts` (new), `tests/e2e/course-find.mjs` (new), `components/course-outline.tsx` (the two data attributes only), `app/[handle]/course/[product]/page.tsx` (the wrapper only), `lib/buyer-words/courses.ts` (the three find phrases only), `.github/workflows/accessibility-studio-matrix.yml` (its one step only) | 12/11/2026 19h44 |
