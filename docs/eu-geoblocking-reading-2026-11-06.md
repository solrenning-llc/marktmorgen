# EU geo-blocking reading: Regulation (EU) 2018/302 per product kind (6 November 2026)

**Status: a reading for the owner's decision ("Depende do dono").** It is not
legal advice, not a verified status and not a conformity statement. It changes
no price, limit, commission, flag, gate or term, and no code. Every line is
marked **CONFIRMED-TEXT** (the quoted text answers it), **NEEDS-FACT** (the text
answers it only once a fact about the creator, the product or the buyer is
known) or **OPEN** (the text does not settle it; the owner or a lawyer must).

This is unit 6 (row 10) of `docs/eu-consumer-audit-2026-11-06.md` (branch
`claude2/eu-consumer-audit`). Code was read on `origin/main` at `5c0731550`.

## How it was read

- Official source only: the Publications Office's Cellar, fetched on **6
  November 2026**. EUR-Lex was not used and no challenge page was met.
- The `resource/celex/32018R0302` address did not resolve from this machine on
  the first try (DNS error), so the **resolved Cellar file recorded by the
  audit** was fetched directly. Its hash equals the audit's, so it is the same
  file.
- Text read: the original act as published (OJ L 60 I, 2.3.2018). Later
  amendments to the Regulation, if any, were **not checked**.

| Key | Act | URL read (6 Nov 2026) | SHA-256 of the file read |
| --- | --- | --- | --- |
| S7 | Regulation (EU) 2018/302 (geo-blocking), original | https://publications.europa.eu/resource/cellar/058372dc-1def-11e8-ac73-01aa75ed71a1.0006.03/DOC_1 (CELEX 32018R0302) | `0ec80603166aa96260f28889ff115093e4da0f643fb948f7e871ca7cc6eae62b` |

## What the text says (short quotes, S7)

- **Art. 2(18) "trader"**: "any natural person or any legal person … acting …
  for purposes relating to the trade, business, craft or profession of the
  trader." **Art. 2(16) "online interface"**: software, "including a website …
  operated by or on behalf of a trader". **Recital 17**: the Regulation "should
  apply equally to all traders, including online marketplaces, operating within
  the Union", whether established in a Member State or a third country.
- **Art. 2(13) "customer"**: "a consumer who is a national of, or has his or her
  place of residence in, a Member State, or an undertaking which has its place of
  establishment in a Member State, and receives a service or purchases a good,
  or seeks to do so, within the Union, for the sole purpose of end use".
- **Art. 3(1)**: a trader shall not "block or limit a customer's access to the
  trader's online interface for reasons related to the customer's nationality,
  place of residence or place of establishment." **Art. 3(2)**: no redirection
  to another version without explicit consent. **Art. 3(3)**: exceptions where
  needed to comply with Union or Member State law, with a clear explanation.
- **Art. 4(1)**: no different "general conditions of access" for those reasons
  where the customer seeks to: **(a)** buy goods delivered to, or collected in,
  a Member State "to which the trader offers delivery in the general conditions
  of access"; **(b)** "receive electronically supplied services from the trader,
  other than services the main feature of which is the provision of access to
  and use of copyright protected works or other protected subject matter,
  including the selling of copyright protected works or protected subject matter
  in an intangible form"; **(c)** receive services "in a physical location within
  the territory of a Member State where the trader operates".
- **Art. 2(14) "general conditions of access"**: "all terms, conditions and other
  information, including net sale prices … which are set, applied and made
  available to the public at large by or on behalf of the trader".
- **Art. 4(2)**: the prohibition "shall not prevent traders from offering
  general conditions of access, including net sale prices, which differ between
  Member States or within a Member State and which are offered to customers on a
  specific territory or to specific groups of customers on a non-discriminatory
  basis." **Recital 27**: traders "should always treat their customers in a
  non-discriminatory manner … when a customer wishes to benefit from such offers
  and general conditions of access."
- **Art. 4(4)**: point (b) "shall not apply to traders that are exempted from
  VAT" under the small-business scheme (Chapter 1 of Title XII of Directive
  2006/112/EC). **Art. 4(5)**: no prohibition where Union or Member State law
  prevents the sale to certain customers or territories (book-price laws).
