/**
 * A creator's affiliates: people who send buyers to the store and earn a
 * share of what those buyers pay.
 *
 * The one rule this file is built around: Marktmorgen never holds, moves or pays
 * out any of this money. Every sale is paid to the creator's own Stripe
 * account, in full, like every other sale here. What is kept is the record —
 * who applied, who the creator let in, which sale came through whose link,
 * what that earns and what the creator says they have paid — and the creator
 * pays their affiliates themselves, however they like. The studio says so,
 * and so does every page an affiliate sees.
 *
 * How a sale is credited:
 *
 *   - an affiliate's link is the store's address with ?via=<code>. Following
 *     it leaves a first-party cookie on the store's own address (proxy.ts)
 *     holding the code and the time. The last link followed wins;
 *   - when the buyer opens a checkout within the store's window, and the code
 *     belongs to someone the creator approved, the affiliate and the share
 *     the product earns today travel with the charge in its metadata. Only
 *     one-off payments are credited: memberships and payment plans are not;
 *   - once Stripe says the checkout is settled, the sale is written down here
 *     with what was paid before tax, read from Stripe. The thanks page and
 *     the five-minute job both do this, so a buyer who never comes back is
 *     still counted, and each sale is written once;
 *   - what it earns is worked out when it is shown, against the refunds on
 *     the creator's Stripe account, so a refunded sale earns nothing and a
 *     partly refunded one earns on what was kept. A chargeback counts the
 *     same way (added 17 October 2026): while the bank holds the disputed
 *     money, and for good once the dispute is lost, that money was not kept,
 *     so it earns nothing; a dispute the creator wins earns again;
 *   - a membership or a payment plan, where the creator credits them (added
 *     12 October 2026, lib/affiliate-setting.ts recurring), carries the
 *     affiliate on its subscription, and each of its paid invoices is read
 *     from the creator's Stripe account when the book is: a membership's
 *     while it is within the months agreed when it was sold, a plan's every
 *     one. Nothing is written for them here;
 *   - a bonus for each goal reached in a calendar month is worked out from
 *     the same lines, so a refund that takes the month back under the goal
 *     takes the bonus back too.
 *
 * What stops it being gamed:
 *
 *   - nobody earns on their own purchase: a sale paid with the affiliate's own
 *     address is written down as such and earns nothing, and a browser signed
 *     in as that affiliate is not credited at all;
 *   - the creator cannot be their own affiliate;
 *   - a click counts once per visitor per day, clicks from one connection are
 *     capped per hour, and the creator's own clicks and known robots are not
 *     counted;
 *   - two affiliates paid at the same address, or signing up with the same
 *     inbox written two ways (a "+" tag, Gmail's dots), and an affiliate
 *     whose link was reached from a paid search ad where the creator does
 *     not allow those, have what they are owed held, out of every payment,
 *     until the creator looks and releases it;
 *   - a purchase paid from the affiliate's inbox written another way is
 *     their own purchase all the same;
 *   - applying needs the address to be real — the application only exists
 *     once its emailed link is opened — and is capped per hour, per
 *     connection and per address.
 *   - where the creator lets buyers join on their own, the proof is the
 *     order itself: the checkout's id, which only the thanks page and the
 *     purchase email carry, is read back from the creator's Stripe account,
 *     and the address that paid is the one that joins.
 *
 * Records, under the store's own stats id so they move with the store:
 *
 *   nl:aff:<id>:people   hash  affiliate id -> the affiliate
 *   nl:aff:<id>:emails   hash  address -> affiliate id
 *   nl:aff:<id>:codes    hash  code -> affiliate id
 *   nl:aff:<id>:clicks   hash  affiliate id -> clicks counted
 *   nl:aff:<id>:paid     hash  affiliate id -> clicks counted that came from a paid search ad
 *   nl:aff:<id>:sales    hash  Stripe reference -> the sale
 *   nl:aff:<id>:payouts  hash  payout id -> what the creator says they paid
 */
import { rememberAffiliate } from "@/lib/affiliate-hub";
import { type Paid, paypalPaymentId, readPaidExact, readPayPalRefundsWithCoverage, refundedKey as paypalRefundedKey } from "@/lib/paypal-sales";
import { MAX_STORE_BYTES, saleHandles, storeForEmailSeen, storeForId, storeRef } from "@/lib/store";
import { storeForIdExactly } from "@/lib/store-exact";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, type SendOutcome, isSenderConfigured, sendEmail, sendEmailOutcome } from "@/lib/email";
import { REFUSED_TRIES, countRefusal, refusedTooOften } from "@/lib/refused-tries";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { giveData, needData } from "@/lib/store-data";
import { orderWrite } from "@/lib/order-data";
import { dataBytes } from "@/lib/store-data-rules";
import { affiliatePromotionFrom, readAffiliatePromotion, type AffiliatePromotion } from "@/lib/affiliate-promotion";
import { onAccount } from "@/lib/stripe-account";
import { STRIPE_LIST_VERSION, readStripePage } from "@/lib/stripe-list";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { DISPUTE_TAKES } from "@/lib/retained-revenue";
import { isSettled } from "@/lib/instant-pay";
import { SITE_URL } from "@/lib/site-url";
import {
  AFFILIATE_CODE_PATTERN,
  type AffiliateSetting,
  MAX_AFFILIATES,
  MAX_COMMISSION,
  MIN_COMMISSION,
  commissionOn,
  commissionRate,
  creditsContacts,
  RECURRING_ALWAYS,
  readViaCookie,
  type Via,
} from "@/lib/affiliate-setting";
import { type Card, productIds, readCardsFor, readListing } from "@/lib/catalog";
import type { HeldOne, HeldWhy } from "@/lib/affiliate-bulk-words";
import type { BookSizes } from "@/lib/api-read-rules";
import { affiliateForCodes, codeOwners, promoCodesOn } from "@/lib/affiliate-codes";
import { MAX_COMMITTED_SHARE, type PartnerShare, type ShareProblem, parsePartnerShare, shareOn, shareProblem } from "@/lib/partner-share";
import { type Held, LockBusyError, holdLock, withLock } from "@/lib/redis-lock";
import { bondFor, rememberBuyer } from "@/lib/affiliate-bond";
import { offerPartnership } from "@/lib/partner-invites";
import type { Store } from "@/lib/store";
import { plainAmount } from "@/lib/money";
import { alertCreator } from "@/lib/phone-alerts";
import { bumpsFromMeta } from "@/lib/bundle-rules";
import { affiliatesWords } from "@/lib/buyer-words/affiliates";
import { type LeadKind, type LeadReason, type LeadStatus, type SettledLead, leadsKey, parseLead, settleLeads } from "@/lib/affiliate-lead-rules";
import { readMoves } from "@/lib/call-records";
import { leadWords } from "@/lib/buyer-words/affiliate-leads";
import { formatMoney } from "@/lib/money";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { idleStep, readIdleDays } from "@/lib/affiliate-idle-rules";

/** How long the emailed link to apply or sign in keeps working. */
export const AFFILIATE_LINK_SECONDS = 24 * 60 * 60;
/** How long an affiliate stays signed in on one browser. */
export const AFFILIATE_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const AFFILIATE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const AFFILIATE_ID_PATTERN = /^[0-9a-f]{12}$/;
export const MAX_NOTE_LENGTH = 200;
export const MAX_REFERENCE_LENGTH = 80;
/** Applications from one connection to one store, and for one inbox, per hour. */
const APPLY_IP_LIMIT = 10;
const APPLY_ADDRESS_LIMIT = 5;
/** Clicks counted from one connection to one store per hour. */
const CLICK_IP_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60 * 60;
/** How many pages of a hundred refunds are read when the book is opened. */
export const REFUND_PAGES = 10;
/** And of a hundred disputes, which are far fewer. */
export const DISPUTE_PAGES = 3;
// DISPUTE_TAKES, the dispute states that take the money, is lib/retained-revenue.ts's: the numbers read the same set.

/** The cookie an affiliate's own browser is signed in with, one per store. */
export function affiliateCookieName(handle: string): string {
  return `nl_aff_${handle.replace(/[^a-z0-9._-]/g, "")}`;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const peopleKey = (id: string) => `nl:aff:${id}:people`;
const emailsKey = (id: string) => `nl:aff:${id}:emails`;
const codesKey = (id: string) => `nl:aff:${id}:codes`;
const clicksKey = (id: string) => `nl:aff:${id}:clicks`;
const paidClicksKey = (id: string) => `nl:aff:${id}:paid`;
const salesKey = (id: string) => `nl:aff:${id}:sales`;
const payoutsKey = (id: string) => `nl:aff:${id}:payouts`;
/** A partner's share of one sale, keyed "<sale reference>:<partner id>". */
const sharesKey = (id: string) => `nl:aff:${id}:shares`;
const linkKey = (token: string) => `nl:aff:link:${sha(`nimbus-aff-link:${token}`).slice(0, 40)}`;
const sessionKey = (token: string) => `nl:aff:session:${sha(`nimbus-aff-session:${token}`).slice(0, 40)}`;
const seenKey = (parts: string) => `nl:aff:seen:${sha(`nimbus-aff-seen:${parts}`).slice(0, 40)}`;
const clickIpKey = (ip: string, id: string) => `nl:rl:aff:click:${sha(`nimbus-aff-click:${ip}:${id}`).slice(0, 32)}`;
const applyIpKey = (ip: string, handle: string) => `nl:rl:aff:ip:${sha(`nimbus-aff-ip:${ip}:${handle}`).slice(0, 32)}`;
const applyAddressKey = (email: string) => `nl:rl:aff:addr:${sha(`nimbus-aff-addr:${email}`).slice(0, 32)}`;

export type AffiliateStatus = "pending" | "approved" | "declined" | "removed";

export type Affiliate = {
  id: string;
  email: string;
  /** What their link carries: ?via=<code>. */
  code: string;
  status: AffiliateStatus;
  /** When they applied, and when the creator last decided, in ms. */
  appliedAt: number;
  decidedAt: number;
  /** Where they said they would share the store, in their words. */
  note: string;
  /**
   * A share the creator set for this affiliate alone, in percent, replacing
   * the store's and each product's (lib/affiliate-setting.ts commissionRate).
   * Null: the program's own shares.
   */
  rate: number | null;
  /**
   * When that share last changed (epoch ms, withRate), so a sale confirmed later knows whether the share it was made
   * at is still the one held (owner's decision 6). Absent on a record whose share has not changed since 9 November
   * 2026: a share set then is of an unknown date.
   */
  rateAt?: number;
  /** The PayPal address they asked to be paid at; empty: the address they joined with. */
  paypal: string;
  /**
   * A standing share of every sale of certain products, whoever brought the
   * buyer — what Hotmart calls co-production (lib/partner-share.ts). Null for
   * an ordinary affiliate, which is almost everybody. Somebody can hold both:
   * the two add up, and the cap counts them together.
   */
  share: PartnerShare | null;
  /**
   * What the creator looked at and let through (releaseHold): the paid-search
   * clicks there were then, and the affiliates they shared an address with
   * then. Somebody new sharing it holds it again. Null for anybody never held.
   */
  cleared: { paid: number; with: string[] } | null;
  /**
   * The affiliate whose invitation link they joined through, and the second
   * tier's percent as it stood when they joined (lib/affiliate-setting.ts
   * secondTier). That affiliate earns it on each sale this one brings, on top
   * of this one's own share. Null for everybody else.
   */
  by: { id: string; percent: number } | null;
  /**
   * When they were last warned that they would be removed for bringing no
   * sale and no lead (630 [HN6](3), idleSweep), in seconds; 0 if never.
   */
  warned?: number;
};

/**
 * What tied a sale to an affiliate:
 *
 *   "click"  they followed the affiliate's link (lib/affiliate-setting.ts);
 *   "code"   they typed a discount code given to that affiliate, with no
 *            click anywhere (lib/affiliate-codes.ts);
 *   "buyer"  they had been credited to that affiliate before, and the creator
 *            asked for their buyers to stay theirs (lib/affiliate-bond.ts);
 *   "contact" nothing else credited it, and the buyer is a confirmed lead
 *            that affiliate brought, where the creator asked for contacts to
 *            earn their affiliate (lib/affiliate-leads.ts contactFor; 630 [HN6](1));
 *   "partner" nobody brought this buyer to them: they hold a standing share
 *            of the product itself (lib/partner-share.ts);
 *   "recurring" a payment of a membership or payment plan sold through their
 *            link, read from its invoice;
 *   "bonus"  a goal reached in a month, not a sale at all;
 *   "tier2"  a sale brought by somebody who joined through their invitation
 *            link: the second tier, worked out when the book is read;
 *   "lead"   not a sale: a confirmed lead, earning the program's fixed amount
 *            per lead (lib/affiliate-leads.ts, added 18 October 2026).
 */
export type Credit = "click" | "code" | "buyer" | "partner" | "contact" | "recurring" | "bonus" | "tier2" | "lead";

/** A sale that came through an affiliate's link. */
export type Referral = {
  /** The Checkout Session, or the one-click payment, that paid for it. */
  ref: string;
  /** The payment behind it, which is what a refund is made against. */
  pi: string;
  aff: string;
  /** When it was paid, in seconds. */
  at: number;
  product: string;
  title: string;
  /** What was paid before tax, in the currency's smallest unit: what the share is taken of. */
  base: number;
  /** What was paid in all, tax included, in the currency's smallest unit. */
  total: number;
  /**
   * What it was paid in, as Stripe says. Sales written down before stores
   * had a choice have none, and were in US dollars.
   */
  currency: string;
  /** The share it earns, in percent, as it was when the buyer paid. */
  rate: number;
  /** Paid with the affiliate's own address: written down, earns nothing. */
  self: boolean;
  /** What credited it: a click, a code, or the buyer being theirs already. */
  how: Credit;
  /** Optional campaign labels recorded at checkout; absent on older records. */
  promotion?: AffiliatePromotion | null;
};

/**
 * A partner's share of one sale (lib/partner-share.ts).
 *
 * Written for every sale of a product they share in, whoever brought the
 * buyer — which is the whole difference from a Referral, and why it is kept
 * apart rather than squeezed into one. One sale can produce several of these
 * and a Referral besides: the affiliate who brought the buyer, and each
 * partner who shares in the product. They all end up in the same row of the
 * same book, and are paid in the same batch.
 */
export type PartnerEarning = {
  /** The Checkout Session, or one-click payment, that paid for it. */
  ref: string;
  /** The payment behind it, which is what a refund is made against. */
  pi: string;
  /** The partner. */
  aff: string;
  /** When it was paid, in seconds. */
  at: number;
  product: string;
  title: string;
  /** What was paid before tax, in the currency's smallest unit. */
  base: number;
  /** What was paid in all, tax included. */
  total: number;
  currency: string;
  /** The share it earns, in percent, as it stood when the buyer paid. */
  percent: number;
  /** Bought by the partner themselves: written down, earns nothing. */
  self: boolean;
};

export type Payout = {
  id: string;
  aff: string;
  /** In the currency's smallest unit. */
  cents: number;
  /** The store's currency when it was written down; US dollars before there was a choice. */
  currency: string;
  /** The day the creator paid it, as they typed it: YYYY-MM-DD. */
  date: string;
  /** Their own note of it: a PayPal id, a bank reference, "cash". */
  reference: string;
  at: number;
};

/** Whether the programme is on and can keep its records. */
export function affiliatesOn(store: Store): boolean {
  return store.affiliates.enabled && Boolean(store.statsId) && isRedisConfigured();
}

/** Whether people can apply: the programme is on and its emails can be sent. */
export function canApply(store: Store): boolean {
  return affiliatesOn(store) && isSenderConfigured();
}

function parseAffiliate(raw: unknown): Affiliate | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Affiliate>;
    if (typeof value.id !== "string" || !AFFILIATE_ID_PATTERN.test(value.id)) return null;
    if (typeof value.email !== "string" || typeof value.code !== "string") return null;
    const status: AffiliateStatus =
      value.status === "approved" || value.status === "declined" || value.status === "removed" ? value.status : "pending";
    return {
      id: value.id,
      email: value.email,
      code: value.code,
      status,
      appliedAt: typeof value.appliedAt === "number" ? value.appliedAt : 0,
      decidedAt: typeof value.decidedAt === "number" ? value.decidedAt : 0,
      note: typeof value.note === "string" ? value.note : "",
      rate:
        typeof value.rate === "number" && Number.isInteger(value.rate) && value.rate >= MIN_COMMISSION && value.rate <= MAX_COMMISSION
          ? value.rate
          : null,
      paypal: typeof value.paypal === "string" && EMAIL_PATTERN.test(value.paypal) ? value.paypal : "",
      share: parsePartnerShare(value.share),
      cleared:
        value.cleared && typeof value.cleared === "object"
          ? {
              paid: Math.max(0, Number((value.cleared as { paid?: unknown }).paid) || 0),
              with: (Array.isArray((value.cleared as { with?: unknown }).with) ? ((value.cleared as { with: unknown[] }).with) : [])
                .filter((id): id is string => typeof id === "string" && AFFILIATE_ID_PATTERN.test(id))
                .slice(0, 50),
            }
          : null,
      by: (() => {
        const by = value.by as { id?: unknown; percent?: unknown } | null | undefined;
        if (!by || typeof by !== "object" || typeof by.id !== "string" || !AFFILIATE_ID_PATTERN.test(by.id) || by.id === value.id) return null;
        const percent = Number(by.percent);
        return Number.isInteger(percent) && percent >= 1 && percent <= MAX_COMMISSION ? { id: by.id, percent } : null;
      })(),
      warned: Number.isInteger(value.warned) && Number(value.warned) > 0 ? Number(value.warned) : 0,
      ...(Number.isSafeInteger(value.rateAt) && Number(value.rateAt) > 0 ? { rateAt: Number(value.rateAt) } : {}),
    };
  } catch {
    return null;
  }
}

/** Where an affiliate is paid through PayPal: the address they asked for, or the one they joined with. */
export function payAddress(affiliate: Pick<Affiliate, "email" | "paypal">): string {
  return affiliate.paypal || affiliate.email;
}

/**
 * Sets, or clears with null, the share one affiliate earns. Written over exactly the record read (changeAffiliate),
 * so a share or a decision written meanwhile is kept.
 *
 * A share of their own that only goes down is written at once: it never raises what a sale promises. A move between
 * their own share and the program's is judged under the program's partner lock, against the terms read exactly now:
 * one that pays no more on any product (paysNoMore: the program's 30% for an own 20%, say) is a reduction too, written
 * without reading the program's people and never refused for them. Any other change is checked against the partners
 * and the commission read exactly now (commissionProblem, #2995 follow-up): over the 90% cap on a product with
 * partners, ShareCapError and nothing written. Unknown reply: UnknownReplyError; the lock not held: LockBusyError;
 * nothing written either way.
 */
/** An affiliate's record with its own share set to `rate`, and the moment it changed when it did (rateAt). */
function withRate(affiliate: Affiliate, rate: number | null): Affiliate {
  return affiliate.rate === rate ? { ...affiliate, rate } : { ...affiliate, rate, rateAt: Date.now() };
}

export async function setAffiliateRate(store: Store, id: string, rate: number | null, charge: Charge = PAID): Promise<Affiliate | null> {
  if (rate !== null && (!Number.isInteger(rate) || rate < MIN_COMMISSION || rate > MAX_COMMISSION)) return null;
  const lowers = (a: Affiliate) => rate !== null && a.rate !== null && rate <= a.rate;
  const plain = await changeAffiliate(store, id, (affiliate) => (lowers(affiliate) ? withRate(affiliate, rate) : null));
  if (!plain) return null;
  if (plain.next) return plain.next;
  if (plain.before.rate === rate) return plain.before;
  return withPartnerLock(store, async (held) => {
    const now = await storeNow(store);
    const lost = () => new LockBusyError("the partner lock was lost before an affiliate's share was written");
    // The terms cannot change while the lock is held (every save of them takes it), so "pays no more" stays true.
    if (!(await holdLock(held))) throw lost();
    const lowered = await changeAffiliate(store, id, (affiliate) => (paysNoMore(now.affiliates, affiliate.rate, rate) ? withRate(affiliate, rate) : null));
    if (!lowered) return null;
    if (lowered.next) return lowered.next;
    if (lowered.before.rate === rate) return lowered.before;
    const problem = await commissionProblem(now, { rate: { id, rate } }, charge);
    if (problem) throw new ShareCapError(problem);
    if (!(await holdLock(held))) throw lost();
    return (await changeAffiliate(store, id, (affiliate) => withRate(affiliate, rate)))?.next ?? null;
  });
}

/**
 * Sets, or clears with null, a partner's standing share of certain products.
 *
 * Whether the share is allowed at all — the cap over everything promised on
 * one product, affiliate commission included — is decided by the caller with
 * lib/partner-share.ts shareProblem, which needs the other partners and the
 * programme's own rates. This only writes what it is given.
 *
 * Shares already earned are untouched by a change here: each one was written
 * down with the percentage it was made at, exactly as a commission is.
 */
export async function setPartnerShare(store: Store, id: string, share: PartnerShare | null): Promise<Affiliate | null> {
  return (await changeAffiliate(store, id, (affiliate) => ({ ...affiliate, share })))?.next ?? null;
}

/** Everybody in this programme who holds a standing share of something. */
export async function listPartners(store: Store): Promise<Affiliate[]> {
  return (await listAffiliates(store)).filter((a) => a.share !== null);
}

/** The program's partner lock: every write of a standing share takes it, so the cap is checked against what is there. */
const partnerLockKey = (statsId: string) => `nl:aff:${statsId}:partners:lock`;
const PARTNER_LOCK_SECONDS = 15;
const PARTNER_LOCK_WAIT_MS = 3_000;

/**
 * Runs `work` holding this program's partner lock (lib/redis-lock.ts). A share set from the studio and a partnership
 * accepted (an invitation's emailed link or the invitee's studio) each check the cap and write under it, so two of
 * them at the same instant cannot each read the other's room and both pass (#2995 review). Throws LockBusyError when
 * the lock stays taken, or its receipt is unknown: nothing is written then.
 */
export async function withPartnerLock<T>(store: Store, work: (held: Held) => Promise<T>): Promise<T> {
  return withLock(partnerLockKey(store.statsId as string), PARTNER_LOCK_SECONDS, PARTNER_LOCK_WAIT_MS, work);
}

/**
 * Whether `share` may be held by the affiliate `self` (null for somebody not yet in the program), against the
 * program's other approved partners as read exactly now and the affiliate commission on each product
 * (lib/partner-share.ts shareProblem). `self`'s own current share is replaced, not added. Throws UnknownReplyError
 * when the people could not be read exactly: never "nobody".
 */
export async function partnerShareProblem(store: Store, share: PartnerShare, self: string | null, charge: Charge = PAID): Promise<ShareProblem | null> {
  // The commission as it is now, not as the request read it before the lock: a raise saved meanwhile counts.
  const now = await storeNow(store);
  // The people read paid for first at their worst and settled at what was read (paidPeople, rule 30).
  return shareProblemAmong(now.affiliates, await paidPeople(now, charge), share, self);
}

/** partnerShareProblem against `people` and `terms` already read (a batch checks many against one read). */
function shareProblemAmong(terms: CommissionTerms, people: readonly Affiliate[], share: PartnerShare, self: string | null): ShareProblem | null {
  const others: Record<string, number[]> = {};
  for (const other of people) {
    if (other.id === self || other.status !== "approved" || !other.share) continue;
    for (const product of other.share.products) (others[product] ??= []).push(other.share.percent);
  }
  // The most an affiliate can earn on each product: the program's, the product's, or one affiliate's own (rule 30).
  const affiliatePercent: Record<string, number> = {};
  for (const product of share.products) affiliatePercent[product] = topCommission(terms, people, product);
  return shareProblem({ percent: share.percent, products: share.products, others, affiliatePercent });
}

/**
 * The store as it is this moment, read again, never the copy a request read before taking the partner lock. Throws
 * UnknownReplyError when it cannot be read, or reads as another program: the cap is never checked against a guess.
 */
async function storeNow(store: Store, meter?: Meter): Promise<Store> {
  const now = await storeForEmailSeen(storeRef(store), (commands, reply) => counted(meter, commands, reply));
  if (!now || now.statsId !== store.statsId) throw new UnknownReplyError("the store's affiliate commission");
  return now;
}

type CommissionTerms = Pick<AffiliateSetting, "percent" | "rates">;

/**
 * The most any affiliate can earn on one product: the program's share, the product's own, or one affiliate's own
 * (lib/affiliate-setting.ts commissionRate), whatever their status, since a decision can make anybody approved again.
 * A product set to 0% stays out for everyone.
 */
export function topCommission(terms: CommissionTerms, people: readonly Pick<Affiliate, "rate">[], product: string): number {
  let top = commissionRate(terms, product);
  for (const person of people) if (person.rate !== null) top = Math.max(top, commissionRate(terms, product, person.rate));
  return top;
}

/** Whether `after` pays more than `before` anywhere: the program's share, or any product's own. */
export function commissionRaised(before: CommissionTerms, after: CommissionTerms): boolean {
  if (after.percent > before.percent) return true;
  for (const id of new Set([...Object.keys(before.rates), ...Object.keys(after.rates)])) {
    if (commissionRate(after, id) > commissionRate(before, id)) return true;
  }
  return false;
}

/**
 * Whether an affiliate earning `to` (their own share, or null for the program's) instead of `from` is paid no more on
 * any product under `terms`: on each product with a share of its own, and on every other (the program's share).
 * A product set to 0% stays at 0 either way (commissionRate).
 */
export function paysNoMore(terms: CommissionTerms, from: number | null, to: number | null): boolean {
  if (from === to) return true;
  // "" is no product's id (lib/catalog.ts ids are never empty): it reads as any product with no share of its own.
  return [...Object.keys(terms.rates), ""].every((product) => commissionRate(terms, product, to) <= commissionRate(terms, product, from));
}

/**
 * Whether moving from (`terms`, `people`) to (`nextTerms`, `nextPeople`) makes a product with approved partners
 * promise more than MAX_COMMITTED_SHARE of a sale: its partners' shares plus the most an affiliate can earn on it.
 * Only a rise is refused: a change that lowers what a product promises, or leaves it, passes even where an older
 * state is already over the cap, so a creator can always come back under it.
 */
export function commissionCapProblem(input: {
  terms: CommissionTerms;
  people: Affiliate[];
  nextTerms: CommissionTerms;
  nextPeople: Affiliate[];
}): ShareProblem | null {
  const partners = new Map<string, number>();
  for (const person of input.nextPeople) {
    if (person.status !== "approved" || !person.share) continue;
    for (const product of person.share.products) partners.set(product, (partners.get(product) ?? 0) + person.share.percent);
  }
  for (const [product, shared] of partners) {
    const before = shared + topCommission(input.terms, input.people, product);
    const after = shared + topCommission(input.nextTerms, input.nextPeople, product);
    if (after > MAX_COMMITTED_SHARE && after > before) return "committed";
  }
  return null;
}

/**
 * Whether a change of commission may be saved (#2995 follow-up): the program's terms (`terms`) or one affiliate's
 * own share (`rate`), against `now` (the store read under the partner lock, which the caller holds) and the
 * program's people read exactly now. Throws UnknownReplyError when the people could not be read.
 */
export async function commissionProblem(
  now: Store,
  change: { terms?: CommissionTerms; rate?: { id: string; rate: number | null } },
  charge: Charge = PAID,
): Promise<ShareProblem | null> {
  // Paid for first at its worst and settled at what was read (paidPeople, rule 30).
  const people = await paidPeople(now, charge);
  const rate = change.rate;
  const nextPeople = rate ? people.map((person) => (person.id === rate.id ? { ...person, rate: rate.rate } : person)) : people;
  return commissionCapProblem({ terms: now.affiliates, people, nextTerms: change.terms ?? now.affiliates, nextPeople });
}

/**
 * The affiliate choosing the PayPal address they are paid at, from their own
 * signed-in page. Where money goes is the one thing on that page worth taking
 * over, so the address they joined with is told every time it changes.
 */
