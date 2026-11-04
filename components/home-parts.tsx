import { AI_MONTHLY } from "@/lib/ai-rules";
import { weeklyReachShort } from "@/lib/email-equivalence";
import { ANSWERS_MONTHLY } from "@/lib/answers-rules";
import { MAX_OPTIONS } from "@/lib/product-option";
import { Suspense } from "react";
import { Icon } from "@/components/icons";
import { listSizeWords } from "@/lib/contact-rules";
import { PAID_STORAGE_BYTES } from "@/lib/storage-rules";
import { DATA_ROOM_BYTES, dataWords } from "@/lib/store-data-rules";
import { currentUploadBudgetPolicy, isUploadBudgetConfigured, uploadAllowanceWords } from "@/lib/upload-budget-policy";
import { paidVideoWords } from "@/lib/video-admission-rules";
import { VISITS_INCLUDED, publicVisitLimit } from "@/lib/traffic-rules";
import { ORDERS_INCLUDED } from "@/lib/order-rules";
import { allowanceListWords } from "@/lib/store-allowance-rules";
import {
  COMMISSION_BPS,
  COMMISSION_PLANS_PUBLISHED,
  PUBLISHED_PLAN_PRICES as PLAN_PRICES,
  monthlyEmails,
  PLAN_TITLES,
  PRO_MONTHLY_EMAILS,
  PRO_ON_SALE,
  REFUND_DAYS,
  TRIAL_DAYS,
  TRIAL_MONTHLY_EMAILS,
  type Tier,
  publishedYearSaving as yearSaving,
  SCALE_MONTHLY_EMAILS,
  TIERS,
} from "@/lib/plan";
import { feeWords } from "@/lib/fee-words";
import { PLANS_ON_SALE } from "@/lib/opening";
import { pricingPerksMarkup, pricingTermsMarkup } from "@/lib/pricing-perks-markup";

import { PricingCycle, CycleText, CycleLink, CycleTerms } from "@/components/pricing-cycle";
export { HeroFlow, RevealOnScroll } from "@/components/home-interactive";

/*
 * Two plans, and every line under them is something you can open and try
 * today. A price with a feature beside it is a promise; a promise we cannot
 * keep is worse than a shorter list. Each yearly price is the same plan paid
 * once a year, and the studio opens either.
 */
// Reuse formatters and immutable plan figures across hydration and cycle changes.
const PLAN_NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const PLAN_PRICE_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const INCLUDED = [
  "Your own store address, live the moment you take it",
  `${PLAN_NUMBER_FORMAT.format(VISITS_INCLUDED.creator)} counted visits to your store a billing month; public pages pause at ${PLAN_NUMBER_FORMAT.format(publicVisitLimit(VISITS_INCLUDED.creator))}, and the rest are kept for your buyers' courses, community and podcasts; nothing is billed past it`,
  `${PLAN_NUMBER_FORMAT.format(ORDERS_INCLUDED.creator)} orders a billing month${feeWords().ordersShared ? " (an order whose sale paid your plan's share is not counted)" : ""}; at that figure new orders pause until your next billing month, nothing is billed past it, and a buyer already paying always finishes`,
  `Each billing month, starting on the day your plan renews: ${allowanceListWords("creator")}; past one, that use waits for the next month${PLANS_ON_SALE && PRO_ON_SALE ? ", or a larger plan" : ""}, and nothing is billed`,
  "Buyers pay into your own Stripe account",
  "Up to 2,000 products: files, courses, memberships, paid calls and live sessions",
  "Sales pages and landing pages built from blocks, and reviews only buyers can write",
  "A community for your buyers, with spaces, posts, comments, moderation and live events members RSVP to",
  `Up to ${MAX_OPTIONS} prices on any product, bundles of 2 to 20 products, pay what you want, discount codes and payment plans`,
  "15 currencies, and Apple Pay, Google Pay, Klarna and the other ways to pay you switch on in Stripe",
  "Offers before and after paying: a box at checkout, and up to five one-click offers after",
  "An affiliate program with a page for each affiliate, paid from your own PayPal in one press or on payday by itself",
  "Your own numbers counted without cookies, as CSV files too, and ad pixels for Meta, Google, TikTok and Pinterest — those are the platforms' own, and visitors are asked first where the law requires it",
  "License keys, stamped PDFs, course quizzes and certificates",
  `Lesson videos: ${paidVideoWords()} each month; new playback pauses at the threshold`,
  "A private video room for each booking if you want one, and calendar sync for your calls",
  "Mailchimp, Kit, beehiiv or MailerLite built in, and webhooks for Zapier or Make",
  "A team of you plus up to five people per store, each with a role, and notifications of sales on your phone",
  "Sign-in without passwords, and a full refund that closes access by itself",
  "Free products that build an email list you can download at any time",
  "Your list, products and past buyers brought over from another platform, from a spreadsheet",
];

