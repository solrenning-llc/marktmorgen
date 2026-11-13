# EU consumer law audit: Marktmorgen as a marketplace, creators as traders (6 November 2026)

Scope: a reading, with proof, of the EU consumer-law duties that apply to
Marktmorgen as the provider of an online marketplace (and, under the Digital
Services Act, of a hosting service and an online platform), and to creators as
the traders who sell through it. It sets each duty next to what the code on
`origin/main` at `88471da71` already does and what is missing.

This is a document only. It changes no code, price, limit, commission, flag,
gate or term. It is not legal advice and certifies nothing: a "no" in the gap
column means "the code does what the quoted text asks, as read here", not
"conformity confirmed". Every gap below needs its own unit, test and review.

## How it was read

- Official sources only, from the Publications Office's Cellar
  (publications.europa.eu), fetched on **6 November 2026** with
  `curl -sSL https://publications.europa.eu/resource/celex/<CELEX> -H 'Accept: application/xhtml+xml' -H 'Accept-Language: en'`
  (each 303 redirect was followed over https). EUR-Lex itself was not used.
  Downloads are kept outside the repository.
- The consolidated texts reached are dated **28 May 2022** (the day the
  Omnibus Directive applied). Later consolidations of Directive 2011/83/EU
  were tried (`02011L0083-20231218`, `-20231219`, `-20240108`, `-20240109`,
  `-20260619`) and were **not reached** (404). So Directive (EU) 2023/2673,
  which inserted Article 11a and amended Article 6(1)(h), was read in its
  original amending text, not in a consolidated version.
- Code was checked with grep and reads in a clean worktree of `origin/main`.

### Sources and SHA-256 of each file read

| Key | Act | CELEX URL (read 6 Nov 2026) | Resolved Cellar file | SHA-256 |
| --- | --- | --- | --- | --- |
| S1 | Directive 2011/83/EU (CRD), consolidated 28.05.2022 | https://publications.europa.eu/resource/celex/02011L0083-20220528 | https://publications.europa.eu/resource/cellar/51fedfcf-7025-11ea-a07e-01aa75ed71a1.0006.03/DOC_1 | `23b2e4199b115ac65876ec315cdf623abea24db69580f41e32b651e155540cfe` |
| S2 | Directive 2005/29/EC (UCPD), consolidated 28.05.2022 | https://publications.europa.eu/resource/celex/02005L0029-20220528 | https://publications.europa.eu/resource/cellar/bf9a3433-702b-11ea-a07e-01aa75ed71a1.0006.03/DOC_1 | `4fdd501a787024632469709772d833a200c2d9de9b9fe1d9973a519f3750c5bf` |
| S3 | Directive 98/6/EC (price indication), consolidated 28.05.2022 | https://publications.europa.eu/resource/celex/01998L0006-20220528 | https://publications.europa.eu/resource/cellar/6c0a5cd1-ec06-11ec-a534-01aa75ed71a1.0002.02/DOC_1 | `9e4086ee569e8744eab99cbc9f10119a41cb0ae7114fc3759e2a22a2e4c23e2c` |
| S4 | Directive (EU) 2019/2161 (Omnibus), original | https://publications.europa.eu/resource/celex/32019L2161 | https://publications.europa.eu/resource/cellar/eefb17ee-2173-11ea-95ab-01aa75ed71a1.0006.03/DOC_1 | `4f2987a941a32c9fae499098554b206e93b26365fea60353e2f886084174b1ac` |
| S5 | Regulation (EU) 2022/2065 (DSA), original | https://publications.europa.eu/resource/celex/32022R2065 | https://publications.europa.eu/resource/cellar/3ff67256-55c4-11ed-92ed-01aa75ed71a1.0006.03/DOC_1 | `11b119a7d45f3a10cd41714061f9d907839ef5d1634e41774490f00b95856bbf` |
| S6 | Directive (EU) 2023/2673, original (inserts CRD Art. 11a) | https://publications.europa.eu/resource/celex/32023L2673 | https://publications.europa.eu/resource/cellar/ba0121b2-8d8f-11ee-8aa6-01aa75ed71a1.0006.03/DOC_1 | `1183c1f775c7fe6f306a7645dd9f485c48731cf4c5e9393184ab919b21513081` |
| S7 | Regulation (EU) 2018/302 (geo-blocking), original | https://publications.europa.eu/resource/celex/32018R0302 | https://publications.europa.eu/resource/cellar/058372dc-1def-11e8-ac73-01aa75ed71a1.0006.03/DOC_1 | `0ec80603166aa96260f28889ff115093e4da0f643fb948f7e871ca7cc6eae62b` |
| S8 | Commission Recommendation 2003/361/EC (SME definition), original | https://publications.europa.eu/resource/celex/32003H0361 (HTML) | https://publications.europa.eu/resource/cellar/6ca8d655-126b-4a42-ada4-e9058fa45155.0004.01/DOC_1 | `2b3b17217525fe69d2f5bc93eac53509d63f9f35f058366a7e28a8178880fd73` |

