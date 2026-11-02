import { CREATOR_SHOWCASE, SHOWCASE_REVIEWED_AT } from "@/lib/creator-showcase";
// Content for every page behind a menu item. One entry per page, so that
// each menu item opens something different and real.
import { AI_PLANS_WORDS } from "@/lib/ai-rules";
import { isDomainsConfigured } from "@/lib/domains";
import { PRO_MONTHLY_EMAILS, TIERS, PLAN_TITLES, publishedPriceWords, monthlyEmails, commissionBps } from "@/lib/plan";
import { pipelineLimitWords } from "@/lib/crm-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { FINAL_COMPARISON_PAGES } from "@/lib/final-comparison-pages";
import { COMPETITOR_PRICES } from "@/lib/competitor-prices";
import { PLANS_ON_SALE } from "@/lib/opening";
import { paypalSalesConfigured } from "@/lib/paypal-sales";
import { PAYPAL_NOT_YET, PAYPAL_WAITS, STAN_AFFILIATES_AHEAD, checkoutQuestionWords } from "@/lib/public-explanations";
import type { IconName } from "@/components/icons";
import type { VisualKey } from "@/components/feature-visuals";
import { CREATOR_PAGES, FEATURE_PAGES } from "@/lib/feature-pages";
import { INVITE_PROGRAM_OPEN, INVITE_PAUSE_NOTICE, INVITE_BONUS_CENTS, INVITE_HOLD_DAYS, INVITE_SHARE_PERCENT } from "@/lib/creator-invite-rules";
import { PLAN_AT, feeWords, monthlyRow, planPriceWords, yearlyRow } from "@/lib/fee-words";

const INVITE_BONUS = `$${INVITE_BONUS_CENTS / 100}`;

/** Whether stores can be put on their own domain on this deployment. */
const DOMAINS = isDomainsConfigured();
/*
  Whether a buyer can pay with PayPal here.

  Read rather than written down, for the same reason DOMAINS is: PayPal hands
  a platform its partner credentials only after approving it, so this is
  false until that day and true from it, and the comparison rows below have
  to say whichever is true on the day they are read. They said "no PayPal"
  flatly for months after lib/paypal-sales.ts was finished, which is the same
  fault as claiming a feature that does not exist, pointing the other way.
*/
const PAYPAL = paypalSalesConfigured();

export type Block =
  | { kind: "lead"; text: string }
  | { kind: "cards"; title: string; items: { emoji: string; title: string; body: string; tint: string }[] }
  | { kind: "steps"; title: string; items: { title: string; body: string }[] }
  | { kind: "facts"; title: string; items: { value: string; label: string; tone: string }[] }
  | { kind: "table"; title: string; note?: string; head: [string, string, string]; rows: [string, string, string][] }
  | { kind: "quote"; text: string; source: string }
  | { kind: "note"; title: string; body: string }
  | { kind: "storecard"; title: string; creator: string; tagline: string; photo?: string; alt: string; example?: string; items: { label: string; detail: string; price: string }[] }
  /** Three numbered steps side by side: how the thing works, start to end. */
  | { kind: "how"; title: string; items: { title: string; body: string }[] }
  /** What it does, one card each, optionally leading to its own page. */
  | { kind: "features"; title: string; intro?: string; items: { icon: IconName; title: string; body: string; href?: string }[] }
  /** Who it is for, in their own situation. */
  | { kind: "uses"; title: string; items: { icon: IconName; who: string; what: string }[] }
  /** What it does not do, said before anyone has to find out. */
  | { kind: "limits"; title: string; intro?: string; items: string[] }
  | { kind: "faq"; title: string; items: { q: string; a: string }[] }
  /** From the first free thing to the biggest sale, for one kind of creator. */
  | { kind: "ladder"; title: string; intro?: string; items: { step: string; title: string; price: string; body: string; href: string; icon: IconName }[] };

export type TopicPage = {
  slug: string;
  section: "platform" | "for" | "proof";
  eyebrow: string;
  title: string;
  highlight: string;
  intro: string;
  badge: { label: string; tone: "live" | "building" | "proof" };
  accent: string;
  blocks: Block[];
  /** An exact search title and description when the visible heading is editorial. */
  seo?: { title: string; description: string };
  /** The drawing of the real screen shown beside the heading. */
  visual?: VisualKey;
  /** The plan it comes with: on $29 (and so on Studio too), or on Studio only. */
  plan?: "creator" | "pro";
  /** Where a feature sits in the menu and on the features page. */
  group?: "sell" | "paid" | "deliver" | "grow";
  /** How the menu and the features page name it. */
  menu?: { label: string; description: string; icon: IconName };
  /** Other feature pages worth reading next. */
  related?: string[];
  /**
   * A photograph of the work this page is about, shown behind the example
   * store in the heading. Licensed stock, and the page says so beside it:
   * nobody in these pictures is a customer of ours.
   */
  photo?: { id: string; alt: string };
};

const PROOF = { label: "Checked and dated", tone: "proof" as const };

