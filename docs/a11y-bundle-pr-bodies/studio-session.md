# Accessibility bundle: studio-session

Branch `claude3/keep/p-bundle-studio-session` at `582602ed2`, made from `origin/main` (`7aac1f437`) by merging 1 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

29 product files, 1 test files.

## What changes

- `p-time-3`: fix(a11y): a session that ends mid-change says how to keep what was typed (WCAG 2.2.5)

## WCAG 2.2 criteria

- 2.2.5: `p-time-3`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 64 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- Import-only conflicts with the studio and abbreviations bundles in `components/custom-range.tsx`, `components/discord-studio.tsx`, `components/quiz-editor.tsx`, `components/team-two-step-switch.tsx` (keep every import).

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- None found.

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
