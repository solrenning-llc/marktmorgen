# Accessibility bundle: studio-focus-2

Branch `claude3/keep/p-bundle-studio-focus-2` at `1bf84e0ff`, made from `origin/main` (`7aac1f437`) by merging 6 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

11 product files, 10 test files.

## What changes

- `p-apg-6`: fix(a11y): removing a funnel offer keeps the focus in the editor (WCAG 2.4.3)
- `p-apg-7`: fix(a11y): taking a product out of a bundle keeps the focus in the editor (WCAG 2.4.3)
- `p-apg-8`: fix(a11y): removing a page funnel step keeps the focus on the steps (WCAG 2.4.3)
- `p-apg-busy-1`: fix(a11y): BusyButton keeps the focus while a button waits; pilot in two files (WCAG 2.4.3)
- `p-time-1`: fix(a11y): scripted smooth scrolls respect prefers-reduced-motion (WCAG 2.3.3)
- `p-lang-1`: fix(a11y): language names in the studio carry their own lang (WCAG 3.1.2)

## WCAG 2.2 criteria

- 2.3.3: `p-time-1`
- 2.4.3: `p-apg-6`, `p-apg-7`, `p-apg-8`, `p-apg-busy-1`
- 3.1.2: `p-lang-1`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 50 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (all 2,346 files in `tests/`) and `tsc` on every bundle and stacked branch merged together over current main (`claude3/keep/p-bundle-zz-combined-check` at `575612584`, a reference branch, never a PR). First run of 13 Nov: `platform-us-english` and `tap-targets` failed, fixed in their bundles. Run of 14 Nov: `community-patch-member-exact` and `review-stop-exact` failed (their renderers called the client line as a plain function), fixed in the community bundle; `call-series-rules` failed once under load and passes alone. All pass now; `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- `docs/accessibility-inventory.json` lists the new `components/busy-button.tsx`; `tests/accessibility-inventory.test.ts` passes.
- Conflicts with the studio-confirm/studio-asks bundles in `components/bundle-editor.tsx` and `components/course-editor.tsx`: keep `takeOut` and `lang={track.lang}` inside the `ConfirmAction`; `confirmClear` goes.

## Open PRs touching the same lines (±3 lines, the 732 PRs open on 14 Nov 2026 at about 00:10 UTC-3)

- #3427: components/course-editor.tsx
- #3530: components/page-editor.tsx
- #3534: components/page-editor.tsx
- #3556: components/page-editor.tsx
- #3558: components/page-editor.tsx
- #3665: components/page-editor.tsx
- #4130: components/page-editor.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
