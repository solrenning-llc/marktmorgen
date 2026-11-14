# Accessibility bundle: studio-focus

Branch `claude3/keep/p-bundle-studio-focus` at `ff9c3ca21`, made from `origin/main` (`7aac1f437`) by merging 3 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

11 product files, 8 test files.

## What changes

- `p-apg-12`: fix(a11y): removing a sequence step keeps the focus on the steps (WCAG 2.4.3)
- `p-apg-12`: fix(a11y): a form's questions and results and a quiz's questions keep the focus on remove (WCAG 2.4.3)
- `p-apg-12`: fix(a11y): six studio lists keep the focus when an item is removed (WCAG 2.4.3)
- `p-apg-1`: fix(a11y): the currency question takes the focus and closes on Escape (APG, WCAG 2.4.3)
- `p-apg-2`: fix(a11y): the inbox filter tabs follow the APG tabs pattern (WCAG 2.1.1, 4.1.2)

## WCAG 2.2 criteria

- 2.1.1: `p-apg-2`
- 2.4.3: `p-apg-12`, `p-apg-1`
- 4.1.2: `p-apg-2`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 51 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (all 2,346 files in `tests/`) and `tsc` on every bundle and stacked branch merged together over current main (`claude3/keep/p-bundle-zz-combined-check` at `575612584`, a reference branch, never a PR). First run of 13 Nov: `platform-us-english` and `tap-targets` failed, fixed in their bundles. Run of 14 Nov: `community-patch-member-exact` and `review-stop-exact` failed (their renderers called the client line as a plain function), fixed in the community bundle; `call-series-rules` failed once under load and passes alone. All pass now; `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- Import-only conflicts with studio-confirm/toast-problems in `components/forms-editor.tsx` and `components/inbox-studio.tsx` (keep both imports).

## Open PRs touching the same lines (±3 lines, the 732 PRs open on 14 Nov 2026 at about 00:10 UTC-3)

- #3378: components/affiliate-studio.tsx
- #3485: components/affiliate-studio.tsx
- #3837: components/inbox-studio.tsx
- #3838: components/inbox-studio.tsx
- #3839: components/inbox-studio.tsx
- #3840: components/inbox-studio.tsx
- #3841: components/inbox-studio.tsx
- #4130: components/forms-editor.tsx, components/inbox-studio.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