const PRO_INCLUDED = [
  `Everything in ${PLAN_TITLES.creator}`,
  `${PLAN_NUMBER_FORMAT.format(VISITS_INCLUDED.pro)} visits to your store a month covered, instead of ${PLAN_NUMBER_FORMAT.format(VISITS_INCLUDED.creator)}`,
  `${PLAN_NUMBER_FORMAT.format(ORDERS_INCLUDED.pro)} orders a month covered, instead of ${PLAN_NUMBER_FORMAT.format(ORDERS_INCLUDED.creator)}`,
  `Each billing month: ${allowanceListWords("pro")}`,
  "One-off emails to your list, now or at a time you choose, to everyone or to the people who have not bought a particular thing yet",
  "Sequences that go out by themselves after someone joins or buys",
  `Up to ${PLAN_NUMBER_FORMAT.format(PRO_MONTHLY_EMAILS)} emails a month (${PLAN_NUMBER_FORMAT.format(TRIAL_MONTHLY_EMAILS)} during the free trial), from your name, with replies coming to you`,
  "One-click unsubscribe in every email, honored for good",
  "Community announcements emailed to the members who asked for them, counted in the same monthly allowance",
  "One email that asks each buyer for a review, 3 to 30 days after buying",
  `Writing help with AI, from your own words and in your store's language: product descriptions, whole sales pages and course outlines, a second opinion on a page, any block rewritten, a page translated, picture descriptions, the line about your store, blog posts, emails, replies to reviews and posts to share — ${AI_MONTHLY.pro} writing jobs and ${PLAN_NUMBER_FORMAT.format(ANSWERS_MONTHLY.pro)} answers to visitors' questions a month, each request setting aside the most it could cost from the plan's monthly AI budget first; not during the free trial`,
  "Our name off the foot of your page, so it carries yours and nothing of ours",
];

/*
 * What each plan is, in the few things a creator is actually deciding
 * between.
 *
 * The itemised lists above are still here, whole, one press away: somebody
 * checking whether their own case is covered needs that detail and nothing
 * is kept from them. But eighteen technical lines are not how anybody
 * chooses a plan, and leading with them turned a decision into homework.
 * The open layer answers one question — which of these two is my business —
 * and the answer has three parts.
 */
type PlanGroup = { icon: Parameters<typeof Icon>[0]["name"]; title: string; body: string };

const CREATOR_GROUPS: PlanGroup[] = [
  {
    icon: "store",
    title: "Sell whatever it is you make",
    body: "Files, courses, memberships, paid calls and live sessions, on pages you build from blocks — up to 2,000 of them in one store.",
  },
  {
    icon: "bank",
    title: "Your own payment account",
    // The share of a sale is said once, under the price ("0% of sales"); not again here (243 [CF6], 31/10 complement).
    body: "Buyers pay into your own Stripe account, in 15 currencies, and the money is yours.",
  },
  {
    icon: "users",
    title: "Sell to the same people again",
    body: "Bundles, discount codes, payment plans, an offer at checkout and up to five after it, an affiliate program, and a community your buyers join.",
  },
];

function proGroups(domains: boolean): PlanGroup[] {
  return [
    {
      icon: "check",
      title: `Everything in ${PLAN_TITLES.creator}`,
      body: "Every line of the plan beside this one, unchanged. Studio adds to it; it replaces nothing.",
    },
    {
      icon: "mail",
      title: "Write to your own list from here",
      // The monthly emails are a figure under the price; this says what they are for, without the number again.
      body: `A list of up to ${listSizeWords()} people, and the price does not move as it fills. One-off emails and sequences that send themselves after someone joins or buys, from your name, with replies coming to you.`,
    },
    domains
      ? {
          icon: "globe",
          title: "Your name on it, and only yours",
          body: "Your store on your own domain, with the certificate made for you, and our name off the foot of the page.",
        }
      : {
          icon: "eye",
          title: "Your name on it, and only yours",
          body: "Our name comes off the foot of your page, so what a buyer reads at the bottom of it is yours.",
        },
  ];
}