Also downloaded and hashed, but superseded for quoting by the consolidated
versions above: the original CRD (`32011L0083`,
`6e9c0ddd987ff051e2ca291bf04cc7891ec002e04e1e5ea4a00f3ba4845e1b3a`), the
original UCPD (`32005L0029`,
`e3bb49ef6c1bc917e05b26032df8d8dd2a37f36fbf1b86bf3f839505419f0c52`) and the
original Directive 98/6/EC (`31998L0006`,
`77d19b7281741263c1ec154c1bec6169f5f5ce8882b1c2a830dcf4e8b4048315`).

### Who is who, as the texts define it

- CRD Art. 2(17) [S1]: "‘online marketplace’ means a service using software,
  including a website, part of a website or an application, operated by or on
  behalf of a trader which allows consumers to conclude distance contracts
  with other traders or consumers". Art. 2(18): "‘provider of an online
  marketplace’ means any trader which provides an online marketplace to
  consumers". Marktmorgen's store pages and checkout fit this reading.
- The Terms already say the creator is the seller: "Each sale made through
  your store is a contract between you and your buyer. Marktmorgen is not a
  party to it" (`app/terms/page.tsx:139-144`).
- DSA micro/small exclusion. DSA Art. 19(1) and Art. 29(1) [S5] exclude
  "providers of online platforms that qualify as micro or small enterprises as
  defined in Recommendation 2003/361/EC" from Section 3 (Arts. 20–28, except
  Art. 24(3)) and Section 4 (Arts. 30–32). Recommendation Annex Art. 2(3) [S8]:
  "a microenterprise is defined as an enterprise which employs fewer than 10
  persons and whose annual turnover and/or annual balance sheet total does not
  exceed EUR 2 million." With no sales open (`PLANS_ON_SALE` false) and a sole
  owner, Marktmorgen reads as a microenterprise today. This is a reading of the
  facts, not a verified status; the exclusion ends with growth (and lasts 12
  months after losing the status, Art. 19(1) second subparagraph). Section 2
  (Arts. 16–18) and Section 1 (Arts. 11–15) have **no** such exclusion, except
  Art. 15(1) (Art. 15(2)).

## The table

Gap: **yes** (missing), **partial** (some of it), **no** (the code does what
the quoted text asks, as read here), **n/a now** (not applicable today, with
the reason).

