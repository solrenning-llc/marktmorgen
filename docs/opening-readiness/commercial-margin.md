# Commercial margin review — opening gate 4 (draft for the owner)

> **Draft only. Nothing here is approved.** `CURRENT_COMMERCIAL_MARGIN_REVIEW` in `lib/commercial-margin.ts:134` stays `null`. Only the owner approves a review and records it in code. This document changes no price, limit, commission, `PLANS_ON_SALE`, `OPENING_REQUESTED`, tax gate, Article 9a gate, commercial review or `stripePlatformEligibilityReady`.

Prepared by Claude 4 (cloud AC) on 14 November 2026, queue message C4-202 (owner, 14 November 2026, 15:45 Fortaleza). Code read at main `3859d4a4ef5980e2341d2411c09a204ed77f2af7`. Supplier pages were checked on 14 November 2026 unless a row says otherwise.

## Summary

| Question | Answer today |
| --- | --- |
| Can paid plans open on gate 4 today? | **No.** `commercialPlansMayOpen(true)` returns `false` at this commit, for six separate reasons (section 3.1). |
| Which units keep a positive net profit at 100% use, worst month, under the LC rule? | Store monthly and yearly, the Store assistant and AI captions: yes, in the model. Studio and Scale: **only** while AI is held to its automatic spend ceiling. |
| Which units lose money at 100% of every right? | **Studio and Scale, monthly and yearly**, when every AI right is used at the largest request the code allows (Sonnet 5.5 with a full-context document). They stay positive under the LC rule if the code allowed Haiku 5.5 only (section 3.2). |
| Minimum paying customer base? | **Not calculable.** All 22 LLC fixed-cost lines are `null` in code and no funded-exposure review exists (section 3.4). |
| What does the owner need to decide? | Section 5. |

## 1. What the code requires (`lib/commercial-margin.ts`)

### 1.1 The review value

`CommercialMarginReview` (`lib/commercial-margin.ts:122`) has these fields:

| Field | Type | What it must hold |
| --- | --- | --- |
| `planPaymentDisputes` | `PlanPaymentDisputeReview` (`lib/plan-payment-dispute-cost-rules.ts:25`) | For each of the six contracts: the most a customer pays under it (principal) and the most it can lose in dispute fees, with evidence. |
| `priceAndRightsSnapshot` | string | Exactly `CURRENT_PRICE_AND_RIGHTS_SNAPSHOT` (`lib/commercial-margin.ts:121`), the JSON of every price, limit and term (schema 29; 18,014 characters, SHA-256 `f2d0bc7889b94e76ccb43c34429d6d456023d5cdeaec7628873bdc3f0ed1bfad` at this commit). Any change to a price or right voids the review. |
| `companyBase` | `CustomerBaseReview` (`lib/customer-base-rules.ts:13`) | Monthly fixed-cost and fixed-tax ceilings, both flags `true`, evidence text, and the reviewed number of paying customers. |
| `fundedExposure` | `FundedExposureReview` (`lib/funded-exposure-rules.ts:6`) | For the current UTC month: a budget and, for each of 8 scopes (trial, setup, full refund, non-payment, post-cancellation, paused, legacy credits, platform waitlist), the most cases a month and the worst case of one. |
| `taxEvidence` | string | Non-empty evidence for the tax review. |
| `costAndLimitEvidence` | string | Non-empty evidence for costs and limits. |
| `allocatedFixedCostsVerified` | boolean | Must be `true`. |
| `prepaidUsageEnforced` | boolean | Must be `true`. |
| `scenarios` | map of `CustomerWorstCase` (`lib/net-margin-rules.ts:14`) | All 9 scenarios of `REQUIRED_MARGIN_SCENARIOS` (`lib/commercial-margin.ts:39`): the 6 plan contracts at full use plus `video_overage`, `visits_overage`, `orders_overage`. |

Each `CustomerWorstCase` holds the revenue collected, the refundable revenue, a tax ceiling, a ceiling for each of 11 cost categories, three flags (`allCostsBounded`, `allTaxesReviewed`, `revenueCollected`) and a TX tax review (`taxReview`, `taxContext`). `assessCustomerWorstCase` (`lib/net-margin-rules.ts:59`) approves it only when every amount is known, the tax ceiling is at least the reviewed TX ceiling, and the net is at least 1 cent (`MINIMUM_NET_PROFIT_CENTS`, `lib/net-margin-rules.ts:7`).

### 1.2 `commercialPlansMayOpen` (`lib/commercial-margin.ts:269`)

