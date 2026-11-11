# Studio accessibility audit, 11 November 2026 (Claude 4, cloud P)

This record covers an audit of the creator's studio against WCAG 2.2 AAA and ATAG 2.0, as AX274 Part A requires. It is a record of what was checked, how, what failed, what was fixed and what was not checked. **It is not a statement of conformance.** Automated checks, a scripted keyboard and Chromium are not a screen reader, a real device or a person.

The public pages and the checkout were audited by another session (cloud K) and are not covered here.

## Method

- A local production build (`next build`, `next start`) with the synthetic e2e seed (`tests/e2e/store-copy-seed.ts`, `homeDemo`) and a synthetic creator session. The studio runs against the local stand-ins for the database, Stripe and email (`tests/e2e/services.mjs`). No real account, payment or email was used.
- Chromium through Playwright. The audit runs only GET requests, except in flows that save; those flows wrote only to the local synthetic database.
- On each page, at 1280, 390 and 320 px:
  - axe-core with the tags wcag2a–wcag22aaa and best-practice, including `color-contrast-enhanced`, both as the page loads and with every disclosure and toggle open;
  - every interactive element under 44 × 44 px, not counting links inside a sentence;
  - a Tab walk, checking that the focus indicator is visible and that the focus is not trapped;
  - 200 Shift+Tab steps, checking that no focused control is hidden under the sticky header and the section bar.
- Every button on a page pressed in turn from the keyboard, each on a fresh load, recording where the focus lands.
- Text spacing (1.4.12) and reflow at 320 px (1.4.10); line length (1.4.8), measured as characters per rendered line of running text; dark mode requested from the system.
- Editors that the seed cannot reach (a bundle with products, a course quiz) were bundled with esbuild into a minimal page with the App Router context and driven the same way, once with main's component and once with the fixed one.

## Pages

All of these load: start page (`/studio`), products and the product editor, the page editor and its blocks (`/studio/pages`), sales (`/studio/totals`), customers (`/studio/people`), email (`/studio/email`), settings (`/studio/site`, `/studio/tax`, `/studio/team`), inbox, checkup, funnels and "Pages in order", bundles, blog, forms, import, affiliates, community, integrations, deals, payment requests, agreements, phone, outreach, growth, reviews, Path, calendar, meetings, memberships, invoices, labels, disputes, refunds, closing refunds, copy, invite, agent, add, business card (`/studio/card`) and a course (`/studio/course/[id]`).

## What was fixed (pull requests)

| PR | Criterion | What |
| --- | --- | --- |
| #3757 | 2.5.5, 2.4.11, 2.4.12 | The "Studio sections" bar's links went from 36 px to at least 44 × 44 px. Pages that draw the bar keep a scroll padding of 8.5rem, so a focused control is not hidden under the bar. On `/studio` at 1280 px, focused controls hidden went from 2 wholly and 25 partly to 0 and 0. |
| #3758 | 2.5.5 | Underlined-text buttons on the start page (Ship it, license keys, podcast, bundle, the month's goal, "Already done") are now 44 px tall. |
| #3759 | 2.5.5 | A 44 px floor under every summary, and under every label that wraps a checkbox or a radio, for the studio only (`[data-studio]`). |
| #3770 | 2.4.3 | The page editor's "Clear the page" question keeps the focus. Before, the focus fell to the body, and Tab then Enter cleared the page without the question being heard. |
| #3771 | 2.4.3 | A product card's Edit: the focus goes into the form, then back to Edit after Cancel or a save. |
| #3773 | 2.4.3 | Studio-wide focus keeper: a control turned off while busy (`disabled={busy}`, 232 controls in 93 components) gets the focus back once it is on again. |
| #3777 | (defect) | `/studio/card` answered HTTP 500 for every creator, because a function was passed to a client component. |
| #3782 | 2.4.9 | "Do it" and "Its page" now say their destination. |
| #3783 | 2.4.3 | A product card's Remove: the focus goes onto the question, back to Remove on "Keep it", and on to "Add something to sell" once the product is removed. |
| #3784 | 2.4.3 | Closing a disclosure from inside (Cancel, Save) puts the focus back on its summary. |
| #3786 | 2.4.3 | "Pages in order": New funnel, Edit, Remove, Keep it, Cancel and saving no longer drop the focus. |
| #3790 | 2.4.3 | Focus keeper, second part: a moved control gets the focus back, and a control replaced by an editor hands the focus to that editor, only inside `<main>`. On `/studio`, the buttons that drop the focus went from about 20 to 0, with the other PRs applied. |
| #3791 | 2.4.3, 4.1.3 | "The order of your page": the end buttons use `aria-disabled` and say "already first/last", and each move is announced. |
| #3792 | 2.4.3, 4.1.3 | The same for the Move buttons in the bundle, collection and ClickFunnels editors. |
| #3793 | 2.4.3 | A quiz's "Add a question" moves the focus to the new question. |

