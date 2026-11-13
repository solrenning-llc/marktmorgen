# EU art. 9a and UK VAT: sources re-read on 13 November 2026, and the build spec per checkout path

Status: documentation only. Nothing here builds a VAT treatment, fills `DEEMED_SUPPLIER_RECORDS`, changes a price, a limit, the commission, a flag or a gate, or opens sales. `PLANS_ON_SALE` (`lib/opening.ts`) stays false, and `deemedSupplierReady()` (`lib/deemed-supplier.ts`) stays false because the registry is empty. No tax consultation was made or drafted. No account, registration, terms acceptance, payment or third-party contact was made.

Reading rule applied (TX policy in AGENTS.md, 27 Oct 2026): the legally correct reading, grounded in the text of the law, regulation or official decision with article and date. Not the most-tax reading by default. A point that could not be read today, or that the text does not settle on Marktmorgen's facts, is a **gap that fails**: it is never treated as zero and never as "assumed fine".

## What this document adds to earlier work

It reuses, and does not repeat, these documents:

- [eu-vat-article-9a.md](eu-vat-article-9a.md) (18 Oct 2026, with the 19 Oct checkpoint): the first art. 9a analysis, the reasons why Marktmorgen authorises the charge, authorises delivery and sets the terms, and a first path table and build list. Part of its body was written under the retired rule 19 (most-tax reading, ISS 5% as certain, consultations). Those parts are history.
- [tx-legal-source-review-2026-10-27.md](tx-legal-source-review-2026-10-27.md): the TX1 source matrix. Points 12 to 14 there were partial. For point 13 the full texts of Regulation 282/2011 and of Fenix were blocked by an anti-robot page.
- [tx4-oss-evidence.md](tx4-oss-evidence.md) and [tx4-uk-vat-evidence.md](tx4-uk-vat-evidence.md) (4 Nov 2026): the non-Union OSS and UK VAT return and record routines, read in Commission, Irish Revenue and HMRC guidance. They leave the costs unknown.
- [eu-vat-retention-funding.md](eu-vat-retention-funding.md) (19 Oct 2026): the 132-month storage cohort ceiling and the funding formula for the 10-year records.

New in this document:

1. **Primary EU texts read in full today from EUR-Lex.** This covers the consolidated Regulation 282/2011 (version of 14 Apr 2025), the consolidated Directive 2006/112/EC (versions of 1 Jan 2025 and 14 Apr 2025, which are identical for every article cited here) and the full judgment in C-695/20 Fenix. Earlier rounds relied on the UK National Archives copy, search snippets or a press release.
2. **Corrections to article numbers used in earlier notes and in the task brief.**
   - The non-Union scheme is arts. 358a to 369 of the Directive.
   - Arts. 369a to 369k are the Union scheme, which is for suppliers established in the EU, and the goods facilitator scheme.
   - For the non-Union scheme, the return currency and exchange-rate rule is **art. 366**, not 369h.
   - The 10-year record rule is **art. 369(2)**.
   - Art. 63c(1) of the Regulation refers to records "within the meaning of Articles 369 and 369k".
3. **A scope divergence in TX point 13.**
   - Art. 9a covers only electronically supplied services (and VoIP).
   - Live services are not left without a supplier question. Art. 28 of the Directive still applies on the facts, and Fenix para. 54 says it covers "all categories of services".
   - Live streamed educational or entertainment activities take the customer's place under art. 54(1), second subparagraph.
   - Physical goods sold by a non-EU seller inside the EU fall under the separate deeming rule of art. 14a(2).
4. **A per-path build spec, the funding gap and an exact definition of a `DEEMED_SUPPLIER_RECORDS` entry**, written for the builder.

## Part 1 — Official sources, read 13 November 2026

All EUR-Lex texts were downloaded through the session's proxy as HTML and read in full. The quotes below are copied from those texts. EUR-Lex consolidated texts say they are "meant purely as a documentation tool and has no legal effect"; the authentic text is the Official Journal. No difference from the OJ text was looked for, so this remains a residual limit.

### 1.1 Sources and read status

| # | Source | URL | Read today? |
| --- | --- | --- | --- |
| S1 | Council Implementing Regulation (EU) No 282/2011, consolidated 14 Apr 2025 (02011R0282-20250414) | https://eur-lex.europa.eu/eli/reg_impl/2011/282/2025-04-14/eng | **Yes, in full** |
| S1b | Same Regulation, original OJ text (ELI `/oj`) | https://eur-lex.europa.eu/eli/reg_impl/2011/282/oj/eng | Yes, but it is the 2011 text, without arts. 9a, 24a–24f and 63c. Used only to confirm that the consolidation is the right source. |
| S2 | Council Directive 2006/112/EC, consolidated 1 Jan 2025 (02006L0112-20250101) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02006L0112-20250101 | **Yes, in full** |
| S2b | Same Directive, consolidated 14 Apr 2025 (02006L0112-20250414), the latest listed on EUR-Lex today | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:02006L0112-20250414 | **Yes, in full.** Arts. 14a, 28, 44, 58, 73, 196, 242a, 358a, 359, 364–367 and 369 were compared word for word with S2 and are identical. |
| S3 | European Commission, DG TAXUD, Explanatory notes on the 2015 place-of-supply changes (3 Apr 2014) | https://taxation-customs.ec.europa.eu/system/files/2016-09/explanatory_notes_2015_en.pdf | **Not read today.** The host is blocked by this session's network proxy (CONNECT 403; WebFetch could not resolve the host). A web search also shows a later Commission "Explanatory Notes on TBE services" dated 30 Jul 2021 (listed on vat-one-stop-shop.ec.europa.eu, also blocked); it has not been read. The §3.4.6 quotes in eu-vat-article-9a.md come from the 18 Oct 2026 read and are not re-verified. |
| S4 | CJEU, Grand Chamber, C-695/20 Fenix International Ltd v HMRC, judgment of 28 Feb 2023 (ECLI:EU:C:2023:127) | https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:62020CJ0695 | **Yes, in full**, from EUR-Lex. curia.europa.eu and InfoCuria are blocked by the session's proxy, but the EUR-Lex text is the published judgment. |
| S5 | HMRC, VAT Notice 741A (place of supply of services), and HMRC guidance on digital services to UK consumers and online marketplaces | https://www.gov.uk/guidance/vat-place-of-supply-of-services-notice-741a and other gov.uk pages | **Not read today.** www.gov.uk, assets.publishing.service.gov.uk and www.legislation.gov.uk are blocked by this session's proxy. The last read was on 27 Oct 2026 (TX1 matrix, point 14: Notice 741A, updated 29 Sep 2022, s. 2.6) and on 4 Nov 2026 (tx4-uk-vat-evidence.md). |

