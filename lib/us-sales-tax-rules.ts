/**
 * 9 [C-US] unit 1 (coordinator Claude 5, C5-20261121-0535-respostas, item 1): the per-state US sales tax rules a
 * marketplace like Marktmorgen falls under, each read on the state's own official page on 2026-11-20, with the page's
 * address and a verbatim quote. Five questions per state:
 *   - stateSalesTax: whether the state has a statewide sales tax (Hawaii's general excise tax and New Mexico's gross
 *     receipts tax are noted where read);
 *   - marketplaceFacilitator: whether a platform that sells for third-party sellers must collect and remit on their
 *     sales;
 *   - threshold: the economic nexus threshold that starts the obligation, as the state words it (dollars, the
 *     transaction test if any and how the two join, the period, what counts); for Oklahoma and Connecticut, the
 *     facilitator's own threshold, which differs from a remote seller's;
 *   - digitalProducts: whether e-books, downloads and recorded courses delivered electronically are taxed;
 *   - saas: whether remotely accessed software, as Marktmorgen's own plans are, is taxed.
 *
 * Data only. Nothing reads it yet: no counter, no checkout, no registration, no flag. It is kept apart from the
 * doing-business counters of TX point 9 (Claude 2's lib/us-state-tax-threshold.ts, state income and franchise tax), a
 * different law; when counters are wired, both use one per-state counter (a later unit, agreed with Claude 2).
 *
 * Unknown is never zero. A field not confirmed on an official page that day is `{ known: false, gap }`, and whatever
 * reads this table later must treat it as the reading that protects the company (collect, or refuse the sale), never
 * as "no tax" or "below the threshold". Every quote was checked again by fetching its page and finding the words
 * there; three Nevada quotes whose page now redirects were turned into gaps. Colorado, Massachusetts and New
 * Hampshire answered 403 to every request, Rhode Island asked for a browser challenge, and Wyoming's and Maryland's
 * pages sit on hosts this environment does not reach: those stay unknown, and no way around a refusal was tried.
 * Some answers rest on a general statement or an older ruling; their `note` and the state's `gaps` say so.
 *
 * These pages change. Read them again, with the date, before any of this is used to collect or to stop collecting.
 */

/** The day every page below was read. */
export const US_SALES_TAX_READ_ON = "2026-11-20";

export type UsSalesTaxSource = { url: string; quote: string };
export type UsSalesTaxRead<T> = { known: true; value: T; source: UsSalesTaxSource; note?: string } | { known: false; gap: string };
export type UsNexusThreshold = {
  /** Dollars as the state writes them; never rounded or converted. */
  salesUsd: number;
  /** The transaction count, when the state has one; null when it has none or repealed it. */
  transactions: number | null;
  /** How the transaction test joins the dollar test; null when there is no transaction test. */
  joiner: "and" | "or" | null;
  period: string;
  counts: string;
};
export type UsTaxed = "yes" | "no" | "partly";
export type UsSalesTaxRule = {
  state: string;
  stateSalesTax: UsSalesTaxRead<boolean>;
  marketplaceFacilitator: UsSalesTaxRead<boolean>;
  threshold: UsSalesTaxRead<UsNexusThreshold | "no-state-sales-tax">;
  digitalProducts: UsSalesTaxRead<UsTaxed>;
  saas: UsSalesTaxRead<UsTaxed>;
  /** What was not confirmed, in the researcher's words. */
  gaps: readonly string[];
};