| # | Obligation | Exact article | Official text read (short literal quote; read 6 Nov 2026) | Where in the code | Gap | Note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | A price-reduction announcement shows the prior price, which is the lowest price of at least the 30 days before | Directive 98/6/EC Art. 6a(1)–(2), inserted by Directive (EU) 2019/2161 Art. 2(1) | "Any announcement of a price reduction shall indicate the prior price applied by the trader for a determined period of time prior to the application of the price reduction." / "The prior price means the lowest price applied by the trader during a period of time not shorter than 30 days prior to the application of the price reduction." [S3 Art. 6a; same words in S4 Art. 2(1)] https://publications.europa.eu/resource/celex/01998L0006-20220528 | The crossed-out price is the product's current price: `components/store-product.tsx:103-119` (`PriceTag`, `money(product.priceCents)` inside `<s>`), used for a sale and for a fair price alike (`offNow`, `components/store-product.tsx:98-100`); sale arithmetic `lib/store-sale.ts:1-4`, `lib/store-sale.ts:103`. Past sales are kept only for chart marks (`lib/store-sale.ts:125-127`, `lib/auto-marks.ts:59`, `lib/store.ts:2755`). No price history: grep for "prior price", "lowest price … 30", "Omnibus", "98/6", "priceHistory" finds nothing | **yes** | The crossed-out figure is not the lowest price of the prior 30 days when the creator raised the price, or ran another sale, inside those 30 days. Nothing records a product's prices over time, so the rule cannot be computed today. Duty sits with the creator (trader); the marketplace draws the announcement, so the code must make it right |
| 2 | Tell the consumer whether the third-party seller is a trader or not, on the seller's declaration | CRD Art. 6a(1)(b); UCPD Art. 7(4)(f) | "whether the third party offering the goods, services or digital content is a trader or not, on the basis of the declaration of that third party to the provider of the online marketplace" [S1 Art. 6a(1)(b)]; UCPD: "for products offered on online marketplaces, whether the third party offering the products is a trader or not" [S2 Art. 7(4)(f)] https://publications.europa.eu/resource/celex/02011L0083-20220528 | No declaration is asked of the creator and no status is shown to the buyer. Terms assume every creator sells: `app/terms/page.tsx:135-144`. The only buyer-facing line names who takes the money: `lib/buyer-words/en.ts:207-208`, drawn at `app/[handle]/page.tsx:522`, `app/[handle]/p/[product]/page.tsx:402`, `app/[handle]/book/[product]/page.tsx:267` | **yes** | Needs a stored declaration (trader / not a trader) per store, shown before the buyer is bound. If a creator declares "not a trader", Art. 6a(1)(c) also applies (row 3) |
| 3 | If the seller is not a trader, say that EU consumer rights do not apply | CRD Art. 6a(1)(c) | "where the third party offering the goods, services or digital content is not a trader, that the consumer rights stemming from Union consumer protection law do not apply to the contract" [S1] https://publications.europa.eu/resource/celex/02011L0083-20220528 | None (follows from row 2) | **yes** | Only arises once row 2 exists. The withdrawal consent box and Art. 11a function would then not apply to that store's sales |
| 4 | Say how contract obligations are shared between seller and marketplace | CRD Art. 6a(1)(d) | "where applicable, how the obligations related to the contract are shared between the third party offering the goods, services or digital content and the provider of the online marketplace" [S1] https://publications.europa.eu/resource/celex/02011L0083-20220528 | Creator-facing Terms say the creator answers buyers and handles refunds and disputes: `app/terms/page.tsx:154-158`. The buyer sees only "Payment is taken by … on [store]'s own account. Marktmorgen never holds the money and takes none of it." (`lib/buyer-words/en.ts:207-208`) | **partial** | The buyer is not told before paying that the creator is the seller and answers for delivery, refunds and the right to withdraw, and what Marktmorgen does (hosting, checkout, notices) |
| 5 | Ranking transparency: main parameters of the order of search results, in a specific section reachable from the results | CRD Art. 6a(1)(a); UCPD Art. 7(4a); definition UCPD Art. 2(m) | CRD: "general information, made available in a specific section of the online interface that is directly and easily accessible from the page where the offers are presented, on the main parameters determining ranking … of offers presented to the consumer as a result of the search query" [S1]; UCPD Art. 7(4a): "When providing consumers with the possibility to search for products offered by different traders or by consumers …" [S2] https://publications.europa.eu/resource/celex/02005L0029-20220528 | Store search returns one store's products "in the creator's order" (`app/[handle]/page.tsx:236`; `lib/catalog.ts:834-842`); the results line says only how many were found (`app/[handle]/page.tsx:418-427`). The one cross-creator list, the affiliate directory, states its order and that nobody can pay to rank higher: `lib/affiliate-directory.ts:212-213`, shown at `app/affiliate-programs/page.tsx:99-101` | **partial** | No cross-trader product search exists today, so UCPD 7(4a) does not bite yet ("different traders"). CRD 6a(1)(a) applies to offers on the marketplace found by a search query; inside one store the order is the creator's own. Cheapest safe step: one sentence next to store search results saying how they are ordered. Any future search across stores needs a full ranking section and, under UCPD Annex I point 11a, clear disclosure of any paid placement |
| 6 | If the trader shows reviews, say whether and how it checks they come from real buyers | UCPD Art. 7(6) | "Where a trader provides access to consumer reviews of products, information about whether and how the trader ensures that the published reviews originate from consumers who have actually used or purchased the product shall be regarded as material." [S2] https://publications.europa.eu/resource/celex/02005L0029-20220528 | Only buyers can review; each review is checked against the paid, non-refunded order on the creator's Stripe account: `lib/reviews.ts:1-31`, `lib/review-proof.ts:1-26`. The rule is told to buyers under the reviews: `lib/buyer-words/en.ts:282-283` ("Only people who bought … can review it, and every review is checked against its order"), drawn at `components/review-list.tsx:188` | **no** | Kept in all seven buyer languages (`lib/buyer-words/*.ts`) |
| 7 | Do not say reviews are from buyers without reasonable steps to check | UCPD Annex I point 23b | "Stating that reviews of a product are submitted by consumers who have actually used or purchased the product without taking reasonable and proportionate steps to check that they originate from such consumers." [S2] https://publications.europa.eu/resource/celex/02005L0029-20220528 | "Verified buyer" / "Verified purchase" labels (`lib/buyer-words/en.ts:269-274`) rest on the order check in `lib/review-proof.ts:1-26`; a full refund takes the stars out (`lib/reviews.ts:28-30`) | **no** | |
| 8 | No false reviews or endorsements, no misrepresenting reviews | UCPD Annex I point 23c | "Submitting or commissioning another legal or natural person to submit false consumer reviews or endorsements, or misrepresenting consumer reviews or social endorsements, in order to promote products." [S2] https://publications.europa.eu/resource/celex/02005L0029-20220528 | Creator cannot edit a review or offer anything for one; hiding keeps the stars in the average and says how many are hidden (`lib/reviews.ts:19-27`). "What people said elsewhere" quotes need a public https source and are never shown as reviews (`lib/sales-page.ts:298-307`). AI page drafts never invent testimonials (`lib/funnel-ai-rules.ts:15`) | **no** | The duty is the trader's; the code removes the tools to break it on Marktmorgen's pages. It cannot stop a creator from paying for reviews elsewhere |
| 9 | Say when a price was personalised by automated decision-making | CRD Art. 6(1)(ea), inserted by Directive (EU) 2019/2161 Art. 4(4) | "(ea) where applicable, that the price was personalised on the basis of automated decision-making;" [S1]; recital 45 of the Omnibus speaks of personalising "for specific consumers or specific categories of consumer based on automated decision-making and profiling of consumer behaviour allowing traders to assess the consumer's purchasing power" [S4] https://publications.europa.eu/resource/celex/32019L2161 | The fair price lowers a product's price by the visitor's country, read automatically from the connection, using World Bank price levels: `lib/fair-price.ts:1-4`, `lib/fair-price.ts:38-40`, applied at `components/store-product.tsx:88-100`. The buyer sees "A fair price for [country]: N% off" and "[store] lowers prices where money buys less" (`lib/buyer-words/en.ts:50-52`) | **partial** | Country-level pricing by purchasing power, chosen by an automated read of the connection, is close to the recital's wording. Under the more protective reading it is a personalised price. The current note says the price depends on the country but not that it was set automatically for this visitor. One added sentence fixes it. Sales (row 1) are the same for everybody and are not personalised |
| 10 | Price differences between EU countries must not be applied to a customer for reasons of residence where the Regulation forbids it | Regulation (EU) 2018/302 Art. 4(1)(b), 4(2) | "receive electronically supplied services from the trader, other than services the main feature of which is the provision of access to and use of copyright protected works …" [S7 Art. 4(1)(b)]; "The prohibition set out in paragraph 1 shall not prevent traders from offering general conditions of access, including net sale prices, which differ between Member States … on a non-discriminatory basis." [S7 Art. 4(2)] https://publications.europa.eu/resource/celex/32018R0302 | `lib/fair-price.ts:1-40` (per-country percentage, creator's choice per country) | **partial** (reading open) | Most store products (e-books, courses, downloads) are copyright works outside Art. 4(1)(b). Memberships with live events or coaching may not be. Art. 4(2) allows prices that differ by Member State if non-discriminatory, but the buyer cannot choose another country's price. Not decided here: put in "Depende do dono" before any EU fair-price default. Fair price is off by default (`lib/fair-price.ts:20-21`) |
| 11 | Before the order: main characteristics, total price, duration and minimum duration shown clearly, directly before ordering; order button says the order means paying ("order with obligation to pay" or an unambiguous equivalent) | CRD Art. 8(2) | "If placing an order entails activating a button or a similar function, the button or similar function shall be labelled in an easily legible manner only with the words ‘order with obligation to pay’ or a corresponding unambiguous formulation indicating that placing the order entails an obligation to pay the trader." [S1] https://publications.europa.eu/resource/celex/02011L0083-20220528 | Normal checkout: the paying button is on Stripe's hosted Checkout page; the session sets `mode` and `locale` but no `submit_type` (`lib/store-checkout.ts:337-355`; grep `submit_type` finds nothing), so the label is Stripe's default. The store's own button "Buy for $X" (`lib/buyer-words/en.ts:184`) only opens that page. One-click offer after paying charges at once from Marktmorgen's own button "Yes, add it for $X" (`lib/buyer-words/thanks.ts:188`, drawn at `app/[handle]/thanks/page.tsx:1225-1227`; DE: "Ja, für … hinzufügen", `lib/buyer-words/thanks.ts:781`) | **partial** | Stripe's own label was **not verified** in this audit (no Stripe page was opened). The one-click button is fully Marktmorgen's: "add it" does not plainly say that pressing it obliges payment; read strictly, it fails Art. 8(2), and the consumer "shall not be bound" if it fails. Safer wording, such as "Buy now for $X" / "Jetzt kaufen", in all seven languages |
| 12 | Digital content: prior express consent to start, acknowledgement of losing the right to withdraw, and confirmation on a durable medium | CRD Art. 16(m) (as replaced by Directive (EU) 2019/2161 Art. 4(12)); Art. 8(7)(b) | "(i) the consumer has provided prior express consent to begin the performance during the right of withdrawal period; (ii) the consumer has provided acknowledgement that he thereby loses his right of withdrawal; and (iii) the trader has provided confirmation in accordance with Article 7(2) or Article 8(7)." [S1 Art. 16(m)]; Art. 8(7)(b): "the confirmation of the consumer's prior express consent and acknowledgment in accordance with point (m) of Article 16" [S1] https://publications.europa.eu/resource/celex/02011L0083-20220528 | `lib/digital-consent.ts:1-66` (rules, two kinds: digital and membership), version `lib/digital-consent.ts:84`, server refusal `lib/digital-consent.ts:184-199` (`consentFromForm`, `requireDigitalConsent`), enforced at `lib/store-checkout.ts:451` and `lib/cart-checkout.ts:120`, one-click offers `lib/upsell.ts:188`; confirmation email `lib/digital-consent-email.ts:32`; Terms `app/terms/page.tsx:167` (`#instant-access`) | **no** | Its own header records that it was read from legislation.gov.uk on 30 October 2026, not from EUR-Lex. The text quoted here, read from the Cellar today, matches its three conditions |
| 13 | Withdrawal function for contracts made online: "withdraw from contract here", statement, "confirm withdrawal", acknowledgement on a durable medium | CRD Art. 11a, inserted by Directive (EU) 2023/2673 Art. 1(3); applies from 19 June 2026 | "the trader shall ensure that the consumer can also withdraw from the contract by using a withdrawal function." / "labelled with the words “withdraw from contract here” or an unambiguous corresponding formulation" / "only with the words “confirm withdrawal” or with an unambiguous corresponding formulation" [S6 Art. 1(3)]; "They shall apply those measures from 19 June 2026." [S6 Art. 2] https://publications.europa.eu/resource/celex/32023L2673 | **Not on main.** Built in PR #2827 (open, not merged; head `claude2/kb9-eu-withdrawal`, `98572e9`): `lib/withdrawal-rules.ts`, `lib/withdrawal.ts`, `lib/buyer-words/withdrawal.ts`, `app/[handle]/orders/withdraw/page.tsx`, `app/api/store/withdraw/route.ts`. Neither `lib/withdrawal-rules.ts` nor `lib/withdrawal.ts` exists in this worktree | **yes on main** (built in #2827) | Gap closes when #2827 is merged and published. Not "available to the customer" before that (VR) |
| 14 | Pre-contract information names the withdrawal function and where it is | CRD Art. 6(1)(h) as replaced by Directive (EU) 2023/2673 Art. 1(2) | "… as well as the model withdrawal form set out in Annex I(B), and, where applicable, information about the existence and placement of the withdrawal function referred to in Article 11a;" [S6 Art. 1(2)] https://publications.europa.eu/resource/celex/32023L2673 | None on main; whether #2827 adds this sentence before ordering was not checked in this audit | **yes on main** | Belongs with row 13 |
| 15 | Trader identity and contact before the contract (address, phone, email) | CRD Art. 6(1)(c) (trader's own duty) | "the geographical address at which the trader is established as well as the trader's telephone number and email address" [S1] https://publications.europa.eu/resource/celex/02011L0083-20220528 | No required trader identity on the store. Optional pieces only: the mail postal address for list emails (`lib/store.ts:293-299`), "Visit us" for a place of business (`lib/visit-us.ts:1-8`, drawn at `app/[handle]/page.tsx:671-672`), and a contact page | **partial** | The duty is the creator's; the marketplace can make it possible and prompt for it. DSA Art. 31 (compliance by design) would oblige that once the micro exclusion ends (row 18) |
| 16 | Trader traceability: collect name, address, phone, email, ID, payment account, trade register, self-certification; verify; show (a), (d), (e) to buyers; keep 6 months after the end | DSA Art. 30(1)–(7) | "shall ensure that traders can only use those online platforms to promote messages on or to offer products or services to consumers located in the Union if, prior to the use of their services for those purposes, they have obtained the following information …" [S5 Art. 30(1)]; "shall make the information referred to in paragraph 1, points (a), (d) and (e) available on its online platform" [S5 Art. 30(7)] https://publications.europa.eu/resource/celex/32022R2065 | None. Stripe's own onboarding of each creator's account is Stripe's record, not Marktmorgen's under Art. 30 | **n/a now** (Art. 29 micro/small exclusion); **yes** once it ends | Planning item, not urgent: build before Marktmorgen stops being micro or small, as the exclusion lasts only 12 more months after that |
| 17 | Compliance by design (interface lets traders give pre-contract, product-safety and identity information) | DSA Art. 31 | "shall ensure that its online interface is designed and organised in a way that enables traders to comply with their obligations regarding pre-contractual information, compliance and product safety information under applicable Union law." [S5 Art. 31(1)] https://publications.europa.eu/resource/celex/32022R2065 | Partly by other duties: row 15 pieces; Terms/refund text checker `lib/terms-check-rules.ts:1-30` | **n/a now** (Art. 29); **partial** on the merits | |
| 18 | Tell buyers of an illegal product or service (identity of trader, redress), past 6 months | DSA Art. 32 | "that provider shall inform, insofar as it has their contact details, consumers who purchased the illegal product or service through its services" [S5 Art. 32(1)] https://publications.europa.eu/resource/celex/32022R2065 | Takedown exists (`lib/takedown.ts:1-19`), but nothing writes to the buyers of a product taken down | **n/a now** (Art. 29); **yes** once it ends | Purchases are read from the creator's Stripe account, not stored by Marktmorgen (`lib/review-proof.ts:5-6`), which shapes how this could be built |
| 19 | Notice and action: easy electronic notice with the four elements; confirmation of receipt; notice of the decision with redress | DSA Art. 16(1), (2), (4), (5) (no micro exclusion) | "the provider of hosting services shall, without undue delay, send a confirmation of receipt of the notice to that individual or entity." [S5 Art. 16(4)]; "notify that individual or entity of its decision in respect of the information to which the notice relates, providing information on the possibilities for redress" [S5 Art. 16(5)] https://publications.europa.eu/resource/celex/32022R2065 | Form at `/report` asks for the page, explanation, name, email and the good-faith and accuracy statements (`components/report-form.tsx:20`, `components/report-form.tsx:120-130`); linked from every store page (`app/[handle]/page.tsx:716-720`). The notifier is emailed nothing by design: `lib/takedown.ts:17-19`; the sent screen says "No copy is emailed to you" (`components/report-form.tsx:58-65`) | **partial** | Arts. 16(1)–(2) are met as read. Art. 16(4) asks to *send* a receipt and 16(5) to notify the decision; neither is sent. The design choice (a public form must not become a way to email anyone) can be kept by sending only to the address typed by the notifier after the notice is filed, once, rate-limited |
| 20 | Statement of reasons to the affected creator for each restriction | DSA Art. 17(1), (3) (no micro exclusion) | "Providers of hosting services shall provide a clear and specific statement of reasons to any affected recipients of the service for any of the following restrictions …" [S5 Art. 17(1)]; must include "(f) clear and user-friendly information on the possibilities for redress" [S5 Art. 17(3)] | The creator is emailed what was taken down, why, and how to send a counter-notice or ask again: `lib/takedown.ts:9-12`, `lib/takedown.ts:183-184` | **partial** (not checked item by item) | Whether every element (a)–(f) of Art. 17(3), including out-of-court settlement and judicial redress, is in the email was not checked line by line here |
| 21 | Legal representative in the EU for a provider with no EU establishment | DSA Art. 13(1), (4) (no micro exclusion) | "Providers of intermediary services which do not have an establishment in the Union but which offer services in the Union shall designate, in writing, a legal or natural person to act as their legal representative in one of the Member States" [S5 Art. 13(1)] https://publications.europa.eu/resource/celex/32022R2065 | Counted as a fixed cost only: `lib/llc-fixed-costs.ts:19` (`eu-dsa-representative`). No representative named on any page (grep "legal representative" in `app/` finds none) | **yes** | Needs a contract: "Depende do dono". No account, contract or contact is authorized by this audit |
| 22 | DSA Section 3 duties of online platforms (complaints system, dark patterns, ads labelling, recommender transparency, minors) | DSA Arts. 20–28 | "This Section, with the exception of Article 24(3) thereof, shall not apply to providers of online platforms that qualify as micro or small enterprises …" [S5 Art. 19(1)] | Transparency counts published anyway (`lib/transparency.ts:1-10`) | **n/a now** (Art. 19) | Same 12-month tail as row 16. Unfair-practice rules in the UCPD (rows 5–8) still apply in full |

## Units proposed (one per gap)

Each unit is separate, small, and must keep every price, limit, commission,
flag and gate as it is. RED is the failing test that proves the gap before the
fix.

1. **Omnibus prior price (row 1).** Keep each product's price per day for at
   least 30 days (one small record per product, written when the price or a
   sale changes), compute the lowest price of the 30 days before a reduction
   starts, and cross out that price, not today's. Files: `lib/store-sale.ts`,
   `lib/fair-price.ts`, `components/store-product.tsx`, `lib/store.ts`
   (where the price and the sale are saved), a new `lib/prior-price.ts`.
   RED: a product at $50, raised to $80 ten days ago, then put on a 25% sale;
   `PriceTag` must cross out $50 (the 30-day lowest), and today it crosses out
   $80. Second RED: a sale that ended five days ago at $40 makes $40 the prior
   price of a new sale.
2. **Trader status declaration (rows 2, 3).** Ask each creator once, in the
   studio, "trader" or "not a trader" (default unanswered, and no EU sale
   until answered, as a new reason in the existing sale checks, not a new
   flag), store it on the store, and show it to the buyer on the product page
   and before paying; for "not a trader", the Art. 6a(1)(c) sentence and no
   withdrawal box. Files: `lib/store.ts`, studio settings component,
   `lib/buyer-words/*.ts`, `app/[handle]/p/[product]/page.tsx`,
   `app/[handle]/page.tsx`. RED: a product page of a store with no declaration
   renders no trader-status line; a "not a trader" store renders no sentence
   that EU consumer rights do not apply.
3. **Who answers for what (row 4).** One buyer-facing sentence before paying:
   the creator is the seller and answers for delivery, refunds and withdrawal;
   Marktmorgen hosts the store and the checkout. Files: `lib/buyer-words/*.ts`
   (next to `paidBy`), the three pages that draw `paidBy`. RED: the product
   page HTML does not contain a sentence naming the creator as the seller.
4. **Search order note (row 5).** One line under store search results: how the
   results are ordered ("in the order [store] chose"). Files:
   `app/[handle]/page.tsx` (results line), `lib/buyer-words/*.ts`. RED: a
   search results page has no statement of its order.
5. **Fair price: automated personalisation notice (row 9).** Add to the fair
   price note that the price was set automatically from the visitor's
   location. Files: `lib/buyer-words/*.ts` (`fairNote`). RED: `fairNote` in
   every language lacks words saying the price was set automatically for this
   visitor.
6. **Geo-blocking reading (row 10).** Documentary first: record the reading of
   Regulation 2018/302 Art. 4 per product kind in "Depende do dono". No code
   until the owner decides. RED: none (decision unit).
7. **One-click offer button label (row 11).** Relabel "Yes, add it for $X" as
   an unambiguous paying phrase in all seven languages, and set `submit_type`
   on the Stripe Checkout session to the paying label Stripe offers after
   reading Stripe's current dated documentation. Files:
   `lib/buyer-words/thanks.ts`, `lib/store-checkout.ts`,
   `lib/cart-checkout.ts`. RED: `yesAdd` in every language contains no word
   from an allowed paying list (buy, pay, order … and their translations);
   the checkout body has no `submit_type`.
8. **Withdrawal function (rows 13, 14).** Merge and publish PR #2827 after its
   review and green CI; then check that the pre-order information names the
   function and where it is (Art. 6(1)(h)). RED for row 14: the product page
   and the checkout consent text do not mention where to withdraw.
9. **Trader identity prompt (row 15).** In the studio, ask for the creator's
   geographic address, phone and email and show them on the store's legal
   line; the store can still sell without them only where the law allows,
   which is the creator's call, told plainly. Files: `lib/store.ts`, studio
   settings, `app/[handle]/page.tsx`. RED: a store page footer has no trader
   address, phone or email even when the creator gave them.
10. **DSA notice receipt and decision (row 19).** After a notice is filed,
    email the notifier once, to the address they typed, a receipt; email the
    decision with redress when it is taken. Rate-limited, no copy of the
    content. Files: `lib/takedown.ts`, `app/api/report/*`,
    `components/report-form.tsx`. RED: filing a notice with an email sends
    nothing (mock sender called zero times); acting on it sends nothing to the
    notifier.
11. **DSA statement of reasons check (row 20).** Compare the takedown email
    with Art. 17(3)(a)–(f) item by item; add what is missing (at least
    out-of-court settlement and judicial redress). Files: `lib/takedown.ts`.
    RED: the email text lacks a mention of out-of-court dispute settlement and
    of judicial redress.
12. **DSA legal representative (row 21).** "Depende do dono": choose and
    contract a representative; then name it on the legal pages. No code
    before the contract. RED (later): the legal page has no representative's
    name, postal address, email and phone.
13. **DSA Section 3 and 4 readiness (rows 16–18, 22).** Planning only while
    the micro exclusion holds: a dated trigger in the queue for when
    Marktmorgen nears the small-enterprise limits, so trader traceability,
    compliance by design and the buyer notice of illegal products are built
    before the exclusion and its 12-month tail end. RED: none now.

## Not reached or not checked

- Consolidated Directive 2011/83/EU after 28 May 2022 (tried five dates, all
  404). Article 11a and the new Article 6(1)(h) were read in Directive (EU)
  2023/2673 itself.
- Stripe's hosted Checkout button label and pre-order summary: not opened, not
  verified (row 11).
- PR #2827's text before ordering (row 14) and the takedown email against
  every element of DSA Art. 17(3) (row 20): not checked line by line.
- National transpositions (for example the German and French rules on price
  reductions and order buttons) and Commission guidance documents: not read.
- Whether Marktmorgen qualifies as a micro or small enterprise is a reading of
  the facts against Recommendation 2003/361/EC, not a verified status.