To close S3 and S5, the owner must allow these hosts in the session's network settings: `taxation-customs.ec.europa.eu`, `vat-one-stop-shop.ec.europa.eu`, `www.gov.uk` and `www.legislation.gov.uk`. `curia.europa.eu` is also needed for InfoCuria. Until then, S3 and S5 are gaps.

### 1.2 Regulation 282/2011 (S1)

**Art. 7(1), electronically supplied services ("ESS"):** "services which are delivered over the Internet or an electronic network and the nature of which renders their supply essentially automated and involving minimal human intervention, and impossible to ensure in the absence of information technology."

**Art. 7(2)** lists what is covered, including:

- (a) "the supply of digitised products generally, including software and changes to or upgrades of software";
- (c) "services automatically generated from a computer via the Internet or an electronic network, in response to specific data input by the recipient";
- (f) "the services listed in Annex I".

**Art. 7(3)** lists what is not covered, including:

- (c) "goods, where the order and processing is done electronically";
- (i) "services of professionals such as lawyers and financial consultants, who advise clients by e-mail";
- (j) "teaching services, where the course content is delivered by a teacher over the Internet or an electronic network (namely via a remote link)";
- (n) "telephone helpdesk services";
- (t) "tickets to cultural, artistic, sporting, scientific, educational, entertainment or similar events booked online".

**Annex I** (Art. 7):

- point (3)(c): "the digitised content of books and other electronic publications";
- (3)(d): "subscription to online newspapers and journals";
- (4)(a)–(c): accessing or downloading music, sounds and films;
- (4)(f): video on demand;
- (4)(h): "the supply of audio and audiovisual content via communications networks which is not provided by and under the editorial responsibility of a media service provider";
- (5)(a): "Automated distance teaching dependent on the Internet or similar electronic network to function and the supply of which requires limited or no human intervention, including virtual classrooms, except where the Internet or similar electronic network is used as a tool simply for communication between the teacher and student";
- (5)(b): "workbooks completed by pupils online and marked automatically, without human intervention".

**Art. 9a(1), first subparagraph:** "For the application of Article 28 of Directive 2006/112/EC, where electronically supplied services are supplied through a telecommunications network, an interface or a portal such as a marketplace for applications, a taxable person taking part in that supply shall be presumed to be acting in his own name but on behalf of the provider of those services unless that provider is explicitly indicated as the supplier by that taxable person and that is reflected in the contractual arrangements between the parties."

**Art. 9a(1), second subparagraph:** "(a) the invoice issued or made available by each taxable person taking part in the supply of the electronically supplied services must identify such services and the supplier thereof; (b) the bill or receipt issued or made available to the customer must identify the electronically supplied services and the supplier thereof."

**Art. 9a(1), third subparagraph:** "a taxable person who, with regard to a supply of electronically supplied services, authorises the charge to the customer or the delivery of the services, or sets the general terms and conditions of the supply, shall not be permitted to explicitly indicate another person as the supplier of those services."

**Art. 9a(2):** the rule also applies to "telephone services provided through the internet, including voice over internet Protocol (VoIP)".

**Art. 9a(3):** "This Article shall not apply to a taxable person who only provides for processing of payments in respect of electronically supplied services ... and who does not take part in the supply".

**Art. 18(1)(a):** the supplier may regard an EU customer as a taxable person "where the customer has communicated his individual VAT identification number to him, and the supplier obtains confirmation of the validity of that identification number and of the associated name and address in accordance with Article 31 of Council Regulation (EC) No 904/2010". Art. 31 of Regulation 904/2010 is the VIES confirmation.

**Art. 18(2), second subparagraph:** "irrespective of information to the contrary, the supplier of ... electronically supplied services ... may regard a customer established within the Community as a non-taxable person as long as that customer has not communicated their individual VAT identification number".

**Art. 24a(1)** presumes the customer's location at a hot spot, kiosk, internet café, restaurant or hotel lobby. It is not relevant here.

**Art. 24b**, first paragraph, covers services under art. 54(1) second subparagraph or art. 58 supplied to a non-taxable person:

- (a) fixed land line;
- (b) "the country identified by the mobile country code of the SIM card";
- (c) decoder or viewing card;
- (d) "under circumstances other than those referred to in Article 24a and in points (a), (b) and (c) of this Article, it shall be presumed that the customer is established, has his permanent address or usually resides at the place identified as such by the supplier on the basis of two items of non-contradictory evidence as listed in Article 24f".

The second paragraph allows a one-item simplification only for supplies "provided by a taxable person from his business establishment or a fixed establishment located in a Member State" up to EUR 100,000. It is **not available to the LLC**, which has no EU establishment.