- **Art. 5(1)**: within the means of payment the trader accepts, no different
  conditions for a payment transaction for reasons of nationality, residence,
  location of the payment account, of the payment provider or of issue of the
  instrument, for credit transfer, direct debit or a card payment of the same
  brand and category, with authentication met and in a currency the trader
  accepts. **Art. 5(2)**: delivery may be withheld until payment is confirmed.
- **Art. 1(3)** excludes the activities in Art. 2(2) of Directive 2006/123/EC.
  **Recital 8**: "Audiovisual services, including services the principle
  purpose of which is the provision of access to broadcasts of sports events and
  which are provided on the basis of exclusive territorial licenses, are
  excluded from the scope of this Regulation." (The Directive itself was not
  read.) **Recital 8** also says the Regulation applies to "non-audiovisual
  electronically supplied services the main feature of which is the provision of
  access to and use of copyright protected works", subject to the Art. 4(1)(b)
  exclusion and its later evaluation (Art. 9(2)).
- **Recital 10 (bundles)**: a trader offering a bundle "should either comply
  with the prohibitions set in this Regulation as regards the whole bundle, or at
  least offer, on an individual basis, services that fall within the scope".
- **Recitals 24–25**: electronically supplied services are those where "no
  physical delivery is required" (examples given: cloud services, data
  warehousing, website hosting, firewalls, search engines, directories);
  services "received by the customer in a physical location" are the (c) case.

## Who is the "trader" for a store sale

- **Creator**: the Terms say "Each sale made through your store is a contract
  between you and your buyer. Marktmorgen is not a party to it"
  (`app/terms/page.tsx:139-144`, as quoted by the audit). The creator sets the
  product, the price and the countries. **NEEDS-FACT** whether a given creator
  is a "trader" (business purpose) or a private person; the Regulation applies
  only to traders (Art. 2(18)); the audit's unit 2 (trader declaration) is the
  mechanism that would record it.
- **Marktmorgen**: sells its own plans (a trader for those), and operates the
  store page and checkout "on behalf of" creators (Art. 2(16)); recital 17
  names "online marketplaces" as traders under the Regulation. Whether
  Marktmorgen is itself bound for the creators' store interfaces, or only the
  creator is, is **OPEN**. The conservative reading in this document: both
  could be asked why an interface or a checkout treats visitors differently by
  country.

## What the code does today that could matter