/** The 50 states and the District of Columbia, in the alphabetical order of their names. */
export const US_SALES_TAX_RULES: readonly UsSalesTaxRule[] = [
  {
    state: "AL",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.revenue.alabama.gov/division/sales-use/", quote: "Sales and Use Tax administers sales tax, consumers tax, sellers use tax, simplified sellers use tax, rental tax, lodgings tax, utility taxes and various other business taxes and fees." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.revenue.alabama.gov/sales-use/simplified-sellers-use-tax-ssut/", quote: "marketplace facilitators having sales made into Alabama through the marketplace of $250,000 or more must either register with ALDOR to collect and remit simplified sellers use tax (SSUT)" }, note: "Code of Ala. 1975 section 40-23-199.2 (per ADOR notice, 26 Jul 2021); Act 2018-539; Rules 810-6-2-.90.03 and .90.04" },
    threshold: { known: true, value: { salesUsd: 250000, transactions: null, joiner: null, period: "Remote seller: 'annual Alabama sales' (ADOR news release). Facilitator: period not stated on pages read.", counts: "Remote seller: retail sales made directly by the seller (sales through an SSUT-participating marketplace are excluded). Facilitator: sales made into Alabama through the marketplace. Alabama collects a flat 8% simplified sellers use tax." }, source: { url: "https://www.revenue.alabama.gov/news/ador-announces-sales-and-use-tax-guidance-for-online-sellers/", quote: "Remote sellers with annual Alabama sales in excess of the rule's $250,000 small seller exception should register for the Alabama Simplified Sellers Use Tax Program (SSUT)" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products and SaaS taxability not confirmed on an official page.", "Measuring period for marketplace facilitator threshold not stated on the pages read.", "Alabama code/administrative-rule text sites not read; figures come from ADOR guidance pages."],
  },
  {
    state: "AK",
    stateSalesTax: { known: true, value: false, source: { url: "https://arsstc.org/faqs-for-sellers/", quote: "Alaska does not have a state sales tax." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://arsstc.org/about/code/", quote: "A marketplace facilitator is considered the remote seller for each sale facilitated through its marketplace and shall collect, report, and remit sales tax to the Commission." }, note: "Alaska Remote Seller Sales Tax Code (ARSSTC), Section 040 / Section 050 (marketplace facilitator provisions); applies only in member jurisdictions" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Current or previous calendar year (Code Section 040); FAQ says 'previous calendar year'.", counts: "Statewide gross sales (all sales of goods, property, products or services delivered in Alaska, taxable or not), including the seller's marketplace facilitator's statewide gross sales." }, source: { url: "https://arsstc.org/about/code/", quote: "provided the remote seller or marketplace facilitator has met one of the following Threshold Criteria (\"Threshold Criteria\") in the current or previous calendar year: ... meets or exceeds one hundred thousand dollars ($100,000)" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Alaska has no state sales tax; taxability varies by municipality and was not checked per municipality.", "Only a $100,000 criterion was found in Section 040 (no transaction-count criterion seen).", "The ARSSTC quote for threshold joins two sentence fragments with an ellipsis; the code text itself was read at arsstc.org/about/code/."],
  },
  {
    state: "AZ",
    stateSalesTax: { known: true, value: true, source: { url: "https://azdor.gov/business/transaction-privilege-tax/retail-sales-subject-tpt", quote: "A retail sale is a sale of tangible personal property sold by persons (i.e. retailers) that have substantial nexus by physical presence or economic nexus." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://azdor.gov/business/transaction-privilege-tax/reporting-guide", quote: "The Arizona statutes define a marketplace facilitator as a person or business operating a marketplace and facilitating retail sales." }, note: "Not given on page; ADOR TPT notices list business codes 'Marketplace Facilitators in Arizona Retail Sales (017)' and 'Third Party Sales (605)'. Economic nexus rules effective October 1, 2019 (deduction-codes page)." },
    threshold: { known: false, gap: "no threshold confirmed on an official page read on 2026-11-20" },
    digitalProducts: { known: true, value: "partly", source: { url: "https://azdor.gov/business/transaction-privilege-tax/retail-sales-subject-tpt", quote: "Examples of tangible personal property include, but are not limited to: digital images, handmade items, vehicles, clothing, handmade jewelry, etc." }, note: "Only 'digital images' is named as tangible personal property; e-books, courses, downloads not addressed on pages read." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Economic nexus threshold amount, period and facilitator rule NOT confirmed: the ADOR nexus page (azdor.gov/taxpayer-education/nexus-program/nexus-program-tpt) returns HTTP 403 and azleg.gov is not reachable.", "The old URL azdor.gov/transaction-privilege-tax and the remote-sellers page returned 404.", "SaaS and e-book/course taxability not confirmed."],
  },
  {
    state: "AR",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.dfa.arkansas.gov/office/taxes/excise-tax-administration/sales-use-tax/sales-and-use-tax-faqs/", quote: "The state Use Tax rate is the same as the Sales Tax rate, 6.500%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.dfa.arkansas.gov/office/taxes/excise-tax-administration/sales-use-tax/remote-sellers/", quote: "All remote sellers and marketplace facilitators are required to collect and remit Sales and Use tax to the State of Arkansas if within the current or previous year" }, note: "Act 822 of the 92nd Legislative Session (2019), as stated on the DFA page" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Current or previous year", counts: "Sales of tangible personal property, taxable services, a digital code, or specified digital products for delivery into Arkansas." }, source: { url: "https://www.dfa.arkansas.gov/office/taxes/excise-tax-administration/sales-use-tax/remote-sellers/", quote: "within the current or previous year the sale of tangible personal property, taxable services, a digital code, or specified digital products for delivery into Arkansas exceeded one hundred thousand dollars ($100,000) or two hundred (200) taxable transactions" } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://www.dfa.arkansas.gov/office/taxes/excise-tax-administration/sales-use-tax/remote-sellers/", quote: "tangible personal property, taxable services, a digital code, or specified digital products for delivery into Arkansas" }, note: "The page treats 'specified digital products' and digital codes as taxable sales counting to the threshold; the definition of specified digital products (which kinds are taxed) was not read." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Definition of 'specified digital products' and SaaS treatment not confirmed on an official page.", "Statute/rule text (codeofarrules.arkansas.gov) not read."],
  },
  {
    state: "CA",
    stateSalesTax: { known: true, value: true, source: { url: "https://cdtfa.ca.gov/industry/MPFAct.htm", quote: "a marketplace facilitator is generally responsible for collecting, reporting, and paying the tax on retail sales made through their marketplace for delivery to California customers." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://cdtfa.ca.gov/industry/MPFAct.htm", quote: "a marketplace facilitator is considered the seller and retailer for each sale facilitated through its marketplace" }, note: "Marketplace Facilitator Act, Rev. & Tax. Code sections 6041-6041.6 (AB 147, SB 92, AB 1402); from 1 Oct 2019. Page covers tangible merchandise; from 1 Jan 2027 digital products (see below) are tangible personal property and the digital-products guide says marketplace facilitators may need to register for digital product sales." },
    threshold: { known: true, value: { salesUsd: 500000, transactions: null, joiner: null, period: "Preceding or current calendar year", counts: "Total combined sales of tangible personal property for delivery in California by the retailer and related persons, including sales facilitated through a marketplace facilitator." }, source: { url: "https://cdtfa.ca.gov/industry/MPFAct.htm", quote: "Economic nexus means that the total combined sales of tangible personal property for delivery in California by the retailer and all persons related to the retailer exceed $500,000 in the preceding or current calendar year." } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://cdtfa.ca.gov/industry/retailers-and-purchasers-of-digital-products/definitions.htm", quote: "Digital products do NOT include any of the following: ... Digital audio work ... Digital audiovisual work ... Digital book" }, note: "From 1 Jan 2027 only prewritten computer software (downloaded, electronically transferred or remotely accessed) is a taxable 'digital product'; e-books, audio, video/movies are excluded from the definition. A flat file download or recorded course video is therefore not taxable as a digital product; software is. Before 2027 not checked." },
    saas: { known: true, value: "yes", source: { url: "https://cdtfa.ca.gov/industry/retailers-and-purchasers-of-digital-products/definitions.htm", quote: "Software as a service (SaaS) involving the right to access and use the provider's prewritten computer software running on a cloud infrastructure" }, note: "Effective 1 January 2027 (Senate Bill 122, Stats. 2026, Ch. 23) per https://cdtfa.ca.gov/industry/retailers-and-purchasers-of-digital-products/ : 'sales and use tax generally applies to the retail sale of a digital product'. Treatment before 2027 not confirmed. Retailers may be relieved when a purchaser's aggregate gross receipts exceed $5,000,000 (retailers.htm)." },
    gaps: ["Whether digital-product sales count toward the $500,000 economic-nexus threshold from 2027 was not confirmed on the pages read.", "Pre-2027 treatment of SaaS/digital goods not read.", "www.cdtfa.ca.gov does not resolve; bare cdtfa.ca.gov was used."],
  },
  {
    state: "CO",
    stateSalesTax: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: false, gap: "no threshold confirmed on an official page read on 2026-11-20" },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["tax.colorado.gov returned HTTP 403 (bot block) for every URL tried, with several user agents and header sets; no other official Colorado host (cdor.colorado.gov, colorado.gov/revenue, sos.state.co.us, leg.colorado.gov) is reachable from this session. Nothing could be read, so every field is unknown."],
  },
  {
    state: "CT",
    stateSalesTax: { known: true, value: true, source: { url: "https://portal.ct.gov/drs/sales-tax/tax-information", quote: "The sales tax rate of 6.35% applies to the retail sale, lease, or rental of most goods (including digital goods, which are described in Special Notice 2019(8)" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://portal.ct.gov/-/media/drs/publications/ocg/ocg-8.pdf", quote: "As of December 1, 2018, marketplace facilitators are required to collect and remit sales tax on behalf of their marketplace sellers." }, note: "Public Acts 2018, No. 18-152, sections 2-5 (OCG-8); Conn. Gen. Stat. section 12-407(a)(15)(C) as amended" },
    threshold: { known: true, value: { salesUsd: 250000, transactions: null, joiner: null, period: "Remote seller (IP 2018(5)): 12-month period ending the September 30 before the tax period. Facilitator (OCG-8 Q12): October 1 to September 30.", counts: "Remote seller: retail sales into Connecticut (count includes sales through a marketplace facilitator per OCG-8 chart). Facilitator: facilitated retail sales by marketplace sellers; sales to all purchasers wherever located count." }, source: { url: "https://portal.ct.gov/-/media/drs/publications/ocg/ocg-8.pdf", quote: "Facilitated retail sales of at least $250,000 during the prior twelve-month period by marketplace sellers" } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://portal.ct.gov/-/media/drs/publications/pubssn/2019/sn-2019(8).pdf", quote: "digital goods, which includes audio works, visual works, audio-visual works, reading materials or ring tones, which are electronically accessed or transferred, will be subject to sales and use taxes at the standard 6.35% rate." }, note: "Effective 1 Oct 2019, downloaded or streamed digital goods (books, videos, music, podcasts) taxed at 6.35%. Digital goods sold individually, as subscriptions, as in-app purchases or as codes are all within the 6.35% list. Not read: whether online courses with live/interactive content differ." },
    saas: { known: true, value: "partly", source: { url: "https://portal.ct.gov/drs/sales-tax/tax-information", quote: "Canned software electronically accessed or transferred, without any tangible personal property, that is purchased by a business for business use." }, note: "Page lists this under the 1% rate; 'Canned software that is electronically accessed or transferred for personal use is taxable at 6.35%'. A creator's business subscription is therefore taxable at 1% (rate for computer and data processing services); non-business use 6.35%. The page does not use the term SaaS." },
    gaps: ["OCG-8 and IP 2018(5) are dated 2018 guidance; no newer remote-seller page was found on portal.ct.gov, so the current text of the threshold and any later law change was not confirmed.", "The 'prior twelve-month' definitions differ between remote seller (ends Sept 30 preceding the tax period) and facilitator (Oct 1 to Sept 30)."],
  },
  {
    state: "DE",
    stateSalesTax: { known: true, value: false, source: { url: "https://revenue.delaware.gov/frequently-asked-questions/business-licenses-faqs/", quote: "Delaware does not impose a state sales tax; however, Delaware does impose a tax on the gross receipts of most businesses." } },
    marketplaceFacilitator: { known: true, value: false, source: { url: "https://revenue.delaware.gov/frequently-asked-questions/business-licenses-faqs/", quote: "Delaware does not impose a state sales tax" }, note: "Not applicable: no state sales tax, so no marketplace-facilitator sales-tax collection duty was found. Gross receipts tax applicability to a marketplace operator was not read." },
    threshold: { known: true, value: "no-state-sales-tax", source: { url: "https://revenue.delaware.gov/frequently-asked-questions/business-licenses-faqs/", quote: "Delaware does not impose a state sales tax; however, Delaware does impose a tax on the gross receipts of most businesses." } },
    digitalProducts: { known: true, value: "no", source: { url: "https://revenue.delaware.gov/frequently-asked-questions/business-licenses-faqs/", quote: "Delaware does not impose a state sales tax" }, note: "No sales tax on any product. The seller's gross receipts may be subject to Delaware gross receipts tax if it engages in business in Delaware (not read in detail for remote/out-of-state sellers)." },
    saas: { known: true, value: "no", source: { url: "https://revenue.delaware.gov/frequently-asked-questions/business-licenses-faqs/", quote: "Delaware does not impose a state sales tax" }, note: "No sales tax. Same gross receipts tax caveat." },
    gaps: ["Whether Delaware gross receipts tax reaches an out-of-state platform or marketplace operator was not confirmed on the pages read.", "'Marketplace facilitator false' is inferred from there being no sales tax, not from a page that addresses marketplaces."],
  },
  {
    state: "DC",
    stateSalesTax: { known: true, value: true, source: { url: "https://otr.cfo.dc.gov/page/sales-and-use-tax-faqs", quote: "Beginning on January 1, 2019, remote sellers must collect and remit District sales tax" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://otr.cfo.dc.gov/page/sales-and-use-tax-faqs", quote: "Beginning on April 1, 2019, a \"marketplace facilitator\" is required to collect District sales tax on behalf of its \"marketplace sellers.\"" }, note: "Not cited on page (D.C. Code sales and use tax chapter 47-2001 et seq.)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Previous calendar year or current calendar year", counts: "Gross receipts from retail sales delivered into the District, or number of separate retail sales delivered; sales on own website and through a marketplace both count." }, source: { url: "https://otr.cfo.dc.gov/page/sales-and-use-tax-faqs", quote: "remote sellers must collect and remit District sales tax if they had, in the previous calendar year, or will have, in the current calendar year, more than $100,000 of gross receipts from retail sales delivered into the District or more than 200 separate retail sales" } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://otr.cfo.dc.gov/page/digital-goods-sales-taxability-chart", quote: "Digital Books – Taxable digital goods under D.C. Code §47-2001(d-1)." }, note: "Chart also lists audiobooks, music downloads and streaming, digital video downloads, streaming video services, applications as taxable, effective January 1, 2019. Online courses not specifically listed." },
    saas: { known: true, value: "partly", source: { url: "https://otr.cfo.dc.gov/page/digital-goods-sales-taxability-chart", quote: "the sale, rental, or maintenance of computer software continues to be subject to sales tax in the District whether the software is canned, prepackaged, or customized." }, note: "Software and software services are taxable (D.C. Mun. Regs. 9 §474.4); the chart does not name remotely accessed SaaS explicitly, so SaaS is likely taxable but not confirmed by name." },
    gaps: ["Marketplace facilitator definition quoted from FAQ; whether the 'remote seller' threshold also governs facilitators was not stated.", "Remote SaaS and online course taxability not named explicitly."],
  },
  {
    state: "FL",
    stateSalesTax: { known: true, value: true, source: { url: "https://floridarevenue.com/taxes/taxesfees/Pages/sales_tax.aspx", quote: "Sales tax and discretionary sales surtax are calculated on each taxable transaction." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://floridarevenue.com/taxes/tips/Documents/TIP_21A01-03.pdf", quote: "marketplace providers who have a physical presence in Florida or who make or facilitate a substantial number of remote sales, as defined above, through a marketplace, are required to register with the Department and collect and remit tax." }, note: "Chapter 2021-2, Laws of Florida; sections 212.02, 212.05, 212.054, 212.0596, 212.05965, 212.06, 212.11, 212.18, F.S. (as listed in TIP 21A01-03). Florida's term is 'marketplace provider'; effective July 1, 2021." },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Previous calendar year", counts: "Taxable remote sales (the sum of total sales exceeds $100,000); TIP defines a remote sale as the retail sale of tangible personal property transported into Florida." }, source: { url: "https://floridarevenue.com/taxes/taxesfees/Pages/sales_tax.aspx", quote: "Effective July 1, 2021, Florida law requires businesses making remote sales into the state to collect and electronically remit sales and use tax ... if the business has made taxable remote sales in excess of $100,000 over the previous calendar year." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products and SaaS taxability not confirmed (flsenate.gov, flrules.org not reachable; floridarevenue.com pages found do not cover it).", "The remote-sale/marketplace definitions refer to tangible personal property, so their reach to digital products is unconfirmed."],
  },
  {
    state: "GA",
    stateSalesTax: { known: true, value: true, source: { url: "https://dor.georgia.gov/taxes/sales-use-tax", quote: "Georgia sales and use tax generally applies to all tangible goods sold." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://dor.georgia.gov/marketplace-facilitators", quote: "A marketplace facilitator is a \"dealer\" and is required to collect and remit Georgia state and local sales taxes on facilitated retail sales sourced to Georgia" }, note: "O.C.G.A. § 48-8-2(8)(M.3) (as cited in DOR Policy Bulletin SUT-2020-01)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "previous or current calendar year", counts: "total value of the sales price of its taxable retail sales sourced to Georgia, combined across all its marketplace sellers and the marketplace facilitator itself" }, source: { url: "https://dor.georgia.gov/marketplace-facilitators", quote: "equals or exceeds $100,000.00 in the previous or current calendar year." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Georgia digital products and SaaS taxability: no official statement found in pages read (dor.georgia.gov what-subject-to-sales-tax FAQ and sales-use-tax page contain no software/digital text).", "Remote-seller (non-facilitator) threshold page not read.", "has_state_sales_tax quote is general ('tangible goods'); rate not read."],
  },
  {
    state: "HI",
    stateSalesTax: { known: true, value: true, source: { url: "https://files.hawaii.gov/tax/legal/hrs/hrs_237.pdf", quote: "There is hereby levied and shall be assessed and collected annually privilege taxes against persons on account of their business and other activities in the State" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://files.hawaii.gov/tax/legal/hrs/hrs_237.pdf", quote: "A marketplace facilitator shall be deemed the seller of tangible personal property, intangible property, or services" }, note: "HRS § 237-4.5" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "current or immediately preceding calendar year", counts: "gross income or gross proceeds from sale of tangible personal property delivered in the State, services used or consumed in the State, or intangible property used in the State; or 200 or more separate transactions" }, source: { url: "https://files.hawaii.gov/tax/legal/hrs/hrs_237.pdf", quote: "is $100,000 or more; or (2) The person sold tangible personal property delivered in the State, services used or consumed in the State, or intangible property used in the State in two hundred or more separate transactions." } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://files.hawaii.gov/tax/legal/tir/tir21-06.pdf", quote: "The Department considers the sale of prewritten or canned software to be the sale of tangible personal property (TPP), regardless of whether the software is contained on a tangible medium" }, note: "Confirmed only for prewritten software transferred electronically. E-books, downloads, recorded courses not addressed in pages read; GET applies broadly to gross income so likely taxable but NOT confirmed." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["TIR 2019-03 (marketplace facilitator guidance) not retrievable (404 on guessed URLs); facilitator-specific threshold unconfirmed.", "SaaS and e-book/course taxability not stated in pages read.", "HRS 237-2.5 is 'engaging in business' nexus; whether it is the facilitator trigger is inferred from 237-4.5 + 237-3, not stated."],
  },
  {
    state: "ID",
    stateSalesTax: { known: true, value: true, source: { url: "https://tax.idaho.gov/taxes/sales-use/online-guide/", quote: "Idaho’s sales tax rate is 6%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.idaho.gov/taxes/sales-use/guides-for-certain-groups/online-sellers/laws-rules/", quote: "Marketplace facilitator — Idaho Code section 63-3605E" }, note: "Idaho Code § 63-3605E (House Bill 259, 2019)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "current or previous calendar year", counts: "combined total of the facilitator's own Idaho sales and its third-party Idaho sales; remote retailers: total Idaho sales including those through a marketplace facilitator" }, source: { url: "https://tax.idaho.gov/taxes/sales-use/guides-for-certain-groups/online-sellers/online-guide/", quote: "Marketplace facilitators without a physical presence in Idaho must collect Idaho sales tax when the combined total of their own sales in Idaho and their third-party sales in Idaho exceeds $100,000 in the current or previous year." } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://tax.idaho.gov/taxes/sales-use/online-guide/", quote: "Digital books, videos, music, or games with a permanent right for the buyer to use" }, note: "Listed as an example of taxable retail sales. Only digital items with a permanent right of use are listed; streaming/subscription access not addressed." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Idaho SaaS taxability: Sales Tax Rule 027 text not retrievable (adminrules.idaho.gov and legislature.idaho.gov not on allowlist).", "Whether 'permanent right' excludes recorded courses/subscriptions not stated.", "Idaho facilitator is also required to hold separate seller's permit (informational)."],
  },
  {
    state: "IL",
    stateSalesTax: { known: true, value: true, source: { url: "https://tax.illinois.gov/research/publications/bulletins/fy-2026-12.html", quote: "are subject to State and local Retailers' Occupation Tax (ROT)" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.illinois.gov/research/publications/bulletins/fy-2026-12.html", quote: "Marketplace facilitators who no longer meet the threshold will no longer be required to file a return and remit ROT on behalf of their marketplace sellers." }, note: "Leveling the Playing Field for Illinois Retail Act, 35 ILCS 185; 86 Ill. Adm. Code 131.130 (definition); P.A. 104-0006" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "12-month lookback period; on or after Jan 1 2026 the 200-transaction threshold no longer applies; rolling quarterly determination for quarters beginning after March 31, 2026", counts: "cumulative gross receipts from sales of tangible personal property (TPP) to purchasers in Illinois (page speaks only of TPP)" }, source: { url: "https://tax.illinois.gov/research/publications/bulletins/fy-2026-12.html", quote: "the only threshold used to determine if a remote retailer or marketplace facilitator is engaged in the occupation of selling TPP at retail in Illinois and is subject to State and local ROT is whether the retailer makes $100,000 or more in cumulative gross receipts" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Illinois digital products and SaaS taxability not confirmed: 86 Ill. Adm. Code 130.1935 not retrievable (redirect to ilga.gov blocked).", "Bulletin FY 2024-08 is on taxarchive.illinois.gov, not on the allowlist.", "The $100,000 test and facilitator definition are written around TPP; whether digital/service sales count toward it was not confirmed.", "Service Occupation Tax threshold ($100,000 sales of service) appears in PIO-113 (R-01/26), not analysed."],
  },
  {
    state: "IN",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.in.gov/dor/i-am-a/business-corp/remote-sellers/marketplace-facilitators", quote: "Indiana’s current sales tax rate is 7%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.in.gov/dor/i-am-a/business-corp/remote-sellers/marketplace-facilitators", quote: "Marketplace facilitators must register and collect Indiana sales tax on behalf of their sellers for transactions into Indiana." }, note: "IC 6-2.5-2-1; IC 6-2.5-1-21.7 and 21.9 (per Sales Tax Information Bulletin #89)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "current or preceding calendar year; 200-transaction threshold removed effective January 1, 2024", counts: "gross revenue from sales of tangible personal property delivered into Indiana, a product transferred electronically into Indiana, or a service delivered in Indiana; counted regardless of whether the sales are taxable; facilitators count own sales plus facilitated sales" }, source: { url: "https://www.in.gov/dor/i-am-a/business-corp/remote-sellers/", quote: "if its gross revenue from sales into Indiana exceeds $100,000 in the previous or current calendar year." } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://www.in.gov/dor/files/sib08.pdf", quote: "electronically transfers specified digital products to an end user; and (2) grants to the end user the right of permanent use of the specified digital products that is not conditioned upon continued payment by the purchaser." }, note: "Specified digital products = digital audio works, digital audiovisual works, digital books (Sales Tax Information Bulletin #8, Jan 2023); taxable only with permanent-use right not conditioned on continued payment, so subscriptions/streaming and non-listed categories (e.g. recorded courses, generic downloads) are not confirmed taxable. Bulletin #93 gives detail but was not read." },
    saas: { known: true, value: "no", source: { url: "https://www.in.gov/dor/files/sib08.pdf", quote: "are not considered retail transactions, and therefore the purchase, rental, lease, or license of that software is not subject to Indiana sales or use tax." }, note: "Prewritten software remotely accessed from a hosted server (cloud computing, SaaS) is not a retail transaction; bulletin effective January 1, 2023." },
    gaps: ["Sales Tax Information Bulletin #93 (specified digital products detail) not read.", "Quotes from the SIB PDFs are re-flowed from multi-line PDF text."],
  },
  {
    state: "IA",
    stateSalesTax: { known: true, value: true, source: { url: "https://tax.iowa.gov/remote-sellers", quote: "must charge sales tax, including local option sales tax, the same as retailers with a physical presence in Iowa." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.iowa.gov/remote-sellers", quote: "If a marketplace facilitator makes or facilitates $100,000 or more in Iowa sales, the marketplace facilitator must collect and remit Iowa sales tax" }, note: "Iowa Code § 423.14A" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "remote seller: prior-year or current-year exceedance, collecting from the first day of the next calendar month starting at least 30 days after crossing, through year end and the entire next calendar year", counts: "gross revenue from Iowa sales, including exempt sales, wholesale sales and sales where a marketplace facilitator collected tax; facilitator: Iowa sales made or facilitated" }, source: { url: "https://tax.iowa.gov/remote-sellers", quote: "Remote sellers must collect Iowa sales tax only if the remote seller has $100,000 or more in gross revenue from Iowa sales." } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://revenue.iowa.gov/taxes/tax-guidance/sales-use-excise-tax/taxation-specified-digital-products-software-and-related-services", quote: "Beginning January 1, 2019, Iowa sales tax, local option sales tax, and use tax applies to “specified digital products.”" }, note: "Includes digital audio-visual works, audio works, e-books, other digital written works, games, news/information products, software apps; webinars generally taxable; exempt when sold to a non-end user and, for commercial enterprises, an exemption for specified digital products used exclusively by the enterprise (Iowa Code 423.3(104))." },
    saas: { known: true, value: "yes", source: { url: "https://revenue.iowa.gov/taxes/tax-guidance/sales-use-excise-tax/taxation-specified-digital-products-software-and-related-services", quote: "Software as a service means the sale, storage, use, or other consumption of vendor-hosted computer software, such as software accessible on the cloud." }, note: "Listed under 'New Taxable Service'. A commercial enterprise exemption (Iowa Code 423.3(104)) applies to SaaS purchased and used exclusively by a commercial enterprise (businesses for profit), which would cover most creator purchases." },
    gaps: ["Statewide sales tax rate not read; evidence is that sales tax applies as for physical-presence retailers.", "Exemption rules for SaaS and digital products bought by businesses are mentioned but administrative rules were noted as 'being finalized' on the page; not verified further."],
  },
  {
    state: "KS",
    stateSalesTax: { known: true, value: true, source: { url: "https://ksrevenue.gov/taxnotices/notice21-14.pdf", quote: "A marketplace facilitator located in Kansas will register for, collect, and remit Kansas retailers’ sales tax." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://ksrevenue.gov/taxmarketplace.html", quote: "K.S.A 79-5601 et seq. Marketplace Facilitators" }, note: "K.S.A. 79-5601 et seq. (Senate Bill 50, 2021, New Sections 1-4); Notice 21-14 (Nov. 1, 2021)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "current or immediately preceding calendar year", counts: "cumulative gross receipts of taxable sales (exempt sales not counted) sourced to Kansas; for facilitators includes its own sales plus facilitated sales; first-year facilitator collects only on sales above $100,000" }, source: { url: "https://ksrevenue.gov/taxnotices/notice21-14.pdf", quote: "A marketplace facilitator shall only be required to collect and remit such taxes if the following criteria are satisfied during the current or immediately preceding calendar year:" } },
    digitalProducts: { known: true, value: "no", source: { url: "https://ksrevenue.gov/pdf/edu71r.pdf", quote: "Kansas generally does not tax electronic downloads of digital products." }, note: "Policy guideline EDU-71R dated July 23, 2010; examples: movies, music, photographs, newspapers. Prewritten computer software is taxable even when delivered electronically (same document and Pub 1510). Document is old; whether later law changed this was not confirmed." },
    saas: { known: true, value: "no", source: { url: "https://ksrevenue.gov/pdf/edu71r.pdf", quote: "Charges by an ASP for its services are not subject to sales tax." }, note: "2010 guideline (EDU-71R): remote access to someone else's software is not a lease; prewritten software delivered to the customer is taxable. Age of source: confirm no later change." },
    gaps: ["Digital/SaaS answers rest on EDU-71R (July 23, 2010); no newer official statement found, so treat as lower confidence.", "Statewide rate not read; has_state_sales_tax evidence is the notice's reference to Kansas retailers' sales tax.", "The ksrevenue.gov quotes from Notice 21-14/21-17 are re-flowed from PDF text."],
  },
  {
    state: "KY",
    stateSalesTax: { known: true, value: true, source: { url: "https://taxanswers.ky.gov/Sales-and-Excise-Taxes/Pages/Do-I-Need-to-Register-for-a-Sales-and-Use-Tax-Account.aspx", quote: "businesses that provide the services listed in the chart below are required to collect the 6% sales tax from their customers for providing these services." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://taxanswers.ky.gov/Sales-and-Excise-Taxes/Pages/Remote-Retailers-Marketplace-Providers-FAQs.aspx", quote: "HB 354 requires marketplace providers with $100,000 in gross receipts or 200 or more separate transactions sourced to this state in the previous or current year to register for a Kentucky sales and use tax account" }, note: "KRS 139.010(24) (marketplace provider); KRS 139.450; HB 354 (2019)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "previous or current calendar year", counts: "gross receipts sourced to Kentucky; marketplace provider counts its own sales or its sales in combination with sales it facilitates (KRS 139.450)" }, source: { url: "https://taxanswers.ky.gov/Sales-and-Excise-Taxes/Pages/Remote-Retailers-Marketplace-Providers-FAQs.aspx", quote: "Effective August 1, 2026, the Legislature repealed the “200 or more transactions” provision. After this date, only marketplace providers that surpass the “$100,000 in gross receipts” threshold have economic nexus in Kentucky" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Kentucky digital property and SaaS taxability not confirmed: revenue.ky.gov (newsletters, Sales-Use-Tax pages) is not on the allowlist.", "The August 1, 2026 repeal of the 200-transaction test is stated by the DOR FAQ page; statute not read."],
  },
  {
    state: "LA",
    stateSalesTax: { known: true, value: true, source: { url: "https://remotesellers.louisiana.gov/Announcement", quote: "beginning on January 1, 2025, the Louisiana state sales tax rate is 5%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://remotesellers.louisiana.gov/Documents/RSIB%2020-003%20Act%20216%20Collection%20Requirements%20Marketplace%20Facilitators%206.18.20.pdf", quote: "Act 216 requires Marketplace Facilitators to register with the Commission and collect and remit state and local sales and use tax on all taxable remote sales for delivery into Louisiana" }, note: "Act 216 of the 2020 Regular Session (RSIB 20-003, June 18, 2020)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "prior or current calendar year", counts: "all remote sales, including exempt sales, for delivery into Louisiana; facilitator counts own sales and those facilitated" }, source: { url: "https://remotesellers.louisiana.gov/Announcement", quote: "remote sellers who meet the threshold for economic nexus ($100,000 annual sales or 200 transactions annually delivered in Louisiana) have 30 days to apply for registration" } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://remotesellers.louisiana.gov/Announcement", quote: "Act 10 of the 2024 Third Extraordinary Session provides for the taxability for state and local sales tax of digital products and services, defines digital products and states the exemptions which apply." }, note: "Effective for tax periods on or after January 1, 2025. The definition and the specific exemptions are not listed on the page, so which products (e-books, courses, subscriptions) are covered is not confirmed." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Act 10 (2024 Third Extraordinary Session) text and Louisiana Revenue Information Bulletin 25-007 not retrievable on an allowed host, so the digital-product definition and SaaS status are unconfirmed.", "Threshold wording in RSIB 20-003 ('fewer than 200 sales or less than $100,000') is an exception-form sentence, read as 200 transactions OR $100,000 consistent with the Announcement page; the 2020 bulletin may not reflect later law changes.", "Local (parish) sales taxes also apply but were not analysed."],
  },
  {
    state: "ME",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/Business%20Guide%20for%20December%202025%20FINAL.pdf", quote: "A sales tax is imposed at the rate of 5.5% of the sale price on retail sales, leases, or rentals of tangible personal property; products transferred electronically" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/IB43_FINAL_Registration_of_Sellers_2024_08_19.pdf", quote: "A marketplace facilitator is required to register with MRS as a retailer for the purposes of collecting and remitting the sales tax on all sales of tangible personal property or taxable services made through the marketplace in Maine" }, note: "36 M.R.S. § 1951-C(1) (per MRS Instructional Bulletin 43, Aug. 19, 2024)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "previous calendar year or current calendar year", counts: "facilitator: gross sales of tangible personal property or taxable services into Maine, including sales facilitated for marketplace sellers and its own direct sales; remote seller: total gross sales of TPP or taxable services" }, source: { url: "https://www.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/IB43_FINAL_Registration_of_Sellers_2024_08_19.pdf", quote: "if the marketplace facilitator’s gross sales from delivery of tangible personal property or taxable services into Maine in the previous calendar year or current calendar year exceeds $100,000." } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://www.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/Guidanceforpublications09242013.pdf", quote: "The sale of a digital copy of a publication is taxable provided the publication is downloadable to the subscriber’s electronic device." }, note: "Maine taxes 'products transferred electronically' (Business Guide, Dec 2025) and, from Jan 1, 2026, digital audiovisual and digital audio services. Online-view-only publications without download are exempt (2013 guidance). Definition of 'products transferred electronically' not read; recorded courses not addressed." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Maine SaaS taxability not found; the definition of 'products transferred electronically' (36 M.R.S. § 1752) not read.", "Whether the 200-transaction test (2018 guidance) was formally repealed is inferred from IB 43 (2024) showing only $100,000; confirm.", "Publications guidance is dated 2013."],
  },
  {
    state: "MD",
    stateSalesTax: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: false, gap: "no threshold confirmed on an official page read on 2026-11-20" },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Official content for Maryland sales tax is on services.marylandcomptroller.gov (blocked by the proxy: 'no rule or network setting allows this host'); www.marylandcomptroller.gov pages read (/, /businesses.html, /businesses/tax-services.html, /legal-library.html) are navigation only with no sales tax, facilitator, threshold or digital-products text. marylandtaxes.gov did not connect (HTTP 000). Nothing confirmed, including the 2025 digital products change."],
  },
  {
    state: "MA",
    stateSalesTax: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: false, gap: "no threshold confirmed on an official page read on 2026-11-20" },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["www.mass.gov returned HTTP 403 'This page is forbidden' for every URL tried (home, DOR org page, remote seller/marketplace pages, TIR, 830 CMR 64H.1.6, digital products, doc download). Nothing confirmed."],
  },
  {
    state: "MI",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.michigan.gov/taxes/business-taxes/sales-use-tax", quote: "Individuals or businesses that sell tangible personal property to the final consumer are required to remit a 6% sales tax on the total price of their taxable retail sales to the State of Michigan." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.michigan.gov/taxes/business-taxes/sales-use-tax/information/marketplace-facilitator-seller-faqs", quote: "The marketplace facilitator with nexus with Michigan is statutorily treated as the person engaged in the business of making retail sales for purposes of the General Sales Tax Act or Use Tax Act" }, note: "Page refers to the 'General Sales Tax Act or Use Tax Act' without section numbers; no MCL section read" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Previous calendar year; obligation begins the following tax year", counts: "Gross sales (taxable, non-taxable, exempt) and transactions; a facilitator counts its own direct sales plus sales it facilitates for marketplace sellers" }, source: { url: "https://www.michigan.gov/taxes/business-taxes/sales-use-tax/information/marketplace-facilitator-seller-faqs", quote: "in the previous calendar year, it has over $100,000 in sales (both taxable and non-taxable), or more than 200 transactions (both taxable and non-taxable) to purchasers located in Michigan." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products and SaaS taxability not found on michigan.gov pages read (general-faq, exemptions-faq, filing-requirements-faq, internet-purchases-faq had no digital/SaaS text).", "No MCL section citation shown on the pages read."],
  },
  {
    state: "MN",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.revenue.state.mn.us/sales-tax-marketplace-providers", quote: "must collect and remit Minnesota state and local sales tax" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.revenue.state.mn.us/sales-tax-marketplace-providers", quote: "an out-of-state marketplace provider must collect and remit Minnesota state and local sales tax if their total sales (including facilitated sales) over the prior 12-month period total either:" }, note: "Minnesota Statute 297A.66 and 297A.77 (listed on the page; the state calls facilitators 'marketplace providers')" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Prior 12-month period", counts: "Retail sales shipped to Minnesota; for providers, all marketplace provider sales and facilitated sales; resale sales excluded" }, source: { url: "https://www.revenue.state.mn.us/sales-tax-marketplace-providers", quote: "200 or more retail sales shipped to Minnesota; More than $100,000 in retail sales shipped to Minnesota; When calculating the threshold, include all marketplace provider sales and facilitated sales." } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://www.revenue.state.mn.us/digital-products", quote: "Specified digital products, other digital products, and digital codes are taxable, including: Digital audio works ... Digital audiovisual works ... Digital books or e-books" }, note: "Taxable: specified digital audio, audiovisual works (live or prerecorded), e-books, e-greeting cards, online games. Not taxable: digital items not on those lists (news articles, PDF charts, digital photos). Live or pre-recorded webinars taxable unless interactive requirements are met; online classes at post-secondary schools not taxable. Periodicals, magazines, newspapers, blogs excluded from e-books. Bundles taxable unless taxable part is 10% or less." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["SaaS (remotely accessed, nothing downloaded) not explicitly addressed on pages read; no separate Minnesota SaaS page found.", "Statewide rate not quoted."],
  },
  {
    state: "MS",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.dor.ms.gov/business/business-tax-frequently-asked-questions", quote: "Yes, Mississippi imposes a tax on the sale of tangible personal property and various services. The general tax rate is 7%" } },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: true, value: { salesUsd: 250000, transactions: null, joiner: null, period: "Any twelve month period", counts: "Sales into the state by out-of-state businesses; page does not say gross vs taxable or whether facilitated sales count" }, source: { url: "https://www.dor.ms.gov/business/business-tax-frequently-asked-questions", quote: "businesses located out of the state that have sales into the state of Mississippi that exceed $250,000 over any twelve month period are considered to have substantial economic presence in the state and are required to register" } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://www.dor.ms.gov/business/business-tax-frequently-asked-questions", quote: "Tangible personal property includes electricity, water, gas, steam, pre-written software, and digital and electronic goods." }, note: "Digital and electronic goods are tangible personal property." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["No marketplace facilitator text on dor.ms.gov pages read (FAQ, mississippi-sales-and-use-taxes, use-tax, register-taxes, reporting-requirements, sales-tax-exemptions); guessed facilitator/remote-seller URLs returned 404.", "Threshold: only the seller's-use-tax $250,000 statement found; no transaction count; unclear whether it applies identically to facilitators."],
  },
  {
    state: "MO",
    stateSalesTax: { known: true, value: true, source: { url: "https://dor.mo.gov/taxation/business/tax-types/sales-use/", quote: "The state’s sales tax is imposed on the purchase price of tangible personal property or taxable service sold at retail." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://dor.mo.gov/faq/taxation/business/remote-seller-and-marketplace-facilitator.html", quote: "Any remote seller or marketplace facilitator that sells tangible personal property into Missouri must collect and remit vendor’s use tax on the retail sale" }, note: "Section 144.752, RSMo (page cites it for vendor's use tax returns); Chapter 144 RSMo" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Calendar year per the headline answer; the detailed answer tests each calendar quarter-end over the preceding 12-month period", counts: "Gross receipts from taxable sales of tangible personal property shipped into Missouri, including sales through a marketplace facilitator" }, source: { url: "https://dor.mo.gov/faq/taxation/business/remote-seller-and-marketplace-facilitator.html", quote: "if their gross receipts from taxable sales in Missouri exceed $100,000 in a calendar year." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["The Missouri marketplace/remote rule on the page is expressly for tangible personal property; whether it reaches digital goods or services is not stated.", "No digital products or SaaS guidance found on dor.mo.gov (search is JavaScript); revisor.mo.gov not allowed."],
  },
  {
    state: "MT",
    stateSalesTax: { known: true, value: false, source: { url: "https://revenue.mt.gov/taxes/general-sales-tax", quote: "Montana does not have a general-use sales tax." } },
    marketplaceFacilitator: { known: true, value: false, source: { url: "https://revenue.mt.gov/taxes/general-sales-tax", quote: "The Wayfair decision does not affect Montanans purchasing goods or services online because Montana does not have a general sales tax." } },
    threshold: { known: true, value: "no-state-sales-tax", source: { url: "https://revenue.mt.gov/taxes/general-sales-tax", quote: "Montana does not have a general-use sales tax." } },
    digitalProducts: { known: true, value: "no", source: { url: "https://revenue.mt.gov/taxes/general-sales-tax", quote: "Montana does not have a general-use sales tax." }, note: "No general sales tax. Local resort tax exists (separate tax; page says it is a sales tax on certain sales in resort areas)." },
    saas: { known: true, value: "no", source: { url: "https://revenue.mt.gov/taxes/general-sales-tax", quote: "Montana does not have a general-use sales tax." }, note: "No general sales tax." },
    gaps: ["marketplace_facilitator=false is inferred from the absence of a general sales tax; no page states facilitator rules. Local resort tax (revenue.mt.gov/taxes/miscellaneous/local-resort-tax) was not checked for marketplace rules."],
  },
  {
    state: "NE",
    stateSalesTax: { known: true, value: true, source: { url: "https://revenue.nebraska.gov/businesses/nebraska-sales-and-use-tax", quote: "The Nebraska state sales and use tax rate is 5.5% (.055)." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://revenue.nebraska.gov/about/frequently-asked-questions/remote-seller-and-marketplace-facilitator-faqs", quote: "MMPs, also known as marketplace facilitators, who have met the thresholds described above are required to obtain a sales tax permit, collect, report, and remit Nebraska and local sales tax on sales delivered or sourced to Nebraska addresses." }, note: "LB 284 (2019), Remote Seller and Marketplace Facilitator Act (statute section not shown on pages read; the state calls facilitators 'Multivendor Marketplace Platforms (MMP)')" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Prior calendar year or current calendar year", counts: "Total Nebraska retail sales (all sales other than resale, sublease or subrent), including sales through an MMP; and Nebraska sales transactions including MMP sales" }, source: { url: "https://revenue.nebraska.gov/about/frequently-asked-questions/remote-seller-and-marketplace-facilitator-faqs", quote: "more than $100,000 in Nebraska retail sales, including sales through a Multivendor Marketplace Platform (MMP), in the prior calendar year or current calendar year, or who made 200 or more Nebraska sales transactions" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products and SaaS taxability not found on revenue.nebraska.gov pages read (taxable services FAQ, exemptions guide, info-guide index).", "Remote seller notice (07/11/2019) words the test 'exceeded $100,000 in the previous...' and the FAQ says 'prior calendar year or current calendar year'; the FAQ is the later, fuller statement."],
  },
  {
    state: "NV",
    stateSalesTax: { known: false, gap: "the official page cited no longer holds the sentence (it redirects); not confirmed" },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.nv.gov/faqs/marketplace-facilitator-seller-faqs/", quote: "Marketplace Facilitators, Marketplace Sellers, or Remote Sellers must collect and submit Sales Tax on all their Nevada sales." }, note: "NRS 372.748 (definition); NRS 372.749 (marketplace seller)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Previous or current calendar year; effective October 1, 2019", counts: "All sales in Nevada, directly to customers and through online marketplaces, added together" }, source: { url: "https://tax.nv.gov/faqs/marketplace-facilitator-seller-faqs/", quote: "if total sales exceed $100,000 or if there are more than 200 separate transactions in Nevada during the previous or current calendar year" } },
    digitalProducts: { known: false, gap: "the official page cited no longer holds the sentence (it redirects); not confirmed" },
    saas: { known: false, gap: "the official page cited no longer holds the sentence (it redirects); not confirmed" },
    gaps: ["Digital products and SaaS not addressed explicitly on tax.nv.gov pages read; the TPP-only statement suggests not taxable but is not a quote on digital goods.", "Facilitator FAQ describes marketplaces in terms of tangible personal property."],
  },
  {
    state: "NH",
    stateSalesTax: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: false, gap: "no threshold confirmed on an official page read on 2026-11-20" },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["www.revenue.nh.gov returned HTTP 403 'Access Denied' for every URL tried through the helper (home, /faq, /taxes-glance). Not retried with other client identities. Nothing confirmed, including that NH has no general sales tax."],
  },
  {
    state: "NJ",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.nj.gov/treasury/taxation/businesses/salestax/index.shtml", quote: "New Jersey assesses a 6.625% Sales Tax on sales of most tangible personal property, specified digital products, and certain services unless specifically exempt under New Jersey law." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.nj.gov/treasury/taxation/pdf/pubs/sales/tb83.pdf", quote: "A marketplace facilitator is required to collect Sales Tax on sales of tangible personal property, specified digital products, and services delivered into New Jersey, which are made by a marketplace seller" }, note: "P.L. 2018, c. 132 (as TB-83, issued October 25, 2018, states)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "current or prior calendar year", counts: "Remote seller's gross revenue from sales of tangible personal property, specified digital products, or taxable services delivered into NJ; OR 200 or more separate transactions. Marketplace sales are collected by the facilitator regardless of whether the marketplace seller is above or below either threshold." }, source: { url: "https://www.nj.gov/treasury/taxation/remotesellers.shtml", quote: "The remote seller's gross revenue from sales of tangible personal property, specified digital products, or taxable services delivered into New Jersey during the current or prior calendar year, exceeds $100,000; or" } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://www.nj.gov/treasury/taxation/businesses/salestax/index.shtml", quote: "New Jersey assesses a 6.625% Sales Tax on sales of most tangible personal property, specified digital products, and certain services unless specifically exempt under New Jersey law." }, note: "Specified digital products are taxable, but the definition (whether e-books, recorded courses, content subscriptions are included) was not found on a page I could read. Prewritten software delivered electronically is taxable (TB-72)." },
    saas: { known: true, value: "partly", source: { url: "https://www.nj.gov/treasury/taxation/pdf/pubs/tb/tb72.pdf", quote: "Use of a software application is not listed as a taxable service. Therefore, most charges for SaaS are not subject to Sales Tax. However, SaaS which meets the definition of an information service is subject to Sales Tax." }, note: "TB-72 (July 3, 2013). Downloaded/electronically delivered software is taxable (TB-51R); business-use exemption may apply." },
    gaps: ["Definition of specified digital product not located on an official page read.", "No separate facilitator threshold located; TB-83 is dated 2018."],
  },
  {
    state: "NM",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.tax.newmexico.gov/businesses/gross-receipts-overview/", quote: "Gross receipts tax (GRT) is imposed on businesses, but it is common for a business to pass the GRT on to the purchaser." } },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "previous calendar year", counts: "Taxable gross receipts from sales, leases, and licenses of tangible personal property, sales of licenses and sales of services and licenses for use of real property sourced to this state (page's wording: 'tangle personal property'); receipts eligible for exemption or deduction are excluded." }, source: { url: "https://www.tax.newmexico.gov/businesses/determining-nexus/", quote: "For someone who lacks physical presence, engaging in business means having in the previous calendar year total taxable gross receipts of at least one hundred thousand dollars ($100,000)" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["FYI-206 and FYI-105 are hosted at realfile.tax.newmexico.gov, not reachable.", "Taxability of digital products and SaaS not confirmed.", "Marketplace provider collection duty not confirmed (only GRT liability above threshold)."],
  },
  {
    state: "NY",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/do_i_need_to_register_for_sales_tax.htm", quote: "Sales of tangible personal property are subject to New York sales tax unless they are specifically exempt." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/do_i_need_to_register_for_sales_tax.htm", quote: "If you are a marketplace provider located in New York State, you are required to register for sales tax and collect tax on taxable sales of tangible personal property that you facilitate for marketplace sellers." }, note: "TSB-M-19(2.1)S, Sales Tax Collection Requirement for Marketplace Providers (as named on the page)" },
    threshold: { known: true, value: { salesUsd: 500000, transactions: 100, joiner: "and", period: "previous four sales tax quarters", counts: "Cumulative gross receipts from sales made or facilitated of tangible personal property delivered into the state, and more than 100 sales made or facilitated." }, source: { url: "https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/do_i_need_to_register_for_sales_tax.htm", quote: "in the previous four sales tax quarters, your cumulative total of gross receipts from sales made or facilitated of tangible personal property delivered into the state exceeded $500,000, and you made or facilitated more than 100 sales" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: true, value: "yes", source: { url: "https://www.tax.ny.gov/pubs_and_bulls/tg_bulletins/st/computer_software.htm", quote: "the sale to a purchaser in New York of a license to remotely access software is subject to state and local sales tax." }, note: "TB-ST-128 (page text: 'Prewritten computer software is taxable ... whether sold ... by remote access')." },
    gaps: ["Digital products (non-software) taxability not found; marketplace page TSB-M-19(2.1)S not read directly (only the registration bulletin summarizing it)."],
  },
  {
    state: "NC",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.ncdor.gov/taxes-forms/sales-and-use-tax/taxable-items", quote: "North Carolina imposes sales and use tax on the sales price of, or gross receipts derived from, taxable sales of the following:" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.ncdor.gov/taxes-forms/sales-and-use-tax/marketplace-facilitators-and-marketplace-sellers", quote: "A marketplace facilitator that is engaged in business in North Carolina is considered the retailer of each marketplace-facilitated sale it makes on behalf of a marketplace seller and must collect and remit the sales and use tax on all such sales." }, note: "G.S. 105-164.4J (as cited on the NCDOR FAQ page)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "previous or current calendar year", counts: "Gross sales sourced to North Carolina, including sales as a marketplace seller and marketplace-facilitated sales." }, source: { url: "https://www.ncdor.gov/taxes-forms/sales-and-use-tax/other-sales-and-use-tax-resources/remote-sales", quote: "A remote seller must register and collect sales and use tax when it is engaged in business in the state. This includes when the remote seller has gross sales in excess of one hundred thousand dollars ($100,000) sourced to North Carolina in the previous or current calendar year" } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://www.ncdor.gov/taxes-forms/sales-and-use-tax/taxable-items/certain-digital-property", quote: "Certain digital property includes the items listed below if transferred electronically: A digital audio work. A digital audiovisual work. A digital book." }, note: "Taxable: digital audio/audiovisual works, digital books, magazines/newsletters/reports/other publications, photographs, greeting cards. The page says certain digital property 'does not include an information service or an educational service', so recorded courses may fall outside; not confirmed." },
    saas: { known: true, value: "no", source: { url: "https://www.ncdor.gov/documents/files/suplr-2018-0005-saas-cloud-based-software-access/open", quote: "North Carolina does not currently impose sales and use tax on revenue from access to cloud based software accessed electronically via an internet connection." }, note: "Source is Private Letter Ruling SUPLR 2018-0005 dated January 24, 2018, binding only on that taxpayer; no general NCDOR page on SaaS found. Prewritten software (downloaded) is taxable TPP." },
    gaps: ["SaaS answer rests on a 2018 private letter ruling, not a general page.", "Whether recorded online courses are an 'educational service' (excluded) not confirmed."],
  },
  {
    state: "ND",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.tax.nd.gov/sales-and-use-tax", quote: "North Dakota imposes a sales tax on retail sales. The sales tax is paid by the purchaser and collected by the seller." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.tax.nd.gov/marketplace-facilitator", quote: "A marketplace facilitator is required to collect North Dakota sales and use taxes, as well as local taxes, on North Dakota sales made on its marketplace." }, note: "Not cited on the page" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "current or prior calendar year", counts: "All taxable sales through the marketplace, on behalf of all sellers and its own behalf." }, source: { url: "https://www.tax.nd.gov/marketplace-facilitator", quote: "Marketplace facilitators without physical nexus in North Dakota must have taxable sales exceeding $100,000 in the current or prior calendar year before they are required to collect and remit sales and use tax." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Statute citation not on the pages read.", "Digital products and SaaS not confirmed."],
  },
  {
    state: "OH",
    stateSalesTax: { known: true, value: true, source: { url: "https://tax.ohio.gov/business/sales-and-use-tax", quote: "The Ohio Sales Tax applies to the retail sale, lease, and rental of tangible personal property." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.ohio.gov/business/sales-and-use-tax/sales-and-use-tax", quote: "any company that helps other people sell things online—called a marketplace facilitator—and meets substantial nexus in Ohio must follow the same tax rules as regular sellers." }, note: "Am. Sub. H.B. 166 (as named on the page); effective September 1, 2019" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "current or previous year", counts: "Total sales to Ohio customers; or number of separate sales to Ohio customers." }, source: { url: "https://tax.ohio.gov/business/sales-and-use-tax/sales-and-use-tax", quote: "Your total sales to Ohio customers were over $100,000 in the current or previous year, OR" } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://tax.ohio.gov/business/sales-and-use-tax/taxability", quote: "Downloadable Content (e-books, music, and movies)" }, note: "Listed under 'Taxable Items'; page also lists streaming services as taxable. Recorded online courses not addressed." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["SaaS not confirmed; ST 2003-06 information release not readable (No content found).", "The 2019 nexus alert PDF is hosted off-allowlist."],
  },
  {
    state: "OK",
    stateSalesTax: { known: true, value: true, source: { url: "https://oklahoma.gov/tax/businesses/sales-use-tax.html", quote: "Under Oklahoma law, sales tax must be charged and collected on all transfers of title or possession of tangible personal property that occur within the state." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://oklahoma.gov/tax/helpcenter/businesses.html", quote: "A marketplace facilitator that had aggregate sales of products in Oklahoma or delivered to locations in Oklahoma subject to sales or use tax worth at least $10,000 during the immediately preceding 12 month period must file an election with the OTC to either collect and remit the tax or to comply with certain notice and reporting requirements." }, note: "68 O.S. Section 1393" },
    threshold: { known: true, value: { salesUsd: 10000, transactions: null, joiner: null, period: "the immediately preceding 12 months", counts: "a facilitator's aggregate sales into Oklahoma subject to sales or use tax (a remote seller's own threshold is $100,000)" }, source: { url: "https://oklahoma.gov/tax/helpcenter/businesses.html", quote: "A marketplace facilitator that had aggregate sales of products in Oklahoma or delivered to locations in Oklahoma subject to sales or use tax worth at least $10,000 during the immediately preceding 12 month period must file an election with the OTC to either collect and remit the tax or to comply with certain notice and reporting requirements." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products and SaaS not located on official pages.", "Page says 'at least $10,000' in one place and 'more than $10,000' in another."],
  },
  {
    state: "OR",
    stateSalesTax: { known: true, value: false, source: { url: "https://www.oregon.gov/dor/programs/businesses/pages/sales-tax.aspx", quote: "Oregon doesn't have a general sales or use/transaction tax." } },
    marketplaceFacilitator: { known: true, value: false, source: { url: "https://www.oregon.gov/dor/programs/businesses/pages/sales-tax.aspx", quote: "Oregon doesn't have a general sales or use/transaction tax." } },
    threshold: { known: true, value: "no-state-sales-tax", source: { url: "https://www.oregon.gov/dor/programs/businesses/pages/sales-tax.aspx", quote: "Oregon doesn't have a general sales or use/transaction tax." } },
    digitalProducts: { known: true, value: "no", source: { url: "https://www.oregon.gov/dor/programs/businesses/pages/sales-tax.aspx", quote: "Oregon doesn't have a general sales or use/transaction tax." } },
    saas: { known: true, value: "no", source: { url: "https://www.oregon.gov/dor/programs/businesses/pages/sales-tax.aspx", quote: "Oregon doesn't have a general sales or use/transaction tax." } },
    gaps: [],
  },
  {
    state: "PA",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/sales-use-and-hotel-occupancy-tax", quote: "The Pennsylvania sales tax rate is 6 percent." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/sales-use-and-hotel-occupancy-tax/online-retailers", quote: "All marketplace facilitators and online sellers who maintain a place of business by having economic presence (i.e. Pennsylvania annual gross sales of greater than $100,000) must now register, collect and remit Pennsylvania sales tax starting July 1, 2019." }, note: "Act 13 of 2019; Sales and Use Tax Bulletin 2019-01" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "calendar year", counts: "Gross amount on all channels, taxable and nontaxable. A marketplace facilitator with no physical presence uses both facilitated and direct sales." }, source: { url: "https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/sales-use-and-hotel-occupancy-tax/online-retailers", quote: "Economic presence in Pennsylvania is measured by sales threshold only. There is no transactional count requirement." } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/sales-use-and-hotel-occupancy-tax/digital-products", quote: "Digital products include any product transferred electronically to a customer by download, streaming, or through other electronic means." }, note: "Page examples: video, music, books, apps, games, and canned software; e-books and subscriptions are listed as taxable. Recorded courses not specifically addressed." },
    saas: { known: true, value: "yes", source: { url: "https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/sales-use-and-hotel-occupancy-tax/canned-computer-software-digital-goods", quote: "A license to use tangible personal property, including canned software, is subject to tax. The transaction remains taxable regardless of whether the tangible personal property is digitally delivered, streamed, or accessed by other means." }, note: "Page names canned software 'accessed through a software-as-a-service agreement (SaaS)'. Taxation of non-canned (custom) SaaS not discussed." },
    gaps: [],
  },
  {
    state: "RI",
    stateSalesTax: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: false, gap: "no threshold confirmed on an official page read on 2026-11-20" },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["tax.ri.gov returned HTTP 403 'Enable JavaScript and cookies to continue' (browser challenge) on every page; not circumvented. All answers unknown."],
  },
  {
    state: "SC",
    stateSalesTax: { known: true, value: true, source: { url: "https://dor.sc.gov/sales-use-tax-index/sales-tax", quote: "Tax rate is 6%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://dor.sc.gov/sites/dor/files/Documents/Policy%20Manuals/Chapter%2013%20-%20Nexus.pdf", quote: "the marketplace facilitator must report and remit the sales and use tax on the marketplace facilitator’s “gross proceeds of sales,”" }, note: "S.C. Code Section 12-36-71 (defines 'marketplace facilitator') and 12-36-70, as cited on the page; also SC Revenue Ruling #19-6 (cited, not read). Definition on the page is limited to facilitating retail sales of tangible personal property, which the same chapter says includes taxable services and intangibles." },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Previous or current calendar year", counts: "Gross revenue from sales of tangible personal property, products transferred electronically, and services delivered into SC, whether or not the sale is taxable (per Revenue Ruling 18-14 / Ch.13 of the manual: gross revenue includes exempt and non-taxable sales, and revenue from sales via a marketplace counts toward the remote seller's own threshold). No transaction-count test stated." }, source: { url: "https://dor.sc.gov/sales-use-tax-index/sales-tax/remote-sellers", quote: "A seller whose gross revenue exceeds $100,000, in the previous or current calendar year, from sales of:" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: true, value: "yes", source: { url: "https://dor.sc.gov/sites/dor/files/Documents/Policy%20Manuals/Chapter%2013%20-%20Nexus.pdf", quote: "Because software sold on disks and flash drives and via an ASP (SaaS) are subject to the South Carolina sales and use tax," }, note: "Stated in an example in the SC Sales & Use Tax Manual Ch.13 (September 2025 edition), for software; the example also treats downloaded software as not taxable." },
    gaps: ["No dedicated DOR marketplace-facilitator page found (guessed URLs 404); relied on Manual Ch.13 and RR 18-14. RR 19-6 (facilitator guidance) cited but not read.", "Taxability of e-books, downloadable files, recorded courses and content subscriptions not found on any page read.", "Whether the facilitator test counts only retail sales of tangible personal property (incl. taxable services) was not tested against statute text."],
  },
  {
    state: "SD",
    stateSalesTax: { known: true, value: true, source: { url: "https://dor.sd.gov/businesses/taxes/sales-use-tax/", quote: "The state sales and use tax rate is 4.2%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://dor.sd.gov/businesses/taxes/sales-use-tax/", quote: "Marketplace providers who meet a certain threshold must obtain a South Dakota sales tax license and pay applicable sales tax (Per SDCL 10-65)." }, note: "SDCL 10-65 (as stated on page); SDCL 10-65-7 referenced in the Marketplace Provider bulletin" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Previous or current calendar year", counts: "Gross revenue from sales into SD; 'Gross sales or transactions include the sale of tangible personal property, any products transferred electronically, or services.' Page says remote seller threshold: 'Your business's gross revenue from sales into South Dakota exceeded $100,000'." }, source: { url: "https://dor.sd.gov/businesses/taxes/sales-use-tax/", quote: "The marketplace provider facilitates the sales of two or more marketplace sellers that, when the sales are combined, meets the remote seller criteria." } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://dor.sd.gov/businesses/taxes/sales-use-tax/", quote: "The sales tax applies to the gross receipts of all retail sales, including the sale, lease, or rental of tangible personal property or any product transferred electronically, and the sale of services." }, note: "The 'Products Transferred Electronically' tax fact lists 'music, books, videos, movies, newspapers, custom computer software, photos, clip art' as examples (https://dor.sd.gov/media/argitevb/products-transferred-electronically.pdf). Exemptions not examined." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["SaaS taxability not stated explicitly on any page read.", "Exemptions to the product-transferred-electronically rule not examined."],
  },
  {
    state: "TN",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.tn.gov/revenue/taxes/sales-and-use-tax.html", quote: "The general state tax rate is 7%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.tn.gov/revenue/taxes/sales-and-use-tax/out-of-state-dealers-marketplace-facilitators.html", quote: "marketplace facilitators that make or facilitate more than $100,000 in sales to Tennessee customers in the previous 12-month period are required to collect and remit Tennessee sales tax." }, note: "Tenn. Code Ann. § 67-6-901 – 902 (as cited in Important Notice 20-15, https://www.tn.gov/content/dam/tn/revenue/documents/notices/sales/sales20-15.pdf); Public Chapter 759 (2020)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Previous 12-month period", counts: "Facilitator: total sales to consumers in TN, made or facilitated (own and third-party). Page says 'more than $100,000' (dealer page) and notice says '$100,000 or more'; the two pages differ on more-than vs or-more. Remote seller (marketplace seller) test: $100,000 or more in sales in the state." }, source: { url: "https://www.tn.gov/revenue/taxes/sales-and-use-tax/out-of-state-dealers-marketplace-facilitators.html", quote: "Marketplace facilitators that do not have at least $100,000 in total sales in this state do not have a collection responsibility." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products and SaaS taxability not found on any tn.gov page read (notice index and sales tax pages searched for digital/software terms).", "Notice 20-15 (a PDF) is a notice, not the statute; statute pages not on allowed host."],
  },
  {
    state: "TX",
    stateSalesTax: { known: true, value: true, source: { url: "https://comptroller.texas.gov/taxes/sales/", quote: "Texas imposes a 6.25 percent state sales and use tax on all retail sales, leases and rentals of most goods, as well as taxable services." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://comptroller.texas.gov/taxes/sales/marketplace-providers-sellers.php", quote: "Marketplace providers engaged in business in Texas must collect, report and remit state and local sales and use tax on all sales made through a marketplace." }, note: "Sec. 151.0242, Marketplace Providers and Marketplace Sellers (listed as a reference on the page; statute text not read)" },
    threshold: { known: true, value: { salesUsd: 500000, transactions: null, joiner: null, period: "Preceding twelve calendar months (safe harbor: less than $500,000)", counts: "Total Texas revenue: gross revenue from taxable and nontaxable sales of tangible personal property and services into Texas, including separately stated handling, transportation, installation and similar fees, and sales for resale and to exempt entities." }, source: { url: "https://comptroller.texas.gov/taxes/sales/remote-sellers.php", quote: "Remote sellers with total Texas revenue of less than $500,000 in the preceding twelve calendar months are not required to obtain a tax permit or collect, report and remit state and local use tax." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products taxability not found.", "SaaS classification (data processing / information service) not stated for SaaS specifically.", "Marketplace provider dollar threshold not stated on pages read.", "Publication 94-108 (Engaged in Business) not read."],
  },
  {
    state: "UT",
    stateSalesTax: { known: true, value: true, source: { url: "https://tax.utah.gov/business/sales-tax/sales/rates/", quote: "State Sales & Use Tax ST State Sales & Use Tax 59-12-103" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.utah.gov/business/sales-tax/sales-use-tax-faq/", quote: "Retailers and marketplace facilitators must collect and pay sales and use tax on their sales and on sales they facilitate on their marketplace if they meet any of the following criteria in Utah:" }, note: "No statute cited on the page; state sales tax code reference 59-12-103 appears on the rates page." },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Previous or current calendar year", counts: "Gross revenue from the sale of tangible personal property, any product transferred electronically, or services for storage, use, or consumption in Utah. The FAQ applies the same criterion to marketplace facilitators for 'sales they facilitate'." }, source: { url: "https://tax.utah.gov/business/sales-tax/other-sales-tax/out-of-state-remote-sellers/", quote: "Utah requires a remote seller to collect and pay Utah sales tax if, in either the previous or the current calendar year, the remote seller receives a gross revenue of more than $100,000" } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["tax.utah.gov returns 403 for many paths (pubs, bulletins, FAQ subpages); only a few pages readable.", "Digital products and SaaS taxability not found.", "No statute citation for marketplace facilitator on pages read."],
  },
  {
    state: "VT",
    stateSalesTax: { known: true, value: true, source: { url: "https://tax.vermont.gov/business/sales-and-use-tax", quote: "The sales tax rate is 6%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.vermont.gov/business-and-corp/sales-and-use-tax/marketplace", quote: "a marketplace facilitator is required to collect and remit sales tax when a seller uses its marketplace to conduct a retail sale." }, note: "No statute cited on the marketplace page; 32 V.S.A. § 9712 is cited only on the noncollecting-vendor page." },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Any preceding twelve-month period (per Act 134 of 2016)", counts: "Sales (gross) into Vermont; page does not say gross vs taxable. Marketplace page says facilitator must collect from June 1, 2019 when a seller uses its marketplace." }, source: { url: "https://tax.vermont.gov/business/sales-and-use-tax", quote: "Out-of-state vendors making sales in Vermont must register and collect sales tax if they made sales of at least $100,000 or 200 individual transactions during any preceding twelve-month period" } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://tax.vermont.gov/business-and-corp/sales-and-use-tax/prewritten-computer-software", quote: "Digital audio works - Digital audio-video works - Digital books" }, note: "Page lists as taxable: digital audio works, digital audio-video works, digital books, prewritten software downloaded or accessed remotely. Nontaxable: custom software, development and technical support services, digital photographs. Recorded courses likely fall under digital audio-video works but the page does not say 'courses'; content subscriptions not addressed." },
    saas: { known: true, value: "yes", source: { url: "https://tax.vermont.gov/business-and-corp/sales-and-use-tax/prewritten-computer-software", quote: "Effective July 1, 2024, all sales of prewritten computer software are subject to sales and use tax, including software purchased on storage media, downloaded to a computer system, or accessed remotely via the internet." }, note: "Prewritten software accessed remotely is taxable from 2024-07-01; custom software is not (32 V.S.A. § 9701(7), Act 183 of 2024 cited on page)." },
    gaps: ["Marketplace page gives no facilitator-specific dollar threshold or statute citation.", "Taxability of content subscriptions and recorded courses not stated by name."],
  },
  {
    state: "VA",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.tax.virginia.gov/retail-sales-and-use-tax", quote: "Sales tax rates vary by the locality the sale was made in or where the merchandise was received" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.tax.virginia.gov/remote-sellers-marketplace-facilitators-economic-nexus", quote: "If you are a marketplace facilitator that sold or facilitated the sale of more than $100,000 in annual gross revenue or 200 or more transactions to Virginia customers in the previous or current calendar year, you must register to collect and pay Virginia sales tax." }, note: "No statute cited on the page (links to Va. Code Title 58.1 and Guidelines on townhall.virginia.gov, not read)." },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Previous or current calendar year (stated for facilitators and remote sellers)", counts: "Annual gross retail sales (page also says 'gross revenue from retail sales'); facilitators count sold or facilitated sales." }, source: { url: "https://www.tax.virginia.gov/remote-sellers-marketplace-facilitators-economic-nexus", quote: "A remote seller or marketplace facilitator has economic nexus if they sell or facilitate the sale of more than $100,000 in annual gross retail sales or 200 or more transactions to Virginia customers." } },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Digital products and SaaS taxability not found on pages read.", "Site search is JavaScript-driven and returned nothing.", "Statute / guidelines (townhall.virginia.gov, law.lis.virginia.gov) are not allowed hosts."],
  },
  {
    state: "WA",
    stateSalesTax: { known: true, value: true, source: { url: "https://dor.wa.gov/taxes-rates/retail-sales-tax", quote: "The state tax rate is 6.5%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://dor.wa.gov/taxes-rates/retail-sales-tax/marketplace-fairness-leveling-playing-field/marketplace-facilitators", quote: "Marketplace facilitators must collect and report sales tax on all retail sales sourced to Washington that are made through their marketplace." }, note: "RCW 82.08.0531; RCW 82.08.010; RCW 82.02.260; WAC 458-20-282 (listed on the page)" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Current or prior year (from the out-of-state thresholds page, https://dor.wa.gov/education/industry-guides/out-state-businesses-reporting-thresholds-and-nexus: 'in the current or prior year')", counts: "Combined gross receipts sourced or attributed to Washington (facilitator count includes sales made on behalf of marketplace sellers). Also registration if physical presence nexus." }, source: { url: "https://dor.wa.gov/taxes-rates/retail-sales-tax/marketplace-fairness-leveling-playing-field/marketplace-facilitators", quote: "Marketplace facilitators making retail sales to Washington consumers (including sales made on behalf of marketplace sellers) are required to register if they: - Have more than $100,000 in combined gross receipts sourced or attributed to Washington." } },
    digitalProducts: { known: true, value: "yes", source: { url: "https://dor.wa.gov/forms-publications/publications-subject/tax-topics/digital-products-including-digital-goods", quote: "Sales or use tax apply to all digital products, regardless of how they are accessed (downloaded, streamed, subscription service, networking, etc.)." }, note: "Subject to exclusions and exemptions listed on the page; the retail-sales-tax page says 'Many digital products are subject to sales tax'. The page also says some services newly became subject to retail sales tax effective Oct. 1, 2025." },
    saas: { known: true, value: "yes", source: { url: "https://dor.wa.gov/forms-publications/publications-subject/tax-topics/digital-products-including-digital-goods", quote: "The laws also cover remote access software (“RAS”) which is also subject to sales and use tax." }, note: "Remote access software and digital automated services are listed as subject to sales/use tax; mere storage/hosting is excluded from DAS (B&O tax instead). Exemptions exist on the page." },
    gaps: [],
  },
  {
    state: "WV",
    stateSalesTax: { known: true, value: true, source: { url: "https://tax.wv.gov/Business/SalesAndUseTax/Pages/SalesAndUseTax.aspx", quote: "at a rate of 6%." } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://tax.wv.gov/Documents/AdministrativeNotices/2019/AdministrativeNotice.2019-21.pdf", quote: "This bill requires marketplace facilitators having economic nexus with West Virginia to begin collecting and remitting West Virginia sales and use taxes on sales of goods and service they facilitate on and after July 1, 2019." }, note: "W. Va. Code § 11-15A-1(b)(8) (definition); § 11-15A-6b(e) (economic nexus) as cited in Administrative Notice 2019-21" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: 200, joiner: "or", period: "Immediately preceding calendar year or current calendar year", counts: "Gross revenue from West Virginia sales (marketplace facilitator, referrer, or retailer without physical presence). Alternative test: 200 or more separate transactions." }, source: { url: "https://tax.wv.gov/Documents/AdministrativeNotices/2019/AdministrativeNotice.2019-21.pdf", quote: "has gross revenue from West Virginia sales equal to or exceeding $100,000 for an immediately preceding calendar year, or a current calendar year;" } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://tax.wv.gov/Documents/TSD/tsd445.pdf", quote: "All sales of streaming services in West Virginia are subject to sales and use tax unless there is a specific exception or exemption outlined under West Virginia law." }, note: "Streaming services taxable (TSD 445). TSD 445 states it does not cover sales of digital products (downloads); no page read states treatment of downloaded e-books/files or recorded courses." },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["SaaS taxability not found.", "Downloaded digital products taxability not found (TSD 445 excludes them).", "Marketplace facilitator page (TSD-442) PDF not read."],
  },
  {
    state: "WI",
    stateSalesTax: { known: true, value: true, source: { url: "https://www.revenue.wi.gov/DOR%20Publications/pb201.pdf", quote: "The Wisconsin sales tax is a 5% tax imposed on the sales price of retailers making taxable retail sales in" } },
    marketplaceFacilitator: { known: true, value: true, source: { url: "https://www.revenue.wi.gov/Pages/Businesses/marketplace-providers-sellers.aspx", quote: "a marketplace provider is required to collect and remit sales or use tax for all sales of taxable products and services in Wisconsin that the marketplace provider facilitates on behalf of a marketplace seller, as provided in secs. 77.52(3m)(a) and 77.523(1), Wis. Stats." }, note: "Wis. Stats. secs. 77.52(3m)(a) and 77.523(1); 2019 Wis. Act 10; Tax 11.555, Wis. Adm. Code" },
    threshold: { known: true, value: { salesUsd: 100000, transactions: null, joiner: null, period: "Previous or current calendar year", counts: "Gross sales into Wisconsin, including sales for resale, taxable, and exempt sales. The 200-transaction threshold was eliminated effective Feb. 20, 2021 (2021 Wis. Act 1)." }, source: { url: "https://www.revenue.wi.gov/Pages/Businesses/remote-sellers.aspx", quote: "a remote seller is only required to collect and remit sales or use tax if its gross sales into Wisconsin exceed $100,000 in the previous or current calendar year." } },
    digitalProducts: { known: true, value: "partly", source: { url: "https://www.revenue.wi.gov/DOR%20Publications/pb201.pdf", quote: "Specified digital goods means digital audio works, digital audiovisual works, and digital books." }, note: "Taxable: specified digital goods (digital audio works, digital audiovisual works, digital books) and additional digital goods (greeting cards, finished artwork, periodicals, video or electronic games, newspapers or other news or information products). Publication 240 (Digital Goods) not read; recorded online courses and content subscriptions are not named." },
    saas: { known: true, value: "yes", source: { url: "https://www.revenue.wi.gov/DOR%20Publications/pb201.pdf", quote: "includes electricity, gas, steam, water, and prewritten computer software, regardless of how it is delivered to the purchaser." }, note: "Pub 201 defines taxable tangible personal property to include prewritten computer software 'regardless of how it is delivered', which covers remote access; Pub 240 not read to confirm SaaS wording." },
    gaps: ["Publication 240 (Digital Goods) not read.", "Whether a recorded online course is a taxable digital good not stated by name."],
  },
  {
    state: "WY",
    stateSalesTax: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    marketplaceFacilitator: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    threshold: { known: false, gap: "no threshold confirmed on an official page read on 2026-11-20" },
    digitalProducts: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    saas: { known: false, gap: "not confirmed on an official page read on 2026-11-20" },
    gaps: ["Wyoming sales tax content is on excise-tax-div.wyo.gov, which is not reachable (HTTP 000) from this session; revenue.wyo.gov/divisions/... paths return 404.", "revenue.wyo.gov/rules-and-regulations lists 'Chapter 2 - Sales and Use Tax (effective 05-20-2026)' but only as Google Drive links (not an allowed host)."],
  },
];

/** One state's rules, or null for a code not in the table (which is not a state with no tax). */
export function usSalesTaxRule(state: string): UsSalesTaxRule | null {
  return US_SALES_TAX_RULES.find((rule) => rule.state === state) ?? null;
}
