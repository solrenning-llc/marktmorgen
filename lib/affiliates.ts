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
import { type Paid, paypalPaymentId, readPayPalRefunds, refundedKey as paypalRefundedKey } from "@/lib/paypal-sales";
import { saleHandles, storeForId } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { giveData, needData } from "@/lib/store-data";
import { orderWrite } from "@/lib/order-data";
import { dataBytes } from "@/lib/store-data-rules";
import { affiliatePromotionFrom, readAffiliatePromotion, type AffiliatePromotion } from "@/lib/affiliate-promotion";
import { onAccount } from "@/lib/stripe-account";
import { DISPUTE_TAKES } from "@/lib/retained-revenue";
import { isSettled } from "@/lib/instant-pay";
import { SITE_URL } from "@/lib/site-url";
import {
  AFFILIATE_CODE_PATTERN,
  MAX_AFFILIATES,
  MAX_COMMISSION,
  MIN_COMMISSION,
  commissionOn,
  commissionRate,
  creditsContacts,
  RECURRING_ALWAYS,
  readViaCookie,
} from "@/lib/affiliate-setting";
import { productIds, readListings } from "@/lib/catalog";
import type { BookSizes } from "@/lib/api-read-rules";
import { affiliateForCodes, codeOwners } from "@/lib/affiliate-codes";
import { type PartnerShare, parsePartnerShare, shareOn } from "@/lib/partner-share";
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
const REFUND_PAGES = 10;
/** And of a hundred disputes, which are far fewer. */
const DISPUTE_PAGES = 3;
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
    };
  } catch {
    return null;
  }
}

/** Where an affiliate is paid through PayPal: the address they asked for, or the one they joined with. */
export function payAddress(affiliate: Pick<Affiliate, "email" | "paypal">): string {
  return affiliate.paypal || affiliate.email;
}

/** Sets, or clears with null, the share one affiliate earns. */
export async function setAffiliateRate(store: Store, id: string, rate: number | null): Promise<Affiliate | null> {
  const affiliate = await readAffiliate(store, id);
  if (!affiliate) return null;
  if (rate !== null && (!Number.isInteger(rate) || rate < MIN_COMMISSION || rate > MAX_COMMISSION)) return null;
  const next: Affiliate = { ...affiliate, rate };
  await writeAffiliate(store, next);
  return next;
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
  const affiliate = await readAffiliate(store, id);
  if (!affiliate) return null;
  const next: Affiliate = { ...affiliate, share };
  await writeAffiliate(store, next);
  return next;
}

/** Everybody in this programme who holds a standing share of something. */
export async function listPartners(store: Store): Promise<Affiliate[]> {
  return (await listAffiliates(store)).filter((a) => a.share !== null);
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
  const value = paypal === normaliseEmail(affiliate.email) ? "" : paypal;
  if (value === affiliate.paypal) return { ok: true };
  await writeAffiliate(store, { ...affiliate, paypal: value });
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

export async function listAffiliates(store: Store): Promise<Affiliate[]> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const [reply] = await redisPipeline([["HGETALL", peopleKey(store.statsId)]]);
  return pairs(reply)
    .map(([, raw]) => parseAffiliate(raw))
    .filter((a): a is Affiliate => a !== null)
    .sort((a, b) => b.appliedAt - a.appliedAt);
}

export async function readAffiliate(store: Store, id: string): Promise<Affiliate | null> {
  if (!store.statsId || !isRedisConfigured() || !AFFILIATE_ID_PATTERN.test(id)) return null;
  const [raw] = await redisPipeline([["HGET", peopleKey(store.statsId), id]]);
  return parseAffiliate(raw);
}

