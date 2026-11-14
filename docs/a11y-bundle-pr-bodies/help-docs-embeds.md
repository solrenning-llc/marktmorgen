# Accessibility bundle: help-docs-embeds

Branch `claude3/keep/p-bundle-help-docs-embeds` at `6f1e3ffc0`, made from `origin/main` (`7aac1f437`) by merging 8 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

9 product files, 9 test files.

## What changes

- `p-spacing-2`: fix(help): let a long word in a help question wrap so its open/close sign stays in the box
- `p-target-2`: fix(help): wrap the section links on a narrow screen instead of a sideways scroller
- `p-docs-a11y-1`: fix(a11y): /developers' code examples scroll by keyboard and are named (AX274; 2.1.1)
- `p-docs-plain-words-1`: fix(a11y): split long sentences in the public API docs (AX274 3.1.5)
- `p-docs-plain-words-3`: fix(a11y): split long sentences on /help/zoom, /platform and /status (AX274 3.1.5)
- `p-nav-2`: fix(site): help and developer subpages show a trail to where they are
- `p-spacing-3`: fix(embed): let a product card outgrow a frame too short for it instead of clipping its action
- `p-sr-2`: fix(embed): the sign-up card in the checkout script's frame is the page's main landmark

## WCAG 2.2 criteria

- 1.3.1: `p-sr-2`
- 1.4.4: `p-spacing-3`
- 1.4.10: `p-spacing-2`, `p-target-2`, `p-spacing-3`
- 1.4.12: `p-spacing-2`
- 2.1.1: `p-docs-a11y-1`
- 2.4.1: `p-sr-2`
- 2.4.8: `p-nav-2`
- 2.4.11: `p-target-2`
- 2.4.12: `p-target-2`
- 3.1.5: `p-docs-plain-words-1`, `p-docs-plain-words-3`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 28 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- #3378: app/developers/page.tsx
- #3530: app/developers/page.tsx
- #3534: app/developers/page.tsx
- #3537: app/developers/page.tsx
- #3556: app/developers/page.tsx
- #3558: app/developers/page.tsx
- #3920: app/developers/checkout-script/page.tsx
- #4130: app/developers/page.tsx
- #4162: app/help/page.tsx
- #4191: app/help/page.tsx
- #4209: app/help/page.tsx
- #4322: app/help/page.tsx
- #4328: app/help/page.tsx
- #4329: app/help/page.tsx
- #4331: app/help/page.tsx
- #4332: app/help/page.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
