# Accessibility backlog: language (13 November 2026)

What the AX274 language sweep of 13 November 2026 left for later. Each item is open until a commit closes it.

## Abbreviations not yet expanded (WCAG 3.1.4)

[`Abbr`](../components/abbr.tsx) draws an abbreviation with what it stands for, from one list ([`lib/abbreviations.ts`](../lib/abbreviations.ts)). Ten studio files that no open pull request touched mark the first time they write one ([`tests/abbreviations.test.ts`](../tests/abbreviations.test.ts)). These still write them bare: in a file an open pull request changes, or inside a string, where the sentence has to become JSX first. Mark the first time each appears on a page with `<Abbr of="…" />`.

| File | Abbreviations (times) | Open PRs on 13 Nov |
| --- | --- | ---: |
| `app/studio/agent/page.tsx` | API (1) | 2 |
| `app/studio/course/[product]/page.tsx` | PDF (1) | 205 |
| `app/studio/page.tsx` | API (1), CRM (2), CSV (1), PDF (1), UTC (8) | 225 |
| `app/studio/paused/page.tsx` | CSV (1) | 3 |
| `app/studio/people/page.tsx` | API (1) | 38 |
| `app/studio/team/page.tsx` | API (1) | 2 |
| `components/affiliate-commission-history.tsx` | CSV (1) | 2 |
| `components/affiliate-leads-studio.tsx` | CSV (1), UTC (1) | 0 |
| `components/affiliate-studio.tsx` | CSV (1), UTC (1) | 6 |
| `components/ai-assist.tsx` | PDF (1) | 11 |
| `components/answers-editor.tsx` | PDF (1) | 1 |
| `components/calendar-editor.tsx` | ICS (1), UTC (1), iCal (2) | 1 |
| `components/certificate-actions.tsx` | PDF (1) | 0 |
| `components/checkup-list.tsx` | UTC (1) | 0 |
| `components/clickfunnels-funnel.tsx` | HTML (1) | 1 |
| `components/course-editor.tsx` | HTML (1) | 13 |
| `components/deal-agenda.tsx` | UTC (1) | 0 |
| `components/deals-board.tsx` | CRM (3), CSV (1), UTC (1) | 4 |
| `components/email-studio.tsx` | API (1), CSV (1), UTC (2) | 15 |
| `components/email-sync-editor.tsx` | API (5) | 1 |
| `components/feature-visuals.tsx` | API (1), PDF (3) | 1 |
| `components/home-parts.tsx` | CSV (1) | 1 |
| `components/host-calendar.tsx` | iCal (5) | 1 |
| `components/licence-key-editor.tsx` | CSV (1) | 2 |
| `components/local-clock.tsx` | UTC (1) | 0 |
| `components/page-editor.tsx` | PDF (1) | 173 |
| `components/page-funnel-editor.tsx` | UTC (1) | 123 |
| `components/path-board.tsx` | UTC (1) | 1 |
| `components/pdf-preview-toggle.tsx` | PDF (2) | 0 |
| `components/pdf-stamp-toggle.tsx` | EPUB (3), PDF (2) | 1 |
| `components/product-editor.tsx` | PDF (1), SKU (1) | 27 |
| `components/quiz-editor.tsx` | UTC (1) | 0 |
| `components/review-ai-summaries.tsx` | UTC (2) | 0 |
| `components/sequence-import-box.tsx` | CSV (1) | 1 |
| `components/shipping-editor.tsx` | SKU (1) | 1 |
| `components/stats-panel.tsx` | CSV (1), UTC (1) | 7 |
| `components/store-assistant-editor.tsx` | PDF (1) | 180 |
| `components/task-editor.tsx` | PDF (1) | 2 |
| `components/tax-editor.tsx` | VAT (3) | 1 |
| `components/team-event-editor.tsx` | iCal (1) | 2 |
| `components/team-manager.tsx` | API (1), UTC (1) | 3 |
| `components/two-step-manager.tsx` | UTC (1) | 0 |
| `components/webhook-editor.tsx` | API (3) | 6 |

## Unusual words (WCAG 3.1.3)

Marktmorgen has no glossary page; [`lib/site-pages.ts`](../lib/site-pages.ts) gives each page a glossary of its own. Creating a site-wide glossary is a page of its own and is not done here. These are the words a creator or buyer may not know, with how often they appear in the site's and the studio's words (components, pages, the help center and the feature pages), to define where they are first used or in a future glossary.

| Word | Times | Files |
| --- | ---: | ---: |
| affiliate | 714 | 48 |
| funnel | 621 | 45 |
| sequence | 281 | 30 |
| pipeline | 212 | 12 |
| passkey | 193 | 22 |
| pixel | 179 | 27 |
| webhook | 168 | 24 |
| workflow | 99 | 11 |
| payment plan | 90 | 31 |
| dispute | 87 | 25 |
| embed | 81 | 19 |
| waitlist | 73 | 15 |
| two-step login | 69 | 14 |
| license key | 63 | 18 |
| cohort | 33 | 8 |
| sales tax | 32 | 12 |
| upsell | 28 | 7 |
| recurring revenue | 16 | 7 |
| order bump | 14 | 8 |
| churn | 10 | 6 |
| round robin | 9 | 3 |
| stamped PDF | 8 | 6 |
| Content-Security-Policy | 7 | 5 |
| chargeback | 5 | 4 |
| Conversions API | 4 | 2 |
| nonce | 3 | 2 |
| reverse charge | 1 | 1 |
| lead magnet | 1 | 1 |
