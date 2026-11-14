# Accessibility bundle: studio-plain-words

Branch `claude3/keep/p-bundle-studio-plain-words` at `923057675`, made from `origin/main` (`7aac1f437`) by merging 1 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

25 product files, 4 test files.

## What changes

- `p-studio-plain-words-1`: fix(a11y): the studio's long sentences are split, saying the same (AX274; 3.1.5)

## WCAG 2.2 criteria

- 3.1.5: `p-studio-plain-words-1`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 62 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- Conflicts with abbreviations in `components/bundle-editor.tsx`: keep the split sentence with `<Abbr of="PDF" />`.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- #3173: app/studio/community/page.tsx
- #3530: app/studio/site/page.tsx
- #3534: app/studio/site/page.tsx
- #3537: app/studio/site/page.tsx
- #3556: app/studio/site/page.tsx
- #3558: app/studio/site/page.tsx
- #4130: app/studio/calendar/page.tsx, app/studio/outreach/page.tsx, app/studio/pages/page.tsx, app/studio/site/page.tsx

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
