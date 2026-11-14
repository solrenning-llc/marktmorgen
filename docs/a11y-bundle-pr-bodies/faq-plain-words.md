# Accessibility bundle: faq-plain-words

Branch `claude3/keep/p-bundle-faq-plain-words` at `280de7089`, made from `origin/main` (`7aac1f437`) by merging 1 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

30 product files, 10 test files.

## What changes

- `p-docs-plain-words-4`: fix(a11y): split long sentences in the help center's answers (AX274 3.1.5)
- `p-docs-plain-words-4`: fix(a11y): split long sentences on the /platform feature pages (AX274 3.1.5)

## WCAG 2.2 criteria

- 3.1.5: `p-docs-plain-words-4`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 61 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Other bundles

- Conflicts with studio-plain-words on the affiliate sentence (`app/studio/affiliates/page.tsx`, `lib/affiliate-faq.ts`, `tests/affiliate-faq.test.ts`): keep studio-plain-words' shorter sentences.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- #1496: lib/help-content.ts
- #3024: lib/help-content.ts
- #3118: lib/help-content.ts
- #3478: lib/help-content.ts
- #3530: lib/feature-pages.ts
- #3534: lib/feature-pages.ts
- #3537: lib/feature-pages.ts
- #3556: lib/feature-pages.ts
- #3558: lib/feature-pages.ts
- #3562: lib/feature-pages.ts, lib/help-content.ts
- #3731: lib/help-content.ts
- #4130: lib/feature-pages.ts, lib/help-content.ts, lib/home-faq.ts
- #4162: lib/help-content.ts
- #4191: lib/help-content.ts
- #4209: lib/help-content.ts
- #4245: lib/mail-health-rules.ts
- #4322: lib/help-content.ts
- #4328: lib/help-content.ts
- #4329: lib/help-content.ts
- #4331: lib/help-content.ts
- #4332: lib/help-content.ts
- #4415: lib/feature-pages.ts

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