export const PAGES: TopicPage[] = [
  ...FEATURE_PAGES,
  ...CREATOR_PAGES,
  ...FINAL_COMPARISON_PAGES,
  {
    slug:"creator-showcase",section:"proof",eyebrow:"Permission before proof",title:"Store",highlight:"showcase",
    intro:"Explore the demo or a creator listing with recorded permission. No listing is a promise of sales, income or results.",
    seo:{title:"Creator store showcase — Marktmorgen",description:"Clearly labeled demo and only real creator listings with dated permission. No invented testimonials or earnings claims."},
    badge:{label:"Permission registry reviewed "+SHOWCASE_REVIEWED_AT,tone:"proof"},accent:"#6d4aff",
    blocks:[
      {kind:"lead",text:CREATOR_SHOWCASE.every(entry=>entry.kind==="demo")?"No real creator listing has recorded permission here yet. The only listing below is our fictional demonstration store.":"Each real creator listing below has dated permission in the reviewed registry. Permission to list a store does not authorize a testimonial or a claim about results."},
      {kind:"features",title:"Explore the store listings",items:CREATOR_SHOWCASE.map(entry=>({icon:"store" as const,title:entry.name+(entry.kind==="demo"?" — demo":" — creator"),body:entry.description+(entry.permissionRecordedAt?" Permission recorded "+entry.permissionRecordedAt+".":""),href:entry.href}))},
      {kind:"limits",title:"How permission works",items:["A real listing needs explicit permission, its date, scope and an evidence reference before publication. Missing or revoked permission keeps it off this list.","No customer portraits, revenue totals, testimonials or growth figures are inferred from a store listing.","The demo is fictional and demonstrates features; it is not evidence of a real creator's outcome. Paid plans and paid selling remain subject to all opening gates."]},
    ],
  },
  {
    slug: "teachable",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "Teachable",
    intro: "A Teachable alternative where courses sit beside other products in a creator's store. Compare catalog limits, student experience and payment costs before moving a school.",
    seo: { title: "Marktmorgen vs Teachable", description: "A Teachable alternative where courses and other products share a creator's store. Compare sourced prices, catalog limits and payment fees. Marktmorgen paid plans remain closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "A school and a multi-product store can serve different needs. Marktmorgen already supports courses, quizzes and certificates; that does not make its student experience identical to Teachable's. Inspect the actual course tools, product limits and separate payment fees." },
      { kind: "table", title: "Courses, subscriptions and fees", head: ["Compare", "Teachable", "Marktmorgen"], note: "USD. Sources read October 20, 2026. Product counts are catalog limits, not a promise of unlimited storage or bandwidth. Taxes and payment processing are separate.", rows: [
        ["Monthly subscription", COMPETITOR_PRICES.teachable.plans.map(p => p.name + ": $" + p.monthlyCents / 100).join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month")).join("; ")],
        ["Annual billing", COMPETITOR_PRICES.teachable.annualScope, TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "year")).join("; ")],
        ["Platform and processing fees", COMPETITOR_PRICES.teachable.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% of each sale").join("; ") + ". Your Stripe processing fees are separate."],
        ["Product catalog", "Starter: 5; Builder: 10; Growth: 50 products. Custom limits require a quote.", MAX_PRODUCTS.toLocaleString("en-US") + " catalog products. Upload, storage, delivery and per-feature limits still apply."],
        ["Student experience", "iOS and Android student apps.", "Courses in the store's browser experience. Marktmorgen has no app-store listing."],
        ["Getting started", COMPETITOR_PRICES.teachable.trial.days + "-day trial according to its pricing page.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Inspect the course and migration limits", items: [
        { icon: "book", title: "Courses in Marktmorgen", body: "Read the existing learning, lesson and delivery features before replacing a school.", href: "/platform/courses" },
        { icon: "download", title: "Supported migration paths", body: "Check what products, contacts and past buyers can be imported. Do not assume another school's design or live subscriptions transfer.", href: "/platform/switching-to-marktmorgen" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "Teachable offers iOS and Android student apps. Marktmorgen has no app-store listing.",
        "Teachable's Custom offer includes migration assistance and school-specific onboarding. Marktmorgen does not promise that service through its self-service importer.",
        "Teachable sells paid courses today. Marktmorgen's paid plans remain closed.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. No worldwide tax exemption, universal course fit or net-margin result is inferred from the fee table.", items: [
        { icon: "list", title: COMPETITOR_PRICES.teachable.plans[0].source.label, body: "Monthly prices, annual-billing display, product caps, trial, student apps and Custom services.", href: COMPETITOR_PRICES.teachable.plans[0].source.url },
        { icon: "calculator", title: COMPETITOR_PRICES.teachable.plans[0].feeSource.label, body: "Plan fee versus processing and optional bundles.", href: COMPETITOR_PRICES.teachable.plans[0].feeSource.url },
        { icon: "scale", title: "All published comparisons", body: "Read other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "highlevel",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "HighLevel",
    intro: "A HighLevel alternative where CRM records sit beside a creator's store and products. Compare the audience, channels and agency model before treating these as equivalent subscriptions.",
    seo: { title: "Marktmorgen vs HighLevel", description: "A HighLevel alternative where CRM and products share a creator's store. Compare subscription prices, usage costs, channels and agency scope. Marktmorgen paid plans remain closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Marktmorgen already has custom contact fields, deals, pipelines and branching workflows. That does not make it a phone system or an agency-resale platform. Choose by the work and channels you need, including the usage bill." },
      { kind: "table", title: "CRM, subscriptions and channel costs", head: ["Compare", "HighLevel", "Marktmorgen"], note: "USD. Sources read October 20, 2026. Subscription prices do not include every optional service, provider charge or tax. A store is not the same billing unit as an agency sub-account.", rows: [
        ["Monthly subscription", COMPETITOR_PRICES.highlevel.plans.map(p => p.name + ": $" + p.monthlyCents / 100).join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month")).join("; ")],
        ["Annual subscription", COMPETITOR_PRICES.highlevel.plans.map(p => p.name + ": $" + (p.annualCents / 100).toLocaleString("en-US") + "/year").join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "year")).join("; ")],
        ["CRM and accounts", "CRM and pipelines. Starter has 3 sub-accounts; Unlimited and Agency Pro have unlimited sub-accounts.", "Contact fields, deals and pipelines within each store. " + pipelineLimitWords()],
        ["Communication channels", "Email, SMS, calling and social-media tools; usage and add-on costs apply.", "Opt-in email with published send limits; no SMS, WhatsApp or phone-call sending. Booked video calls are a different product."],
        ["Usage charges", COMPETITOR_PRICES.highlevel.feeScope, "List emails use published plan allowances. Stripe charges separately for payments; bounded paid add-ons keep their own limits."],
        ["Agency resale", "Agency Pro includes SaaS Mode and automated sub-account creation.", "No equivalent agency SaaS resale or marked-up phone/email rebilling is offered by this comparison."],
        ["Getting started", COMPETITOR_PRICES.highlevel.trial.days + "-day trial; usage charges can still apply.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Inspect the existing tools", items: [
        { icon: "users", title: "People, deals and pipelines", body: "Read the current contact fields, recorded deal values, pipeline rules and workflow conditions.", href: "/platform/crm" },
        { icon: "layout", title: "Store pages and funnels", body: "Inspect the existing page blocks and experiments before assuming they replace an agency's setup.", href: "/platform/sales-pages" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "HighLevel has native phone and SMS tooling plus social-media management. Marktmorgen does not offer those communication channels.",
        "HighLevel Agency Pro has SaaS Mode and automated client sub-account creation. Marktmorgen is not a replacement for that resale model.",
        "HighLevel offers agency-wide account management. Marktmorgen's pipelines and their limits belong to individual stores.",
        "HighLevel sells paid subscriptions today. Marktmorgen's paid plans remain closed.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. No result, revenue, cost-saving or net-margin claim is made from either subscription price.", items: [
        { icon: "list", title: COMPETITOR_PRICES.highlevel.plans[0].source.label, body: "Monthly and annual prices, sub-accounts, channels and SaaS Mode.", href: COMPETITOR_PRICES.highlevel.plans[0].source.url },
        { icon: "calculator", title: COMPETITOR_PRICES.highlevel.usage.source.label, body: "Usage billing, wallets, optional services and rebilling.", href: COMPETITOR_PRICES.highlevel.usage.source.url },
        { icon: "scale", title: "All published comparisons", body: "Read other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "hotmart",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "Hotmart",
    intro: "A Hotmart alternative where a creator's store charges through their own Stripe account. Compare the distribution tools, payment model and current fee policy before moving.",
    seo: { title: "Marktmorgen vs Hotmart", description: "A Hotmart alternative where a creator's store uses their own Stripe account. Compare current USD fee bands, payment models and distribution tools. Marktmorgen paid plans remain closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Hotmart combines product delivery with its own payment system and affiliate tools. Marktmorgen uses a creator's connected Stripe account. Neither arrangement removes every creator or platform tax obligation, and the payment policy matters more than an old fee headline." },
      { kind: "table", title: "Subscriptions, USD fees and payment models", head: ["Compare", "Hotmart", "Marktmorgen"], note: "USD. Official sources read October 20, 2026. Fee bands below assume purchase and commission currencies are both USD. Taxes, card and withdrawal charges can add to the total.", rows: [
        ["Subscription", "No monthly or annual subscription fee.", TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month") + " or " + publishedPriceWords(t, "year")).join("; ")],
        ["Platform fee", COMPETITOR_PRICES.hotmart.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% of each sale").join("; ") + ". Your Stripe processing fees are separate."],
        ["Current fee policy", COMPETITOR_PRICES.hotmart.policyScope, "The published subscription and visible limits remain the terms for a prepared store; paid selling remains closed."],
        ["Payment and tax responsibilities", "Hotpay collects and settles proceeds under its policy. Contracting entity, product, residence and local law affect tax responsibility.", "Direct charges on your connected Stripe account. Applicable creator and platform taxes still need to be handled."],
        ["Product delivery and distribution", "Product hosting, affiliate tools and a Hotmart app for buyers.", "A store with multiple product types and controlled community access. Marktmorgen has no app-store listing and does not promise a supply of buyers."],
        ["Payout timing", "For non-BRL commissions, withdrawal can start from 15 calendar days after a completed sale, subject to the guarantee period and account eligibility. BRL payment methods have different timelines.", "Stripe settlement, the connected account payout schedule, bank timing and account review determine bank receipt. Direct charging does not mean an instant payout or guarantee faster receipt."],
        ["Branding and domains", "Hotmart Club offers visual identity and domain customization. That does not establish that every payment or buyer-app surface is unbranded.", DOMAINS ? "Customize your storefront look. Studio and Scale custom domains require DNS ownership verification and a working certificate; payment-provider surfaces retain their own terms." : "Customize your storefront look. Custom-domain connections are not configured on this deployment; the existing Marktmorgen store address remains available. No promise of a fully unbranded payment flow."],
        ["Ecosystem and portability", "Sales on the Hotmart platform use Hotpay under its payment policy. Distribution and buyer-app benefits depend on that ecosystem.", "Your store charges through a connected Stripe account and still depends on Stripe eligibility and Marktmorgen service availability. Supported imports do not transfer live subscriptions or a marketplace audience."],
        ["Getting started", "Paid sales are available subject to Hotmart's onboarding and eligibility.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Inspect before moving", items: [
        { icon: "download", title: "Supported migration paths", body: "Check contacts, products and past-buyer imports. An import does not migrate a payment provider's live subscription or send messages on its own.", href: "/platform/switching-to-marktmorgen" },
        { icon: "bank", title: "Your Stripe account", body: "Read how connected charges and payouts work before replacing your current payment setup.", href: "/platform/your-stripe" },
        { icon: "scale", title: "Brand and domain requirements", body: "Check the available plans, configuration and DNS ownership requirements before promising a custom address to buyers.", href: "/platform/domain" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "Hotmart offers affiliate tools and automated affiliate payments. Marktmorgen does not promise Hotmart's distribution network or incoming sales.",
        "Hotmart offers a buyer app and offline class viewing. Marktmorgen has no app-store listing.",
        "Hotmart has no monthly subscription fee. Marktmorgen uses subscriptions with published limits.",
        "Hotmart sells paid products today. Marktmorgen's paid plans remain closed.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. No tax exemption or net-margin certification is inferred from the payment model.", items: [
        { icon: "list", title: COMPETITOR_PRICES.hotmart.plans[0].source.label, body: "Subscription model, product delivery, affiliate tools and buyer app.", href: COMPETITOR_PRICES.hotmart.plans[0].source.url },
        { icon: "scale", title: COMPETITOR_PRICES.hotmart.plans[0].feeSource.label, body: "Current fixed fee, microtransaction bands and conditional tax responsibilities.", href: COMPETITOR_PRICES.hotmart.plans[0].feeSource.url },
        { icon: "calculator", title: COMPETITOR_PRICES.hotmart.feeDetails.source.label, body: "USD bands, conflicting older sentence and the Player fee change.", href: COMPETITOR_PRICES.hotmart.feeDetails.source.url },
        { icon: "bank", title: "Hotmart withdrawal availability", body: "Non-BRL withdrawal timing, guarantee periods, BRL method differences and conditions that can prevent receipt. Read October 20, 2026.", href: "https://suportehotmart.zendesk.com/hc/en-us/articles/360028608652-When-can-I-withdraw-my-commissions-and-what-can-prevent-receipt" },
        { icon: "list", title: "Hotmart Club customization", body: "Official Club page describes visual identity and domain customization. Read October 20, 2026; not used as a fee source.", href: "https://solutions.hotmart.com/update-your-members-area" },
        { icon: "bank", title: "Stripe payout documentation", body: "Available balance, settlement, payout schedules, bank delays and account conditions. Read October 20, 2026; no faster-payout guarantee.", href: "https://docs.stripe.com/payouts" },
        { icon: "scale", title: "All published comparisons", body: "Read other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "whop",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "Whop",
    intro: "A Whop alternative where a creator's store uses their own Stripe account. Compare discovery, payment services and payout fees rather than treating every platform fee as the same charge.",
    seo: { title: "Marktmorgen vs Whop", description: "A Whop alternative where a creator's store uses their own Stripe account. Compare dated payment, payout and optional-service fees. Marktmorgen paid plans remain closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Choose the distribution and payment setup you need. A direct Stripe store does not bring a marketplace audience with it, and a payment-service quote is not a promise that every extra service or tax is included." },
      { kind: "table", title: "Payments, payouts and discovery", head: ["Compare", "Whop", "Marktmorgen"], note: "USD. Sources read October 20, 2026. Whop's Standard quote has conditional additions; a payment fee is not an independently verified platform-share breakdown. Unknown charges are not zero.", rows: [
        ["Subscription", "Standard pay-as-you-go has no setup or monthly fee. Custom pricing requires a quote.", TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month") + " or " + publishedPriceWords(t, "year")).join("; ")],
        ["Each payment", COMPETITOR_PRICES.whop.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% of each sale").join("; ") + ". Your Stripe processing fees are separate."],
        ["Getting paid", COMPETITOR_PRICES.whop.payoutScope, "Payouts follow your connected Stripe account's schedule and fees. Creator and platform tax obligations still apply."],
        ["Discovery", "A public Discover directory with business search.", "Your store has its own address and sharing links. No comparable discovery directory or guaranteed buyers are offered here."],
        ["Getting started", "Standard payment services are available now, subject to the provider's onboarding and eligibility.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Inspect the store and payment setup", items: [
        { icon: "bank", title: "Your own Stripe account", body: "Read how charges, payouts and refunds use the creator's connected account. This does not remove applicable taxes.", href: "/platform/your-stripe" },
        { icon: "store", title: "Community beside products", body: "Inspect the existing community, courses and product limits before assuming they replace your current setup.", href: "/platform/community" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "Whop has a public discovery directory. Marktmorgen does not promise a comparable audience source or marketplace placement.",
        "Whop Standard has no monthly subscription fee. Marktmorgen uses subscriptions with published limits.",
        "Whop offers several payout methods. Marktmorgen relies on the creator's connected Stripe payout options.",
        "Whop accepts paid business today. Marktmorgen's paid plans remain closed.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. This page does not certify a merchant-of-record arrangement, worldwide tax coverage or net margin for either platform.", items: [
        { icon: "calculator", title: COMPETITOR_PRICES.whop.plans[0].source.label, body: "Card, international, optional-service and payout charges.", href: COMPETITOR_PRICES.whop.plans[0].source.url },
        { icon: "list", title: COMPETITOR_PRICES.whop.discovery.source.label, body: "The actual public directory; inclusion does not promise traffic or sales.", href: COMPETITOR_PRICES.whop.discovery.source.url },
        { icon: "scale", title: "All published comparisons", body: "Read other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "kit",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "Kit",
    intro: "A Kit alternative where email can sit beside courses, memberships and paid calls in a creator's store. Compare list size, sends, payment fees and newsletter tools before moving.",
    seo: { title: "Marktmorgen vs Kit", description: "A Kit alternative where email and products share a creator's store. Compare sourced billing, inclusive commerce fees and newsletter tools. Marktmorgen paid plans remain closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Kit is focused on email publishing. Marktmorgen combines a store with several product types and bounded list-email sends. Existing Marktmorgen templates, sequences and workflow branches remain part of that comparison; a broader product catalog does not make either service the right choice for every newsletter." },
      { kind: "table", title: "Email, billing and commerce", head: ["Compare", "Kit", "Marktmorgen"], note: "USD. Sources read October 20, 2026. Subscriber capacity and monthly sends measure different things; the rows are not equivalent allowances. Processing and taxes still matter.", rows: [
        ["Subscription pricing", COMPETITOR_PRICES.kit.billingScope, TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month") + " or " + publishedPriceWords(t, "year")).join("; ")],
        ["Email allowance", "Free supports up to 10,000 subscribers and unlimited broadcasts. Paid pricing varies by subscriber count.", TIERS.map(t => PLAN_TITLES[t] + ": " + monthlyEmails(t).toLocaleString("en-US") + " list emails/month").join("; ")],
        ["Commerce charges", COMPETITOR_PRICES.kit.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% of each sale").join("; ") + ". Your Stripe processing fees are separate."],
        ["Newsletter discovery", "Creator recommendations, including paid placements, and newsletter sponsorship tools.", "Your store and email links are shareable. This comparison offers no comparable newsletter recommendation or sponsorship network."],
        ["Email experiments", "Subject-line tests on Creator; subject-line and content tests on Pro.", "Two subject lines on a one-off email. This does not test two full email bodies or a sequence."],
        ["Getting started", COMPETITOR_PRICES.kit.trial.days + "-day paid-plan trial; a free plan is also offered.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Inspect the existing email tools", items: [
        { icon: "mail", title: "Marktmorgen email and its limits", body: "Read about broadcasts, four starting templates, sequences, workflow branches, consent and monthly send limits.", href: "/platform/email" },
        { icon: "download", title: "Moving contacts and products", body: "Inspect supported imports and their refusal rules. Imported contacts are not emailed merely because they were imported.", href: "/platform/switching-to-marktmorgen" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "Kit offers a free newsletter plan with unlimited broadcasts within its subscriber limit. Marktmorgen's monthly list-email sends are bounded by plan.",
        "Kit has creator recommendation and newsletter sponsorship networks. Marktmorgen does not promise comparable placements or incoming subscribers.",
        "Kit Pro tests email content as well as subjects. Marktmorgen's one-off email test compares subject lines.",
        "Kit sells paid plans today. Marktmorgen's paid plans remain closed.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. No audience growth, sponsorship income or renewal discount is promised.", items: [
        { icon: "list", title: COMPETITOR_PRICES.kit.plans[0].source.label, body: "Subscriber-based prices, first-year promotion, send allowances, email tests and processing-inclusive commerce fees.", href: COMPETITOR_PRICES.kit.plans[0].source.url },
        { icon: "info", title: COMPETITOR_PRICES.kit.discovery.source.label, body: "How newsletter recommendations and paid placements work.", href: COMPETITOR_PRICES.kit.discovery.source.url },
        { icon: "info", title: COMPETITOR_PRICES.kit.sponsorship.source.label, body: "The sponsorship mechanism and creator choice of ads.", href: COMPETITOR_PRICES.kit.sponsorship.source.url },
        { icon: "scale", title: "All published comparisons", body: "Read other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "circle",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "Circle",
    intro: "A Circle alternative where a community sits beside a creator's store and products. Compare live events, messaging and billing before choosing.",
    seo: { title: "Marktmorgen vs Circle", description: "A Circle alternative where community and products share a creator's store. Compare native live events, messaging and sourced billing terms. Marktmorgen paid plans remain closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Both products have community conversations and private messages. Marktmorgen's existing chat is not missing: its room checks for new messages while active. Compare the kind of conversation and event you need, rather than assuming these work identically." },
      { kind: "table", title: "Community, price and payment terms", head: ["Compare", "Circle", "Marktmorgen"], note: "USD. Sources read October 20, 2026. An annual-billing monthly equivalent is not a monthly purchase option or a verified annual invoice. Taxes and processor charges are separate.", rows: [
        ["Annual-billing display", COMPETITOR_PRICES.circle.plans.map(p => p.name + ": $" + p.annualEquivalentMonthlyCents / 100 + "/month equivalent").join("; ") + ". " + COMPETITOR_PRICES.circle.annualScope, TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "year")).join("; ")],
        ["Monthly subscription", "Current monthly purchase prices not verified here; check Circle's quote.", TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month")).join("; ")],
        ["Platform share and processing", COMPETITOR_PRICES.circle.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% of each sale").join("; ") + ". Stripe processing is separate; direct payments do not remove tax obligations."],
        ["Live events", "Native live streams and interactive rooms, with recording.", "Community events and paid calls use supported external meeting providers. Native broadcasting and recording are not built in."],
        ["Private conversations", "One-to-one and group messages, threads and multimedia.", "Text conversations between two people, with community settings and first-message requests where enabled. This is not Circle's group and multimedia messaging."],
        ["Marketing email", "Email Hub is an optional add-on; the displayed 10,000-contact quote is $99/month above the community plan. Plus includes 10,000 contacts.", TIERS.map(t => PLAN_TITLES[t] + ": " + monthlyEmails(t).toLocaleString("en-US") + " list emails/month").join("; ")],
        ["Getting started", COMPETITOR_PRICES.circle.trial.days + "-day trial.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Inspect the community before moving", items: [
        { icon: "store", title: "Marktmorgen community", body: "Read the existing community features and limits alongside the other products in a store.", href: "/platform/community" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "Circle has native live streams, interactive rooms and recordings. Marktmorgen's events use supported external meeting providers.",
        "Circle messaging supports groups, threads and multimedia. Marktmorgen's private conversations are text between two people.",
        "Circle Plus offers branded iOS and Android listings. Marktmorgen has no app-store listing.",
        "Circle sells paid community plans today. Marktmorgen's paid plans remain closed.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. A missing billing quote remains unknown, not zero.", items: [
        { icon: "list", title: COMPETITOR_PRICES.circle.plans[0].source.label, body: "Annual-billing display, trial, Email Hub and branded-app scope.", href: COMPETITOR_PRICES.circle.plans[0].source.url },
        { icon: "calculator", title: COMPETITOR_PRICES.circle.plans[0].feeSource.label, body: "Platform shares and the separate processor and Billing charges.", href: COMPETITOR_PRICES.circle.plans[0].feeSource.url },
        { icon: "info", title: COMPETITOR_PRICES.circle.live.source.label, body: "Native broadcasting, interactive rooms and recordings.", href: COMPETITOR_PRICES.circle.live.source.url },
        { icon: "info", title: COMPETITOR_PRICES.circle.messaging.source.label, body: "Private, group and multimedia conversations.", href: COMPETITOR_PRICES.circle.messaging.source.url },
        { icon: "scale", title: "All published comparisons", body: "Read the other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "clickfunnels",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "ClickFunnels",
    intro: "A ClickFunnels alternative where a creator's store, products and funnels share a block-based studio. Compare the editor, payment terms and migration limits before moving.",
    seo: { title: "Marktmorgen vs ClickFunnels", description: "A ClickFunnels alternative where store pages and funnels share a block-based studio. Compare prices, page tests and migration limits. Marktmorgen paid plans remain closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Both platforms can use your existing Stripe account, and neither adds a platform share to those payments. That alone is not a reason to move. Compare the design controls, email allowance and what your current funnel needs." },
      { kind: "table", title: "Prices, pages and payment terms", head: ["Compare", "ClickFunnels", "Marktmorgen"], note: "USD. Official sources read October 20, 2026 are linked below. Annual charges are paid yearly; Dominate has no monthly purchase option. Processor and optional-service charges are separate.", rows: [
        ["Monthly subscription", COMPETITOR_PRICES.clickfunnels.plans.map(p => p.name + ": " + (p.monthlyCents === null ? "annual only" : "$" + p.monthlyCents / 100)).join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month")).join("; ")],
        ["Annual subscription", COMPETITOR_PRICES.clickfunnels.plans.map(p => p.name + ": $" + (p.annualCents / 100).toLocaleString("en-US") + "/year").join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "year")).join("; ")],
        ["Platform share and processing", COMPETITOR_PRICES.clickfunnels.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% of each sale").join("; ") + ". Stripe charges its own processing fees."],
        ["Marketing email allowance", "Launch: 50,000; Scale: 300,000; Optimize: 750,000; Dominate: 1,200,000 emails/month.", TIERS.map(t => PLAN_TITLES[t] + ": " + monthlyEmails(t).toLocaleString("en-US") + " list emails/month").join("; ")],
        ["Page editing and migration", "Drag-and-drop page editor and templates.", "Pages use store blocks. The ClickFunnels importer does not preserve the source design, fonts, scripts or templates."],
        ["Page experiments", "A funnel step can have one variant page alongside its original, according to the help guide.", "A headline test or a second version of the whole page, using its own blocks. One test at a time; imported ClickFunnels tests are not carried over."],
        ["Getting started", COMPETITOR_PRICES.clickfunnels.trial.days + "-day trial according to its FAQs.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Check the move before changing platforms", items: [
        { icon: "door", title: "Moving from ClickFunnels", body: "Read the existing guide for contacts, products, past buyers and saved funnel pages, including what the dry run refuses. This comparison is not a replacement migration guide.", href: "/platform/move-from-clickfunnels" },
        { icon: "layout", title: "Inspect Marktmorgen sales pages", body: "See the blocks and limits before assuming they replace your current design controls.", href: "/platform/sales-pages" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "ClickFunnels offers a drag-and-drop page editor and reusable funnel templates. Marktmorgen's importer does not carry over their layouts, custom code or templates.",
        "ClickFunnels publishes larger email-send allowances, starting on Launch. Marktmorgen's Studio and Scale list-email limits are shown in the table.",
        "ClickFunnels sells paid plans now. Marktmorgen's paid plans remain closed, so a prepared store is not an open paid checkout.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. The page-test guide allows one variant per funnel step; it does not support a claim of unlimited simultaneous page variants.", items: [
        { icon: "list", title: COMPETITOR_PRICES.clickfunnels.plans[0].source.label, body: "Monthly and exact annual charges, including annual-only Dominate, and email allowances.", href: COMPETITOR_PRICES.clickfunnels.plans[0].source.url },
        { icon: "calculator", title: COMPETITOR_PRICES.clickfunnels.plans[0].feeSource.label, body: "Existing Stripe accounts, processor fees and optional billing or invoice charges.", href: COMPETITOR_PRICES.clickfunnels.plans[0].feeSource.url },
        { icon: "info", title: COMPETITOR_PRICES.clickfunnels.trial.source.label, body: "Its standard trial and account setup.", href: COMPETITOR_PRICES.clickfunnels.trial.source.url },
        { icon: "layout", title: COMPETITOR_PRICES.clickfunnels.split.source.label, body: "Original and one variant page per funnel step.", href: COMPETITOR_PRICES.clickfunnels.split.source.url },
        { icon: "layout", title: COMPETITOR_PRICES.clickfunnels.editor.source.label, body: "The published editor and platform capabilities.", href: COMPETITOR_PRICES.clickfunnels.editor.source.url },
        { icon: "scale", title: "All published comparisons", body: "Read the other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "skool",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "Skool",
    intro: "A Skool alternative where a community can sit beside products, courses and paid calls in the creator's store. Compare payment fees, live events and discovery before choosing.",
    seo: { title: "Marktmorgen vs Skool", description: "A Skool alternative where community and products share the creator's store. Compare Hobby and Pro fees, native live calls and discovery. Marktmorgen paid selling remains closed." },
    badge: { label: "Sources read October 20, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Marktmorgen starts at " + publishedPriceWords("creator", "month") + "; Skool Hobby is $" + COMPETITOR_PRICES.skool.plans[0].monthlyCents / 100 + " a month. Skool provides its own live-call and discovery tools. Inspect Marktmorgen if you need several product types and direct Stripe charges, rather than assuming either platform is the best fit for every community." },
      { kind: "table", title: "Subscriptions, payment fees and scope", head: ["Compare", "Skool", "Marktmorgen"], note: "USD. Sources read October 20, 2026 are linked below. Skool's listed payment fee is not a separate quote for a Marktmorgen payment: Stripe processing still applies on your own account. Taxes and optional services may add to either side.", rows: [
        ["Monthly subscription", COMPETITOR_PRICES.skool.plans.map(p => p.name + ": $" + p.monthlyCents / 100).join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month")).join("; ")],
        ["Annual billing", COMPETITOR_PRICES.skool.annualScope, TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "year")).join("; ")],
        ["Each paid transaction", COMPETITOR_PRICES.skool.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% to Marktmorgen").join("; ") + ". Your Stripe processing fees are separate."],
        ["Payment account", "Skool processes payments and uses Stripe Express for bank payouts; it is not your existing regular Stripe account.", "Direct charges on your own Stripe account. This does not remove creator or platform tax obligations."],
        ["Discovery and acquisition", "Discovery has eligibility rules. Growth Boost adds 30% on subscriptions it brings, on top of payment fees; it can be turned off.", "Your store has its own address and sharing links. No Skool-style acquisition network is offered by this comparison."],
        ["Community live events", "Native live calls; one-to-many webinars are a Pro feature.", "Community events and paid calls can use supported external meeting providers; this is not native Skool broadcasting."],
        ["Getting started", COMPETITOR_PRICES.skool.trial.days + "-day trial; subscriptions renew until canceled.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Where Marktmorgen may fit", items: [
        { icon: "store", title: "A store with different product types", body: "Inspect courses, memberships and paid calls rather than assuming that every community needs the same setup.", href: "/platform/community" },
        { icon: "bank", title: "Your own Stripe settings", body: "Payments, refunds and payouts use your connected account. Processor terms and applicable tax responsibilities still matter.", href: "/platform/your-stripe" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "Skool has native live calls and Pro webinars. Marktmorgen uses supported external meeting providers for its events and calls.",
        "Skool has a community-discovery directory with eligibility rules. Marktmorgen does not promise a comparable discovery network or a supply of buyers.",
        "Skool offers paid community subscriptions today. Marktmorgen's paid plans are closed; setting up a store does not enable a paid checkout.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 20, 2026. No audience size, webinar capacity or guaranteed results are claimed here.", items: [
        { icon: "list", title: COMPETITOR_PRICES.skool.plans[0].source.label, body: "Hobby and Pro monthly prices; annual billing headline.", href: COMPETITOR_PRICES.skool.plans[0].source.url },
        { icon: "calculator", title: COMPETITOR_PRICES.skool.plans[0].feeSource.label, body: "Transaction bands, the bank-payout account and optional acquisition charges.", href: COMPETITOR_PRICES.skool.plans[0].feeSource.url },
        { icon: "info", title: COMPETITOR_PRICES.skool.trial.source.label, body: "Trial, renewal and cancellation rules.", href: COMPETITOR_PRICES.skool.trial.source.url },
        { icon: "list", title: COMPETITOR_PRICES.skool.discovery.source.label, body: "What makes a group eligible for the directory.", href: COMPETITOR_PRICES.skool.discovery.source.url },
        { icon: "video", title: COMPETITOR_PRICES.skool.live.source.label, body: "Native scheduled or immediate calls.", href: COMPETITOR_PRICES.skool.live.source.url },
        { icon: "video", title: COMPETITOR_PRICES.skool.webinar.source.label, body: "One-to-many webinars on Pro, without an unverified capacity claim.", href: COMPETITOR_PRICES.skool.webinar.source.url },
        { icon: "scale", title: "All published comparisons", body: "Read the other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },
  {
    slug: "comparisons",
    section: "proof",
    eyebrow: "Compare before choosing",
    title: "Compare",
    highlight: "the platforms.",
    intro: "Published prices, payment fees and practical limits, with official sources and an honest account of where another platform is ahead.",
    seo: { title: "Compare Marktmorgen with other creator platforms", description: "Compare Marktmorgen with creator platforms using dated official sources, published prices, practical limits and honest tradeoffs." },
    badge: PROOF,
    accent: "#6d4aff",
    blocks: [
      { kind: "features", title: "Read a comparison", items: [
        { icon: "scale", title: "Marktmorgen vs Kajabi", body: "Plans, email, card fees and branded apps.", href: "/proof/kajabi" },
        { icon: "scale", title: "Marktmorgen vs Skool", body: "Payment fees, native live calls and community discovery.", href: "/proof/skool" },
        { icon: "scale", title: "Marktmorgen vs ClickFunnels", body: "Editor, payment fees and the existing migration guide.", href: "/proof/clickfunnels" },
        { icon: "scale", title: "Marktmorgen vs Circle", body: "Native live events, messaging and billing terms.", href: "/proof/circle" },
        { icon: "scale", title: "Marktmorgen vs Kit", body: "Email allowances, commerce fees and newsletter tools.", href: "/proof/kit" },
        { icon: "scale", title: "Marktmorgen vs Whop", body: "Payment fees, payouts and public discovery.", href: "/proof/whop" },
        { icon: "scale", title: "Marktmorgen vs Hotmart", body: "Current USD fee bands, payment model and distribution tools.", href: "/proof/hotmart" },
        { icon: "scale", title: "Marktmorgen vs HighLevel", body: "CRM, channel costs and agency scope.", href: "/proof/highlevel" },
        { icon: "scale", title: "Marktmorgen vs Teachable", body: "Course catalogs, student experience and processing fees.", href: "/proof/teachable" },
        { icon: "scale", title: "Marktmorgen vs Substack", body: "Publication networks, subscription share and email.", href: "/proof/substack" },
        { icon: "scale", title: "Marktmorgen vs Patreon", body: "Standard versus legacy fees and the fan experience.", href: "/proof/patreon" },
        { icon: "scale", title: "Marktmorgen vs Linktree", body: "Link pages, selling eligibility and conflicting fee quotes.", href: "/proof/linktree" },
        { icon: "scale", title: "Marktmorgen vs Podia", body: "Annual invoices, catalogs and migration help.", href: "/proof/podia" },
        { icon: "scale", title: "Marktmorgen vs Thinkific", body: "Learning products and conditional gateway fees.", href: "/proof/thinkific" },
        { icon: "scale", title: "Marktmorgen vs Systeme.io", body: "Email, funnels and actual plan limits.", href: "/proof/systeme" },
        { icon: "scale", title: "Marktmorgen and Stan", body: "The existing side-by-side comparison and its sources.", href: "/proof/compare" },
        { icon: "calculator", title: "Marktmorgen and Gumroad", body: "Subscription costs, sales fees and tax responsibilities.", href: "/proof/gumroad" },
        { icon: "scale", title: "Marktmorgen and Beacons", body: "Its plans and sales fees, and when they are a better fit.", href: "/proof/beacons" },
      ] },
      { kind: "note", title: "Availability matters as much as price", body: PLANS_ON_SALE ? "Check each plan's limits and the payment provider's own fees before choosing." : "Marktmorgen's paid plans are not on sale yet. You can set up a store and inspect the live demo; these comparisons do not mean paid selling is open." },
    ],
  },
  {
    slug: "kajabi",
    section: "proof",
    eyebrow: "A sourced comparison",
    title: "Marktmorgen vs",
    highlight: "Kajabi",
    intro: "A Kajabi alternative where your store, products and direct Stripe payments share one studio. Compare the published limits as well as the subscription price.",
    seo: { title: "Marktmorgen vs Kajabi", description: "A Kajabi alternative where store setup and direct Stripe payments share one studio. Compare prices, email limits and branded apps. Paid plans are not on sale yet." },
    badge: { label: "Sources read October 19, 2026", tone: "proof" },
    accent: "#6d4aff",
    blocks: [
      { kind: "lead", text: "Choose by the features you need. Marktmorgen starts at " + publishedPriceWords("creator", "month") + "; list email starts on " + PLAN_TITLES.pro + " at " + publishedPriceWords("pro", "month") + ". Kajabi Basic includes marketing email. A lower entry price does not mean every plan is cheaper or every allowance matches." },
      { kind: "table", title: "Prices, limits and payment fees", head: ["Compare", "Kajabi", "Marktmorgen"], note: "USD. Official Kajabi sources were read October 19, 2026 and are linked below. Annual prices require annual payment. Processing, applicable taxes and optional services can add to either side.", rows: [
        ["Monthly subscription", COMPETITOR_PRICES.kajabi.plans.map(p => p.name + ": $" + p.monthlyCents / 100).join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "month")).join("; ")],
        ["Annual subscription", COMPETITOR_PRICES.kajabi.plans.map(p => p.name + ": $" + (p.annualCents / 100).toLocaleString("en-US") + "/year").join("; "), TIERS.map(t => PLAN_TITLES[t] + ": " + publishedPriceWords(t, "year")).join("; ")],
        ["Product catalog", "Basic: 5; Growth: 50; Pro: unlimited.", "Up to " + MAX_PRODUCTS.toLocaleString("en-US") + " products per store. Storage, traffic, order and other plan limits still apply."],
        ["Marketing email", "Unlimited marketing emails on all three plans.", TIERS.map(t => PLAN_TITLES[t] + ": " + monthlyEmails(t).toLocaleString("en-US") + " list emails/month").join("; ") + ". Transactional notices are a separate allowance."],
        ["Platform share and processing", COMPETITOR_PRICES.kajabi.feeScope, TIERS.map(t => PLAN_TITLES[t] + ": " + commissionBps(t) / 100 + "% of each sale").join("; ") + ". Stripe charges its own processing fees on your account; your location and payment method affect them."],
        ["US Kajabi Payments card rates", COMPETITOR_PRICES.kajabi.plans.map(p => p.name + ": " + p.usCardProcessingBps / 100 + "% + $" + (p.usCardProcessingFixedCents / 100).toFixed(2)).join("; "), "Your own Stripe pricing applies; Kajabi's card rates are not a quote for Marktmorgen."],
        ["Branded app-store listing", "Included on Pro; $" + COMPETITOR_PRICES.kajabi.brandedApp.monthlyAddOnCents / 100 + "/month extra on Basic or Growth.", "Browser-based store and studio. No Marktmorgen app-store app."],
        ["Getting started", "Standard " + COMPETITOR_PRICES.kajabi.trial.days + "-day trial; some features require a paid plan.", PLANS_ON_SALE ? "Check the current plan terms before starting." : "Store setup is available. Paid plans and paid selling are not open yet."],
      ] },
      { kind: "features", title: "Where Marktmorgen may fit", items: [
        { icon: "bank", title: "Use your own Stripe account", body: "Direct charges and payouts follow your Stripe settings. This does not remove any tax duties the creator or Marktmorgen has.", href: "/platform/your-stripe" },
        { icon: "store", title: "Inspect the store before deciding", body: "The live demo shows the buyer's route. Compare its behavior with your own product and delivery needs.", href: "/demo" },
      ] },
      { kind: "limits", title: "Where they are ahead", items: [
        "Kajabi offers branded iOS and Android listings, included on Pro or as a paid add-on. Marktmorgen has no app-store app.",
        "Kajabi includes marketing email on Basic and publishes unlimited marketing emails on its plans. Marktmorgen's Store plan has no list email, and Studio and Scale have the monthly send limits above.",
        "Kajabi sells paid plans today. Marktmorgen's paid plans are still closed; a prepared store is not an open paid checkout.",
      ] },
      { kind: "features", title: "Official sources and scope", intro: "Read October 19, 2026. These are public USD quotes, not a negotiated offer or a promise that every payment method is available in every country.", items: [
        { icon: "list", title: COMPETITOR_PRICES.kajabi.plans[0].source.label, body: "Monthly and annual subscriptions, products, marketing email and regional payment-fee conditions.", href: COMPETITOR_PRICES.kajabi.plans[0].source.url },
        { icon: "info", title: COMPETITOR_PRICES.kajabi.trial.source.label, body: "The standard trial is 14 days; its exact term and locked features are described by Kajabi.", href: COMPETITOR_PRICES.kajabi.trial.source.url },
        { icon: "info", title: COMPETITOR_PRICES.kajabi.brandedApp.source.label, body: "Branded listings on Apple App Store and Google Play, plan inclusion and the Basic/Growth add-on.", href: COMPETITOR_PRICES.kajabi.brandedApp.source.url },
        { icon: "scale", title: "All published comparisons", body: "Read the other comparisons and their own dated sources.", href: "/proof/comparisons" },
      ] },
    ],
  },

  /* ------------------------------------------------ proof ------------- */
  {
    slug: "compare",
    section: "proof",
    eyebrow: "Proof",
    title: "Side by side",
    highlight: "with Stan",
    intro:
      "Checked on Stan's own pricing, terms and help center in September 2026. When it changes, this page changes.",
    badge: PROOF,
    accent: "from-violet-brand to-pink-brand",
    blocks: [
      {
        kind: "features",
        title: "The short version",
        intro: "Four lines before the long table. Every one of them is backed by a row below or on the feature-by-feature page, with its source.",
        items: [
          { icon: "bank", title: "Where we are ahead: the money", body: "Sales land in a full Stripe account in your own name, with its own login and payout schedule. Stan's creators get an account Stan manages, and cash out inside Stan." },
          { icon: "tag", title: `Where we are ahead: the ${PLAN_AT.creator} plan`, body: "Several prices on one product, discount codes in percent or dollars, sales and landing pages, offers before and after paying, payment plans, ad pixels and an affiliate program, most of which Stan keeps for its $99 plan. And pay what you want, free trials on memberships, reviews only buyers can write, 15 currencies, a team with roles, bundles that hand over each product as itself, and past buyers brought over from a file, none of which Stan's help center describes. Since September 30: one search box across the whole community, a public API, an offer made once to a member who presses Cancel, and points, levels and a leaderboard in the community, with a course handed over at a level, none of which Stan's help center describes either." },
          { icon: "scale", ...feeWords().sameAsStan },
          { icon: "info", title: "Where Stan is ahead", body: `${PAYPAL ? "" : "PayPal at checkout, "}${STAN_AFFILIATES_AHEAD}, automatic Instagram replies, Zoom links made for each booking and webinar, an iPhone app, and as many products as you like where we stop at 2,000. If you need those today, Stan is the better tool today.` },
        ],
      },
      {
        kind: "table",
        title: "The part that decides",
        note: "Sources: Stan's help center articles 'Creator vs. Creator Pro', 'How to Connect Stan with Stripe', 'How to Cash Out Inside Stan', 'Experiment: How to Connect an Existing Stripe Account' and 'How to Subscribe on the Stan Mobile App', read on September 18, 2026; 'Can I Create More Than One Stan Store?' and 'How to Change Your Stan Username or Email', read on September 19, 2026. The rows on products, prices, trials and the customer area re-checked on Stan's help center on September 26, 2026; 'Can I Create More Than One Stan Store?' re-read, and 'Can I Grant Administrative Access to a Team Member?' and 'How Can I Add My Customer Reviews?' read on September 27, 2026, and the rows on ways to pay and currency re-checked the same day. The rows on live events, bundles and moving from another platform from 'How to Add an Integrated Webinar to Community', 'Webinar Product', the Digital Downloads category, 'How to Import Your Existing Email List into Stan' and 'How Do I Manually Give Access or Add a Customer to a Product?', read on September 27, 2026. Stan's 14-day free trial from their article 'Stan Store Pricing 2026', read on September 28, 2026, the same day every other row was re-checked on their help center and the rows on the line about you and the customer area were corrected from 'How to Add or Update Your Profile Bio' and 'Common Feature Requests On Our Radar'. The row on inviting other creators from 'What is Stan's Referral Program?', read on September 30, 2026.",
        head: ["", "Stan", "Marktmorgen"],
        rows: [
          ["Monthly price", "$29 and $99, free for the first 14 days", monthlyRow()],
          ["Paid yearly", "$300 and $948 a year", yearlyRow()],
          ["Cut of each sale", "0% platform fee", feeWords().short],
          ["Logging in", "An account with a password. Their own signup asks for name, email and password", "A link sent to your email, or a passkey if you add one. No password to invent, and none kept here to be stolen"],
          ["Ways to be paid", "Stripe or PayPal, for every creator", PAYPAL ? "Stripe or PayPal, both paying straight into your own account, with the ways to pay you switch on in Stripe: cards, Apple Pay, Google Pay, Link, Klarna, Afterpay, Affirm, iDEAL and more" : `Stripe, with the ways to pay you switch on in it: cards, Apple Pay, Google Pay, Link, Klarna, Afterpay, Affirm, iDEAL and more. ${PAYPAL_NOT_YET}`],
          ["Currency", "One per store, chosen from ten", "Any one of 15 per store, from US dollars and euros to yen and Mexican pesos"],
          ["Whose Stripe account", "One they manage. Their own help center: you cannot connect an existing Stripe account", "A full Stripe account in your own name, opened from your studio, with its own Stripe login. It stays yours"],
          ["Getting paid", "Cash out inside Stan, $10 minimum, whole balance only", "Your own Stripe payout schedule"],
          ["Where you see your money", "Their Income tab. A Stripe Custom account has no Stripe login", "stripe.com, like any other business of yours"],
          ["Phone app", "iPhone and iPad, for running your store. Not on Android", "No app-store app — they are ahead here. The studio installs from the browser and sends notifications of sales and bookings, on Android and on iPhone with iOS 16.4 or later. Each store installs to the home screen on both, as an app with its own name and icon"],
          ["Products on one store", "As many as you like", "Up to 2,000, and up to 100 links — they are ahead here"],
          ["Several prices for one product", "Listed as a top feature request, not available", "Up to 50, compared side by side, each with its own file or link"],
          ["Pay what you want", "Not in their help center", `Yes: a minimum of at least $1 and a suggested price, on the ${PLAN_AT.creator} plan`],
          ["Free trial on a membership", "Not in their help center", "1 to 90 days, with the card taken at the start and nothing charged until it ends"],
          ["A line about you on the page", "A short profile bio, and no separate About Me page", "On every store, under your name"],
          ["Your own domain", "Not available", DOMAINS ? `Yes, on the ${PLAN_AT.pro} Studio plan, with the certificate handled for you` : "Not available"],
          ["Changing your store address", "Any time. Their help center says old links are forwarded on a best-effort basis, cannot be guaranteed, and advises resending them", "Any time. Old addresses stay with the store and keep working until you choose to let one go. A store holds up to 10 addresses at once, its current one included"],
          ["Customer area for all purchases", "A login for courses only. Other purchases show in a Purchases tab inside the creator's community, if there is one","A buyer's purchases from a store, up to the 40 most recent, listed on one page the buyer reaches with an emailed link: downloads, links, courses and booked calls. No account and no password"],
          ["Several stores in one account", "Not in one account. Several accounts, each with its own email and its own subscription", "Up to five in one account, each with its own address, Stripe account and plan"],
          ["Inviting other creators", "20% of each payment they make, in cash through Stripe or PayPal, for as long as they stay subscribed, 3 to 5 days after each renewal once their 14-day trial ends, and only while you pay Stan too. No bonus for the creator you invite in their help center", INVITE_PROGRAM_OPEN ? `${INVITE_SHARE_PERCENT}% of each payment they make, for as long as they pay, as credit on your own plan \u2014 not cash \u2014 added ${INVITE_HOLD_DAYS} days after each payment. The creator you invite gets ${INVITE_BONUS} of credit after their first payment` : INVITE_PAUSE_NOTICE],
          ["A team with roles", "Not for the store: their help center says the only way to give someone admin access is to share your login. Admins and moderators exist inside the community only", "Up to five people per store, as Admin, Editor or Support, each signing in with their own email, checked on our server, with an activity log"],
          ["Reviews", "Added by the creator. Their help center says customers cannot write one", "Written only by buyers whose payment your Stripe account confirms. You can answer or hide one, never edit or delete it; hidden reviews still count in the average, and a full refund takes the stars out"],
          ["Live events in the community", "Webinars added to the community as a product members sign up for, with Zoom or Google Meet links made automatically", "Live events members RSVP to, with a cap of 1 to 5,000, reminders, a private Jitsi Meet room shown on the page, your own link or a Google Meet made on your connected Google Calendar, and replays. No Zoom link made for you yet — they are ahead there"],
          ["Bundles", "Their Digital Downloads help section lists bundles among the files you can sell as one download. No product type that hands over other products in their help center", "2 to 20 of your one-off products at one price, each delivered as itself: its download or link, its course and its license key. Not with memberships or calls"],
          ["Moving from another platform", "A list of up to 5,000 imported contacts per store in all, each sent an email to opt in again. Buyers given access one at a time", "Up to 50,000 contacts a file, only people you confirm agreed; up to 500 products a file, as drafts; and up to 20,000 past buyers a file, who keep what they bought, with one email to them if you choose"],
        ],
      },
      {
        kind: "quote",
        text: "In order to use Stripe with Stan, you will be prompted to create a new Custom Stripe account that is managed by Stan. You will not be able to connect an existing Stripe account.",
        source: "Stan help center, 'How to Connect Stan with Stripe', read September 18, 2026",
      },
      {
        kind: "note",
        title: "One correction to that, from their own help center",
        body: "Stan is running an experiment that does let some creators connect a Stripe account they already own. Their article says it is open only to a share of new creators who signed up after May 1, 2025 and go through onboarding on a phone browser, and it warns that if you use it, Stan's own Income tab may not show your earnings correctly. So it exists, it is not the normal path, and it costs you part of their product.",
      },
      {
        kind: "note",
        title: "Where Stan is ahead, and we say so",
        body: `Stan has things we do not: ${PAYPAL ? "" : "PayPal at checkout, "}${STAN_AFFILIATES_AHEAD}, automatic Instagram replies, Zoom links made for each booking and webinar, an app for iPhone and iPad, stores with no limit on products, and a support team with years of experience behind it. We now have a community with live events, an affiliate program paid from your own PayPal in one press, sales and landing pages, offers after paying, Google Meet links made on your own Google Calendar and a private video room for each booking and event, but none of those. If you depend on them today, Stan is the better tool today.`,
      },
    ],
  },
  {
    slug: "gumroad",
    section: "proof",
    eyebrow: "Proof",
    title: "Side by side",
    highlight: "with Gumroad",
    intro:
      "Fees checked against Gumroad’s pricing page and official help text on October 16, 2026. Other operational details below were checked in September 2026 and may change; confirm eligibility and terms before switching.",
    badge: PROOF,
    accent: "from-mint-brand to-violet-brand",
    blocks: [
      {
        kind: "lead",
        text: "Gumroad is one of the oldest and simplest ways to sell a file on the internet, and for a first sale it is hard to beat: nothing to pay until you sell something. The difference between the two of us is not the store page. It is what happens to the money.",
      },
      {
        kind: "facts",
        title: "Gumroad's own numbers",
        items: [
          { value: "10% + $0.50", label: "Standard direct-sale fee, before separate processing", tone: "bg-pink-brand/10 text-pink-brand" },
          { value: "30%", label: "Discover fee, including payment processing", tone: "bg-amber-brand/15 text-amber-brand" },
          { value: "$100", label: "Minimum balance before they pay you", tone: "bg-violet-brand/10 text-violet-deep" },
          { value: "7 days", label: "A sale waits in their balance on weekly, monthly and quarterly payouts", tone: "bg-sky-brand/15 text-sky-brand" },
        ],
      },
      {
        kind: "table",
        title: "The part that decides",
        note: "Sources: Gumroad's pricing page and their help center articles 'Gumroad's fees', 'Getting paid by Gumroad', 'Connect your Stripe account to Gumroad' and 'Sales tax on Gumroad', read on September 28, 2026. Direct, Discover and high-volume fee conditions re-checked on October 16, 2026.",
        head: ["", "Gumroad", "Marktmorgen"],
        rows: [
          ["Cut of each sale", "10% + $0.50 direct; new direct sales become 5% + $0.50 after $20,000 in paid sales that calendar month. Discover: 30%. Custom account fees can differ", feeWords().short],
          ["Card fee on top of that", "Direct sales add card processing at 2.9% + $0.30, or PayPal fees. Discover’s 30% includes processing", "Stripe processing fees, plus the published plan share"],
          ["Monthly price", "None", monthlyRow()],
          ["Whose payment account", "Gumroad is the merchant of record. New connections to a seller’s own Stripe are restricted; check current country eligibility", "Your own Stripe, from the first sale"],
          ["When the money reaches you", "Into their balance, then paid out on the schedule you pick there, with a 7-day hold on weekly, monthly and quarterly payouts", "In your own Stripe balance at the moment of sale, then paid out on your Stripe schedule"],
          ["Minimum to be paid", "$100, higher in some countries", "Whatever your own Stripe is set to"],
          ["Instant payout", "United States only, 3% fee, after a first payout and 60 days of processing", "Not needed — the account is already yours"],
          ["Disputes", "They handle them for you", "Yours, in your own dashboard"],
          ["Who is the seller of record", "Gumroad. They are the merchant of record on every sale", "You are. The charge is on your account, in your name"],
          ["Sales tax, VAT and GST", "They collect and remit it worldwide, according to their own help center", "Worked out and collected by Stripe Tax on your own account, when you switch it on. Filing it is yours, because you are the seller"],
          ["A marketplace that sends buyers", "Discover, at 30% of the sale", "None"],
          ["Several prices for one product", "Versions and pay-what-you-want", "Price options and pay what you want, both working today"],
        ],
      },
      {
        kind: "quote",
        text: "We no longer support new user-connected Stripe accounts except for users from Brazil.",
        source: "Gumroad help center, 'Connect your Stripe account to Gumroad', read September 18, 2026",
      },
      {
        kind: "steps",
        title: "A $27 direct-sale example before the volume discount",
        items: [
          { title: "On Gumroad", body: "10% of $27 is $2.70, plus $0.50, so $3.20 goes to Gumroad. Their own fees page says that figure does not include credit card processing, so card processing at 2.9% + $0.30 — about $1.08 — comes out as well. You keep $22.72." },
          { title: "On Marktmorgen", body: feeWords().gumroad.ours },
          { title: "The honest break-even", body: feeWords().gumroad.evenOut },
          { title: "At a hundred sales", body: feeWords().gumroad.hundred },
        ],
      },
      {
        kind: "note",
        title: "Compare the work behind each payment",
        body: "Gumroad includes merchant-of-record administration for the indirect taxes it is responsible for. With Marktmorgen, you remain the seller and manage your own payment account and applicable registrations and filings. Compare those responsibilities as well as the subscription, sales share and payment fees. The example excludes refunds, currency conversion and other account-specific charges.",
      },
      {
        kind: "note",
        title: "Where Gumroad is ahead of us today",
        body: `A marketplace that can send you buyers;${DOMAINS ? "" : " your own domain;"} a Zapier app; and a mobile app. We have none of those. We now have fair prices by country (their purchasing power parity, worked out the same way), affiliates (paid from your own PayPal, not by us), license keys, PDF stamping and reviews from buyers, webhooks that Zapier can catch instead of an app of our own, and a public API, which on our side reads and changes nothing. Email to your list we have on our ${PLAN_AT.pro} Studio plan; Gumroad includes it at no extra charge. They have been doing this since 2011 and it shows.`,
      },
    ],
  },
  {
    slug: "beacons",
    section: "proof",
    eyebrow: "Proof",
    title: "Side by side",
    highlight: "with Beacons",
    intro:
      "Every number here was read on Beacons' own pricing page and help center in September 2026, and the page says where each one came from. When they change one, this page changes.",
    badge: PROOF,
    accent: "from-sky-brand to-violet-brand",
    blocks: [
      {
        kind: "lead",
        text: "Beacons is the closest competitor to us on the one thing we care most about: the money goes straight into the seller's own Stripe or PayPal account, at the moment of the sale. Their help center is explicit about it. So the argument between us is not custody. It is the 9%, and what it costs to make it stop.",
      },
      {
        kind: "facts",
        title: "Beacons' own numbers",
        items: [
          { value: "9%", label: "Their cut on the free plan and the $10 plan", tone: "bg-pink-brand/10 text-pink-brand" },
          { value: "$30", label: "The monthly plan where their cut becomes 0%", tone: "bg-violet-brand/10 text-violet-deep" },
          { value: "2.9% + $0.30", label: "Stripe's own fee, charged on top of theirs", tone: "bg-amber-brand/15 text-amber-brand" },
          { value: "$0", label: "Their free plan really is free to start", tone: "bg-mint-brand/15 text-mint-deep" },
        ],
      },
      {
        kind: "table",
        title: "The part that decides",
        note: "Sources: Beacons' pricing page and their help center articles 'Beacons Products Transaction Fees' and 'When will I receive my payout from Product/Store Sales?', read on September 18, 2026. Plan prices, the fee quoted below and the rows on order bumps, memberships and courses re-checked on their pricing page and help center on September 28, 2026.",
        head: ["", "Beacons", "Marktmorgen"],
        rows: [
          ["Cut of each sale", "9% on the free and $10 plans. 0% from the $30 plan up", feeWords().short],
          ["Monthly price", "$0, $10, $30 and $100", monthlyRow()],
          ["Whose payment account", "Your own Stripe or PayPal", "Your own Stripe"],
          ["Ways to be paid", "Stripe or PayPal", PAYPAL ? "Stripe or PayPal, both paying straight into your own account" : `Stripe, with the ways to pay you switch on in it. ${PAYPAL_NOT_YET}`],
          ["When the money reaches you", "At the moment of sale, into your own account", "At the moment of sale, into your own account"],
          ["Card fee", "Stripe's 2.9% + $0.30, on top of their 9%", "Stripe processing fees, plus the published plan share"],
          ["What you are buying", "A whole suite: link in bio, websites, media kit, email, an affiliate network, AI tools", "One store, built to sell: files, courses, memberships, calls, a community for your buyers, and a media kit for brands"],
          ["A free plan", "Yes, and you can sell on it", "None"],
          ["Order bumps and upsells", "Order bumps on every plan, the free one included", "Yes \u2014 up to three boxes the buyer checks at checkout, and one click after paying on the same card"],
          ["Memberships and courses", "Memberships from the $30 plan. Courses on every plan, but only one, with no video hosting, below the $30 plan", `Yes, both, on the ${PLAN_AT.creator} plan`],
        ],
      },
      {
        kind: "quote",
        text: "The 9% fee applies to users on the free plan or the $10/month Creator plan.",
        source: "Beacons help center, 'Beacons Products Transaction Fees', read September 18, 2026",
      },
      {
        kind: "steps",
        title: "The same $27 file, on both",
        items: [
          { title: "On their free or $10 plan", body: "9% of $27 is $2.43, and Stripe takes about $1.08 on top. You keep $23.49." },
          { title: "On their $30 plan", body: "Their cut is 0%, Stripe still takes about $1.08, so you keep $25.92 — and you pay $30 that month." },
          { title: "On Marktmorgen", body: feeWords().beacons.ours },
          { title: "The honest break-even", body: feeWords().beacons.evenOut },
        ],
      },
      {
        kind: "note",
        title: "Where Beacons is ahead of us, and it is not close",
        body: `For $30 they give you 0% and, with it, websites, a media kit that updates itself, email marketing, an affiliate network of 12,000 brands and a pile of AI tools. We give you a store page with courses, memberships, calls, a community, an affiliate program of your own, the checkout tools and a media kit whose numbers you type yourself, and on our ${PLAN_AT.pro} Studio plan email to your list, but none of the other extras. Compare the subscription and sales fee together; the cheaper option depends on your sales.`,
      },
      {
        kind: "note",
        title: "So when should you not use us?",
        body: "If you are selling a handful of files a month, take their free plan: 9% of almost nothing is cheaper than any monthly price, ours included. And if you want the whole suite in one login, buy their $30 plan. Come to us when what you want is a fast, focused store page that pays into your own account, and you would rather not run a suite to get it.",
      },
    ],
  },
  {
    slug: "speed",
    section: "proof",
    eyebrow: "Proof",
    title: "A slow store is",
    highlight: "a store people leave",
    intro:
      "Measured with Google PageSpeed Insights on a simulated phone, on October 5, 2026. You can run the same test yourself on any store, ours included.",
    badge: PROOF,
    accent: "from-sky-brand to-mint-brand",
    blocks: [
      {
        kind: "facts",
        title: "Performance score on mobile",
        items: [
          { value: "93–94", label: "Marktmorgen demo store, measured twice", tone: "bg-mint-brand text-ink" },
          { value: "58–59", label: "Two Stan stores, measured the same day", tone: "bg-ink text-white" },
          { value: "46", label: "A third Stan store, same test", tone: "bg-ink text-white" },
        ],
      },
      {
        kind: "steps",
        title: "How the test was run",
        items: [
          { title: "Same tool for everyone", body: "Google PageSpeed Insights, mobile, simulated slow 4G, Lighthouse 13.5.0." },
          { title: "Stan stores from Stan's own list", body: "Three public stores of creators Stan named in its \"25 in 25\" winners post: the first on the list and every sixth after it. Measured on the same day, one run each." },
          { title: "Our store measured twice", body: "Because the score moves a few points between runs. It scored 93 and 94." },
          { title: "A real store, with its photos", body: `The demo store was measured as an ordinary store on the ${PLAN_AT.creator} plan, drawn by the same pages as every creator's, with a portrait and a product picture on it. Since October 17, 2026 it is on the ${PLAN_AT.pro} plan, so it can show the AI features too; it has not been measured on it yet. A store with more or heavier pictures can score lower.` },
          { title: "The number we retired", body: "Until October 5, 2026 this page said 97 to 100. That was measured on September 17 on an earlier demo, a simpler page with no photos that was not built the way a store is. It is gone, and so is its score." },
        ],
      },
      {
        kind: "note",
        title: "Why it is money, not vanity",
        body: "The buyer opens your link inside Instagram, on a phone, on mobile data. Every second of loading is a share of that traffic that never sees the price.",
      },
    ],
  },
  {
    slug: "promises",
    section: "proof",
    eyebrow: "Proof",
    title: "What we will",
    highlight: "never do to you",
    intro:
      "Every line here answers a complaint creators have published about platforms in this market. They are commitments, written before we have customers, so you can hold us to them.",
    badge: PROOF,
    accent: "from-amber-brand to-pink-brand",
    blocks: [
      {
        kind: "lead",
        text: "We read hundreds of public reviews and complaints from creators about the platforms they use to sell. The same failures come back again and again. This is our answer to each one.",
      },
      {
        kind: "cards",
        title: "The commitments",
        items: [
          { emoji: "🏦", title: "We never hold your sales", body: "Your money is charged on your own Stripe account, so there is no Marktmorgen balance to freeze, delay or set a minimum on.", tint: "bg-mint-brand/15 text-mint-deep" },
          { emoji: "🙋", title: "A person answers you", body: "Support is a human writing back. No chatbot standing between you and your money.", tint: "bg-violet-brand/10 text-violet-deep" },
          { emoji: "🚪", title: "You can always leave", body: "Download your sales history, with each buyer's email address, and your email list as files whenever you want, free, without asking us.", tint: "bg-sky-brand/15 text-sky-brand" },
          { emoji: "🌐", title: "Your domain stays yours", body: "If you bring a domain, you remain the owner of it and keep access to its settings. No exit fee.", tint: "bg-pink-brand/10 text-pink-brand" },
          { emoji: "✉️", title: "Your list is yours", body: "Your buyers are on your own Stripe account, and the addresses your free products collect download as a CSV from your studio whenever you like. The price does not go up as the list grows.", tint: "bg-amber-brand/15 text-amber-brand" },
          { emoji: "📜", title: "No silent changes", body: "Price and rule changes are announced in advance, in writing, and never applied retroactively to money already earned.", tint: "bg-violet-brand/10 text-violet-deep" },
          { emoji: "🔌", title: "No surprise shutdown", body: "If your account ever has to be paused, you get the reason in writing and a way to answer before the store goes dark, unless the law or an urgent risk to buyers means acting at once.", tint: "bg-mint-brand/15 text-mint-deep" },
          { emoji: "🧾", title: "One line for the real cost", body: "The subscription, plus Stripe's own fees shown as Stripe charges them. No fee that only appears on the statement.", tint: "bg-pink-brand/10 text-pink-brand" },
        ],
      },
      {
        kind: "note",
        title: "Where these came from",
        body: "Public reviews and complaints from creators on Trustpilot, G2, Capterra, the Better Business Bureau, app stores and creator blogs, about Stan, Beacons, Linktree, Gumroad, Payhip, Kajabi and Podia, read in September 2026. We are not repeating the accusations here; we are answering the pattern.",
      },
      {
        kind: "note",
        title: "What we cannot promise yet",
        body: "We cannot promise a support team that answers at three in the morning, or a feature list as long as that of a platform with years of work behind it. We can promise that a person answers, and that everything listed as working really works.",
      },
    ],
  },
  {
    slug: "everything",
    section: "proof",
    eyebrow: "Proof",
    title: "Feature by feature,",
    highlight: "against Stan",
    intro:
      "Everything Stan publicly offers, and exactly where Marktmorgen stands on each line. Stan's side was read from its own help center, app store listings and blog on September 17, 2026; the rows on the store, what you can sell, checkout and marketing were re-checked on its help center on September 26, and the rows on stores, teams, reviews, calls, ways to pay, currency, funnels, email platforms, webinars, bundles and imports on September 27. On September 28, the rows were read against its help center again, and the rows on the line about you, sales pages, teams, physical products and quizzes were corrected. The row on inviting other creators was read from Stan's referral program article on September 30, the row on packages of sessions from its coaching call article the same day, and the row on members switching plans from its article on membership prices. Everything in the Marktmorgen column works today; nothing there is a promise.",
    badge: PROOF,
    accent: "from-violet-brand to-mint-brand",
    blocks: [
      {
        kind: "lead",
        text: "The goal is to offer everything Stan offers and more. This page is the scoreboard for that goal, and it is deliberately uncomfortable: every line where we do not have something says so, in the same size of type as the lines where we do.",
      },
      {
        kind: "table",
        title: "Apps and devices",
        note: "Stan's help center, article 406, read September 17, 2026: the Stan app is \u201ccurrently only available on iPhone and iPad through the iOS App Store.\u201d",
        head: ["", "Stan", "Marktmorgen"],
        rows: [
          ["iPhone app", "Yes \u2014 a creator app, rated 4.9 stars on the App Store", "Not available \u2014 Stan is ahead here. The studio installs to the home screen instead, and sends notifications of sales and bookings on iOS 16.4 or later"],
          ["Android app", "No \u2014 none, by their own documentation", "Not available. The studio installs to the home screen instead, and sends notifications of sales and bookings"],
          ["Buyer app", "Yes, on iPhone only: the Stan Community app, for members of a creator's community", "No app-store app. Each store installs to the home screen on both phones as an app of its own, with the store's name, icon and color"],
          ["Annual plan inside the app", "Not possible \u2014 browser only", "Same price on every device"],
          ["Add to home screen", "Not advertised", "Yes, on Android and iPhone: the studio, with notifications, and every store as its own app"],
        ],
      },
      {
        kind: "table",
        title: "The store",
        head: ["", "Stan", "Marktmorgen"],
        rows: [
          ["Store page on a phone", "Yes", "Yes, and faster (93\u201394 against 46\u201359 on PageSpeed, October 5, 2026)"],
          ["Themes and colors", "Yes, limited", "Yes \u2014 four themes, ten colors or any color of your own, five pairings of letters, and your photo. Every color is checked for contrast before your page uses it"],
          ["A line about you on the page", "A short profile bio, and no separate About Me page", "Every store, under your name"],
          ["Products on one store", "No numeric cap stated", "Up to 2,000 products and 100 links, 24 products a page on the store and search in your studio — Stan is ahead here"],
          ["Sections on the store", "Yes — named sections, dragged into order and hidden when empty (their help center, read October 7, 2026)", "Yes — up to 20 headings, each starting at a product you pick, and one line of your own news across the top"],
          ["Product pictures", "Yes — thumbnails shown as Button, Callout or Preview", "Yes — a picture on each product, shown as Button, Callout or Preview, the same three"],
          ["Several prices for one product", "Not available", "Up to 50 on one product, each with its own file or link, compared side by side with one marked as your pick"],
          ["Sales pages for a product", "A checkout page for each product, with a description and a video, which can be made a private landing page on every plan. Funnels of several pages on the $99 plan", `Yes, on the ${PLAN_AT.creator} plan: up to 30 blocks per product \u2014 hero, video from YouTube, Vimeo or Loom, your own pictures, benefits, what is inside, who it is and is not for, how it works, a comparison table, bonuses, numbers counted by the store, about you, questions, guarantee, a countdown to a real deadline, buttons and reviews, from six templates or an AI draft (on ${AI_PLANS_WORDS}) \u2014 with its own search title and description and a share picture drawn for it`],
          ["Reviews", "Added by the creator. Their help center says customers cannot write one", "Written only by paying buyers, checked on your Stripe account. You can answer or hide one, never edit or delete it; hidden reviews still count in the average, and a full refund takes the stars out"],
          ["Your own domain", "Not available", DOMAINS ? `Yes, on the ${PLAN_AT.pro} Studio plan, with the certificate handled for you` : "Not available"],
          ["Custom code on the page", "Explicitly not supported", "Not available"],
          ["Selling on your own website", "Not available: the checkout is only at stan.store/<name>", "One product at a time, as a card with its picture, price, rating and buy button that opens Stripe's checkout in a new tab, or as a plain button in your color. Pasted into any page that takes HTML. The whole store cannot be put inside another site"],
          ["Several stores in one account", "Not in one account. Several accounts, each with its own email and its own subscription", "Up to five in one account, each with its own address, Stripe account and plan, switched at the top of the studio"],
          ["A team with roles", "Not for the store: their help center says the only way to give someone admin access is to share your login. Admins and moderators exist inside the community only", "Up to five people per store, as Admin, Editor or Support, each signing in with their own email, checked on our server, with an activity log"],
        ],
      },
      {
        kind: "table",
        title: "What you can sell",
        head: ["", "Stan", "Marktmorgen"],
        rows: [
          ["Digital downloads", "Yes, up to 5 GB", "Yes, up to 5 GB"],
          ["Selling something bigger", "Their help center: host it on Google Drive or Dropbox and use Redirect to URL", "Sell it as a link. Same escape hatch, and we say so on the product itself"],
          ["How much your buyers may download", "No figure in their help center", "200 GB a month, published, and shown in your account as it is used"],
          ["Courses with drip and analytics", "Yes", "Yes \u2014 modules, videos up to 5 GB that stay upright when filmed upright, text, downloads, free preview lessons, modules that open over time with an email to the student, and each student's progress"],
          ["Memberships and subscriptions", "Yes \u2014 daily, weekly, monthly, annually, and can end after a set number of payments. No free trial in their help center", "Yes \u2014 daily, weekly, monthly, yearly, on your own Stripe, with a free trial of 1 to 90 days and an end after 2 to 36 payments if you want them. Members cancel on their own, through Stripe, without writing to you, and files, courses and the community close when a membership ends"],
          ["Members switching plans", "Not in their help center: existing members stay at the price they bought at (article 132, read September 30, 2026)", "Yes \u2014 2 to 6 memberships as tiers; members move up or down on their own, see Stripe's exact amount first, pay the difference at once or get a credit on their next payments, and what each plan includes opens and closes with it"],
          ["An offer when a member cancels", "Not in their help center, read September 30, 2026", `Yes, on the ${PLAN_AT.creator} plan: a discount you choose, 10% to 50% off one to three payments, offered once per membership on Stripe's own cancellation page and declined in one press. An offer of more than one payment only on memberships charged monthly`],
          ["A come-back offer after a member leaves", "Not in their help center, read September 30, 2026", `Yes, on the ${PLAN_AT.creator} plan: one email 3 to 21 days after a membership ends, with 10% to 50% off one to three payments, only to former members who agreed to hear from you and have not come back, and a link that opens your checkout with the discount applied`],
          ["When a member's card fails", "Reminders for payment plans, by their help center", `One email per failed renewal, on the ${PLAN_AT.creator} plan, with a link that pays it and makes the card that worked the one used next time. It says when the card is tried again, or that it will not be`],
          ["Video link for each booking", "Yes \u2014 Zoom or Google Meet links created automatically", "Google Meet links made automatically once you connect your Google Calendar, or your own meeting link, or a private Jitsi Meet room made for each booking. The first person in a Jitsi room may be asked to sign in to Jitsi to start it. No Zoom link is made for you yet \u2014 Stan is ahead on Zoom"],
          ["Coaching calls with a calendar", "Yes \u2014 with Google Calendar and reminder emails", "Yes \u2014 your hours in your time zone, times shown to each buyer in theirs, held while they pay, an email about each booking to the buyer and to you, reminders a day and an hour before when the booking leaves time for them, and buyers who move their own booking up to twice. Busy times in up to three Google, Outlook or iCloud calendars hide call times; bookings reach your calendar as a feed you subscribe to, and only calls set to Google Meet are written into your connected Google Calendar as events"],
          ["Group calls", "Yes \u2014 a maximum number of attendees", "Yes \u2014 1 to 50 people per time slot, with the seats left shown to buyers"],
          ["Packages of sessions", "Not in their help center: a coaching call product books one call per purchase (article 15, read September 30, 2026)", "Yes \u2014 2 to 20 sessions of a weekly call at one price, with a time limit you choose or none, paid once and booked one at a time from the buyer's own link, each with the reminders, meeting link and moves of any booking. Not for live sessions on dates"],
          ["Live webinars", "Yes", "Yes \u2014 live sessions on dates you set, up to 50 dates per product and 1 to 500 seats each, held in a Google Meet made on your connected Google Calendar, on the meeting service whose link you give, or in a Jitsi Meet room made for each session. And free live events for your community's members. No streaming or recording built in"],
          ["Lead magnets", "Yes", "Yes \u2014 anything priced at 0 is given for an email address, each address confirmed by its owner, and the list downloads as a CSV at any time"],
          ["Community", "Yes, one per account, with webinars inside it", `Yes, one per store, on the ${PLAN_AT.creator} plan: up to 20 spaces, each for the whole community or for the buyers of some products, posts with a picture that can be edited, polls, comments, likes, @mentions, pinned posts, a live room, private messages, notifications on a computer or phone, an opt-in member directory, reports and moderation, open only to the buyers you choose. Announcements by email on Studio`],
          ["Questions and a welcome for new members", "Not among the community features in their help center, read September 30, 2026", `Yes, on the ${PLAN_AT.creator} plan: up to three questions every member answers once before their first post or comment, read only by you, and a welcome message sent privately from you on their first visit`],
          ["Points, levels and a leaderboard", "Not in their help center, read September 30, 2026", `Yes, on the ${PLAN_AT.creator} plan: one point for every like a member's post or comment gets, 9 levels shown beside every name, a leaderboard for 7 days, 30 days and all time, spaces that open for posting at a level, and a course of yours handed over free at a level`],
          ["Search in the community", "Not in their help center, read September 30, 2026", "Yes — one box across posts and comments, course lessons, events, the member directory, the room and a member's own messages, each result shown only to somebody who may open it. What is said inside a video is not searched"],
          ["Webinars inside the community", "Yes \u2014 a webinar product added to the community, which members sign up for on its landing page, with Zoom or Google Meet links made automatically", "Yes \u2014 live events: up to 50 coming up, RSVPs with a cap of 1 to 5,000, the way in on the event's page from 15 minutes before, in a private Jitsi Meet room shown on the page, at your own link or in a Google Meet made on your connected Google Calendar, reminders a day and an hour before, emails when one moves or is canceled, and replays from YouTube, Vimeo or Loom. Free to members, not sold on its own, and no Zoom link made for you yet \u2014 Stan is ahead there"],
          ["Bundles", "Their Digital Downloads help section lists bundles among the files you can sell as one download. No product type that hands over other products in their help center", "Yes \u2014 2 to 20 of your one-off products at one price, each delivered as itself, with \u201cwhat they cost on their own\u201d shown only when it is true. Not with memberships or calls"],
          ["External links on your page", "Yes, as one of their product types", "Yes, as their own list — no price on them and nothing to check out"],
          ["Physical products", "Not built in. Their help center suggests a custom product with address fields at checkout, with shipping and stock handled by hand", `Yes, on the ${PLAN_AT.creator} plan: Stripe asks for an address in the countries you ship to and adds your shipping cost; you mark each order as shipped and the buyer is emailed, with a tracking link`],
          ["Course quizzes and certificates", "Not in their help center", "Yes \u2014 up to 20 questions after any lesson, a pass mark and a number of tries, and a certificate with a page of its own that anyone can open to check it. The certificate is printed or saved as a PDF from the browser"],
        ],
      },
      {
        kind: "table",
        title: "Checkout and money",
        head: ["", "Stan", "Marktmorgen"],
        rows: [
          ["Cut of each sale", "0%", feeWords().short],
          ["Whose Stripe account", "One managed by the platform", "Yours"],
          ["Getting paid", "Manual cash-out, $10 minimum", "Your Stripe payout schedule"],
          ["PayPal", "Yes, for every creator", PAYPAL ? feeWords().paypal : `Not yet: ${PAYPAL_WAITS}. Until then, Stan is ahead here`],
          ["Klarna and Afterpay", "Yes, on the $99 plan", `Yes, on the ${PLAN_AT.creator} plan, with Affirm, Apple Pay, Google Pay, Link, iDEAL, Bancontact and more: the ways to pay you switch on in your own Stripe account, where Stripe offers them`],
          ["Currency", "One per store, chosen from ten", "Any one of 15 per store: US, Canadian, Australian, New Zealand, Singapore and Hong Kong dollars, euros, pounds, Swiss francs, Swedish kronor, Norwegian and Danish kroner, Polish zloty, yen and Mexican pesos"],
          ["Private podcast", "Not in their help center: a URL product can link to a podcast elsewhere (searched September 30, 2026)", `Yes, on the ${PLAN_AT.creator} plan: sold once or as a membership, with a private feed for each buyer in their own podcast app, emptied when a refund or the membership ends it`],
          ["A sale across the store", "Discount codes that can expire, on the $99 plan, which buyers have to know and type (article 43, read September 30, 2026). No price crossed out on the store", `Yes, on the ${PLAN_AT.creator} plan: a percentage off from a start to an end you pick, shown with the old price crossed out and when it ends, taken off at checkout with no code, and stopped by itself at the end`],
          ["Discount codes", "Yes, on the $99 plan, a percentage off only", `Yes, on the ${PLAN_AT.creator} plan, a percentage or an amount off \u2014 kept on your own Stripe account`],
          ["Pay what you want", "Not in their help center", `Yes, on the ${PLAN_AT.creator} plan: a minimum of at least $1 and a suggested price. Not with memberships, price options, payment plans, the box at checkout, calls or discount codes`],
          ["Questions at checkout", "Yes \u2014 including phone number and checkbox", checkoutQuestionWords()],
          ["Order bumps and upsells", "Yes, on the $99 plan. One order bump per product (their blog, updated September 16, 2026)", `Yes, on the ${PLAN_AT.creator} plan: up to three boxes the buyer checks at checkout, each its own product at its own price, and one click after paying, charged to the same card`],
          ["Limited quantity", "Yes, on the $99 plan", "Yes \u2014 the count shown is the real one, and a unit someone is paying for is held so the last one is never sold twice"],
          ["Payment plans", "Yes, on the $99 plan", `Yes, on the ${PLAN_AT.creator} plan: 2 to 12 weekly or monthly payments, ending by themselves after the last`],
          ["Sales tax collection", "Yes", "Yes \u2014 Stripe Tax on your own account, once your Stripe tax setup is done"],
          ["Logging in", "An account with a password, by their own signup page", "A link sent to your email that works once, for 15 minutes, or a passkey if you add one, and no password kept here. Log out of all devices in one click"],
          ["What a full refund closes", "Not something we can check from outside", "On Marktmorgen: the download at once, the course within 10 minutes, the community within 5, and the license key revoked within about 5. On a payment plan, a full refund of its first payment does the same"],
        ],
      },
      {
        kind: "table",
        title: "Marketing",
        head: ["", "Stan", "Marktmorgen"],
        rows: [
          ["Email broadcasts and flows", "Yes, on the $99 plan only", `Yes, on the ${PLAN_AT.pro} Studio plan: one-off emails, emails scheduled for later and sequences that send themselves, with steps that give or take off a label and start another sequence, up to ${PRO_MONTHLY_EMAILS.toLocaleString("en-US")} a month, only to people who agreed`],
          ["Abandoned-checkout email", "Yes \u2014 a flow with an abandoned-cart trigger, on the $99 plan", `One reminder per checkout, on the ${PLAN_AT.creator} plan, only to buyers who asked for it: on Stripe's page where Stripe offers its box (accounts in the United States), or on the page a buyer returns to after leaving the checkout, in every country. Off until you switch it on. Not for calls or live sessions`],
          ["Instagram auto-DM", "Yes, on the $29 plan", "Not available"],
          ["Funnels up to 20 pages", "Yes, on the $99 plan, since June 2026 \u2014 landing pages, checkout and upsells", `Yes, on the ${PLAN_AT.creator} plan: up to 20 of your own pages and products' pages in order from one address, counted step by step, with a box at checkout and up to five one-click offers after paying, each with a path for yes and for no. The thank-you page is the store's own, with a button to the next step`],
          ["Email platforms", "Mailchimp and other email tools through Zapier", `Mailchimp, Kit, beehiiv and MailerLite built in, on the ${PLAN_AT.creator} plan, one per store, passing on only people who agreed`],
          ["Affiliates paid automatically", "Yes, on the $99 plan, out of your sale, which Stan holds for 7 business days first (article 340, read September 30, 2026)", `Yes, on the ${PLAN_AT.creator} plan, from your own PayPal: everyone owed in one press, or by itself on your payday. Your sale lands in full in your Stripe account at once and is never held. Needs a PayPal Business account with Payouts switched on; PayPal charges you its own fee on each payment`],
          ["A share for one affiliate", "Yes, on the $99 plan: edit an affiliate's commission (article 378, read September 30, 2026)", `Yes, on the ${PLAN_AT.creator} plan: 1% to 90% for one affiliate, on every product except those you set to 0%`],
          ["Where affiliates are paid", "Affiliates connect their own Stripe or PayPal, and need a Stan account (article 402, read September 30, 2026)", "Affiliates need no account anywhere: each chooses on their own page the PayPal address you pay them at, and the address they joined with is told of every change. Or pay by Wise or bank transfer from the file"],
          ["Buyers become affiliates", "Yes, on the $99 plan: every customer becomes an affiliate automatically, through Affiliate Share", `Yes, on the ${PLAN_AT.creator} plan, when you switch it on: everyone who buys is offered their own link on the thanks page and in the purchase email, approved at once. Paid from your own PayPal, in one press or on your payday`],
          ["Inviting other creators", "20% of each payment they make, in cash through Stripe or PayPal, for as long as they stay subscribed, 3 to 5 days after each renewal once their 14-day trial ends, and only while you pay Stan too. No bonus for the creator you invite in their help center", INVITE_PROGRAM_OPEN ? `${INVITE_SHARE_PERCENT}% of each payment they make, for as long as they pay, as credit on your own plan \u2014 not cash \u2014 added ${INVITE_HOLD_DAYS} days after each payment. The creator you invite gets ${INVITE_BONUS} of credit after their first payment` : INVITE_PAUSE_NOTICE],
          ["Waitlist before launch", "Not in their help center: its \u201cProduct coming soon!\u201d notice only means no way to pay is connected yet (article 367), read September 30, 2026", `Yes, on the ${PLAN_AT.creator} plan: a product marked coming soon takes addresses confirmed from the inbox, and the day you put it on sale each gets one email with its link and price`],
          ["Advertising pixels", "Yes, on the $99 plan", `Yes \u2014 Meta, Google, TikTok and Pinterest, on the ${PLAN_AT.creator} plan, with each purchase and its amount. Visitors are asked first where the law says so`],
          ["Recurring revenue and churn", "Not in their help center, read September 30, 2026", `Yes, on the ${PLAN_AT.creator} plan: monthly recurring revenue, paying members and trials, churn over 30 days and the share of trials that became paying, overall and by membership, read from your own Stripe account`],
          ["Visits, sources and conversion", "Yes", "Yes \u2014 7, 30 and 90 days and all time, with UTM tags, counted without cookies, sales read from your own Stripe account, and CSV files of sales, visits and sources"],
          ["Public API and webhooks", "None published", `Both, on the ${PLAN_AT.creator} plan. Webhooks: up to five addresses, eight events, signed, for Zapier's Catch Hook, Make or your own server. An API that reads your list, members, a course's students, your affiliates and your bookings, with up to five keys; a key made to write also adds people who agreed to your list, changes their labels, and gives or takes back products`],
          ["Importing your list", "A CSV, up to 5,000 imported contacts per store in all, each sent an email to opt in again", "A CSV, up to 50,000 rows a file on a list of up to 100,000, only people you confirm agreed, never anyone who unsubscribed here. Nobody is emailed because of it"],
          ["Importing products", "Not in their help center", "A CSV, up to 500 a file, as drafts: title, price, description and link. Files, pictures and lessons are added afterward"],
          ["Past buyers from another platform", "Access granted one customer at a time, to downloads, courses and the community, with no bulk undo", "A CSV, up to 20,000 a file: files, links, courses, bundles and the community, and one email to them if you choose. Not calls, and no undo in one step. Members are emailed a link of their own to keep their membership here, first paying on the day it would have renewed"],
        ],
      },
      {
        kind: "note",
        title: "Where things stand today",
        body: "New paid plans and payment activation are paused while we review the full costs and tax requirements. A Stripe connection alone does not enable selling. You can try the demo before deciding; demo payments use a test card and do not charge real money. Existing accounts keep their contracted rights and access to recovery, export and cancellation. Published plan prices describe the planned offer, not an invitation to start paying today. We have not announced an opening date.",
      },
      {
        kind: "note",
        title: "About the app stores",
        body: "A real App Store and Google Play app is not a design job; it is a compliance job. Apple charges $99 a year and takes a cut of subscriptions bought inside an app, and Stan's help center says an annual plan cannot be bought in its app, only in a browser. Google Play charges $25 once. The installable web app has none of that, works on both systems, and is what we ship first.",
      },
    ],
  },
  {
    slug: "questions",
    section: "proof",
    eyebrow: "Proof",
    title: "Questions,",
    highlight: "including the awkward ones",
    intro:
      "If a question is missing, write it to us and the answer goes on this page, whether it flatters us or not.",
    badge: { label: "Straight answers", tone: "proof" as const },
    accent: "from-violet-brand to-amber-brand",
    blocks: [
      {
        kind: "steps",
        title: "The short answers",
        items: [
          { title: "Can I sign up and sell today?", body: "New paid plans and payment activation are currently paused. Connecting Stripe does not bypass this pause. You can explore the demo with test payments; no opening date has been announced. If you already have an account, your contracted rights, recovery, exports and cancellation remain available." },
          { title: "Who holds the money from my sales?", body: feeWords().whoHolds },
          { title: "What happens if Marktmorgen closes?", body: "Your Stripe account, your customers and your files were never ours. Your list downloads from your studio at any time, and a shutdown comes with at least 30 days' notice in writing." },
          { title: "Who is behind this?", body: "Marktmorgen’s creator also handles support, in English and in writing." },
          { title: "Can my store look like mine?", body: "Yes. Put up your photo, pick one of four themes, a color \u2014 one of ten, or your own \u2014 and one of five pairings of letters, and the studio shows the page before you save it. Every color is checked so the words on your page stay easy to read." },
          { title: "What do I do if something breaks?", body: "You write to support and a person answers. If a sale is affected, you have the Stripe dashboard as the source of truth, independently of us." },
        ],
      },
    ],
  },
];

export function findPage(section: TopicPage["section"], slug: string) {
  return PAGES.find((p) => p.section === section && p.slug === slug);
}

export function slugsFor(section: TopicPage["section"]) {
  return PAGES.filter((p) => p.section === section).map((p) => ({ slug: p.slug }));
}
