/** Official USD plan quotes for comparisons and the future browser-only calculator.
 * Static data: no visitor request, account access or provider operation.
 * Monthly equivalents of annual billing are not monthly purchase options.
 */
export type OfficialPriceSource = { label: string; url: string; readOn: string };
export type CompetitorPlanPrice = {
  name: string;
  monthlyCents: number | null;
  annualCents: number | null;
  /** Advertised monthly equivalent under annual billing; not an invoice or monthly purchase. */
  annualEquivalentMonthlyCents?: number;
  source: OfficialPriceSource;
  platformFeeBps: number | null;
  feeSource?: OfficialPriceSource;
  listedPaymentFeeBps?: number;
  listedPaymentFixedCents?: number;
  externalProviderFeeBps?: number;
  usRecurringBillingBps?: number;
  usCardProcessingBps?: number;
  usCardProcessingFixedCents?: number;
};
const kajabiPricing: OfficialPriceSource = {
  label: "Kajabi pricing and payment fees",
  url: "https://www.kajabi.com/pricing",
  readOn: "2026-11-15",
};
const skoolPricing: OfficialPriceSource = { label: "Skool plans", url: "https://www.skool.com/pricing", readOn: "2026-10-20" };
const skoolFees: OfficialPriceSource = { label: "Skool payment fees, payouts and Growth Boost", url: "https://help.skool.com/article/86-subscriptions-faq", readOn: "2026-10-20" };
const cfPricing: OfficialPriceSource = { label: "ClickFunnels plan prices and limits", url: "https://support.myclickfunnels.com/docs/clickfunnels-pricing/", readOn: "2026-10-20" };
const cfPayments: OfficialPriceSource = { label: "ClickFunnels Stripe and processor fees", url: "https://support.myclickfunnels.com/docs/setting-up-stripe-as-a-payment-gateway-in-clickfunnels/", readOn: "2026-10-20" };
const circlePricing: OfficialPriceSource = { label: "Circle pricing and plan scope", url: "https://circle.so/pricing", readOn: "2026-10-20" };
const circleFees: OfficialPriceSource = { label: "Circle paywall and Stripe fees", url: "https://help.circle.so/p/payments/paywall-setup/paywall-transaction-fees", readOn: "2026-10-20" };
const kitPricing: OfficialPriceSource = { label: "Kit prices and inclusive commerce fees", url: "https://kit.com/pricing", readOn: "2026-10-20" };
const whopPricing: OfficialPriceSource = { label: "Whop standard payment and payout prices", url: "https://whop.com/network/pricing/", readOn: "2026-10-20" };
const hotmartPricing: OfficialPriceSource = { label: "Hotmart subscription and product pricing", url: "https://hotmart.com/en/pricing", readOn: "2026-10-20" };
const hotmartPolicy: OfficialPriceSource = { label: "Hotmart payment policy updated September 21, 2026", url: "https://hotmart.com/en/legal/payments-policy", readOn: "2026-10-20" };
const hlPricing: OfficialPriceSource = { label: "HighLevel subscription prices and scope", url: "https://www.gohighlevel.com/pricing", readOn: "2026-10-20" };
const hlUsage: OfficialPriceSource = { label: "HighLevel usage costs and rebilling guide", url: "https://help.gohighlevel.com/support/solutions/articles/155000001156-highlevel-pricing-guide", readOn: "2026-10-20" };
const teachablePricing: OfficialPriceSource = { label: "Teachable plan prices and product limits", url: "https://www.teachable.com/pricing", readOn: "2026-10-20" };
const teachableFees: OfficialPriceSource = { label: "Teachable plan fees, processing and bundles", url: "https://support.teachable.com/en/articles/15661316-understand-your-transaction-fees-and-bundles", readOn: "2026-10-20" };
const substackPricing: OfficialPriceSource = { label: "Substack publishing, subscription and Stripe fees", url: "https://support.substack.com/hc/en-us/articles/360037607131-How-much-does-Substack-cost", readOn: "2026-10-20" };
const patreonPricing: OfficialPriceSource = { label: "Patreon standard plan and publishing", url: "https://www.patreon.com/pricing", readOn: "2026-10-20" };
const patreonFees: OfficialPriceSource = { label: "Patreon standard and legacy fee rules", url: "https://support.patreon.com/hc/en-us/articles/11111747095181-Creator-fees-overview", readOn: "2026-10-20" };
const linktreePricing: OfficialPriceSource = { label: "Linktree monthly prices and annual-billing display", url: "https://linktr.ee/s/pricing", readOn: "2026-10-20" };
const linktreeFees: OfficialPriceSource = { label: "Linktree direct and partner earnings fees", url: "https://linktr.ee/help/en/articles/11410206-understanding-transaction-and-processing-fees-on-linktree", readOn: "2026-10-20" };
const podiaPricing: OfficialPriceSource = { label: "Podia annual invoices, fees and migration help", url: "https://www.podia.com/pricing", readOn: "2026-10-20" };
const thinkificPricing: OfficialPriceSource = { label: "Thinkific prices, course limits and trial", url: "https://www.thinkific.com/pricing/", readOn: "2026-10-20" };
const thinkificFees: OfficialPriceSource = { label: "Thinkific conditional third-party gateway fees", url: "https://support.thinkific.com/hc/en-us/articles/22383950439575-Third-Party-Payment-Gateway-Fee-FAQ", readOn: "2026-10-20" };
const systemePricing: OfficialPriceSource = { label: "Systeme.io plan prices and FAQ limits", url: "https://systeme.io/pricing", readOn: "2026-10-20" };
export const COMPETITOR_PRICES = {
  kajabi: {
    name: "Kajabi",
    currency: "USD",
    plans: [
      { name: "Basic", monthlyCents: 17900, annualCents: 171600, source: kajabiPricing, platformFeeBps: 0, externalProviderFeeBps: 200, usCardProcessingBps: 290, usCardProcessingFixedCents: 30 },
      { name: "Growth", monthlyCents: 24900, annualCents: 238800, source: kajabiPricing, platformFeeBps: 0, externalProviderFeeBps: 100, usCardProcessingBps: 280, usCardProcessingFixedCents: 30 },
      { name: "Pro", monthlyCents: 49900, annualCents: 478800, source: kajabiPricing, platformFeeBps: 0, externalProviderFeeBps: 50, usCardProcessingBps: 270, usCardProcessingFixedCents: 30 },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "Kajabi Payments has no platform revenue share. Card rates shown are for US entities. A third-party provider adds 2%, 1% or 0.5% where Kajabi Payments is available; PayPal is excluded. Processing and taxes are separate.",
    trial: { days: 14, source: { label: "Kajabi standard trial and its limits", url: "https://help.kajabi.com/en/articles/17174347-kajabi-trial-information", readOn: "2026-11-15" } },
    brandedApp: { monthlyAddOnCents: 19900, includedOn: "Pro", source: { label: "Kajabi branded app scope and pricing", url: "https://help.kajabi.com/en/articles/17175583-kajabi-branded-app-faqs", readOn: "2026-11-15" } },
  },
  skool: {
    name: "Skool",
    currency: "USD",
    plans: [
      { name: "Hobby", monthlyCents: 900, annualCents: null, source: skoolPricing, feeSource: skoolFees, platformFeeBps: null, listedPaymentFeeBps: 1000, listedPaymentFixedCents: 30 },
      { name: "Pro", monthlyCents: 9900, annualCents: null, source: skoolPricing, feeSource: skoolFees, platformFeeBps: null, listedPaymentFeeBps: 290, listedPaymentFixedCents: 30 },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "Hobby: 10% + $0.30 per transaction. Pro: 2.9% + $0.30 up to $899; 3.9% + $0.30 above $900. The FAQ does not clearly state the exact $900 boundary. Confirm that quote before calculating it.",
    annualScope: "Yearly billing is advertised with two months free; no annual charge is assumed from that headline. Check Skool's current annual quote.",
    trial: { days: 14, source: { label: "Skool subscription and cancellation policy", url: "https://help.skool.com/article/227-payment-terms-and-policy", readOn: "2026-10-20" } },
    discovery: { source: { label: "Skool Discovery eligibility", url: "https://help.skool.com/article/153-discovery-faqs", readOn: "2026-10-20" } },
    live: { source: { label: "Skool native live calls", url: "https://help.skool.com/article/210-how-to-go-live-on-skool", readOn: "2026-10-20" } },
    webinar: { source: { label: "Skool webinars on Pro", url: "https://help.skool.com/article/214-how-to-create-webinar", readOn: "2026-10-20" } },
  },
  clickfunnels: {
    name: "ClickFunnels",
    currency: "USD",
    plans: [
      { name: "Launch", monthlyCents: 9700, annualCents: 97000, source: cfPricing, platformFeeBps: 0, feeSource: cfPayments },
      { name: "Scale", monthlyCents: 19700, annualCents: 197000, source: cfPricing, platformFeeBps: 0, feeSource: cfPayments },
      { name: "Optimize", monthlyCents: 29700, annualCents: 297000, source: cfPricing, platformFeeBps: 0, feeSource: cfPayments },
      { name: "Dominate", monthlyCents: null, annualCents: 599700, source: cfPricing, platformFeeBps: 0, feeSource: cfPayments },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "ClickFunnels adds no fee for using Stripe. Processor charges and optional billing, invoicing, tax or Payments AI services can add to your bill; 0% is not free processing.",
    trial: { days: 14, source: { label: "ClickFunnels trial FAQs", url: "https://support.myclickfunnels.com/docs/clickfunnels-faqs/", readOn: "2026-10-20" } },
    split: { source: { label: "ClickFunnels page split-test scope", url: "https://support.myclickfunnels.com/docs/managing-ab-split-testing-in-funnel-steps/", readOn: "2026-10-20" } },
    editor: { source: { label: "ClickFunnels editor and feature overview", url: "https://www.clickfunnels.com/pricing", readOn: "2026-10-20" } },
  },
  circle: {
    name: "Circle",
    currency: "USD",
    plans: [
      { name: "Professional", monthlyCents: null, annualCents: null, annualEquivalentMonthlyCents: 8900, source: circlePricing, platformFeeBps: 200, feeSource: circleFees },
      { name: "Business", monthlyCents: null, annualCents: null, annualEquivalentMonthlyCents: 19900, source: circlePricing, platformFeeBps: 100, feeSource: circleFees },
      { name: "Scale", monthlyCents: null, annualCents: null, annualEquivalentMonthlyCents: 41900, source: circlePricing, platformFeeBps: 100, feeSource: circleFees },
    ] satisfies CompetitorPlanPrice[],
    annualScope: "These are advertised monthly equivalents with annual billing, before taxes. A monthly purchase price and the exact annual invoice have not been verified; neither is calculated from the display. Circle Plus needs a custom quote.",
    feeScope: "Professional: 2%; Business and Scale: 1%; Circle Plus: 0.5%, plus Stripe. The US subscription example adds 2.9% + $0.30 processing and 0.7% Billing. Country, method, currency conversion and optional services can change the total.",
    trial: { days: 14, source: circlePricing },
    live: { source: { label: "Circle native live streams and rooms", url: "https://help.circle.so/p/live-and-events/live-setup/circle-live-overview", readOn: "2026-10-20" } },
    messaging: { source: { label: "Circle direct and group messaging", url: "https://help.circle.so/p/chat/dm/get-to-know-direct-messaging", readOn: "2026-10-20" } },
  },
  kit: {
    name: "Kit",
    currency: "USD",
    plans: [
      { name: "Free", monthlyCents: 0, annualCents: 0, source: kitPricing, platformFeeBps: 60, listedPaymentFeeBps: 350, listedPaymentFixedCents: 30 },
      { name: "Creator", monthlyCents: null, annualCents: 39000, source: kitPricing, platformFeeBps: 60, listedPaymentFeeBps: 350, listedPaymentFixedCents: 30 },
      { name: "Pro", monthlyCents: null, annualCents: null, annualEquivalentMonthlyCents: 6600, source: kitPricing, platformFeeBps: 60, listedPaymentFeeBps: 350, listedPaymentFixedCents: 30 },
    ] satisfies CompetitorPlanPrice[],
    billingScope: "Paid quotes are for 1,000 subscribers. Creator: $390/year. Pro displays a $66/month annual-billing equivalent and a $593 first-year promotion, renewing at the standard rate. The exact standard renewal invoice and paid monthly quotes are not verified here; do not infer them from rounded equivalents or the promotion.",
    feeScope: "The published digital-product and subscription fee is 3.5% + $0.30, including card processing; Kit states its share is 0.6%. Do not add standard card processing a second time.",
    trial: { days: 14, source: kitPricing },
    discovery: { source: { label: "Kit creator recommendations", url: "https://kit.com/features/recommendations", readOn: "2026-10-20" } },
    sponsorship: { source: { label: "Kit newsletter sponsorships", url: "https://kit.com/features/newsletter-sponsorships", readOn: "2026-10-20" } },
  },
  whop: {
    name: "Whop",
    currency: "USD",
    plans: [
      { name: "Standard pay-as-you-go", monthlyCents: 0, annualCents: 0, source: whopPricing, platformFeeBps: null, listedPaymentFeeBps: 270, listedPaymentFixedCents: 30 },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "Domestic cards: 2.7% + $0.30. International cards add 1.5%; currency conversion adds 1%. Optional orchestration adds 0.8%, Billing 0.5%, and tax/remittance 2% when enabled and tax is collected; all three enabled gives 6% + $0.30 before international/FX extras.",
    payoutScope: "Next-day US ACH payout: $2.50; instant bank deposit: 4% + $2.50. Other methods have their own rates. This is not a quote for Marktmorgen or a complete tax exemption.",
    trial: { days: null, source: whopPricing },
    discovery: { source: { label: "Whop Discover directory", url: "https://whop.com/discover/", readOn: "2026-10-20" } },
  },
  hotmart: {
    name: "Hotmart",
    currency: "USD",
    plans: [
      { name: "Standard", monthlyCents: 0, annualCents: 0, source: hotmartPricing, platformFeeBps: 990, listedPaymentFixedCents: 100, feeSource: hotmartPolicy },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "For a USD purchase with USD commission above $15: 9.9% + $1.00. At or below $15: 9.9% + $0.10. Currency mismatches have different rules. These are platform charges, not a verified all-in payment or tax quote.",
    policyScope: "The September 21, 2026 English policy lists a $1.00 fixed USD fee. An older $0.50 sentence remains in the help article; its updated table and Player FAQ state $1.00. Confirm the applicable transaction quote. Do not add a separate legacy Player fee.",
    trial: { days: null, source: hotmartPricing },
    feeDetails: { source: { label: "Hotmart fee bands and Player fee update", url: "https://suportehotmart.zendesk.com/hc/en-us/articles/208298448-What-are-the-fees-charged-by-Hotmart", readOn: "2026-10-20" } },
  },
  highlevel: {
    name: "HighLevel",
    currency: "USD",
    plans: [
      { name: "Starter", monthlyCents: 9700, annualCents: 97000, source: hlPricing, platformFeeBps: null },
      { name: "Unlimited", monthlyCents: 29700, annualCents: 297000, source: hlPricing, platformFeeBps: null },
      { name: "Agency Pro", monthlyCents: 49700, annualCents: 497000, source: hlPricing, platformFeeBps: null },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "The subscription is not an all-in usage quote: phone numbers, calls, SMS, email sends and AI can cost extra. Rebilling does not make usage free. Provider, method and enabled services determine payment costs; no universal transaction fee is assumed here.",
    trial: { days: 14, source: hlPricing },
    usage: { source: hlUsage },
  },
  teachable: {
    name: "Teachable",
    currency: "USD",
    plans: [
      { name: "Starter", monthlyCents: 3900, annualCents: null, annualEquivalentMonthlyCents: 2900, source: teachablePricing, platformFeeBps: 750, feeSource: teachableFees },
      { name: "Builder", monthlyCents: 8900, annualCents: null, annualEquivalentMonthlyCents: 6900, source: teachablePricing, platformFeeBps: 0, feeSource: teachableFees },
      { name: "Growth", monthlyCents: 18900, annualCents: null, annualEquivalentMonthlyCents: 13900, source: teachablePricing, platformFeeBps: 0, feeSource: teachableFees },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "The plan fee is 7.5% on Starter and 0% on Builder and Growth, across Teachable Payments and custom gateways. Payment processing and optional bundles are separate; 0% plan fee is not free payment processing.",
    annualScope: "Displayed monthly equivalents under annual billing are $29, $69 and $139. An exact annual invoice has not been verified here; do not infer it from the displayed equivalent. Custom needs a quote.",
    trial: { days: 7, source: teachablePricing },
  },
  substack: {
    name: "Substack",
    currency: "USD",
    plans: [
      { name: "Publishing", monthlyCents: 0, annualCents: 0, source: substackPricing, platformFeeBps: 1000, usCardProcessingBps: 290, usCardProcessingFixedCents: 30, usRecurringBillingBps: 70 },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "No publishing subscription fee; paid subscriptions incur a 10% Substack share. The published US-card example adds Stripe 2.9% + $0.30 processing and 0.7% recurring Billing. Local methods, country and iOS purchases can change the total. Optional custom-domain connection is $50 once.",
    trial: { days: null, source: substackPricing },
    discovery: { source: { label: "Substack reader app and discovery feed", url: "https://support.substack.com/hc/en-us/articles/19291693034004-Getting-started-on-the-Substack-app", readOn: "2026-10-20" } },
  },
  patreon: {
    name: "Patreon", currency: "USD",
    plans: [{ name: "Standard for new creators", monthlyCents: 0, annualCents: 0, source: patreonPricing, platformFeeBps: 1000, feeSource: patreonFees }] satisfies CompetitorPlanPrice[],
    feeScope: "The standard platform share is 10% for creator pages published after August 4, 2025, plus payment processing, payout, conversion and applicable taxes. Continuously published legacy pages can retain different rates; unpublishing and republishing can move them to standard pricing. iOS purchases can add different charges.",
    trial: { days: null, source: patreonPricing },
  },
  linktree: {
    name: "Linktree", currency: "USD",
    plans: [
      { name: "Free", monthlyCents: 0, annualCents: 0, source: linktreePricing, platformFeeBps: null, feeSource: linktreeFees },
      { name: "Starter", monthlyCents: 800, annualCents: null, annualEquivalentMonthlyCents: 600, source: linktreePricing, platformFeeBps: null, feeSource: linktreeFees },
      { name: "Pro", monthlyCents: 1500, annualCents: null, annualEquivalentMonthlyCents: 1200, source: linktreePricing, platformFeeBps: null, feeSource: linktreeFees },
      { name: "Premium", monthlyCents: 3500, annualCents: null, annualEquivalentMonthlyCents: 3000, source: linktreePricing, platformFeeBps: null, feeSource: linktreeFees },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "The pricing page advertises 0% selling fees on Pro, while its link-in-bio feature page still lists a 9% Pro digital-product fee. The applicable platform rate remains unconfirmed, not zero. Direct earnings have separate Stripe processing; the $0.25 partner-earnings payout fee is not a per-purchase fee.",
    annualScope: "Paid annual-billing displays are $6, $12 and $30 per month equivalent; exact annual invoices are not verified here. Digital-product selling is documented for eligible Pro and Premium accounts in supported countries.",
    trial: { days: 7, scope: "Pro and Premium only", source: linktreePricing },
    eligibility: { source: { label: "Linktree digital-product eligibility", url: "https://linktr.ee/help/en/articles/10631437-how-to-share-and-sell-digital-products-on-your-linktree", readOn: "2026-10-20" } },
    conflictingDisplay: { source: { label: "Linktree older Pro fee display", url: "https://linktr.ee/features/link-in-bio", readOn: "2026-10-20" } },
  },
  podia: {
    name: "Podia", currency: "USD",
    plans: [
      { name: "Mover", monthlyCents: null, annualCents: 50400, source: podiaPricing, platformFeeBps: 500 },
      { name: "Shaker", monthlyCents: null, annualCents: 100800, source: podiaPricing, platformFeeBps: 0 },
      { name: "Earthquaker", monthlyCents: null, annualCents: 180000, source: podiaPricing, platformFeeBps: 0 },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "Mover: 5% platform fee; Shaker and Earthquaker: 0%. Stripe or PayPal processing is separate. Monthly purchase quotes are unverified.",
    trial: { days: 14, source: podiaPricing },
  },
  thinkific: {
    name: "Thinkific", currency: "USD",
    plans: [
      { name: "Basic", monthlyCents: 5400, annualCents: null, annualEquivalentMonthlyCents: 4000, source: thinkificPricing, platformFeeBps: 0, externalProviderFeeBps: 500, feeSource: thinkificFees },
      { name: "Start", monthlyCents: 10900, annualCents: null, annualEquivalentMonthlyCents: 8200, source: thinkificPricing, platformFeeBps: 0, externalProviderFeeBps: 200, feeSource: thinkificFees },
      { name: "Grow", monthlyCents: 21900, annualCents: null, annualEquivalentMonthlyCents: 16400, source: thinkificPricing, platformFeeBps: 0, externalProviderFeeBps: 100, feeSource: thinkificFees },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "The third-party gateway fee is 5% on Basic, 2% on Start and 1% on Grow where the FAQ's country and provider rules apply. Thinkific Payments does not incur that gateway fee; processing and enabled payment services still cost separately. This is not a universal 0% payment quote.",
    annualScope: "Advertised annual-billing monthly equivalents are $40, $82 and $164. Exact annual invoices are unverified, not inferred from rounded displays. Plus requires a custom quote.",
    trial: { days: 30, source: thinkificPricing },
  },
  systeme: {
    name: "Systeme.io", currency: "USD",
    plans: [
      { name: "Free", monthlyCents: 0, annualCents: 0, source: systemePricing, platformFeeBps: 0 },
      { name: "Startup", monthlyCents: 1700, annualCents: null, source: systemePricing, platformFeeBps: 0 },
      { name: "Webinar", monthlyCents: 4700, annualCents: null, source: systemePricing, platformFeeBps: 0 },
      { name: "Unlimited", monthlyCents: 9700, annualCents: null, source: systemePricing, platformFeeBps: 0 },
    ] satisfies CompetitorPlanPrice[],
    feeScope: "Systeme.io advertises 0% platform transaction fees; Stripe or PayPal processing is separate. Exact paid annual invoices are not verified from the two-months-free headline.",
    trial: { days: null, source: systemePricing },
  },
} as const;