**Art. 24d(1):** the supplier "may rebut a presumption referred to in Article 24a or Article 24b, first subparagraph, point (a), (b) or (c) ... on the basis of three items of non-contradictory evidence". **Art. 24d(2):** "A tax authority may rebut presumptions ... where there are indications of misuse or abuse by the supplier."

**Art. 24f** lists the evidence for art. 24b(d) and 24d(1):

- "(a) the billing address of the customer;
- (b) the internet Protocol (IP) address of the device used by the customer or any method of geolocation;
- (c) bank details such as the location of the bank account used for payment or the billing address of the customer held by that bank;
- (d) the Mobile Country Code (MCC) ... stored on the ... SIM card ...;
- (e) the location of the customer's fixed land line ...;
- (f) other commercially relevant information."

**Art. 25:** "only the circumstances existing at the time of the chargeable event shall be taken into account."

**Art. 63c(1):** records "sufficiently detailed within the meaning of Articles 369 and 369k of Directive 2006/112/EC" shall contain:

- "(a) the Member State of consumption ...;
- (b) the type of services ...;
- (c) the date of the supply ...;
- (d) the taxable amount indicating the currency used;
- (e) any subsequent increase or reduction of the taxable amount;
- (f) the VAT rate applied;
- (g) the amount of VAT payable indicating the currency used;
- (h) the date and amount of payments received;
- (i) any payments on account received before the supply ...;
- (j) where an invoice is issued, the information contained on the invoice;
- (k) in respect of services, the information used to determine the place where the customer is established or has his permanent address or usually resides ...;
- (l) any proof of possible returns of goods ...".

### 1.3 Directive 2006/112/EC (S2, S2b)

- **Art. 14a(2) (goods):** "Where a taxable person facilitates, through the use of an electronic interface such as a marketplace, platform, portal or similar means, the supply of goods within the Community by a taxable person not established within the Community to a non-taxable person, the taxable person who facilitates the supply shall be deemed to have received and supplied those goods himself." Art. 14a(1) covers the same for imported consignments up to EUR 150.
- **Art. 28:** "Where a taxable person acting in his own name but on behalf of another person takes part in a supply of services, he shall be deemed to have received and supplied those services himself."
- **Art. 44 (B2B):** "The place of supply of services to a taxable person acting as such shall be the place where that person has established his business."
- **Art. 45 (B2C general rule):** the place where the supplier has established his business.
- **Art. 54(1), second subparagraph:** "Where the services and ancillary services relate to activities which are streamed or otherwise made virtually available, the place of supply shall, however, be the place where the non-taxable person is established, has his permanent address or usually resides."
- **Art. 58(1):** "The place of supply of the following services to a non-taxable person shall be the place where that person is established, has his permanent address or usually resides: ... (c) electronically supplied services, in particular those referred to in Annex II. Where the supplier of a service and the customer communicate via electronic mail, that shall not of itself mean that the service supplied is an electronically supplied service."
- **Art. 59c(1):** the EUR 10,000 threshold applies only where "the supplier is established ... only in one Member State". The LLC has no EU establishment, so **no threshold applies: VAT is due from the first B2C sale** whose place of supply is in the EU.
- **Art. 73:** "the taxable amount shall include everything which constitutes consideration obtained or to be obtained by the supplier, in return for the supply, from the customer or a third party".
- **Art. 196:** "VAT shall be payable by any taxable person, or non-taxable legal person identified for VAT purposes, to whom the services referred to in Article 44 are supplied, if the services are supplied by a taxable person not established within the territory of the Member State."
- **Art. 219a(2)(b):** invoicing follows "the rules applying in the Member State where the supplier making use of one of the special schemes ... is identified."
- **Art. 242a(1)–(2):** a taxable person who "facilitates, through the use of an electronic interface such as a market place, platform, portal or similar means, the supply of goods or services to a non-taxable person within the Community ... shall be obliged to keep records of those supplies", "made available electronically on request", "kept for a period of 10 years from the end of the year during which the transaction was carried out."
- **Non-Union scheme:**
  - **Art. 358a(1):** "'Taxable person not established within the Community' means a taxable person who has not established his business in the territory of the Community and who has no fixed establishment there".
  - **Art. 358a(2):** the Member State of identification is the one "which the taxable person ... chooses".
  - **Art. 359:** "Member States shall permit any taxable person not established within the Community supplying services to a non-taxable person who is established in a Member State ... to use this special scheme. This scheme applies to all those services supplied within the Community."
  - **Art. 360:** state the start "electronically".
  - **Art. 361:** name, postal address, electronic addresses, "national tax number, if any", statement of no EU establishment.
  - **Art. 362:** individual VAT identification number.
  - **Art. 364:** "a VAT return for each calendar quarter, whether or not services covered by this special scheme have been supplied ... by the end of the month following the end of the tax period".
  - **Art. 365:** per Member State of consumption, total value exclusive of VAT and VAT per rate. Corrections go "in a subsequent return within three years".
  - **Art. 366:** "The VAT return shall be made out in euro." Other currencies use "the exchange rate applying on the last day of the tax period", at "the exchange rates published by the European Central Bank for that day, or, if there is no publication on that day, on the next day of publication".
  - **Art. 367:** pay "at the latest ... at the expiry of the deadline", "to a bank account denominated in euro".
  - **Art. 368:** no deduction in the scheme; refunds go under Directive 86/560/EEC.
  - **Art. 369(1)–(2):** records "sufficiently detailed to enable the tax authorities of the Member State of consumption to verify that the VAT return is correct", "made available electronically on request", "kept for a period of ten years from the end of the year during which the transaction was carried out."

Not read today:

- the deferred-application provisions of Directive (EU) 2025/516 ("VAT in the digital age"), which is in the 14 Apr 2025 consolidation's amendment list. None of the article texts cited above changed between the two consolidations, but amendments that apply from 2027 to 2030 were not traced. **Gap G10.**
- each Member State's national transposition and invoicing rules for B2C e-services under art. 219a(2)(b). **Gap G9.**

### 1.4 Fenix, C-695/20, 28 Feb 2023 (S4)

- **Operative part:** "The examination of the question referred has disclosed no factor of such a kind as to affect the validity of Article 9a(1) of Council Implementing Regulation (EU) No 282/2011 ... as amended by Council Implementing Regulation (EU) No 1042/2013 ..., in the light of Articles 28 and 397 of Council Directive 2006/112/EC ... and of Article 291(2) TFEU."
- **Para. 22** (the facts): Fenix "is responsible for collecting and distributing the payments made by fans, using a third-party entity which supplies payment services. Fenix also sets the general terms and conditions for use of the Only Fans platform."
- **Para. 25:** HMRC "took the view that Fenix had to pay VAT on all of the sum received from a fan and not only on the 20% of that sum which it levied by way of remuneration."
- **Para. 54:** art. 28 is "worded in general terms, without containing restrictions as to its application or scope and which thus covers all categories of services".
- **Para. 81:** "where the taxable person is in one of the three situations covered by that subparagraph, the presumption ... cannot be rebutted and therefore becomes irrebuttable".
- **Para. 83:** a taxable person with "the power to authorise the supply of that service, or to charge for it, or to lay down the general terms and conditions ... may unilaterally define essential elements relating to the supply ... the taxable person must be regarded as being the supplier of services, pursuant to Article 28 of the VAT Directive."

Fenix collected the money itself. Marktmorgen does not: the charge is a Stripe direct charge on the creator's account. Para. 81 turns on *authorising* the charge, not on collecting it. eu-vat-article-9a.md cites the Commission's notes §3.4.6 for "is not the same as taking payment" (S3, not re-read today). Marktmorgen's server creates every Checkout Session with the platform key (`onAccount(...)` in `lib/store-checkout.ts` and `lib/cart-checkout.ts`), decides whether the session may open (`canSell`) and sets the terms. On the text, that is "authorises the charge" and "sets the general terms and conditions". **Reading: Marktmorgen is the deemed supplier of ESS sold through stores to EU consumers.** This confirms eu-vat-article-9a.md on the primary text. It is not a most-tax choice.

### 1.5 United Kingdom (S5): not read today

No UK source could be opened today (proxy refusal). What was established earlier, and is not re-verified today:

- **27 Oct 2026:** Notice 741A s. 2.6. A non-established supplier making UK-taxable supplies not reverse-charged must register with no threshold.
- **4 Nov 2026:** returns, records and Making Tax Digital (tx4-uk-vat-evidence.md).

Not established at any date:

- that a UK equivalent of art. 9a binds a platform like Marktmorgen after 31 Dec 2020 (assimilated law status, any UK amendment);
- HMRC's current page on digital services to UK consumers;
- the online marketplace rules for goods.

### 1.6 Verdict on TX points 12, 13 and 14

| TX point | Verdict | Reason | Source rows |
| --- | --- | --- | --- |
| **12** — EU VAT on Marktmorgen's own plans: B2B reverse charge with a valid VAT number (art. 196); otherwise the consumer's VAT through non-Union OSS from the first sale | **Confirmed on the law; implementation gap** | Each part of point 12 is confirmed by the text: art. 44 + art. 196 (B2B place and reverse charge); Reg. art. 18(1)(a) (VAT number validity confirmed through VIES) and 18(2) (no number communicated → consumer); art. 58(1)(c) (B2C place = consumer); art. 59c (no threshold for a non-EU supplier); arts. 358a–369 (non-Union scheme, quarterly, euro, ECB rate on the last day, 10-year records). Not confirmed: that the LLC is "not established" on its real facts, and the registration itself (none exists). Neither plan billing (`lib/billing.ts`) nor the Store assistant (`lib/assistant-billing.ts`) has VIES checking, location evidence or OSS records. | S1 arts. 18, 24b, 24f, 63c; S2/S2b arts. 44, 58, 59c, 196, 358a–369 |
| **13** — EU VAT on store sales: Marktmorgen is the deemed supplier of ESS only; not live mentoring/calls, not physical goods; VAT on top or from the payout, never from Marktmorgen's revenue | **Partly confirmed, partly divergent** | Confirmed: art. 9a text, its irrebuttability when the platform authorises charge or delivery or sets the terms (Fenix para. 81), its validity (Fenix ruling), its limitation to ESS and VoIP, art. 7 + Annex I for what an ESS is. **Divergent 1:** "not calls" is right for *art. 9a*, but art. 28 still applies on the facts (Fenix para. 54, 83). A live *streamed* educational or entertainment activity to a consumer is taxed where the consumer is (art. 54(1) second subpara.). A one-to-one live call falls under art. 45 (supplier's place) only once the supplier under art. 28 is determined. **Divergent 2:** "not physical goods" is right for art. 9a, but art. 14a(2) deems a facilitating platform to be the supplier of goods sold inside the EU by a non-EU seller to a consumer. **Divergent 3:** "never from Marktmorgen's revenue" is a design goal, not law. The VAT is owed by the deemed supplier on the whole consideration (art. 73; Fenix para. 25). Under direct charges the money lands with the creator, and no funding mechanism exists today (Part 2, §2.4). | S1 arts. 7, 9a, Annex I; S2 arts. 14a, 28, 45, 54, 73; S4 ruling, paras. 22, 25, 54, 81, 83 |
| **14** — UK: same logic, registration from the first consumer sale, no threshold for a non-established supplier | **Gap (not read today); partially confirmed earlier** | No-threshold registration was confirmed on 27 Oct 2026 (Notice 741A s. 2.6). The UK deemed-supplier rule for e-services, the current HMRC digital-services guidance and the marketplace rules for goods have not been read at any date. The proxy blocked gov.uk and legislation.gov.uk today. | S5 (not read) |

