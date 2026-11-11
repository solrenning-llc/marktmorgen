> **MR update — owner27/10/2026 07h42Fortaleza.** The18October pricing explanation below is preserved as history. Its60%floor and theoretical alternative threshold prices are superseded, not current instructions or new price proposals. Current prices and every visible allowance remain unchanged. See [the current MR model rows](#mr--current-price-registered-model-27-october2026) and [the complete model report](margin-alignment-2026-10-18.md). Unknown costs still fail;60%is the actual monthly company target.

# Prices, limits and how value is presented, 18 October 2026

The owner's decision, in chat, verbatim:

> 11:21 — "preço: o que maximiza o meu lucro. limites: combinação que potencializa o que maximiza meu lucro + o que cliente percebe alto valor + não remover limites visíveis"
>
> 11:22 — "preço e limites = preço e limites de cada plano"
>
> 11:25 — "você deve verificar como os melhores concorrentes fazem para ver como o cliente veria alto valor em mim."

This supersedes, for Marktmorgen only, the earlier rule that a price is never changed to meet the floor. Hazelsong's prices do not change. No sale opens: the tax gate (`lib/tax-gate.ts`, most-tax reading), the EU art. 9a deemed-supplier gate (`lib/deemed-supplier.ts`) and the commercial review (`lib/commercial-margin.ts`) keep `PLANS_ON_SALE` false.

## How competitors present value

Each row is only what the page named shows, read on 18 October 2026 (UTC) unless it says otherwise. "Open" means the page states no figure or says "unlimited".

| Competitor and source | Plans and prices | Highlighted | What each card leads with | Limits stated | Left open | Yearly framing |
| --- | --- | --- | --- | --- | --- | --- |
| Stan, [stan.store/blog/stan-store-pricing/](https://stan.store/blog/stan-store-pricing/) (Stan's own article, last updated July 22, 2026) | Creator $29/mo or $300/yr; Creator Pro $99/mo or $948/yr | None formally; the FAQ points beginners to Creator | The features list: Creator Pro is "Everything in Creator, plus" discount codes, upsells, order bumps, affiliates, email broadcasts and flows, pixels | 0% transaction fee | Products and customers ("unlimited" in the FAQ); emails on Creator Pro ("unlimited emails"); no figure for contacts or storage | "save $48", "save $240" beside the yearly price |
| Kajabi, [kajabi.com/pricing](https://kajabi.com/pricing) | Basic $179/mo, Growth $249/mo, Pro $499/mo; yearly shown as $143, $199, $399 a month | Pro, "Most Popular" | One line of whom it is for ("No limits, full customization and dedicated support." on Pro), then the limits | Products 5 / 50 / unlimited; contacts 2,500 / 25,000 / 100,000; websites 1 / 1 / 3; admin users 2 / 11 / 26; AI credits 0 / 500 / 1,000 | Marketing emails, funnels, landing pages ("Unlimited"); no figure for email volume, storage, bandwidth or video | A "Save 20%" toggle, and "Save $432/year", "Save $600/year", "Save $1200/year" |
| ClickFunnels, [support.myclickfunnels.com/docs/clickfunnels-pricing/](https://support.myclickfunnels.com/docs/clickfunnels-pricing/) (updated Oct 12, 2026) | Launch $97/mo or $970/yr; Scale $197 or $1,970; Optimize $297 or $2,970; Dominate yearly only, $5,997 | Scale, "Most popular" | The limits table | Workspaces 1 / 5 / 10 / 20; team 2 / 5 / 10 / 20; contacts 10K / 75K / 150K / 400K; emails a month 50K / 300K / 750K / 1.2M; courses 3 / 6 / 10 / 20; AI words 1M / 2M / 5M / 10M; domains 5 on Launch | Visitors, funnels ("unlimited", funnels for a limited time); domains from Scale | "Annual Discount" column: ten monthly payments |
| HighLevel, [gohighlevel.com/pricing](https://www.gohighlevel.com/pricing) | Starter $97/mo or $970/yr; Unlimited $297 or $2,970; Agency Pro $497 or $4,970; Enterprise by contact | Unlimited, "MOST POPULAR" | Whom it is for ("Perfect for smaller businesses and solo marketers") | Sub-accounts: 3 on Starter | Contacts and users ("unlimited"); email, SMS and AI are "usage based charges" with no rate on the page | "Save with annual" toggle: ten monthly payments |
| Beacons, [help.beacons.ai/en/articles/4695681](https://help.beacons.ai/en/articles/4695681) (edited November 14, 2025) | Free $0; Creator $10/mo or $100/yr; Creator Plus $30 or $300; Creator Max $90 or $900 | None stated | Who it suits ("serious sellers ready to maximize their earnings" for Creator Plus) | Transaction fee 9% on Free and Creator, 0% from Creator Plus; email sends 50 / 500 a month on Free and Creator | Marketing emails on Creator Plus ("unlimited"); AI generations on Creator Max ("unlimited") | "Annually at $100/year": ten monthly payments |
| Linktree, [linktr.ee/s/pricing](https://linktr.ee/s/pricing) | Free, Starter, Pro, Premium; the page as read showed no dollar figure | Pro, "Recommended" | "Everything in Starter, plus:" and the features | "Sell and earn with 0% fees" on Pro; a $0.25 payout fee in its FAQ | Links ("unlimited") | Not shown in the reading |
| Gumroad, Podia | Not read: the fetch of gumroad.com/pricing and podia.com/pricing was refused on 18 October 2026, so nothing is asserted about them here | | | | | |

**What a buyer compares**, from these pages: the price a month, the share taken from a sale, emails a month and contacts, products and courses, AI allowance, team seats, and the yearly saving. Every leader prints its limits on the card itself, highlights one middle or upper plan, and frames the year as ten monthly payments or "save $X". Visitors, products and marketing emails are the lines the leaders most often leave open.

## The method for the price

There is no demand data, so the price that maximizes profit cannot be measured; it is chosen by rule, stated here:

1. **The floor.** For each unit, the lowest price at which every allowance used in full keeps 60% net under the sizing reading of `lib/receiving-costs.ts` (the dearer fee on the amount charged with the buyer's tax on top at 27%, remittance, refund and dispute reserves, at least 27.5% on profit, the commission on sales counted as zero), plus the room `tests/spend-floor.test.ts` keeps under a unit on sale (25¢ a month, $1 a year, the add-on's 25¢). `floorPriceCents` in `tests/margin-alignment-table.ts` searches it; `docs/margin-alignment-2026-10-18.md` prints it, and `tests/margin-alignment.test.ts` holds every unit on the price list at or above it.
2. **Every floor is above the comparable competitor plan.** Store's floor is above Stan Creator ($29) and Beacons Creator Plus ($30); Studio's is above Stan Creator Pro ($99), the $97 entry plans of ClickFunnels and HighLevel and Kajabi Growth ($249); Scale's is above Kajabi Pro ($499) and HighLevel Agency Pro ($497). Every dollar above the floor widens the gap a buyer sees beside those cards, so each price is the **lowest round price, monthly first, at or above the floor with its room, such that the year at ten monthly payments also keeps it**. Round means the points the owner prefers ($69, $449, $999: what Pieter Levels would set). Ten months for twelve is what ClickFunnels, HighLevel and Beacons charge, and Marktmorgen's convention.
3. **The products do not compete on price.** None of these prices is "cheap": each is set by what the limits printed on the plan cost to deliver at full use, at about twenty dollars of price for each dollar a month of use, because receiving one payment takes about 12% of revenue and the floor leaves 17.24% for every cost.

## The price list

| Unit | Floor at the limits before this change | Floor at the limits in force | Price | Net at full use (sizing reading) | Closest competitor plan, its price | Its limits beside ours |
| --- | --- | --- | --- | --- | --- | --- |
| Store monthly | $60.50 | $62.83 ($67.70 with room) | **$69** | 60.31% | Stan Creator, $29 | Stan: products and customers open, no email; Store: 3,400 visits, 200 orders, 5 GB storage, 4 video hours, no list email or AI |
| Store yearly | $551.65 | $578.98 ($598.35 with room) | **$690** (ten months) | 60.59% | Stan Creator, $300 | as above |
| Studio monthly | $365.83 | $401.45 ($406.60 with room) | **$449** | 60.38% | Kajabi Growth, $249; ClickFunnels Scale, $197; HighLevel Unlimited, $297 | Kajabi Growth: 25,000 contacts, 50 products, 500 AI credits, emails open; ClickFunnels Scale: 75,000 contacts, 300,000 emails a month; Studio: 10,000 visits, 450 orders, 7,000 list emails, 40 AI writing jobs and 250 answers, 40 GB storage, 32 video hours |
| Studio yearly | $3,977.83 | $4,406.00 ($4,425.70 with room) | **$4,490** (ten months) | 60.06% | Kajabi Growth, $199 a month yearly | as above |
| Scale monthly | $835.40 | $871.65 ($876.63 with room) | **$999** | 60.46% | Kajabi Pro, $499; HighLevel Agency Pro, $497 | Kajabi Pro: 100,000 contacts, unlimited products, 1,000 AI credits, emails open; Scale: 40,000 visits, 1,500 orders, 10,000 list emails, 80 AI writing jobs and 400 answers, 80 GB storage, 64 video hours |
| Scale yearly | $9,338.48 | $9,775.80 ($9,795.18 with room) | **$9,990** (ten months) | 60.07% | Kajabi Pro, $399 a month yearly | as above |
| Store assistant add-on, a month | $61.20 ($65.90 with room) | the same | **$69** (was $49), 700 replies | 60.40% | HighLevel AI Employee, $50 or $97 a month per sub-account (no reply count on the page) | ours: 700 replies a month in the store's chat, handed to the creator when it cannot answer |
| AI captions | $3.99 a minute a language needs an $850 minimum; $6.00 needs $32.00 | the same | **$6.00 a minute a language, never less than $35** (was 25¢ and $2) | 60.00% at its worst length | none of the pages above prices captions | — |

"Before this change" is the floor at the figures in force on the morning of 18 October 2026 (3,000 visits on Store, 5,000 and 8,000 list emails on Studio and Scale), measured with the same search. The prices were chosen at the limits before the raises below: there, Studio at $399 a month would have made the year $3,990, which keeps 60% but not its $1 of room, so Studio is $449; Scale at $899 a month would have needed a year above ten monthly payments, so Scale is $999. The raises were then sized to the room these prices leave, and the floors in force are the ones in the third column.

**The result, stated plainly:** at these prices Marktmorgen costs about twice the competitor plan a buyer will compare it with (Store $69 against Stan's $29, Studio $449 against Kajabi Growth's $249, Scale $999 against Kajabi Pro's $499), and four and a half times Stan Creator Pro ($99) for Studio, and prints smaller email and contact figures than the leaders. That is what the 60% rule at full use, under this receiving model, requires. Whether creators buy at these prices is not known and cannot be until sales open.

## Which visible limits were raised, and why these

No visible limit was cut. The room each round price left above its floor, on the tighter of its two intervals (the year for Studio and Scale, the month for Store), was spent where the leaders print the most and Marktmorgen the least:

| Plan | Raised | Why this line | Room left |
| --- | --- | --- | --- |
| Studio | List emails 5,000 → **7,000** a month | Emails a month is the figure every leader prints (ClickFunnels 50,000 to 1.2M, Kajabi and Stan Creator Pro "unlimited") | Studio yearly keeps 60.06% |
| Scale | List emails 8,000 → **10,000** a month | the same | Scale yearly keeps 60.07% |
| Store | Visits 3,000 → **3,400** a month | Store has no list email to raise; visitors are the line ClickFunnels leaves open | Store monthly keeps 60.31% |

Matching a leader outright is not possible at these prices: 43,000 more emails on Studio to reach ClickFunnels Launch's 50,000 would cost $38.70 a month at full use, and so about $760 a month more of price. The Store assistant's 700 replies stay: the $69 price leaves 39¢ of room, too little for a round step.

## The commission variant

Removed. With the commission on sales counted as zero by the owner's rule, a lower price "with commission" can never keep 60%: at the published $22, $149 and $349 every plan kept 53% to 55% (`docs/margin-alignment-2026-10-18.md`). `PRICES_WITH_COMMISSION` is now the same price list as `PRICES_WITHOUT_COMMISSION`, `COMMISSION_PLANS_PUBLISHED` is false, so every page says 0% of a sale, and `isSharedPrice` can never be true. `COMMISSION_LIVE` stays false and the share machinery (`lib/platform-share.ts`) stays as built, switched off.

## How the cards present it

The cards follow what the leaders do, from the code only: the price first, then "0% of sales", the yearly line with "two months free" when the year is ten monthly payments, and then, under the price, the five figures a buyer compares (visits, orders, list emails, AI, storage), read from the constants the product enforces. No figure is called unlimited, no plan is marked "most popular" (no customer exists), and Store keeps its "Where to start" mark.

## Owner steps at Stripe

None is needed to create prices by hand. The checkout makes each plan's Stripe price itself, under the lookup key `nimbus_<tier>_<cycle>`, the first time it is needed, and uses a price at Stripe only when its amount, currency and interval match `lib/plan.ts`; otherwise it makes a new one and moves the lookup key to it (`ensurePrice` in `lib/billing.ts`, `transfer_lookup_key`). The Store assistant's price is made the same way (`lib/assistant-billing.ts`), and AI captions are charged by amount. No environment variable holds a price ID. When sales open, after the first checkout of each plan: in the Stripe dashboard, Product catalog, archive the old $29, $99, $249, $300, $948 and $2,388 prices (and the $49 Store assistant price), so no old link can be used.


## MR — Current-price registered model (27 October2026)

Generated from the actual CI renderer for MR; amounts are registered-model calculations under the binding most-tax reading, not actual invoices or certified margins. No new price or limit is proposed. All costs/coverage outside the model, the full LLC base, SR3requirements and real accounting remain unapproved where unknown. The commercial/art9a/Stripe-eligibility and other gates remain closed.

| Unit | Current price | Revenue | Receiving and reserves | Full usage | Taxes | Net profit | Net margin | Cost room | With room | On sale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Store monthly ($69) | $69.00 | $54.33 | $9.14 | $6.94 | $32.63 | $5.62 | 10.34% | $0.25 | positive | no |
| Store yearly ($690) | $690.00 | $543.30 | $85.65 | $80.23 | $322.24 | $55.18 | 10.15% | $1.00 | positive | no |
| Studio monthly ($449) | $449.00 | $353.54 | $55.97 | $24.67 | $231.04 | $41.86 | 11.84% | $0.25 | positive | no |
| Studio yearly ($4,490) | $4,490.00 | $3,535.43 | $553.98 | $281.07 | $2,287.94 | $412.44 | 11.66% | $1.00 | positive | no |
| Scale monthly ($999) | $999.00 | $786.61 | $123.76 | $49.06 | $519.21 | $94.58 | 12.02% | $0.25 | positive | no |
| Scale yearly ($9,990) | $9,990.00 | $7,866.14 | $1,231.82 | $559.83 | $5,142.35 | $932.14 | 11.85% | $1.00 | positive | no |
| Store assistant add-on ($69/mo, 700 replies) | $69.00 | $54.33 | $9.14 | $2.48 | $36.12 | $6.59 | 12.12% | $0.25 | positive | no |
| AI captions, 1 language (6 min, $36.00) | $36.00 | $28.34 | $5.06 | $1.20 | $18.69 | $3.39 | 11.96% | $0.00 | positive | no |
| AI captions, 2 languages (3 min, $36.00) | $36.00 | $28.34 | $5.06 | $0.90 | $18.92 | $3.46 | 12.20% | $0.00 | positive | no |
| AI captions, 3 languages (2 min, $36.00) | $36.00 | $28.34 | $5.06 | $0.80 | $19.00 | $3.48 | 12.27% | $0.00 | positive | no |