async function writeAffiliate(store: Store, affiliate: Affiliate): Promise<void> {
  await redisPipeline([["HSET", peopleKey(store.statsId as string), affiliate.id, JSON.stringify(affiliate)]]);
  // Found again from their own page across every store (lib/affiliate-hub.ts).
  await rememberAffiliate(store.sid, affiliate.email);
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

async function within(key: string, limit: number): Promise<boolean> {
  const [, count] = await redisPipeline([
    ["SET", key, "0", "EX", RATE_WINDOW_SECONDS, "NX"],
    ["INCR", key],
  ]);
  return Number(count) <= limit;
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
  if (!(await within(applyIpKey(ip, store.handle), APPLY_IP_LIMIT))) return "limited";
  if (!(await within(applyAddressKey(email), APPLY_ADDRESS_LIMIT))) return "limited";

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
    const [count] = await redisPipeline([["HLEN", peopleKey(statsId)]]);
    if (Number(count) >= MAX_AFFILIATES) return "full";
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
export async function acceptPartnership(store: Store, email: string, share: PartnerShare): Promise<OpenResult> {
  if (!affiliatesOn(store)) return { ok: false, reason: "unavailable" };
  const token = randomBytes(32).toString("hex");
  const grant: LinkGrant = { s: store.statsId as string, e: normaliseEmail(email), n: "Accepted a partnership", k: 1, p: share };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", 600]]);
  return openAffiliateLink(store, token);
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
  | { ok: false; reason: "expired" | "full" | "unavailable" };

/**
 * The button on the page an emailed link opens. The first time for an
 * address, it makes the application; every time, it signs this browser in.
 */
export async function openAffiliateLink(store: Store, token: string): Promise<OpenResult> {
  if (!affiliatesOn(store)) return { ok: false, reason: "unavailable" };
  if (!AFFILIATE_TOKEN_PATTERN.test(token)) return { ok: false, reason: "expired" };
  const statsId = store.statsId as string;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  const grant = parseGrant(raw);
  if (!grant || grant.s !== statsId) return { ok: false, reason: "expired" };

  let affiliate: Affiliate | null = null;
  let created = false;
  const [knownId] = await redisPipeline([["HGET", emailsKey(statsId), grant.e]]);
  if (typeof knownId === "string") affiliate = await readAffiliate(store, knownId);
  // An invitation the creator sent (grant.k) arrives already decided: opening
  // it approves them and attaches the share the email stated. Somebody the
  // creator had declined or removed is let back in by it, because inviting
  // them is the creator changing their mind, in their own words.
  if (affiliate && grant.k === 1) {
    affiliate = { ...affiliate, status: "approved", decidedAt: Date.now(), share: grant.p ?? affiliate.share };
    await writeAffiliate(store, affiliate);
  }
  if (!affiliate) {
    const [count] = await redisPipeline([["HLEN", peopleKey(statsId)]]);
    if (Number(count) >= MAX_AFFILIATES) return { ok: false, reason: "full" };
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
      await writeAffiliate(store, affiliate);
      created = true;
    }
  }

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
  const knownInbox = autoChosen && (await sameInboxAsAnother(store, affiliate.email, affiliate.id));
  const ownersInbox = autoChosen && canonicalEmail(affiliate.email) === canonicalEmail(store.email);
  let autoApproved = false;
  if (autoChosen && !knownInbox && !ownersInbox) {
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
    if (affiliate.status === "pending" && !knownInbox) {
      affiliate = { ...affiliate, status: "approved", decidedAt: Date.now() };
      await writeAffiliate(store, affiliate);
    }
  } else {
    const [count] = await redisPipeline([["HLEN", peopleKey(statsId)]]);
    if (Number(count) >= MAX_AFFILIATES) return { ok: false, reason: "full" };
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
      await writeAffiliate(store, affiliate);
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
  await redisPipeline([["DEL", sessionKey(session)]]);
}

// ---- The creator's decisions ---------------------------------------------

export type Decision = "approve" | "decline" | "remove" | "restore";

/** Lets someone in, turns them down, or takes them out. Their history stays. */
export async function decide(store: Store, id: string, decision: Decision): Promise<Affiliate | null> {
  const affiliate = await readAffiliate(store, id);
  if (!affiliate) return null;
  const status: AffiliateStatus =
    decision === "approve" || decision === "restore" ? "approved" : decision === "decline" ? "declined" : "removed";
  const next: Affiliate = { ...affiliate, status, decidedAt: Date.now() };
  await writeAffiliate(store, next);
  if (decision === "approve" && affiliate.status === "pending" && isSenderConfigured()) {
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
  return next;
}

// ---- Several decisions at once, with undo (630 [HN6](4), unit 1) ----------

/** The most applications one press decides, and how long its undo lasts. */
export const MAX_BULK_DECISIONS = 100;
export const BULK_UNDO_MS = 10 * 60_000;

/** How one affiliate stood before a decision in bulk: what an undo puts back. */
export type Before = { id: string; status: AffiliateStatus; decidedAt: number };

/**
 * Approves or declines several pending applications, one by one through
 * decide (each approval emails its link, as one at a time). Only pending
 * ones are touched; anybody already decided is left as they are. Returns how
 * each stood before, for an undo.
 */
export async function decideMany(store: Store, ids: string[], decision: "approve" | "decline"): Promise<Before[]> {
  const before: Before[] = [];
  for (const id of [...new Set(ids)].slice(0, MAX_BULK_DECISIONS)) {
    const affiliate = await readAffiliate(store, id);
    if (!affiliate || affiliate.status !== "pending") continue;
    const done = await decide(store, id, decision);
    if (done) before.push({ id, status: affiliate.status, decidedAt: affiliate.decidedAt });
  }
  return before;
}

/**
 * Puts back how each affiliate stood before a decision in bulk, for those
 * still exactly as that decision left them and within BULK_UNDO_MS of it: a
 * later decision by hand is never overwritten. An approval email already
 * sent is not taken back; the studio says so. Returns how many were put back.
 */
export async function undoMany(store: Store, before: Before[], decision: "approve" | "decline", now = Date.now()): Promise<number> {
  const left: AffiliateStatus = decision === "approve" ? "approved" : "declined";
  let undone = 0;
  for (const entry of before.slice(0, MAX_BULK_DECISIONS)) {
    if (entry.status !== "pending") continue;
    const affiliate = await readAffiliate(store, entry.id);
    if (!affiliate || affiliate.status !== left || now - affiliate.decidedAt > BULK_UNDO_MS || affiliate.decidedAt < entry.decidedAt) continue;
    await writeAffiliate(store, { ...affiliate, status: entry.status, decidedAt: entry.decidedAt });
    undone += 1;
  }
  return undone;
}

/** How one affiliate's own share stood before a change in bulk: what an undo puts back. */
export type RateBefore = { id: string; rate: number | null };

/**
 * Sets, or clears with null, the share of several approved affiliates at
 * once (630 [HN6](4), unit 2), each through setAffiliateRate: it applies to
 * sales from now on, and a sale keeps the share it was made at. Returns how
 * each stood before, leaving out those already at it.
 */
export async function setRatesMany(store: Store, ids: string[], rate: number | null): Promise<RateBefore[] | null> {
  if (rate !== null && (!Number.isInteger(rate) || rate < MIN_COMMISSION || rate > MAX_COMMISSION)) return null;
  const before: RateBefore[] = [];
  for (const id of [...new Set(ids)].slice(0, MAX_BULK_DECISIONS)) {
    const affiliate = await readAffiliate(store, id);
    if (!affiliate || affiliate.status !== "approved" || affiliate.rate === rate) continue;
    if (await setAffiliateRate(store, id, rate)) before.push({ id, rate: affiliate.rate });
  }
  return before;
}

/** Puts back each share still exactly as the change left it; one changed by hand since is never overwritten. */
export async function undoRates(store: Store, before: RateBefore[], rate: number | null): Promise<number> {
  let undone = 0;
  for (const entry of before.slice(0, MAX_BULK_DECISIONS)) {
    const affiliate = await readAffiliate(store, entry.id);
    if (!affiliate || affiliate.rate !== rate) continue;
    if (await setAffiliateRate(store, entry.id, entry.rate)) undone += 1;
  }
  return undone;
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
  await redisPipeline([["HSET", payoutsKey(store.statsId as string), payout.id, json]]);
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
  if (!(await within(clickIpKey(visitor.ip, statsId), CLICK_IP_LIMIT))) return false;
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
 * (readBook, through readPayPalRefunds).
 */
export async function creditPayPalSale(store: Store, paid: Paid, title: string): Promise<void> {
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
  await notePartners(store, { ...sale, buyer: paid.email });
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
    // Then the code the buyer typed, which is the only trace a sale made on a
    // podcast or from a stage leaves at all (lib/affiliate-codes.ts).
    const given = owners ?? (await codeOwners(store));
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
async function refundsSince(store: Store, since: number): Promise<{ byIntent: Map<string, number>; complete: boolean }> {
  const byIntent = new Map<string, number>();
  if (!store.stripeAccountId) return { byIntent, complete: false };
  let after = "";
  for (let page = 0; page < REFUND_PAGES; page += 1) {
    const listed = await onAccount(
      "GET",
      store.stripeAccountId,
      `/refunds?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
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
export async function disputesSince(store: Store, since: number): Promise<{ byIntent: Map<string, number>; complete: boolean }> {
  const byIntent = new Map<string, number>();
  if (!store.stripeAccountId) return { byIntent, complete: false };
  let after = "";
  for (let page = 0; page < DISPUTE_PAGES; page += 1) {
    const listed = await onAccount(
      "GET",
      store.stripeAccountId,
      `/disputes?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
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
export async function readBook(store: Store, only?: string): Promise<Book> {
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
      const read = await recurringReferrals(store, everyone, Math.min(...everyone.map((a) => Math.floor(a.appliedAt / 1000))) - 86_400);
      recurringLines = read.lines.filter((r) => mine(r.aff));
      invoicesChecked = read.complete;
    } catch (error) {
      console.error("reading invoices for the affiliate book failed", error);
      invoicesChecked = false;
    }
  }
  const everything = [...referrals, ...partnerLines, ...recurringLines];
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
      const read = store.stripeAccountId ? await refundsSince(store, since) : { byIntent: new Map<string, number>(), complete: true };
      refunds = read.byIntent;
      refundsChecked = read.complete;
      // PayPal's refunds in full, named by the payment as the book names it.
      for (const r of await readPayPalRefunds(store.statsId, since)) refunds.set(paypalPaymentId(r.capture), (refunds.get(paypalPaymentId(r.capture)) ?? 0) + r.cents);
    } catch (error) {
      console.error("reading refunds for the affiliate book failed", error);
      refundsChecked = false;
    }
    // A chargeback takes the money back as a refund does (disputesSince).
    // Judged with the refunds: when either could not be read in full, what
    // is owed is not known (refundsChecked), and no payout is made on it.
    if (store.stripeAccountId) {
      try {
        const disputed = await disputesSince(store, since);
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
const INVOICE_PAGES = 10;
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
async function recurringReferrals(store: Store, everyone: Affiliate[], since: number): Promise<{ lines: Referral[]; complete: boolean }> {
  const handles = saleHandles(store);
  const byId = new Map(everyone.map((a) => [a.id, a]));
  const found: { invoice: InvoiceLike; meta: Record<string, string> }[] = [];
  let after = "";
  let complete = false;
  for (let page = 0; page < INVOICE_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: "100", status: "paid", "created[gte]": String(Math.max(0, since)) });
    query.append("expand[]", "data.payments");
    if (after) query.set("starting_after", after);
    const listed = (await onAccount("GET", store.stripeAccountId as string, `/invoices?${query}`, undefined, AFF_SUB_STRIPE_VERSION)) as { data?: unknown; has_more?: unknown };
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
  const titles = new Map((ids.length ? await readListings(store, ids).catch(() => []) : []).map((p) => [p.id, p.title]));
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
  const next: Affiliate = { ...affiliate, cleared: { paid: Number(paid) || 0, with: sharersOf(affiliate, await listAffiliates(store)) } };
  await writeAffiliate(store, next);
  return next;
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

export async function programNumbers(store: Store): Promise<ProgramNumbers | null> {
  if (!store.statsId || !isRedisConfigured()) return null;
  const statsId = store.statsId;
  const [people, clicks, sales, payouts] = await redisPipeline([
    ["HGETALL", peopleKey(statsId)],
    ["HGETALL", clicksKey(statsId)],
    ["HGETALL", salesKey(statsId)],
    ["HGETALL", payoutsKey(statsId)],
  ]);
  const approved = pairs(people)
    .map(([, raw]) => parseAffiliate(raw))
    .filter((a): a is Affiliate => a !== null && a.status === "approved");
  const currency = store.currency.toLowerCase();
  const referrals = pairs(sales)
    .map(([, raw]) => parseReferral(raw))
    .filter((r): r is Referral => r !== null && !r.self && (r.currency || "usd").toLowerCase() === currency);
  const earned = (r: Referral) => commissionOn(r.base, r.rate);
  const byClick = referrals.filter((r) => r.how === "click");
  return {
    affiliates: approved.length,
    clicks: pairs(clicks).reduce((sum, [, n]) => sum + (Number(n) || 0), 0),
    clickSales: byClick.length,
    clickEarnedCents: byClick.reduce((sum, r) => sum + earned(r), 0),
    sales: referrals.length,
    earnedCents: referrals.reduce((sum, r) => sum + earned(r), 0),
    paidCents: pairs(payouts)
      .map(([, raw]) => parsePayout(raw))
      .filter((p): p is Payout => p !== null && (p.currency || "usd").toLowerCase() === currency)
      .reduce((sum, p) => sum + p.cents, 0),
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
    const again = await readAffiliate(store, affiliate.id);
    if (same(again, affiliate)) {
      await writeAffiliate(store, { ...again, warned: now });
      done.warned += 1;
    }
  }
  return done;
}