## Part 2 — Build spec per checkout path

This part is written for the engineer who will build it. Every rule below assumes **art. 9a is built only for EU consumers** (`jurisdiction: "EU"`). The UK follows the same shape once S5 is read and confirmed, and is otherwise refused. US states and "other" are out of scope here and stay unrecorded.

### 2.1 Classification per product kind and path

"ESS" means art. 7(1) + Annex I: delivered over the internet, essentially automated, minimal human intervention. "EU consumer" means a buyer located in an EU Member State (§2.3) who has not given a VIES-valid VAT number (§2.2).

| Path / kind | Where in code | ESS? | Rule for an EU consumer | Note |
| --- | --- | --- | --- | --- |
| Single product checkout: download/file, link, licence key | `lib/store-checkout.ts` (`product.file`, `product.link`, `lib/licence-keys.ts`) | Yes: art. 7(2)(a), Annex I (2)(a), (3)(b)–(c), (4)(a)–(c) | **Art. 9a: Marktmorgen is the supplier.** VAT at the consumer's Member State rate (art. 58). | A "link" product is ESS only if what the link opens is itself automated digital content. If the link leads to a live service, classify it as that service. **Gap G6** until the creator declares it. |
| Recorded course | `lib/learn.ts`, `lib/course.ts` | Yes: Annex I (5)(a), automated distance teaching | **Art. 9a.** | Art. 7(3)(j) excludes only content "delivered by a teacher over the Internet ... via a remote link", meaning live teaching. A course with live sessions in the same price is mixed (see the bundle row). |
| Private podcast | podcast products | Yes: Annex I (4)(a)/(h) | **Art. 9a.** | |
| Membership / content subscription (recurring) | `lib/membership-access.ts`, `lib/community-access.ts`, `mode: "subscription"` | Yes for access to the content: Annex I (3)(d), (4)(f)/(h) | **Art. 9a on each renewal.** Location evidence is taken at each chargeable event (Reg. art. 25), so it is re-checked on every renewal invoice. | Live member events in the same price make it mixed. **Gap G7:** single or multiple supply (whether a principal ESS absorbs an ancillary live element) is case law not read today. Until it is read, a membership with live events is refused to EU consumers, or its live part is sold separately. |
| Cart (several products, one session) | `lib/cart-checkout.ts` | Per line | **Per-line treatment.** Each ESS line carries VAT under art. 9a. Each physical line follows the physical row. Each live line follows the call row. | The cart already refuses mixed shipping (`CartShippingRefused`). Add: if any line's rule is "refuse for an EU consumer", refuse the whole cart before the session is created, naming the line. |
| Bundle | `lib/bundles.ts`, `lib/cart-bundle.ts`, `lib/funnel-bundle*.ts` | Per component | **All-ESS bundle: art. 9a on the whole price.** Mixed bundle (ESS + physical or live): split the price across components by the creator's own stand-alone prices, pro rata, recorded in the art. 63c record. If no stand-alone price exists for a component, refuse sale to EU consumers. | Splitting on stand-alone prices is a build choice, not a text read today. **Gap G7.** |
| Payment plan (instalments) | `metadata[plan_payments]` in `lib/store-checkout.ts` | Same as the product | Same as the product. **Each instalment is a payment received** (art. 63c(1)(h)/(i)). | **Gap G8:** the chargeable event for an ESS paid in instalments (whether VAT is due at each instalment or at delivery) is a rule of the Member State not read today. Until it is read, refuse instalment plans to EU consumers. |
| Gift | `lib/gifts.ts`, `lib/gift-rules.ts` | Same as the product | **Art. 9a.** The customer is the payer (consideration from the customer, art. 73), so location evidence is the payer's. | The recipient's location is not the place of supply evidence. Record the payer's evidence only. Physical goods cannot be gifts today (`store-checkout.ts` line ~296). |
| Pre-order | `lib/preorders.ts` | Same as the product | **Art. 9a.** The payment before delivery is a "payment on account" (art. 63c(1)(i)). | **Gap G8** applies to the chargeable event of payments on account. Until it is read, refuse pre-orders to EU consumers, or charge VAT at payment and keep the rate fixed. |
| Pay what you want | `lib/pay-what-you-want.ts` (`activePwyw`) | Same as the product | **Art. 9a.** The VAT base is what the buyer actually pays (art. 73). | The buyer names a VAT-exclusive amount, and VAT is added on top before paying. A minimum price is VAT-exclusive. |
| Offer after paying (upsell), checkout box, next offer, yearly offer | `lib/upsell.ts`, `lib/next-offer.ts`, `lib/yearly-offer.ts` | Same as the product sold | Same as the product sold. **A separate supply with its own record.** | The upsell charges again on the same payment method. Re-use the first session's location evidence only if the chargeable event is the same day and the evidence is unchanged. Otherwise refuse. |
| Call / call package (live video with the creator) | `lib/calls.ts`, `lib/call-packages.ts` | **No** (art. 7(1) "minimal human intervention" fails; compare art. 7(3)(i), (j), (n)) | **Not art. 9a.** Supplier question under art. 28 on the facts (Fenix paras. 54, 83). Place: art. 45 (supplier's establishment) for a one-to-one consultation; art. 54(1) second subpara. (consumer's place) if it is a streamed educational or entertainment *activity*. | **Gap G5.** Until classified, refuse calls to EU consumers. The 27 Oct 2026 TX1 matrix records Irish Revenue's admission-to-events guidance: coaching series are not automatically events. |
| Tip ("Support my work") | `lib/store-tip-checkout.ts` | Nothing is supplied in return on its face | **Gap G6.** A payment with no supply is outside VAT, but a tip that unlocks or is tied to content is consideration. Until the link to content is excluded in code, refuse tips from EU consumers. | |
| Payment request | `lib/payment-requests.ts` | Depends on what is billed | **Classify by what the creator says it is for.** If it is unknown, refuse for EU consumers. | |
| Physical product with shipping | `lib/shipping.ts`, `shipping_address_collection` in `store-checkout.ts` | Not a service (art. 7(3)(c)) | **Not art. 9a.** Art. 14a(2) applies when the seller is not established in the EU and the goods are supplied inside the EU. Art. 14a(1) applies to imports up to EUR 150. | **Out of scope for this build.** Remove EU (and UK) countries from `shipping_address_collection[allowed_countries]` when the creator's Stripe account country is not in the EU (or UK). For an EU-established creator shipping inside the EU, art. 14a(2) does not deem Marktmorgen. The creator's own VAT applies, outside this registry. |
| PayPal one-off sales | `lib/paypal-sales.ts` | Same as the product | Same treatment, or refuse EU consumers on PayPal until the same evidence and records are built. | PayPal gives no card BIN country. The second piece of evidence must be the billing address PayPal returns, compared with IP. |
| **Store assistant add-on** and **Marktmorgen plans** | `lib/assistant-billing.ts`, `lib/billing.ts` | Yes, but Marktmorgen's own service | **Not art. 9a and not a store sale.** TX point 12: B2B reverse charge (art. 44 + 196) with a VIES-valid number; otherwise art. 58 consumer VAT through the same non-Union OSS registration. | The same location, VIES and record modules serve both. Build them once. |