/*
 * A yearly price said as a monthly one, for comparing with the monthly plan.
 * It is never the number on the card — the card shows what is actually
 * charged, once a year — only the line underneath that does the division so
 * nobody has to.
 */
function monthlyEquivalent(yearCents: number): string {
  const perMonth = yearCents / 12 / 100;
  return Number.isInteger(perMonth) ? String(perMonth) : perMonth.toFixed(2);
}

/*
 * The six things somebody is agreeing to, where they can be read.
 *
 * They were all on the page before, and all of them were in the wrong place
 * to be read: three sentences of grey small print under the button, and a
 * band of three columns below both cards. Terms worth trusting are worth
 * laying out — one label, one answer, per line, inside the card they belong
 * to, so nobody has to reconstruct the deal from prose.
 */
/** The share of each sale a plan's card shows: none since 18 October 2026, when the offer with a share stopped being published (lib/plan.ts). */
function shareShown(tier: Tier): number {
  return COMMISSION_PLANS_PUBLISHED ? COMMISSION_BPS[tier] : 0;
}

/** "$4,490". */
function usdWhole(cents: number): string {
  return `$${PLAN_PRICE_FORMAT.format(cents / 100)}`;
}

/**
 * The figures a buyer holds up against another tool's card, from the
 * constants the product enforces (docs/value-presentation-2026-10-18.md):
 * the leaders print contacts, emails a month, products and AI on the card
 * itself, so these are printed under the price rather than only in the list.
 */
function planFigures(tier: Tier): { included: string[]; notOnPlan: string[] } {
  const n = (x: number) => PLAN_NUMBER_FORMAT.format(x);
  const emails = monthlyEmails(tier);
  const included = [`${n(VISITS_INCLUDED[tier])} visits a month`, `${n(ORDERS_INCLUDED[tier])} orders a month`];
  // What a plan does not have is said plainly, without the check mark of what it has (243 [CF6], 31/10 complement).
  const notOnPlan: string[] = [];
  // 459 [EL3]: what the number is enough for, worked out from it (lib/email-equivalence.ts), never typed.
  if (emails > 0) included.push(`${n(emails)} list emails a month: ${weeklyReachShort(emails)}`);
  else notOnPlan.push("email to your list");
  if (AI_MONTHLY[tier] > 0) included.push(`${n(AI_MONTHLY[tier])} AI writing jobs and ${n(ANSWERS_MONTHLY[tier])} visitor answers a month`);
  else notOnPlan.push("AI writing");
  included.push(`${n(PAID_STORAGE_BYTES[tier] / 1024 ** 3)} GB of storage`);
  return { included, notOnPlan };
}

const PLAN_FIGURES = Object.fromEntries(TIERS.map(tier => [tier, planFigures(tier)])) as Record<Tier, { included: string[]; notOnPlan: string[] }>;

/**
 * The monthly upload allowance in plain words (243 [CF6], 31/10 complement), from the same policy as
 * uploadAllowanceWords, and in the same GB as storage (1 GB = 1,024³ bytes, so its 5,368,709,120 bytes are 5 GB, as
 * Store's storage is). Every figure stays written: files, size and upload steps. When the policy is not set, its own
 * sentence says uploads are paused.
 */
function plainUploadWords(tier: Tier): string {
  const policy = currentUploadBudgetPolicy();
  if (!isUploadBudgetConfigured(policy) || policy.perStore[tier].opens === 0) return uploadAllowanceWords(tier, policy);
  const cap = policy.perStore[tier];
  const gb = Math.floor((cap.authorizedBytes / 1024 ** 3) * 10) / 10;
  return `Each billing month, new product and lesson files: up to ${PLAN_NUMBER_FORMAT.format(cap.opens)} files and ${PLAN_NUMBER_FORMAT.format(gb)} GB in all, sent in up to ${PLAN_NUMBER_FORMAT.format(cap.controlRequests)} upload steps (a large file is sent in parts). Starting a file over counts again.`;
}