## Failures found and left to the files' owners

These are in files that other agents' open PRs hold. Each was reported in the agents' channel with its file, line and fix.

- `/studio/deals`: " · 0 open" and " · view only" on the selected pipeline have a 5.63:1 contrast ratio (1.4.6 needs 7:1), from `opacity-80` in `components/deals-board.tsx`.
- `/studio/team`: two landmarks share a name, because the scrolling region of the roles table has the same name as its section (`components/team-manager.tsx`).
- 2.5.5:
  - the studio header's logo (153 × 40 px; 32 × 32 px on a phone);
  - the breadcrumb's "Studio" link (41 px wide);
  - the product card's "Edit" (27 px wide);
  - checkout extras, the checkout questions, the course toggle, the product update box, "Change my address", "Add your profiles", "How Path works" and "Download an example file";
  - in the course editor: "See it as a student does", "Move module up/down" and "Remove module".
- The checkbox on `/studio/inbox` (13 px; its label is 27 px tall).
- Adding a question or a result in `/studio/forms`, and adding a lesson or a module in a course, leaves the focus on the button and announces nothing.

## Proposed, not yet done

- **1.4.8 line length.** On `/studio`, 30 of 128 paragraphs of running text average more than 80 characters per line (up to 110). On `/studio/email` it is 2 of 4 (up to 152), and on `/studio/team` 2 of 5 (up to 95). The public pages and the store already cap the line length; the studio does not. The cap needs the same careful exceptions as the store's, so it was proposed as its own unit.
- **3.1.3 / 3.1.4.** The studio has no glossary and almost no `<abbr>`, while its text uses abbreviations such as API, HMAC, CSV, JSON, UTC, VAT, CVC, RSVP, CRM, VPN and SVG. Where a glossary should live is a product decision.

## Checked, no failure found in what was checked

- axe AAA on all the pages listed above, with every disclosure open. The exceptions are the two findings above (deals, team).
- 2.1.2: no keyboard trap. The repeated stops in date and time fields are the browser walking the field's parts, with the outline visible.
- 2.2.6: the session lasts 30 days.
- 2.5.7: dragging blocks in the page editor has Move up/down buttons.
- 3.3.6 in the page editor: removing a block is announced and can be undone.
- 1.4.10 and 1.4.12: no horizontal scroll and no clipped text at 320 px with wide text spacing, on nine main pages.
- ATAG / AX274 item 6:
  - the page coach asks for a description for every picture and for a clear purpose on every button;
  - block headings are levelled by the code, so a creator cannot put them out of order;
  - the store palette corrects contrast to 7:1 on its own.

## Not checked

- Screen readers (NVDA, JAWS, VoiceOver, TalkBack), Firefox, WebKit, real devices, and testing with people.
- States the seed cannot create: email sending with a real sending domain, refunds, a full course with videos, imported funnels, and saved quizzes.
- Dark mode: the studio does not change its colours. Dark mode is already in the queue (complement WG (a)).
- Whether the 5-second confirmation toast meets 2.2.3. It pauses on hover and focus, closes with Escape and is used only for confirmations; this needs a person's judgement.
