## Summary

AX274 Part A item 5 (emails): the email sent to everyone coming when a creator moves or cancels an event (`lib/community-event-mail.ts`, `noticeHtml`) is now a whole document built by `lib/email-document.ts`, the helper #4242 brings for every transactional email:
- the store's language on `<html>` and on the named article (WCAG 3.1.1);
- the subject as the title and as the article's name (2.4.2);
- the charset, so accented words in the store's language arrive whole;
- a viewport for a phone (1.4.10).

Before, it had `<html lang>` and a body, but no head, charset or title. The email audit of 11 November listed it as "Open".

**Stacked on #4242** (`claude7/a11y-public-email-pdf`). Open it once #4242 is in main; the coordinator decided #4242's helper is the one kept. The words of the email are unchanged. Its footer's grey stays #57534e, now on the helper's white paper (7.63:1, was 7.00:1 on #f7f5f0). The card and band layout gives way to the helper's single 560 px column. No price, limit, commission, flag, gate or creator content changed. Nothing is sent by the tests.

## RED → GREEN

`tests/ax-mail-event-title.test.ts` renders the real `noticeHtml` with synthetic French words.
- With the notice as it was (only exported), 4 of 6 checks fail: no charset or head, no title, no viewport, no named article.
- On this branch, 6 of 6 pass.

The 12 tests that name `community-event-mail` or `email-document` pass. `tsc`: no error.

## Acessibilidade

**Criteria checked:** 3.1.1 Language of Page; 2.4.2 Page Titled; 1.4.10 Reflow (viewport); 1.4.6 Contrast (Enhanced) for the footer (7.63:1) and the body (the helper's #1c1917 on #ffffff, about 17.5:1); 1.3.1 (one named article).

**Method:** a unit test on the real builder with synthetic words, plus the WCAG luminance formula for the footer's grey. No email is sent.

**Results:**
- The notice has a whole document, a title, a charset, a viewport and a named article in the store's language.
- Its words and footer are kept.
- Steps and decisions: 0 → 0.

**Exclusions and gaps:**
- Not opened in real mail apps (Gmail, Outlook, Apple Mail), their dark modes or their zoom.
- No screen reader was used.