export async function setPayAddress(store: Store, affiliate: Affiliate, raw: string): Promise<{ ok: true } | { ok: false; reason: "email" }> {
  const typed = raw.trim().slice(0, MAX_EMAIL_LENGTH);
  const paypal = typed ? normaliseEmail(typed) : "";
  if (paypal && !EMAIL_PATTERN.test(paypal)) return { ok: false, reason: "email" };
  const valueFor = (a: Affiliate) => (paypal === normaliseEmail(a.email) ? "" : paypal);
  // Only the address is changed, over exactly the record read: a share or a decision written meanwhile is kept.
  const changed = await changeAffiliate(store, affiliate.id, (now) => (valueFor(now) === now.paypal ? null : { ...now, paypal: valueFor(now) }));
  if (!changed?.next) return { ok: true };
  const value = changed.next.paypal;
  if (isSenderConfigured()) {
    const a = affiliatesWords(store.language);
    await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
      to: affiliate.email,
      subject: a.payChangedSubject(store.name),
      text: [
        a.payChangedLine(store.name, value || affiliate.email),
        "",
        a.payChangedIfNot,
        `${SITE_URL}/@${store.handle}/affiliates`,
      ].join("\n"),
      replyTo: store.email,
    }).catch((error) => console.error("telling an affiliate their pay address changed failed", error));
  }
  return { ok: true };
}

function parseReferral(raw: unknown): Referral | null {
  if (typeof raw !== "string") return null;
  try {
    // `byCode` is not on Referral any more: it is the older spelling of
    // `how`, still read so a sale written down then keeps its credit.
    const value = JSON.parse(raw) as Partial<Referral> & { byCode?: unknown };
    if (typeof value.ref !== "string" || typeof value.aff !== "string") return null;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return {
      ref: value.ref,
      pi: typeof value.pi === "string" ? value.pi : "",
      aff: value.aff,
      at: n(value.at),
      product: typeof value.product === "string" ? value.product : "",
      title: typeof value.title === "string" ? value.title : "",
      base: n(value.base),
      total: n(value.total),
      currency: readCurrencyCode(value.currency),
      rate: n(value.rate),
      self: value.self === true,
      ...(readAffiliatePromotion(value.promotion) ? { promotion: readAffiliatePromotion(value.promotion) } : {}),
      // Sales written down before a code or a bond could credit anybody have
      // neither field, and every one of those came from a click. `byCode` is
      // read for the ones written in between.
      how:
        value.how === "code" || value.how === "buyer" || value.how === "partner" || value.how === "contact"
          ? value.how
          : value.byCode === true
            ? "code"
            : "click",
    };
  } catch {
    return null;
  }
}

function parsePartnerEarning(raw: unknown): PartnerEarning | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<PartnerEarning>;
    if (typeof value.ref !== "string" || typeof value.aff !== "string") return null;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return {
      ref: value.ref,
      pi: typeof value.pi === "string" ? value.pi : "",
      aff: value.aff,
      at: n(value.at),
      product: typeof value.product === "string" ? value.product : "",
      title: typeof value.title === "string" ? value.title : "",
      base: n(value.base),
      total: n(value.total),
      currency: readCurrencyCode(value.currency),
      percent: n(value.percent),
      self: value.self === true,
    };
  } catch {
    return null;
  }
}

function parsePayout(raw: unknown): Payout | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<Payout>;
    if (typeof value.id !== "string" || typeof value.aff !== "string" || typeof value.cents !== "number") return null;
    return {
      id: value.id,
      aff: value.aff,
      cents: value.cents,
      currency: readCurrencyCode(value.currency),
      date: typeof value.date === "string" ? value.date : "",
      reference: typeof value.reference === "string" ? value.reference : "",
      at: typeof value.at === "number" ? value.at : 0,
    };
  } catch {
    return null;
  }
}

/** A three-letter currency code as Stripe writes it; US dollars when absent. */
function readCurrencyCode(raw: unknown): string {
  return typeof raw === "string" && /^[a-z]{3}$/.test(raw) ? raw : "usd";
}

/** A Redis hash reply, as pairs. */
function pairs(reply: unknown): [string, string][] {
  const list = Array.isArray(reply) ? reply.map(String) : [];
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]);
  return out;
}

/**
 * A HGETALL reply as pairs, read exactly: one reply for the one command, a list of strings with an even count, or
 * UnknownReplyError (CX-123 rule 24). HGETALL answers an empty list for a hash with nothing in it, so a reply missing,
 * cut short or of another shape is never "nobody".
 */
function hashPairsExact(replies: unknown, what: string): [string, string][] {
  const list = stringList(repliesFor(replies, 1)?.[0]);
  if (!list || list.length % 2 !== 0) throw new UnknownReplyError(what);
  const out: [string, string][] = [];
  for (let i = 0; i < list.length; i += 2) out.push([list[i], list[i + 1]]);
  return out;
}

/**
 * Every record of the program, newest first. Throws UnknownReplyError when the people could not be read exactly:
 * the partner-share cap, a hold's release, the export and the duplicate-inbox check must never read "nobody" from a
 * reply they do not understand (docs/reviews/c5-sweep-app1.md finding 1).
 */
export async function listAffiliates(store: Store): Promise<Affiliate[]> {
  return [...(await peopleExact(store)).values()].map((one) => one.affiliate).sort((a, b) => b.appliedAt - a.appliedAt);
}

/** One pipeline, counted on `meter` when there is one (what a paid part of a change moved). */
async function piped(meter: Meter | undefined, commands: (string | number)[][]): Promise<unknown[]> {
  const replies = await redisPipeline(commands);
  counted(meter, commands, replies);
  return replies;
}

/** One record as read, with the text it was read as, so it can be written over exactly that (changeAffiliate). */
type Read = { raw: string; affiliate: Affiliate };

/** Every record of the program by its field (its id), each with its text (one HGETALL). Throws UnknownReplyError like listAffiliates. */
async function peopleExact(store: Store, meter?: Meter): Promise<Map<string, Read>> {
  const out = new Map<string, Read>();
  if (!store.statsId || !isRedisConfigured()) return out;
  for (const [field, raw] of hashPairsExact(await piped(meter, [["HGETALL", peopleKey(store.statsId)]]), "an affiliate program's people")) {
    const affiliate = parseAffiliate(raw);
    if (affiliate) out.set(field, { raw, affiliate });
  }
  return out;
}

/**
 * The records of these people, in one HMGET, each with its text; null for one not there (or not readable as a
 * record). Throws UnknownReplyError when the reply is not exactly one string or nil for each: never "nobody".
 */
async function recordsExact(store: Store, ids: readonly string[], meter?: Meter): Promise<Map<string, Read | null>> {
  const out = new Map<string, Read | null>();
  if (!ids.length) return out;
  const reply = repliesFor(await piped(meter, [["HMGET", peopleKey(store.statsId as string), ...ids]]), 1);
  const slots = reply ? repliesFor(reply[0], ids.length) : null;
  if (!slots) throw new UnknownReplyError("an affiliate program's records");
  ids.forEach((id, i) => {
    const raw = slots[i];
    if (raw !== null && typeof raw !== "string") throw new UnknownReplyError("an affiliate's record");
    const affiliate = raw === null ? null : parseAffiliate(raw);
    out.set(id, raw !== null && affiliate?.id === id ? { raw, affiliate } : null);
  });
  return out;
}

/** How many records the program keeps (one HLEN), read exactly: UnknownReplyError otherwise. */
async function peopleCount(store: Store, meter?: Meter): Promise<number> {
  const reply = repliesFor(await piped(meter, [["HLEN", peopleKey(store.statsId as string)]]), 1);
  const count = reply ? countOf(reply[0]) : null;
  if (count === null) throw new UnknownReplyError("how many records an affiliate program keeps");
  return count;
}

export async function readAffiliate(store: Store, id: string): Promise<Affiliate | null> {
  if (!store.statsId || !isRedisConfigured() || !AFFILIATE_ID_PATTERN.test(id)) return null;
  const [raw] = await redisPipeline([["HGET", peopleKey(store.statsId), id]]);
  return parseAffiliate(raw);
}

/**
 * Writes a record just made, under an id nobody else has (a fresh random id, after its address was claimed with
 * HSETNX). Every change to a record already there goes through changeAffiliate instead.
 */
async function writeNewAffiliate(store: Store, affiliate: Affiliate): Promise<void> {
  await redisPipeline([["HSET", peopleKey(store.statsId as string), affiliate.id, JSON.stringify(affiliate)]]);
  // Found again from their own page across every store (lib/affiliate-hub.ts).
  await rememberAffiliate(store.sid, affiliate.email);
}

/**
 * Writes one affiliate's record only when it is still exactly the text read, in one script: a compare-and-set.
 * Modelled by lib/redis-memory.ts. 1 written, 0 not (changed or gone meanwhile).
 */
export const AFFILIATE_SWAP = `-- marktmorgen:affiliate-swap:v1
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  return 1
end
return 0`;

/** What rememberAffiliate's two commands move at the most, both ways: two keys of a hash, a store's id, an expiry. */
const REMEMBER_BYTES = 600;

/** How many times a change reads again after the record changed under it, before it gives up. */
const SWAP_ATTEMPTS = 5;

/**
 * Changes one affiliate's record with `change`, written over exactly the record read (AFFILIATE_SWAP). When another
 * write landed in between, it reads again and applies `change` to what is there now, so it never puts back a share,
 * a decision or an address that write made (#2995 follow-up: a share lowered meanwhile came back whole).
 *
 * `change` returns the record to write, or null to write nothing. Returns the record as read and as written (`next`
 * null when nothing was written), or null when there is no such record. Throws UnknownReplyError when the read or the
 * swap was answered in an unknown shape, and LockBusyError when the record kept changing: nothing written either way.
 */
async function changeAffiliate(
  store: Store,
  id: string,
  change: (now: Affiliate) => Affiliate | null,
  /**
   * `known`: the record's text as a batch already read it, written over without reading it again. With it, a single
   * attempt: when the record changed meanwhile, one HEXISTS tells "gone" (null) from "changed" (LockBusyError), so a
   * batch never reads a record twice and its cost stays what it took for it (bulkUnits).
   */
  known?: string,
  /** What the write moved, counted for a batch that pays for it (settle). */
  meter?: Meter,
): Promise<{ before: Affiliate; next: Affiliate | null } | null> {
  if (!store.statsId || !isRedisConfigured() || !AFFILIATE_ID_PATTERN.test(id)) return null;
  const key = peopleKey(store.statsId);
  if (known !== undefined) {
    const before = parseAffiliate(known);
    if (!before) return null;
    const next = change(before);
    if (!next) return { before, next: null };
    const swapped = repliesFor(await piped(meter, [["EVAL", AFFILIATE_SWAP, 1, key, id, known, JSON.stringify(next)]]), 1);
    const written = swapped ? countOf(swapped[0]) : null;
    if (written === 1) {
      await rememberAffiliate(store.sid, next.email);
      // The hub's two commands (lib/affiliate-hub.ts), counted at their widest: a key, the store's id and an expiry.
      if (meter) {
        meter.commands += 2;
        meter.bytes += REMEMBER_BYTES;
      }
      return { before, next };
    }
    if (written !== 0) throw new UnknownReplyError("an affiliate's record swap");
    const there = repliesFor(await piped(meter, [["HEXISTS", key, id]]), 1);
    const exists = there ? countOf(there[0]) : null;
    if (exists === 0) return null;
    if (exists !== 1) throw new UnknownReplyError("whether an affiliate's record is there");
    throw new LockBusyError("an affiliate's record changed while a batch wrote it");
  }
  for (let attempt = 0; attempt < SWAP_ATTEMPTS; attempt += 1) {
    const read = repliesFor(await redisPipeline([["HGET", key, id]]), 1);
    if (!read || (read[0] !== null && typeof read[0] !== "string")) throw new UnknownReplyError("an affiliate's record");
    const raw = read[0];
    const before = raw === null ? null : parseAffiliate(raw);
    if (raw === null || !before) return null;
    const next = change(before);
    if (!next) return { before, next: null };
    const swapped = repliesFor(await redisPipeline([["EVAL", AFFILIATE_SWAP, 1, key, id, raw, JSON.stringify(next)]]), 1);
    const written = swapped ? countOf(swapped[0]) : null;
    if (written === 1) {
      // Found again from their own page across every store (lib/affiliate-hub.ts).
      await rememberAffiliate(store.sid, next.email);
      return { before, next };
    }
    if (written !== 0) throw new UnknownReplyError("an affiliate's record swap");
  }
  throw new LockBusyError("an affiliate's record kept changing while it was written");
}

/** The affiliate this store has under an address, or null. */
export async function affiliateByEmail(store: Store, email: string): Promise<Affiliate | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const [id] = await redisPipeline([["HGET", emailsKey(store.statsId), normaliseEmail(email)]]);
  return typeof id === "string" && id ? readAffiliate(store, id) : null;
}

/**
 * A link that signs an affiliate this store already has in to its page, made
 * for an address whose owner has just proved it (lib/affiliate-hub.ts): the
 * same one-off link the store's own form emails, handed over instead of sent.
 * Null for an address the store does not have, so it never makes an
 * application nobody asked for.
 */
export async function signInLinkFor(store: Store, email: string, origin: string): Promise<string | null> {
  if (!affiliatesOn(store)) return null;
  const affiliate = await affiliateByEmail(store, email);
  if (!affiliate) return null;
  const token = randomBytes(32).toString("hex");
  const grant: LinkGrant = { s: store.statsId as string, e: affiliate.email, n: "" };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", AFFILIATE_LINK_SECONDS]]);
  return `${origin}/@${store.handle}/affiliates?token=${token}`;
}

/** A whole number from one up after INCR, or null when the reply is not exactly that. */
function incremented(reply: unknown): number | null {
  const count = countOf(reply);
  return count !== null && count >= 1 ? count : null;
}

/**
 * Whether one more request fits in the hour: true or false on a count read in
 * its exact shape, null when the answer is missing, cut short or of another
 * shape, which is never taken as room (CX-123 rule 24).
 */
async function within(key: string, limit: number): Promise<boolean | null> {
  const both = repliesFor(
    await redisPipeline([
      ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
      ["INCR", key],
    ]),
    2,
  );
  if (!both || (both[0] !== "OK" && both[0] !== null)) return null;
  const count = incremented(both[1]);
  return count === null ? null : count <= limit;
}

/** A name that can sit inside the quotes of an email's From line. */
function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

/** The address part of NIMBUS_FROM, whatever form it was written in. */
function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}


/** The address an affiliate shares: the store's own domain when it has one live. */
export function affiliateLink(store: Store, code: string): string {
  const base = store.domain?.liveAt ? `https://${store.domain.name}` : `${SITE_URL}/@${store.handle}`;
  return `${base}${store.domain?.liveAt ? "/" : ""}?via=${code}`;
}

// ---- Applying and signing in ---------------------------------------------

export type ApplyRequest = "sent" | "email" | "limited" | "unavailable" | "owner" | "error";

/**
 * What an emailed link stands for.
 *
 * `s` the store, `e` the address it was sent to, `n` what they wrote about
 * where they would share it. And for a partner the creator invited rather than
 * somebody who applied: `k` marks it an invitation, so opening it makes a
 * record that is already approved, and `p` is the share that comes with it.
 *
 * A partner is not an applicant. Hotmart has the producer send the invitation,
 * and that is the right way round: somebody who helped make the product should
 * not have to apply to an affiliate programme to be paid for it.
 *
 * `r` is the affiliate whose invitation link they applied through, when the
 * programme has a second tier (lib/affiliate-setting.ts secondTier).
 */
type LinkGrant = { s: string; e: string; n: string; k?: 1; p?: PartnerShare; r?: string };

/**
 * The affiliate whose invitation link this is, when it may bring anybody: the
 * programme has a second tier, they are approved, and they are not inviting
 * themselves under another address.
 */
export async function recruiterFor(store: Store, code: string, email: string): Promise<Affiliate | null> {
  if (!store.statsId || store.affiliates.secondTier <= 0 || !AFFILIATE_CODE_PATTERN.test(code)) return null;
  const [id] = await redisPipeline([["HGET", codesKey(store.statsId), code]]);
  const affiliate = typeof id === "string" ? await readAffiliate(store, id) : null;
  if (!affiliate || affiliate.status !== "approved") return null;
  return canonicalEmail(affiliate.email) === canonicalEmail(email) ? null : affiliate;
}

/** An affiliate's invitation link: the programme's page, carrying their code. */
export function recruitLink(store: Store, code: string): string {
  return `${SITE_URL}/@${store.handle}/affiliates?by=${encodeURIComponent(code)}`;
}

/**
 * Emails a link to the address typed. Opening it is what makes the
 * application — so every applicant has proved the address is theirs — and it
 * is also how a returning affiliate signs in to see their numbers.
 */
export async function requestAffiliateLink(input: {
  store: Store;
  email: string;
  note: string;
  ip: string;
  origin: string;
  /** The code of the affiliate whose invitation link they came through, if any. */
  by?: string;
}): Promise<ApplyRequest> {
  const { store, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const email = normaliseEmail(raw);
  if (!canApply(store)) return "unavailable";
  if (canonicalEmail(email) === canonicalEmail(store.email)) return "owner";
  // A count that could not be read sends nothing and keeps nothing; it is said as an error, never as too many requests.
  const byConnection = await within(applyIpKey(ip, store.handle), APPLY_IP_LIMIT);
  if (byConnection === null) return "error";
  if (!byConnection) return "limited";
  const byAddress = await within(applyAddressKey(email), APPLY_ADDRESS_LIMIT);
  if (byAddress === null) return "error";
  if (!byAddress) return "limited";

  const [known] = await redisPipeline([["HGET", emailsKey(store.statsId as string), email]]);
  const token = randomBytes(32).toString("hex");
  const note = input.note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_LENGTH);
  const recruiter = input.by ? await recruiterFor(store, input.by, email) : null;
  const grant: LinkGrant = { s: store.statsId as string, e: email, n: note, ...(recruiter ? { r: recruiter.id } : {}) };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", AFFILIATE_LINK_SECONDS]]);

  const name = store.name;
  const a = affiliatesWords(store.language);
  const link = `${origin}/@${store.handle}/affiliates?token=${token}`;
  // A new applicant's address is one only they have said is theirs: it takes
  // only the share of access emails kept for those (ASKED_SHARE_BPS).
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional", asked: typeof known !== "string" },
    from: `"${displayName(name)} via Marktmorgen" <${senderAddress()}>`,
    to: email,
    subject: typeof known === "string" ? a.yourPageFor(name) : a.linkSubjectNew(name),
    text: [
      typeof known === "string" ? a.linkIntroKnown(name) : a.linkIntroNew(name),
      "",
      link,
      "",
      typeof known === "string" ? a.linkShowsKnown : a.linkAboutNew(name, store.affiliates.days),
      "",
      a.paidByStore(name),
      "",
      a.linkExpires,
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

export type InviteResult = "sent" | "waiting" | "email" | "owner" | "unavailable" | "full" | "error";

/**
 * Invites somebody to be a partner on certain products, at a share.
 *
 * Nothing is written down until they open the link, so an address typed wrong
 * leaves no half-made partner behind. Opening it makes a record that is
 * already approved, with the share attached — they agreed to it by opening an
 * email that states it, which is the whole point of sending the terms in the
 * message rather than afterwards.
 *
 * Whether the share is allowed — the cap over everything promised on a
 * product — is the caller's to check with lib/partner-share.ts, the same as
 * setting one on somebody already in the programme.
 */
export async function invitePartner(input: {
  store: Store;
  email: string;
  share: PartnerShare;
  titles: Map<string, string>;
  origin: string;
  /** True when this address already has a store here, so the studio asks instead. */
  alreadyHere?: boolean;
}): Promise<InviteResult> {
  const { store, share, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  if (!affiliatesOn(store) || !isSenderConfigured()) return "unavailable";
  const email = normaliseEmail(raw);
  if (email === normaliseEmail(store.email)) return "owner";

  const statsId = store.statsId as string;
  const [known] = await redisPipeline([["HGET", emailsKey(statsId), email]]);
  if (typeof known !== "string") {
    // Read exactly (rule 24): an unknown count throws before anything is written or sent, never "room left".
    if ((await peopleCount(store)) >= MAX_AFFILIATES) return "full";
  }

  const named = share.products.map((id) => input.titles.get(id) ?? "a product").slice(0, 12);
  // The same list in the email, in the store's language; the studio's copy stays English.
  const a = affiliatesWords(store.language);
  const listed = share.products.map((id) => input.titles.get(id) ?? a.someProduct).slice(0, 12);

  // Somebody who already has a store here has a better place to be asked than
  // an inbox: their own studio (lib/partner-invites.ts). The offer waits there
  // with the terms written out. This moves the agreement, it does not skip it —
  // nothing is written into this programme until they accept.
  if (input.alreadyHere) {
    const left = await offerPartnership(email, {
      sid: store.sid,
      storeName: store.name,
      handle: store.handle,
      share,
      titles: named,
    });
    if (!left.ok) return left.reason === "full" ? "full" : "error";
    await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
      to: email,
      subject: a.partnerSubject(store.name),
      text: [
        a.partnerOffer(store.name, share.percent),
        "",
        ...listed.map((title) => `  • ${title}`),
        "",
        a.partnerInStudio,
        "",
        `${SITE_URL}/studio/affiliates`,
        "",
        a.partnerAnswer,
      ].join("\n"),
      replyTo: store.email,
    }).catch((error) => console.error("telling a creator about a partnership offer failed", error));
    return "waiting";
  }

  const token = randomBytes(32).toString("hex");
  const grant: LinkGrant = { s: statsId, e: email, n: "Invited as a partner", k: 1, p: share };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", AFFILIATE_LINK_SECONDS]]);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
    to: email,
    subject: a.partnerSubject(store.name),
    text: [
      a.partnerOffer(store.name, share.percent),
      "",
      ...listed.map((title) => `  • ${title}`),
      "",
      a.partnerTerms(share.percent),
      "",
      a.partnerOpen,
      "",
      `${origin}/@${store.handle}/affiliates?token=${token}`,
      "",
      a.partnerPays(store.name),
      "",
      a.partnerExpires,
    ].join("\n"),
    replyTo: store.email,
  });
  return sent ? "sent" : "error";
}

/**
 * Writes in a partner who has just accepted, from their own studio.
 *
 * The only path that makes a partner without an emailed link, and it is not a
 * shortcut: the person pressed the button, on a page showing the share and the
 * products. That is a better record of agreement than a link opened in a mail
 * app, not a worse one. It goes through the same grant the email would have
 * carried, so the record is made exactly as it is made everywhere else.
 */
export async function acceptPartnership(store: Store, email: string, share: PartnerShare, charge: Charge = PAID): Promise<OpenResult> {
  if (!affiliatesOn(store)) return { ok: false, reason: "unavailable" };
  const token = randomBytes(32).toString("hex");
  const grant: LinkGrant = { s: store.statsId as string, e: normaliseEmail(email), n: "Accepted a partnership", k: 1, p: share };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", 600]]);
  return openAffiliateLink(store, token, charge);
}

function parseGrant(raw: unknown): LinkGrant | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<LinkGrant>;
    if (typeof value.s !== "string" || typeof value.e !== "string") return null;
    const share = parsePartnerShare(value.p);
    return {
      s: value.s,
      e: value.e,
      n: typeof value.n === "string" ? value.n : "",
      ...(value.k === 1 ? { k: 1 as const } : {}),
      ...(share ? { p: share } : {}),
      ...(typeof value.r === "string" && AFFILIATE_ID_PATTERN.test(value.r) ? { r: value.r } : {}),
    };
  } catch {
    return null;
  }
}

/** The address an emailed link is for, while it still works. For the page. */
export async function linkEmail(store: Store, token: string): Promise<string | null> {
  if (!AFFILIATE_TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  const grant = parseGrant(raw);
  return grant && grant.s === store.statsId ? grant.e : null;
}

/** A readable code for a new affiliate, from their address, not yet taken here. */
async function claimCode(store: Store, email: string, id: string): Promise<string> {
  const stem = (email.split("@")[0] ?? "").replace(/[^a-z0-9]/g, "").slice(0, 14);
  const first = stem.length >= 3 ? stem : `${stem}aff`.slice(0, 14);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = attempt === 0 ? first : `${first}${Math.floor(10 + Math.random() * (attempt < 4 ? 90 : 9990))}`;
    if (!AFFILIATE_CODE_PATTERN.test(code)) continue;
    const [won] = await redisPipeline([["HSETNX", codesKey(store.statsId as string), code, id]]);
    if (Number(won) === 1) return code;
  }
  const code = randomBytes(5).toString("hex");
  await redisPipeline([["HSETNX", codesKey(store.statsId as string), code, id]]);
  return code;
}

export type OpenResult =
  | { ok: true; session: string; affiliate: Affiliate; created: boolean }
  /** "committed" and "crowded": an accepted share no longer fits the cap (lib/partner-share.ts); the link or offer is kept. */
  /** "resting": the requests that pay for reading the program's people were not taken; nothing read or written, the link or offer kept. */
  | { ok: false; reason: "expired" | "full" | "unavailable" | "committed" | "crowded" | "resting" };

type Recorded = { ok: true; affiliate: Affiliate; created: boolean } | { ok: false; reason: "expired" | "full" | "committed" | "crowded" };

/**
 * The record an opened link (or an accepted studio offer) makes or approves. With `fence`, the grant carries a share:
 * it runs under the program's partner lock, re-checks the cap against the partners read exactly now (this person's
 * own current share replaced, not added) and confirms the lock is still held before the first write. Over the cap,
 * nothing is written. UnknownReplyError and LockBusyError are thrown before any write.
 */
async function recordFromLink(store: Store, grant: LinkGrant, fence: { share: PartnerShare; held: Held; charge: Charge } | null): Promise<Recorded> {
  const statsId = store.statsId as string;
  let affiliate: Affiliate | null = null;
  let created = false;
  const [knownId] = await redisPipeline([["HGET", emailsKey(statsId), grant.e]]);
  if (typeof knownId === "string") affiliate = await readAffiliate(store, knownId);
  if (fence) {
    // The people read paid for first, by whoever pays for this path (openAffiliateLink's `charge`), rule 30.
    const problem = await partnerShareProblem(store, fence.share, affiliate?.id ?? null, fence.charge);
    if (problem) return { ok: false, reason: problem === "crowded" ? "crowded" : "committed" };
    if (!(await holdLock(fence.held))) throw new LockBusyError("the partner lock was lost before the share was written");
  }
  // An invitation the creator sent (grant.k) arrives already decided: opening
  // it approves them and attaches the share the email stated. Somebody the
  // creator had declined or removed is let back in by it, because inviting
  // them is the creator changing their mind, in their own words.
  if (affiliate && grant.k === 1) {
    // Only the decision and the share are changed, over exactly the record read: an address set meanwhile is kept.
    const changed = await changeAffiliate(store, affiliate.id, (now) => ({ ...now, status: "approved", decidedAt: Date.now(), share: grant.p ?? now.share }));
    if (!changed?.next) return { ok: false, reason: "expired" };
    affiliate = changed.next;
  }
  if (!affiliate) {
    // Read exactly (rule 24): an unknown count throws before anything is written, never "room left".
    if ((await peopleCount(store)) >= MAX_AFFILIATES) return { ok: false, reason: "full" };
    const id = randomBytes(6).toString("hex");
    // One application per address, however many links are opened at once.
    const [won] = await redisPipeline([["HSETNX", emailsKey(statsId), grant.e, id]]);
    if (Number(won) !== 1) {
      const [other] = await redisPipeline([["HGET", emailsKey(statsId), grant.e]]);
      affiliate = typeof other === "string" ? await readAffiliate(store, other) : null;
      if (!affiliate) return { ok: false, reason: "expired" };
    } else {
      const code = await claimCode(store, grant.e, id);
      const now = Date.now();
      const invited = grant.k === 1;
      // Checked again now, because the programme or the recruiter may have changed since the email went out.
      const recruiter = grant.r && !invited ? await readAffiliate(store, grant.r) : null;
      const by =
        recruiter && store.affiliates.secondTier > 0 && recruiter.status === "approved" && canonicalEmail(recruiter.email) !== canonicalEmail(grant.e)
          ? { id: recruiter.id, percent: store.affiliates.secondTier }
          : null;
      affiliate = {
        id,
        email: grant.e,
        code,
        status: invited ? "approved" : "pending",
        appliedAt: now,
        decidedAt: invited ? now : 0,
        note: grant.n,
        rate: null,
        paypal: "",
        share: invited ? grant.p ?? null : null,
        cleared: null,
        by,
      };
      await writeNewAffiliate(store, affiliate);
      created = true;
    }
  }

  return { ok: true, affiliate, created };
}

/**
 * The button on the page an emailed link opens. The first time for an
 * address, it makes the application; every time, it signs this browser in.
 */
