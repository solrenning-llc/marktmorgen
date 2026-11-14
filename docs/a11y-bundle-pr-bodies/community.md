# Accessibility bundle: community

Branch `claude3/keep/p-bundle-community` at `0b87812fc`, made from `origin/main` (`7aac1f437`) by merging 6 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

14 product files, 6 test files.

## What changes

- `p-spacing-1`: fix(community): let the bar's name and store link wrap instead of ending in an ellipsis
- `p-target-3`: fix(community): make the bar's link home, its tabs, the poll's check boxes and post and event titles 44 by 44
- `p-sr-1`: fix(community): the post's title is the level-1 heading of its own page
- `p-form-1`: fix(community): show the post box's labels for its title, space and text
- `p-form-4`: fix(community): the line answering a sent form takes focus once so it is read
- `p-nav-1`: fix(community): the notifications page marks its tab as the current page

## WCAG 2.2 criteria

- 1.3.1: `p-sr-1`
- 1.4.10: `p-spacing-1`
- 1.4.12: `p-spacing-1`
- 2.4.6: `p-sr-1`
- 2.4.8: `p-nav-1`
- 2.5.3: `p-form-1`
- 2.5.5: `p-target-3`
- 3.3.2: `p-form-1`
- 4.1.2: `p-nav-1`
- 4.1.3: `p-form-4`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 24 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- `docs/accessibility-inventory.json` lists the new `components/community-flash.tsx` (regenerated with `scripts/accessibility-route-inventory.mjs --write`; `tests/accessibility-inventory.test.ts` passes).

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- None found.

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
