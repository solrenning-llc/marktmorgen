# SZ2: legal information fields for physical products (design, 6 November 2026)

Queue item 618 [SZ2]. A physical product (`Product.shipping`, `lib/catalog.ts`;
`lib/shipping.ts`) is something the creator ships. This document says which
information the creator fills for it, where Marktmorgen shows it, and what the
first pure unit (`lib/physical-legal.ts`) computes. These are **information
fields the creator fills**; nothing here is legal advice, and nothing here
states that a store, a product or Marktmorgen complies with any law.

State (VR item 1): design and a pure, tested module. Not wired into the studio,
the product page, the checkout, the email or storage. Nothing changes for any
customer. No price, limit, commission, flag or gate changes.

## Sources and how they were read

The session's network refused every official host on 6 November 2026
(`eur-lex.europa.eu`, `oehha.ca.gov`, `www.p65warnings.ca.gov`,
`commission.europa.eu`, `www.nist.gov`, `www.legislation.gov.uk`: proxy
`connect_rejected`). The official texts were therefore **located** by web search
on 6 November 2026 but **not read in full** in this session. Every row below
says which. Until each official text is read and its date recorded, the wording
in the table is the design's working reading, not a verified citation; the
divergence goes to "Depende do dono" (see the end), and the code keeps the
stricter behaviour where the reading is uncertain.

| # | Source (official) | URL | Read on 06/11/2026? |
| --- | --- | --- | --- |
| S1 | Regulation (EU) 2023/988 (GPSR), arts. 3(14), 4, 16, 19, 22, 52 | https://eur-lex.europa.eu/eli/reg/2023/988/oj | No (host blocked). Located by search; arts. 19 and 22(7) summarized by secondary sources found the same day. |
| S2 | Commission, Safety Gate "obligations for businesses" presentation of the GPSR | https://webgate.ec.europa.eu/safety/consumers/consumers_safety_gate/obligationsForBusinesses/documents/GPSR-Presentation-website.pdf | No (located by search; lists the manufacturer's postal and electronic address and the EU responsible person). |
| S3 | Directive 98/6/EC (Price Indication), arts. 1–6a, as amended by Directive (EU) 2019/2161 art. 2 | https://eur-lex.europa.eu/eli/dir/1998/6/oj | No (host blocked). |
| S4 | Commission Notice 2021/C 526/02, guidance on art. 6a of 98/6/EC (OJ C 526, p. 130, as cited by the search result) | https://eur-lex.europa.eu/oj/direct-access.html (OJ C 526 of 2021; exact CELEX link to confirm) | No (host blocked). |
| S5 | CJEU, C-330/23, Aldi Süd, 26 September 2024: the announced reduction is computed from the lowest price applied in the 30 days before it | https://curia.europa.eu/juris/liste.jsf?num=C-330/23 | No; judgment located by search (secondary summaries agree on the holding). |
| S6 | Cal. Code Regs. tit. 27, §§ 25600.2, 25602(b), 25603 (Proposition 65 safe-harbor warnings), as amended effective 1 January 2025 | https://oehha.ca.gov/media/downloads/crnr/finalregtext112624approval.pdf | No (host blocked). Located by search; secondary sources the same day agree: internet warning on the product display page or a clearly marked hyperlink on it, before purchase; short form must name a chemical; "CA WARNING" / "CALIFORNIA WARNING" allowed; transition to 1 January 2028. |
| S7 | Cal. Health & Safety Code § 25249.11(b) (businesses with fewer than 10 employees are not "persons in the course of doing business") | https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=HSC&sectionNum=25249.11 | No. |
| S8 | NIST Handbook 130, Uniform Unit Pricing Regulation (model for US states) | https://www.nist.gov/pml/owm/publications/nist-handbooks/handbook-130 | No (host blocked). |

## What must be shown, by whom (working reading)

### EU / EEA: GPSR art. 19 (distance sales), applicable since 13 December 2024

