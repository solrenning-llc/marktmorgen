# Ads from inside Marktmorgen: what each ad platform's API asks (632 [AA2] (a))

Study for 632 [AA2] step (a), 2 November 2026, read only: no account created, no review requested, nobody contacted. Owner's rule for this item: the creator's own ad account, card, audiences and history; Marktmorgen never pays, advances, receives or holds ad money; a campaign is created paused and spends only after the creator confirms, with the maximum possible spend shown first.

**State of the evidence: NOT CONFIRMED.** `developers.facebook.com`, `developers.google.com`, `business-api.tiktok.com` and the help centers could not be opened from the session that wrote this (the environment's network policy denies those hosts). Every line below comes from search-engine summaries of the official pages named, not from the pages themselves; no page date could be read. Nothing here may be used in code, a calculation or a public page until each line is confirmed on the page itself, with its date (rule VR item 7). To confirm: allow those hosts in the cloud environment's network settings, then re-read each page.

## Meta Marketing API

- Creating and managing campaigns needs `ads_management` (reading spend, as today, is `ads_read`). Managing other businesses' ad accounts needs the higher access tier, requested through App Review, with Business Verification. Source named: https://developers.facebook.com/docs/permissions
- A changelog summary reports the tiers renamed "Limited access" and "Full access", and the automatic upgrade threshold lowered to 500 Marketing API calls in 15 days. Source named: https://developers.facebook.com/documentation/ads-commerce/marketing-api/marketing-api-changelog.md
- Rate limit summary: `ads_management` calls per ad account per hour of 100,000 (full access) or 300 (limited), plus 40 per active ad. Source named: https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting
- Version: v26.0 summarized as current (29 July 2026). The version tables found disagree on end dates.
- Daily budget overspend: sources disagree. Older docs and the Business Help Center say up to 25% over on a day; the v24 announcement (8 October 2025) and the pricing page say up to 75% on some days for some accounts; all say no more than 7 times the daily budget in a week. The most conservative bound found: 1.75 times the daily budget on a day, 7 times in a week.
- A campaign and an ad set can be created with `status: PAUSED`; an ad set left without a status is created ACTIVE, so PAUSED must always be sent.
- Policy pages named: Ad Standards (transparency.meta.com/policies/ad-standards/), health and wellness including before-and-after, prohibited commercial practices (guaranteed returns). AI disclosure is explicit for social-issue, election and political ads; a general rule for other ads was not confirmed.

## Google Ads API

- Access summary: developer tokens reported replaced on 9 September 2026 by access levels on the Google Cloud project. Levels: Test (test accounts), Explorer (2,880 operations a day), Basic (15,000 a day, automated after brand verification of the Cloud project), Standard (unlimited, manual audit of about 10 business days). Sources named: developers.google.com/google-ads/api/docs/api-policy/access-levels and …/brand-verification
- Version: v26.1 (release notes of 28 October 2026); each version lives about a year.
- Budgets: a day can spend up to 2 times the daily budget; a month is never charged more than 30.4 times the average daily budget. A campaign total budget is never exceeded. Sources named: support.google.com/google-ads/answer/1704443, /6385083, /10486938
- A campaign can be created `PAUSED` (recommended by Google's docs).
- Policy pages named: misrepresentation and unreliable claims, including financial gain and weight loss (support.google.com/adspolicy/answer/15936857); unacceptable business practices (/15938071). Financial services are restricted by country.

## TikTok API for Business (v1.3)

- Developer profile approved first; then an app with chosen permission scopes, reviewed in about 2 to 3 business days. The exact scope names for managing ads were not found.
- Rate limits depend on the app's level; no figure for creating campaigns or ad groups was found.
- Budgets: one help article says no more than 125% of the highest daily budget in a day; another says up to 25% over on some days and at most 7 times the daily budget in a week.
- Status field `operation_status` (`ENABLE`, `DISABLE`); whether an ordinary campaign can be created disabled was not confirmed.
- AI-generated content needs TikTok's AIGC label. Policy pages named: misleading and false content, weight management, financial services (ads.tiktok.com/help).

## What the owner would do, later (never the agent)

Each step needs the owner's own accounts and acceptance of the platform's terms, so it is listed for "Depende do dono", not done:

1. Meta: request `ads_management` at the full access tier through App Review on the existing Meta app, with Business Verification of Solrenning LLC.
2. Google: a Google Cloud project with the Google Ads API, its OAuth app in production with brand verification, then Basic access (and Standard if needed).
3. TikTok: a developer profile, an app with the ads scopes, and its review.

## What follows in the code, once confirmed

The first rules unit of 632 (b): a campaign plan created paused, refused without an end date or a total budget (never an unbounded spend), and the maximum possible spend shown to the creator computed from the confirmed overspend rule of the platform, never from the budget alone.

## Already in the product, not to be built twice (rule "Pedidos repetidos", step 5)

Checked in the code on 2 November 2026:

- **632 (q), a campaign QR code for events and print, with the same sales measure**: short links for posts, videos, talks and flyers (`lib/short-links.ts`, `components/short-links.tsx`) each have their own QR code to download (SVG and PNG) and their own line of visits, sales and revenue in the numbers. Nothing new to build; at most the word "campaign" in the studio's help, later.
- **632 (p), a weekly ads report**: the weekly email (`lib/stats-report.ts`, `weeklyMessage`) already reads the ad spend lines (`lib/ad-spend-rules.ts`, Meta spend read by `lib/meta-ads.ts`) into what is worth knowing. What 632 adds later is a section per campaign, once campaigns are made from here.
- **632 (c), honest ad words**: the store's honesty rules (`lib/terms-check-rules.ts`) are applied to ad text in `lib/ad-creative-check.ts` (632 unit 2), without any platform rule that is not confirmed.
