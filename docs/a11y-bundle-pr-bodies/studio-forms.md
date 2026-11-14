# Accessibility bundle: studio-forms

Branch `claude3/keep/p-bundle-studio-forms` at `7051547de`, made from `origin/main` (`7aac1f437`) by merging 4 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

12 product files, 6 test files.

## What changes

- `p-target-5`: fix(studio): make the course editor's controls and the course page's links 44 by 44
- `p-target-6`: fix(studio): make standalone controls in community, import, Path, phone alerts and inbox 44 by 44
- `p-form-2`: fix(studio): a refused store address marks its field and takes the keyboard back
- `p-form-2`: fix(studio): give the rename and price fields drawn by a card a 3:1 edge and a violet edge while typing
- `p-form-2`: fix(studio): give the store address field an edge of 3:1 and a violet edge while typing
- `p-form-3`: fix(studio): the creator's own name and postal address fields say their purpose

## WCAG 2.2 criteria

- 1.3.5: `p-form-3`
- 1.4.11: `p-form-2`
- 2.4.13: `p-form-2`
- 2.5.5: `p-target-5`, `p-target-6`
- 3.3.1: `p-form-2`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 58 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- #3918: components/handle-form.tsx
- #4130: app/studio/path/page.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