The economic operator offering a product online (here the **creator**, who is
the seller and often the manufacturer) indicates clearly and visibly in the
offer, before purchase:

| Field | GPSR | Who fills | Required for an EU sale |
| --- | --- | --- | --- |
| Manufacturer: name, registered trade name or trade mark | 19(a) | creator | yes |
| Manufacturer: postal address | 19(a) | creator | yes |
| Manufacturer: electronic address (email or web contact page) | 19(a), corrigendum | creator | yes |
| EU responsible person: name, postal and electronic address, when the manufacturer is not established in the EU | 19(b), 16(1); Reg. 2019/1020 art. 4 | creator | yes when the manufacturer's country is outside the EU/EEA |
| Product identification: a picture, its type, and any other identifier (batch, serial, model) | 19(c) | creator (picture: the product image) | picture and type yes; other identifier optional |
| Warnings or safety information that goes on or with the product, in a language consumers there understand | 19(d) | creator | the text, or an explicit "no warnings or safety information" |

Art. 16(1): a product may be placed on the EU market only if an economic
operator established in the Union is responsible for it. Many Marktmorgen
creators are in the US; their EU sales need an EU responsible person.

**Marktmorgen's side, art. 22.** If Marktmorgen is an "online marketplace"
(art. 3(14): an intermediary service whose online interface lets consumers
conclude distance contracts with traders), art. 22(7) requires it to design its
interface so the trader can enter the art. 19 information and it is displayed
with the offer. Each store is the creator's own page with direct charges on the
creator's Stripe account, but the interface and checkout are Marktmorgen's; the
design takes the stricter reading that art. 22(7) applies. The other art. 22
duties (registration on the Safety Gate portal and a single point of contact,
22(1); acting on authority orders and notices; cooperation) need an account or
a contact with an authority and are **not done by any agent**: "Depende do
dono".

Scope notes: GPSR art. 2(2) excludes, among others, medicinal products, food,
feed, living plants and animals and antiques; products under sector law
(toys, cosmetics, electrical equipment...) keep GPSR art. 19 for what that law
does not cover. The module does not classify products; the creator fills the
fields for every physical product shipped to the EU/EEA.

