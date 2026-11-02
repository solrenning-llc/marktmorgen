/**
 * The questions answered on the home page, and their answers.
 *
 * They live here rather than beside the component that draws them because the
 * page writes them down twice: once for a reader, once in the form a search
 * engine reads. One list, so the two can never say different things.
 */
import { COMMISSION_PLANS_PUBLISHED, PUBLISHED_PLAN_PRICES, TRIAL_DAYS, PLAN_TITLES, publishedPriceWords } from "@/lib/plan";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { PLANS_ON_SALE } from "@/lib/opening";
import { feeWords } from "@/lib/fee-words";

export type HomeQuestion = {q:string;a:string;links?:{label:string;href:string}[]};

/** The six decision questions shared by home and pricing; no provider call. */
export function decisionQuestions(): HomeQuestion[] { return [
{q:"How much does it cost?",a:(["creator","pro","scale"] as const).map(tier=>PLAN_TITLES[tier]+": "+publishedPriceWords(tier,"month")+" or "+publishedPriceWords(tier,"year")).join("; ")+". Annual billing is one upfront payment. Optional add-ons and Stripe processing are separate; published usage limits apply. "+(PLANS_ON_SALE?"Check availability and terms before subscribing.":"Paid plans and paid selling are not open yet."),links:[{"label":"All prices, limits and optional add-ons","href":"/pricing"}]},
{"q":"Is there a contract? Can I cancel anytime?","a":"The Terms describe a subscription that renews for the billing interval you choose. You may cancel at any time: future periods are not charged, and access lasts through the period already paid unless a refund applies. Annual billing is paid upfront, not a monthly installment contract. Trial, refund and store-closing rules still apply.","links":[{"label":"Cancellation and store-closing terms","href":"/terms#closing"},{"label":"Trial and refund policy","href":"/refunds"}]},
{"q":"Can I move from Kajabi, Stan or another platform?","a":"You can import CSV files for consenting contacts, products as drafts and past buyers, matching the columns and reviewing skipped rows. Products must be set up with their files or lessons before the relevant buyers receive access. Files, course lessons and community posts do not automatically move; subscription cards and renewals need the separate migration process. Permissions, allowances and availability checks still apply.","links":[{"label":"What moves and what needs separate setup","href":"/platform/switching-to-marktmorgen"}]},
{"q":"Does it connect to my other tools?","a":"Webhooks can send selected events to Zapier, Make or your server. Use Webhooks by Zapier; there is no native Marktmorgen app in its directory. The API uses scoped keys made in the studio, with read access or permitted writes on every plan, subject to its request allowance and endpoint rules. A contact import does not create permission to send marketing.","links":[{"label":"API, keys, webhooks and limits","href":"/developers"}]},
{"q":"Is there support, and how?","a":"The help center explains the existing features. For support, write in English to support@marktmorgen.com; Marktmorgen's creator handles it in writing. We do not publish a guaranteed response time here.","links":[{"label":"Read the help center","href":"/help"},{"label":"Email support","href":"mailto:support@marktmorgen.com"}]},
{"q":"How long does it take to open a store?","a":"There is no measured setup-time promise. You choose an address, describe your store, add its appearance and products, and complete the relevant account and payment setup. Your content and provider checks affect the time. The live demo shows an existing example you can inspect now; preparing a store does not open paid selling while plans remain closed.","links":[{"label":"See the live demo","href":"/demo"},{"label":"See the actual Path","href":"/platform/path"}]},
]; }

/*
 * What the home page asks and answers (VS1, owner 31/10/2026): six short
 * questions, each answer one or two plain sentences read from the code
 * (lib/plan.ts, lib/opening.ts, lib/fee-words.ts), with a link to the page
 * that says the rest. The longer answers live on /pricing (decisionQuestions
 * above) and in the help center (lib/help-content.ts, which also keeps the
 * two answers below that left the home page).
 */
const MONTH = (tier: "creator" | "pro" | "scale") => PUBLISHED_PLAN_PRICES[tier].month / 100;
const TEN_MONTH_YEAR = (["creator", "pro", "scale"] as const).every((tier) => PUBLISHED_PLAN_PRICES[tier].year === PUBLISHED_PLAN_PRICES[tier].month * 10);