/** The upload, storage and data-room allowances, as lines of the itemized list. */
function storageLines(tier: Tier): string[] {
  return [
    plainUploadWords(tier),
    `Up to ${PAID_STORAGE_BYTES[tier] / 1024 ** 3} GB of stored files and videos. New uploads must fit in the remaining space.`,
    `A data room of ${dataWords(DATA_ROOM_BYTES[tier])} for your store's words and records: products, pages, posts, contacts and what each order keeps.`,
  ];
}

/**
 * The terms every plan shares, said once under the three cards (243 [CF6], 31/10 complement): the first charge of
 * each plan in one line, and the rest as before. Whether paid plans are on sale is said once, above the plans.
 */
function PlanTermsOnce() {
  const markup = (yearly: boolean) => {
    const charges = TIERS.map((tier) => `${PLAN_TITLES[tier]} $${PLAN_NUMBER_FORMAT.format((yearly ? PLAN_PRICES[tier].year : PLAN_PRICES[tier].month) / 100)}`).join(", ");
    const shares = TIERS.map((tier) => shareShown(tier));
    const fees = shares.every((share) => share === shares[0])
      ? `${shares[0] / 100}% of each sale on every plan. Stripe charges its own processing fee separately.`
      : `${TIERS.map((tier) => `${PLAN_TITLES[tier]} ${shareShown(tier) / 100}%`).join(", ")} of each sale. Stripe charges its own processing fee separately.`;
    const rows: [string, string][] = [
      ["Free trial", `${TRIAL_DAYS} days. Your card is taken when it starts, so you can sell before you decide.`],
      ["First charge", `${charges} ${yearly ? "for the year" : "for the month"}, on the day the trial ends. We email you a week before.`],
      [
        "Money back",
        `Ask within ${REFUND_DAYS} days of your first payment and it comes back in full, for any reason or none. A yearly plan is refunded for the months you have not started, at any time, less Stripe's card fee.`,
      ],
      ["Canceling", "Two clicks in your studio, any time. Inside the trial, the card is never charged."],
      ["Fees", fees],
    ];
    return pricingTermsMarkup(rows);
  };
  return (
    <section aria-labelledby="plan-terms-heading" className="card-flat mt-6 p-6 sm:p-7" data-plan-terms>
      <h3 id="plan-terms-heading" className="t-h3">The terms, for every plan</h3>
      <CycleTerms month={markup(false)} year={markup(true)} />
    </section>
  );
}