| Check | Line | Passes today? |
| --- | --- | --- |
| The owner asked to open (`OPENING_REQUESTED`) | `lib/commercial-margin.ts:270`; `lib/opening.ts:32` | No (`false`, owner's flag). |
| The review is plain data with a known tax state | `lib/commercial-margin.ts:188` | No (review is `null`). |
| Commission: off, or live and proven | `lib/commercial-margin.ts:273` | **Yes**: `COMMISSION_PLANS_PUBLISHED=false` (`lib/plan.ts:99`). |
| Exposure budget configured | `lib/commercial-margin.ts:274`; `lib/exposure-budget-policy.ts:6` | No: `CURRENT_EXPOSURE_BUDGET_POLICY=null`. |
| Contract funding configured | `lib/commercial-margin.ts:275`; `lib/contract-funding-rules.ts:35` | No: `CURRENT_CONTRACT_FUNDING_POLICY=null`. |
| Contract life cycle covered | `lib/commercial-margin.ts:276`; `lib/contract-funding-rules.ts:12` | No: `resourceAllocations`, `renewals` and `settlementAndReserveReconciliation` are `false`. |
| Margin data ready (`commercialMarginDataReady`) | `lib/commercial-margin.ts:205` | No, see below. |

`commercialMarginDataReady` (`lib/commercial-margin.ts:205`), in order:

| Check | Line | Passes today? |
| --- | --- | --- |
| Upload budget policy configured | 207 | Yes. |
| AI spend policy valid **and every AI right funded** (`aiEntitlementsFunded`, `lib/ai-entitlement-rules.ts:40`) | 209 | **No** (section 3.2). |
| Snapshot equals the current terms | 210 | Needs the review. |
| Both evidence strings non-empty | 211 | Needs the review. |
| `allocatedFixedCostsVerified` and `prepaidUsageEnforced` are `true` | 212 | Needs the review. |
| Each scenario's TX review is for that exact scenario | 214–217 | Needs TX evidence. |
| Dispute principal and fees reviewed; each plan scenario's `refundAndDisputeFees` covers the full lost-dispute fees | 221–226 | Needs the review. |
| Every LLC fixed-cost line has a ceiling, and the base covers it monthly and yearly | 230–236 | **No**: all lines `null` (`lib/llc-fixed-costs.ts:44`). |
| Funded exposure approved | 237–238 | Needs the review. |
| Minimum customer base sufficient, with fixed costs plus exposure budget | 241–244 | Needs the above. |
| Non-paying AI pools funded in exposure | 247–253 | Passes vacuously today (no non-paying AI pool). |
| Upload and AI pools funded for every reviewed paying customer | 255 | Needs the reviewed count. |
| All 9 scenarios approved, plan revenue at most the published price, AI cost at least the plan's AI ceiling, with the spend-floor room (25¢ monthly, $1 yearly, `lib/commercial-margin.ts:56`) | 256–267 | **No**: see 3.3 for the three overage scenarios. |

The other opening gates (`taxGateValid`, `deemedSupplierReady`, `stripePlatformEligibilityReady`, `lib/opening.ts:33`) are not part of gate 4 and are not reviewed here.

## 2. Worst case per customer, by unit

### 2.1 Method

- **Use:** every right of the plan at its maximum in the worst month, from the cost registry `tests/plan-cost-registry.ts` (34 monthly lines plus what one payment leaves after the plan ends). A year counts 12 full worst months. The commission on sales is counted as zero.
- **Receiving:** `lib/receiving-costs.ts`, the least favorable reading allowed by SR5: the buyer's tax is added on top of the price at up to 27%; the dearer provider fee (Stripe, 6.6% + 30¢) applies to the whole amount charged; 1.5% remittance allowance; 1% refund reserve; dispute reserve of 1% of (amount charged + $30).
- **LC rule (the profit shown to the owner):** IRPF 15% of the profit (Lei 14.754/2023, art. 5) and IOF 0.38% of the money sent to Brazil (Decreto 6.306/2007, arts. 14 and 15-B XXV). Following the owner's decision on TX point 4, the amount sent is the profit before IRPF, so both apply to the unit's pretax profit, each rounded up to the cent. No ISS, no US federal tax; the buyer's tax is outside the price. **This calculation is made outside the 27.5% floor that the code still carries in `tests/historical-receiving-model.ts:4`.** The per-unit IRPF is conservative: the real IRPF is on the LLC's annual profit after fixed costs.
- **Email (LC rule):** Amazon SES at $0.10 per 1,000 ($0.0001 per email), the owner's account price chosen on 30 October 2026. The code still uses $0.0009 per email (`PER_EMAIL`, `tests/plan-cost-registry.ts:144`); section 2.6 shows both.
- **Code reading, shown apart:** the archived most-tax reading (27% VAT inside the price, 78.18% on profit, ISS 5% of revenue) and the sizing reading (27.5% on profit), from `tests/historical-receiving-model.ts`, with the code's email price. These are **not** the owner's profit.
- **Room:** each plan unit must stay positive after the spend-floor room (25¢ monthly, $1 yearly; 25¢ for the assistant; captions have none).

No figure is typed by hand: every amount below was computed by bundling the repository's own modules at the commit above (the SES price swapped in for the LC columns only).

### 2.2 Supplier prices (one row per rate)

| Cost | Value used | Unit | Official source | Checked |
| --- | --- | --- | --- | --- |
| Stripe card fee | 2.9% + $0.30 | per successful charge | https://stripe.com/pricing | 14 Nov 2026 |
| Stripe international card | +1.5% | per charge | https://stripe.com/pricing | 14 Nov 2026 |
| Stripe currency conversion | +1% | per charge | https://stripe.com/pricing | 14 Nov 2026 |
| Stripe Billing | 0.7% | of billing volume | https://stripe.com/pricing | 14 Nov 2026 |
| Stripe Tax | 0.5% (no-code); the page also lists $0.50 per transaction for the API integration | per charge where registered | https://stripe.com/pricing | 14 Nov 2026 |
| Stripe dispute | $15 received + $15 countered | per dispute | https://stripe.com/pricing | 14 Nov 2026 |
| Stripe Connect, direct charges on creators' accounts | $0 to the platform when Stripe bills the connected account | — | https://stripe.com/connect/pricing | 14 Nov 2026 |
| Stripe API calls | **unknown** (`null` in two cost lines) | per call | https://stripe.com/pricing does not state it | 14 Nov 2026 |
| Paddle (compared, the dearer one is used) | 5% + $0.50 | per charge | repository value, `lib/receiving-costs.ts` | not rechecked; Stripe is dearer at every price here |
| Vercel function memory | $0.0106 | per GB-hour (iad1, the default region for new projects) | https://vercel.com/docs/functions/usage-and-pricing | 14 Nov 2026 |
| Vercel active CPU | $0.128 | per CPU-hour (iad1) | same | 14 Nov 2026 |
| Vercel invocations | $0.60 | per million | same | 14 Nov 2026 |
| Vercel default region | iad1, Washington, D.C. | — | https://vercel.com/docs/functions/configuring-functions/region | 14 Nov 2026; `vercel.json` sets no region, the project's dashboard setting was **not** checked |
| Upstash Redis commands | $0.20 | per 100,000 | https://upstash.com/pricing/redis | 14 Nov 2026 |
| Upstash Redis bandwidth | $0.03 | per GB (no free quota counted) | same | 14 Nov 2026 |
| Upstash Redis storage | $0.25 | per GB-month (no free quota counted) | same | 14 Nov 2026 |
| Cloudflare R2 storage | $0.015 (code holds $0.023, the dearest store) | per GB-month | https://developers.cloudflare.com/r2/pricing/ | 14 Nov 2026 |
| Cloudflare R2 operations | $4.50 Class A, $0.36 Class B | per million | same | 14 Nov 2026 |
| Bunny Stream storage | $0.01 default region (code holds $0.02) | per GB-month | https://bunny.net/docs/stream-pricing | 14 Nov 2026 |
| Bunny Stream delivery | **$0.005** volume network (code); standard network $0.010 to **$0.060** | per GB | same | 14 Nov 2026; the account's network was **not** checked, 2.6 shows $0.060 |
| Bunny Transcribe AI (captions) | $0.10 | per minute per language | same | 14 Nov 2026; the code budgets one extra language per job |
| Anthropic Haiku 5.5 | $0.10 / $0.50 per million tokens up to 100,000-token prompts; $0.50 / $2.50 above | per million tokens | https://platform.claude.com/docs/en/about-claude/pricing | 14 Nov 2026 |
| Anthropic Sonnet 5.5 | $2 / $10 | per million tokens | same | 14 Nov 2026 |
| Amazon SES (LC rule) | $0.10 | per 1,000 emails | https://aws.amazon.com/ses/pricing/ | **not rechecked today**: the page is outside this session's network. Value from AGENTS.md, rule LC (owner, 1 Nov 2026) |
| Resend (code) | $0.0009 per email | per email | https://resend.com/pricing | **not rechecked today**: outside this session's network |

The code adds 10% on every model charge for invoice taxes, exchange and card costs (`PROVIDER_CHARGES_BPS`, `lib/spend-cost-table.ts`).

### 2.3 Per-plan cost lines (worst month, US dollars)

From `COST_LINES` in `tests/plan-cost-registry.ts`. Email lines use SES; the Resend figure follows.

| Cost line | Store | Studio | Scale |
| --- | --- | --- | --- |
| platform-subscription-search | 0.1431 | 0.1431 | 0.1431 |
| assistant-start-reads | 0 | 0 | 0 |
| storage | 0.1150 | 0.9200 | 1.8400 |
| free-delivery | 0 | 0 | 0 |
| video | 0.0576 | 0.4610 | 0.9220 |
| visits | 0.8968 | 2.6376 | 10.5506 |
| orders | 0.1006 | 0.2264 | 0.7546 |
| list-email (SES; Resend 0 / 6.3000 / 9.0000) | 0 | 0.7000 | 1.0000 |
| transactional-email (SES; Resend 0.1380 / 0.3680 / 0.9200) | 0.0180 | 0.0480 | 0.1200 |
| store-email (SES; Resend 0.0681 / 0.2724 / 0.7264) | 0.0081 | 0.0324 | 0.0864 |
| ai (automatic spend ceiling, not the full right; see 3.2) | 0 | 3.3537 | 6.3691 |
| uploads | 0.0574 | 0.3593 | 0.7187 |
| workflows | 0 | 0.5069 | 0.8166 |
| imports | 0.0354 | 0.1649 | 0.3766 |
| clickfunnels | 0.0316 | 0.0966 | 0.1379 |
| funnel-share | 0.0595 | 0.2164 | 0.4480 |
| team-scheduling | 0.0272 | 0.6269 | 1.3469 |
| quizzes | 0.0278 | 0.0278 | 0.0278 |
| collections | 0 | 0 | 0 |
| embed | 0 | 0 | 0 |
| certificate-page | 0 | 0 | 0 |
| public-requests | 0.0573 | 0.2034 | 0.6165 |
| studio | 0.1991 | 0.4152 | 1.1356 |
| store-readings | 0.4084 | 0.4491 | 0.5845 |
| calendar-feed | 3.5903 | 3.5903 | 3.5903 |
| rest-api | 0.0302 | 0.1208 | 0.6041 |
| inbox | 0.0044 | 0.0132 | 0.0439 |
| integrations | 0.0048 | 0.0190 | 0.0476 |
| free-share | 0.1215 | 0.1215 | 0.1215 |
| buyer-actions | 0.0589 | 0.2945 | 0.8835 |
| webhooks | 0.0347 | 0.1158 | 0.3474 |
| task-files | 0.0056 | 0.0230 | 0.0460 |
| database-storage | 0.0381 | 0.1152 | 0.2753 |
| community-pictures | 0.0043 | 0.0214 | 0.0643 |
| **Total per worst month (SES)** | **6.1359** | **16.0235** | **34.0189** |

What one payment leaves after the plan ends (closing, kept data), added once per payment: $0.30 Store, $1.43 Studio, $2.74 Scale. Human support has **no cost line**: see 3.4.

### 2.4 Result per unit under the LC rule (AI held to its automatic ceiling)

All amounts are per payment. "Fee" is the Stripe fee on the amount charged; "Remit." is the remittance allowance.

| Unit | Price | Charged (with buyer tax) | Fee | Remit. | Refund reserve | Dispute reserve | Use | Pretax profit | IRPF 15% | IOF 0.38% | Net | Room | Net after room | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Store monthly | $69.00 | $87.63 | $6.11 | $1.04 | $0.69 | $1.18 | $6.43 | $53.55 | $8.04 | $0.21 | $45.30 | $0.25 | $45.09 | positive |
| Store yearly | $690.00 | $876.30 | $58.17 | $10.35 | $6.90 | $9.07 | $73.93 | $531.58 | $79.74 | $2.03 | $449.81 | $1.00 | $448.97 | positive |
| Studio monthly | $449.00 | $570.23 | $37.97 | $6.74 | $4.49 | $6.01 | $17.45 | $376.34 | $56.46 | $1.44 | $318.44 | $0.25 | $318.24 | positive |
| Studio yearly | $4,490.00 | $5,702.30 | $376.68 | $67.35 | $44.90 | $57.33 | $193.71 | $3,750.03 | $562.51 | $14.26 | $3,173.26 | $1.00 | $3,172.42 | positive |
| Scale monthly | $999.00 | $1,268.73 | $84.07 | $14.99 | $9.99 | $12.99 | $36.76 | $840.20 | $126.03 | $3.20 | $710.97 | $0.25 | $710.75 | positive |
| Scale yearly | $9,990.00 | $12,687.30 | $837.69 | $149.85 | $99.90 | $127.18 | $410.97 | $8,364.41 | $1,254.67 | $31.79 | $7,077.95 | $1.00 | $7,077.10 | positive |
| Store assistant ($69/mo, 700 replies) | $69.00 | $87.63 | $6.11 | $1.04 | $0.69 | $1.18 | $2.48 | $57.50 | $8.63 | $0.22 | $48.65 | $0.25 | $48.44 | positive |
| AI captions, 1 language (worst: 6 min) | $36.00 | $45.72 | $3.34 | $0.54 | $0.36 | $0.76 | $1.20 | $29.80 | $4.47 | $0.12 | $25.21 | $0.00 | $25.21 | positive |
| AI captions, 2 languages (worst: 3 min) | $36.00 | $45.72 | $3.34 | $0.54 | $0.36 | $0.76 | $0.90 | $30.10 | $4.52 | $0.12 | $25.46 | $0.00 | $25.46 | positive |
| AI captions, 3 languages (worst: 2 min) | $36.00 | $45.72 | $3.34 | $0.54 | $0.36 | $0.76 | $0.80 | $30.20 | $4.53 | $0.12 | $25.55 | $0.00 | $25.55 | positive |

The caption rows are the worst length for each language count across every length from 1 to 240 minutes under the LC rule. The assistant's use is its 700 replies at the worst reply cost (`assistantMonthWorst`), on Haiku 5.5 only.

Consumption taxes of the EU (VAT, non-Union OSS), the UK and US states on the plans are charged to the buyer on top of the price (TX points 10, 12, 14, 15, 17); they are not revenue and not a cost of the unit, except the Stripe fee on the larger charged amount, which is included above. US federal income tax is 0% under TX point 8 and state income or franchise tax is 0% below each state's threshold under TX point 9; both points are still under source review in `docs/tx-legal-source-review-2026-10-27.md`. The registrations and filings these taxes need are LLC fixed costs (section 3.4).

### 2.5 Studio and Scale when every AI right is used

The plans publish 40 (Studio) or 80 (Scale) AI writing jobs and 250 or 400 visitor answers a month (`lib/ai-rules.ts:40`, `lib/answers-rules.ts:43`). `aiEntitlementsFunded` prices each permitted call at the largest request the code allows (a 12 MB document filling the 1M-token context, 6,000 output tokens, plus 10% charges): $2.27 on Sonnet 5.5, $0.57 on Haiku 5.5. The automatic ceiling funds only $3.35 (Studio) and $6.37 (Scale) a month.

| Unit | AI funded today (per month) | All AI rights, Sonnet allowed (per month) | All AI rights, Haiku only (per month) | Net after room, today's ceiling | Net after room, all rights, Sonnet | Net after room, all rights, Haiku only |
| --- | --- | --- | --- | --- | --- | --- |
| Studio monthly | $3.35 | $747.89 | $187.06 | $318.24 | **−$368.45** | $162.78 |
| Studio yearly | $3.35 | $747.89 | $187.06 | $3,172.42 | **−$5,185.44** | $1,307.02 |
| Scale monthly | $6.37 | $1,269.15 | $317.43 | $710.75 | **−$422.83** | $447.54 |
| Scale yearly | $6.37 | $1,269.15 | $317.43 | $7,077.10 | **−$6,789.97** | $3,918.46 |

LC rule, SES email. Store has no AI rights.

### 2.6 Sensitivity of the LC result to email and video delivery

Use / net after room, LC rule.

| Unit | SES, Bunny volume ($0.005/GB) | Resend (code), Bunny volume | Resend, Bunny standard at $0.060/GB |
| --- | --- | --- | --- |
| Store monthly | $6.43 / $45.09 | $6.96 / $44.64 | $7.60 / $44.11 |
| Store yearly | $73.93 / $448.97 | $80.26 / $443.61 | $87.91 / $437.14 |
| Studio monthly | $17.45 / $318.24 | $24.34 / $312.41 | $29.42 / $308.11 |
| Studio yearly | $193.71 / $3,172.42 | $276.41 / $3,102.44 | $337.31 / $3,050.90 |
| Scale monthly | $36.76 / $710.75 | $48.61 / $700.73 | $58.76 / $692.14 |
| Scale yearly | $410.97 / $7,077.10 | $553.19 / $6,956.76 | $674.94 / $6,853.74 |

Stripe Tax at $0.50 per transaction instead of 0.5% would add at most 6¢ on a Store monthly charge and 27¢ on a caption charge; no result changes sign.

### 2.7 The same units under the code's archived readings (not the owner's profit)

Net after room, code email price (Resend), Bunny volume. "Most-tax" is the archived gate reading: 27% VAT inside the price, 78.18% on profit (US federal 37% + California 13.3% + Brazil 27.5% + IOF 0.38%), ISS 5% of revenue. "Sizing" is 27.5% on profit with the buyer's tax on top. Both still carry the 27.5% floor.

| Unit | LC rule (for comparison) | Sizing 27.5% | Most-tax, AI at today's ceiling | Most-tax, all AI rights, Haiku only | Most-tax, all AI rights, Sonnet |
| --- | --- | --- | --- | --- | --- |
| Store monthly | $44.64 | $38.25 | $5.56 | $5.56 | $5.56 |
| Store yearly | $443.61 | $380.08 | $54.95 | $54.95 | $54.95 |
| Studio monthly | $312.41 | $267.67 | $41.88 | $1.79 | −$489.24 |
| Studio yearly | $3,102.44 | $2,658.08 | $413.24 | −$67.77 | −$6,407.21 |
| Scale monthly | $700.73 | $600.37 | $94.63 | $26.75 | −$688.13 |
| Scale yearly | $6,956.76 | $5,960.36 | $933.37 | $118.88 | −$9,466.57 |
| Store assistant | $48.44 | $41.68 (before room) | $6.54 | — | — |
| AI captions, 1 / 2 / 3 languages | $25.21 / $25.46 / $25.55 | $21.60 / $21.82 / $21.89 | $3.39 / $3.46 / $3.48 | — | — |

The most-tax column at today's ceiling matches the generated `docs/margin-alignment-2026-10-18.md` before room ($5.62 Store monthly before the 6¢ room effect).

## 3. Which units pass, which fail, and why

### 3.1 Gate 4 as a whole: fails today

1. `CURRENT_COMMERCIAL_MARGIN_REVIEW` is `null` (the owner's decision).
2. `aiEntitlementsFunded` is `false`: Studio and Scale AI rights are not funded at the largest permitted request (3.2).
3. All 22 LLC fixed-cost ceilings are `null` (`lib/llc-fixed-costs.ts:44`), so `allocateEntireLlcFixedCosts` returns `null` (3.4).
4. `CURRENT_EXPOSURE_BUDGET_POLICY` and `CURRENT_CONTRACT_FUNDING_POLICY` are `null`.
5. `contractLifecycleReady()` is `false`: resource allocations, renewals and settlement/reserve reconciliation are not covered.
6. The three overage scenarios cannot pass (3.3).

### 3.2 Per unit, MR rule (net profit above zero with the spend-floor room)

| Unit | Model result (LC) | MR verdict today | Why |
| --- | --- | --- | --- |
| Store monthly | +$45.09 | **Fails on evidence only** | Positive at 100% use. Open evidence: TX review per scenario (FX ceilings, annual books, exchange operations: none exist before the LLC operates), Stripe API call tariff, Vercel project region, Bunny network, SES/Resend prices not rechecked today, support cost. |
| Store yearly | +$448.97 | **Fails on evidence only** | Same. |
| Studio monthly | +$318.24 at the AI ceiling; −$368.45 with every AI right on Sonnet | **Fails on the merits** | A customer using every AI right at the largest Sonnet request costs $747.89 a month in AI against $376.34 pretax profit. |
| Studio yearly | +$3,172.42; −$5,185.44 | **Fails on the merits** | Same, twelve months. |
| Scale monthly | +$710.75; −$422.83 | **Fails on the merits** | $1,269.15 a month in AI at full rights on Sonnet. |
| Scale yearly | +$7,077.10; −$6,789.97 | **Fails on the merits** | Same, twelve months. |
| Store assistant | +$48.44 | **Fails on evidence only** | Positive; Haiku only, pool reserved before every call. Same open evidence as Store. It also needs `PLANS_ON_SALE` (`lib/opening.ts:42`). |
| AI captions | +$25.21 or more | **Fails on evidence only** | Positive at every length; charged before the work. Same open evidence. Sold only with a paid plan. |

With Haiku 5.5 as the only allowed model, Studio and Scale would be positive at every AI right under the LC rule (2.5), and under the archived most-tax reading Studio yearly would still lose $67.77. Changing the allowed models or the AI ceiling is a code change outside this document.

### 3.3 The three overage scenarios

`REQUIRED_MARGIN_SCENARIOS` still requires `video_overage`, `visits_overage` and `orders_overage` to be approved (`lib/commercial-margin.ts:39` and `:256`). None of these overages is sold any more: visits and orders are `"not-sold"` in `CURRENT_COMMERCIAL_TERMS` (`traffic.overage`, `orders.overage`), and the video overage price has not been charged since 31 October 2026 (`lib/watch-rules.ts:13`). A scenario with no collected revenue is refused (`"no_revenue"`, `lib/net-margin-rules.ts:81`), so **no review can pass this check as the code stands**. The fix is a code change (for example, drop the obsolete scenarios or redefine them as "use stops at the plan's figure"), to be decided and reviewed separately.

### 3.4 What is unknown and fails (never zero)

| Unknown | Where | Effect |
| --- | --- | --- |
| All 22 LLC fixed costs: Delaware, California tax and fee, registered agent, formation, owner INSS, domains, tools, deployment artifacts, backup, US mailbox, EU GDPR and DSA representatives, UK GDPR representative, Form 5472, pro forma 1120, Brazilian IRPF filing, CBE, VAT/OSS compliance, ITIN/acceptance agent, US representative, US business address | `lib/llc-fixed-costs.ts:19`, `:44` | Base not calculable. |
| Funded exposure (trial, setup, full refund, non-payment, post-cancellation, paused, legacy credits, waitlist) | `lib/funded-exposure-rules.ts` | Base not calculable. |
| TX review per scenario: FX ceilings, annual books, incoming exchange operations, applicable facts | `lib/customer-tax-review.ts:26` | Every scenario stays `tax_review_unknown`. |
| Stripe API call tariff | `platform-subscription-search`, `assistant-start-reads` lines | Cost not certified. |
| Vercel project region | Vercel dashboard; `vercel.json` sets none | The registry uses the iad1 rates (default region). Another region costs up to 73% more for CPU and memory (São Paulo). |
| Bunny Stream network (volume or standard) | Bunny account | Up to 12× the delivery rate; 2.6 shows the results stay positive. |
| Human support cost | No cost line | `supportAndOperations` is left unknown in the draft. If only the owner answers, the owner must say so, with no paid tool. |
| Amazon SES and Resend prices today | outside this session's network | Not rechecked on 14 November 2026. |
| Company costs that are not plan lines yet (checkout sweep, forget retries, status page, backup) | `NOT_A_COST` in `tests/plan-cost-registry.ts` | Belong in the fixed costs above. |

### 3.5 Minimum paying customer base

**Not calculable.** `assessMinimumCustomerBase` needs the complete monthly fixed-cost and fixed-tax ceilings and the funded-exposure budget; none exists. The repository holds public price observations for some lines (`FIXED_COST_SOURCE_OBSERVATIONS`, `lib/llc-fixed-costs.ts:23`: Delaware $400 a year, California $800 tax plus a fee up to $11,790, registered agent $100 a year, mailbox $59 a month, EU/UK representatives from €79 a month each), but they are quotes, not reviewed ceilings, and several lines have no observation at all.

For the owner's sense of scale only (not a base): the code allows no tax shield on fixed costs, so each $1,000 a month of fixed costs and funded exposure needs the after-room LC net of at least 23 Store monthly, or 4 Studio monthly, or 2 Scale monthly customers.

## 4. Draft `CommercialMarginReview` value

**Draft for the owner. Not in code. `CURRENT_COMMERCIAL_MARGIN_REVIEW` stays `null`.** Every field holds only what has proof; `null`, `false` and empty strings mark what is pending, so the draft cannot pass `commercialPlansMayOpen` by accident. Amounts are US cents, LC rule, SES email, AI at today's automatic ceiling, and `refundAndDisputeFees` raised to the full $30 dispute fees per contract, as `lib/commercial-margin.ts:221` requires. The spend-floor room is added by the code (`scenarioWithPlanRoom`), so `other` is 0.

```typescript
// DRAFT — prepared 14 Nov 2026 at main 3859d4a4ef. Owner approval required. Not imported anywhere.
import { CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, type CommercialMarginReview } from "@/lib/commercial-margin";

const PENDING = ""; // an empty evidence string fails the gate on purpose

// One contract = one payment (monthly, or the yearly price paid at once).
// Principal = the published price; fees = one dispute received ($15) + countered ($15), stripe.com/pricing, 14 Nov 2026.
const dispute = (principal: number) => ({
  maximumPaidPrincipalCents: principal,
  maximumTotalFeesCents: 3_000,
  allContractPaymentsBounded: true, // one payment per contract (lib/plan.ts prices)
  liabilityTailReviewed: false, // PENDING: how long after the period a dispute can still arrive, and whether one payment can be disputed twice
  evidence: PENDING,
});

// Cost categories: infrastructure = hosting, functions and database lines; storageDeliveryVideo = storage, video,
// free-delivery, task-files, community-pictures; email = the three email lines at SES; ai = automatic ceiling;
// paymentAndFx = Stripe fee + 1.5% remittance; postCancellation = per-payment lines;
// refundAndDisputeFees = 1% refund reserve + max(dispute reserve, $30 full dispute fees).
const plan = (collected: number, months: 1 | 12, costs: Record<string, number | null>, taxes: number) => ({
  collectedRevenueCents: collected,
  refundableRevenueCents: 0, // the 30-day money-back refund is the separate full_refund exposure scope
  taxesCeilingCents: taxes, // LC rule: ceil(15% IRPF) + ceil(0.38% IOF) of pretax profit
  costCeilings: costs,
  allCostsBounded: false, // PENDING: support cost, Stripe API tariff, Vercel region, Bunny network, SES price today
  allTaxesReviewed: false, // PENDING: TX review needs FX ceilings, annual books and exchange operations
  revenueCollected: true, // the subscription is charged before the period (checkout coverage true, lib/contract-funding-rules.ts:12)
  taxReview: null, // PENDING: CustomerTaxReview (lib/customer-tax-review.ts:26)
  taxContext: { scenario: "", from: "", through: "", months }, // PENDING: dates of the reviewed period
});

export const DRAFT_COMMERCIAL_MARGIN_REVIEW: CommercialMarginReview = {
  planPaymentDisputes: {
    creator_month: dispute(6_900), creator_year: dispute(69_000),
    pro_month: dispute(44_900), pro_year: dispute(449_000),
    scale_month: dispute(99_900), scale_year: dispute(999_000),
  },
  priceAndRightsSnapshot: CURRENT_PRICE_AND_RIGHTS_SNAPSHOT, // schema 29, SHA-256 f2d0bc78…bfad on 14 Nov 2026
  companyBase: {
    monthlyFixedCostsCeilingCents: null, // PENDING: all 22 lines of lib/llc-fixed-costs.ts
    monthlyFixedTaxesCeilingCents: null, // PENDING
    allFixedCostsBounded: false,
    allFixedTaxesReviewed: false,
    fixedCostsEvidence: PENDING,
    fixedTaxEvidence: PENDING,
    reviewedPayingCustomers: null, // PENDING: needs the two ceilings above
  },
  fundedExposure: null, // PENDING: FundedExposureReview for the month of approval, 8 scopes (lib/funded-exposure-rules.ts:3)
  taxEvidence: PENDING,
  costAndLimitEvidence: PENDING, // the sources of section 2.2 are ready to cite once the open items are closed
  allocatedFixedCostsVerified: false,
  prepaidUsageEnforced: false, // PENDING: AI rights are not funded at the largest request (aiEntitlementsFunded false)
  scenarios: {
    creator_month_full: plan(6_900, 1, { infrastructure: 593, storageDeliveryVideo: 19, email: 3, ai: 0, paymentAndFx: 715, supportAndOperations: null, acquisitionAndAffiliates: 0, fixedBusinessCosts: 0, postCancellation: 30, refundAndDisputeFees: 3_069, other: 0 }, 381),
    creator_year_full: plan(69_000, 12, { infrastructure: 7_113, storageDeliveryVideo: 220, email: 32, ai: 0, paymentAndFx: 6_852, supportAndOperations: null, acquisitionAndAffiliates: 0, fixedBusinessCosts: 0, postCancellation: 30, refundAndDisputeFees: 3_690, other: 0 }, 7_855),
    pro_month_full: plan(44_900, 1, { infrastructure: 1_047, storageDeliveryVideo: 143, email: 79, ai: 336, paymentAndFx: 4_471, supportAndOperations: null, acquisitionAndAffiliates: 0, fixedBusinessCosts: 0, postCancellation: 143, refundAndDisputeFees: 3_449, other: 0 }, 5_419),
    pro_year_full: plan(449_000, 12, { infrastructure: 12_557, storageDeliveryVideo: 1_711, email: 937, ai: 4_025, paymentAndFx: 44_403, supportAndOperations: null, acquisitionAndAffiliates: 0, fixedBusinessCosts: 0, postCancellation: 143, refundAndDisputeFees: 10_223, other: 0 }, 57_677),
    scale_month_full: plan(99_900, 1, { infrastructure: 2_358, storageDeliveryVideo: 288, email: 121, ai: 637, paymentAndFx: 9_906, supportAndOperations: null, acquisitionAndAffiliates: 0, fixedBusinessCosts: 0, postCancellation: 274, refundAndDisputeFees: 3_999, other: 0 }, 12_661),
    scale_year_full: plan(999_000, 12, { infrastructure: 28_286, storageDeliveryVideo: 3_447, email: 1_448, ai: 7_643, paymentAndFx: 98_754, supportAndOperations: null, acquisitionAndAffiliates: 0, fixedBusinessCosts: 0, postCancellation: 274, refundAndDisputeFees: 22_708, other: 0 }, 128_645),
    video_overage: null, // CANNOT PASS: overage not sold (section 3.3); needs a code decision
    visits_overage: null, // same
    orders_overage: null, // same
  },
};
```

With the known amounts above, each plan scenario's net after the code's room would be, in cents: Store 2,069 / 43,124; Studio 29,791 / 317,240; Scale 69,635 / 707,710 (monthly / yearly). These are **after** the full $30 dispute fees and before support. They hold only while AI stays at today's ceiling; with every AI right on Sonnet, Studio and Scale lose (2.5). `acquisitionAndAffiliates` is 0 because the invite program is closed (`INVITE_PROGRAM_OPEN=false`, `lib/creator-invite-rules.ts:56`) and no affiliate is paid by Marktmorgen; `fixedBusinessCosts` is 0 per customer because fixed costs are carried once in `companyBase`.

## 5. What the owner decides

1. **AI on Studio and Scale.** Either (a) allow only Haiku 5.5 for the plans' AI rights, which makes every right fundable with a positive LC profit, or (b) keep Sonnet and accept that these plans cannot pass MR at 100% use, or (c) another bound on the largest request (a smaller document limit). Any of these is a code change for a separate, reviewed PR; no visible limit may be cut (owner, 18 October 2026).
2. **The three overage scenarios** (3.3): approve a code change that removes or redefines them.
3. **Fixed costs:** a reviewed monthly and yearly ceiling for each of the 22 LLC lines, with source and date; without them there is no base.
4. **Funded exposure:** a monthly budget and case limits for the 8 scopes.
5. **Support:** whether support is only the owner's own time (no paid tool), so `supportAndOperations` can be an evidenced 0.
6. **Checks only the owner can make:** the Vercel project's function region, the Bunny Stream network, and the SES account price today.

The TX evidence per scenario (FX ceilings, annual books, exchange operations) can only exist once the LLC operates; until then every scenario stays `tax_review_unknown` and gate 4 stays closed.

## 6. How this was produced and what was not verified

- Amounts: the repository's modules (`lib/receiving-costs.ts`, `tests/plan-cost-registry.ts`, `tests/margin-alignment-table.ts`, `tests/historical-receiving-model.ts`, `lib/ai-entitlement-rules.ts`, `lib/ai-spend-policy.ts`) bundled with the test runner's aliases at main `3859d4a4ef`, with the SES price swapped in only for the LC columns, and Bunny standard delivery only for the sensitivity column. No code or constant was changed.
- No test is added: a test pinning these amounts would turn every unrelated cost change on main into a red build. To check a figure, bundle the same modules at the same commit.
- Not verified: real invoices, the Vercel and Bunny account settings, the SES and Resend pages today, the Stripe API call tariff, the TX facts of the real company, and anything in sections 3.4 and 3.5.
- State (VR item 1): this is a document in a pull request. Nothing is available to customers; nothing is opened.
