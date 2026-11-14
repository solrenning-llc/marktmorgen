# Accessibility bundle: studio-asks

Branch `claude3/keep/p-bundle-studio-asks` at `ef7632aeb`, made from `origin/main` (`7aac1f437`) by merging 5 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

11 product files, 5 test files.

## What changes

- `p-remove-asks-2`: fix(a11y): six studio removals ask first through ConfirmAction (AX274 3.3.6)
- `p-remove-asks-3`: fix(a11y): the welcome video and an alert phone ask before removal (AX274 3.3.6)
- `p-saved-reply-kept-5`: fix(a11y): a saved reply's words stay until its save is confirmed (AX274 3.3.7, 3.3.6)
- `p-link-purpose-4`: fix(a11y): each product's bundle and funnel links name their product (AX274 2.4.9)
- `p-apg-4`: fix(a11y): a lesson's video, downloads and captions ask before they go (WCAG 3.3.6)

## WCAG 2.2 criteria

- 2.4.9: `p-link-purpose-4`
- 3.3.6: `p-remove-asks-2`, `p-remove-asks-3`, `p-saved-reply-kept-5`, `p-apg-4`
- 3.3.7: `p-saved-reply-kept-5`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 35 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (all 2,346 files in `tests/`) and `tsc` on every bundle and stacked branch merged together over current main (`claude3/keep/p-bundle-zz-combined-check` at `575612584`, a reference branch, never a PR). First run of 13 Nov: `platform-us-english` and `tap-targets` failed, fixed in their bundles. Run of 14 Nov: `community-patch-member-exact` and `review-stop-exact` failed (their renderers called the client line as a plain function), fixed in the community bundle; `call-series-rules` failed once under load and passes alone. All pass now; `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: removals now ask first (3.3.6): one confirmation step more, on purpose; nothing else changes.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3 lines, the 732 PRs open on 14 Nov 2026 at about 00:10 UTC-3)

- #3837: components/inbox-studio.tsx
- #3838: components/inbox-studio.tsx
- #3839: components/inbox-studio.tsx
- #3840: components/inbox-studio.tsx
- #3841: components/inbox-studio.tsx
- #4000: components/bundle-toggle.tsx, components/checkout-extras.tsx
- #4130: components/inbox-studio.tsx, components/person-notes.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
