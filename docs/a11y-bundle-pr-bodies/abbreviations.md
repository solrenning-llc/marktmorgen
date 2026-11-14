# Accessibility bundle: abbreviations

Branch `claude3/keep/p-bundle-abbreviations` at `f46d930e4`, made from `origin/main` (`7aac1f437`) by merging 1 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

13 product files, 3 test files.

## What changes

- `p-lang-4`: fix(help): the help center expands each abbreviation the first time a section uses it
- `p-lang-4`: fix(a11y): abbreviations in the studio's words say what they stand for (WCAG 3.1.4)

## WCAG 2.2 criteria

- 3.1.4: `p-lang-4`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 39 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 1 (accessibility-inventory.test.ts), fixed in the next commit by listing the new component in the inventory; it passes now.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- Includes `p-lang-2` (stacked under `p-lang-4`).
- `docs/accessibility-inventory.json` lists the new `components/abbr.tsx`; `tests/accessibility-inventory.test.ts` passes.
- Import-only conflicts with the studio bundles in `components/bundle-editor.tsx`, `components/custom-range.tsx`, `components/domain-editor.tsx` (keep both imports); in `app/help/page.tsx` keep `[overflow-wrap:anywhere]` from help-docs-embeds with `helpAbbr(...)`.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

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