### 2.2 B2C or B2B

- Add an optional "EU VAT number" field to the checkout, before the session is created. Do not rely on Stripe's `tax_id_collection` on the creator's account (`lib/tax.ts`). That collects for the creator's own Stripe Tax, not for Marktmorgen.
- **Check the number in VIES on the server** (Reg. art. 18(1)(a); Regulation 904/2010 art. 31) and keep the consultation reference returned, the date and the name and address returned. Port Hazelsong's `lib/vies.ts`, reading it first. Cost per check: unknown, and it fails until measured (G11).
- **Valid** → B2B. The place of supply is the buyer's (art. 44). For store sales, the deemed chain makes Marktmorgen the supplier to the buyer, and the buyer self-accounts (art. 196). Charge no VAT, and print "Reverse charge" with both VAT identifiers (invoice rules of the Member State of identification, art. 219a(2)(b), not read today: G9).
- **Invalid, unavailable or absent** → consumer (art. 18(2) second subparagraph). Never treat a failed VIES call as valid.

### 2.3 Location evidence (arts. 24b(d), 24f)

The code can collect, before the session is created:

1. **IP geolocation:** `x-vercel-ip-country` (art. 24f(b)), already read in `lib/visitor.ts` and `lib/visit.ts`.
2. **Billing country typed by the buyer** (art. 24f(a)), asked on Marktmorgen's page before redirecting to Stripe.

After payment, from the creator's connected account through the platform key:

3. **Card issuing country** (`payment_method_details.card.country`, art. 24f(c) "bank details") and the **billing address Stripe collected** (art. 24f(a)).

Rules:

- **Before the price is shown:** (1) and (2) must name the same country. If they contradict, refuse the checkout with a plain message ("We could not confirm which country you are buying from"). Do not choose a default. If either is missing, refuse. Two non-contradictory items are required, and one is not enough for a non-EU-established supplier (art. 24b second paragraph is unavailable).
- **After payment:** if (3) contradicts the pair, keep all three in the record and flag the sale for the return. The presumption of art. 24b(d) rests on two non-contradictory items, and the third is supporting evidence. Do not auto-refund. **Gap G4:** whether a post-payment contradiction defeats the presumption is not settled by any text read today.
- VPN users get the refusal. This is a deliberate trade-off and is already disclosed for fair prices (`lib/help-content.ts`).
- Non-EU country with both items agreeing → no EU VAT. Record nothing in the EU ledger, but keep the evidence with the order for the same 10 years, because it is the proof that the sale was not an EU supply. **Gap G12** (storage bound).

### 2.4 Who collects, who remits, and the money gap

- **Who owes the VAT:** under art. 9a + art. 28, Marktmorgen (the LLC) is the supplier to the consumer and owes the VAT on the whole consideration (art. 73), through the non-Union OSS (art. 359), quarterly, in euro (arts. 364–367).
- **Where the money lands:** every store sale is a Stripe direct charge on the **creator's** connected account. Marktmorgen receives nothing from the charge.
- **How Marktmorgen could take the VAT:**
  - An `application_fee_amount` on the direct charge would have been the mechanism. **Per SR5 (AGENTS.md, 28 Oct 2026), a Brazilian platform account connecting creators outside Brazil gets direct charges without an application fee: there are no application fees, destination charges or separate charges and transfers.** Today `COMMISSION_LIVE` is false and no checkout sets an application fee.
  - Under the US LLC route (SR6 study, undecided), application-fee availability is not established either.
