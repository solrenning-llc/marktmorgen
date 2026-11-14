# PDF/UA: the buyer's stamped line in an embedded font

Branch `claude3/keep/p-pdf-1` at `10b760ff8`, **stacked on #3761** (`claude4/ax-pdf-stamp-artifact`, the same line as an artifact). Open after #3761, or with it.

## What changes
- `lib/pdf-stamp.ts`: the line is drawn in Noto Sans (the face of the site's own PDFs), embedded and subset to the line's letters, with a ToUnicode map, instead of the standard Helvetica, which is never embedded. A conforming ebook stayed conforming only until it was stamped.
- Size: about 4 KB more per stamped copy (up to 12 KB with many different letters), measured on a 300-page file. Stamped copies already count in the creator's paid storage, under its cap.

## Criteria
- ISO 14289-1 (PDF/UA-1) 7.21.4.1 (fonts embedded) and 7.21.7 (ToUnicode); AX274 Part A item 5.

## Proof
- RED `058b3803f`: `tests/pdf-stamp-font-embedded.test.ts` finds `/Helvetica` unembedded on both pages of a stamped conforming synthetic book (also on main).
- After the fix: 18 stamp, PDF and EPUB test files pass; `tsc` clean outside stale `.next/types`.

## Accessibility
- Checked: fonts embedded and mapped to text on every page after the stamp, with pdf-lib's parser, offline. No veraPDF in the repository; none installed.
- Steps and decisions for the main task: none added or removed.
- Not checked: real assistive technology (screen readers, voice control), testing with people (item 202), Safari, Firefox and phones. Automated tests do not prove conformance.

## Open PRs touching the same lines (±3, snapshot 13 Nov 2026 23:15 UTC-3)
- #3761: `lib/pdf-stamp.ts` 88-118 (the base of this branch).
- #3480, #3486, #3899, #4130, #4357: `lib/pdf-stamp.ts` 36 (imports).

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
