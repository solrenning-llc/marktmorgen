/**
 * What we charge, in one place.
 *
 * These numbers are read by the checkout that actually bills a creator and by
 * the pages that tell the world the price. They live here, rather than in
 * lib/billing.ts, because that file talks to Stripe with a secret key and must
 * never be pulled into a browser bundle — and a marketing page that cannot
 * import the real number ends up retyping it, which is how a site starts
 * advertising a price the checkout does not open with.
 *
 * Nothing in this file may ever read an environment variable or a secret. That
 * is the whole reason it is safe for a client component to import it.
 */
import { type PlanDispute, planDisputed } from "@/lib/plan-dispute-rules";

/**
 * The plans. Pro adds what costs us money to run for you, and Scale is Pro
 * with room for a list that has outgrown it.
 */
export type Tier = "creator" | "pro" | "scale";
/** Every plan, from the least to the most. */
export const TIERS: readonly Tier[] = ["creator", "pro", "scale"];
/** How often it is billed. */
export type Cycle = "month" | "year";

/**
 * The prices on sale and published, in cents (owner's decision, 18 October
 * 2026, 11:21: "preço: o que maximiza o meu lucro. limites: combinação que
 * potencializa o que maximiza meu lucro + o que cliente percebe alto valor +
 * não remover limites visíveis"; and 11:22: "preço e limites = preço e
 * limites de cada plano"). Each is the lowest round price at or above what
 * keeps 60% net at full use of every allowance under lib/receiving-costs.ts
 * (the sizing reading, the commission counted as zero), with the room the
 * spend floor test keeps, and the year is ten monthly payments
 * (docs/value-presentation-2026-10-18.md has the method, the floors and the
 * competitors read). These do not open a sale: lib/opening.ts does that.
 */
export const PRICES_WITHOUT_COMMISSION: Record<Tier, Record<Cycle, number>> = {
  creator: { month: 6900, year: 69000 },
  pro: { month: 44900, year: 449000 },
  scale: { month: 99900, year: 999000 },
};

/**
 * Until 18 October 2026 there were two price lists: a lower one that went
 * with a share of each sale (Store $22 + 6.25%, Studio $149 + 2.75%, Scale
 * $349) and one without ($29, $99, $249). With the commission counted as
 * zero by the owner's rule, a lower price "with commission" can never be
 * justified on margin, so the variant is set equal to the one price list:
 * one subscription, nothing taken from a sale. The machinery for a share
 * (lib/platform-share.ts) stays, switched off (COMMISSION_LIVE false), and
 * isSharedPrice below can never be true while the two lists are equal.
 */
export const PRICES_WITH_COMMISSION: Record<Tier, Record<Cycle, number>> = PRICES_WITHOUT_COMMISSION;

/**
 * The price lists published before 18 October 2026, kept only so that a
 * subscription begun on one of them, if any, is still read as the right plan
 * (lib/billing.ts planOf). Nobody subscribed on them: no sale was ever open.
 */
export const LEGACY_PLAN_PRICES: readonly Record<Tier, Record<Cycle, number>>[] = [
  { creator: { month: 2900, year: 30000 }, pro: { month: 9900, year: 94800 }, scale: { month: 24900, year: 238800 } },
  { creator: { month: 2200, year: 22000 }, pro: { month: 14900, year: 149000 }, scale: { month: 34900, year: 349000 } },
];

/** The share of each sale that goes with PRICES_WITH_COMMISSION, in basis points. */
export const COMMISSION_BPS: Record<Tier, number> = { creator: 625, pro: 275, scale: 0 };

/**
 * Whether the share of each sale is charged, and with it the prices above.
 *
 * Off, and it stays off until three things are true, because a price on the
 * site that the checkout cannot bill is a price we would be advertising
 * without charging, and a share we cannot take is a store that pays less
 * than the plan it was sold:
 *
 *   1. Stripe has said in writing that this platform may take an application
 *      fee on a creator's own charges, from the company that will run it.
 *      The share is taken out of the sale itself, on the creator's account,
 *      so it is never a bill somebody can fail to pay.
 *   2. Every checkout that charges on a creator's account sets that fee, and
 *      a refund gives back the fee's share of what was refunded. Built on
 *      October 12, 2026 (lib/platform-share.ts, lib/share-settle.ts), and
 *      to be run against Stripe's test mode on that company's platform
 *      before it is relied on (SHARE_PROVED_IN_TEST_MODE there).
 *   3. No page says any more that nothing is taken from a sale. A store that
 *      subscribed before keeps the price it chose with no share taken
 *      (Store.shared), which is built.
 *
 * tests/plan-margin.test.ts refuses the switch while any of these is
 * missing that code can see.
 */
export const COMMISSION_LIVE = false;

/**
 * Whether the offer with a share of each sale is published. False since 18
 * October 2026: one price list, and 0% of a sale (PRICES_WITH_COMMISSION).
 */
export const COMMISSION_PLANS_PUBLISHED = false;

