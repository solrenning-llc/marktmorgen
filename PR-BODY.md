## Summary

Fixes #4635. AX274 Part A item 5 (emails), WCAG 3.1.2 Language of Parts. A message forwarded to a creator (`lib/inbound-mail.ts`) carries the sender's own HTML with our short English header line above it ("From …", "To …"). That line had no `lang`, so when the sender's language, or the mail app's, differs from English, a screen reader read our lines with the wrong voice. The line is now built by a small pure function, `forwardedHeaderHtml`, and marked `lang="en-US"`. Its look is unchanged (13 px, #555, 7.46:1 on white).

First seen by the 11 November email audit (`docs/accessibility-email-pdf-audit-2026-11-11.md`); still present on main. No price, limit, commission, flag, gate, words or creator content changed. Nothing is sent by the tests.

## RED → GREEN

`tests/inbound-forward-header-lang.test.ts` renders the real `forwardedHeaderHtml` with synthetic lines. With the function as main built the line (the same markup, no `lang`), "marked lang=\"en-US\"" fails (1 of 4). On this branch, 4 of 4 pass. The 6 tests that name `inbound-mail` pass. `tsc`: no error.

## Acessibilidade

**Criteria checked:** 3.1.2 Language of Parts; 1.4.6 Contrast (Enhanced) of the line (unchanged, 7.46:1 on white).

**Method:** a unit test on the real builder, with synthetic lines. No email is sent.

**Results:** the header line carries `lang="en-US"`. The sender's HTML after it is untouched, keeping its own language marks, if any. Steps and decisions: 0 → 0.

**Exclusions and gaps:**
- Not opened in real mail apps (Gmail, Outlook, Apple Mail), and no screen reader was used: these are gaps.
- The sender's own HTML is theirs and is not changed, so a sender's message without `lang` stays as they sent it.