export async function openAffiliateLink(store: Store, token: string, charge: Charge = PAID): Promise<OpenResult> {
  if (!affiliatesOn(store)) return { ok: false, reason: "unavailable" };
  if (!AFFILIATE_TOKEN_PATTERN.test(token)) return { ok: false, reason: "expired" };
  const statsId = store.statsId as string;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  const grant = parseGrant(raw);
  if (!grant || grant.s !== statsId) return { ok: false, reason: "expired" };

  // A share carried by an invitation is checked again now, against the partners there are now, under the program's
  // partner lock (#2995 review): each invitation was inside the cap alone when sent, and two accepted could promise
  // 160% of a sale. Over the cap: refused, nothing written, the link (or the studio offer) kept. The people read
  // unknown (UnknownReplyError) or the lock not held (LockBusyError): thrown before any write, the link kept.
  // Reading the people for it is paid first, at its worst, and given back down to what was read (paidPeople): from the
  // store's public requests for an emailed link, from the answering creator's studio requests in their studio (the
  // caller's `charge`). Not taken: "resting", nothing read or written, the link or offer kept. Not known whether taken
  // (the charge threw): UnknownReplyError, never "resting", nothing read or written, the link or offer kept.
  const share = grant.k === 1 ? grant.p : undefined;
  let made: Recorded;
  try {
    made = share
      ? await withPartnerLock(store, (held) => recordFromLink(store, grant, { share, held, charge }))
      : await recordFromLink(store, grant, null);
  } catch (error) {
    if (error instanceof StudioNotPaidError) return { ok: false, reason: "resting" };
    throw error;
  }
  if (!made.ok) return made;
  let { affiliate } = made;
  const { created } = made;

  // Somebody who joined before their page across every store existed is found from their next sign-in.
  await rememberAffiliate(store.sid, affiliate.email);
  const session = randomBytes(32).toString("hex");
  await redisPipeline([
    ["SET", sessionKey(session), JSON.stringify({ s: statsId, a: affiliate.id }), "EX", AFFILIATE_SESSION_SECONDS],
    // Spent: an emailed link signs in once.
    ["DEL", linkKey(token)],
  ]);

  // Approved at once when the creator chose it (624 [SZ8](35)): through the same decision as by hand, so the
  // approval email with their link goes as usual. Only a new application; someone declined or removed stays out,
  // and so does the same inbox written another way (a dot or a "+" tag): an application whose address matches any
  // other record, declined and removed included, waits for the creator instead.
  // The store's own address (the owner's, as it is now) waits too: the owner is never their own affiliate.
  // The choice is read again from the store as it is now, and the application again, so a creator who turned
  // approval off, or declined or removed this person, in the meantime is not overruled.
  const autoChosen = created && grant.k !== 1 && store.affiliates.autoApprove === true && affiliate.status === "pending";
  // A list of the program that could not be read is not "no other inbox": the application waits, said as such.
  const sameInbox = autoChosen
    ? await sameInboxAsAnother(store, affiliate.email, affiliate.id).catch((error: unknown) => {
        if (error instanceof UnknownReplyError) return null;
        throw error;
      })
    : false;
  const knownInbox = sameInbox === true;
  const unreadList = sameInbox === null;
  const ownersInbox = autoChosen && canonicalEmail(affiliate.email) === canonicalEmail(store.email);
  let autoApproved = false;
  if (autoChosen && !knownInbox && !unreadList && !ownersInbox) {
    const now = store.sid ? await storeForId(store.sid) : null;
    const still = now?.affiliates.autoApprove === true ? await readAffiliate(store, affiliate.id) : null;
    if (still?.status === "pending") {
      affiliate = (await decide(store, affiliate.id, "approve")) ?? affiliate;
      autoApproved = affiliate.status === "approved";
    }
  }

  if (created && isSenderConfigured() && grant.k !== 1) {
    const studioLink = `${SITE_URL}/studio/affiliates${store.sid ? `?store=${store.sid}` : ""}`;
    await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
      from: `Marktmorgen <${senderAddress()}>`,
      to: store.email,
      subject: autoApproved ? `New affiliate: ${affiliate.email}` : `New affiliate application: ${affiliate.email}`,
      text: [
        autoApproved
          ? `${affiliate.email} joined as an affiliate of ${store.name}, approved at once because you chose to approve every application.`
          : `${affiliate.email} applied to be an affiliate of ${store.name}.`,
        ...(knownInbox
          ? ["It was not approved at once: the address matches one already on your list (including people you declined or removed), written the same way or another way, so it waits for your decision."]
          : []),
        ...(ownersInbox ? ["It was not approved at once: it is this store's own address, so it waits for your decision."] : []),
        ...(unreadList
          ? ["It was not approved at once: your list of affiliates could not be checked for the same address just now, so it waits for your decision."]
          : []),
        ...(affiliate.note ? [`Where they will share it: ${affiliate.note}`] : []),
        "",
        autoApproved ? `Remove them in your studio if you would rather not: ${studioLink}` : `Approve or decline them in your studio: ${studioLink}`,
        "",
        autoApproved
          ? "Commissions are paid by you, directly, never by Marktmorgen."
          : "Nothing changes until you decide. Commissions are paid by you, directly, never by Marktmorgen.",
      ].join("\n"),
    }).catch((error) => console.error("telling a creator about an application failed", error));
  }
  // And their phone, when a device of theirs asked for applications
  // (lib/phone-alerts.ts): no address on a lock screen, only that one came.
  if (created) {
    await alertCreator(
      store,
      "affiliate",
      grant.k === 1
        ? { title: "Your partner accepted", body: `Somebody you invited as a partner on ${store.name} opened their link.`, url: store.sid ? `/studio/affiliates?store=${store.sid}` : "/studio/affiliates" }
        : autoApproved
          ? { title: "New affiliate", body: `Someone joined as an affiliate of ${store.name}, approved at once as you chose.`, url: store.sid ? `/studio/affiliates?store=${store.sid}` : "/studio/affiliates" }
          : { title: "New affiliate application", body: `Someone applied to promote ${store.name}. Approve or decline them in your studio.`, url: store.sid ? `/studio/affiliates?store=${store.sid}` : "/studio/affiliates" },
      { seed: affiliate.id },
    ).catch((error) => console.error("an application notification failed", error));
  }
  return { ok: true, session, affiliate, created };
}

/**
 * Whether another record of this store than `self`, in any state (declined
 * and removed included), reaches the same inbox as `address`, by its address
 * or its payout address, written the same or another way (canonicalEmail).
 * Throws UnknownReplyError when the program's people could not be read.
 */
async function sameInboxAsAnother(store: Store, address: string, self: string | null): Promise<boolean> {
  const mine = canonicalEmail(address);
  return (await listAffiliates(store)).some(
    (other) => other.id !== self && (canonicalEmail(other.email) === mine || canonicalEmail(payAddress(other)) === mine),
  );
}

/** Whether buyers may join this store's programme on their own (lib/affiliate-setting.ts). */
export function buyersJoin(store: Store): boolean {
  return affiliatesOn(store) && store.affiliates.buyers;
}

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/**
 * The address that paid for a checkout of this store, read from the creator's
 * own Stripe account, or null. The checkout's id is what the thanks page and
 * the purchase email already carry as the buyer's proof of the order, so it
 * proves the same thing here: this is the person who paid.
 */
export async function buyerOfOrder(store: Store, sessionId: string): Promise<string | null> {
  if (!SESSION_ID.test(sessionId) || !store.stripeAccountId) return null;
  let session: Record<string, unknown>;
  try {
    session = await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  } catch {
    return null;
  }
  const meta = (session.metadata ?? {}) as Record<string, string>;
  if (!saleHandles(store).has(meta.store ?? "")) return null;
  if (!isSettled(session)) return null;
  const details = session.customer_details as { email?: unknown } | null | undefined;
  const email = typeof details?.email === "string" ? details.email : typeof session.customer_email === "string" ? session.customer_email : "";
  return email && EMAIL_PATTERN.test(email) ? normaliseEmail(email) : null;
}

export type JoinResult =
  | { ok: true; session: string; affiliate: Affiliate; created: boolean }
  | { ok: false; reason: "unavailable" | "order" | "owner" | "declined" | "full" };

/**
 * A buyer taking their own link, where the creator lets buyers join: made
 * and approved at once, or — for a buyer who had applied and was waiting —
 * approved now. Somebody the creator declined or removed is not let back in
 * this way: that decision was theirs.
 */
export async function joinAsBuyer(store: Store, sessionId: string): Promise<JoinResult> {
  if (!buyersJoin(store)) return { ok: false, reason: "unavailable" };
  const email = await buyerOfOrder(store, sessionId);
  if (!email) return { ok: false, reason: "order" };
  if (canonicalEmail(email) === canonicalEmail(store.email)) return { ok: false, reason: "owner" };
  const statsId = store.statsId as string;

  let affiliate: Affiliate | null = null;
  let created = false;
  const [knownId] = await redisPipeline([["HGET", emailsKey(statsId), email]]);
  if (typeof knownId === "string") affiliate = await readAffiliate(store, knownId);
  // The same inbox as another record, declined and removed included, written another way (a "+" tag, dots at
  // Gmail): not let in by an order; an application waits for the creator instead (624 [SZ8](35)).
  const knownInbox = await sameInboxAsAnother(store, email, affiliate?.id ?? null);
  if (affiliate) {
    if (affiliate.status === "declined" || affiliate.status === "removed") return { ok: false, reason: "declined" };
    // Somebody waiting who holds a share stays waiting: approving them makes the share count, and that is the
    // creator's decision, checked against the cap (decide), never an order's (#2995, rule 30).
    if (affiliate.status === "pending" && !knownInbox && affiliate.share === null) {
      // Over exactly the record read, and only while it still waits with no share.
      const changed = await changeAffiliate(store, affiliate.id, (now) =>
        now.status === "pending" && now.share === null ? { ...now, status: "approved", decidedAt: Date.now() } : null,
      );
      affiliate = changed?.next ?? changed?.before ?? affiliate;
    }
  } else {
    // Read exactly (rule 24): an unknown count throws before anything is written, never "room left".
    if ((await peopleCount(store)) >= MAX_AFFILIATES) return { ok: false, reason: "full" };
    const id = randomBytes(6).toString("hex");
    const [won] = await redisPipeline([["HSETNX", emailsKey(statsId), email, id]]);
    if (Number(won) !== 1) {
      // The same buyer pressing twice at once: the other press made them.
      const [other] = await redisPipeline([["HGET", emailsKey(statsId), email]]);
      affiliate = typeof other === "string" ? await readAffiliate(store, other) : null;
      if (!affiliate) return { ok: false, reason: "order" };
    } else {
      const code = await claimCode(store, email, id);
      const now = Date.now();
      affiliate = knownInbox
        ? { id, email, code, status: "pending", appliedAt: now, decidedAt: 0, note: "Joined after buying", rate: null, paypal: "", share: null, cleared: null, by: null }
        : { id, email, code, status: "approved", appliedAt: now, decidedAt: now, note: "Joined after buying", rate: null, paypal: "", share: null, cleared: null, by: null };
      await writeNewAffiliate(store, affiliate);
      created = true;
    }
  }

  const session = randomBytes(32).toString("hex");
  await redisPipeline([["SET", sessionKey(session), JSON.stringify({ s: statsId, a: affiliate.id }), "EX", AFFILIATE_SESSION_SECONDS]]);
  if (created) {
    await alertCreator(
      store,
      "affiliate",
      affiliate.status === "pending"
        ? { title: "New affiliate application", body: `Someone who bought from ${store.name} asked for a link. Their address matches one already on your list, so it waits for you.`, url: store.sid ? `/studio/affiliates?store=${store.sid}` : "/studio/affiliates" }
        : { title: "A buyer became an affiliate", body: `Someone who bought from ${store.name} took their own link to share it.`, url: store.sid ? `/studio/affiliates?store=${store.sid}` : "/studio/affiliates" },
      { seed: affiliate.id },
    ).catch((error) => console.error("a new-affiliate notification failed", error));
  }
  return { ok: true, session, affiliate, created };
}

/** The affiliate a browser is signed in as, on this store, or null. */
export async function affiliateForSession(store: Store, session: string | undefined): Promise<Affiliate | null> {
  if (!session || !AFFILIATE_TOKEN_PATTERN.test(session) || !store.statsId || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", sessionKey(session)]]);
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as { s?: unknown; a?: unknown };
    if (value.s !== store.statsId || typeof value.a !== "string") return null;
    return await readAffiliate(store, value.a);
  } catch {
    return null;
  }
}

export async function endAffiliateSession(session: string | undefined): Promise<void> {
  if (!session || !AFFILIATE_TOKEN_PATTERN.test(session) || !isRedisConfigured()) return;
  // 0 or 1 is done; any other answer leaves the session possibly open, so the sign-out never says it ended (rule 24).
  const deleted = countOf(repliesFor(await redisPipeline([["DEL", sessionKey(session)]]), 1)?.[0]);
  if (deleted === null || deleted > 1) throw new UnknownReplyError("the affiliate session's delete");
}

// ---- The creator's decisions ---------------------------------------------

export type Decision = "approve" | "decline" | "remove" | "restore";

/** A share that would pass the cap if its holder became approved now (lib/partner-share.ts). Nothing was written. */
export class ShareCapError extends Error {
  constructor(readonly problem: ShareProblem) {
    super(`a partner share would pass the cap: ${problem}`);
    this.name = "ShareCapError";
  }
}

/**
 * Lets someone in, turns them down, or takes them out. Their history stays.
 *
 * Somebody holding a share who becomes approved (a removed partner restored, a pending person approved) makes that
 * share count again, so the cap is checked again first, under the program's partner lock, against the partners read
 * exactly now (#2995, rule 30). Over it: ShareCapError, nothing written. Unknown reply: UnknownReplyError; the lock
 * not held: LockBusyError; nothing written either way.
 */
export async function decide(store: Store, id: string, decision: Decision, charge: Charge = PAID): Promise<Affiliate | null> {
  const found = await readAffiliate(store, id);
  if (!found) return null;
  const status: AffiliateStatus =
    decision === "approve" || decision === "restore" ? "approved" : decision === "decline" ? "declined" : "removed";
  const counts = (a: Affiliate) => status === "approved" && a.status !== "approved" && a.share !== null;
  // Only the decision is changed, over exactly the record read (changeAffiliate): a share, a rate or an address
  // written meanwhile is kept. `checked` is the share the cap was checked with: when the record now holds another
  // (it can only change under the partner lock this decision holds), nothing is written. With no lock (`checked`
  // undefined), a record that now holds a share this decision would make count is never written: the decision goes
  // again under the lock (NeedsPartnerLock), so a share given meanwhile is checked against the cap (pre-review M1).
  const write = async (checked: PartnerShare | null | undefined) => {
    const changed = await changeAffiliate(store, id, (now) => {
      if (checked === undefined && counts(now)) throw new NeedsPartnerLock();
      if (checked !== undefined && JSON.stringify(now.share) !== JSON.stringify(checked)) {
        throw new LockBusyError("a partner's share changed while the decision was written");
      }
      return { ...now, status, decidedAt: Date.now() };
    });
    return changed?.next ? { affiliate: changed.before, next: changed.next } : null;
  };
  const locked = () =>
    withPartnerLock(store, async (held) => {
      // Read again under the lock: the share or the status may have changed since.
      const now = await readAffiliate(store, id);
      if (!now) return null;
      if (counts(now) && now.share) {
        const problem = await partnerShareProblem(store, now.share, now.id, charge);
        if (problem) throw new ShareCapError(problem);
        if (!(await holdLock(held))) throw new LockBusyError("the partner lock was lost before the decision was written");
      }
      return write(now.share);
    });
  const written = counts(found)
    ? await locked()
    : await write(undefined).catch((error: unknown) => {
        if (error instanceof NeedsPartnerLock) return locked();
        throw error;
      });
  if (!written) return null;
  const { affiliate, next } = written;
  if (decision === "approve" && affiliate.status === "pending") await tellApproved(store, affiliate);
  return next;
}

/** Thrown inside a change written with no partner lock that turns out to need it: the caller goes again under it. */
class NeedsPartnerLock extends Error {
  constructor() {
    super("the change needs the partner lock");
    this.name = "NeedsPartnerLock";
  }
}

/** Emails somebody just approved their link and the program's terms, when the store can send. Never throws. */
async function tellApproved(store: Store, affiliate: Affiliate): Promise<void> {
  if (isSenderConfigured()) {
    const a = affiliatesWords(store.language);
    await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
      to: affiliate.email,
      subject: a.approvedSubject(store.name),
      text: [
        a.approvedIntro(store.name),
        "",
        affiliateLink(store, affiliate.code),
        "",
        a.approvedTerms(
          store.affiliates.days,
          affiliate.rate ?? store.affiliates.percent,
          affiliate.rate === null && Object.keys(store.affiliates.rates).length > 0,
        ),
        "",
        a.termDisclose,
        // Pay per lead, when the program pays it (lib/affiliate-leads.ts): its terms and its own disclosure.
        ...(store.affiliates.lead.kind !== "none"
          ? (() => {
              const lw = leadWords(store.language);
              const amount = (cents: number) => formatMoney(cents, store.currency, LANGUAGES[parseLanguage(store.language)].locale);
              return ["", lw.term(store.affiliates.lead.kind, amount(store.affiliates.lead.cents), store.name), lw.termRules(store.affiliates.lead.hold, store.affiliates.lead.daily, amount(store.affiliates.lead.budget), store.name), "", lw.disclose];
            })()
          : []),
        "",
        a.approvedPage(`${SITE_URL}/@${store.handle}/affiliates`),
        "",
        a.paidByStore(store.name),
      ].join("\n"),
    }).catch((error) => console.error("telling an affiliate they were approved failed", error));
  }
}

// ---- Several decisions at once, with undo (630 [HN6](4), unit 1) ----------

/** The most applications one press decides, and how long its undo lasts. */
export const MAX_BULK_DECISIONS = 100;
export const BULK_UNDO_MS = 10 * 60_000;

/** How one affiliate stood before a decision in bulk: what an undo puts back. */
export type Before = { id: string; status: AffiliateStatus; decidedAt: number };

// ---- What a change in bulk reads, and the studio requests it takes first (pre-review M2) ----

/**
 * What one more studio request covers of a change in bulk (tests/plan-cost-registry.test.ts holds both under
 * UNIT_COST.studio, at a light request's shape): STUDIO_UNIT_COMMANDS commands, or STUDIO_UNIT_BYTES bytes through the
 * database, as lib/segments.ts counts a megabyte read. A change in bulk takes, before each part of it, the studio
 * requests that part costs at its worst size (bulkUnits), on top of the one its press took;
 * tests/affiliate-bulk-cost.test.ts measures every command and byte of a batch inside what it took.
 */
export const STUDIO_UNIT_COMMANDS = 20;
export const STUDIO_UNIT_BYTES = 1_000_000;

/**
 * The most bytes one affiliate's record can take as JSON, by the caps it is written and read with (parseAffiliate):
 * two addresses of MAX_EMAIL_LENGTH and a note of MAX_NOTE_LENGTH characters, each character at its widest (a control
 * character, six bytes escaped), a share of 200 product ids of 40 characters, 50 ids let through and the rest.
 * tests/affiliate-bulk-cost.test.ts holds the widest record under it.
 */
export const AFFILIATE_RECORD_MAX_BYTES = 16_000;

/**
 * Commands the partner lock takes at the most: a try every 20 ms, doubling up to 250 ms, for PARTNER_LOCK_WAIT_MS;
 * keeping it before the first write and every BATCH_HOLD_EVERY writes after; letting it go.
 */
const LOCK_COMMANDS = 16 + Math.ceil(MAX_BULK_DECISIONS / 25) + 2;
/** How many writes of a batch go between two checks that the partner lock is still held. */
const BATCH_HOLD_EVERY = 25;
/** Commands one write of a batch takes at the most: the swap, the HEXISTS that says gone or changed, the hub's two. */
const WRITE_COMMANDS = 4;

/**
 * Studio requests that cover `commands` commands and `bytes` bytes through the database: each request covers a share
 * of either, and the shares add up, so together they cover both (and a light request's own time, each).
 */
export function bulkUnits(commands: number, bytes: number): number {
  return Math.ceil(commands / STUDIO_UNIT_COMMANDS + bytes / STUDIO_UNIT_BYTES);
}

/**
 * Bytes a record read moves, at most: its text inside a JSON reply, each character escaped at most to two bytes
 * (Upstash answers JSON), and the reply's framing.
 */
const readBytes = (records: number) => records * (2 * AFFILIATE_RECORD_MAX_BYTES + 64);
/** Bytes one write moves, at most: the script, the record as read and as written, escaped, and the hub's commands. */
const writeBytes = (raw: number, next: number) => 2 * (raw + next) + 1_200;
const utf8 = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * What a part of a change has read and written so far, measured as it went: its commands, and the bytes of their
 * JSON sent and of the replies' JSON answered (lib/redis.ts sends and reads JSON), never less than moved.
 */
export type Meter = { commands: number; bytes: number; /** A reply was not understood: what moved is not known, nothing is given back. */ unsure?: boolean };
const meterOf = (): Meter => ({ commands: 0, bytes: 0 });
/** Counts one pipeline on `meter` as Upstash moves it. */
function counted(meter: Meter | undefined, commands: readonly (readonly (string | number)[])[], replies: unknown): void {
  if (!meter) return;
  meter.commands += commands.length;
  meter.bytes += utf8(JSON.stringify(commands)) + utf8(JSON.stringify(replies ?? null)) + 16 * commands.length;
}

/** Studio requests taken before a reading; `give(n)` gives back `n` of them, in the window they were taken in. */
export type Hold = {
  /** Gives back `units` taken and not needed, never more than were taken. */
  give: (units: number) => Promise<void>;
  /**
   * Counts `units` more, already used by a read that moved more than was taken for it, past the figure if it must
   * (lib/store-allowance.ts forceAllowance): a read is never refused after it was made.
   */
  force: (units: number) => Promise<void>;
};
/**
 * Takes this many of the store's studio requests before the work they pay for: null when they were not taken. A
 * charge that cannot tell whether they were taken throws: that is unknown, never "used up" (rule 24).
 */
export type Charge = (units: number) => Promise<Hold | null>;
/** For a caller that already paid for the work, or a test of the work alone. */
const PAID: Charge = async () => ({ give: async () => {}, force: async () => {} });
/** Commands one take of studio requests uses itself, and its give-back (lib/studio-route.ts holdStudio). */
const TAKE_COMMANDS = 6;
type Taken = { units: number; hold: Hold };
/**
 * Takes, before the work, the studio requests `commands` commands and `bytes` bytes cost at most, with the take's own:
 * null when they were not taken. A charge that threw is not known to have taken them or not (rule 24): logged and
 * thrown as UnknownReplyError, never read as "used up"; nothing is read or written for it and nothing given back.
 */
async function take(charge: Charge, commands: number, bytes: number): Promise<Taken | null> {
  if (commands <= 0 && bytes <= 0) return { units: 0, hold: { give: async () => {}, force: async () => {} } };
  const units = bulkUnits(commands + TAKE_COMMANDS, bytes);
  let hold: Hold | null;
  try {
    hold = await charge(units);
  } catch (error) {
    console.error("taking studio requests for an affiliate reading answered unknown", error);
    throw error instanceof UnknownReplyError ? error : new UnknownReplyError("a take of studio requests");
  }
  return hold ? { units, hold } : null;
}
/** As take, for a batch that names who it left out: "used" when not taken, "unavailable" when not known. */
async function takeOrWhy(charge: Charge, commands: number, bytes: number): Promise<Taken | "used" | "unavailable"> {
  try {
    return (await take(charge, commands, bytes)) ?? "used";
  } catch (error) {
    if (error instanceof UnknownReplyError) return "unavailable";
    throw error;
  }
}
/**
 * Once the part is done and measured, gives back what was taken beyond the measure, rounded up: the store pays what
 * was really read and written, never less (coordinator, 2026-11-07). A part that moved more than it took (records
 * added between the count and the read) is counted at what it really read, past the figure if it must (Hold.force,
 * lib/store-allowance.ts forceAllowance): never refused after the read, since it was read.
 */
async function settle(taken: Taken, meter: Meter): Promise<void> {
  if (meter.unsure) return;
  const needed = bulkUnits(meter.commands + TAKE_COMMANDS, meter.bytes);
  if (needed < taken.units) await taken.hold.give(taken.units - needed).catch(() => {});
  else if (needed > taken.units) await taken.hold.force(needed - taken.units).catch(() => {});
}

/** The studio requests a reading needs were not taken (used up, or not counted just now): nothing was read or written. */
export class StudioNotPaidError extends Error {
  constructor() {
    super("the studio requests this reading needs were not taken");
    this.name = "StudioNotPaidError";
  }
}

/**
 * The program's people, read for the 90% cap: counted first (HLEN), the read taken at its worst (that many records of
 * AFFILIATE_RECORD_MAX_BYTES), then settled at what it moved. StudioNotPaidError when not taken, nothing read;
 * UnknownReplyError as listAffiliates. A caller that pays nothing (PAID) reads as listAffiliates does.
 */
async function paidPeople(store: Store, charge: Charge): Promise<Affiliate[]> {
  if (charge === PAID || !store.statsId || !isRedisConfigured()) return listAffiliates(store);
  const meter = meterOf();
  const count = await peopleCount(store, meter);
  const taken = await take(charge, 2, readBytes(count));
  if (!taken) throw new StudioNotPaidError();
  const people = await peopleExact(store, meter);
  await settle(taken, meter);
  return [...people.values()].map((one) => one.affiliate).sort((a, b) => b.appliedAt - a.appliedAt);
}

type BatchWrite = { id: string; raw: string; change: (now: Affiliate) => Affiliate | null };
type BatchResult = { before: Affiliate; next: Affiliate } | HeldWhy | null;

/**
 * Writes each change over exactly the record as the batch read it (changeAffiliate with `known`): no record is read
 * again. Per id: the record before and after, null when `change` wrote nothing, or why not ("gone": no longer there;
 * "unavailable": changed meanwhile, an unknown reply, or the partner lock lost). With `held`, the lock is confirmed
 * before the first write and every BATCH_HOLD_EVERY after; once lost, nothing more is written. What it moved is
 * counted on `meter`.
 */
async function writeBatch(store: Store, writes: readonly BatchWrite[], meter: Meter, held?: Held): Promise<Map<string, BatchResult>> {
  const out = new Map<string, BatchResult>();
  let lost = false;
  for (const [i, one] of writes.entries()) {
    if (held && !lost && i % BATCH_HOLD_EVERY === 0) {
      // One script that keeps the lock: its key, token and term, both ways.
      meter.commands += 1;
      meter.bytes += 400;
      if (!(await holdLock(held))) lost = true;
    }
    if (lost) {
      out.set(one.id, "unavailable");
      continue;
    }
    try {
      const changed = await changeAffiliate(store, one.id, one.change, one.raw, meter);
      out.set(one.id, changed === null ? "gone" : changed.next ? { before: changed.before, next: changed.next } : null);
    } catch (error) {
      if (error instanceof UnknownReplyError) meter.unsure = true;
      if (error instanceof UnknownReplyError || error instanceof LockBusyError) out.set(one.id, "unavailable");
      else throw error;
    }
  }
  return out;
}

/** The people a batch asks about, at most MAX_BULK_DECISIONS, once each, in order. */
const batchIds = (ids: readonly string[]) => [...new Set(ids)].slice(0, MAX_BULK_DECISIONS);

/**
 * The records a batch asks about (one HMGET), taken first at their worst and settled at what was read: null when the
 * studio requests were not taken ("used"), or the take or the reply was not exact ("unavailable", nothing given back).
 */
async function batchRecords(store: Store, ids: readonly string[], charge: Charge): Promise<Map<string, Read | null> | "used" | "unavailable"> {
  const taken = await takeOrWhy(charge, 1, readBytes(ids.length));
  if (typeof taken === "string") return taken;
  const meter = meterOf();
  const records = await recordsExact(store, ids, meter).catch((error: unknown) => {
    if (error instanceof UnknownReplyError) return null;
    throw error;
  });
  if (!records) return "unavailable";
  await settle(taken, meter);
  return records;
}

/**
 * Runs `work` under the partner lock with the store read again exactly now, the lock's commands and the store's read
 * taken first at their worst (LOCK_COMMANDS, MAX_STORE_BYTES) and settled once the store is read. False when the
 * studio requests were not taken: nothing done.
 */