**What Marktmorgen does (later units):** fields in the studio on a physical
product; shown on the product page and on the checkout path before payment and
in the confirmation email; a physical product whose fields are incomplete does
not ship to the EU/EEA countries (those countries are taken out of the
checkout's shipping countries, with the reason in the studio), and the rest of
its countries keep selling. Area used: EU 27 plus Iceland, Liechtenstein and
Norway (GPSR is marked "text with EEA relevance"; whether it is already in the
EEA Agreement was not read, so the stricter inclusion is used). Northern
Ireland ships under `GB` and cannot be told apart by country code: not covered;
"Depende do dono".

### California: Proposition 65 (27 CCR §§ 25600.2, 25602(b), 25603)

- Who: the manufacturer, producer, packager, importer, supplier or distributor
  is primarily responsible (§ 25600.2); a retail seller only in the cases that
  section lists. Businesses with fewer than 10 employees are outside the act
  (S7). Whether a product exposes anyone to a listed chemical is a fact only
  the creator (or their supplier) knows.
- Internet sales safe harbor (§ 25602(b), as amended 1 January 2025): the
  warning is on the product display page, or a clearly marked hyperlink using
  the word "WARNING" on that page, or otherwise prominently displayed before
  the purchase is completed.
- Content (§ 25603): signal word `WARNING:` (from 2025 also `CA WARNING:` or
  `CALIFORNIA WARNING:`), and a reference to `www.P65Warnings.ca.gov`; the short
  form must now name at least one listed chemical (transition for existing
  short forms to 1 January 2028).

**What Marktmorgen does:** an optional field "California Proposition 65
warning" on a physical product that ships to the US, with the text exactly as
the creator's manufacturer or supplier gave it. The code does not write the
warning and does not decide whether one is needed; it checks that a given text
starts with a signal word and names the P65Warnings site, and shows it on the
product page before the buy button and on the checkout path. No product is
blocked for leaving it empty. The yellow triangle symbol of the long form is
not drawn yet (out of scope; see below).

### EU: unit price (98/6/EC arts. 2(b), 3)

For a product sold by weight, volume, length, area or cubic measure, the unit
price (price per kilogram, litre, metre, square metre or cubic metre) is shown
next to the selling price, unless it equals the selling price; member states
may waive it for some products (art. 5) and some allow other reference units.

**What Marktmorgen does:** optional "Net quantity" on each price of a physical
product (amount and unit: g, kg, ml, cl, l, mm, cm, m, cm², m², cm³, m³); the
unit price is computed, never typed, from the price actually charged. Shown on
the product page next to the price, at the base unit (kg, l, m, m², m³), with
the unit written out for screen readers. A unit price is shown to every buyer
when a quantity is set (it costs nothing and helps everyone).

**US states:** unit-pricing laws modelled on NIST Handbook 130 apply to retail
stores in a few states; whether any reaches an online seller was not read
(S8). Nothing is required by the code; the same optional display covers it.

### EU: prior lowest price on an announced reduction (98/6/EC art. 6a)

Any announcement of a price reduction indicates the prior price: the lowest
price the trader applied in a period of not less than 30 days before the
reduction (art. 6a(2)); the CJEU (S5) held that the percentage or the struck
price is computed from that prior price, not from the price the day before.
Member states may set other rules for perishable goods, goods on the market
under 30 days, and progressively increasing reductions (art. 6a(3)–(5)).

**What Marktmorgen does:** the store sale (`lib/store-sale.ts`) is the only
announced reduction. A price history per physical product records each price
actually applied (the regular price, and the sale price while a sale ran),
kept for 61 days: the 30-day period plus the longest store sale
(`MAX_SALE_DAYS`, 31), so a sale still running on its last day finds the
prior price computed at its start (the queue item said "limited to 30 days";
30 alone would lose that price mid-sale). During a sale, a buyer in the EU/EEA sees the prior price
computed from that history, and the percentage shown is computed from it.
History shorter than 30 days (a new product) is flagged, and the next unit
decides the wording ("Lowest price since it went on sale on ..."). A sale
announced on a product with no history at all is not shown to EU/EEA buyers
with a struck price.

Digital content: art. 6a sits in a directive about "products" offered by
traders; whether any member state extends it to services or digital content
(for example a national law written for "goods and services") was not read:
"Depende do dono", per country, before extending the history to digital
products.

## Data model (later units store it; this unit only defines and validates it)

```ts
type Contact = { name: string; postal: string; electronic: string; country: string };
type SafetyInfo = {
  manufacturer: Contact;
  responsible: Contact | null; // needed when manufacturer.country is outside the EU/EEA
  productType: string;         // type or model the buyer can recognise
  identifier: string;          // batch, serial or other, optional
  warnings: string;            // as given with the product
  noWarnings: boolean;         // the creator states there are none; never inferred from an empty field
};
type NetQuantity = { amount: string; unit: QuantityUnit }; // per price option
type PriceStep = { at: number; cents: number };            // seconds; history kept 61 days (30 + longest sale)
type Prop65 = string;                                      // "" is none
```

Limits: each text field has a maximum length (`MAX_*` in the module), control
characters and overlong values read as empty (never silently cut),
a step is never stamped later than the latest time seen (a change in the
same second keeps that second, after the earlier step in order; a clock that
goes back stamps the new step at the last step's second; no applied price is
lost or moved into the future), a history with any unreadable step reads as
"unreadable" as a whole (never a filtered subset taken as complete), the price history holds at most `MAX_PRICE_STEPS`
steps; when a creator changes prices more often than that within the kept period,
adjacent old steps are merged into one at the **lower** price, so the prior
price can only come out lower (a smaller announced reduction), never higher.

Storage cost (later unit): one short record on the product and up to
`MAX_PRICE_STEPS` small entries, written only when the price applied changes;
inside the store's existing data-room limits; no supplier, no AI, no new read
on a page view beyond the product record already read.

## Validation (in `lib/physical-legal.ts`)

- `readSafetyInfo(raw)`: whatever came back from storage, made safe.
- `safetyGaps(info, hasPicture)`: the list of missing GPSR items (codes), empty
  when complete.
- `gpsrClosedCountries(countries, info, hasPicture)`: the shipping countries in
  the EU/EEA that the product cannot ship to while gaps remain.
- `checkProp65(text)`: `null` when acceptable or empty; otherwise the problem.
  The site counts only when named on its own (`www.P65Warnings.ca.gov`,
  optionally with `https://` and a path), not as part of a longer hostname.
- `unitPrice(priceCents, quantity)`: the price per base unit, rounded half up
  to the smallest currency unit, from exact integer arithmetic.
- `recordPrice(history, cents, now)` and `priorLowestPrice(history, start)`;
  the latter returns `"unreadable"` when any step of the history cannot be
  read, and a price replaced within the sale's own starting second counts as
  before it (it can only lower the prior price).

## Accessibility (AX274)

For the later display units: the fields are plain text in the page's language
order, under a heading "Product safety and manufacturer" (2.4.10), in a
definition list (`dl`) so a screen reader reads label and value; the Prop 65
text is shown as text, never an image of text (1.4.9), with the signal word in
bold but not conveyed by colour alone; unit abbreviations have a written form
(`unitWords`, 3.1.4: "per kilogram"), and the prior price is a sentence
("Lowest price in the 30 days before this sale: $12.00"), not only a struck
number. Studio fields have visible labels, an example in place, an error that
names the field and how to fix it (3.3.1, 3.3.3), and nothing typed is lost on
an error (3.3.7). Contrast 7:1, targets 44 × 44 px, reflow at 320 px, as the
rest of the studio. This unit has no interface: 0 → 0 steps and decisions.

## Out of scope for this item (or for now)

- Deciding whether a product needs a Prop 65 warning, which chemical, or the
  GPSR risk assessment; the creator answers for the product.
- Drawing the Prop 65 triangle symbol and food-specific warning pages.
- Warning translation per member state; the creator gives the text.
- Safety Gate registration, single point of contact, recalls, authority
  orders: "Depende do dono".
- UK (GPSR 2005 / Product Safety and Metrology Act 2025, Price Marking Order
  2004), Switzerland, Northern Ireland, other countries: not read.
- Feeds (207 [SH4]) reuse the same fields later.

## Next units

1. Storage and studio fields: `SafetyInfo`, Prop 65 text and net quantity on a
   physical product; validation from this module; AX274 form review.
2. Product page and checkout path: show the fields, the unit price and the
   Prop 65 text before the buy button; take the GPSR-closed countries out of
   the checkout's shipping countries (`lib/store-checkout.ts`,
   `lib/cart-shipping.ts`), with the studio saying why.
3. Confirmation email: the GPSR fields and the Prop 65 text.
4. Price history written when a price or a sale changes; the EU/EEA prior
   price on the store sale (`lib/store-sale.ts`) and the percentage from it.
5. Confirm every source above in the official text with its date; correct the
   module where the reading differs.

## Depende do dono (unknowns)

- The official texts S1–S8 could not be read on 6 November 2026 (network);
  every reading above stays the working reading until read and dated.
- Whether Marktmorgen is an "online marketplace" under GPSR art. 3(14): the
  design applies art. 22(7) anyway; the other art. 22 duties need the owner.
- EEA incorporation of the GPSR; Northern Ireland under `GB`.
- Member-state options under art. 6a(3)–(5) (new products, perishables,
  progressive reductions) and any extension of art. 6a to digital content.
- US state unit-pricing laws for online sellers.
