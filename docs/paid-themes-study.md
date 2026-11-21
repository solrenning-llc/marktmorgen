# 345 [RN3] — Paid themes and store templates: study (6 November 2026)

**State (VR item 1):** study only, in the queue's sense "documento". Nothing is built, priced,
put on sale or switched on. No account, contact, terms acceptance or payment. This document
does not certify profit, legal treatment or accessibility.

Scope from docs/codex-queue.md item 345 [RN3], with its complement RF (owner, 25/10/2026, 00h11)
and the reopening LQ15 (owner, 28/10/2026, 23h31): study paid store themes sold at a one-time
price, and the sale between creators of themes and store templates exported by 379 [TB5].

## 1. What already exists (not repeated here)

| Piece | Where | What it already decides |
| --- | --- | --- |
| Free template library (page, funnel, email, sequence starters) | docs/ht15-template-library.md, lib/template-library*.ts | Built-in templates open as unsaved drafts; no new provider or cost. This study does not revisit it. |
| Store look | lib/store-look.ts | 4 themes (Paper, Sand, Night, Color) x 5 font pairings x 1 creator color. Every painted color is derived until it reaches a contrast target: 7:1 for button text, 4.5:1 for other accent text, 3:1 for button edges. Pure data, no code. |
| Store export/import | 379 [TB5], lib/store-export.ts | One exporter/importer for pages, draft products, automations, emails and funnels, without buyers, contacts or secrets. RF says to reuse it, never a second flow. |
| Template marketplace | 430 [TM1] | Owner decided a 10% application fee on this marketplace only, charged on the seller's own Stripe account; 0% on stores' own sales unchanged; AX274 automatic checks before a template is published. |
| Curated "Start from this" businesses | 379 [TB5], complement WG (05/11/2026) | Six Marktmorgen-built example businesses, free, as drafts. |
| Generated code | 631 [AA1](d) | AI-generated code only on a separate apps domain, isolated, checked before publishing. Creators never upload custom code (owner's rule, repeated in every "Não gravado" list). |

So the open question for RN3 is narrow: **should Marktmorgen ever charge for a look or a
template, either as the seller (first-party) or by taking a share of creator-to-creator sales
(third-party, which is TM1)?**

## 2. How leading platforms do it today

All reads on 06/11/2026. Direct fetches of shopify.dev and themes.shopify.com were blocked by
this session's network, so the Shopify rows rely on the official pages' text as returned by web
search excerpts; rows marked "secondary" come from non-official pages and are not facts.

| Platform | Who sells | Price to the buyer | Platform share | Quality / accessibility rules | Refunds |
| --- | --- | --- | --- | --- | --- |
| Shopify Theme Store | Approved theme partners | One-time, per store; a listing shows US$100 (official help page excerpt); US$140–400 ranges are secondary | 0% until US$1,000,000 gross theme revenue in a calendar year, then 15% for the rest of that year; resets on 1 January; on gross sales, refunds not deducted; billing carries a 2.9% processing fee plus sales tax [S1] | 5-stage review [S2]; average Lighthouse accessibility score of at least 90 on home, product, collection and cart pages [S3]; partners must keep shipping updates to stay listed [S4] | Official rule not confirmed; secondary sources say Theme Store purchases are non-refundable [S6]. Free trial of a paid theme before publishing; up to 19 at once [S5] |
| Kajabi Template Store | Any developer whose template passes Kajabi's review | Set by the developer; secondary sources report about US$23–897 | 10% plus transaction fees per sale [S7] | Kajabi review; developer responsible for bugs and customer service [S7]. No accessibility rule found | Not found |
| Framer Marketplace | Approved creators (templates, plugins, components) | Set by the creator; no minimum found | 0%: creator keeps 100% [S8]; Framer instead pays referral commission on plan upgrades from templates | Two-stage human review, about 21 days estimated; originality and quality rules [S9]. No accessibility threshold found in the excerpts | Framer does not process refunds; each template shows the creator's refund policy at checkout [S10] |
| Wix Studio Marketplace | Wix Studio partners | Set by the partner | Partners keep 100% "in 2024"; another Wix page says through mid-2025; current terms unknown [S11] | Wix review | Not found |
| Webflow Marketplace | Template creators | Set by the creator | Creator keeps 95% (platform 5%); creators may also sell outside the marketplace with a fulfillment link [S12] | Webflow review | Not found |
| Gumroad (general digital goods, many templates) | Anyone | Set by the seller | 10% + US$0.50 per sale plus card processing (2.9% + US$0.30); Discover sales 30% (secondary) [S13] | None specific | Seller's policy |
| Stan, Podia | No paid theme marketplace found | Themes are included in the plan (Podia generates section themes from six chosen colors [S14]; Stan: secondary only) | — | — | — |

Items from the owner's briefing, checked:

- **"Shopify keeps 15% of third-party themes": partly true.** It is 15% only above US$1M of
  gross theme revenue per partner per calendar year; below that it is 0% [S1]. Most partners
  never pay it.
- **"Median theme price of US$300": not verified.** No official source gives a median. Method if
  needed later: on one dated day, list every paid theme price shown on themes.shopify.com and take
  the median of the observed list prices. Not done (host blocked here); not a fact.
- Envato/ThemeForest fee changes for July 2026 appear only in secondary sources and were left out.

## 3. What the market tells us

1. **Creator platforms do not sell their own looks.** Kajabi, Podia and Stan include themes in the
   plan; paid themes, where they exist, come from third parties. Charging a paying Marktmorgen
   customer for a first-party look would be unusual and could lower the value the customer sees.
2. **Marketplace take rates split into two camps:** 0–5% where the platform earns from the
   subscription upgrade (Shopify below US$1M, Framer, Webflow; Wix kept 0% through 2024 or mid-2025,
   current terms unknown), and 10% at the closest creator comparable (Kajabi, plus transaction
   fees). The owner's 10% in TM1 matches Kajabi.
3. **Every curated marketplace above uses human review** (Gumroad, a general store, has no
   template-specific review). Marktmorgen cannot (no manual work by the owner), so only data-only
   themes checked automatically are possible.
4. **No competitor requires AAA.** Shopify's bar is a Lighthouse score of 90 [S3]; a third-party
   vendor estimates that covers a fraction of WCAG 2.2 (secondary, not used). AX274 asks far more.
5. **Refunds are usually "no refunds" or the creator's own policy.** In the EU, a no-withdrawal rule
   for digital content needs the buyer's prior express consent, an acknowledgement that the right
   is lost, and a confirmation on a durable medium (Directive 2011/83/EU art. 16(m), art. 8(7)) [S15].

## 4. The rules applied to each option

**Option 1 — Marktmorgen sells its own premium theme presets** (more themes/fonts/section
layouts in lib/store-look.ts form, one-time price, as a line on the plan invoice).

- Code rule and AX274: compatible if a theme is data only and goes through the same contrast
  derivation and the AX274 pre-publish checks. Observed gap: lib/store-look.ts targets 7:1 only for
  button text and 4.5:1 for other accent text (`--st-accent-text`), while AX274 asks 7:1 for text
  and WCAG 1.4.6 allows 4.5:1 only for large text; that color is used today on small text in
  components/store-cart.tsx, components/course-outline.tsx and components/store-product.tsx. Any
  paid theme would inherit this until fixed. Not fixed here; recorded in docs/codex-queue.md under
  345 [RN3] for 274 [AX1].
- Manual work: design and per-theme AAA audit would be agent work plus a fixed audit cost
  (unknown, AX274 fixed costs).
- VR: a paid theme is "real" only when sold, applied and audited in production; nothing on a page
  before that.
- Tax: Marktmorgen's own electronic supply, same treatment as the plans (TX points 10, 12, 14, 15, 17).
- Profit: per sale it is positive before the unknown costs, counting only receiving costs and
  taxes (table in section 5). Storage, the AX274 pre-publish checks, the per-theme AAA audit and
  support are unknown, so under MR ("unknown fails") option 1 does not pass the unit rule either
  until they are measured and capped. Demand is unknown, and the market point 1 above argues
  against it.

**Option 2 — creator-to-creator marketplace of themes and store templates** (this is 430 [TM1]
with 379 [TB5]; RN3 only studies it).

- 0% commission on stores' own sales stays: the 10% is a separate fee on a separate product, as the
  owner decided in TM1. It must never reuse COMMISSION_LIVE or the legacy commission percentages.
- **Application fee availability is not settled.** SR5 (owner, 28/10/2026) records Stripe's answer
  that a Brazilian platform account connects US, Canada, UK and EEA creators only with direct
  charges and **no application fees** outside Brazil. TM1's mechanism therefore exists only on the
  US LLC route still under study in 495 [SR6]. On the Brazilian route the fee cannot be taken this
  way.
- Art. 9a: Marktmorgen authorizes the charge, so for a buyer in the EU without a VAT number it is the
  deemed supplier of the template (TX point 13; lib/deemed-supplier.ts). Many small creators are not
  VAT-registered.
- Manual work: review, copyright complaints and refund disputes must run with no owner action.
  Automated checks can verify structure, contrast, alt text, headings, link purpose, absence of
  buyer data and secrets; they cannot verify that the seller owns the images and words. The seller's
  declaration plus an automatic takedown on a valid notice is the only owner-free path found; whether
  that is enough is unknown.
- VR: no fake screenshots, ratings, sales counts or rankings; gallery order written on the page.

**Option 3 — no paid themes; every look stays included.** Matches Kajabi, Podia and Stan; no new
cost; profit only indirectly (retention). Already the current state.

## 5. Worst case per sale (arithmetic only, not a review)

Owner-facing rule LC, through `MOST_CORRECT_READING` in lib/receiving-costs.ts (the code's current
reading; it has no percentage floor): IRPF 15% on profit and IOF 0.38% on the amount remitted
(approximated here as the pre-IRPF profit), dearer provider 6.6% + 30¢ on the amount charged with
buyer tax on top at 27%, remittance 1.5%, refund reserve 1%, dispute reserve 1% of the charge plus
US$30. Not included: storage, checks, screenshots, gallery reads, support and every LLC fixed cost
(FX275), all **unknown**.

The table is printed by `node scripts/paid-themes-study.mjs` from tests/paid-themes-study-table.ts,
which types no fee, reserve or tax rate, and tests/paid-themes-study.test.ts fails if a cell here
differs. Per column, with C the amount charged (`chargedOf`) and F the fee (price × 10%, rounded
down):

- Reading A: F − (`providerFeeCents(C)` + dispute reserve on C + US$30 + remittance and refund
  reserve on F), then IRPF and IOF on a positive result.
- Reading B: F − (remittance and refund reserve on F + Stripe Tax 0.5% on C), then IRPF and IOF.
- Break-even fee: the smallest F in whole cents whose reading-A net keeps MR's positive cent
  (`POSITIVE_NET_CENTS`), as a share of the price.
- First-party theme: price − `receivingOf(price).totalCents`, then IRPF and IOF.

Rounding: integer cents; every fee, reserve and tax rounded up as lib/receiving-costs.ts does; the
fee rounded down; break-even rounded up to 0.01%; margins rounded to the nearest percent.

Two readings for the marketplace fee, because who bears the Stripe fee, disputes and the Stripe Tax
fee on direct charges is not confirmed (SR5: Stripe Tax question still unanswered):

- **Reading A (most onerous):** Marktmorgen bears every receiving cost of the whole sale.
- **Reading B (structure of a direct charge):** fee, disputes and refunds sit on the seller's account;
  Marktmorgen bears remittance and refund reserve on its fee, plus Stripe Tax 0.5% of the charge.

| Sale price | Marktmorgen net at 10%, reading A | at 10%, reading B | Break-even fee, reading A | First-party theme at that price (option 1), receiving and tax only |
| --- | --- | --- | --- | --- |
| US$19 | −US$0.62 | US$1.45 | 13.53% | US$13.57 net (71%) |
| US$49 | −US$0.60 | US$3.76 | 11.33% | US$35.87 net (73%) |
| US$99 | −US$0.53 | US$7.62 | 10.59% | US$73.05 net (74%) |
| US$300 | −US$0.32 | US$23.12 | 10.13% | US$222.49 net (74%) |

Under reading A, 10% loses money on every sale before any other cost; under reading B it is
positive before the unknown costs. MR says unknown fails, so **as of today the TM1 fee does not pass
the unit rule** until Stripe's answer or a test-mode proof shows reading B applies, and the unknown
per-template costs are measured and capped. The first-party figures (71–74%) count receiving costs
and taxes only: storage, checks, the per-theme audit and support are unknown, so **option 1 does not
pass the unit rule either** until they are measured and capped; a sale also says nothing about
volume.
The prices in this table are calculation points, not proposals.

## 6. Unknowns (each fails until measured; none is zero)

- Who pays Stripe's fee, dispute fees and Stripe Tax on a direct charge with an application fee
  (reading A or B); whether application fees exist at all on the chosen route (SR5/SR6).
- Storage, transfer, screenshots, automated checks and gallery reads per template, and their caps.
- Cost of a per-theme AAA audit and of testing with real people (item 202).
- Demand: number of sellers and buyers; Marktmorgen has no customers yet, so expected marketplace
  revenue near opening is close to nothing.
- An owner-free process for copyright complaints and bad-faith listings.
- Shopify's official refund rule and the current Wix terms; the Shopify median price.
- Shopify's theme revenue-share page [S1]: read via excerpt only; confirm directly before any decision.
  Its terms have changed before, and the calendar-year US$1M threshold is the central fact against
  the briefing's "15%".
- Whether creators buying templates count as EU consumers often enough to make art. 9a the normal case.

### Scope points of item 345 still open

- **Whole company:** neither option changes the minimum base of paying customers that must cover
  100% of the LLC fixed costs (FX275) and the funded exposures; a theme or template sale adds no
  known contribution to it until its own unknown costs are measured. No global result is claimed.
- **License:** the terms a buyer gets (one store or several, no resale, no redistribution of the
  seller's images and words, what survives a refund) are not written; a commercial term, so
  "Depende do dono" before any sale.
- **Updates and compatibility:** when lib/store-look.ts or the 379 [TB5] importer changes, a sold
  theme or template must keep importing and keep passing the AX274 checks; who ships the update
  (Marktmorgen for option 1, the seller for option 2) and what happens to a template that stops
  passing are unknown.
- **Taxes for option 2 beyond art. 9a:** US marketplace facilitator laws (TX point 11) and the UK
  platform rule with no threshold for a non-established supplier (TX point 14) may make Marktmorgen
  liable for the template sale; buyer tax on top or taken from the seller's payout, never from
  Marktmorgen's fee. Not studied state by state here; unknown.
- **Worst-month caps:** TM1 asks for per-plan caps on template quantity, size, gallery reads and
  imports in the worst month; none is set here, and each stays unknown until measured.

## 7. Conclusion

- **Option 3 now; option 2 later, inside TM1, in its queue order.** A third-party marketplace is the
  only paid-template path that matches the market, keeps 0% on stores' own sales and needs no
  first-party design work. It should start only after TB5 exists, the platform route allows the fee,
  and reading A or B is settled by evidence.
- **Option 1 is not recommended** while competitors include looks in the plan and the per-theme
  audit cost is unknown; per-sale margin alone does not justify it.
- Every theme, paid or free, must stay data only and pass the same automatic contrast derivation and
  AX274 checks; the 4.5:1 accent-text target (`--st-accent-text`) in lib/store-look.ts should be
  raised to 7:1 in its own unit (not done here; recorded in docs/codex-queue.md under 345 [RN3]).

## 8. Depende do dono

1. **TM1 fee under reading A.** If evidence shows Marktmorgen bears the whole receiving cost, the
   decided 10% loses money per sale; break-even points are in section 5. Keep 10% and wait for
   evidence, or decide again. No change is proposed or made here.
2. **First-party paid themes (option 1):** yes or no. Recommended: no, for now. A yes needs a price
   decision by the owner.
3. **Refund term for template sales:** EU-compliant no-withdrawal with consent and acknowledgement,
   or a fixed refund window. A commercial term, so the owner decides.
4. **Copyright complaints without manual work:** accept an automatic takedown on notice, or keep the
   marketplace closed until a better owner-free process exists.
5. **License terms for theme and template sales:** one store or several, resale and redistribution,
   what survives a refund. A commercial term, so the owner decides before any sale.

## 9. Sources (all read on 06/11/2026)

| # | Source | URL | How read |
| --- | --- | --- | --- |
| S1 | Shopify, Revenue share for Shopify Theme Store developers | https://shopify.dev/docs/storefronts/themes/store/revenue-share | Official; search excerpt (direct fetch blocked) |
| S2 | Shopify, Theme Store requirements | https://shopify.dev/docs/storefronts/themes/store | Official; search excerpt |
| S3 | Shopify Partners blog, Theme Store accessibility requirements | https://www.shopify.com/partners/blog/theme-store-accessibility-requirements | Official blog; search excerpt |
| S4 | Shopify, Updating your theme (Theme Store) | https://shopify.dev/docs/storefronts/themes/store/success/updates | Official; search excerpt |
| S5 | Shopify Help Center, Adding, previewing, and buying themes | https://help.shopify.com/manual/online-store/themes/adding-themes | Official; search excerpt |
| S6 | Archetype Themes help, refunds; Shopify Community threads | https://help.archetypethemes.co/en/articles/1231616 | Secondary |
| S7 | Kajabi Help, Template developer FAQs | https://help.kajabi.com/articles/resources/kajabi-templates/template-developer-faqs | Official; search excerpt |
| S8 | Framer, How the Creator Program works | https://www.framer.com/help/articles/how-the-creator-program-works/ | Official; search excerpt |
| S9 | Framer, Submit a template | https://www.framer.com/templates/submit/ | Official; search excerpt |
| S10 | Framer, How to request a refund for a purchased template | https://www.framer.com/help/articles/how-to-request-a-refund-for-a-purchased-template | Official; search excerpt |
| S11 | Wix Help, Wix Studio: Sell your Studio templates in the Marketplace | https://support.wix.com/en/article/wix-studio-sell-your-studio-templates-in-the-marketplace | Official; search excerpt |
| S12 | Webflow blog, Big update for Webflow Template Creators | https://webflow.com/blog/template-creator-enhancements | Official; search excerpt |
| S13 | Gumroad Help, Gumroad's fees | https://gumroad.com/help/article/66-gumroads-fees.html | Official; search excerpt |
| S14 | Podia Help, Changing your site's colors | https://intercom.help/podia-3dd936dd4247/en/articles/11370342-changing-your-site-s-colors | Official; search excerpt |
| S15 | Directive 2011/83/EU, arts. 8(7) and 16(m) | https://www.legislation.gov.uk/eudr/2011/83/article/16 | Official archive copy; search excerpt; EUR-Lex original not read |

Calculation: `node scripts/paid-themes-study.mjs` (synthetic; tests/paid-themes-study-table.ts reads
lib/receiving-costs.ts; held by tests/paid-themes-study.test.ts). Rounding in section 5.