async function withPaidStore(store: Store, charge: Charge, work: (now: Store, lock: Held) => Promise<void>): Promise<boolean> {
  const taken = await take(charge, LOCK_COMMANDS + 1, 2 * MAX_STORE_BYTES);
  if (!taken) return false;
  // The lock's own commands are counted at their most (its tries are not counted one by one).
  const meter: Meter = { commands: LOCK_COMMANDS, bytes: LOCK_COMMANDS * 300 };
  let entered = false;
  try {
    await withPartnerLock(store, async (lock) => {
      entered = true;
      const now = await storeNow(store, meter);
      await settle(taken, meter);
      await work(now, lock);
    });
  } finally {
    // The lock never taken: the store was not read, so what was set aside for it is given back. Taken but the store
    // not read exactly: what moved is not known, so nothing is given back.
    if (!entered) await settle(taken, meter);
  }
  return true;
}

/**
 * The program's people, read under the partner lock for the cap: counted (HLEN), taken at their worst, read (HGETALL)
 * and settled at what was read. "used" when not taken: nothing read.
 */
async function batchPeople(now: Store, charge: Charge): Promise<Map<string, Read> | "used"> {
  const meter = meterOf();
  const count = await peopleCount(now, meter);
  const taken = await take(charge, 2, readBytes(count));
  if (!taken) return "used";
  const people = await peopleExact(now, meter);
  await settle(taken, meter);
  return people;
}

/**
 * Approves or declines several pending applications at once. Only pending ones are touched; anybody already decided
 * is left as they are. Each approval emails its link, as one at a time does. Returns how each stood before, for an
 * undo, and who was left out and why (lib/affiliate-bulk-words.ts), never a silent gap in the count.
 *
 * One read of the people asked for (HMGET). Approving somebody who holds a share makes it count, so those are
 * checked, together, under ONE partner lock, against ONE read of the store and of the program's people: each one in
 * turn against the partners as they would stand with the ones before it approved (pre-review M2). Each part is taken
 * in studio requests first at its worst (`charge`, bulkUnits) and, once done, settled at what it really moved; one
 * that was not taken is left out as "used", one not known to be taken as "unavailable", nothing read or written for it.
 */
export async function decideMany(
  store: Store,
  ids: string[],
  decision: "approve" | "decline",
  charge: Charge = PAID,
): Promise<{ before: Before[]; held: HeldOne[] }> {
  const status: AffiliateStatus = decision === "approve" ? "approved" : "declined";
  const asked = batchIds(ids);
  const held: HeldOne[] = [];
  const outcome = new Map<string, BatchResult>();
  const email = new Map<string, string>();
  const leave = (list: readonly string[], why: HeldWhy) => list.forEach((id) => outcome.set(id, why));
  const finish = () => {
    const before: Before[] = [];
    for (const id of asked) {
      const result = outcome.get(id);
      if (result === undefined || result === null) continue;
      if (typeof result === "string") held.push({ id, email: email.get(id) ?? "", why: result });
      else before.push({ id, status: result.before.status, decidedAt: result.before.decidedAt });
    }
    return { before, held };
  };
  leave(asked.filter((id) => !AFFILIATE_ID_PATTERN.test(id)), "gone");
  const valid = asked.filter((id) => AFFILIATE_ID_PATTERN.test(id));
  if (!valid.length) return finish();
  if (!store.statsId || !isRedisConfigured()) return (leave(valid, "unavailable"), finish());
  const records = await batchRecords(store, valid, charge);
  if (typeof records === "string") return (leave(valid, records), finish());

  const plain: BatchWrite[] = [];
  const shared: string[] = [];
  const decided = (now: Affiliate) => ({ ...now, status, decidedAt: Date.now() });
  for (const id of valid) {
    const read = records.get(id);
    if (!read) {
      outcome.set(id, "gone");
      continue;
    }
    email.set(id, read.affiliate.email);
    if (read.affiliate.status !== "pending") continue;
    // Over exactly the record read (its share was null then): one given a share meanwhile is not written.
    if (status === "approved" && read.affiliate.share) shared.push(id);
    else plain.push({ id, raw: read.raw, change: (now) => (now.status === "pending" ? decided(now) : null) });
  }
  const writing = plain.reduce((sum, one) => sum + writeBytes(utf8(one.raw), utf8(one.raw) + 64), 0) + shared.length * writeBytes(AFFILIATE_RECORD_MAX_BYTES, AFFILIATE_RECORD_MAX_BYTES);
  const writes = await takeOrWhy(charge, WRITE_COMMANDS * (plain.length + shared.length), writing);
  if (typeof writes === "string") return (leave([...plain.map((one) => one.id), ...shared], writes), finish());
  const wrote = meterOf();
  for (const [id, result] of await writeBatch(store, plain, wrote)) outcome.set(id, result);

  if (shared.length) {
    try {
      const ran = await withPaidStore(store, charge, async (now, lock) => {
        const everyone = await batchPeople(now, charge);
        if (everyone === "used") return leave(shared, "used");
        const people = [...everyone.values()].map((one) => one.affiliate);
        const at = new Map(people.map((one, i) => [one.id, i]));
        const approving: BatchWrite[] = [];
        for (const id of shared) {
          const read = everyone.get(id);
          const i = at.get(id);
          if (!read || i === undefined) {
            outcome.set(id, "gone");
            continue;
          }
          const share = read.affiliate.share;
          if (read.affiliate.status !== "pending") continue;
          if (share) {
            // Against the partners as they stand with those approved before it in this batch.
            const problem = shareProblemAmong(now.affiliates, people, share, id);
            if (problem) {
              outcome.set(id, problem === "crowded" ? "crowded" : "cap");
              continue;
            }
          }
          people[i] = { ...read.affiliate, status };
          approving.push({ id, raw: read.raw, change: (x) => (x.status === "pending" ? decided(x) : null) });
        }
        for (const [id, result] of await writeBatch(store, approving, wrote, lock)) outcome.set(id, result);
      });
      if (!ran) leave(shared, "used");
    } catch (error) {
      if (!(error instanceof UnknownReplyError || error instanceof LockBusyError)) throw error;
    }
    // Not reached for an unknown reply, or the lock held elsewhere: nothing was written for them.
    leave(shared.filter((id) => !outcome.has(id)), "unavailable");
  }
  await settle(writes, wrote);
  if (status === "approved") {
    for (const id of asked) {
      const result = outcome.get(id);
      if (result && typeof result === "object" && result.before.status === "pending") await tellApproved(store, result.before);
    }
  }
  return finish();
}

/**
 * Puts back how each affiliate stood before a decision in bulk, for those
 * still exactly as that decision left them and within BULK_UNDO_MS of it: a
 * later decision by hand is never overwritten. An approval email already
 * sent is not taken back; the studio says so. One read of them all (HMGET); each part taken first and settled once
 * done, like the decision (decideMany). Returns how many were put back (`undone`), how many could not be just now
 * (`left`: a reply not understood, or the record changed meanwhile) and whether the studio requests it needs were not
 * taken (`used`: nothing read or written, so the caller must not say anything was put back).
 */
export async function undoMany(store: Store, before: Before[], decision: "approve" | "decline", now = Date.now(), charge: Charge = PAID): Promise<UndoResult> {
  const left: AffiliateStatus = decision === "approve" ? "approved" : "declined";
  const entries = new Map<string, Before>();
  for (const entry of before.slice(0, MAX_BULK_DECISIONS)) if (entry.status === "pending" && AFFILIATE_ID_PATTERN.test(entry.id)) entries.set(entry.id, entry);
  if (!entries.size) return { undone: 0, left: 0, used: false };
  if (!store.statsId || !isRedisConfigured()) return { undone: 0, left: entries.size, used: false };
  const records = await batchRecords(store, [...entries.keys()], charge);
  if (records === "used") return { undone: 0, left: entries.size, used: true };
  if (records === "unavailable") return { undone: 0, left: entries.size, used: false };
  const writes: BatchWrite[] = [];
  for (const [id, entry] of entries) {
    const read = records.get(id);
    if (!read) continue;
    // Over exactly the record read, and only while it is still as the bulk decision left it.
    writes.push({
      id,
      raw: read.raw,
      change: (affiliate) =>
        affiliate.status !== left || now - affiliate.decidedAt > BULK_UNDO_MS || affiliate.decidedAt < entry.decidedAt
          ? null
          : { ...affiliate, status: entry.status, decidedAt: entry.decidedAt },
    });
  }
  const taken = await takeOrWhy(charge, WRITE_COMMANDS * writes.length, writes.reduce((sum, one) => sum + writeBytes(utf8(one.raw), utf8(one.raw) + 64), 0));
  // Not known whether taken: nothing written, all of them left to try again, and not said to be used up.
  if (typeof taken === "string") return { undone: 0, left: writes.length, used: taken === "used" };
  const wrote = meterOf();
  let undone = 0;
  let notNow = 0;
  for (const result of (await writeBatch(store, writes, wrote)).values()) {
    if (result && typeof result === "object") undone += 1;
    else if (result === "unavailable") notNow += 1;
  }
  await settle(taken, wrote);
  return { undone, left: notNow, used: false };
}

/**
 * What an undo in bulk did: how many were put back, how many could not be just now (an undo may be pressed again for
 * them), and whether nothing was done because the studio requests it needs were not taken.
 */
export type UndoResult = { undone: number; left: number; used: boolean };

/** How one affiliate's own share stood before a change in bulk: what an undo puts back. */
export type RateBefore = { id: string; rate: number | null };

/** One affiliate's share a batch changes: to `rate`, only while `when` holds for their record. */
type RateAsk = { id: string; rate: number | null; when: (now: Affiliate) => boolean };

/**
 * Changes several affiliates' own shares at once (setRatesMany, undoRates). One read of them all (HMGET); a share of
 * their own that only goes down is written at once. Every other change is judged together, under ONE partner lock,
 * against ONE read of the store: one that pays no more on any product (paysNoMore) is written without reading the
 * people; the rest are checked against the cap with ONE read of the program's people, each in turn against the
 * program as it stands with the ones before it changed (pre-review M2). Each part is taken in studio requests first
 * at its worst (`charge`) and settled once done at what it really moved; one that was not taken is left out as
 * "used". Returns those written, with their share before, and who was left out and why.
 */
async function changeRates(store: Store, asks: readonly RateAsk[], charge: Charge): Promise<{ done: RateBefore[]; held: HeldOne[] }> {
  const outcome = new Map<string, BatchResult>();
  const email = new Map<string, string>();
  const leave = (list: readonly string[], why: HeldWhy) => list.forEach((id) => outcome.set(id, why));
  const finish = () => {
    const done: RateBefore[] = [];
    const held: HeldOne[] = [];
    for (const { id } of asks) {
      const result = outcome.get(id);
      if (result === undefined || result === null) continue;
      if (typeof result === "string") held.push({ id, email: email.get(id) ?? "", why: result });
      else done.push({ id, rate: result.before.rate });
    }
    return { done, held };
  };
  leave(asks.filter((ask) => !AFFILIATE_ID_PATTERN.test(ask.id)).map((ask) => ask.id), "gone");
  const valid = asks.filter((ask) => AFFILIATE_ID_PATTERN.test(ask.id));
  const ids = valid.map((ask) => ask.id);
  if (!valid.length) return finish();
  if (!store.statsId || !isRedisConfigured()) return (leave(ids, "unavailable"), finish());
  const records = await batchRecords(store, ids, charge);
  if (typeof records === "string") return (leave(ids, records), finish());

  const plain: BatchWrite[] = [];
  const judged: RateAsk[] = [];
  for (const ask of valid) {
    const read = records.get(ask.id);
    if (!read) {
      outcome.set(ask.id, "gone");
      continue;
    }
    email.set(ask.id, read.affiliate.email);
    const was = read.affiliate.rate;
    if (!ask.when(read.affiliate) || was === ask.rate) continue;
    // Down from a share of their own to a lower one: lower on every product whatever the terms (commissionRate).
    if (was !== null && ask.rate !== null && ask.rate <= was) plain.push({ id: ask.id, raw: read.raw, change: (now) => (ask.when(now) ? withRate(now, ask.rate) : null) });
    else judged.push(ask);
  }
  const writing = plain.reduce((sum, one) => sum + writeBytes(utf8(one.raw), utf8(one.raw) + 8), 0) + judged.length * writeBytes(AFFILIATE_RECORD_MAX_BYTES, AFFILIATE_RECORD_MAX_BYTES);
  const writes = await takeOrWhy(charge, WRITE_COMMANDS * (plain.length + judged.length), writing);
  if (typeof writes === "string") return (leave([...plain.map((one) => one.id), ...judged.map((ask) => ask.id)], writes), finish());
  const wrote = meterOf();
  for (const [id, result] of await writeBatch(store, plain, wrote)) outcome.set(id, result);

  if (judged.length) {
    try {
      const ran = await withPaidStore(store, charge, async (now, lock) => {
        const terms = now.affiliates;
        const changes: BatchWrite[] = [];
        const write = (ask: RateAsk, raw: string) => changes.push({ id: ask.id, raw, change: (x) => (ask.when(x) ? withRate(x, ask.rate) : null) });
        // Paying no more anywhere, under the terms as they are now (they cannot change while the lock is held).
        const lower = judged.filter((ask) => paysNoMore(terms, records.get(ask.id)?.affiliate.rate ?? null, ask.rate));
        const raise = judged.filter((ask) => !lower.includes(ask));
        for (const ask of lower) write(ask, records.get(ask.id)?.raw as string);
        if (raise.length) {
          const everyone = await batchPeople(now, charge);
          if (everyone === "used") leave(raise.map((ask) => ask.id), "used");
          else {
            const people = [...everyone.values()].map((one) => one.affiliate);
            const at = new Map(people.map((one, i) => [one.id, i]));
            for (const ask of lower) {
              const i = at.get(ask.id);
              if (i !== undefined) people[i] = withRate(people[i], ask.rate);
            }
            for (const ask of raise) {
              const read = everyone.get(ask.id);
              const i = at.get(ask.id);
              if (!read || i === undefined) {
                outcome.set(ask.id, "gone");
                continue;
              }
              if (!ask.when(read.affiliate) || read.affiliate.rate === ask.rate) continue;
              // Against the program as it stands with those changed before it in this batch.
              const next = people.slice();
              next[i] = withRate(people[i], ask.rate);
              if (commissionCapProblem({ terms, people, nextTerms: terms, nextPeople: next })) {
                outcome.set(ask.id, "cap");
                continue;
              }
              people[i] = next[i];
              write(ask, read.raw);
            }
          }
        }
        for (const [id, result] of await writeBatch(store, changes, wrote, lock)) outcome.set(id, result);
      });
      if (!ran) leave(judged.map((ask) => ask.id), "used");
    } catch (error) {
      if (!(error instanceof UnknownReplyError || error instanceof LockBusyError)) throw error;
    }
    // Not reached for an unknown reply, or the lock held elsewhere: nothing was written for them.
    leave(judged.map((ask) => ask.id).filter((id) => !outcome.has(id)), "unavailable");
  }
  await settle(writes, wrote);
  return finish();
}

/**
 * Sets, or clears with null, the share of several approved affiliates at once (630 [HN6](4), unit 2): it applies to
 * sales from now on, and a sale keeps the share it was made at. Checked against the cap like one at a time
 * (setAffiliateRate), all together (changeRates). Returns how each stood before, leaving out those already at it, and
 * who was left out and why.
 */
export async function setRatesMany(store: Store, ids: string[], rate: number | null, charge: Charge = PAID): Promise<{ before: RateBefore[]; refused: HeldOne[] } | null> {
  if (rate !== null && (!Number.isInteger(rate) || rate < MIN_COMMISSION || rate > MAX_COMMISSION)) return null;
  const asks = batchIds(ids).map((id) => ({ id, rate, when: (a: Affiliate) => a.status === "approved" && a.rate !== rate }));
  const { done, held } = await changeRates(store, asks, charge);
  return { before: done, refused: held };
}

/**
 * Puts back each share still exactly as the change left it; one changed by hand since is never overwritten. Putting
 * back a higher share is checked against the cap like any raise; over it, or unchecked, it stays. Returns as undoMany:
 * `left` counts each one not put back for the cap or a reply not understood, `used` that the studio requests were
 * not taken for any of them.
 */
export async function undoRates(store: Store, before: RateBefore[], rate: number | null, charge: Charge = PAID): Promise<UndoResult> {
  const asks: RateAsk[] = [];
  const seen = new Set<string>();
  for (const entry of before.slice(0, MAX_BULK_DECISIONS)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    asks.push({ id: entry.id, rate: entry.rate, when: (a) => a.rate === rate });
  }
  const { done, held } = await changeRates(store, asks, charge);
  const left = held.filter((one) => one.why !== "gone").length;
  return { undone: done.length, left, used: done.length === 0 && held.some((one) => one.why === "used") };
}

export async function addPayout(
  store: Store,
  input: { aff: string; cents: number; currency: string; date: string; reference: string },
): Promise<Payout | null> {
  if (!(await readAffiliate(store, input.aff))) return null;
  const payout: Payout = {
    id: randomBytes(6).toString("hex"),
    aff: input.aff,
    cents: input.cents,
    currency: input.currency,
    date: input.date,
    reference: input.reference.replace(/\s+/g, " ").trim().slice(0, MAX_REFERENCE_LENGTH),
    at: Date.now(),
  };
  // What the creator writes down takes room in the store's data room first (DataRoomError when it does not fit).
  const json = JSON.stringify(payout);
  await needData(store, [{ slot: PAYOUTS_SLOT, bytes: dataBytes([payout.id, json], 1) }]);
  // Written only on HSET's exact 1, a new field (rule 24): a reply missing or of another shape may have written
  // nothing, and a book still owing what was paid pays it again (the next payout file, PayPal on payday); 0 means
  // another payout under the same id was overwritten. Thrown either way; the room stays counted (more, never less).
  const reply = repliesFor(await redisPipeline([["HSET", payoutsKey(store.statsId as string), payout.id, json]]), 1);
  if (!reply || reply[0] !== 1) throw new UnknownReplyError("a payout written down");
  return payout;
}

export async function removePayout(store: Store, id: string): Promise<boolean> {
  if (!store.statsId || !/^[0-9a-f]{12}$/.test(id)) return false;
  const [held, removed] = await redisPipeline([["HGET", payoutsKey(store.statsId), id], ["HDEL", payoutsKey(store.statsId), id]]);
  if (Number(removed) === 1 && typeof held === "string") await giveData(store, [{ slot: PAYOUTS_SLOT, bytes: dataBytes([id, held], 1) }]);
  return Number(removed) === 1;
}

/** Where what the creator says they paid their affiliates is counted in the store's data room (lib/store-data.ts). */
const PAYOUTS_SLOT = "aff:payouts";

// ---- Clicks and the checkout ---------------------------------------------

/** The approved affiliate behind a code, or null. */
async function approvedByCode(store: Store, code: string): Promise<Affiliate | null> {
  if (!affiliatesOn(store) || !AFFILIATE_CODE_PATTERN.test(code)) return null;
  const [id] = await redisPipeline([["HGET", codesKey(store.statsId as string), code]]);
  if (typeof id !== "string") return null;
  const affiliate = await readAffiliate(store, id);
  return affiliate?.status === "approved" ? affiliate : null;
}

/**
 * Counts a click on an affiliate's link: once per visitor per day, a limited
 * number per connection per hour, and not from the affiliate's own browser.
 * The caller has already left out the creator and known robots.
 */
export async function recordClick(
  store: Store,
  code: string,
  visitor: { ip: string; userAgent: string; session: string | undefined; paid?: boolean },
): Promise<boolean> {
  const affiliate = await approvedByCode(store, code);
  if (!affiliate) return false;
  const own = await affiliateForSession(store, visitor.session);
  if (own?.id === affiliate.id) return false;
  const statsId = store.statsId as string;
  // A count that could not be read counts no click; thrown so the visit's log says why (lib/visit.ts).
  const allowed = await within(clickIpKey(visitor.ip, statsId), CLICK_IP_LIMIT);
  if (allowed === null) throw new UnknownReplyError("an affiliate click count");
  if (!allowed) return false;
  const day = Math.floor(Date.now() / 86_400_000);
  const [fresh] = await redisPipeline([
    ["SET", seenKey(`${statsId}|${affiliate.id}|${visitor.ip}|${visitor.userAgent}|${day}`), "1", "NX", "EX", 2 * 86_400],
  ]);
  if (fresh === null) return false;
  await redisPipeline([
    ["HINCRBY", clicksKey(statsId), affiliate.id, 1],
    // Reached from a paid search ad (lib/affiliate-setting.ts paidSearch): counted apart, so it can be held.
    ...(visitor.paid ? [["HINCRBY", paidClicksKey(statsId), affiliate.id, 1]] : []),
  ]);
  return true;
}

/**
 * Who a checkout is credited to, read from the click cookie: an approved
 * affiliate, within the store's window — and never the browser of that
 * affiliate themselves.
 *
 * Which click is read is the store's own rule (lib/affiliate-setting.ts):
 * the latest link followed, or the first one the visitor ever followed. The
 * window is counted from whichever click that is, so a store on first click
 * gives its affiliates a window that starts when the buyer was found, not one
 * that restarts every time they come back.
 *
 * `rate` is this product's own share, and it may be 0. That is deliberate.
 * An order can hold more than this product: a bump rides in the same charge
 * and earns its own product's share. So whether the order earns anything at
 * all is not knowable here, only where the order is finally assembled, and
 * the guard belongs there — in lib/store-checkout.ts for a checkout, in
 * lib/calls.ts for a booking. Deciding it here voided the bump's commission
 * whenever the main product happened to be set to 0%, which is exactly the
 * case a creator uses to pay on the add-on and not on the front offer.
 */
export async function attributionFor(
  store: Store,
  productId: string,
  cookies: { via: string | undefined; session: string | undefined },
): Promise<{ aff: string; rate: number; own: number | null } | null> {
  const affiliate = await attributedAffiliate(store, cookies);
  return affiliate ? { aff: affiliate.id, rate: commissionRate(store.affiliates, productId, affiliate.rate), own: affiliate.rate } : null;
}

/**
 * The approved affiliate a visit is credited to by its click cookie, under
 * the store's rule and window, never the affiliate's own browser: what a
 * checkout is credited by (attributionFor), and a lead (lib/affiliate-leads.ts).
 */
export async function attributedAffiliate(
  store: Store,
  cookies: { via: string | undefined; session: string | undefined },
): Promise<Affiliate | null> {
  if (!affiliatesOn(store)) return null;
  const via = readViaCookie(cookies.via);
  if (!via) return null;
  const click = store.affiliates.rule === "first" ? via.first : via.last;
  const now = Math.floor(Date.now() / 1000);
  if (click.at > now + 60 || now - click.at > store.affiliates.days * 86_400) return null;
  let affiliate = await approvedByCode(store, click.code);
  // On first click, somebody the creator has since declined or removed leaves
  // the sale to the affiliate who actually brought the buyer back, rather than
  // taking it away from everyone.
  if (!affiliate && store.affiliates.rule === "first" && via.last.code !== click.code) {
    const back = via.last;
    if (back.at <= now + 60 && now - back.at <= store.affiliates.days * 86_400) {
      affiliate = await approvedByCode(store, back.code);
    }
  }
  if (!affiliate) return null;
  const own = await affiliateForSession(store, cookies.session);
  if (own?.id === affiliate.id) return null;
  return affiliate;
}

// ---- A link the checkout could not read: charged now, credited later -----

/**
 * The metadata key an order carries when the affiliate behind its click could not be read at checkout (owner's
 * decision 6, 9 November 2026: the sale is charged and the affiliate is linked afterwards). Its value is
 * "<last>~<first>~<own>~<shares>": the two clicks as the visit's cookie held them, the affiliate this browser was
 * signed in as ("-" for nobody, "?" when that did not read either), and the shares the program held at the sale
 * (shareSnapshot), so a sale confirmed later keeps the share it was made at. It credits nothing by itself: nothing is
 * credited on it until a later read answers (notePendingLinks; creditPayPalSale for a PayPal order).
 */
export const VIA_PENDING_META = "via_pending";

/**
 * How long a pending link is read again before the creator is told, from when the order is first seen paid (a
 * checkout stays open a day, and a buyer may pay late in it). The five-minute sweep (lib/checkout-sweep.ts) reads it
 * at each pass: two hours is 24 passes, enough to outlast a passing fault of the database. It never runs past the
 * day for which the sweep reads a checkout at all (CONFIRM_WITHIN_SECONDS, lib/purchase-email.ts) less the notice's
 * tries (PENDING_TELL_MARGIN), and the link is always read once before anyone is told. Once told, nothing is credited
 * automatically any more: a creator who pays the affiliate by hand is never paid over by a late read.
 */
export const PENDING_LINK_SECONDS = 2 * 60 * 60;

/** The most commands one pending order's read takes in a sweep's run: a code and a record, twice on first click. */
export const PENDING_LINK_COMMANDS = 4;

/** How long the mark of a decided link stays: past the sweep's day of reading, so an order is never decided twice. */
const PENDING_MARK_SECONDS = 2 * 86_400;
/** What the deadline leaves before the sweep stops reading a checkout: the notice's tries, one a pass, and one pass more. */
export const PENDING_TELL_MARGIN = (REFUSED_TRIES + 1) * 300;
/** The day the sweep reads a checkout for (CONFIRM_WITHIN_SECONDS, lib/purchase-email.ts; held equal by the test). */
export const PENDING_SWEEP_SECONDS = 24 * 60 * 60;
const pendingKey = (statsId: string, ref: string) => `nl:aff:pend:${statsId}:${ref}`;

/** What the checkout's read of the visit's affiliate came to: known (somebody or nobody), or not known and kept. */
export type Attribution =
  | { known: true; via: { aff: string; rate: number; own: number | null } | null }
  | { known: false; pending: string };

/** The approved affiliate behind a code, read exactly (rule 24): null for nobody approved, UnknownReplyError otherwise. */
async function approvedByCodeExact(store: Store, code: string): Promise<Affiliate | null> {
  if (!AFFILIATE_CODE_PATTERN.test(code)) return null;
  const statsId = store.statsId as string;
  const id = repliesFor(await redisPipeline([["HGET", codesKey(statsId), code]]), 1)?.[0];
  if (id === null) return null;
  if (typeof id !== "string" || !AFFILIATE_ID_PATTERN.test(id)) throw new UnknownReplyError("which affiliate a code belongs to");
  const raw = repliesFor(await redisPipeline([["HGET", peopleKey(statsId), id]]), 1)?.[0];
  if (raw === null) return null;
  const affiliate = typeof raw === "string" ? parseAffiliate(raw) : null;
  // A record that does not read is not "nobody": the sale may well be theirs.
  if (!affiliate || affiliate.id !== id) throw new UnknownReplyError("an affiliate's record");
  return affiliate.status === "approved" ? affiliate : null;
}

/** The affiliate a browser is signed in as on this store, read exactly: "-" for nobody, their id, UnknownReplyError otherwise. */
async function ownIdExact(store: Store, session: string | undefined): Promise<string> {
  if (!session || !AFFILIATE_TOKEN_PATTERN.test(session)) return "-";
  const raw = repliesFor(await redisPipeline([["GET", sessionKey(session)]]), 1)?.[0];
  if (raw === null) return "-";
  if (typeof raw !== "string") throw new UnknownReplyError("an affiliate's session");
  let value: { s?: unknown; a?: unknown };
  try {
    value = JSON.parse(raw) as { s?: unknown; a?: unknown };
  } catch {
    throw new UnknownReplyError("an affiliate's session");
  }
  if (value.s !== store.statsId) return "-";
  if (typeof value.a !== "string" || !AFFILIATE_ID_PATTERN.test(value.a)) throw new UnknownReplyError("an affiliate's session");
  return value.a;
}

/** Who the clicks credit at `atSeconds`, under the store's rule and window, as attributedAffiliate decides; read exactly. */
async function creditedByClicks(store: Store, via: Via, atSeconds: number): Promise<Affiliate | null> {
  const inWindow = (click: Via["last"]) => click.at <= atSeconds + 60 && atSeconds - click.at <= store.affiliates.days * 86_400;
  const click = store.affiliates.rule === "first" ? via.first : via.last;
  if (!inWindow(click)) return null;
  const affiliate = await approvedByCodeExact(store, click.code);
  if (affiliate || store.affiliates.rule !== "first" || via.last.code === click.code || !inWindow(via.last)) return affiliate;
  return approvedByCodeExact(store, via.last.code);
}

