# Accessibility bundle: emails

Branch `claude3/keep/p-bundle-emails` at `62dc7dbbb`, made from `origin/main` (`7aac1f437`) by merging 5 keep branch(es) with `--no-ff`; no rebase, no force push. Each branch has its RED test in its own commit, which fails on main, and then the fix.

6 product files, 6 test files.

## What changes

- `p-mail-a11y-1`: fix(a11y): the moved or canceled event email is a whole page (AX274 item 5; 2.4.2, 3.1.1, 1.4.10)
- `p-mail-a11y-2`: fix(a11y): a long address in an email's text wraps on a phone (AX274 item 5; 1.4.10)
- `p-mail-a11y-3`: fix(a11y): an email's buttons stay boxes under forced colours (AX274 item 5; 1.4.1, 1.4.11)
- `p-mail-a11y-4`: fix(a11y): the event emails' links say where they go (AX274 item 5; 2.4.9)
- `p-lang-3`: fix(community): say RSVP in plain words to buyers (going, said you are coming, your place)

## WCAG 2.2 criteria

- 1.4.1: `p-mail-a11y-3`
- 1.4.10: `p-mail-a11y-1`, `p-mail-a11y-2`
- 1.4.11: `p-mail-a11y-3`
- 2.4.2: `p-mail-a11y-1`
- 2.4.9: `p-mail-a11y-4`
- 3.1.1: `p-mail-a11y-1`
- 3.1.5: `p-lang-3`

## Proof

- RED first: every merged branch has a test commit before its fix, and that test fails on `origin/main`.
- On the bundle head, 34 test files were run: the ones the branches add or change, plus the tests that name the files changed here. Failed: 0.
- `tsc --noEmit -p .`: clean.
- Whole suite (every file in `tests/`) on all 18 bundles merged together (`claude3/keep/p-bundle-zz-combined-check` at `09cd72c74`, a reference branch, never a PR): 2 failures on the first run, `platform-us-english.test.ts` (British spelling in new test titles) and `tap-targets.test.ts` (an empty 44px minimum on the phone alerts' summary); both fixed in their bundles and both pass now, with `tsc` clean.
- Browser checks run real Chromium with the real Tailwind build of `app/globals.css`, where the test needs layout, contrast, forced colors or focus.

## Accessibility

- Checked: the criteria listed above, each with an automated test that runs the real code, from a RED commit that fails on main.
- Method: Node tests over the source; for layout, contrast, forced colors, focus and timing, Playwright with Chromium on the built CSS, at 320 px, at 400% zoom and with text spacing where the criterion asks for it.
- Steps and decisions for the main task: no step or decision added or removed.
- Not checked: real assistive technology (screen readers, voice control, switch access), testing with people (item 202), Safari and Firefox, and mobile devices. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3 lines, snapshot of open PRs from 13 Nov 2026 23:15 UTC-3)

- #3530: lib/mail-body.ts
- #3534: lib/mail-body.ts
- #3537: lib/mail-body.ts
- #3556: lib/mail-body.ts
- #3558: lib/mail-body.ts
- #3715: lib/mail-body.ts
- #4014: lib/buyer-words/community.ts
- #4130: lib/mail-body.ts

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
