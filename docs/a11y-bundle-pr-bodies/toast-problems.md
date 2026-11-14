# Accessibility bundle: toast-problems

Branch `claude3/keep/p-bundle-toast-problems` at `37b928fa4`, made from `origin/main` (`7aac1f437`) by merging 1 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

19 product files, 3 test files.

## What changes

- `p-toast-problems-1`: fix(a11y): failures go through toastProblem: alert mark, role=alert, no time limit (AX274 2.2.3, 3.3.1, 1.3.1)

## WCAG 2.2 criteria

- 1.3.1: `p-toast-problems-1`
- 2.2.3: `p-toast-problems-1`
- 3.3.1: `p-toast-problems-1`

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

## Other bundles

- Includes `p-time-5` (also in the globals bundle): no toast leaves by itself, so `toastShownFor` answers null for both kinds and `tests/toast-problems.test.ts` now expects null for a confirmation too (stricter, 2.2.3). Whichever of the two bundles lands first, the other merges cleanly on those commits.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- #2924: components/ad-spend-editor.tsx
- #3069: components/ad-spend-editor.tsx
- #3070: components/ad-spend-editor.tsx
- #3159: components/person-notes.tsx
- #3171: components/product-editor.tsx
- #3291: components/payment-requests-studio.tsx
- #3473: components/product-editor.tsx
- #3840: components/inbox-studio.tsx
- #3841: components/inbox-studio.tsx
- #4130: components/inbox-studio.tsx, components/person-notes.tsx
- #4238: components/product-editor.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