- **Therefore there is no mechanism today to move the VAT from the creator's account to the LLC.** The options are listed for the owner, none chosen:
  - (a) An application fee, only if the platform account eventually allows it. That is not true for the BR platform per SR5.
  - (b) Invoicing the creator after each quarter for the VAT Marktmorgen owes on the creator's sales, with a pre-funded deposit or a card on file. This has credit risk, and an unpaid creator invoice would leave Marktmorgen paying the VAT itself.
  - (c) Refusing EU consumers on every store path (`treatment: "refuse-consumers"`), which needs no funding mechanism.
  - (d) Restructuring the checkout so the platform is merchant of record. That is not available per SR5 and is a terms change.
  - **Until one of these is chosen and built, the only implementable EU record is "refuse-consumers".**
- **"Never from Marktmorgen's commission":** the commission is 0% today (`COMMISSION_PLANS_PUBLISHED` false), so the commission cannot fund it anyway. The VAT is added on top of the buyer's price, so the buyer pays it, but it still lands with the creator.
- **Currency cost:** the creator's charge may be in USD. The OSS return and payment are in euro (art. 366–367). FX and transfer costs are unknown (G11) and fail.
- **Refunds:** a refund reduces the taxable amount (art. 63c(1)(e)). The correction goes in a later return within three years (art. 365). If option (b) is used, the creator credit must follow.
- **Disputes:** whether a lost chargeback reduces the taxable amount is a rule of each Member State, not read today. **Gap G8.**
- **Creator's own Stripe Tax:** for an EU consumer on an ESS path, the creator's `automatic_tax` (`lib/tax.ts` `applyTax`) must be off for that session. Otherwise VAT is charged twice, once by the creator as if the creator were the supplier.

### 2.5 Art. 63c records

One immutable record per supply, per correction and per payment. The fields map one-to-one to art. 63c(1)(a)–(k):