/** Every price we charge, in cents: the set that is on sale. */
export const PLAN_PRICES: Record<Tier, Record<Cycle, number>> = COMMISSION_LIVE ? PRICES_WITH_COMMISSION : PRICES_WITHOUT_COMMISSION;

/** The published price list: the one on sale, since 18 October 2026 the same as PLAN_PRICES. */
export const PUBLISHED_PLAN_PRICES = COMMISSION_PLANS_PUBLISHED ? PRICES_WITH_COMMISSION : PRICES_WITHOUT_COMMISSION;
export const PUBLISHED_PRICE_CENTS = PUBLISHED_PLAN_PRICES.creator.month;
export const PUBLISHED_YEAR_PRICE_CENTS = PUBLISHED_PLAN_PRICES.creator.year;
export function publishedYearSaving(tier: Tier): number {
  return PUBLISHED_PLAN_PRICES[tier].month * 12 - PUBLISHED_PLAN_PRICES[tier].year;
}

/**
 * Whether a subscription to us is at the prices that go with a share of each
 * sale, read from what it charges. A store that subscribed before the share
 * keeps the price it chose and pays no share, which is this telling the two
 * apart: every price in the one set differs from its place in the other.
 */
export function isSharedPrice(tier: Tier, cycle: Cycle, amountCents: number): boolean {
  return amountCents > 0 && amountCents === PRICES_WITH_COMMISSION[tier][cycle] && amountCents !== PRICES_WITHOUT_COMMISSION[tier][cycle];
}

/** The share of a sale a plan takes now, in basis points: none while COMMISSION_LIVE is off. */
export function commissionBps(tier: Tier): number {
  return COMMISSION_LIVE ? COMMISSION_BPS[tier] : 0;
}

/**
 * What a plan takes from a sale of this many cents, before tax: rounded down,
 * so a creator is never charged a fraction of a cent that was not theirs to
 * give. Zero for a refund, a negative amount, or anything that is not money.
 */
export function commissionCents(tier: Tier, saleCents: number): number {
  if (!Number.isFinite(saleCents) || saleCents <= 0) return 0;
  return Math.floor((Math.floor(saleCents) * commissionBps(tier)) / 10_000);
}

/** The monthly subscription, in cents: the price the site leads with. */
export const PRICE_CENTS = PLAN_PRICES.creator.month;
/** The same plan, paid once a year. */
export const YEAR_PRICE_CENTS = PLAN_PRICES.creator.year;

/** What paying yearly saves over twelve monthly payments, in cents. */
export function yearSaving(tier: Tier): number {
  return PLAN_PRICES[tier].month * 12 - PLAN_PRICES[tier].year;
}

/** "$29 a month", "$300 a year". */
export function priceWords(tier: Tier, cycle: Cycle): string {
  const cents = PLAN_PRICES[tier][cycle];
  // "$2,388 a year": a price in the thousands is written the way it is said.
  const dollars = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return `$${dollars} a ${cycle}`;
}

/** Subscription quote for the published offer, independent of live billing. */
export function publishedPriceWords(tier: Tier, cycle: Cycle): string {
  const cents = PUBLISHED_PLAN_PRICES[tier][cycle];
  const dollars = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return `$${dollars} a ${cycle}`;
}

/**
 * What each plan is called on an invoice, at Stripe, and in the studio.
 *
 * These are billing identities. They are the names already on the Stripe
 * products a paying creator's subscription points at, so they do not change
 * for the sake of a page.
 */
export const PLAN_NAMES: Record<Tier, string> = {
  creator: "Marktmorgen",
  pro: "Marktmorgen Pro",
  scale: "Marktmorgen Scale",
};

/**
 * What each plan is called where somebody is choosing between them.
 *
 * "Marktmorgen" and "Marktmorgen Pro" name the seller, not the plan: told
 * only that, a creator still has to read two columns of features to work out
 * which one is their own business. A title has one job in front of somebody
 * deciding — to say what this plan is for — and "Pro" does the opposite of
 * that, because it describes the person rather than the plan and implies the
 * cheaper one is for amateurs.
 *
 * So the chooser reads these, and the small print under the button names the
 * plan the way the invoice will name it, from PLAN_NAMES above. One file, so
 * the two can never drift apart.
 */
export const PLAN_TITLES: Record<Tier, string> = {
  creator: "Store",
  pro: "Studio",
  scale: "Scale",
};

/**
 * Whether Pro can be bought.
 *
 * Pro is what costs us money to run for a creator, or what a creator buys
 * back from us. Three things are built and in it today: email to their
 * list, their own domain, and taking our name off the foot of their page.
 * Nothing else is
 * part of it until it exists in the code. The API that reads a store
 * (app/api/v1) is built and is on every plan, not only Pro; one that writes
 * is not built, and is not sold. Several stores per account are built, and are not a Pro feature: an
 * account runs up to five (lib/store.ts, MAX_STORES_PER_ACCOUNT), each on a
 * plan of its own, Creator or Pro. Funnels and affiliates are built and are
 * on every plan, not only Pro. It went on sale with the first of
 * those two, and not a day before: a plan that costs more and adds nothing
 * yet is not something we will take money for.
 */