/** A product id as a checkout writes it (lib/catalog.ts). */
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The shares the program holds now for the products an order may hold, and its months on renewals, as the pending
 * mark keeps them: "<months>;<id>=<percent>;<id>=x", "x" for a product the creator took out (0% for everyone, an
 * affiliate's own share included). An affiliate's own share is not known yet: it is read at the confirmation.
 * Kept short (Stripe takes 500 characters a value, a PayPal order 200, and holds one product): products past the
 * room are left out, and a sale holding one left out is not credited automatically: its share at the sale is not
 * known (rule 24), so the creator is told as for a link that never read.
 */
function shareSnapshot(store: Store, products: readonly string[]): string {
  const parts = [String(store.affiliates.recurring)];
  let room = 300;
  for (const id of new Set(products)) {
    if (!SNAPSHOT_ID.test(id)) continue;
    const entry = `${id}=${store.affiliates.rates[id] === 0 ? "x" : commissionRate(store.affiliates, id, null)}`;
    if (entry.length + 1 > room) break;
    parts.push(entry);
    room -= entry.length + 1;
  }
  return parts.join(";");
}

/**
 * Who a checkout is credited to, as attributionFor, except that a read that does not answer is never "nobody" (owner's
 * decision 6): it answers { known: false } with the visit's clicks and the program's shares now for `products` (the
 * order's products; productId alone when not given), which the checkout carries on the order (pendingChannel) so the
 * sale is charged as usual and credited once a later read answers. Never throws: a checkout route opens the payment
 * page whatever it answers.
 */
export async function attributionOrPending(
  store: Store,
  productId: string,
  cookies: { via: string | undefined; session: string | undefined },
  products: readonly string[] = [productId],
): Promise<Attribution> {
  const via = affiliatesOn(store) ? readViaCookie(cookies.via) : null;
  if (!via) return { known: true, via: null };
  try {
    const affiliate = await creditedByClicks(store, via, Math.floor(Date.now() / 1000));
    if (!affiliate) return { known: true, via: null };
    if ((await ownIdExact(store, cookies.session)) === affiliate.id) return { known: true, via: null };
    return { known: true, via: { aff: affiliate.id, rate: commissionRate(store.affiliates, productId, affiliate.rate), own: affiliate.rate } };
  } catch (error) {
    console.error("an affiliate's link could not be read at checkout; the sale goes on with it pending", store.handle, error instanceof Error ? error.message : "");
    const own = await ownIdExact(store, cookies.session).catch(() => "?");
    const shares = shareSnapshot(store, [productId, ...products]);
    return { known: false, pending: `${via.last.code}.${via.last.at}~${via.first.code}.${via.first.at}~${own}~${shares}` };
  }
}

/** The metadata a checkout adds for a link it could not read: the pending clicks, and nothing when it knows. */
export function pendingChannel(attribution: Attribution): Record<string, string> {
  return attribution.known ? {} : { [VIA_PENDING_META]: attribution.pending };
}

type Pending = { via: Via; own: string; months: number | null; shares: Map<string, number | "x"> };

/** A pending mark as the checkout wrote it, or null for one that does not read. */
function readPending(raw: unknown): Pending | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split("~");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const via = readViaCookie(`${parts[0]}~${parts[1]}`);
  const own = parts[2];
  if (!via || !(own === "-" || own === "?" || AFFILIATE_ID_PATTERN.test(own))) return null;
  const shares = new Map<string, number | "x">();
  let months: number | null = null;
  if (parts.length === 4) {
    const [first, ...entries] = parts[3].split(";");
    if (!/^\d{1,4}$/.test(first)) return null;
    months = Number(first);
    for (const entry of entries) {
      const [id, share] = entry.split("=");
      if (!id || !SNAPSHOT_ID.test(id) || !(share === "x" || /^\d{1,3}(\.\d+)?$/.test(share ?? ""))) return null;
      shares.set(id, share === "x" ? "x" : Number(share));
    }
  }
  return { via, own, months, shares };
}

/**
 * The share a product of a pending sale earns: the program's at the sale, the affiliate's own share read now in its
 * place, 0 for a product taken out; null when the sale's share for it was not kept (never the share of today, which a
 * change since could have raised or cut).
 */
function saleShare(pending: Pending, productId: string, own: number | null): number | null {
  const kept = pending.shares.get(productId);
  if (kept === undefined) return null;
  return kept === "x" ? 0 : own ?? kept;
}

type PendingOutcome =
  | { kind: "credit"; affiliate: Affiliate; pending: Pending }
  | { kind: "share"; affiliate: Affiliate }
  | { kind: "own"; affiliate: Affiliate }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * Whether the affiliate's own share may have changed since the sale at `atSeconds` (withRate): changed after it, or
 * set at a date not kept. The share the sale was made at is then not known, and nothing is credited on its own.
 */
function ownShareChangedSince(affiliate: Affiliate, atSeconds: number): boolean {
  return affiliate.rateAt !== undefined ? affiliate.rateAt > atSeconds * 1000 : affiliate.rate !== null;
}

/**
 * A pending link read again, against the sale's own time: credited, nobody, still not known, or ("share") read but
 * sold at an own share of the affiliate's that has changed since. Never throws.
 */
async function decidePending(store: Store, raw: unknown, atSeconds: number): Promise<PendingOutcome> {
  const pending = readPending(raw);
  if (!pending) return { kind: "unknown" };
  try {
    const affiliate = await creditedByClicks(store, pending.via, atSeconds);
    // Who is approved is read now, at the confirmation, not at the sale: an affiliate approved in between is
    // credited, one declined or removed in between is not (at most PENDING_SWEEP_SECONDS after the checkout opened).
    if (!affiliate || pending.own === affiliate.id) return { kind: "none" };
    // Every product of the order taken out of the program earns nothing, whatever the affiliate's own share.
    if (pending.shares.size && [...pending.shares.values()].every((kept) => kept === "x")) return { kind: "none" };
    // Their own browser could not be told apart at checkout, and never will be: not credited automatically, and the
    // creator is told at once (never read again for nothing).
    if (pending.own === "?") return { kind: "own", affiliate };
    if (ownShareChangedSince(affiliate, atSeconds)) return { kind: "share", affiliate };
    return { kind: "credit", affiliate, pending };
  } catch (error) {
    console.error("a pending affiliate link still does not read", store.handle, error instanceof Error ? error.message : "");
    return { kind: "unknown" };
  }
}

/**
 * A pending link's mark (PENDING_MARK_SECONDS), one an order:
 *   seen:<t>          first seen paid at t, read at least once, not decided yet;
 *   offers:<aff>:<t>  credited to <aff>, its offers after paying not all read yet (they follow it meanwhile);
 *   lead:<aff>:<t>    credited to <aff>, its booking's lead not written yet (tried again, then told);
 *   credited:<aff>    credited to <aff>: its offers after paying follow it (notePendingOffer);
 *   none              nobody's;
 *   tell:<why>        a notice due, refused fewer than REFUSED_TRIES times, tried again at the next pass;
 *   told              the notice was sent;
 *   uncertain         its send is not known: never sent again blindly (rule 24);
 *   untold            refused REFUSED_TRIES times, said in the sweep's log.
 * From the moment a notice is due, nothing about the sale is credited automatically, whatever a later read says.
 */
type TellWhy = "unread" | "membership" | "unsure" | "lead" | "share" | "first" | "own" | "offers";
type PendingMark =
  | `seen:${number}`
  | `offers:${string}:${number}`
  | `lead:${string}:${number}`
  | `credited:${string}`
  | "none"
  | `tell:${TellWhy}`
  | "told"
  | "uncertain"
  | "untold";
const TELL_WHYS: readonly TellWhy[] = ["unread", "membership", "unsure", "lead", "share", "first", "own", "offers"];

/** A pending link's mark, read exactly: null when nothing was decided, UnknownReplyError for an answer of another shape. */
async function readPendingMark(statsId: string, ref: string): Promise<string | null> {
  const mark = repliesFor(await redisPipeline([["GET", pendingKey(statsId, ref)]]), 1)?.[0];
  if (mark === null || typeof mark === "string") return mark;
  throw new UnknownReplyError("a pending affiliate link's mark");
}

/** Writes a pending link's mark, kept PENDING_MARK_SECONDS. */
async function writePendingMark(statsId: string, ref: string, mark: PendingMark): Promise<void> {
  const reply = repliesFor(await redisPipeline([["SET", pendingKey(statsId, ref), mark, "EX", PENDING_MARK_SECONDS]]), 1)?.[0];
  if (reply !== "OK") throw new UnknownReplyError("a pending affiliate link's mark");
}

/** The affiliate a mark says the order was credited to, its offers following it: "" for none. */
function creditedTo(mark: string | null): string {
  const found = mark?.match(/^(?:credited:([0-9a-f]{12})|(?:offers|lead):([0-9a-f]{12}):\d+)$/);
  return found ? found[1] ?? found[2] ?? "" : "";
}

/** Sends one email and says how it went, as lib/email.ts sendEmailOutcome does: handed in by the tests. */
export type PendingSend = (message: Parameters<typeof sendEmailOutcome>[0]) => Promise<SendOutcome>;

type Told = "told" | "uncertain" | "refused" | "untold" | "credited";

/** What the creator is told about a sale whose affiliate link was never confirmed (tellPending): by email and on the phone. Pure. */
export function pendingNotice(
  store: Pick<Store, "name" | "email" | "sid" | "affiliates">,
  ref: string,
  raw: unknown,
  why: TellWhy,
): { to: string; subject: string; text: string; title: string; body: string } {
  const pending = readPending(raw);
  const code = pending ? (store.affiliates.rule === "first" ? pending.via.first.code : pending.via.last.code) : "unknown";
  const studio = `${SITE_URL}/studio/affiliates${store.sid ? `?store=${store.sid}` : ""}`;
  const first = {
    unread: `An order on ${store.name} came through an affiliate's link that could not be read when the buyer paid, and it still could not be read when it was checked again later. The code on the link was ${code}.`,
    share: `An order on ${store.name} came through the link of the affiliate with the code ${code}. The link was read later, but the share it was sold at is not known now: the program's share for it was not kept, or the affiliate has a share of their own that is not known to date from before the sale (it may have been set or moved after it, or its date was not kept). So it was not credited automatically.`,
    first: `A membership or payment plan on ${store.name} came through the link of the affiliate with the code ${code}. The affiliate is on its subscription, so its renewals are credited to them, but the payment its first invoice was paid by could not be read, so that first payment is not counted.`,
    own: `An order on ${store.name} came through the link of the affiliate with the code ${code}. The link was read later, but we could not tell whether the buyer was the affiliate themselves, whose own purchases never earn, so it was not credited automatically.`,
    offers: `An order on ${store.name} came through the link of the affiliate with the code ${code} and was credited to them, but the offers the buyer took after paying could not all be read, so those offers are not counted.`,
    membership: `A membership or payment plan on ${store.name} came through the link of the affiliate with the code ${code}. The link could not be read when the buyer paid, or could not be put on the subscription later, so its payments are not credited to them.`,
    unsure: `A membership or payment plan on ${store.name} came through the link of the affiliate with the code ${code}. We could not confirm whether the affiliate was put on its subscription: Stripe did not answer.`,
    lead: `A call booked on ${store.name} came through the link of the affiliate with the code ${code}. The sale was credited to them, but its lead could not be written down, so the lead is not counted.`,
  }[why];
  const what = {
    unread: "It was not credited to any affiliate, so no commission is counted for it, nor for an offer the buyer took after paying. The buyer was charged as usual and has their purchase.",
    share: "No commission is counted for it, nor for an offer the buyer took after paying. The buyer was charged as usual and has their purchase.",
    membership: "No commission is counted for its payments. The buyer was charged as usual and has their membership.",
    unsure: "Before paying anything for it, look in your affiliates' book: if its payments appear there under the affiliate, they are counted already.",
    lead: "No lead payment is counted for it.",
    first: "No commission is counted for the first payment; the ones after it are counted as usual.",
    own: "No commission is counted for it, nor for an offer the buyer took after paying. The buyer was charged as usual and has their purchase.",
    offers: "The order itself is counted as usual; no commission is counted for its offers.",
  }[why];
  return {
    to: store.email,
    subject: why === "unsure" ? `An affiliate link on a membership on ${store.name} could not be confirmed` : `An affiliate link on an order on ${store.name} was not credited`,
    text: [
      first,
      `The order: ${ref}`,
      "",
      what,
      why === "unsure"
        ? "If it is not there and you decide it is theirs, pay them outside Marktmorgen: a payout written down in your studio is taken off what they earn next."
        : "If you decide it is theirs, pay them outside Marktmorgen: a payout written down in your studio is taken off what they earn next, so it would not settle this sale.",
      `Your affiliates: ${studio}`,
    ].join("\n"),
    title: why === "unsure" ? "An affiliate link could not be confirmed" : "An affiliate link was not credited",
    body: why === "unsure" ? `A membership came through the code ${code}; check your affiliates' book before paying anything for it.` : `An order came through the code ${code}, which could not be credited. Pay the affiliate outside Marktmorgen if it is theirs.`,
  };
}

/**
 * Tells the creator about a sale whose affiliate link was never confirmed: by email from the store's own figure (line
 * store-email), and on the phone where they asked for affiliate notices (alertCreator, once a sale by its own seed).
 * Never about a sale already credited. The notice is final only when the email was sent ("told"); a send that is not
 * known is marked "uncertain" and never sent again blindly; one refused for certain leaves the notice due
 * ("tell:<why>") for the next pass, and at REFUSED_TRIES refusals (lib/refused-tries.ts) it is "untold" and said in
 * the log. Its mark is set before the email goes, so no later read credits the sale on its own.
 */
async function tellPending(store: Store, ref: string, raw: unknown, why: TellWhy, send: PendingSend): Promise<Told> {
  const statsId = store.statsId as string;
  if (why === "unread" || why === "share" || why === "own") {
    // Credited already (a pass whose mark did not write): marked credited to its affiliate, so its offers follow it.
    const written = repliesFor(await redisPipeline([["HGET", salesKey(statsId), ref]]), 1)?.[0];
    if (typeof written === "string") {
      const aff = parseReferral(written)?.aff ?? "";
      if (!AFFILIATE_ID_PATTERN.test(aff)) throw new UnknownReplyError("a sale already credited");
      await writePendingMark(statsId, ref, `credited:${aff}`);
      return "credited";
    }
    if (written !== null) throw new UnknownReplyError("whether a sale was credited");
  }
  const name = `aff-pending:${statsId}:${ref}`;
  if (await refusedTooOften(name)) {
    await writePendingMark(statsId, ref, "untold");
    console.error("a creator could not be told about an unconfirmed affiliate link: the email was refused too often", store.handle, ref);
    return "untold";
  }
  await writePendingMark(statsId, ref, `tell:${why}`);
  const notice = pendingNotice(store, ref, raw, why);
  const outcome = await send({ meter: { by: "store", store: store, kind: "email" },
    from: `"Marktmorgen" <${senderAddress()}>`,
    to: notice.to,
    subject: notice.subject,
    text: notice.text,
    idempotencyKey: `nimbus-aff-pending:${statsId}:${ref}`,
  }).catch((error: unknown): SendOutcome => {
    console.error("telling a creator about an unconfirmed affiliate link failed", error);
    return "uncertain";
  });
  await alertCreator(
    store,
    "affiliate",
    { title: notice.title, body: notice.body, url: store.sid ? `/studio/affiliates?store=${store.sid}` : "/studio/affiliates" },
    { seed: `pending:${ref}` },
  ).catch((error) => console.error("an unconfirmed-affiliate notification failed", error));
  if (outcome === "sent") {
    await writePendingMark(statsId, ref, "told");
    return "told";
  }
  if (outcome === "uncertain") {
    await writePendingMark(statsId, ref, "uncertain");
    console.error("a creator's notice about an unconfirmed affiliate link may or may not have gone; not sent again", store.handle, ref);
    return "uncertain";
  }
  if (await countRefusal(name)) return "refused";
  await writePendingMark(statsId, ref, "untold");
  console.error(`a creator could not be told about an unconfirmed affiliate link: the email was refused ${REFUSED_TRIES} times`, store.handle, ref);
  return "untold";
}

/** The order's metadata as if its link had read at checkout: the affiliate, and each product's share at the sale; null when one is not known. */
function creditedMeta(meta: Record<string, string>, affiliate: Affiliate, pending: Pending): { meta: Record<string, string>; earns: boolean } | null {
  const front = saleShare(pending, meta.product ?? "", affiliate.rate);
  if (front === null) return null;
  const out: Record<string, string> = { ...meta, via: affiliate.id, via_rate: String(front) };
  let earns = front > 0;
  for (const { key, id } of bumpsFromMeta(meta)) {
    const rate = saleShare(pending, id, affiliate.rate);
    if (rate === null) return null;
    out[`${key}_rate`] = String(rate);
    earns ||= rate > 0;
  }
  return { meta: out, earns };
}

/** The pass's time was spent before Stripe could be asked: nothing is known, nothing is said, the order waits for the next pass. */
export class PassTimeSpent extends Error {
  constructor() {
    super("the pass's time was spent before Stripe could be asked");
    this.name = "PassTimeSpent";
  }
}

/** Stripe answered a pending link's read in a shape not known, or not at all (rule 24): never taken for an answer. */
export class StripeUnknownError extends Error {
  constructor(what: string) {
    super(`Stripe answered ${what} in an unknown shape`);
    this.name = "StripeUnknownError";
  }
}

/** How long a Stripe request may take inside the pass's deadline; PassTimeSpent when none is left (rule 24: the order waits). */
function pendingWait(deadline: number | undefined): number {
  const wait = stripeWait(deadline);
  if (wait === null) throw new PassTimeSpent();
  return wait;
}

/**
 * Credits an offer taken after paying (lib/upsell.ts, which calls noteCharge) on an order whose link was pending, to
 * `aff` or, not given, to whom that order's mark says it was credited (creditedTo): at the share the offer's product
 * earns in the program now, as lib/upsell.ts credits an offer on an order whose link read, whether the program is on
 * now or not (the order was sold while it was). Nothing while the order is still pending, or nobody's, or for an
 * affiliate since declined or removed.
 */
async function notePendingOffer(store: Store, pi: Record<string, unknown>, parent: string, aff?: string): Promise<void> {
  if (!store.statsId || typeof pi.id !== "string" || pi.status !== "succeeded") return;
  const to = aff ?? creditedTo(await readPendingMark(store.statsId, parent));
  if (!AFFILIATE_ID_PATTERN.test(to)) return;
  const affiliate = await readAffiliate(store, to);
  if (affiliate?.status !== "approved") return;
  const meta = (pi.metadata ?? {}) as Record<string, string>;
  const rate = commissionRate(store.affiliates, meta.product ?? "", affiliate.rate);
  if (rate <= 0) return;
  await noteCharge(store, { ...pi, metadata: { ...meta, via: to, via_rate: String(rate) } });
}

/** Pages of a buyer's payments read for an order's offers after paying, at the most (as lib/upsell.ts OFFER_PAGES_IN_JOB). */
export const PENDING_OFFER_PAGES = 5;

/**
 * The offers after paying already paid on an order confirmed now, read from the buyer's payments on the creator's
 * account, page by page up to PENDING_OFFER_PAGES; a page that does not read, or more than that, throws, and the
 * order's offers are read again at the next pass (its mark says offers:<aff>, which offers noted meanwhile follow).
 */
async function creditOffersOf(store: Store, row: SessionLike & { id: string }, aff: string, deadline?: number): Promise<void> {
  if (typeof row.customer !== "string" || !row.customer || !store.stripeAccountId) return;
  let after = "";
  for (let page = 0; page < PENDING_OFFER_PAGES; page += 1) {
    const query = new URLSearchParams({ customer: row.customer, limit: "100" });
    if (after) query.set("starting_after", after);
    const read = readStripePage(await onAccount("GET", store.stripeAccountId, `/payment_intents?${query}`, undefined, STRIPE_LIST_VERSION, undefined, pendingWait(deadline)));
    for (const pi of read.rows) {
      const meta = pi.metadata as Record<string, unknown> | null | undefined;
      if (meta?.kind === "upsell" && meta.parent === row.id) await notePendingOffer(store, pi, row.id, aff);
    }
    if (!read.hasMore) {
      if (read.unreadable) throw new StripeUnknownError("a buyer's payment");
      return;
    }
    if (!read.lastId) throw new StripeUnknownError("a page of a buyer's payments");
    after = read.lastId;
  }
  throw new StripeUnknownError("more of a buyer's payments than are read");
}

/** A Stripe subscription's own affiliate (metadata via), read exactly: "" for none, UnknownReplyError when it does not answer. */
async function subscriptionVia(store: Store, subscription: string, deadline?: number): Promise<{ via: string; rate: string }> {
  const read = await onAccount("GET", store.stripeAccountId as string, `/subscriptions/${subscription}`, undefined, AFF_SUB_STRIPE_VERSION, undefined, pendingWait(deadline));
  const meta = read.metadata as Record<string, unknown> | null | undefined;
  if (read.id !== subscription || !meta || typeof meta !== "object") throw new StripeUnknownError("a membership's subscription");
  return { via: typeof meta.via === "string" ? meta.via : "", rate: typeof meta.via_rate === "string" ? meta.via_rate : "" };
}

/**
 * Credits a membership's first payment, already made before the affiliate was on its subscription, as a renewal of
 * it, with the payment its invoice was paid by (read from the invoice, pinned as recurringReferrals reads them), so a
 * refund or a dispute takes it back (settleLine). An invoice that does not answer, or names no payment, throws: not
 * credited, read again at the next pass.
 */
async function creditFirstPayment(store: Store, row: SessionLike & { id: string }, aff: string, rate: number, deadline?: number): Promise<void> {
  const meta = row.metadata ?? {};
  // A total or a tax that is not a number is not known (rule 24): never 0, which would mark the order credited with
  // nothing written, or work the commission out on the buyer's tax. The order waits for the next pass. A real 0 (a
  // trial) has nothing to credit; a session with no total_details at all is read as no tax, as noteSession reads it.
  if (typeof row.amount_total !== "number" || !Number.isSafeInteger(row.amount_total)) throw new StripeUnknownError("a membership's first payment's total");
  const taxRead = row.total_details ? row.total_details.amount_tax : 0;
  if (typeof taxRead !== "number" || !Number.isSafeInteger(taxRead) || taxRead < 0) throw new StripeUnknownError("a membership's first payment's tax");
  const total = row.amount_total;
  if (total <= 0) return;
  const invoice = typeof row.invoice === "string" ? row.invoice : "";
  if (!/^in_[A-Za-z0-9]{3,250}$/.test(invoice)) throw new StripeUnknownError("a membership's first invoice");
  const read = (await onAccount("GET", store.stripeAccountId as string, `/invoices/${invoice}?expand[]=payments`, undefined, AFF_SUB_STRIPE_VERSION, undefined, pendingWait(deadline))) as {
    id?: unknown;
    payments?: { data?: { status?: unknown; payment?: { payment_intent?: unknown } | null }[] } | null;
  };
  const pi = read.id === invoice ? (read.payments?.data ?? []).filter((p) => p.status === undefined || p.status === "paid").map((p) => p.payment?.payment_intent).find((x): x is string => typeof x === "string" && /^pi_/.test(x)) : undefined;
  if (!pi) throw new StripeUnknownError("a membership's first payment");
  const tax = taxRead;
  const buyer = typeof row.customer_details?.email === "string" ? row.customer_details.email : "";
  await writeReferral(store, {
    ref: invoice,
    pi,
    aff,
    at: typeof row.created === "number" ? row.created : Math.floor(Date.now() / 1000),
    product: meta.product ?? "",
    title: (meta.title ?? "").slice(0, 200),
    base: Math.max(0, total - tax),
    total,
    currency: readCurrencyCode(row.currency),
    rate,
    self: await isSelf(store, aff, buyer),
    promotion: affiliatePromotionFrom(meta) ?? undefined,
    how: "recurring",
  });
}

/**
 * Puts a membership's affiliate on its subscription, as a checkout whose link read does (lib/store-checkout.ts), so
 * its renewals earn (recurringReferrals), and credits its first payment (creditFirstPayment). The change is one
 * idempotent request; an answer that is lost, or refused (the same key with another share answers 400), is checked
 * by reading the subscription back: the affiliate on it is a change made. Not known, it throws and is read again.
 * False when there is nothing to put (no renewals in the program at the sale, or a share of 0); null when the share
 * at the sale is not known.
 */
async function creditMembership(store: Store, row: SessionLike & { id: string }, affiliate: Affiliate, pending: Pending, deadline?: number): Promise<boolean | null> {
  const meta = row.metadata ?? {};
  const months = pending.months ?? store.affiliates.recurring;
  const rate = saleShare(pending, meta.product ?? "", affiliate.rate);
  if (rate === null) return null;
  if (months <= 0 || rate <= 0) return false;
  const subscription = typeof row.subscription === "string" ? row.subscription : "";
  if (!/^sub_[A-Za-z0-9]{3,250}$/.test(subscription) || !store.stripeAccountId) throw new StripeUnknownError("a membership's subscription");
  const at = typeof row.created === "number" ? row.created : Math.floor(Date.now() / 1000);
  const body = new URLSearchParams({
    "metadata[via]": affiliate.id,
    "metadata[via_rate]": String(rate),
    "metadata[via_months]": String(months),
    "metadata[via_at]": String(at),
  });
  let put = false;
  try {
    const answer = await onAccount("POST", store.stripeAccountId, `/subscriptions/${subscription}`, body, undefined, `nimbus-aff-pending-sub:${row.id}`, pendingWait(deadline));
    const kept = answer.metadata as Record<string, unknown> | null | undefined;
    put = answer.id === subscription && kept?.via === affiliate.id && kept?.via_rate === String(rate);
  } catch (error) {
    console.error("putting an affiliate on a membership's subscription did not answer; read back", row.id, error instanceof Error ? error.message : "");
  }
  if (!put && (await subscriptionVia(store, subscription, deadline)).via !== affiliate.id) throw new StripeUnknownError("a membership's subscription changed");
  await creditFirstPayment(store, row, affiliate.id, rate, deadline);
  return true;
}

/** A booking's lead where the store pays per booked call, as the link would have written it: true once written (or not owed). */
async function pendingLead(store: Store, row: SessionLike & { id: string }, aff: string): Promise<boolean> {
  const meta = row.metadata ?? {};
  const end = Number(meta.end);
  const email = typeof row.customer_details?.email === "string" ? row.customer_details.email : "";
  if (meta.kind !== "call" || store.affiliates.lead.kind !== "booking" || !email || !Number.isFinite(end)) return true;
  // Read lazily: that file reads this one.
  const { recordLead } = await import("@/lib/affiliate-leads");
  const pi = typeof row.payment_intent === "string" ? row.payment_intent : "";
  const paid = typeof row.amount_total === "number" ? row.amount_total : 0;
  const result = await recordLead(store, { aff, kind: "booking", email, end: Math.floor(end / 1000), ref: row.id, pi, paid, title: meta.title ?? "" });
  // Written, written before, or not owed at all (their own booking, the program no longer paying leads): done. The
  // program's cap reached or a read that did not answer: not written, so tried again (rule 24).
  return result === "recorded" || result === "duplicate" || result === "self" || result === "off";
}

export type PendingCounts = { credited: number; none: number; waiting: number; told: number; refused: number; uncertain: number; untold: number; failed: string[] };

const countTold = (counts: PendingCounts, told: Told) => {
  if (told === "told") counts.told += 1;
  else if (told === "uncertain") counts.uncertain += 1;
  else if (told === "refused") counts.refused += 1;
  else if (told === "untold") counts.untold += 1;
  else counts.credited += 1;
};

/**
 * Every store's pending Stripe orders not decided yet, one list for the company, by when each was last read (seconds):
 * members "<store id>|<checkout>". The sweep reads it by itself (notePendingDue), so an order the day's listing no
 * longer brings (past its day, a store whose pass was cut, more checkouts than the pages read) is still decided or
 * told about. Each member leaves it once its order is decided; a member whose mark has expired leaves it too.
 */
const PENDING_DUE_KEY = "nl:aff:pend:due";
/** Orders of the list read in one run of the five-minute job, at the most. */
export const PENDING_DUE_BATCH = 20;
/** An order the listing read within this long is left to it, not read again from the list in the same run. */
const PENDING_DUE_IDLE = 600;
/** An order read within this long was read in this run already (the job runs every five minutes): not read again. */
const PENDING_READ_AGAIN = 240;

const isFinal = (mark: string) => /^(credited:[0-9a-f]{12}|none|told|uncertain|untold)$/.test(mark);

