# Accessibility bundle: studio-checks

Branch `claude3/keep/p-bundle-studio-checks` at `79c5a141e`, made from `origin/main` (`b859938c0`) by merging 2 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

8 product files, 3 test files.

## What changes

- `p-check-1`: fix(a11y): the store check's warnings open the exact field to fix in one click (AX274 Part A item 6)
- `p-check-2`: fix(a11y): the page coach's picture and button checks open the exact field in one click (AX274 Part A item 6)

## WCAG 2.2 criteria


## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 26 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (all 2,346 files in `tests/`) and `tsc` on every bundle and stacked branch merged together over current main (`claude3/keep/p-bundle-zz-combined-check` at `575612584`, a reference branch, never a PR). First run of 13 Nov: `platform-us-english` and `tap-targets` failed, fixed in their bundles. Run of 14 Nov: `community-patch-member-exact` and `review-stop-exact` failed (their renderers called the client line as a plain function), fixed in the community bundle; `call-series-rules` failed once under load and passes alone. All pass now; `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- New `components/use-fix-link.ts` is a `.ts` hook, so the accessibility inventory (which lists `.tsx` components) does not change.

## Open PRs touching the same lines (±3 lines, the 732 PRs open on 14 Nov 2026 at about 00:10 UTC-3)

- #3530: components/page-editor.tsx, components/product-editor.tsx
- #3534: components/page-editor.tsx, components/product-editor.tsx
- #3537: components/product-editor.tsx
- #3556: components/page-editor.tsx, components/product-editor.tsx
- #3558: components/page-editor.tsx, components/product-editor.tsx
- #3665: components/page-editor.tsx
- #4130: components/page-editor.tsx, components/product-editor.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