export const PRO_ON_SALE = true;

/** List-email ceilings, all campaigns and sequences combined, at the public
 * $0.90/1,000 send rate. Raised on 18 October 2026 with the price list
 * (docs/value-presentation-2026-10-18.md): every list email is the line every
 * competitor prints on its card, so the room the round prices leave went
 * here first. Studio: 7,000 => $6.30; Scale: 10,000 => $9.00 a month, each
 * plan still keeping 60% at full use (tests/spend-floor.test.ts). No free
 * tier is assumed. These limits do not certify the all-tax net margin.
 */
export const PRO_MONTHLY_EMAILS = 7_000;
/** Funded acquisition exposure still requires a separate reviewed allowance. */
export const TRIAL_MONTHLY_EMAILS = 300;
export const SCALE_MONTHLY_EMAILS = 10_000;

/** Whether a plan has what Pro switches on: Pro itself, and Scale above it. */
export function hasPro(tier: Tier): boolean {
  return tier === "pro" || tier === "scale";
}

/** Emails to a list that a paid-up store on this plan may send in a month. */
export function monthlyEmails(tier: Tier): number {
  return tier === "scale" ? SCALE_MONTHLY_EMAILS : tier === "pro" ? PRO_MONTHLY_EMAILS : 0;
}

/**
 * What only Pro switches on. "email", "domain" and "branding" are the ones
 * built. "api" is a name kept for when it is, and "stores" one kept from
 * when several stores were planned for Pro: they are built and on every
 * plan (above), and nothing reads either name.
 *
 * "branding" is the one that costs us nothing to run and something to give:
 * it takes our name off the foot of the creator's page. It is here rather
 * than on every plan because the name at the foot of a page is how a store
 * brings us the next creator, and a store that would rather not carry it is
 * buying back the thing it would otherwise have paid us in.
 */
export type ProFeature = "email" | "domain" | "branding" | "stores" | "api";

/**
 * Whether a store may use a Pro feature right now: paid up, on Pro. Read from
 * the snapshot the studio refreshes, so a buyer's page never waits on Stripe.
 */
export function canUse(
  store: { subscriptionActive: boolean; tier: Tier; renewalUnpaidSince?: number; planDisputes?: PlanDispute[] },
  feature: ProFeature,
): boolean {
  // Emails to the list stop while a renewal is unpaid (232 [CA1] unit 4);
  // the store's own domain and look stay, so its page stays up as it was.
  if (feature === "email" && (store.renewalUnpaidSince ?? 0) > 0) return false;
  // And while a plan payment is disputed (unit 5, lib/plan-dispute-rules.ts).
  if (feature === "email" && store.subscriptionActive && planDisputed(store)) return false;
  return store.subscriptionActive && hasPro(store.tier);
}

export function parseTier(raw: unknown): Tier | null {
  return raw === "creator" || raw === "pro" || raw === "scale" ? raw : null;
}

export function parseCycle(raw: unknown): Cycle | null {
  return raw === "month" || raw === "year" ? raw : null;
}

/**
 * Days of the subscription that are free.
 *
 * The card is taken when the trial starts and first charged when it ends, and
 * cancelling inside it — one click in the studio — means it is never charged.
 * Every public sentence about the trial has to say exactly that, no more.
 *
 * Long enough for a creator to put a product up and actually sell something
 * before deciding whether we are worth paying for. A trial that ends before
 * the first sale proves nothing to anybody.
 */
export const TRIAL_DAYS = 14;

/**
 * Days after a charge in which we give it back in full, on request.
 *
 * The trial answers "is this the right tool", which you can tell in a
 * fortnight. This answers a different question — "was paying for it worth
 * it" — and that one is only answered by using it on a real month of real
 * sales, which is longer than the trial and starts after it. A window
 * shorter than that asks a creator to decide before they can know, which is
 * how a refund policy ends up being a formality rather than a promise.
 *
 * It covers the first payment on an account, in full (changed 12 October
 * 2026; until then every charge). A month given back after it was used is a
 * month we served for nothing, up to the plan's whole worst case plus the
 * card fee Stripe keeps: a bounded cost, taken once, so somebody can try a
 * paid plan for real. On every charge it was a way to use every month free
 * by asking, with no bound at all. A yearly plan is refunded at any time for
 * the months not started, the months used kept at the monthly price, which
 * always covers that month's worst case (tests/plan-margin.test.ts); so
 * three hundred dollars taken in one payment is still the charge most worth
 * standing behind, and a creator who regrets it in week three loses one
 * month, not twelve.
 *
 * Every public sentence about refunds reads this number, including the
 * Refund Policy and the Terms, and INVITE_HOLD_DAYS is derived from it so
 * credit is never paid out on a payment that can still be given back.
 */
export const REFUND_DAYS = 30;
