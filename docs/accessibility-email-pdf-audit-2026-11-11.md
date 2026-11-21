# Emails and generated PDFs: accessibility audit (11 November 2026)

AX274 Part A, item 5 asks every transactional and marketing email and every
PDF the site generates to be accessible. This is what was checked on
11 November 2026 (Claude 4, cloud Q), how, and what is still open. It is a
code audit with synthetic renders, not a conformance claim: no real mail
client, no screen reader and no PDF checker (veraPDF) was run. Every
"not checked" below is a gap, not a pass.

## Method

- Every builder that hands HTML to `sendEmail`, `sendBatch` or a provider was
  found by searching `lib/` and `app/` for `html:` next to a send, then read.
- Each fixed defect has a test that renders the real builder with synthetic
  text and parses the result; nothing is sent.
- PDFs: every use of `pdf-lib` in `lib/` and `app/` was read; tagged output was
  checked by decoding page content streams in tests.

## Emails

| Builder | Whole page, `<html lang>`, `<title>` | Text version | Layout tables | Images | Contrast | State |
| --- | --- | --- | --- | --- | --- | --- |
| Store emails: list, sequences, waitlist, reviews, product updates, community posts (`lib/mail.ts` `render`) | Yes: subject as title, store or door language | Yes, from the same blocks; picture alt kept as `[alt]` (`lib/mail-picture-rules.ts`) | None | `alt` from the creator (`lib/mail-body.ts`, `lib/mail-product-block.ts`) | Theme colors moved to 7:1 (`lib/email-theme.ts`) | Passes the checks listed |
| Store-closing notice to buyers (`lib/closing-buyers-rules.ts` `letterHtml`) | Title missing | Yes | None | None | 17:1 body, 9.4:1 footer | Fixed in PR #3755 |
| Import letters: moved purchases, member invitations (`lib/imports.ts`) | A bare `<div lang>`: no `<html>`, head or title | Yes | None | None | System colors | Fixed in PR #3755 |
| Event moved or cancelled, to people coming (`lib/community-event-mail.ts` `noticeHtml`) | `<html lang>` but no head, charset or title | Yes | None | None | Footer #57534e on #f7f5f0, 7.00:1 (passes at the edge) | **Open**: file reserved by another agent |
| Access given through the API (`lib/api-write.ts`) | A bare `<div lang>` | Yes | None | None | System colors | **Open**: file reserved by another agent |
| Mail forwarded to a creator (`lib/inbound-mail.ts`) | The sender's own HTML, with our English header line prepended; that line has no `lang` (3.1.2) | Yes | Sender's | Sender's | Header #555 on white, 7.46:1 | **Open**: file reserved by another agent |
| Signed agreement copy, attached as HTML (`lib/agreements.ts`) | Yes; data in a table with row headers | n/a (attachment) | None | None | #444 on white, 9.7:1 | No viewport meta: on a phone it opens laid out wide (1.4.10, observation) |
| Every other send found, for example the purchase email (`lib/purchase-email.ts`) | n/a | Text only | n/a | n/a | n/a | No HTML part found by the search; each one was not opened individually |

Not wired to any send yet: `lib/ad-weekly-report.ts` (an HTML fragment with a
captioned data table). `lib/verify-mail.ts` goes only to the site's internal
test address.

Observations, not yet judged as failures:

- Store email footers are 13px (`lib/mail.ts`, `lib/community-event-mail.ts`).
  WCAG sets no minimum size; recorded for 1.4.8 and the plain-language goal.
- In service letters the link text is the address itself. In context the
  purpose is clear (2.4.4), but the link text alone does not say it (2.4.9,
  AAA). The text version needs the address, so a fix needs words per link.
- Store email bodies start their headings at `<h2>`; the store's name above
  them is a paragraph.

## Generated PDFs

| Generator | Tagged (structure tree, `MarkInfo`) | Language | Title shown | Decoration as artifact | State |
| --- | --- | --- | --- | --- | --- |
| Course certificate (`lib/certificate-pdf.ts`) | Yes (`lib/tagged-pdf.ts`) | Store's | Yes | Frame, rule, seal | Passes `tests/tagged-pdf.test.ts`; text at 7:1 on the paper |
| Form answer (`lib/form-response-pdf.ts`) | Yes, over several pages | Store's | Yes | Yes | Passes its tests |
| Buyer's line stamped on a creator's PDF (`lib/pdf-stamp.ts`) | The line was loose content, so a tagged ebook stopped being tagged once sold (ISO 14289-1 7.1) | Kept | Kept | Now an artifact | Fixed in PR #3761 |
| Preview of a creator's PDF (`lib/pdf-preview.ts` `firstPages`) | Pages are copied into a new file: the structure tree, `MarkInfo` and `Lang` of a tagged source are lost; the copied marked content points at no tree | Lost | Title set, not shown in the window | n/a | **Open**: file in another agent's open PR (#3351) |
| Sale receipt (PR #2952, not merged) | Yes (`PageTagger`) | en-US | Yes | Page background | Not merged; line items are paragraphs, not a table (observation) |
| AI-written product file (PR #3474, not merged) | Uses `lib/tagged-pdf.ts` | — | — | — | Not merged; not audited here |

## Not checked

- Rendering in real mail apps (Gmail, Outlook, Apple Mail), dark mode in them,
  and zoom to 200% inside them.
- A screen reader reading any email or PDF.
- veraPDF or another PDF/UA checker on any generated file.
- Creator-written email content beyond what the builders enforce.