/**
 * Decides the pending links of a page of settled checkouts (lib/checkout-sweep.ts, every five minutes, whether the
 * program is on now or not: the sale was made while it was). An order is read at its first sight, and again at each
 * pass until PENDING_LINK_SECONDS after it (never past PENDING_SWEEP_SECONDS less PENDING_TELL_MARGIN after the
 * checkout opened: at that point one still unknown is told at once), against the sale's own time. Answered: credited
 * to the affiliate at the shares of the sale, through noteSession, once (HSETNX and a mark), with its offers after
 * paying, a membership's subscription and a booking's lead; read but sold at a share not known now, told at once;
 * or, nobody, left to a code, a bond or a contact as any sale is. Past the deadline it is not read any more: the
 * creator is told (tellPending), and a refused notice is tried again at the next passes, REFUSED_TRIES at most. The
 * marks of a page are read in one MGET; an order is counted in `failed` when anything about it did not read. Every
 * order not decided stays on the company's list (PENDING_DUE_KEY); Stripe is asked nothing past `deadline` (ms).
 */
export async function notePendingLinks(
  store: Store,
  rows: SessionLike[],
  now = Math.floor(Date.now() / 1000),
  owners?: Map<string, string>,
  partners?: Affiliate[],
  send: PendingSend = sendEmailOutcome,
  deadline?: number,
): Promise<PendingCounts> {
  const counts: PendingCounts = { credited: 0, none: 0, waiting: 0, told: 0, refused: 0, uncertain: 0, untold: 0, failed: [] };
  if (!store.statsId || !isRedisConfigured()) return counts;
  const statsId = store.statsId;
  const handles = saleHandles(store);
  const marked = rows.filter(
    (row): row is SessionLike & { id: string } =>
      typeof row.id === "string" && isSettled(row) && handles.has(row.metadata?.store ?? "") && typeof row.metadata?.[VIA_PENDING_META] === "string",
  );
  if (!marked.length) return counts;
  // Each order's mark, and when the sweep last read it (its score on the company's list), in one round trip.
  const lastRead = store.sid ? marked.map((row) => ["ZSCORE", PENDING_DUE_KEY, `${store.sid}|${row.id}`]) : [];
  const reply = repliesFor(await redisPipeline([["MGET", ...marked.map((row) => pendingKey(statsId, row.id))], ...lastRead]), 1 + lastRead.length);
  const marks = reply ? repliesFor(reply[0], marked.length) : null;
  if (!reply || !marks) {
    counts.failed.push(...marked.map((row) => row.id));
    return counts;
  }
  for (const [i, row] of marked.entries()) {
    const mark = marks[i];
    // Read already in this run (through the company's list, before the store's listing): not read twice, so a
    // refused notice is tried once a run (REFUSED_TRIES) and a read is never paid for twice.
    const readAt = store.sid ? Number(reply[1 + i]) : NaN;
    if (reply[1 + i] !== null && Number.isFinite(readAt) && readAt > now - PENDING_READ_AGAIN && readAt <= now) continue;
    const final = await notePendingOne(store, row, mark, now, counts, owners, partners, send, deadline).catch((error: unknown) => {
      counts.failed.push(row.id);
      console.error("a pending affiliate link was left for the next run", row.id, error instanceof Error ? error.message : "");
      return false;
    });
    // On the company's list while not decided, last read now; off it once decided. Best effort: the listing still
    // brings it for its day, and a member left behind leaves once its mark has expired.
    if (store.sid) {
      const member = `${store.sid}|${row.id}`;
      await redisPipeline([final ? ["ZREM", PENDING_DUE_KEY, member] : ["ZADD", PENDING_DUE_KEY, now, member], ["EXPIRE", PENDING_DUE_KEY, PENDING_MARK_SECONDS]]).catch((error) =>
        console.error("keeping a pending affiliate link on the sweep's list failed", row.id, error instanceof Error ? error.message : ""),
      );
    }
  }
  return counts;
}

/** One pending order of notePendingLinks; true once it is decided for good (its mark final). */
async function notePendingOne(
  store: Store,
  row: SessionLike & { id: string },
  mark: unknown,
  now: number,
  counts: PendingCounts,
  owners: Map<string, string> | undefined,
  partners: Affiliate[] | undefined,
  send: PendingSend,
  deadline: number | undefined,
): Promise<boolean> {
  const statsId = store.statsId as string;
  const meta = row.metadata ?? {};
  const raw = meta[VIA_PENDING_META];
  const once = row.mode === undefined || row.mode === "payment";
  const finalNow = async () => isFinal((await readPendingMark(statsId, row.id)) ?? "");
  if (mark !== null && typeof mark !== "string") {
    counts.failed.push(row.id);
    return false;
  }
  if (typeof mark === "string" && isFinal(mark)) return true;
  if (mark?.startsWith("tell:")) {
    // A notice still due: tried again, never read again.
    const why = mark.slice(5) as TellWhy;
    countTold(counts, await tellPending(store, row.id, raw, TELL_WHYS.includes(why) ? why : "unread", send));
    return finalNow();
  }
  const step = mark?.match(/^(offers|lead):([0-9a-f]{12}):(\d+)$/) ?? null;
  const seenAt = mark === null ? now : step ? Number(step[3]) : mark.startsWith("seen:") ? Number(mark.slice(5)) : NaN;
  if (!Number.isFinite(seenAt)) {
    counts.failed.push(row.id);
    return false;
  }
  if (mark === null) await writePendingMark(statsId, row.id, `seen:${now}`);
  const at = typeof row.created === "number" ? row.created : now;
  const lastCall = at + PENDING_SWEEP_SECONDS - PENDING_TELL_MARGIN;
  const due = Math.min(seenAt + PENDING_LINK_SECONDS, lastCall);
  if (step) {
    // Credited already: its offers or its lead are what is left.
    const aff = step[2];
    if (step[1] === "offers") {
      // Offers that still cannot be read past the deadline: the creator is told, the sale itself staying credited;
      // never retried for ever. Before it, or with the pass's time spent, read again at the next pass.
      const read = await creditOffersOf(store, row, aff, deadline).then(
        () => true,
        (error: unknown) => {
          if (error instanceof PassTimeSpent || now < due) throw error;
          return false;
        },
      );
      if (!read) {
        countTold(counts, await tellPending(store, row.id, raw, "offers", send));
        return finalNow();
      }
    }
    const doneNow = await pendingLead(store, row, aff);
    if (doneNow) {
      await writePendingMark(statsId, row.id, `credited:${aff}`);
      counts.credited += 1;
      return true;
    }
    if (step[1] === "offers") await writePendingMark(statsId, row.id, `lead:${aff}:${seenAt}`);
    if (now >= due) {
      countTold(counts, await tellPending(store, row.id, raw, "lead", send));
      return finalNow();
    }
    counts.waiting += 1;
    return false;
  }
  // Past the deadline, after at least one read: told, never read again; a membership's subscription read back first.
  if (mark !== null && now >= due) {
    if (!once) return tellMembership(store, row, raw, counts, send, deadline);
    countTold(counts, await tellPending(store, row.id, raw, "unread", send));
    return finalNow();
  }
  const outcome = await decidePending(store, raw, at);
  if (outcome.kind === "unknown") {
    // Read once now and still unknown, with the checkout about to leave the sweep's day: told now.
    if (now >= lastCall) {
      countTold(counts, await tellPending(store, row.id, raw, once ? "unread" : "membership", send));
      return finalNow();
    }
    counts.waiting += 1;
    return false;
  }
  // A membership whose subscription already carries an affiliate (a pass that put it, then failed on its first invoice)
  // is credited, its first payment with it, never told otherwise on a decision read again (Claude 1's money review of
  // #3479, MEDIUM 2): its renewals are credited in the book from the subscription, so a notice that no commission is
  // counted would have the creator pay it twice. A subscription that does not answer throws: the order waits.
  if (!once && (outcome.kind === "share" || outcome.kind === "own" || outcome.kind === "none") && (await carriesAffiliate(store, row, deadline))) {
    return tellMembership(store, row, raw, counts, send, deadline);
  }
  if (outcome.kind === "share" || outcome.kind === "own") {
    // Read, but sold at a share not known now, or to a buyer who may be the affiliate: it will not become known, so
    // the creator is told at once.
    countTold(counts, await tellPending(store, row.id, raw, outcome.kind, send));
    return finalNow();
  }
  const rest = Object.fromEntries(Object.entries(meta).filter(([key]) => key !== VIA_PENDING_META));
  if (outcome.kind === "none") {
    // Nobody's link: the sale is any other sale.
    if (once) await noteSession(store, { ...row, metadata: rest }, owners, partners);
    await writePendingMark(statsId, row.id, "none");
    counts.none += 1;
    return true;
  }
  const aff = outcome.affiliate.id;
  if (!once) {
    // A membership or a payment plan: the affiliate goes on its subscription, its first payment credited now.
    const put = await creditMembership(store, row, outcome.affiliate, outcome.pending, deadline);
    if (put === null) {
      countTold(counts, await tellPending(store, row.id, raw, "share", send));
      return finalNow();
    }
    await writePendingMark(statsId, row.id, put ? `credited:${aff}` : "none");
    if (put) counts.credited += 1;
    else counts.none += 1;
    return true;
  }
  // Credited as a link that read would have, at the shares of the sale; one that earns nothing leaves the sale to a
  // code, a bond or a contact.
  const credit = creditedMeta(rest, outcome.affiliate, outcome.pending);
  if (!credit) {
    countTold(counts, await tellPending(store, row.id, raw, "share", send));
    return finalNow();
  }
  await noteSession(store, { ...row, metadata: credit.earns ? credit.meta : rest }, owners, partners);
  if (!credit.earns) {
    await writePendingMark(statsId, row.id, "none");
    counts.none += 1;
    return true;
  }
  // The offers follow it from here (creditedTo), before the ones already paid are read: none is missed in between.
  await writePendingMark(statsId, row.id, `offers:${aff}:${seenAt}`);
  await creditOffersOf(store, row, aff, deadline);
  if (!(await pendingLead(store, row, aff))) {
    await writePendingMark(statsId, row.id, `lead:${aff}:${seenAt}`);
    counts.waiting += 1;
    return false;
  }
  await writePendingMark(statsId, row.id, `credited:${aff}`);
  counts.credited += 1;
  return true;
}

/** Whether a membership's subscription already names an affiliate (subscriptionVia); one with no subscription, none. */
async function carriesAffiliate(store: Store, row: SessionLike & { id: string }, deadline: number | undefined): Promise<boolean> {
  const subscription = typeof row.subscription === "string" ? row.subscription : "";
  if (!/^sub_[A-Za-z0-9]{3,250}$/.test(subscription) || !store.stripeAccountId) return false;
  return AFFILIATE_ID_PATTERN.test((await subscriptionVia(store, subscription, deadline)).via);
}

/**
 * A membership past its deadline: its subscription read back first. The affiliate on it: the change was made (an
 * answer lost), so it is credited, its first payment with it. Nobody on it: told it is not credited. Not answered:
 * told only that it could not be confirmed, never that it is not credited (rule 24).
 */
async function tellMembership(store: Store, row: SessionLike & { id: string }, raw: unknown, counts: PendingCounts, send: PendingSend, deadline: number | undefined): Promise<boolean> {
  const statsId = store.statsId as string;
  const subscription = typeof row.subscription === "string" ? row.subscription : "";
  let on: { via: string; rate: string } | null = null;
  // The pass's time spent is not Stripe failing to answer: it is thrown, and the order waits for the next pass.
  const notTimeSpent = <T>(error: unknown): T | null => {
    if (error instanceof PassTimeSpent) throw error;
    return null;
  };
  if (/^sub_[A-Za-z0-9]{3,250}$/.test(subscription) && store.stripeAccountId) {
    on = await subscriptionVia(store, subscription, deadline).catch(notTimeSpent<{ via: string; rate: string }>);
  } else {
    on = { via: "", rate: "" };
  }
  if (on && AFFILIATE_ID_PATTERN.test(on.via) && /^\d{1,3}(\.\d+)?$/.test(on.rate)) {
    // On the subscription, so its renewals are credited; its first payment too, unless its invoice still names no
    // payment at the deadline: then the creator is told that one is not counted, never left untold (rule 24).
    const first = await creditFirstPayment(store, row, on.via, Number(on.rate), deadline).then(() => true, notTimeSpent<boolean>);
    if (!first) {
      countTold(counts, await tellPending(store, row.id, raw, "first", send));
      return isFinal((await readPendingMark(statsId, row.id)) ?? "");
    }
    await writePendingMark(statsId, row.id, `credited:${on.via}`);
    counts.credited += 1;
    return true;
  }
  countTold(counts, await tellPending(store, row.id, raw, on ? "membership" : "unsure", send));
  return isFinal((await readPendingMark(statsId, row.id)) ?? "");
}

/**
 * The sweep's own pass over the company's list of pending Stripe orders (PENDING_DUE_KEY): at most PENDING_DUE_BATCH
 * not read by a store's listing for PENDING_DUE_IDLE, each read again from Stripe (its checkout, by GET) and decided
 * as notePendingLinks does. One whose store is gone, or whose mark has expired, leaves the list; one that does not
 * read stays for the next run. Stripe is asked nothing past `deadline` (ms). Returns how many did not read.
 */
export async function notePendingDue(now = Math.floor(Date.now() / 1000), deadline?: number, send: PendingSend = sendEmailOutcome): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const read = repliesFor(await redisPipeline([["ZRANGEBYSCORE", PENDING_DUE_KEY, "-inf", now - PENDING_DUE_IDLE, "LIMIT", 0, PENDING_DUE_BATCH]]), 1);
  const members = read ? stringList(read[0]) : null;
  if (!members) throw new UnknownReplyError("the pending affiliate links' list");
  let failed = 0;
  for (const member of members) {
    const [sid, session] = member.split("|");
    try {
      // Read exactly (rule 24; Claude 4 on #3479): only a store answered for sure as absent takes its order off the
      // list; one that does not read is kept for the next run, never dropped as gone.
      const found = sid ? await storeForIdExactly(sid) : "none";
      if (found === "unknown") throw new UnknownReplyError("the store of a pending affiliate link");
      const store = found === "none" ? null : found;
      const valid = Boolean(store?.statsId && store.stripeAccountId && /^cs_[A-Za-z0-9_]{3,250}$/.test(session ?? ""));
      const mark = valid ? await readPendingMark(store!.statsId as string, session) : null;
      // Its store gone, or decided already: off the list.
      if (!valid || (mark !== null && isFinal(mark))) {
        await redisPipeline([["ZREM", PENDING_DUE_KEY, member]]);
        continue;
      }
      let row: Record<string, unknown> | null = null;
      try {
        row = await onAccount("GET", store!.stripeAccountId as string, `/checkout/sessions/${session}`, undefined, undefined, undefined, pendingWait(deadline));
        if (row.id !== session) throw new StripeUnknownError("a pending order's checkout");
      } catch (error) {
        // Its mark expired (two days undecided) and its checkout does not read either: the creator is told, with
        // what is known, before it leaves the list; never dropped untold. Otherwise read again at the next run.
        if (mark !== null || error instanceof PassTimeSpent) throw error;
        await tellPending(store!, session, undefined, "unread", send);
        if (isFinal((await readPendingMark(store!.statsId as string, session)) ?? "")) await redisPipeline([["ZREM", PENDING_DUE_KEY, member]]);
        continue;
      }
      const counts = await notePendingLinks(store!, [row as SessionLike], now, undefined, undefined, send, deadline);
      if (counts.failed.length) failed += 1;
    } catch (error) {
      failed += 1;
      await redisPipeline([["ZADD", PENDING_DUE_KEY, now, member]]).catch(() => undefined);
      console.error("a pending affiliate link on the sweep's list was left for the next run", member, error instanceof Error ? error.message : "");
    }
  }
  return failed;
}

/** The PayPal orders whose affiliate link waits to be decided, by when they are next due (seconds). */
const paypalPendingKey = (statsId: string) => `nl:aff:pend:pp:${statsId}`;

/** PayPal orders with a pending link the five-minute sweep tries in one run of a store, at the most. */
export const PAYPAL_PENDING_BATCH = 10;

/** Keeps a PayPal order on the list of pending links, due at the next pass; the list lasts as a mark does. */
async function paypalDue(statsId: string, order: string, at: number): Promise<void> {
  const key = paypalPendingKey(statsId);
  const replies = repliesFor(await redisPipeline([["ZADD", key, at, order], ["EXPIRE", key, PENDING_MARK_SECONDS]]), 2);
  if (!replies || countOf(replies[0]) === null) throw new UnknownReplyError("the PayPal orders whose affiliate link is pending");
}

async function paypalDone(statsId: string, order: string): Promise<void> {
  await redisPipeline([["ZREM", paypalPendingKey(statsId), order]]);
}

/**
 * A PayPal order's pending link (owner's decision 6), as notePendingLinks decides a Stripe one, whether the program
 * is on now or not: put on the store's list first, so whatever fails after leaves it there for the sweep's next pass
 * (notePayPalPendings); read at its hand-over against the time it was paid, and again until PENDING_LINK_SECONDS after
 * it, credited once at the share of the sale, or nobody's; read but sold at a share not known now, or past the
 * deadline, the creator is told with the same retries. Off the list once decided.
 */
async function settlePayPalPending(store: Store, paid: Paid, title: string, now: number, send: PendingSend): Promise<void> {
  const statsId = store.statsId as string;
  const raw = paid.meta?.[VIA_PENDING_META];
  const ref = `paypal:${paid.order}`;
  await paypalDue(statsId, paid.order, now);
  const mark = await readPendingMark(statsId, ref);
  if (mark !== null && isFinal(mark)) return paypalDone(statsId, paid.order);
  const tell = async (why: TellWhy) => {
    const told = await tellPending(store, ref, raw, why, send);
    if (told !== "refused") await paypalDone(statsId, paid.order);
  };
  if (mark?.startsWith("tell:")) return tell(mark === "tell:share" ? "share" : mark === "tell:own" ? "own" : "unread");
  // Read at its hand-over first (seen:0 marks that it was), then told past the deadline.
  if (mark === "seen:0" && now - paid.at >= PENDING_LINK_SECONDS) return tell("unread");
  const outcome = await decidePending(store, raw, paid.at);
  if (outcome.kind === "unknown") {
    if (mark === null) await writePendingMark(statsId, ref, "seen:0");
    return;
  }
  if (outcome.kind === "share" || outcome.kind === "own") return tell(outcome.kind);
  const share = outcome.kind === "credit" ? saleShare(outcome.pending, paid.product, outcome.affiliate.rate) : 0;
  if (share === null) return tell("share");
  const rate = share;
  if (outcome.kind === "credit" && rate > 0) {
    const sale = { ref, pi: paypalPaymentId(paid.capture), at: paid.at, product: paid.product, title: title.slice(0, 200), base: paid.cents, total: paid.cents, currency: readCurrencyCode(paid.currency) };
    await writeReferral(store, { ...sale, aff: outcome.affiliate.id, rate, self: await isSelf(store, outcome.affiliate.id, paid.email), promotion: affiliatePromotionFrom(paid.meta) ?? undefined, how: "click" });
    await rememberBuyer(store, paid.email, outcome.affiliate.id, store.affiliates.rule).catch((error) => console.error("remembering an affiliate's buyer failed", error));
  }
  await writePendingMark(statsId, ref, outcome.kind === "credit" && rate > 0 ? `credited:${outcome.affiliate.id}` : "none");
  await paypalDone(statsId, paid.order);
}

/**
 * The five-minute sweep's pass over a store's PayPal orders whose link is pending (lib/checkout-sweep.ts): at most
 * PAYPAL_PENDING_BATCH due ones, oldest first, each settled as at its hand-over, whether the program is on now or not.
 * One whose paid record is gone leaves the list; one that does not read waits for the next pass. Returns how many
 * did not read.
 */
export async function notePayPalPendings(store: Store, now = Math.floor(Date.now() / 1000), send: PendingSend = sendEmailOutcome): Promise<number> {
  if (!store.statsId || !store.paypalSeller || !isRedisConfigured()) return 0;
  const statsId = store.statsId;
  const read = repliesFor(await redisPipeline([["ZRANGEBYSCORE", paypalPendingKey(statsId), "-inf", now, "LIMIT", 0, PAYPAL_PENDING_BATCH]]), 1);
  const orders = read ? stringList(read[0]) : null;
  if (!orders) throw new UnknownReplyError("the PayPal orders whose affiliate link is pending");
  let failed = 0;
  for (const order of orders) {
    try {
      const paid = await readPaidExact(order);
      if (paid === "unknown") throw new UnknownReplyError("a PayPal order's paid record");
      if (!paid) {
        await paypalDone(statsId, order);
        continue;
      }
      const listing = await readListing(store, paid.product).catch(() => null);
      await settlePayPalPending(store, paid, listing?.title ?? "", now, send);
    } catch (error) {
      failed += 1;
      console.error("a PayPal order's pending affiliate link was left for the next run", order, error instanceof Error ? error.message : "");
    }
  }
  return failed;
}

/** The share an offer after paying earns the affiliate the order came through. */
export async function funnelRate(store: Store, affId: string, productId: string): Promise<number> {
  if (!affiliatesOn(store)) return 0;
  const affiliate = await readAffiliate(store, affId);
  if (affiliate?.status !== "approved") return 0;
  return commissionRate(store.affiliates, productId, affiliate.rate);
}

async function writeReferral(store: Store, referral: Referral): Promise<void> {
  if (!store.statsId || !isRedisConfigured()) return;
  // Once per sale, whichever of the thanks page and the five-minute job is
  // first, counted in the store's room at what it really adds (lib/order-data.ts).
  await orderWrite(store, [["HSETNX", salesKey(store.statsId), referral.ref, JSON.stringify(referral)]]);
}

/**
 * Writes down every partner's share of one sale.
 *
 * Called for every settled sale of the store, not only the ones an affiliate
 * brought — a partner shares in the product, so the buyer's route to it is
 * beside the point. Each line is written once per sale per partner, so the
 * thanks page and the five-minute sweep can both call this and the second one
 * changes nothing.
 *
 * A sale of a product nobody shares in writes nothing and costs one read of
 * the programme's people, which is why the caller passes `partners` in when it
 * is looking at a page of sales at a time.
 */
export async function notePartners(
  store: Store,
  sale: { ref: string; pi: string; at: number; product: string; title: string; base: number; total: number; currency: string; buyer: string },
  partners?: Affiliate[],
): Promise<void> {
  if (!store.statsId || !isRedisConfigured() || !sale.ref || !sale.product) return;
  const holders = (partners ?? (await listAffiliates(store))).filter(
    (a) => a.status === "approved" && shareOn(a.share, sale.product) > 0,
  );
  if (!holders.length) return;
  const buyer = sale.buyer ? normaliseEmail(sale.buyer) : "";
  const commands: (string | number)[][] = [];
  for (const partner of holders) {
    const earning: PartnerEarning = {
      ref: sale.ref,
      pi: sale.pi,
      aff: partner.id,
      at: sale.at,
      product: sale.product,
      title: sale.title.slice(0, 200),
      base: sale.base,
      total: sale.total,
      currency: readCurrencyCode(sale.currency),
      percent: shareOn(partner.share, sale.product),
      // A 50% partner buying their own product at 50% off is not a sale.
      self: Boolean(buyer) && normaliseEmail(partner.email) === buyer,
    };
    commands.push(["HSETNX", sharesKey(store.statsId), `${sale.ref}:${partner.id}`, JSON.stringify(earning)]);
  }
  await orderWrite(store, commands);
}

/**
 * A sale paid with PayPal (lib/paypal-sales.ts), credited as a Stripe one is
 * (added 13 October 2026): to the affiliate whose link the visit carried, at
 * the share it had when the buyer paid, and to every partner who shares in
 * the product. Once per order, whichever of the return page and the sweep
 * hands it over first. A refund in full on PayPal takes it back in the book
 * (readBook, through readPayPalRefundsWithCoverage).
 */
export async function creditPayPalSale(store: Store, paid: Paid, title: string, send: PendingSend = sendEmailOutcome): Promise<void> {
  if (!store.statsId || !isRedisConfigured()) return;
  const sale = {
    ref: `paypal:${paid.order}`,
    pi: paypalPaymentId(paid.capture),
    at: paid.at,
    product: paid.product,
    title: title.slice(0, 200),
    base: paid.cents,
    total: paid.cents,
    currency: readCurrencyCode(paid.currency),
  };
  if (paid.via && affiliatesOn(store) && paid.via.rate > 0) {
    await writeReferral(store, { ...sale, aff: paid.via.aff, rate: paid.via.rate, self: await isSelf(store, paid.via.aff, paid.email), promotion: affiliatePromotionFrom(paid.meta) ?? undefined, how: "click" });
    await rememberBuyer(store, paid.email, paid.via.aff, store.affiliates.rule).catch((error) => console.error("remembering an affiliate's buyer failed", error));
  }
  // A link the checkout could not read (owner's decision 6) is put on the sweep's list first (Claude 1's money review
  // of #3479, MEDIUM 1): the partners' shares failing on an unknown read no longer drops it, and the hand-over that
  // logs that failure marks the order handed over with its link still due. Then the partners, whatever the link; then
  // the link read again at the hand-over against the time it was paid, and, still unknown, kept for the sweep's next
  // passes (notePayPalPendings), as a Stripe order is; whether the program is on now or not.
  const pending = !paid.via && typeof paid.meta?.[VIA_PENDING_META] === "string";
  const now = Math.floor(Date.now() / 1000);
  // Each step runs whatever the one before it answered, and the first failure is thrown at the end, so the hand-over
  // logs it: the sweep's list not written never drops the partners' shares (cloud G on #3479), and the partners
  // failing never drops the link (settlePayPalPending writes the sweep's list again itself).
  let first: unknown = null;
  const keep = (error: unknown) => {
    first ??= error;
  };
  if (pending) await paypalDue(store.statsId, paid.order, now).catch(keep);
  await notePartners(store, { ...sale, buyer: paid.email }).catch(keep);
  if (pending) await settlePayPalPending(store, paid, title, now, send).catch(keep);
  if (first) throw first;
}

async function isSelf(store: Store, aff: string, buyer: string): Promise<boolean> {
  if (!buyer) return false;
  const affiliate = await readAffiliate(store, aff);
  return Boolean(affiliate) && canonicalEmail(affiliate!.email) === canonicalEmail(buyer);
}

/**
 * One inbox however it is written: lower case, without a "+" tag, and for
 * Gmail without its dots, which Gmail itself ignores. Two addresses that
 * come out the same here reach the same person.
 */
export function canonicalEmail(raw: string): string {
  const email = normaliseEmail(raw);
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  let name = email.slice(0, at).split("+")[0];
  // "example.com." is the same domain as "example.com".
  let domain = email.slice(at + 1).replace(/\.+$/, "");
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") name = name.replace(/\./g, "");
  return `${name}@${domain}`;
}

type SessionLike = {
  id?: unknown;
  mode?: unknown;
  status?: unknown;
  payment_status?: unknown;
  created?: unknown;
  amount_total?: unknown;
  amount_subtotal?: unknown;
  currency?: unknown;
  total_details?: { amount_tax?: unknown } | null;
  payment_intent?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
  /** The codes typed into it, which can credit an affiliate on their own. */
  discounts?: unknown;
  /** The buyer's customer, whose payments hold an offer taken after paying; a membership's subscription and first invoice. */
  customer?: unknown;
  subscription?: unknown;
  invoice?: unknown;
};

/**
 * Writes down a settled checkout that came through an affiliate's link.
 * Anything else is left alone, so it is safe to call on every checkout.
 *
 * `owners` is the store's given-away discount codes (lib/affiliate-codes.ts),
 * passed in by a caller looking at many orders so they are read once. Left
 * out, they are read here. An order with no affiliate in its metadata is
 * credited from the code typed into it, if that code was given to somebody —
 * which is how a sale made on a podcast or from a stage earns anything at all.
 */
