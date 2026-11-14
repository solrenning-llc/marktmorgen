# Accessibility bundle: globals

Branch `claude3/keep/p-bundle-globals` at `6b7cbd0fa`, made from `origin/main` (`7aac1f437`) by merging 7 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

13 product files, 8 test files.

## What changes

- `p-docs-a11y-2`: fix(a11y): the amber status tag reads at 7:1 (AX274; 1.4.6)
- `p-colors-1`: fix(a11y): in forced colors a selected, pressed or current button is drawn in Highlight (WCAG 1.4.1, 1.4.11)
- `p-contrast-1`: fix(community): darker red for delete, firmer edge on the search box
- `p-target-1`: fix(a11y): the preview line's link gets the white keyboard ring of the dark sections
- `p-time-4`: fix(store): the Aurora backdrop settles within five seconds and stays still
- `p-time-5`: fix(a11y): the confirmation toast stays until the person dismisses it
- `p-colors-2`: fix(a11y): charts, meters and marks stay visible in forced colors (WCAG 1.4.11)

## WCAG 2.2 criteria

- 1.4.1: `p-colors-1`
- 1.4.6: `p-docs-a11y-2`, `p-contrast-1`
- 1.4.11: `p-colors-1`, `p-contrast-1`, `p-colors-2`
- 2.2.2: `p-time-4`
- 2.2.3: `p-time-5`
- 2.3.3: `p-time-4`
- 2.4.7: `p-target-1`
- 2.4.13: `p-target-1`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 61 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- None found.

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