| Behavior | Where | Reading |
| --- | --- | --- |
| Price lowered by the visitor's **internet-connection country**, off by default, creator-controlled per country (5% to 90% off), covers only products "bought once, at one price" | `lib/fair-price.ts` (header; `storeCountryOff`, `countryOff`, `NEVER_LOWER`), `lib/store-sale.ts:86-88` (`saleable`), `lib/store-checkout.ts:482-509` (coupon `fairCoupon`, `metadata[fair]`), country read from `x-vercel-ip-country` (`lib/visitor.ts:11`, `app/api/store/checkout/route.ts:299`, `app/api/store/cart/route.ts:56`) | A price that differs by country. Art. 4(2) permits it "on a non-discriminatory basis"; recital 27 asks that a customer who "wishes to benefit" can. The buyer cannot choose another country's price (the doc comment says a VPN user can be shown another country's price; card country is not checked). **OPEN** |
| With the default `maxOff` of 50, the suggestion also lowers some **EU Member States** that are not in `NEVER_LOWER` | `lib/fair-price-data.ts` 2024 levels, e.g. BG 0.42, RO 0.41, HU 0.48, PL 0.49, HR 0.49, CZ 0.55, GR 0.56, LV 0.54, LT 0.53, EE 0.62, SI 0.60, CY 0.61, MT 0.63; formula `floor((1 − level) × 100 / 5) × 5` capped by `maxOff` (hand-computed here, not run): BG and RO 55 → capped 50, HU and PL 50 | Intra-EU price differences by country, from the creator's own switch. Same legal question as the row above, but inside the Union. **OPEN** |
| Physical product ships only to creator-chosen countries; Stripe asks for an address in those countries | `lib/shipping.ts` (`SHIP_REGIONS`, `SHIP_COUNTRIES`), `lib/store-checkout.ts:384-393`, `lib/cart-shipping.ts` | Art. 4(1)(a) refers to delivery "to a Member State to which the trader offers delivery in the general conditions of access"; recital 28 says no duty to deliver cross-border where the trader would not otherwise. The creator's list is the offer. **CONFIRMED-TEXT** for the list itself; **NEEDS-FACT** whether a given creator's list excludes Member States for a reason tied to the buyer's residence (it is the destination, not the buyer) |
| No blocking of store pages or checkout by country found | grep of `lib/`, `app/`, `proxy.ts` for country use: the country feeds the price discount (above), visit statistics (`lib/visit.ts:73`), and consent-banner choice (`proxy.ts:67,109,137`) | Art. 3(1) not engaged by anything found. **NEEDS-FACT** (Vercel or Stripe account-level restrictions were not inspected) |
| Marktmorgen's own plans: one price list, no country field | `lib/plan.ts` (no country logic found by grep) | Art. 4(1)(b) applies to Marktmorgen as the trader of a non-copyright electronically supplied service; nothing differs by country. **NEEDS-FACT** (checkout tax and Stripe payment methods differ by country; Art. 4(2) and Art. 1(4) leave tax outside) |
| Payment methods: Stripe Checkout on the creator's own account, PayPal for connected sellers | `lib/store-checkout.ts`, `lib/store.ts` (PayPal seller) | Art. 5 concerns discrimination within the means the trader accepts. Which methods Stripe shows by country is Stripe's. **NEEDS-FACT** (not tested; no payment method list was read) |

## Per product kind

Kinds were read from `lib/catalog.ts` (`Product` fields and `KIND` bits) and
`lib/product-extras.ts`, `lib/store-sale.ts`. "Fair price?" says whether the
visitor-country discount can touch it (`saleable` plus
`!plan && !membership` at `lib/store-checkout.ts:482`).

| Product kind (code) | Fair price? | Article that applies | Trader | Reading and status |
| --- | --- | --- | --- | --- |
| Downloadable file: e-book, PDF, template, audio or video file (`file`) | Yes, if one price and no options | **Art. 4(1)(b), copyright exclusion** | Creator | An e-book, music or video file is a copyright work sold "in an intangible form". The exclusion removes Art. 4(1)(b), so price by country is outside the prohibition. **NEEDS-FACT** that the item is a protected work and its "main feature" is access to and use of it (a template pack, preset or data file may be tools, not works). Art. 3 (access) and Art. 5 (payment) are **not** excluded: store pages must stay reachable and payment conditions equal. Recital 8's audiovisual exclusion may also apply to film-like files: **OPEN** |
| Link-delivered product (`link`, access held elsewhere) | Yes | Depends on what the link opens | Creator | Same as file if a work; a web tool or service reached by the link is an electronically supplied service outside the copyright exclusion: Art. 4(1)(b) applies. **NEEDS-FACT** |
| Course, recorded lessons (`course`) | Yes | Art. 4(1)(b) copyright exclusion if the main feature is access to lessons (works); recital 8 audiovisual exclusion for video lessons | Creator | Likely outside Art. 4(1)(b); whether lesson video is an "audiovisual service" under the Directive 2006/123/EC exclusion (Art. 1(3)) was not verified because that Directive was not read. **OPEN** |
| Private podcast (`podcast`) | Yes | Same as a course (access to audio works) | Creator | **NEEDS-FACT** / **OPEN**, same as above |
| Membership or subscription, content or community (`recurring`) | No (`!membership`) | **Art. 4(1)(b)** if the main feature is not access to copyright works (community, tools, live Q&A, software) ; copyright exclusion if mainly a content library | Creator | The code applies no country price to memberships (audit row 10 said memberships with live events or coaching may fall in Art. 4(1)(b)). Mixed memberships fall under "main feature" test. **NEEDS-FACT** |
| Call, coaching, consulting, live session, webinar, call package (`call`, weekly, `callPackage`; dated "live" sessions) | No (`!call`) | **Art. 4(1)(b)** if it is an electronically supplied service; **Art. 4(1)(c)** only if received in a physical place in the creator's territory; a human-delivered video call fits neither recital 24 ("no physical delivery", services such as cloud or hosting) nor recital 25 (physical location) cleanly | Creator | Not decided here. **OPEN** (VAT treats human-performed services as not "electronically supplied"; that is a different Directive and was not read in this unit; Art. 1(4) leaves taxation aside) |
| Physical goods with shipping (`shipping`) | Yes, if one price and no options | **Art. 4(1)(a)** | Creator | Applies only to Member States the creator ships to (their list is the offer, recital 28). Different **shipping price by destination** is territory-based (Art. 4(2)). **CONFIRMED-TEXT** on the scope; **NEEDS-FACT** on each creator's list |
| License keys (`keys`) | Yes | Software is protected subject matter: Art. 4(1)(b) copyright exclusion likely; a hosted SaaS licence is a service, not a work | Creator | **NEEDS-FACT** |
| Tips, pay-what-you-want (`pwyw`) | No (`!pwyw`) | None, if no good or service is supplied in return; otherwise follows the underlying product | Creator | **NEEDS-FACT** (is there a deliverable?) |
| Bundle (`bundle`, `pick`) | Yes | Follows its parts; recital 10: comply for the whole bundle or offer the in-scope part separately | Creator | **CONFIRMED-TEXT** (recital 10). A bundle mixing a work, a call and a physical item is covered by recital 10; **NEEDS-FACT** per bundle |
| Products with options (`options`), instalment plans (`plan`), gifts and groups | No for options (`saleable`); plans excluded at checkout | Follows the product | Creator | **NEEDS-FACT** |
| Marktmorgen's own plans: Store, Studio, Scale, assistant, AI captions | No country price | **Art. 4(1)(b)** (non-copyright service), Art. 3, Art. 5 | Marktmorgen | Applies directly to Marktmorgen. No country discrimination found in code. Sales are closed (`PLANS_ON_SALE` false). **NEEDS-FACT** (no VAT-exemption under Art. 4(4) is claimed) |

## Questions for the owner ("Depende do dono")

1. **Fair price for EU visitors.** Should the studio keep fair price as a free
   creator choice for every country, or must a default or a warning exclude
   Member States until a lawyer reads Art. 4(2) with recital 27 (a buyer who
   "wishes to benefit" from another country's price)? Today it is off by
   default and the code lowers EU Member States such as Bulgaria, Romania,
   Hungary and Poland when a creator turns it on. Status **OPEN**.
2. **Who is bound.** Is Marktmorgen, as the operator of the store interface and
   checkout, treated as bound by Art. 3 and Art. 4 for creators' stores
   (recital 17), or only the creator? Status **OPEN**.
3. **Calls and live sessions.** Which of Art. 4(1)(b) or (c), or neither,
   covers a creator-led video call or webinar sold to an EU consumer? Status
   **OPEN**.
4. **Courses and podcasts with video.** Is lesson video an "audiovisual
   service" excluded by recital 8 and Art. 1(3), or a work under the copyright
   exclusion? The Directive 2006/123/EC text should be read first. Status
   **OPEN**.
5. **Creator declaration.** Add the question "business or private seller" to the
   studio (audit unit 2) so Art. 2(18) can be applied per store? Status
   **NEEDS-FACT**.
6. **Shipping lists.** Should the studio tell a creator that excluding a Member
   State is allowed only as a delivery choice and never by the buyer's
   residence or nationality? Status **NEEDS-FACT**.

## Not read, not checked

- Amendments to Regulation (EU) 2018/302 after publication, the Commission's
  Article 9 evaluation reports and any Commission guidance or FAQ on
  geo-blocking: not read.
- Directive 2006/123/EC (Art. 2(2) exclusions, Art. 20): not read; recital 8 of
  the Regulation was used for the audiovisual statement only.
- National enforcement bodies under Art. 7 and national rules: not read.
- Stripe's country-specific payment methods and any Vercel or Stripe account
  restriction by country: not opened.
- The code was read, not run; the fair-price figures for EU countries were
  computed by hand from `lib/fair-price-data.ts` and the `countryOff` formula.