export async function noteSession(
  store: Store,
  session: SessionLike,
  owners?: Map<string, string>,
  partners?: Affiliate[],
): Promise<void> {
  const meta = session.metadata ?? {};
  if (typeof session.id !== "string") return;
  if (session.mode !== undefined && session.mode !== "payment") return;
  if (!isSettled(session)) return;
  const handles = saleHandles(store);
  if (!handles.has(meta.store ?? "")) return;

  const total = typeof session.amount_total === "number" ? session.amount_total : 0;
  const tax = typeof session.total_details?.amount_tax === "number" ? session.total_details.amount_tax : 0;
  const pi =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent && typeof session.payment_intent === "object" && typeof (session.payment_intent as { id?: unknown }).id === "string"
        ? ((session.payment_intent as { id: string }).id)
        : "";
  const buyer = typeof session.customer_details?.email === "string" ? session.customer_details.email : "";
  const base = Math.max(0, total - tax);
  const at = typeof session.created === "number" ? session.created : Math.floor(Date.now() / 1000);
  const currency = readCurrencyCode(session.currency);

  // Partners first, and whatever happens next. A partner shares in the
  // product, so how the buyer arrived is beside the point — and this is the
  // one part that has to run for a sale no affiliate brought at all, which is
  // most of them (lib/partner-share.ts).
  await notePartners(
    store,
    { ref: session.id, pi, at, product: meta.product ?? "", title: meta.title ?? "", base, total, currency, buyer },
    partners,
  ).catch((error) => console.error("noting a partner's share failed", error));

  // Then the affiliate. The click first: a buyer who followed a link and then
  // typed a code they saw elsewhere still belongs to the affiliate whose link
  // they followed.
  let aff = meta.via ?? "";
  let own: number | null = null;
  // How the sale found its affiliate, which the creator's book and the
  // affiliate's own page both say out loud.
  let how: Credit = "click";
  if (!AFFILIATE_ID_PATTERN.test(aff)) {
    if (meta[VIA_PENDING_META] !== undefined) return; // a pending click: notePendingLinks decides
    // Then the code the buyer typed, which is the only trace a sale made on a
    // podcast or from a stage leaves at all (lib/affiliate-codes.ts). Read only
    // for a sale that carries a code: a sale with none never waits on that read.
    const given = promoCodesOn(session).length ? (owners ?? (await codeOwners(store))) : new Map<string, string>();
    let found = affiliateForCodes(session, given);
    how = "code";
    // And last, the buyer themselves: somebody who was credited to an
    // affiliate once and whose creator asked for them to stay credited
    // (lib/affiliate-bond.ts). No cookie, no window, any device.
    if (!found && buyer) {
      found = await bondFor(store, buyer);
      how = "buyer";
    }
    // Then the affiliate who brought this buyer as a confirmed lead, where the
    // creator asked for that (lib/affiliate-leads.ts contactFor). Read lazily:
    // that file reads this one.
    if (!found && buyer && creditsContacts(store.affiliates)) {
      const { contactFor } = await import("@/lib/affiliate-leads");
      // Only a lead confirmed before this checkout was opened, and never the
      // lead this very checkout made (a paid booking is one): a sale written
      // down again later must not reach back to a lead that came after it.
      found = await contactFor(store, buyer, at, session.id);
      how = "contact";
    }
    if (!found) return;
    // A code, a bond or a contact only ever credits somebody the creator approves today.
    // An affiliate they declined or removed keeps their record — it is
    // history — and earns nothing more through either.
    const who = await readAffiliate(store, found);
    if (who?.status !== "approved") return;
    aff = found;
    own = who.rate;
  }
  // Through a link, the shares were worked out and written onto the order when
  // the buyer started paying, and those are the ones that stand — the creator
  // changing a share afterwards does not reach back into a sale already made.
  // Through a code there was no such moment, because nothing knew an affiliate
  // was involved until the code was typed, so the shares are the ones the
  // programme holds now. The affiliate's page says which of the two it was.
  let rate = how === "click" ? Number(meta.via_rate) || 0 : commissionRate(store.affiliates, meta.product ?? "", own);
  // Each product ticked at checkout earns its own product's share, none when
  // the creator left that product out: the one rate kept for the sale is the
  // shares together, each weighed by its part of the whole.
  const subtotal = typeof session.amount_subtotal === "number" ? session.amount_subtotal : 0;
  if (subtotal > 0 && base > 0) {
    let blended = 0;
    let taken = 0;
    for (const { key, id } of bumpsFromMeta(meta)) {
      const cents = Number(meta[`${key}_cents`]);
      const share = how === "click" ? Number(meta[`${key}_rate`]) : commissionRate(store.affiliates, id, own);
      if (!Number.isFinite(cents) || cents <= 0 || !Number.isFinite(share)) continue;
      const part = Math.min(1 - taken, cents / subtotal);
      blended += share * part;
      taken += part;
    }
    if (taken > 0) rate = Math.round((rate * (1 - taken) + blended) * 100) / 100;
  }
  await writeReferral(store, {
    ref: session.id,
    pi,
    aff,
    at,
    product: meta.product ?? "",
    title: (meta.title ?? "").slice(0, 200),
    base,
    total,
    currency,
    rate,
    self: await isSelf(store, aff, buyer),
    promotion: affiliatePromotionFrom(meta) ?? undefined,
    how,
  });

  // And the buyer stays with them, where the creator asked for that. Written
  // after the sale, so a bond that fails costs a future commission rather than
  // one already earned (lib/affiliate-bond.ts).
  if (buyer) {
    await rememberBuyer(store, buyer, aff, store.affiliates.rule).catch((error) =>
      console.error("remembering an affiliate's buyer failed", error),
    );
  }
}

/** Writes down a paid offer after paying that follows an affiliate's sale. */
export async function noteCharge(store: Store, pi: Record<string, unknown>): Promise<void> {
  const meta = (pi.metadata ?? {}) as Record<string, string>;
  if (pi.status !== "succeeded" || typeof pi.id !== "string") return;
  const amount = typeof pi.amount === "number" ? pi.amount : 0;
  const buyer = typeof pi.receipt_email === "string" ? pi.receipt_email : "";
  const at = typeof pi.created === "number" ? pi.created : Math.floor(Date.now() / 1000);

  // A partner shares in the product whether or not an affiliate's link was
  // involved, and an offer taken after paying is a sale of a product.
  await notePartners(store, {
    ref: pi.id,
    pi: pi.id,
    at,
    product: meta.product ?? "",
    title: `${(meta.title ?? "").slice(0, 180)} (added after paying)`,
    // A one-click charge never carries tax: the whole amount is the base.
    base: amount,
    total: amount,
    currency: readCurrencyCode(pi.currency),
    buyer,
  }).catch((error) => console.error("noting a partner's share failed", error));

  // An offer on an order whose link was pending follows that order once it is credited (owner's decision 6).
  if (!AFFILIATE_ID_PATTERN.test(meta.via ?? "") && meta.kind === "upsell" && typeof meta.parent === "string") return notePendingOffer(store, pi, meta.parent);
  const aff = meta.via ?? "";
  if (!AFFILIATE_ID_PATTERN.test(aff)) return;
  await writeReferral(store, {
    ref: pi.id,
    pi: pi.id,
    aff,
    at,
    product: meta.product ?? "",
    title: `${(meta.title ?? "").slice(0, 180)} (added after paying)`,
    // A one-click charge never carries tax: the whole amount is the base.
    base: amount,
    total: amount,
    currency: readCurrencyCode(pi.currency),
    rate: Number(meta.via_rate) || 0,
    self: await isSelf(store, aff, buyer),
    promotion: affiliatePromotionFrom(meta) ?? undefined,
    // An offer taken after paying follows the order it rides on, and that
    // order is only ever reached through a link.
    how: "click",
  });
}

// ---- The book ------------------------------------------------------------

export type LineStatus = "earned" | "partly refunded" | "refunded" | "own purchase" | LeadStatus;

export type Line = Referral & {
  /** Given back to the buyer, in cents, as Stripe says today. */
  refunded: number;
  /** What it earns now, in cents. */
  commission: number;
  status: LineStatus;
  /** For a lead (how "lead"): which, what kind, whose address, and when it can be approved. */
  lead?: LeadView;
};

/** A lead as the book shows it (lib/affiliate-lead-rules.ts). The address is masked on an affiliate's own page. */
export type LeadView = { id: string; kind: LeadKind; email: string; readyAt: number; why: LeadReason | "" };

/** A lead as one line of the book, beside the sales: its fixed amount, never a share. */
export function leadLine(settled: SettledLead): Line {
  const { lead } = settled;
  return {
    ref: `lead:${lead.id}`,
    pi: lead.pi,
    aff: lead.aff,
    at: lead.at,
    product: lead.kind === "signup" ? "" : lead.kind === "free" ? lead.ref : "",
    title: lead.title,
    base: 0,
    total: 0,
    currency: lead.currency,
    rate: 0,
    self: false,
    how: "lead",
    refunded: 0,
    commission: settled.commission,
    status: settled.status,
    lead: { id: lead.id, kind: lead.kind, email: lead.email, readyAt: settled.readyAt, why: lead.why },
  };
}

export type Row = {
  affiliate: Affiliate;
  clicks: number;
  /** Sales that still earn something. */
  sales: number;
  earned: number;
  paid: number;
  /** earned - paid; below zero when refunds came after a payout. */
  owed: number;
  /**
   * Of what is owed, the part still inside the creator's wait, and so not in
   * a batch yet. Never below zero. It is 0 for every store that set no wait,
   * which is what every store did before there was one.
   */
  waiting: number;
  /**
   * What can be paid today: owed less what is still waiting, floored at what
   * is owed so a payout made ahead of time is not counted twice. Below zero
   * when refunds landed after a payout, exactly as `owed` is.
   */
  payable: number;
  /**
   * Of what is owed, the part held for the creator to look at (`flags` says
   * why): left out of `payable`, and so of every payment, until they release
   * it. 0 for anybody not held.
   */
  held: number;
  /** Why it is held: a click from a paid search ad, or an address another affiliate shares. */
  flags: HoldFlag[];
  /** Clicks that came from a paid search ad. */
  paidClicks: number;
};

export type HoldFlag = "paid-search" | "same-address";

export type Book = {
  rows: Row[];
  lines: Line[];
  payouts: Payout[];
  /**
   * What the rows' totals are in: the store's currency. Sales and payouts in
   * another one — from before the store changed its currency — are listed
   * with their own currency and left out of the totals, because adding euros
   * to dollars gives a number that means nothing.
   */
  currency: string;
  /** How many sales and payouts are in another currency, and so not in the totals. */
  elsewhere: number;
  /** False when Stripe could not be asked about refunds and disputes, or not all of them. */
  refundsChecked: boolean;
  /** False when the invoices of memberships and plans could not all be read. */
  invoicesChecked: boolean;
};

/**
 * What has been refunded, by payment, on the creator's account, from the
 * oldest sale on the book on. Pending refunds count: the creator already
 * gave the money back.
 */
async function refundsSince(store: Store, since: number, deadline?: number): Promise<{ byIntent: Map<string, number>; complete: boolean }> {
  const byIntent = new Map<string, number>();
  if (!store.stripeAccountId) return { byIntent, complete: false };
  let after = "";
  for (let page = 0; page < REFUND_PAGES; page += 1) {
    const wait = stripeWait(deadline);
    if (wait === null) return { byIntent, complete: false };
    const listed = await onAccount(
      "GET",
      store.stripeAccountId,
      `/refunds?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
      undefined,
      undefined,
      undefined,
      wait,
    );
    const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
    for (const refund of rows) {
      if (refund.status !== "succeeded" && refund.status !== "pending") continue;
      const pi = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
      const amount = typeof refund.amount === "number" ? refund.amount : 0;
      if (pi) byIntent.set(pi, (byIntent.get(pi) ?? 0) + amount);
    }
    const last = rows[rows.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") return { byIntent, complete: true };
    after = last.id;
  }
  return { byIntent, complete: false };
}

/**
 * What chargebacks have taken, by payment, on the creator's account, from the
 * oldest sale on the book on: the disputed amount of every dispute the bank
 * is holding or the buyer won (DISPUTE_TAKES). Read beside the refunds, so a
 * sale charged back earns its affiliate nothing, as a sale refunded does.
 */
export async function disputesSince(store: Store, since: number, deadline?: number): Promise<{ byIntent: Map<string, number>; complete: boolean }> {
  const byIntent = new Map<string, number>();
  if (!store.stripeAccountId) return { byIntent, complete: false };
  let after = "";
  for (let page = 0; page < DISPUTE_PAGES; page += 1) {
    const wait = stripeWait(deadline);
    if (wait === null) return { byIntent, complete: false };
    const listed = await onAccount(
      "GET",
      store.stripeAccountId,
      `/disputes?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
      undefined,
      undefined,
      undefined,
      wait,
    );
    const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
    for (const dispute of rows) {
      if (typeof dispute.status !== "string" || !DISPUTE_TAKES.has(dispute.status)) continue;
      const raw = dispute.payment_intent;
      const pi = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "";
      const amount = typeof dispute.amount === "number" && dispute.amount > 0 ? dispute.amount : 0;
      if (pi && amount) byIntent.set(pi, (byIntent.get(pi) ?? 0) + amount);
    }
    const last = rows[rows.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") return { byIntent, complete: true };
    after = last.id;
  }
  return { byIntent, complete: false };
}

/** A sale as it stands today, after any refund. */
export function settleLine(referral: Referral, refunded: number): Line {
  const back = Math.min(Math.max(0, refunded), referral.total);
  const kept = referral.total > 0 ? Math.round((referral.base * (referral.total - back)) / referral.total) : 0;
  const status: LineStatus = referral.self
    ? "own purchase"
    : back >= referral.total && referral.total > 0
      ? "refunded"
      : back > 0
        ? "partly refunded"
        : "earned";
  return { ...referral, refunded: back, commission: referral.self ? 0 : commissionOn(kept, referral.rate), status };
}

/**
 * How big the program is, counted before it is read, so a reading that pays
 * for itself by its size (the API's affiliates, lib/api-read.ts) can take
 * what readBook will cost first: the seven records it reads whole, by their
 * entries, the PayPal refunds it reads one by one, the products it may read
 * and whether Stripe is connected. One pipeline of counts, nothing else. Null
 * when a count did not come back as one: unknown is never read as small.
 */
// Accepted race: between this count and readBook's HGETALL the records can grow for a few milliseconds and be
// read past what was paid for, bounded by how fast the store writes them.
export async function bookSizes(store: Store): Promise<BookSizes | null> {
  const stripe = Boolean(store.stripeAccountId);
  const products = productIds(store).length;
  if (!store.statsId || !isRedisConfigured()) return { kept: false, entries: 0, people: 0, leads: 0, paypalRefunds: 0, stripe, products };
  const id = store.statsId;
  const replies = await redisPipeline([
    ["HLEN", peopleKey(id)],
    ["HLEN", clicksKey(id)],
    ["HLEN", salesKey(id)],
    ["HLEN", payoutsKey(id)],
    ["HLEN", sharesKey(id)],
    ["HLEN", paidClicksKey(id)],
    ["HLEN", leadsKey(id)],
    ["ZCARD", paypalRefundedKey(id)],
  ]);
  const counts = replies.map((r) => (typeof r === "number" || (typeof r === "string" && /^\d{1,12}$/.test(r)) ? Number(r) : NaN));
  if (counts.length !== 8 || counts.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return {
    kept: true,
    entries: counts.slice(0, 7).reduce((a, b) => a + b, 0),
    people: counts[0],
    leads: counts[6],
    paypalRefunds: counts[7],
    stripe,
    products,
  };
}

/**
 * Everything the studio shows about the programme — and, filtered to one
 * person, what an affiliate sees: their clicks, the sales through their link
 * with what each earns after refunds, and what the creator says they paid.
 */
/**
 * How much the book would read, counted before it is read (4 November 2026,
 * lib/public-read-rules.ts): the fields of every hash readBook reads whole,
 * and the records it then reads one command each, PayPal's refunds and the
 * open bookings of the leads, at its caps. Eight commands whatever the size;
 * null when they cannot be counted, which reads nothing.
 */
export async function bookSize(store: Store): Promise<{ fields: number; rows: number } | null> {
  if (!store.statsId || !isRedisConfigured()) return { fields: 0, rows: 0 };
  const statsId = store.statsId;
  try {
    const replies = await redisPipeline([
      ["HLEN", peopleKey(statsId)],
      ["HLEN", clicksKey(statsId)],
      ["HLEN", salesKey(statsId)],
      ["HLEN", payoutsKey(statsId)],
      ["HLEN", sharesKey(statsId)],
      ["HLEN", paidClicksKey(statsId)],
      ["HLEN", leadsKey(statsId)],
      ["ZCARD", paypalRefundedKey(statsId)],
    ]);
    // Each count exactly (rule 24): null or a list is not 0 or a number, and one not known reads nothing.
    const counts = replies.map(countOf).filter((n): n is number => n !== null);
    if (replies.length !== 8 || counts.length !== 8) return null;
    const fields = counts.slice(0, 7).reduce((sum, n) => sum + n, 0);
    return { fields, rows: Math.min(counts[7], 500) + Math.min(counts[6], 200) };
  } catch {
    return null;
  }
}

/**
 * How long the next call to Stripe may wait before `deadline` (epoch
 * milliseconds): its full STRIPE_TIMEOUT_MS when there is none, what is left
 * otherwise, and null when less than a second is, so the read stops there
 * and what it read is incomplete.
 */
export function stripeWait(deadline: number | undefined, now = Date.now()): number | null {
  if (deadline === undefined) return STRIPE_TIMEOUT_MS;
  const left = deadline - now;
  return left < 1_000 ? null : Math.min(STRIPE_TIMEOUT_MS, Math.floor(left));
}

/**
 * The program's book, or one affiliate's (`only`). With `deadline` (epoch
 * milliseconds), Stripe is asked nothing past it, and what was not read is
 * marked incomplete (invoicesChecked, refundsChecked): the affiliate page's
 * refresh stops so (lib/affiliate-book-snapshot.ts, BOOK_READ_SECONDS).
 * With `titles: false`, a membership's or plan's payment is not named after its
 * product (its title is ""), and nothing is read for the names: for a reader
 * that prints no product, as the payout file (lib/affiliate-payouts.ts).
 */
export async function readBook(store: Store, only?: string, limits: { deadline?: number; titles?: boolean } = {}): Promise<Book> {
  if (!store.statsId || !isRedisConfigured()) return { rows: [], lines: [], payouts: [], refundsChecked: true, invoicesChecked: true, currency: store.currency, elsewhere: 0 };
  const statsId = store.statsId;
  const [people, clicks, sales, payouts, shares, paidClicks, leadsReply] = await redisPipeline([
    ["HGETALL", peopleKey(statsId)],
    ["HGETALL", clicksKey(statsId)],
    ["HGETALL", salesKey(statsId)],
    ["HGETALL", payoutsKey(statsId)],
    ["HGETALL", sharesKey(statsId)],
    ["HGETALL", paidClicksKey(statsId)],
    // Confirmed leads (lib/affiliate-leads.ts), all of them: the caps and the budget are counted across the program.
    ["HGETALL", leadsKey(statsId)],
  ]);
  // Everybody, for the checks that compare one affiliate with the others.
  const everyone = pairs(people)
    .map(([, raw]) => parseAffiliate(raw))
    .filter((a): a is Affiliate => a !== null);
  const affiliates = everyone.filter((a) => !only || a.id === only);
  // Whose sales are read: one affiliate's own, and, for their second tier,
  // those of the people who joined through their invitation link.
  const recruits = new Set(everyone.filter((a) => only && a.by?.id === only).map((a) => a.id));
  const mine = (aff: string) => !only || aff === only || recruits.has(aff);
  const clickCount = new Map(pairs(clicks).map(([id, n]) => [id, Number(n) || 0]));
  const paidCount = new Map(pairs(paidClicks).map(([id, n]) => [id, Number(n) || 0]));
  const referrals = pairs(sales)
    .map(([, raw]) => parseReferral(raw))
    .filter((r): r is Referral => r !== null && mine(r.aff));
  // A partner's standing share of a sale reads as one more Referral, credited
  // "partner" (lib/partner-share.ts). Keeping the shape means the payouts, the
  // batches, the spreadsheet and the partner's own page all work unchanged,
  // and one sale can produce several of these alongside a commission.
  const partnerLines: Referral[] = pairs(shares)
    .map(([, raw]) => parsePartnerEarning(raw))
    .filter((e): e is PartnerEarning => e !== null && (!only || e.aff === only))
    .map((e) => ({
      ref: `${e.ref}:${e.aff}`,
      pi: e.pi,
      aff: e.aff,
      at: e.at,
      product: e.product,
      title: e.title,
      base: e.base,
      total: e.total,
      currency: e.currency,
      rate: e.percent,
      self: e.self,
      how: "partner" as const,
    }));
  const paid = pairs(payouts)
    .map(([, raw]) => parsePayout(raw))
    .filter((p): p is Payout => p !== null && (!only || p.aff === only))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.at - a.at);

  // Each payment of a membership or plan sold through a link, read from its invoice.
  let invoicesChecked = true;
  let recurringLines: Referral[] = [];
  if (store.stripeAccountId && everyone.length) {
    try {
      const read = await recurringReferrals(store, everyone, Math.min(...everyone.map((a) => Math.floor(a.appliedAt / 1000))) - 86_400, limits.deadline, limits.titles !== false);
      recurringLines = read.lines.filter((r) => mine(r.aff));
      invoicesChecked = read.complete;
    } catch (error) {
      console.error("reading invoices for the affiliate book failed", error);
      invoicesChecked = false;
    }
  }
  // A payment already written down as a sale (a membership's first payment credited when its pending link was
  // confirmed, lib/affiliates.ts creditFirstPayment) is never read again from its invoice: one line, never two.
  const written = new Set(referrals.map((r) => r.ref));
  const everything = [...referrals, ...partnerLines, ...recurringLines.filter((r) => !written.has(r.ref))];
  const leads = pairs(leadsReply)
    .map(([, raw]) => parseLead(raw))
    .filter((l): l is NonNullable<typeof l> => l !== null);
  // A booking's lead is reversed by a refund in full of its booking, read with the sales' refunds.
  const bookings = leads.filter((l) => l.kind === "booking" && l.pi);
  let refunds = new Map<string, number>();
  let refundsChecked = true;
  if (everything.length || bookings.length) {
    const since = Math.min(...[...everything, ...bookings].map((r) => r.at));
    try {
      const read = store.stripeAccountId ? await refundsSince(store, since, limits.deadline) : { byIntent: new Map<string, number>(), complete: true };
      refunds = read.byIntent;
      refundsChecked = read.complete;
      // PayPal's refunds in full, named by the payment as the book names it. One with no capture id never meets its
      // sale, one in another currency than its sale's means nothing in its cents, and one whose cents are not a
      // whole positive amount, or not its sale's whole amount (a PayPal refund here is in full), would count as a
      // refund of less: each leaves what is owed unknown (refundsChecked), never a refund of nothing, so no payout
      // is made on it (rule 24, as #3189 for Stripe). So does a reading that did not cover every refund since the
      // oldest line (more listed than PAYPAL_REFUNDS_READ, or a listed one whose record is gone): a refund past the
      // cut is never paid on. A refund is in full, so the same payment listed twice counts once.
      const paypalSales = new Map<string, { currency: string; total: number }[]>();
      for (const r of everything) {
        if (r.pi.startsWith("paypal:")) paypalSales.set(r.pi, [...(paypalSales.get(r.pi) ?? []), { currency: r.currency.toLowerCase(), total: r.total }]);
      }
      const paypalSeen = new Set<string>();
      const paypal = await readPayPalRefundsWithCoverage(store.statsId, since);
      if (paypal.partial) refundsChecked = false;
      for (const r of paypal.rows) {
        const named = typeof r.capture === "string" && r.capture !== "";
        const sales = named ? paypalSales.get(paypalPaymentId(r.capture)) : undefined;
        const readable = named && typeof r.currency === "string" && Number.isSafeInteger(r.cents) && r.cents > 0;
        if (!readable || (sales ?? []).some((sale) => sale.currency !== r.currency.toLowerCase() || sale.total !== r.cents)) refundsChecked = false;
        else if (!paypalSeen.has(r.capture)) {
          paypalSeen.add(r.capture);
          refunds.set(paypalPaymentId(r.capture), (refunds.get(paypalPaymentId(r.capture)) ?? 0) + r.cents);
        }
      }
    } catch (error) {
      console.error("reading refunds for the affiliate book failed", error);
      refundsChecked = false;
    }
    // A chargeback takes the money back as a refund does (disputesSince).
    // Judged with the refunds: when either could not be read in full, what
    // is owed is not known (refundsChecked), and no payout is made on it.
    if (store.stripeAccountId) {
      try {
        const disputed = await disputesSince(store, since, limits.deadline);
        for (const [pi, cents] of disputed.byIntent) refunds.set(pi, (refunds.get(pi) ?? 0) + cents);
        refundsChecked = refundsChecked && disputed.complete;
      } catch (error) {
        console.error("reading disputes for the affiliate book failed", error);
        refundsChecked = false;
      }
    }
  }
  const settled = everything.map((r) => settleLine(r, r.pi ? refunds.get(r.pi) ?? 0 : 0));
  // Each lead as it stands: the program's caps and budget counted across every affiliate's, then only the ones asked for.
  let ends = new Map<string, number>();
  const openBookings = leads.filter((l) => l.kind === "booking" && l.state === "open" && l.ref && mine(l.aff)).slice(0, 200);
  if (openBookings.length) {
    try {
      for (const [session, move] of await readMoves(openBookings.map((l) => l.ref))) ends.set(session, Math.floor(move.e / 1000));
    } catch (error) {
      console.error("reading moved bookings for the affiliate book failed", error);
      ends = new Map();
    }
  }
  const leadLines = settleLeads(leads, Math.floor(Date.now() / 1000), (pi) => refunds.get(pi) ?? 0, ends)
    .filter((s) => !only || s.lead.aff === only)
    .map(leadLine);
  const flagsOf = holdFlags(store, everyone, paidCount);
  // A goal reached in a month adds its bonus, and a sale by somebody an
  // affiliate brought adds their second tier, both worked out from the sales
  // as they stand after refunds. Then only the one affiliate's, when it is one.
  const lines = [...settled, ...bonusLines(store, settled), ...tierLines(everyone, settled, flagsOf), ...leadLines]
    .filter((l) => !only || l.aff === only)
    .sort((a, b) => b.at - a.at);

  // A sale made less than the creator's wait ago is not payable yet, so their
  // refund window can pass before the money leaves them. `hold` is 0 for a
  // store that set none, and then `until` is now and nothing is ever waiting.
  const until = Math.floor(Date.now() / 1000) - store.affiliates.hold * 86_400;
  const rows = affiliates
    .map((affiliate): Row => {
      const own = lines.filter((l) => l.aff === affiliate.id && l.currency === store.currency);
      const earned = own.reduce((sum, l) => sum + l.commission, 0);
      const out = paid.filter((p) => p.aff === affiliate.id && p.currency === store.currency).reduce((sum, p) => sum + p.cents, 0);
      // A lead waits until the creator approves it (lib/affiliate-leads.ts decideLeads); a sale, until the store's wait has passed.
      const waiting = own.filter((l) => (l.how === "lead" ? l.status !== "approved" : l.at > until)).reduce((sum, l) => sum + l.commission, 0);
      const owed = earned - out;
      const flags = flagsOf.get(affiliate.id) ?? [];
      const payable = owed <= 0 ? owed : Math.max(0, Math.min(owed, earned - waiting - out));
      return {
        affiliate,
        clicks: clickCount.get(affiliate.id) ?? 0,
        sales: own.filter((l) => l.commission > 0 && l.how !== "bonus" && l.how !== "tier2" && l.how !== "lead").length,
        earned,
        paid: out,
        owed,
        waiting,
        // What has cleared, less what has been paid — never more than is owed
        // in all, and never a negative number of its own making: a creator who
        // has already paid past what cleared simply has nothing to pay today.
        // Owing nothing, or being owed money back after a refund, is `owed`'s
        // to say, and is carried through unchanged.
        // Held for the creator to look at: nothing of it goes into a payment until they release it.
        payable: flags.length && payable > 0 ? 0 : payable,
        held: flags.length ? Math.max(0, owed) : 0,
        flags,
        paidClicks: paidCount.get(affiliate.id) ?? 0,
      };
    })
    .sort((a, b) => b.owed - a.owed || b.affiliate.appliedAt - a.affiliate.appliedAt);
  const elsewhere =
    lines.filter((l) => l.currency !== store.currency).length + paid.filter((p) => p.currency !== store.currency).length;
  return { rows, lines, payouts: paid, refundsChecked, invoicesChecked, currency: store.currency, elsewhere };
}

/** How many invoice pages of a hundred are read when the book is opened. */
export const INVOICE_PAGES = 10;
/** The most pages of the creator's Stripe account one reading of the book waits on: invoices, refunds and disputes (lib/api-read-rules.ts, bookWork). */
export const BOOK_STRIPE_PAGES = INVOICE_PAGES + REFUND_PAGES + DISPUTE_PAGES;
const AFF_SUB_STRIPE_VERSION = "2026-08-26.dahlia";

type InvoiceLike = {
  id?: unknown;
  status?: unknown;
  amount_paid?: unknown;
  currency?: unknown;
  customer_email?: unknown;
  created?: unknown;
  status_transitions?: { paid_at?: unknown } | null;
  total_taxes?: { amount?: unknown }[] | null;
  parent?: { subscription_details?: { metadata?: Record<string, string> | null } | null } | null;
  payments?: { data?: { payment?: { payment_intent?: unknown } | null }[] } | null;
};

/** Whether a payment made at `paidAt` falls within `months` of `from`, both in seconds. */
export function withinMonths(from: number, paidAt: number, months: number): boolean {
  if (months >= RECURRING_ALWAYS) return true;
  const start = new Date(from * 1000);
  const end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()) / 1000;
  return paidAt < end;
}

