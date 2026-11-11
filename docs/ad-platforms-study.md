# Ads from inside Marktmorgen: what each ad platform's API asks (632 [AA2] (a))

Study for 632 [AA2] step (a), 2 November 2026, read only: no account created, no review requested, nobody contacted. Owner's rule for this item: the creator's own ad account, card, audiences and history; Marktmorgen never pays, advances, receives or holds ad money; a campaign is created paused and spends only after the creator confirms, with the maximum possible spend shown first.

**State of the evidence (updated 2 November 2026):** the first version below came from search summaries, because the official hosts are denied by this session's network policy. Claude 1 then read the official pages and recorded each point as CONFIRMED, DIVERGENT or NOT FOUND in [docs/ad-platforms-official-check-2026-11-02.md](ad-platforms-official-check-2026-11-02.md) (PR #1766). That record decides: only CONFIRMED points may become code or a calculation; DIVERGENT and NOT FOUND stay gaps, with no value invented.

### What the code may use (CONFIRMED, from the official check)

| Point | Meta | Google | TikTok |
| --- | --- | --- | --- |
| Worst-case spend over the daily budget | 1.75 × daily on a day, 7 × daily in a week (Sunday to Saturday); a campaign under 7 days never spends more than daily × its days ([v24 announcement, 8 Oct 2025](https://developers.facebook.com/blog/post/2025/10/08/introducing-graph-api-v24-and-marketing-api-v24/)) | 2 × the average daily budget on a day, 30.4 × in a month; a campaign total budget is never exceeded ([1704443](https://support.google.com/google-ads/answer/1704443), [6385083](https://support.google.com/google-ads/answer/6385083), [10486938](https://support.google.com/google-ads/answer/10486938)) | 1.25 × the day's highest daily budget on a day, 7 × daily in a week ([daily budget](https://ads.tiktok.com/help/article/how-to-set-up-a-daily-budget-in-tiktok-ads-manager), [dynamic daily budget](https://ads.tiktok.com/help/article/about-dynamic-daily-budget)) |
| Created paused | campaign and ad set `PAUSED`, recommended by Meta ([docs](https://developers.facebook.com/documentation/ads-commerce/marketing-api/advantage-shopping-campaigns)); always sent explicitly | campaign `PAUSED` ([docs](https://developers.google.com/google-ads/api/docs/shopping-ads/create-campaign)) | NOT FOUND (`operation_status` at creation): a gap, so no TikTok campaign is created until it is confirmed |
| Never used | "High demand periods" (budget scheduling, up to 8 × daily) ([reference](https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/high-demand-period)) | — | — |
| Minimum budgets | depend on bid strategy and event (e.g. US$0.50 impressions, US$2.50 clicks, double in some countries); a lowered budget stays at least 10% above what was spent | — | campaign daily above US$50, ad group daily above US$20 ([budget](https://ads.tiktok.com/resources/help/article/budget)) |
| Access | `ads_management` with App Review; Full access with Business Verification to manage others' accounts; Full after 500 calls in 15 days with errors under 15% | access by Google Cloud project (developer tokens ended 9 Sep 2026); brand verification required before Basic; OAuth app External and In production | developer profile, app, scopes, review, token (in part) |
| Policies | NOT FOUND (pages not readable automatically) | unreliable claims (financial gain, weight loss, guaranteed returns) and unacceptable business practices ([15936857](https://support.google.com/adspolicy/answer/15936857), [15938071](https://support.google.com/adspolicy/answer/15938071)) | AI-generated content must be labeled; exaggerated results and before-and-after prohibited ([misleading content](https://ads.tiktok.com/help/article/tiktok-ads-policy-misleading-and-false-content)) |

Gaps kept (NOT FOUND or DIVERGENT): Meta version end dates and its ad policy texts; whether an ad set left without a status starts ACTIVE (so PAUSED is always sent); Google's yearly version life and whether a campaign total budget needs an end date, and country rules for financial services; TikTok scope names, review time, rate limits and the status field at creation.

### Gaps closed on 4 November 2026 (official pages, after the network allowed them)

Read by Claude 3 on 4 November 2026 from the official pages below; each point is CONFIRMED (quoted or closely paraphrased), NOT FOUND or NOT READABLE. Nothing is filled from memory.

- **Meta versions** ([versions](https://developers.facebook.com/docs/graph-api/changelog/versions), no date shown): the page has two tables. Graph API: v24.0 until 18 February 2028, v25.0 until 29 July 2028, v26.0 "TBD". **Marketing API: v24.0 expired on 6 October 2026, v25.0 "TBD", and no v26 row** ("Marketing API version auto-upgrade will release on July 29, 2026"). CONFIRMED. `lib/meta-ads.ts` reads spend with `v26.0` by default and `lib/ad-events.ts` uses `v25.0`; whether a Marketing API call answers on v26.0 is NOT FOUND, reported to Claude 1 (nothing changed here).
- **Meta ad set created without a status** ([ad campaign reference](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign/)): the default when `status` is left out is NOT FOUND; "Only `ACTIVE` and `PAUSED` are valid for creation", and every example sends `status=PAUSED` (CONFIRMED). The rule stays: always send `PAUSED`.
- **Meta Advertising Standards** (transparency.meta.com): NOT READABLE (the network refuses the host). Health and before-and-after, guaranteed returns and the AI label for ordinary ads stay gaps.
- **Google Ads API versions** ([sunset dates](https://developers.google.com/google-ads/api/docs/sunset-dates), last updated 30 October 2026): major versions live about 12 months and minor ones 10; v26 was released on 14 October 2026 with sunset planned for November 2027; at least 20 weeks of overlap before a sunset. CONFIRMED. The page says "at most four" major versions in its summary and "at most five" in its body (DIVERGENT; nothing in the code depends on it).
- **Google total budget** ([CampaignBudget](https://developers.google.com/google-ads/api/reference/rpc/latest/CampaignBudget), [BudgetPeriod](https://developers.google.com/google-ads/api/reference/rpc/latest/BudgetPeriodEnum.BudgetPeriod), [Campaign](https://developers.google.com/google-ads/api/reference/rpc/latest/Campaign), last updated 28 October 2026): `total_amount_micros` is "the budget cap for the campaign's lifetime", only with the `CUSTOM_PERIOD` period, and excludes `amount_micros`; `period` defaults to `DAILY` and cannot change; a campaign's `end_date_time` "defaults to running indefinitely". CONFIRMED. Whether a total budget needs an end date: NOT FOUND (the reference neither requires nor forbids it), so the studio will always ask for the end date with a total budget.
- **TikTok API for Business v1.3** ([portal](https://business-api.tiktok.com/portal/docs)): NOT READABLE (the pages load their text only by script). Scope names, the review time, the call limits and `operation_status` stay gaps; nothing in the code may assume them.

### The first version, from search summaries (history)

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
