# Features of six creator platforms, sorted by what they would cost Marktmorgen

Reviewed 2026-10-18 UTC. For each competitor, its own current features or plans page was read on that date and every feature it names is listed with one mark:

- **(a)** already in Marktmorgen, with the file that implements it;
- **(b)** zero or near-zero marginal cost and fits a creator store: no new supplier charge per use, only what the store's existing meters (its emails, its data room, its public requests, store commands) already count;
- **(c)** costs per use: a model call, SMS or calls, bandwidth or a supplier priced per unit;
- **(d)** belongs to another business, or is left out on purpose (the note says which).

Only what each page names is listed; a feature a page does not show is not listed. A mark of (a) means the code is at main with the cited file; it is not browser, load or live-provider evidence. Nothing here claims Marktmorgen is better than, cheaper than or equal to any of these products, and nothing here changes a price or a limit. Paid sales stay closed.

## Sources

| Id | Page | Accessed |
| --- | --- | --- |
| S1 | [Stan Help Center, "Creator vs. Creator Pro"](https://help.stan.store/article/31-creator-vs-creator-pro) (last updated June 23, 2026) | 2026-10-18 UTC |
| S2 | [Stan Help Center, "Creator Pro Features"](https://help.stan.store/article/407-creator-pro-features) (last updated June 25, 2026) | 2026-10-18 UTC |
| K1 | [Kajabi, product overview](https://www.kajabi.com/product) | 2026-10-18 UTC |
| C1 | [ClickFunnels support, "ClickFunnels Pricing"](https://support.myclickfunnels.com/docs/clickfunnels-pricing/) (updated Oct 12, 2026) | 2026-10-18 UTC |
| H1 | [HighLevel, pricing](https://www.gohighlevel.com/pricing) | 2026-10-18 UTC |
| H2 | [HighLevel support, "How to use Documents & Contracts"](https://help.gohighlevel.com/support/solutions/articles/155000000594-how-to-use-documents-contracts-) (modified 11 Aug 2026) | 2026-10-18 UTC |
| B1 | [Beacons Help, "Beacons Pricing Plans"](https://help.beacons.ai/en/articles/4695681) (last edited November 14, 2025) | 2026-10-18 UTC |
| P1 | [Podia, "Podia vs. Stan Store"](https://www.podia.com/podia-vs-stan-store) (Podia's own page listing its features and plans) | 2026-10-18 UTC |

HighLevel and ClickFunnels are also covered row by row in [highlevel-gap-matrix.md](highlevel-gap-matrix.md) and [clickfunnels-feature-audit.json](clickfunnels-feature-audit.json); the rows below are what their pages above name today.

## Stan (S1, S2)

| Feature | Mark | Evidence or reason |
| --- | --- | --- |
| Storefront on mobile and desktop | (a) | `lib/store.ts`, `app/[handle]/page.tsx` |
| Calendar and booking | (a) | `lib/calls.ts`, `lib/host-calendar.ts` |
| Store and product analytics | (a) | `lib/stats.ts`, `lib/insights.ts` |
| Course builder with course analytics | (a) | `lib/course.ts`, `lib/course-finish.ts` |
| Recurring subscriptions | (a) | `lib/product-recurring.ts`, `lib/membership-access.ts` |
| Lead magnets and email collection | (a) | `lib/free.ts`, `lib/store-join.ts` |
| Community | (a) | `lib/community.ts` |
| Instagram AutoDM (automated replies) | (b) | Not built. Meta charges nothing per message; each reply would be one of the store's existing integration calls and store commands. Blocked on the owner: a Meta app with Instagram messaging permission and Meta's app review. |
| Discount codes, with a limit on uses | (a) | `lib/discount.ts` |
| Limited-quantity offers | (a) | `lib/stock.ts` |
| Upsells and order bumps | (a) | `lib/upsell.ts`, `lib/checkout-ask.ts` |
| Payment plans, Afterpay and Klarna | (a) | `lib/product-recurring.ts`, `lib/payment-methods.ts` (on the creator's own Stripe) |
| Funnels | (a) | `lib/funnel.ts`, `lib/page-funnel.ts` |
| Affiliate management, customers as affiliates | (a) | `lib/affiliates.ts`, `lib/affiliate-payouts.ts` |
| Contact import | (a) | `lib/imports.ts` |
| Email broadcasts and flows | (a) | `lib/broadcasts.ts`, `lib/flows.ts` |
| Meta, Google, Pinterest and TikTok pixels | (a) | `lib/pixels.ts` |

## Kajabi (K1)

| Feature | Mark | Evidence or reason |
| --- | --- | --- |
| Online courses | (a) | `lib/course.ts` |
| Communities | (a) | `lib/community.ts` |
| Newsletters, by email and published on the web | (a) | Email: `lib/broadcasts.ts`. A sent email published as a page of the store, chosen one at a time: `lib/letters.ts` (#554). |
| Coaching with programs, scheduling and payments | (a) | `lib/calls.ts`, `lib/call-packages.ts` |
| Digital downloads | (a) | `lib/product-file.ts`, `lib/delivery.ts` |
| Memberships with tiered access | (a) | `lib/membership-access.ts`, `lib/tier-switch.ts` |
| Podcast hosting and monetization | (a) private, (c) public | A private feed per buyer: `lib/podcast.ts`. A public show is bandwidth per listen. |
| Backstage: coaching programs built from existing content | (c) | A model reads the creator's content: a model call per use. |
| Branded mobile app | (a) partly, (d) store apps | The store and the studio install from the browser (`lib/store-app.ts`, `lib/web-push.ts`). A native app in the app stores is another business (developer accounts, review). |
| Email marketing | (a) | `lib/broadcasts.ts`, `lib/flows.ts` |
| Website builder | (a) | `lib/site-pages.ts`, `lib/sales-page.ts` |
| Funnels and automations | (a) | `lib/funnel.ts`, `lib/flows.ts` |
| Amplify ad network | (d) | An ad network across a platform's customers is another business. |
| Payments, checkout and landing pages | (a) | `lib/store-checkout.ts`, `lib/sales-page.ts` |
| Analytics | (a) | `lib/stats.ts` |
| Contact CRM | (a) | `lib/crm.ts` |
| Cofounder: AI that plans and drafts launches | (a), (c) | AI drafting of a whole store, funnel and pages: `lib/funnel-ai.ts`, `lib/ai.ts`, each a metered model call. |
| Kajabi MCP | (a) | `lib/mcp-tools.ts` |
| Expert Agents: AI trained on the creator's content | (c) | Model calls per use; the store assistant add-on is the closest, priced on its own (`lib/store-assistant.ts`). |

## ClickFunnels (C1)

| Feature | Mark | Evidence or reason |
| --- | --- | --- |
| Funnels | (a) | `lib/funnel.ts` |
| Workspaces and team members | (a) | Up to five stores and team roles: `lib/team.ts`, `lib/team-roles.ts` |
| Contacts and emails a month | (a) | `lib/contacts.ts`, `lib/mail.ts` (each email in the store's existing figure) |
| Courses | (a) | `lib/course.ts` |
| Appointments | (a) | `lib/calls.ts` |
| Custom domains | (a) | `lib/domains.ts` |
| AI tools by words | (a), (c) | `lib/ai.ts`; model calls per use |
| Conversion boosters | (a) | True scarcity and real recent purchases only: `lib/stock.ts`, `lib/recent-sales.ts` |
| Countdown funnels | (a) | A countdown tied to a real end: `lib/sales-page.ts`. An evergreen countdown that restarts per visitor is left out on purpose (fake urgency). |
| Custom code editor | (d) | Left out on purpose: the store pages run under a strict policy on what runs (`lib/csp.ts`). |
| Webhooks and full API | (a) | `lib/webhooks.ts`, `lib/api-read.ts`, `lib/api-write.ts` |
| Affiliate center | (a) | `lib/affiliates.ts` |
| Group onboarding calls, priority and VIP support | (d) | A service, not product code. |
| SSO | (d) | An enterprise sign-in for organizations, not a creator store's need. |

## HighLevel (H1, H2)

| Feature | Mark | Evidence or reason |
| --- | --- | --- |
| Conversation AI | (a), (c) | The store assistant add-on, priced on its own: `lib/store-assistant.ts` |
| Voice AI | (c) | Calls and speech per minute. |
| Content AI, Funnel AI | (a), (c) | `lib/ai.ts`, `lib/funnel-ai.ts` |
| Reviews AI | (a) | Replies to store reviews drafted with AI: `lib/ai.ts`, `lib/reviews.ts` |
| Website and funnel builder | (a) | `lib/site-pages.ts`, `lib/page-funnel.ts` |
| Templates for pages and funnels | (a) partly, (b) more | Nine funnel kinds, starters and three page styles exist (`lib/funnel-starters.ts`, `lib/funnel-types.ts`). More starting pages are content, with no cost per use. |
| Domain management | (a) partly, (c) buying | Connecting a domain: `lib/domains.ts`. Buying one is a registrar charge. |
| CRM and pipelines | (a) | `lib/crm.ts` |
| Custom dashboards and reporting | (a) partly, (b) scheduled to any address | `lib/stats-report.ts`, `lib/custom-range-view.ts`. The weekly email already goes to the creator and up to five team members they choose, each checked against the team when it goes. Any other address, such as an adviser's, would be one of the store's emails; it is kept to the team on purpose today, because the numbers are private. |
| Email marketing | (a) | `lib/broadcasts.ts` |
| SMS marketing | (c) | A carrier charge per message. |
| Inbound and outbound calling | (c) | Per minute. |
| Unified conversations | (a) partly, (c) | Email and community messages in one inbox (`lib/inbox.ts`); SMS, WhatsApp and social channels are per-use or need each platform's app review. |
| Social media management | (b) | Not built. No charge per post from the platforms, but each platform needs its own app review and connection, which only the owner can apply for. |
| Workflow automation | (a) | `lib/flows.ts`, `lib/flow-paths.ts` |
| Forms, surveys and quizzes | (a) | `lib/forms.ts`, `lib/quiz.ts` |
| Booking calendars | (a) | `lib/calls.ts` |
| Ad Manager | (a) partly, (d) | Ad results and audiences from the creator's own ad accounts (`lib/meta-ads.ts`, `lib/ad-audience.ts`); creating ads inside the product is the ad platforms' own tool. |
| Online reputation management | (a) partly | Reviews from paying buyers and asking for them elsewhere: `lib/reviews.ts`, `lib/review-elsewhere.ts` |
| Prospecting tool | (d) | Lead lists of businesses are another business; writing to a business the creator names is `lib/outreach.ts`. |
| Payments and invoicing | (a) | `lib/payment-requests.ts` |
| Documents and contracts with e-signature (H2) | (a) | `lib/agreement-store.ts`, `lib/agreements.ts` (#552) |
| HighLevel mobile app | (a) partly | The studio installs from the browser with push notifications: `lib/web-push.ts` |
| Courses, communities, API | (a) | `lib/course.ts`, `lib/community.ts`, `lib/api-keys.ts` |
| Copying a whole setup (snapshots) | (a) | A funnel is copied by file or into another store (`lib/funnel-bundle.ts`); a whole store into another of the creator's stores, as drafts: `lib/store-copy.ts` (docs/store-copy.md). |
| Sub-accounts, SaaS mode, white-label app, rebilling | (d) | Reselling the platform to agencies' clients is another business. |
| HIPAA compliance | (d) | Not offered, and no page may claim it. |
| WhatsApp, dedicated email IPs, domain purchasing | (c) | Each is a supplier charge. |
| SEO add-on, WordPress hosting, listings management, certification, premium support | (d) | Other businesses or services. |

## Beacons (B1)

| Feature | Mark | Evidence or reason |
| --- | --- | --- |
| Link-in-bio links and several pages | (a) | `lib/store-link.ts`, `lib/site-pages.ts` |
| Media kit for brand deals | (a) | `app/[handle]/media-kit` |
| Store for selling products | (a) | `lib/catalog.ts`, `lib/store-checkout.ts` |
| Email sends and automations | (a) | `lib/broadcasts.ts`, `lib/flows.ts` |
| Page customization | (a) | `lib/store-look.ts` |
| Custom domain | (a) | `lib/domains.ts` |
| AI brand outreach messages | (a) | Drafts to a business the creator names: `lib/outreach.ts` |
| Buy now, pay later | (a) | `lib/payment-methods.ts` (the creator's Stripe methods) |
| Memberships and multi-module courses | (a) | `lib/membership-access.ts`, `lib/course.ts` |
| Order bumps and custom product URLs | (a) | `lib/checkout-ask.ts`, `lib/product-slug.ts` |
| Removing the platform's branding | (a) | `lib/store-look.ts` (`badge`, on Pro) |
| Invoices | (a) | `lib/payment-requests.ts` |
| Analytics and appointments | (a) | `lib/stats.ts`, `lib/calls.ts` |
| Google Workspace, NFC card, white-glove onboarding | (d) | Other businesses or services. |

## Podia (P1)

| Feature | Mark | Evidence or reason |
| --- | --- | --- |
| Courses with drip, quizzes and certificates | (a) | `lib/course.ts`, `lib/quiz.ts`, `lib/certificate.ts` |
| Digital downloads | (a) | `lib/product-file.ts` |
| Coaching | (a) | `lib/calls.ts` |
| Community spaces, group chats, DMs, free or paid tiers | (a) | `lib/community.ts`, `lib/community-chat.ts`, `lib/community-dm.ts` |
| Events: workshops and webinars | (a) | `lib/community-events.ts`, `lib/event-meetings.ts` |
| Website builder, blog, own domain, fonts | (a) | `lib/site-pages.ts`, `lib/blog.ts`, `lib/domains.ts` |
| Email newsletters, welcome sequences, automations | (a) | `lib/broadcasts.ts`, `lib/flows.ts` |
| Affiliate marketing, upsells | (a) | `lib/affiliates.ts`, `lib/upsell.ts` |
| Integrations | (a) | `lib/webhooks.ts`, `lib/email-platforms.ts` |
| Landing pages, social links pages | (a) | `lib/sales-page.ts`, `lib/store-socials.ts` |
| Video storage | (a), (c) | `lib/stream.ts`, `lib/watch.ts`; hours watched are a per-use figure |
| Free migrations | (a) | `lib/imports.ts`, `lib/clickfunnels-csv.ts` |

## The (b) items, in order of creator impact

This order is this review's judgment, not a measurement.

1. **Newsletter issues published on the store** (Kajabi). Built in #554. A creator chooses, per sent email, to publish it as a page of the store, with a list of past issues: a reason to subscribe and a page to share. No new cost: the text is already kept, the pages are the store's public requests, and the index is counted in the data room.
2. **Instagram AutoDM** (Stan). High value to creators who sell from Instagram. Blocked on the owner's Meta app review before any code can be used live.
3. **More starting pages and funnels** (HighLevel templates). Content only; no cost per use. Every starting page must hold no invented testimonial, figure or urgency. Built in #555: three more starter funnels with first words (a membership, a free lesson, a paid call).
4. **Copying a whole store's setup into another store of the same account** (HighLevel snapshots). Uses only the receiving store's data room. Built: `lib/store-copy.ts`, `app/studio/copy` (docs/store-copy.md), charged to the receiving store's studio requests and data room, with no new per-use cost.
5. **A scheduled report to an address outside the team** (HighLevel). One of the store's emails each time; low value, since team members already receive it, and it needs the owner's decision to send store numbers outside the team.
6. **Social planner** (HighLevel). Blocked on each platform's app review.

Built from this list: item 1 in #554 (`lib/letters.ts`, `app/[handle]/letters`, `tests/letters.test.ts`); item 3 in #555 (`lib/funnel-starters.ts`); item 4 in the store copy (`lib/store-copy.ts`). Each other item will be its own tested pull request.