export function homeQuestions(): HomeQuestion[] {
  return [
    {
      q: "How long does it take to open a store?",
      a: "There is no set time. You pick your store address, add what you sell and connect your own Stripe account.",
      links: [{ label: "See the live demo store", href: "/demo" }, { label: "The longer answer, on the pricing page", href: "/pricing" }],
    },
    {
      q: "How much does it cost?",
      a: `${PLAN_TITLES.creator} is $${MONTH("creator")} a month, ${PLAN_TITLES.pro} $${MONTH("pro")} and ${PLAN_TITLES.scale} $${MONTH("scale")}${TEN_MONTH_YEAR ? "; a year costs ten monthly payments" : ", or less when paid yearly"}. ${COMMISSION_PLANS_PUBLISHED ? feeWords().homeFee + (PLANS_ON_SALE ? "" : " Plans are not on sale yet.") : "Stripe's processing fee is separate" + (PLANS_ON_SALE ? "." : ", and plans are not on sale yet.")}`,
      links: [{ label: "All prices and limits", href: "/pricing" }],
    },
    {
      q: "Where does the money from my sales go?",
      a: "Into your own Stripe account. Each sale is charged there directly and paid out to your bank on your Stripe payout schedule; we never hold it.",
      links: [{ label: "How payments reach you", href: "/platform/your-stripe" }],
    },
    {
      q: "Can I move from Stan, Kajabi or another platform?",
      a: "Yes, in part. CSV files bring in contacts who agreed, products as drafts and past buyers; you add files, lessons and community posts yourself.",
      links: [{ label: "What moves and what you add yourself", href: "/platform/switching-to-marktmorgen" }],
    },
    {
      q: "Can I cancel anytime?",
      a: "Yes. Cancel in your studio at any time: you are not charged again, and you keep access until the paid period ends, unless a refund applies.",
      links: [{ label: "Cancellation terms", href: "/terms#closing" }, { label: "Refund policy", href: "/refunds" }],
    },
    {
      q: "Can I start selling today?",
      a: PLANS_ON_SALE
        ? `Yes. Set up your store, connect Stripe and start a ${TRIAL_DAYS}-day free trial on your first store.`
        : "You can set up your store today, with no card. Plans are not on sale yet, so selling starts the day they open.",
      links: [{ label: "What is built so far", href: "/mission" }],
    },
  ];
}

/** Moved from the home page to the help center (lib/help-content.ts, "Your data"). */
export const LEAVING_QUESTION = "What happens to my payments and customer data if I leave?";
export const LEAVING_ANSWER = "Your Stripe account, its customers and its payout history stay with you, because they were never held by us: every charge was made on your account. Your email list, your buyers and your product list download as files at any time. What does not travel is what runs here — your store page, your course pages and the links that deliver your files — so buyers would need somewhere new to collect what they bought. A shutdown would come with notice in writing.";

/** Moved from the home page to the help center ("Getting started"); the conservative default without deployment capabilities. */
export const STAN_QUESTION = "How does Marktmorgen compare with Stan?";
export function stanComparison(paypalAvailable = false): string {
  return `Stan has, among other things: automatic Instagram replies, ${paypalAvailable ? "" : "PayPal at checkout, "}an iPhone app from the App Store, affiliate payouts that need no PayPal account of your own, and stores with no limit on products, where ours hold ${MAX_PRODUCTS.toLocaleString("en-US")}. What we have in their place: a studio that installs from the browser with notifications, Google Meet and Zoom links for supported connected accounts, subject to provider availability and connection requirements, a private Jitsi Meet room for each booking and each live event, and an affiliate program whose payouts leave your own PayPal, in one press or on payday by itself. Each difference is listed by name on the feature-by-feature page (/proof/everything), with where we stand on it, and nothing is advertised before it exists.`;
}

/** The home page's questions; they read no deployment capability. */
export const HOME_QUESTIONS = homeQuestions();
