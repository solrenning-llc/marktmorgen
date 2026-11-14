# Accessibility bundle: studio-forms-2

Branch `claude3/keep/p-bundle-studio-forms-2` at `d36579f63`, made from `origin/main` (`7aac1f437`) by merging 5 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

10 product files, 5 test files.

## What changes

- `p-form-5`: fix(studio): show each field's own label (help question, tip amounts, community, new lesson, AI box)
- `p-forced-1`: fix(studio): keep the colour circles' own colours under forced colors
- `p-nav-3`: fix(studio): the invoices page draws the trail (Studio / Your plan / Invoices)
- `p-studio-a11y-1`: fix(a11y): loose studio links are 44 px targets (AX274; 2.5.5)
- `p-studio-a11y-2`: fix(a11y): the member's email field wraps instead of shrinking (AX274; 1.4.10)

## WCAG 2.2 criteria

- 1.4.10: `p-studio-a11y-2`
- 1.4.11: `p-forced-1`
- 2.4.8: `p-nav-3`
- 2.5.3: `p-form-5`
- 2.5.5: `p-studio-a11y-1`
- 3.3.2: `p-form-5`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 37 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- #4130: app/studio/path/page.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
