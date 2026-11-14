# The API docs expand their abbreviations

Branch `claude3/keep/p-lang-5` at `16104a684`, **stacked on the help-docs-embeds bundle and `claude3/keep/p-lang-4`** (the `Abbr` element and the list). Open after both.

## What changes
- `/developers`: API, CORS, JSON, ISO, UTC and CSV as `<Abbr>` where the page first uses them in prose; MCP is already spelled out beside its first use.
- `/developers/checkout-script`: HTML and API the same way.
- `lib/abbreviations.ts`: CORS and ISO. Code examples are left as written.

## Criteria
- WCAG 2.2 3.1.4 (AAA); AX274 Part A item 4.

## Proof
- RED: `tests/developers-abbreviations.test.ts` draws both pages whole and finds each first use plain; passes after. 25 docs, help and abbreviation test files pass, plus `platform-us-english` and the accessibility inventory; `tsc` clean.

## Accessibility
- Checked: each abbreviation's first prose use is an `<abbr>` with its expansion. The pages have no parameter tables (parameters are in prose with `code`); headings come from `LegalPage` (h1) and `LegalSection` (h2).
- Steps and decisions for the main task: none added or removed.
- Not checked: real assistive technology (screen readers, voice control), testing with people (item 202), Safari, Firefox and phones. Automated tests do not prove conformance.

Lines counted from the help-docs-embeds bundle, so the abbreviations bundle's own lines (p-lang-4, merged under this branch) are in the list too.

## Open PRs touching the same lines (±3, the 732 PRs open on 14 Nov 2026 at about 00:10 UTC-3)
- #3530: app/developers/page.tsx 214
- #3534: app/developers/page.tsx 214
- #3537: app/developers/page.tsx 214
- #3556: app/developers/page.tsx 214
- #3558: app/developers/page.tsx 214
- #4130: app/developers/page.tsx 214
- #4191: app/help/page.tsx 95
- #4209: app/help/page.tsx 95
- #4322: app/help/page.tsx 95
- #4328: app/help/page.tsx 95
- #4329: app/help/page.tsx 95
- #4331: app/help/page.tsx 95
- #4332: app/help/page.tsx 95

Prices, visible limits, commission, gates, flags, `PLANS_ON_SALE` and `OPENING_REQUESTED` are untouched.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014YNUxypZRgh2g8m1KEKHmE