| Field | Art. 63c(1) | Source in code |
| --- | --- | --- |
| `memberStateOfConsumption` (ISO 3166-1 alpha-2) | (a) | §2.3 evidence pair |
| `serviceType` (Annex I point, for example `"Annex I (3)(c) e-book"`) | (b) | product kind |
| `supplyDate` (UTC date of the chargeable event, plus the Member State's local date) | (c) | Stripe `created`. **Gap G8** for the chargeable-event rule |
| `taxableAmountMinor`, `currency` | (d) | session amounts, VAT-exclusive |
| `adjustments[]` (date, delta, reason: refund, partial refund, dispute) | (e) | refund webhook |
| `vatRateBps` | (f) | rate table with source and date (G3) |
| `vatAmountMinor`, `currency` | (g) | computed |
| `payments[]` (date, amount) | (h) | PaymentIntent and invoice payments |
| `paymentsOnAccount[]` | (i) | pre-orders, instalments |
| `invoice` (content, if issued) | (j) | §2.6 |
| `locationEvidence` ({ipCountry, billingCountry, cardCountry, stripeBillingCountry, contradiction: boolean}) | (k) | §2.3 |
| `vatNumberCheck` (number, VIES result, reference, date) | Reg. art. 18 | §2.2 |
| `storeId`, `creatorAccountId`, `sessionId`, `productId` | (needed to reconcile) | |

The buyer's name is not listed in art. 63c(1) and is not stored. The buyer's email is not stored in the ledger.

Retention and storage:

- **Retention:** 10 years from the end of the year of the transaction (Directive arts. 369(2) and 242a(2)). Storage follows the 132-month cohort ceiling and formula in eu-vat-retention-funding.md, with B, R, N, W, Q and T still unknown. **Unknown cost fails, never zero (G12).**
- **Where:** a company-owned storage family that does not depend on the store. It must not be deleted by `lib/closed-store-data.ts` and must be declared in `lib/data-families.ts`.
- **Erasure requests:** GDPR art. 17(3)(b) excepts processing needed for compliance with a legal obligation (not re-read today). The record keeps only the minimum above, with no name, no email and no IP address itself (the derived country only). `lib/person-data.ts` must list it as "kept for the legal period", and the privacy policy must say so in the same change.

### 2.6 What the buyer sees: receipt / invoice wording

- **Before paying,** for an EU consumer: the price with "includes VAT of €X (Y%) for [Member State]". If VAT is added on top, show the VAT-inclusive total before the buyer commits.
- **Receipt**, for an ESS path to an EU consumer. Art. 9a(1)(b) is the rule Marktmorgen cannot use to shift supplier status, so the receipt names Marktmorgen:

  > "Supplier for EU VAT purposes: Solrenning LLC (Marktmorgen), [non-Union OSS VAT number]. Sold on behalf of [creator name]. VAT [rate]% for [Member State]: [amount]. Total paid: [amount]."

- The `whoAnswers` sentence in `lib/buyer-words/*.ts` ("Marktmorgen is not a party to the sale") must be reviewed in all seven buyer languages in the same change, so the checkout never contradicts the receipt.
- The Terms ("You are the seller") need an EU VAT carve-out. That is the owner's decision.
- Exact invoice obligations follow the Member State of identification (art. 219a(2)(b)) and are not read today (G9).

### 2.7 OSS return data

- **Quarterly, per Member State of consumption, per rate:** total value excluding VAT and VAT (art. 365). Include zero returns (art. 364).
- **Due** by the end of the month after the quarter (art. 364). Payment in euro by the same date, to the Member State of identification's euro account, quoting the return (art. 367).
- **Currency:** convert each non-euro amount at the ECB rate for the **last day of the quarter**, or the next publication day (art. 366). Do not use the rate on the sale date.
- **Corrections:** in a later return within three years of the original due date, naming the Member State, period and amount (art. 365).
- The code produces the data. **Filing and paying are the owner's acts and are not automated.**

### 2.8 One `DEEMED_SUPPLIER_RECORDS` entry

Shape (`lib/deemed-supplier.ts`): `{ jurisdiction, treatment, implementedIn, recordedOn, registration, evidence }`. For `EU`:

- `treatment`:
  - `"collect"` only when **all** of §2.1–§2.7 are built for every path not refused, and a funding mechanism from §2.4 exists;
  - otherwise `"refuse-consumers"`, which must refuse **every** store path to an EU-located buyer (by the §2.3 evidence) and Marktmorgen's own plans to EU consumers if point 12 is not built.
- `implementedIn`: the exact files (checkout guards, evidence, VIES, ledger, return export).
- `recordedOn`: a real calendar day (already validated).
- `registration`:
  - for `"collect"`: "non-Union OSS, Member State of identification [XX], identification number [EU…], effective [YYYY-MM-DD]", as verified from the authority's notice (art. 362);
  - for the UK: "UK VAT registration number [GB…], effective [date]".
- `evidence`: the test files and the CI run (`All checks` green on a stated head) that exercise the real code paths with synthetic buyers in each Member State, contradiction cases, VIES valid, invalid and unavailable, refunds, a year boundary and store closure.

**The list must stay empty** until:

1. the LLC exists;
2. the owner has actually registered in the non-Union OSS (and UK VAT for "collect" in the UK), with the number and date verified;
3. the code path is merged, deployed and tested end to end;
4. the margin review counts every new cost.

A `"refuse-consumers"` record is possible earlier, without registration, but only once the refusal is built and tested on every path. **Nothing in this document adds a record, opens sales, or changes `PLANS_ON_SALE`, `OPENING_REQUESTED`, the tax gate, the commercial review or any price, limit or commission.**

## Gaps that fail today

1. **G1** — No non-Union OSS registration and no UK VAT registration exist. The LLC is not yet formed. Owner's act; nothing prepared here.
2. **G2** — No mechanism moves VAT from the creator's direct charge to the LLC. Application fees are unavailable for the BR platform per SR5. EU "collect" cannot be built. Owner's design decision (§2.4 options).
3. **G3** — No dated, sourced table of Member State VAT rates is in the repository.
4. **G4** — The effect of a post-payment contradiction in location evidence is not settled by any text read today.
5. **G5** — Classification of calls and call packages: art. 28 supplier on the facts; art. 45 or art. 54(1) second subparagraph place. Refused for EU consumers until settled.
6. **G6** — Tips, payment requests and "link" products have no supply classification in code.
7. **G7** — Mixed bundles and memberships with live elements: single versus multiple supply and price split. Case law not read.
8. **G8** — Chargeable event for instalments, pre-orders and payments on account, and the VAT effect of lost disputes: Member State rules not read.
9. **G9** — Invoice requirements of the Member State of identification (art. 219a(2)(b)) are not read. GDPR art. 17(3)(b) was not re-read today.
10. **G10** — Deferred-application amendments of Directive (EU) 2025/516 (2027–2030) are not traced.
11. **G11** — Costs of VIES checks, FX on euro remittance, bank transfers and return preparation are unknown. They stay "unknown" in `vat-oss-and-local-compliance` (`lib/llc-fixed-costs.ts`) and are never zero.
12. **G12** — The 10-year ledger's byte, replica, cardinality and operation bounds (B, R, N, W, Q, T in eu-vat-retention-funding.md) are not established. Storage is not funded.
13. **G13** — Commission Explanatory Notes (2014, and the 2021 TBE notes) were not read today because the host is blocked. The meaning of "authorises the charge" when no payment is taken rests on the art. 9a text and Fenix para. 81 alone.
14. **G14** — UK: no source read today. The UK deemed-supplier rule for e-services and the goods marketplace rules have never been read (TX point 14 is a gap).
15. **G15** — Whether the LLC has no EU establishment (art. 358a(1)) on its real facts is not verified. Art. 10 of the Regulation (central administration) was not applied to facts.

## What the builder (nuvem L) needs from this spec

1. **Start with "refuse-consumers" for the EU and the UK.** It is the only treatment buildable today: a server-side guard before every `onAccount(... "/checkout/sessions" ...)` call. That covers `lib/store-checkout.ts`, `lib/cart-checkout.ts`, calls, call packages, payment requests, tips, upsells, PayPal and the plan and assistant billing. The guard refuses a buyer whose §2.3 evidence pair names an EU or UK country, or whose pair contradicts or is missing.
2. **Build the shared modules once:** location evidence (§2.3), VIES (§2.2), the rate table with its source (G3), and the art. 63c ledger (§2.5) behind a storage reservation (G12). Point 12 (Marktmorgen's own plans) and point 13 (store sales) both use them.
3. **Use the path table (§2.1) as the test matrix.** One synthetic test per row, per outcome (consumer, valid B2B, contradiction, missing evidence, non-EU), plus year-boundary, refund, closure and concurrency cases.
4. **Do not touch** prices, limits, commission, `PLANS_ON_SALE`, `OPENING_REQUESTED`, the tax gate, the commercial review or the registry contents. Adding a record is a separate change, after §2.8's conditions.
5. **Wording changes** (`whoAnswers`, Terms, privacy policy, receipts) go in the same PR as the behaviour they describe, in all buyer languages. The Terms change is the owner's decision.
6. **Every new per-sale cost** (VIES, evidence, ledger write, storage) enters `lib/receiving-costs.ts` and the margin tests at its worst case before anything opens. Unknown fails.

## Accessibility

This is a text-only document, with no interface change: 0 → 0 steps and decisions for any user. Headings are in order. Links have descriptive text or are named sources. Tables have header rows. No colour, image or time-based content. Future interface work from §2.2, §2.3 and §2.6 (VAT number field, refusal message, VAT lines before paying, receipts) must meet AX274: errors identified in text, prevention before submitting data (3.3.6), no re-typing of data already given (3.3.7) and plain US English. That work is not done here and nothing is certified.
