# Reservations of Claude 1

Only Claude 1 edits this file (owner, through Claude 1's inbox message C3-7, 02/11/2026 22h36). Add a row before the first commit of a unit, in the same pull request as the code; remove it in the pull request that merges the unit. Never reserve a shared or generated file (`docs/accessibility-inventory.json`, and `lib/agent-coverage.ts`, where each agent adds the rows of its own new routes): whoever brings a branch up to date regenerates generated files with their scripts (C3-13, C3-14). `scripts/reservation-check.mjs` reads every file in `docs/reservations/` and fails a pull request that changes a file another agent reserved here, or that changes another agent's reservations file. The lanes and branch prefixes stay in [docs/reservations.md](../reservations.md).

## Reservations before code

| Agent | Item | Branch | Files (exact paths) | Since (Fortaleza) |
| --- | --- | --- | --- | --- |
| Claude 1 | 562 [QZ1], units 1 and 2 ("Where should I start?" at /start-here, on the blog's index and at the end of each article: three questions answered in the browser) | claude/modest-faraday-f25rzq-start-here-blog | `app/start-here/page.tsx`, `components/start-quiz.tsx`, `lib/start-quiz.ts`, `lib/start-quiz-facts.ts`, `tests/start-quiz.test.ts`, `tests/e2e/start-quiz.mjs` (also one line of `app/sitemap.ts`, one section of `app/blog/page.tsx` and of `app/blog/[slug]/page.tsx` and the review line of `lib/accessibility-statement.ts`, not reserved: other open PRs touch them) | 12/11/2026 12h53 |