function PlanCard({
  tier,
  bestFor,
  groups,
  perks,
  featured,
  cta,
}: {
  tier: Tier;
  bestFor: string;
  groups: PlanGroup[];
  perks: string[];
  featured: boolean;
  cta: string;
}) {
  const { month, year } = PLAN_PRICES[tier];
  const saving = yearSaving(tier) / 100;
  return (
    <div
      data-pricing-card
      style={{ contain: "layout" }}
      className={`relative flex flex-col p-7 sm:p-9 ${
        featured
          ? "card border-violet-brand/35 shadow-[var(--shadow-md)] ring-1 ring-violet-brand/15"
          : "card-flat"
      }`}
    >
      {/*
        The recommended plan is marked once, in words that say why, and
        nothing else on this block tries to hurry anybody: no countdown, no
        "only today", no crossed-out price that was never charged.
      */}
      {featured ? (
        <span className="absolute -top-3 left-7 rounded-full bg-[var(--hm-gold,var(--violet))] px-3 py-1 text-[0.8125rem] font-extrabold text-[var(--hm-text,#fff)] shadow-[var(--shadow-sm)] sm:left-9">
          Where to start
        </span>
      ) : null}

      {/*
        The title says what the plan is; the line under it says whose
        business it suits, which is the only thing somebody holding two
        cards up against each other is trying to find out.
      */}
      {/* A heading under the pricing page's "Plan prices" section (WCAG 1.3.1, 2.4.10). */}
      <h3 className="t-h3">{PLAN_TITLES[tier]}</h3>
      <p className="measure mt-2 text-[0.9375rem] text-ink-soft">{bestFor}</p>

      {/* Wraps "a month" under the price, and a smaller price below 640px,
          so a 320px screen with WCAG 1.4.12 text spacing never scrolls sideways (1.4.10). */}
      <p className="mt-5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[2.75rem] sm:text-[3.5rem] font-semibold leading-none tracking-[-0.05em] text-ink tabular-nums">
          <CycleText month={usdWhole(month)} year={usdWhole(year)} />
        </span>
        <span className="text-ink-mute"><CycleText month="a month" year="a year" /></span>
      </p>
      <p className="mt-2 font-semibold text-violet-deep">{`${shareShown(tier) / 100}% of sales`}</p>
      <p className="mt-2 min-h-[1.5rem] text-[0.9375rem] text-ink-soft">
        <CycleText
          month={`Billed every month. Or ${usdWhole(year)} once a year, which is ${usdWhole(saving * 100)} less${year === month * 10 ? ": two months free" : ""}.`}
          year={`One payment of ${usdWhole(year)}, once a year — $${monthlyEquivalent(year)} a month, ${usdWhole(saving * 100)} less than paying monthly${year === month * 10 ? ": two months free" : ""}.`}
        />
      </p>
      <ul className="mt-5 space-y-1.5 text-[0.9375rem] text-ink" aria-label={`What ${PLAN_TITLES[tier]} holds`}>
        {PLAN_FIGURES[tier].included.map((line) => (
          <li key={line} className="flex gap-2">
            <Icon name="check" size={16} className="mt-1 shrink-0 text-mint-deep" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      {PLAN_FIGURES[tier].notOnPlan.length ? (
        <p className="mt-3 text-[0.9375rem] text-ink-soft" data-not-on-plan>
          {`The ${PLAN_TITLES[tier]} plan does not include ${PLAN_FIGURES[tier].notOnPlan.join(" or ")}. ${TIERS.filter((other) => planFigures(other).notOnPlan.length === 0).map((other) => PLAN_TITLES[other]).join(" and ")} do.`}
        </p>
      ) : null}

      {/*
        Three groups open, the whole list one press away.

        Eighteen ticks in a column made the two cards 4,156px of page
        between them, and a list that long is not read — it is scrolled
        past. Worse, a list sorted by nothing hands the sorting to the
        reader. These three say what the plan is for; the itemized version
        is still here, whole, for anybody checking one particular case.
      */}
      <ul className="mt-7 space-y-5">
        {groups.map((group) => (
          <li key={group.title} className="flex gap-3.5">
            <span className="icon-tile icon-tile-sm" aria-hidden="true">
              <Icon name={group.icon} size={17} strokeWidth={1.9} />
            </span>
            <span>
              <strong className="block font-semibold text-ink">{group.title}</strong>
              <span className="mt-1 block text-[0.9375rem] text-ink-soft">{group.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {/* Native disclosure contents are escaped static HTML, with no React event
          handlers or child hydration work between a press and opening the list. */}
      {/* A press can hydrate this native disclosure independently of the rest
          of the card, preserving its first response during page hydration. */}
      <Suspense fallback={null}>
        {/* The upload, storage and data-room details are in the itemized list, not under it (243 [CF6], 31/10 complement). */}
        <details className="group/perks mt-6" dangerouslySetInnerHTML={{ __html: pricingPerksMarkup([...perks, ...storageLines(tier)]) }} />
      </Suspense>

      <div className="mt-auto pt-8">
        {/*
          The plan and the rhythm travel with the press.

          Both buttons used to go to a bare /signin, so somebody who had just
          read the Pro column and switched the whole page to yearly arrived at
          a page that showed no sign of either. Nothing is charged from here —
          the plan is chosen in the studio, after the store exists — but the
          choice is carried in the address so the next page can say it back,
          and so a creator never has to wonder whether it was heard.
        */}
        <CycleLink tier={tier} cta={cta} featured={featured} />
        {/* The terms are the same for every plan: said once, under the three cards (PlanTermsOnce). */}
        <p className="mt-4 text-[0.8125rem] leading-relaxed text-ink-mute">Pressing this sends a login link to your email.</p>
      </div>
    </div>
  );
}

export function Pricing({ domains = false }: { domains?: boolean }) {
  const proPerks = domains
    ? [...PRO_INCLUDED.slice(0, 1), "Your store on your own domain, with its certificate handled for you", ...PRO_INCLUDED.slice(1)]
    : PRO_INCLUDED;
  return (
    <PricingCycle saving={usdWhole(Math.max(...TIERS.map(yearSaving)))}>
      {/*
        Two cards of the same build.

        A cheaper plan drawn smaller, or with its terms left out, is a way of
        telling somebody they picked wrong. Both of these carry the same
        title, the same three groups, the same itemized list and the same
        four lines of terms, so the only difference a reader finds between
        them is the actual difference between them.
      */}
      {/* No Suspense around the cards: React sends a large boundary after the rest of the page even when it is
          ready, so the cards arrived after the first paint and pushed the terms under them down (1 November 2026).
          Each card's own disclosure keeps its small boundary, for hydrating apart. */}
      <div className="grid gap-6 lg:grid-cols-3 lg:items-stretch">
        <PlanCard
          tier="creator"
          bestFor={"For selling what you make to the audience you already reach — wherever you reach them now."}
          groups={CREATOR_GROUPS}
          perks={INCLUDED}
          featured
          cta="Start on Store"
        />
        <PlanCard
          tier="pro"
          bestFor={"For selling and writing to your own list from the same place, so a buyer hears from you again."}
          groups={proGroups(domains)}
          perks={proPerks}
          featured={false}
          cta="Start on Studio"
        />
        <PlanCard
          tier="scale"
          bestFor="For an established business with a larger list, more visits and more orders every month."
          groups={[
            { icon: "check", title: "Everything in Studio", body: "The same selling tools and email features, with larger allowances." },
            // The figures are under the price, once; these say what the larger allowances are for.
            { icon: "mail", title: "More room to grow", body: "Larger monthly allowances than Studio for emails, visits and orders, for a bigger list and more sales." },
            { icon: "sparkle", title: "More AI and more room", body: "More AI writing, more answers to visitors and more storage than Studio, for a catalog that keeps growing." },
          ]}
          perks={[`Everything in ${PLAN_TITLES.pro}`, `${PLAN_NUMBER_FORMAT.format(SCALE_MONTHLY_EMAILS)} emails a month`, `${PLAN_NUMBER_FORMAT.format(VISITS_INCLUDED.scale)} visits a month`, `${PLAN_NUMBER_FORMAT.format(ORDERS_INCLUDED.scale)} orders a month`, `${PLAN_NUMBER_FORMAT.format(AI_MONTHLY.scale)} AI writing jobs and ${PLAN_NUMBER_FORMAT.format(ANSWERS_MONTHLY.scale)} visitor answers a month`, `Each billing month: ${allowanceListWords("scale")}`]}
          featured={false}
          cta="Start on Scale"
        />
      </div>
      <PlanTermsOnce />
      {/*
        What is true of every plan, and belongs to neither card: the two
        edges of the trial, and the limit we publish rather than bury.
      */}
      <div className="card-flat mt-6 grid gap-4 p-6 text-sm sm:grid-cols-3 sm:p-7">
        <p className="flex gap-2 text-ink-soft">
          <Icon name="clock" size={18} className="mt-0.5 shrink-0 text-violet-deep" />
          <span>
            <strong className="font-semibold text-ink">One trial per account.</strong>
            {` The free ${TRIAL_DAYS} days are for your first store; a second store is paid from its first day.`}
          </span>
        </p>
        <p className="flex gap-2 text-ink-soft">
          <Icon name="refresh" size={18} className="mt-0.5 shrink-0 text-violet-deep" />
          <span>
            <strong className="font-semibold text-ink">Move between the plans.</strong> From your studio, whenever you like,
            either direction. Nothing you have made is lost in the move.
          </span>
        </p>
        <p className="flex gap-2 text-ink-soft">
          <Icon name="download" size={18} className="mt-0.5 shrink-0 text-violet-deep" />
          <span>
            <strong className="font-semibold text-ink">Storage: {PAID_STORAGE_BYTES.creator / (1024 ** 3)} GB on Store, {PAID_STORAGE_BYTES.pro / (1024 ** 3)} GB on Studio, and {PAID_STORAGE_BYTES.scale / (1024 ** 3)} GB on Scale.</strong> Uploads pause when there is no room left. A free trial never has more storage than its chosen plan.
          </span>
        </p>
      </div>
    </PricingCycle>
  );
}