/**
 * The paid invoices of this store's memberships and payment plans that were
 * sold through an affiliate's link, as Referrals: read from the creator's
 * Stripe account, pinned to one API version so their shape is known, and
 * never written down. A membership's payment counts while it falls within
 * the months agreed when it was sold; a plan's every payment counts.
 */
async function recurringReferrals(store: Store, everyone: Affiliate[], since: number, deadline?: number, named = true): Promise<{ lines: Referral[]; complete: boolean }> {
  const handles = saleHandles(store);
  const byId = new Map(everyone.map((a) => [a.id, a]));
  const found: { invoice: InvoiceLike; meta: Record<string, string> }[] = [];
  let after = "";
  let complete = false;
  for (let page = 0; page < INVOICE_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: "100", status: "paid", "created[gte]": String(Math.max(0, since)) });
    query.append("expand[]", "data.payments");
    if (after) query.set("starting_after", after);
    const wait = stripeWait(deadline);
    if (wait === null) break;
    const listed = (await onAccount("GET", store.stripeAccountId as string, `/invoices?${query}`, undefined, AFF_SUB_STRIPE_VERSION, undefined, wait)) as { data?: unknown; has_more?: unknown };
    const rows = (Array.isArray(listed.data) ? listed.data : []) as InvoiceLike[];
    for (const invoice of rows) {
      const meta = invoice.parent?.subscription_details?.metadata ?? {};
      if (!meta.via || !AFFILIATE_ID_PATTERN.test(meta.via) || !handles.has(meta.store ?? "")) continue;
      found.push({ invoice, meta });
    }
    const last = rows[rows.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") {
      complete = true;
      break;
    }
    after = last.id;
  }
  const ids = [...new Set(found.map((f) => f.meta.product).filter((id): id is string => Boolean(id)))];
  // Named from the products' cards, not their whole listings (a title, not up to MAX_PRODUCT_BYTES a product). A
  // reading that fails, or answers in a shape not known, leaves the names empty and every line in, as it always did.
  const titles = new Map([...(named && ids.length ? await readCardsFor(store, ids).catch(() => new Map<string, Card>()) : new Map<string, Card>())].map(([id, card]) => [id, card.title]));
  const lines: Referral[] = [];
  for (const { invoice, meta } of found) {
    const total = typeof invoice.amount_paid === "number" ? invoice.amount_paid : 0;
    if (typeof invoice.id !== "string" || invoice.status !== "paid" || total <= 0) continue;
    const paidAt = Number(invoice.status_transitions?.paid_at) || Number(invoice.created) || 0;
    const plan = meta.kind === "plan";
    const months = Number(meta.via_months) || 0;
    const soldAt = Number(meta.via_at) || 0;
    if (!plan && (months < 1 || !soldAt || !withinMonths(soldAt, paidAt, months))) continue;
    const tax = (invoice.total_taxes ?? []).reduce((sum, t) => sum + (typeof t?.amount === "number" ? t.amount : 0), 0);
    const pi = invoice.payments?.data?.map((p) => p.payment?.payment_intent).find((x): x is string => typeof x === "string") ?? "";
    const affiliate = byId.get(meta.via);
    const buyer = typeof invoice.customer_email === "string" ? invoice.customer_email : "";
    lines.push({
      ref: invoice.id,
      pi,
      aff: meta.via,
      at: paidAt,
      product: meta.product ?? "",
      title: (titles.get(meta.product ?? "") ?? "").slice(0, 200),
      base: Math.max(0, total - tax),
      total,
      currency: readCurrencyCode(invoice.currency),
      rate: Number(meta.via_rate) || 0,
      self: Boolean(affiliate && buyer) && canonicalEmail(affiliate!.email) === canonicalEmail(buyer),
      how: "recurring",
      promotion: affiliatePromotionFrom(meta) ?? undefined,
    });
  }
  return { lines, complete };
}

/**
 * Each goal an affiliate reaches in a calendar month (UTC): its bonus once,
 * dated at the sale that reached it. Counted from the sales that earn after
 * refunds, in the store's currency, not partner shares; a refund that takes
 * the month back under the goal takes the bonus away with it.
 */
export function bonusLines(store: Pick<Store, "affiliates" | "currency">, lines: Line[]): Line[] {
  // A store record made before bonuses existed has none.
  const goals = store.affiliates.bonuses ?? [];
  if (!goals.length) return [];
  const months = new Map<string, Line[]>();
  for (const line of lines) {
    if (line.commission <= 0 || line.how === "partner" || line.how === "bonus" || line.how === "tier2" || line.how === "lead" || line.currency !== store.currency) continue;
    const key = `${line.aff}|${new Date(line.at * 1000).toISOString().slice(0, 7)}`;
    months.set(key, [...(months.get(key) ?? []), line]);
  }
  const out: Line[] = [];
  for (const [key, sold] of months) {
    const [aff, month] = key.split("|");
    const inOrder = [...sold].sort((a, b) => a.at - b.at);
    for (const goal of goals) {
      if (inOrder.length < goal.sales) continue;
      out.push({
        ref: `bonus:${aff}:${month}:${goal.sales}`,
        pi: "",
        aff,
        at: inOrder[goal.sales - 1].at,
        product: "",
        title: `Bonus: ${goal.sales} ${goal.sales === 1 ? "sale" : "sales"} in ${new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" })}`,
        base: 0,
        total: 0,
        currency: store.currency,
        rate: 0,
        self: false,
        how: "bonus",
        refunded: 0,
        commission: goal.cents,
        status: "earned",
      });
    }
  }
  return out;
}

/** What a line credited this way is: a sale somebody brought, as opposed to a share, a bonus or a second tier. */
const BROUGHT: readonly Credit[] = ["click", "code", "buyer", "contact", "recurring"];

/**
 * The second tier: for each sale an affiliate brought that earns them
 * something, the affiliate who invited them earns the percent fixed when they
 * joined (Affiliate.by), of what was kept after refunds — on top, never out of
 * the first share. Three things keep it honest:
 *
 *   - one level only: it is read from sales the recruit brought, never from
 *     another second tier, a partner share or a bonus;
 *   - everything promised on one sale — both shares and any partner's —
 *     never passes the programme's cap;
 *   - nothing is earned on a recruit's sales while that recruit is held for
 *     the creator to look at, nor on sales made after the inviting affiliate
 *     was declined or removed.
 */
export function tierLines(everyone: Affiliate[], lines: Line[], flags: Map<string, HoldFlag[]>): Line[] {
  const byId = new Map(everyone.map((a) => [a.id, a]));
  // What partners take of each sale (written "<sale>:<partner>"), so all the shares of one sale stay under the cap together.
  const partners = new Map<string, number>();
  for (const line of lines) {
    if (line.how !== "partner") continue;
    const sale = line.ref.slice(0, line.ref.lastIndexOf(":"));
    partners.set(sale, (partners.get(sale) ?? 0) + line.rate);
  }
  const out: Line[] = [];
  for (const line of lines) {
    if (line.self || line.commission <= 0 || !BROUGHT.includes(line.how)) continue;
    const recruit = byId.get(line.aff);
    if (!recruit?.by || (flags.get(recruit.id) ?? []).length) continue;
    const up = byId.get(recruit.by.id);
    if (!up || up.id === recruit.id) continue;
    if (up.status !== "approved" && (up.status !== "removed" || line.at * 1000 > up.decidedAt)) continue;
    const percent = Math.min(recruit.by.percent, MAX_COMMISSION - line.rate - (partners.get(line.ref) ?? 0));
    if (percent <= 0) continue;
    out.push(settleLine({ ref: `tier2:${line.ref}`, pi: line.pi, aff: up.id, at: line.at, product: line.product, title: line.title, base: line.base, total: line.total, currency: line.currency, rate: percent, self: false, how: "tier2" }, line.refunded));
  }
  return out;
}

/**
 * Why each affiliate's commission is held, if it is: a click from a paid
 * search ad the creator does not allow, since they last released it; or a
 * payout address, or an inbox written another way, that another affiliate
 * also has, unless the creator cleared it.
 */
export function holdFlags(store: Pick<Store, "affiliates">, everyone: Affiliate[], paidCount: Map<string, number>): Map<string, HoldFlag[]> {
  const out = new Map<string, HoldFlag[]>();
  for (const a of everyone) {
    const flags: HoldFlag[] = [];
    if (!store.affiliates.paidSearch && (paidCount.get(a.id) ?? 0) > (a.cleared?.paid ?? 0)) flags.push("paid-search");
    if (sharersOf(a, everyone).some((id) => !(a.cleared?.with ?? []).includes(id))) flags.push("same-address");
    if (flags.length) out.set(a.id, flags);
  }
  return out;
}

/**
 * The other records with this one's inbox or payout address, written any way:
 * approved, waiting, and also declined or removed, so a payout address set to
 * the inbox of someone the creator turned away is held too.
 */
function sharersOf(a: Affiliate, everyone: Affiliate[]): string[] {
  const mine = new Set([canonicalEmail(a.email), canonicalEmail(payAddress(a))]);
  return everyone
    .filter((b) => b.id !== a.id)
    .filter((b) => mine.has(canonicalEmail(b.email)) || mine.has(canonicalEmail(payAddress(b))))
    .map((b) => b.id);
}

/** The creator looked and lets what is held through: the paid-search clicks so far, and a shared address. */
export async function releaseHold(store: Store, id: string): Promise<Affiliate | null> {
  if (!store.statsId || !AFFILIATE_ID_PATTERN.test(id)) return null;
  const affiliate = await readAffiliate(store, id);
  if (!affiliate) return null;
  const [paid] = await redisPipeline([["HGET", paidClicksKey(store.statsId), id]]);
  const everyone = await listAffiliates(store);
  // Only what was released is changed, over exactly the record read: a share lowered meanwhile is kept.
  const changed = await changeAffiliate(store, id, (now) => ({ ...now, cleared: { paid: Number(paid) || 0, with: sharersOf(now, everyone) } }));
  return changed?.next ?? null;
}

/** What each kind of lead is called in the book's spreadsheet. */
const LEAD_KIND_WORDS: Record<LeadKind, string> = { signup: "Lead: email sign-up", free: "Lead: free product claimed", booking: "Lead: call that took place" };

const csvCell = (value: string | number) => {
  const text = String(value);
  // A cell a spreadsheet would read as a formula is written as text.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The whole book as a spreadsheet: every sale and every payout, one per line. */
export function bookCsv(book: Book, all: Affiliate[]): string {
  const who = new Map(all.map((a) => [a.id, a]));
  const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
  const header = [
    "type",
    "date",
    "affiliate_email",
    "affiliate_code",
    "reference",
    "product",
    "paid_before_tax",
    "refunded",
    "commission_rate_percent",
    "commission",
    "status",
    "payout",
    "payout_reference",
    "currency",
    "campaign_channel",
    "campaign_name",
    "post_variant",
  ];
  const rows: (string | number)[][] = [
    ...book.lines.map((l) => [
      l.how === "tier2" ? "second tier" : l.how === "lead" ? "lead" : "sale",
      day(l.at),
      who.get(l.aff)?.email ?? "",
      who.get(l.aff)?.code ?? "",
      l.ref,
      l.how === "lead" ? `${LEAD_KIND_WORDS[l.lead?.kind ?? "signup"]}${l.title ? `: ${l.title}` : ""}` : l.title,
      plainAmount(l.base, l.currency),
      plainAmount(l.refunded, l.currency),
      l.rate,
      plainAmount(l.commission, l.currency),
      l.status,
      "",
      "",
      l.currency.toUpperCase(),
      l.promotion?.source ?? "",
      l.promotion?.campaign ?? "",
      l.promotion?.content ?? "",
    ]),
    ...book.payouts.map((p) => [
      "payout",
      p.date,
      who.get(p.aff)?.email ?? "",
      who.get(p.aff)?.code ?? "",
      p.id,
      "",
      "",
      "",
      "",
      "",
      "paid by you",
      plainAmount(p.cents, p.currency),
      p.reference,
      p.currency.toUpperCase(),
      "", "", "",
    ]),
  ];
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * A program's own numbers, for the affiliate directory when its creator
 * allowed them (lib/affiliate-setting.ts, AffiliateSetting.numbers): what an
 * affiliate deciding whether to apply most wants to know, and the thing no
 * program elsewhere shows before they join.
 *
 * Read from the same records the creator's book is (readBook), counted the
 * same way: clicks once per visitor a day; sales credited to an affiliate,
 * never their own purchases; what those sales earned at the share each was
 * made at, before any refund, because refunds are read from the creator's
 * Stripe account only when the book is opened; and what the creator wrote
 * down as paid. Only amounts in the store's own currency are added up.
 */
export type ProgramNumbers = {
  /** Affiliates approved today. */
  affiliates: number;
  /** Clicks counted, and the sales credited to a click. */
  clicks: number;
  clickSales: number;
  /** What the sales credited to a click earned, before refunds. */
  clickEarnedCents: number;
  /** Every sale credited to an affiliate (a click, a code or a buyer kept), and what they earned before refunds. */
  sales: number;
  earnedCents: number;
  /** What the creator wrote down as paid to affiliates. */
  paidCents: number;
  /** When the first affiliate was approved, in ms; 0 when none is. */
  since: number;
};

/**
 * A HGETALL reply as pairs, read exactly: a list of strings with an even
 * count, or UnknownReplyError. Never an empty hash from a reply that is
 * missing, cut short or of another shape (lib/redis-reply.ts).
 */
function exactPairs(reply: unknown, what: string): [string, string][] {
  const list = stringList(reply);
  if (!list || list.length % 2 !== 0) throw new UnknownReplyError(what);
  const out: [string, string][] = [];
  for (let i = 0; i < list.length; i += 2) out.push([list[i], list[i + 1]]);
  return out;
}

/** Whole cents from `least` up, held exactly (`1e999` parses to Infinity, `2 ** 53` is past exact). */
const wholeCents = (value: unknown, least: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= least;

/** A share as its writers store it: 0 (`Number(meta.via_rate) || 0`) to MAX_COMMISSION, two decimals when blended. */
const exactShare = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COMMISSION;

/**
 * How a sale found its affiliate, as writeReferral writes it; absent on older records (then `byCode`, or a click).
 * "recurring" is a membership's first payment credited when its pending link was decided (creditFirstPayment;
 * Claude 4 on #3479): refused here, it made the program's numbers unreadable for good.
 */
const STORED_HOW = new Set<unknown>(["click", "code", "buyer", "partner", "contact", "recurring"]);

/** A total of the public numbers, or UnknownReplyError when it is not a whole number held exactly (never "$∞" or "$0"). */
function exactTotal(total: number, what: string): number {
  if (!Number.isSafeInteger(total) || total < 0) throw new UnknownReplyError(what);
  return total;
}

/** Absent (older records, in US dollars) or a three-letter code as Stripe writes it; anything else is of an unknown shape. */
const exactCurrency = (value: unknown): boolean => value === undefined || (typeof value === "string" && /^[a-z]{3}$/.test(value));

/**
 * One record of a program's public numbers, read exactly: what the shared
 * parser reads, or UnknownReplyError. The shared parsers drop a record they
 * cannot read and default a missing number to 0, which their other callers
 * rely on; the public numbers never show such a record as nothing or as 0.
 */
function exactAffiliate(raw: string): Affiliate {
  const affiliate = parseAffiliate(raw);
  if (!affiliate) throw new UnknownReplyError("a program's affiliate");
  return affiliate;
}

/**
 * A sale, read exactly as writeReferral writes it: its base in whole cents
 * from 0 up, its share from 0 to MAX_COMMISSION, its currency absent or
 * Stripe's code, `self` absent or true/false, `how` absent or one it writes
 * (`byCode` absent or true/false on older records).
 */
function exactReferral(raw: string): Referral {
  const referral = parseReferral(raw);
  const value = referral ? (JSON.parse(raw) as Record<string, unknown>) : null;
  if (
    !referral ||
    !value ||
    !wholeCents(value.base, 0) ||
    !exactShare(value.rate) ||
    !exactCurrency(value.currency) ||
    (value.self !== undefined && typeof value.self !== "boolean") ||
    (value.how !== undefined && !STORED_HOW.has(value.how)) ||
    (value.byCode !== undefined && typeof value.byCode !== "boolean")
  ) {
    throw new UnknownReplyError("a program's sale");
  }
  return referral;
}

/** A payment the creator wrote down, read exactly as addPayout writes it: whole cents from 1 up, its currency absent or Stripe's code. */
function exactPayout(raw: string): Payout {
  const payout = parsePayout(raw);
  const value = payout ? (JSON.parse(raw) as Record<string, unknown>) : null;
  if (!payout || !value || !wholeCents(payout.cents, 1) || !exactCurrency(value.currency)) throw new UnknownReplyError("a program's payment");
  return payout;
}

/**
 * Throws UnknownReplyError when a reply, or a record inside it, is not in its
 * exact shape, so the directory shows the program without numbers, never
 * with zeros (lib/affiliate-directory.ts, readDirectory).
 */
export async function programNumbers(store: Store): Promise<ProgramNumbers | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const statsId = store.statsId;
  const replies = repliesFor(
    await redisPipeline([
      ["HGETALL", peopleKey(statsId)],
      ["HGETALL", clicksKey(statsId)],
      ["HGETALL", salesKey(statsId)],
      ["HGETALL", payoutsKey(statsId)],
    ]),
    4,
  );
  if (!replies) throw new UnknownReplyError("a program's numbers");
  const people = exactPairs(replies[0], "a program's affiliates");
  const clicks = exactPairs(replies[1], "a program's clicks").map(([, n]) => {
    // Written only by HINCRBY: a whole number from zero up, or of an unknown shape.
    const count = /^\d+$/.test(n) ? countOf(Number(n)) : null;
    if (count === null) throw new UnknownReplyError("a program's click count");
    return count;
  });
  const sales = exactPairs(replies[2], "a program's sales");
  const payouts = exactPairs(replies[3], "a program's payments");
  const approved = people.map(([, raw]) => exactAffiliate(raw)).filter((a) => a.status === "approved");
  const currency = store.currency.toLowerCase();
  const referrals = sales
    .map(([, raw]) => exactReferral(raw))
    .filter((r) => !r.self && (r.currency || "usd").toLowerCase() === currency);
  // Every sum is checked as it grows: once past exact, adding more can never bring it back.
  const total = (values: number[], what: string) => values.reduce((sum, n) => exactTotal(sum + exactTotal(n, what), what), 0);
  // commissionOn multiplies before it divides: past exact, the product rounds, and so would the commission.
  const earned = (r: Referral) => {
    if (!(r.base * r.rate <= Number.MAX_SAFE_INTEGER)) throw new UnknownReplyError("a program's earnings");
    return commissionOn(r.base, r.rate);
  };
  const byClick = referrals.filter((r) => r.how === "click");
  return {
    affiliates: approved.length,
    clicks: total(clicks, "a program's clicks"),
    clickSales: byClick.length,
    clickEarnedCents: total(byClick.map(earned), "a program's earnings"),
    sales: referrals.length,
    earnedCents: total(referrals.map(earned), "a program's earnings"),
    paidCents: total(
      payouts
        .map(([, raw]) => exactPayout(raw))
        .filter((p) => (p.currency || "usd").toLowerCase() === currency)
        .map((p) => p.cents),
      "a program's payments",
    ),
    since: approved.reduce((first, a) => (first === 0 || (a.decidedAt > 0 && a.decidedAt < first) ? a.decidedAt : first), 0),
  };
}

/** The most warnings and removals one store's sweep does in one run; the rest wait for the next day. */
export const MAX_IDLE_STEPS = 25;

/**
 * Whether a program can have idle affiliates removed at all (630 [HN6](3)):
 * not while it credits memberships and payment plans, whose payments are read
 * from Stripe's invoices when the book is opened and never written down as
 * sales, so an affiliate who brings only members would look idle.
 */
export function idleRemovalAllowed(setting: { recurring: number }): boolean {
  return !(setting.recurring > 0);
}

/**
 * Removing approved affiliates who bring nothing, where the creator asked for
 * it (630 [HN6](3), lib/affiliate-idle-rules.ts idleStep): run once a day by
 * the affiliates' schedule (app/api/cron/affiliates), until `deadline` (ms).
 *
 * What it reads, four commands for the whole store: the affiliates, the
 * sales, the leads and the payments the creator wrote down, already kept and
 * bounded by the store's data room. A sale counts from when it was credited,
 * unless it was the affiliate's own purchase, and counts for the affiliate who
 * invited its affiliate too (their second tier); a lead from when it was
 * confirmed, whatever was decided on it later, so a refund or a reversal never
 * brings an old warning back to life.
 *
 * Who is never warned or removed by it:
 *   - a partner holding a standing share (lib/partner-share.ts): their shares
 *     come from every sale of the product, not through a link;
 *   - anybody who may still be owed something: what their sales, second tier,
 *     leads and monthly goals could have earned, before refunds and so on the
 *     high side, is more than the creator wrote down as paid to them (a sale
 *     in another currency counts as owed). Removal takes them out of every
 *     later payment batch, so it waits until they are paid;
 *   - every affiliate of a program that credits memberships (idleRemovalAllowed).
 *
 * The count starts no earlier than when the creator switched this on, changed
 * it or switched the program back on (idleOn), so nobody is removed for a
 * stretch that came before the rule or during a pause.
 *
 * What it does, at most MAX_IDLE_STEPS a run: removals first, then warnings.
 * A warning is sent only after the affiliate's record is read again and still
 * matches, by email in the store's language from the store's own emails; the
 * first one refused (the store's emails spent, or the provider declining)
 * ends the store's run for the day. Only a warning that went out is written
 * down, on the affiliate's record read again just before, as every writer of
 * that record does. On the date it named, with still nothing, the same removal
 * as the creator's "Remove" (decide): their record stays, and the creator can
 * restore them, which starts the count again.
 */
export async function idleSweep(store: Store, nowMs: number = Date.now(), deadline = Number.POSITIVE_INFINITY): Promise<{ warned: number; removed: number }> {
  const done = { warned: 0, removed: 0 };
  const days = readIdleDays(store.affiliates.idle);
  if (days === 0 || !affiliatesOn(store) || !idleRemovalAllowed(store.affiliates)) return done;
  const statsId = store.statsId as string;
  const now = Math.floor(nowMs / 1000);
  const [peopleReply, salesReply, leadsReply, payoutsReply] = await redisPipeline([
    ["HGETALL", peopleKey(statsId)],
    ["HGETALL", salesKey(statsId)],
    ["HGETALL", leadsKey(statsId)],
    ["HGETALL", payoutsKey(statsId)],
  ]);
  const everyone = pairs(peopleReply)
    .map(([, raw]) => parseAffiliate(raw))
    .filter((a): a is Affiliate => a !== null);
  const inviter = new Map(everyone.filter((a) => a.by).map((a) => [a.id, a.by as { id: string; percent: number }]));
  const lastActive = new Map<string, number>();
  const owedHigh = new Map<string, number>();
  const foreign = new Set<string>();
  const active = (id: string, at: number) => lastActive.set(id, Math.max(lastActive.get(id) ?? 0, at));
  const earn = (id: string, cents: number) => owedHigh.set(id, (owedHigh.get(id) ?? 0) + Math.max(0, Math.ceil(cents)));
  const salesByMonth = new Map<string, number>();
  for (const [, raw] of pairs(salesReply)) {
    const sale = parseReferral(raw);
    if (!sale || sale.self) continue;
    active(sale.aff, sale.at);
    if (sale.currency !== store.currency) foreign.add(sale.aff);
    earn(sale.aff, (sale.base * sale.rate) / 100);
    const up = inviter.get(sale.aff);
    if (up) {
      active(up.id, sale.at);
      if (sale.currency !== store.currency) foreign.add(up.id);
      earn(up.id, (sale.base * up.percent) / 100);
    }
    if (sale.rate > 0) {
      const month = `${sale.aff}:${new Date(sale.at * 1000).toISOString().slice(0, 7)}`;
      salesByMonth.set(month, (salesByMonth.get(month) ?? 0) + 1);
    }
  }
  for (const [month, count] of salesByMonth) {
    const aff = month.slice(0, month.indexOf(":"));
    for (const goal of store.affiliates.bonuses) if (count >= goal.sales) earn(aff, goal.cents);
  }
  for (const [, raw] of pairs(leadsReply)) {
    const lead = parseLead(raw);
    if (!lead) continue;
    active(lead.aff, lead.at);
    if (lead.state !== "reversed") earn(lead.aff, lead.cents);
    if (lead.currency !== store.currency) foreign.add(lead.aff);
  }
  const paid = new Map<string, number>();
  for (const [, raw] of pairs(payoutsReply)) {
    const payout = parsePayout(raw);
    if (payout && payout.currency === store.currency) paid.set(payout.aff, (paid.get(payout.aff) ?? 0) + payout.cents);
  }
  const mayBeOwed = (id: string) => foreign.has(id) || (owedHigh.get(id) ?? 0) > (paid.get(id) ?? 0);

  const steps = everyone
    .filter((a) => a.status === "approved" && a.share === null && !mayBeOwed(a.id))
    .map((affiliate) => ({
      affiliate,
      step: idleStep(
        {
          status: affiliate.status,
          // Counted from their approval, or from when the creator switched this on, changed it or switched the
          // program back on, whichever is later: nobody is removed for a stretch that came before the rule.
          since: Math.max(Math.floor(affiliate.decidedAt / 1000), store.affiliates.idleOn ?? 0),
          lastSale: lastActive.get(affiliate.id) ?? 0,
          lastLead: 0,
          warnedAt: affiliate.warned ?? 0,
          onSince: store.affiliates.idleOn ?? 0,
        },
        days,
        now,
      ),
    }))
    .filter(({ step }) => step.do === "remove" || step.do === "warn")
    // Removals first: they were warned longest ago.
    .sort((x, y) => (x.step.do === y.step.do ? 0 : x.step.do === "remove" ? -1 : 1))
    .slice(0, MAX_IDLE_STEPS);

  const a = affiliatesWords(store.language);
  const locale = LANGUAGES[parseLanguage(store.language)].locale;
  const leads = store.affiliates.lead.kind !== "none";
  // Read again and still the very affiliate the snapshot saw: approved, not decided on, warned as it was.
  const same = (fresh: Affiliate | null, seen: Affiliate): fresh is Affiliate =>
    fresh !== null && fresh.status === "approved" && fresh.share === null && fresh.decidedAt === seen.decidedAt && (fresh.warned ?? 0) === (seen.warned ?? 0);
  for (const { affiliate, step } of steps) {
    if (Date.now() >= deadline) break;
    const fresh = await readAffiliate(store, affiliate.id);
    if (!same(fresh, affiliate)) continue;
    if (step.do === "remove") {
      if (await decide(store, affiliate.id, "remove")) done.removed += 1;
      continue;
    }
    if (step.do !== "warn" || !isSenderConfigured()) continue;
    const date = new Date(step.removeOn * 1000).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    const sent = await sendEmail({
      meter: { by: "store", store, kind: "email" },
      from: `"${displayName(store.name)} via Marktmorgen" <${senderAddress()}>`,
      replyTo: store.email,
      to: fresh.email,
      subject: a.idleSubject(store.name, date),
      text: [a.idleBody(store.name, days, date, leads), "", a.approvedPage(`${SITE_URL}/@${store.handle}/affiliates`)].join("\n"),
    }).catch((error) => {
      console.error("warning an idle affiliate failed", error);
      return false;
    });
    // Refused past the store's emails, or not delivered: nobody is warned, so nobody is removed, and the store waits for tomorrow.
    if (sent !== true) break;
    // Only the warning is written, over exactly the record read, and only while it is still the affiliate the
    // snapshot saw: a share, a rate or an address written meanwhile is kept.
    const changed = await changeAffiliate(store, affiliate.id, (again) => (same(again, affiliate) ? { ...again, warned: now } : null));
    if (changed?.next) done.warned += 1;
  }
  return done;
}
