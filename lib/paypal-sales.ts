/**
 * Selling with PayPal: the buyer pays straight into the creator's own PayPal
 * account, through PayPal's platform program (Multiparty), and nothing passes
 * through Marktmorgen.
 *
 *   nl:ppsell:o:<order>      an order opened: which store, which product, the price asked (3 days; kept while pending, 30 from opening at most)
 *   nl:ppsell:paid:<order>   an order paid: the capture, the buyer's address (kept 400 days)
 *   nl:ppsell:watch:<stats>  paid orders inside PayPal's refund window, scored by when to ask next
 *   nl:ppsell:pending:<stats> orders whose payment PayPal holds as pending, or is being asked to take, until it completes or fails
 *   nl:ppsell:own:<stats>:<address hash>:<product>  the paid orders behind one address's product
 *   nl:ppsell:sales:<stats>     every paid order, scored by when it was paid (400 days): the store's numbers read it
 *   nl:ppsell:refunded:<stats>  paid orders PayPal says were refunded in full, scored by when that was seen
 *   nl:ppsell:back:<stats>      the same refunds by payment, kept for good, for the affiliate book's lines
 *   nl:ppsell:reversed:<stats>  of those, the ones taken back by another way than a refund (reversed, failed, declined)
 *   nl:ppsell:tell:<order>    when telling the store's webhooks of an order's refund first failed (REFUND_TELL_MARK_SECONDS)
 *
 * How it fits together. Marktmorgen is a PayPal partner; a creator connects their
 * PayPal Business account through PayPal's own onboarding (Partner Referrals
 * v2), granting it PAYMENT and REFUND. An order names the creator's account as
 * its payee, so the money is the creator's from the first second; Marktmorgen asks
 * for no fee. When the buyer comes back from PayPal, the order is captured
 * and the purchase is written down under the buyer's PayPal address with
 * lib/imported-purchases.ts — the same record a gift or a purchase brought
 * over from another platform uses — so every door that hands things over
 * (downloads on the list of purchases, courses, the community, private
 * podcasts) opens for it exactly as for a Stripe sale. A refund in full on
 * PayPal takes it back again (revokeRefundedPayPal, run by the checkout sweep).
 *
 * Off until the partner credentials are set: PayPal hands those over only
 * after it approves the platform. Requests follow PayPal's published OpenAPI
 * descriptions (checkout_orders_v2, customer_partner_referrals_v2,
 * payments_payment_v2).
 *
 * What it sells, said plainly where it is offered: one-time products at one
 * price that hand over a file, a link, a course, a bundle or a podcast. Not
 * memberships, payment plans, calls, price options, pay what you want or
 * license keys; no add-on, no gift, no discount code.
 *
 * Counted like a Stripe sale (added 13 October 2026): each paid order is
 * written to the store's own list of PayPal sales with the channel and the
 * affiliate its visit carried, so "Your numbers", the sales file, the
 * affiliate book and the webhooks count it (lib/stats.ts readPaidSales,
 * lib/paypal-delivery.ts).
 */
import { CONSENT_META, type DigitalConsent, consentMetaValue, deliversDigitally, validConsent } from "@/lib/digital-consent";
import { consentEmailLines } from "@/lib/digital-consent-email";
import { reservePaidResourceWindow } from "@/lib/contract-resource-window";
import { fairOff } from "@/lib/fair-price";
import { admitOrders } from "@/lib/order-admission";
import { countOrder } from "@/lib/orders";
import { randomBytes } from "node:crypto";
import { orderWrite } from "@/lib/order-data";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { releaseLock } from "@/lib/redis-lock";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { EMAIL_PATTERN } from "@/lib/auth";
import { addressHash, grantImported, importedKey } from "@/lib/imported-purchases";
import { plainAmount, formatMoney } from "@/lib/money";
import { saleOff, salePrice } from "@/lib/store-sale";
import { sendEmailPinned } from "@/lib/email";
import { isPaidUp } from "@/lib/billing";
import { type Listing, type Store, setPastBuyers, storeRef } from "@/lib/store";
import { speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";

/** Local tests may point this at a stand-in on 127.0.0.1; nothing else is taken. */
const API = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.PAYPAL_API_BASE ?? "")
  ? (process.env.PAYPAL_API_BASE as string)
  : process.env.PAYPAL_ENV === "sandbox"
    ? "https://api-m.sandbox.paypal.com"
    : "https://api-m.paypal.com";
const TIMEOUT_MS = 20_000;
const ORDER_ID = /^[A-Z0-9]{10,36}$/;
/** The refunded mark's score as this file writes it (ZADD with String(now)): whole seconds, nothing else. */
const REDIS_SCORE = /^[1-9]\d{0,11}$/;
/**
 * A refunded payment's purchase taken back only while nothing else stands for it, in one step (Codex G's M1 on #2791):
 * KEYS[1] the address's imported purchases, KEYS[2] its payments for the product; ARGV[1] the product, ARGV[2] the
 * refunded payment's job, ARGV[3..] the other payments already read as not keeping it. A payment that came in since
 * (one not in ARGV), or a record that is now another's, answers 0 and nothing is taken; 1 is taken, 2 was already gone.
 * Billed as the EVAL plus each redis.call (Upstash): at most 4 commands a take-back (EVAL, SMEMBERS, HGET, HDEL),
 * against the 1 HDEL it replaced, for at most the 25 due orders a store's watch reads a run (Revisor 1 on #2809).
 */
const PAYPAL_REVOKE = `-- marktmorgen:paypal-revoke:v1
local known = {}
for i = 3, #ARGV do known[ARGV[i]] = true end
for _, member in ipairs(redis.call('SMEMBERS', KEYS[2])) do
  if not known[member] then return 0 end
end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 2 end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record.job ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1`;
/**
 * A completed payment written down, once, with every list it belongs in, in one step (Claude 5's triage of the money
 * section of the tolerant-reads inventory, 9 November 2026; rules 24 and 30). Before, the record's SET NX and the lists
 * were two requests: a second one that did not reach Redis, or a first whose answer was lost, left the paid order in
 * no list, and every later try found the SET refused and wrote nothing; the buyer was never handed what they paid for.
 * KEYS: the paid record, the hand-over list, the refund watch, the buyer's payments for the product, pending, the
 * store's sales. ARGV: the record, its life, the order, the paid time, the watch's first look, the sales' floor, their
 * life. It is owed a hand-over from here, first and in the same step that takes it off pending, so a paid order is never
 * in neither list (Claude 5 on #2909): lib/paypal-delivery.ts takes it out once it is handed over, and the sweep hands
 * over what is still in it after the return's own hand-over has had its time; counted in the store's numbers like a
 * Stripe sale (lib/stats.ts readPaidSales). Answers 1 when written here, 0 when the record was there already (nothing
 * else is written then). Billed as the EVAL plus each redis.call (Upstash): one command more a sale than the SET and
 * the pipeline it replaces (10 against 9), inside the order's own work, which ORDER_COMPUTE prices (tests/
 * plan-cost-registry.ts, line "orders"); the hand-over list still gets one write a sale (PAYPAL_HAND_OVER_RETRY).
 */
const PAYPAL_SETTLE = `-- marktmorgen:paypal-settle:v1
if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[3])
redis.call('SADD', KEYS[4], ARGV[3])
redis.call('EXPIRE', KEYS[4], ARGV[2])
redis.call('ZREM', KEYS[5], ARGV[3])
redis.call('ZADD', KEYS[6], ARGV[4], ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', ARGV[6])
redis.call('EXPIRE', KEYS[6], ARGV[7])
return 1`;
/** A product id as the catalog makes them, and a PayPal capture id: what the refund watch reads a paid order by. */
const PAID_PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CAPTURE_ID = /^[A-Za-z0-9-]{1,64}$/;
const MERCHANT_ID = /^[A-Z0-9]{8,20}$/;
/** How long a refund on PayPal is watched for, after the sale. PayPal allows refunds for 180 days. */
const WATCH_SECONDS = 180 * 86_400;
/**
 * How long after a creator disconnects PayPal the store's orders are still asked about (paypalMerchant): PayPal's
 * refund window, the same 180 days a paid order is watched for (nextLook). Past it, or as soon as no order of the
 * store is left on its lists (lib/paypal-delivery.ts, sweepPayPal), the store is no longer swept for PayPal.
 */
export const PAYPAL_PAST_SECONDS = WATCH_SECONDS;
/**
 * How long an opened order's record is kept before its buyer comes back from PayPal (openOrder): an order opened before
 * a disconnection can still be approved and captured this long after it, so the disconnected account is kept at least
 * this long (lib/paypal-delivery.ts, sweepPayPal; review of #3924).
 */
export const PAYPAL_OPEN_ORDER_SECONDS = 3 * 86_400;
/**
 * How long after its order was opened a payment PayPal has not confirmed is canceled (watchPayPal): 29 days. A
 * pending order's record is kept 30 days from its capture (watchLater), which comes after its opening, so the
 * cancellation always runs while the record still says which store, product and price it was, one day before the
 * existing handling would have let it go without a word. PayPal clears an eCheck in about a week; 29 days leaves
 * every slower review its time.
 */
export const PENDING_GIVE_UP_SECONDS = 29 * 86_400;
/**
 * How long a canceled order's mark is kept (canceledKey): 30 days. It holds what the notices say (store, product,
 * price, the buyer's PayPal address, whether anything was taken) and is what the page a buyer comes back to reads
 * (canceledFor), so a buyer PayPal gave no address for still finds out there.
 */
export const CANCELED_KEPT_SECONDS = 30 * 86_400;
/** How long after a buyer's notice the sender refused it is tried again (retryCancelNotices): six hours. */
export const CANCEL_NOTICE_EVERY_SECONDS = 6 * 3600;
/**
 * The most times a buyer's notice is tried: the first, at the cancellation, then once every CANCEL_NOTICE_EVERY_SECONDS
 * while the sender refuses it, for as long as the order's mark is kept. Never given up while the mark is kept: the
 * buyer is never left without a word because a sender refused it once.
 */
export const CANCEL_NOTICE_TRIES = 1 + CANCELED_KEPT_SECONDS / CANCEL_NOTICE_EVERY_SECONDS;
/** The buyers' notices one run of the job tries again, at most (retryCancelNotices). */
export const CANCEL_NOTICE_BATCH = 25;
/** PayPal's order statuses (checkout_orders_v2) under which nothing was charged: no capture was made. */
const NOT_CHARGED = new Set(["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"]);
const PAID_KEPT_SECONDS = 400 * 86_400;

const orderKey = (order: string) => `nl:ppsell:o:${order}`;
const paidKey = (order: string) => `nl:ppsell:paid:${order}`;
/** How many times an order's capture was asked for (watchFirst), until thirty days from its opening. */
const tryKey = (order: string) => `nl:ppsell:try:${order}`;
const watchKey = (statsId: string) => `nl:ppsell:watch:${statsId}`;
/** Orders whose payment PayPal holds as pending, scored by when they were taken. */
const pendingKey = (statsId: string) => `nl:ppsell:pending:${statsId}`;
/** An order canceled because PayPal never confirmed its payment (cancelOrder): what its notices and its page say. */
const canceledKey = (order: string) => `nl:ppsell:canceled:${order}`;
/**
 * Canceled orders whose notices the sender refused, scored by when each is tried again (retryCancelNotices): the
 * order's id for its buyer's notice, "c:" and the id for its creator's.
 */
const CANCEL_NOTICE_QUEUE = "nl:ppsell:tell";
/**
 * Paid orders still owed their hand-over (lib/paypal-delivery.ts), scored by when they were written down or last
 * tried: settle adds each one with the writes that take it off pending, a hand-over takes it out.
 */
export const handOverKey = (statsId: string) => `nl:ppsell:handover:${statsId}`;
/** Issues PayPal answers a capture with when it takes nothing (Orders v2 errors). */
const DECLINED = new Set(["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED", "ORDER_NOT_APPROVED", "PAYEE_ACCOUNT_RESTRICTED", "PAYER_ACCOUNT_RESTRICTED"]);
/** Every PayPal order one address paid for one product, so a refund of one leaves the others standing. */
/** The paid orders behind one address's product (also read by lib/paypal-handed.ts). */
export const ownKey = (statsId: string, email: string, productId: string) => `nl:ppsell:own:${statsId}:${addressHash(email)}:${productId}`;
/** Every paid order, scored by when it was paid, and those refunded in full: what the store's numbers read. */
const salesKey = (statsId: string) => `nl:ppsell:sales:${statsId}`;
/** Exported for the affiliate book's count of what it will read (lib/affiliates.ts, bookSizes). */
export const refundedKey = (statsId: string) => `nl:ppsell:refunded:${statsId}`;
/**
 * The store's PayPal payments refunded in full, kept for good (a field per payment, named as the affiliate book names
 * it, paypalPaymentId; its value when the refund was seen): the affiliate book's lines are kept for good, so what
 * takes one back must be too. refundedKey is the short-lived index the store's numbers list; the book reads this,
 * and asks refundedKey about its own orders only (lib/affiliates.ts, readBook).
 */
export const backKey = (statsId: string) => `nl:ppsell:back:${statsId}`;
/** The most names one question of the affiliate book carries (an HMGET of backKey, a ZMSCORE of refundedKey); a longer list is asked in slices. */
export const BOOK_KEPT_SLICE = 500;
/**
 * Of the orders in refundedKey, those PayPal took back by another way than a refund: a capture REVERSED, FAILED or
 * DECLINED (C4-13). Written before the refund mark and kept as long, so the buyer's thanks page (lib/paypal-handed.ts)
 * never says "refunded" of a payment that was not (pre-review MEDIUM, VR 2).
 */
export const reversedKey = (statsId: string) => `nl:ppsell:reversed:${statsId}`;
const SALES_KEPT_SECONDS = 400 * 86_400;
/**
 * How long the refund watch keeps trying to tell the store's webhooks of a refund in full (refund.issued) after the
 * first try that failed (Claude 5's L4 on #3491): the order stays watched and is looked at again every hour, the
 * purchase taken back with the telling; past this the store's webhook log says "Not sent" (on.notTold) and the refund
 * goes on without it. A whole number of hours.
 */
export const REFUND_TELL_RETRY_SECONDS = 6 * 3600;
/** The most tries of one refund's telling: one an hour inside REFUND_TELL_RETRY_SECONDS, the first and the last included. */
export const REFUND_TELL_TRIES_AT_MOST = REFUND_TELL_RETRY_SECONDS / 3600 + 1;
/** How long the time of the first failed try is kept: longer than the tries, so a late look never starts them again. */
const REFUND_TELL_MARK_SECONDS = 30 * 86_400;
/** When telling of this order's refund first failed (whole seconds), set by the first failure and read by every later one. */
const tellKey = (order: string) => `nl:ppsell:tell:${order}`;

/**
 * The time telling of this order's refund first failed: `at` is kept when none is (SET NX), then read back exactly
 * (CX-123 rule 24): "OK" or null, then whole seconds not ahead of `now`. Anything else, an error included, is null:
 * not known, never "inside the bound" nor "past it" (Codex C2's M1 on #3499).
 */
async function tellFirst(order: string, at: number, now: number): Promise<number | null> {
  const mark = repliesFor(await redisPipeline([["SET", tellKey(order), String(at), "NX", "EX", REFUND_TELL_MARK_SECONDS], ["GET", tellKey(order)]]).catch(() => null), 2);
  if (!mark || (mark[0] !== "OK" && mark[0] !== null) || typeof mark[1] !== "string" || !REDIS_SCORE.test(mark[1])) return null;
  const first = Number(mark[1]);
  return first <= now ? first : null;
}

/**
 * A member of refundedKey that is a partial refund's mark rather than an order refunded in full: "part:" and the
 * order (the partial refund's unit builds on this). Readers of refunds in full pass over it, never as a cut.
 */
export const PARTIAL_MARK = /^part:[A-Z0-9]{10,36}$/;

type Partner = { client: string; secret: string; merchant: string; bn: string };

function partner(): Partner | null {
  const client = process.env.PAYPAL_PARTNER_CLIENT_ID?.trim() ?? "";
  const secret = process.env.PAYPAL_PARTNER_SECRET?.trim() ?? "";
  const merchant = process.env.PAYPAL_PARTNER_MERCHANT_ID?.trim() ?? "";
  const bn = process.env.PAYPAL_BN_CODE?.trim() ?? "";
  return client && secret && MERCHANT_ID.test(merchant) && bn ? { client, secret, merchant, bn } : null;
}

/** Whether this deployment is an approved PayPal partner, with its credentials set. */
export function paypalSalesConfigured(): boolean {
  return partner() !== null;
}

class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`PayPal ${status} ${code}`);
  }
}

let cached: { token: string; until: number } | null = null;

async function call(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; form?: URLSearchParams; auth?: string; merchant?: string; requestId?: string } = {},
): Promise<Record<string, unknown>> {
  const p = partner();
  if (!p) throw new Error("PayPal selling is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: options.auth ?? `Bearer ${await partnerToken()}`,
        Accept: "application/json",
        "PayPal-Partner-Attribution-Id": p.bn,
        ...(options.merchant ? { "PayPal-Auth-Assertion": authAssertion(p.client, options.merchant) } : {}),
        ...(options.requestId ? { "PayPal-Request-Id": options.requestId } : {}),
        ...(options.body !== undefined ? { "Content-Type": "application/json", Prefer: "return=representation" } : {}),
        ...(options.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      cache: "no-store",
      signal: controller.signal,
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    const object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    const data = (object ? parsed : {}) as Record<string, unknown>;
    // A success whose answer is not a JSON object is not known (CX-123 rule 24): money may have moved, so it is
    // never read as an empty answer. Every caller handles it as it handles a lost answer.
    if (response.ok && !object) throw new PayPalError(response.status, "UNREADABLE");
    if (!response.ok) {
      const details = Array.isArray(data.details) ? (data.details as { issue?: unknown }[]) : [];
      const code = typeof details[0]?.issue === "string" ? details[0].issue : typeof data.name === "string" ? data.name : "UNKNOWN";
      throw new PayPalError(response.status, code);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function partnerToken(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const p = partner() as Partner;
  const data = await call("POST", "/v1/oauth2/token", {
    auth: `Basic ${Buffer.from(`${p.client}:${p.secret}`).toString("base64")}`,
    form: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const token = typeof data.access_token === "string" ? data.access_token : "";
  const seconds = typeof data.expires_in === "number" ? data.expires_in : 0;
  if (!token) throw new Error("PayPal gave no token");
  cached = { token, until: Date.now() + Math.max(0, seconds - 300) * 1000 };
  return token;
}

/** PayPal's unsigned assertion naming the seller a partner acts for (its "PayPal-Auth-Assertion" header). */
export function authAssertion(client: string, merchant: string): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ iss: client, payer_id: merchant })}.`;
}

// ---------------------------------------------------------------- the creator's PayPal

/** The body that opens PayPal's own onboarding for one store (Partner Referrals v2, referral_data). */
export function referralBody(store: Store, returnUrl: string): Record<string, unknown> {
  return {
    tracking_id: String(store.statsId),
    operations: [
      {
        operation: "API_INTEGRATION",
        api_integration_preference: {
          rest_api_integration: {
            integration_method: "PAYPAL",
            integration_type: "THIRD_PARTY",
            third_party_details: { features: ["PAYMENT", "REFUND"] },
          },
        },
      },
    ],
    products: ["EXPRESS_CHECKOUT"],
    legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
    partner_config_override: { return_url: returnUrl, return_url_description: "Back to your Marktmorgen studio" },
  };
}

/** Where to send the creator to connect their PayPal, or null when PayPal would not say. */
export async function onboardingUrl(store: Store, returnUrl: string): Promise<string | null> {
  if (!store.statsId) return null;
  if (store.period?.funded === true && !(await reservePaidResourceWindow(store))) return null;
  const made = await call("POST", "/v2/customer/partner-referrals", { body: referralBody(store, returnUrl) });
  const links = Array.isArray(made.links) ? (made.links as { rel?: unknown; href?: unknown }[]) : [];
  const action = links.find((l) => l.rel === "action_url");
  return typeof action?.href === "string" && action.href.startsWith("https://") ? action.href : null;
}

/**
 * A connect started from this store's studio (app/api/store/paypal/connect), kept a day: the way back from PayPal
 * (app/api/store/paypal/onboarded) is a GET any page can send the creator to, and PayPal answers for the store's
 * tracking id for as long as the creator has not removed Marktmorgen in their PayPal settings. So the way back is
 * taken only while this mark is there: a visit from the browser's history, or from a link on another site, after
 * the creator stopped selling with PayPal (or before they ever asked) connects nothing. Ended by a way back that
 * connected, and by disconnecting. One per store, holding the attempt's own random token: the way back writes the
 * seller only while that same token is still there, read again under the store's write lock
 * (lib/store.ts connectPayPalSellerIf), so a disconnect, or a newer connect, made while PayPal was being asked wins
 * over the older way back (Codex X4 on #4345).
 */
export const ONBOARDING_SECONDS = 86_400;
const onboardingKey = (statsId: string) => `nl:ppsell:start:${statsId}`;
/** An attempt's token: the moment it began (milliseconds, 13 digits) and 32 random hex characters. */
const ATTEMPT = /^(\d{13})-[0-9a-f]{32}$/;
/** When an attempt began, from its token; 0 for one that is not a token. */
export function attemptStartedAt(attempt: string): number {
  const m = ATTEMPT.exec(attempt);
  return m ? Number(m[1]) : 0;
}

/** Writes a new attempt's mark before the creator is sent to PayPal; throws when the write is not confirmed (rule 24). */
export async function markOnboarding(statsId: string): Promise<string> {
  const attempt = `${String(Date.now()).padStart(13, "0")}-${randomBytes(16).toString("hex")}`;
  const set = repliesFor(await redisPipeline([["SET", onboardingKey(statsId), attempt, "EX", ONBOARDING_SECONDS]]), 1);
  if (!set || set[0] !== "OK") throw new UnknownReplyError("a PayPal connect's start");
  return attempt;
}

/**
 * The connect started from the studio: its attempt token, false when none was started, or "unknown" for any reply not
 * exactly GET's (rule 24).
 */
export async function onboardingStarted(statsId: string): Promise<string | false | "unknown"> {
  const read = repliesFor(await redisPipeline([["GET", onboardingKey(statsId)]]), 1);
  if (!read) return "unknown";
  if (read[0] === null) return false;
  return typeof read[0] === "string" && ATTEMPT.test(read[0]) ? read[0] : "unknown";
}

/** Whether this attempt is still the store's current connect: true, false, or "unknown" (rule 24). */
export async function onboardingStill(statsId: string, attempt: string): Promise<boolean | "unknown"> {
  const now = await onboardingStarted(statsId);
  return now === "unknown" ? "unknown" : now === attempt;
}

/**
 * Ends this attempt's own mark after its way back connected: only while the mark still holds this attempt's token, in
 * one script (lib/redis-lock.ts releaseLock: GET and DEL together), so a newer connect started meanwhile keeps its mark
 * and can finish (Codex G on #4345). Never throws; a mark it could not end runs out within ONBOARDING_SECONDS.
 */
export async function endOnboarding(statsId: string, attempt: string): Promise<void> {
  if (!ATTEMPT.test(attempt)) return;
  await releaseLock({ key: onboardingKey(statsId), token: attempt, ttlSeconds: ONBOARDING_SECONDS });
}

/**
 * Ends any connect in progress before a disconnect is written: true only when the DEL's reply is exactly its own
 * (0 or 1). Run before the store's seller is cleared, so a way back still asking PayPal finds no attempt under the
 * store's write lock and writes nothing.
 */
export async function stopOnboarding(statsId: string): Promise<boolean> {
  try {
    const gone = repliesFor(await redisPipeline([["DEL", onboardingKey(statsId)]]), 1);
    return gone !== null && (gone[0] === 0 || gone[0] === 1);
  } catch (error) {
    console.error("ending a PayPal connect's start failed", error);
    return false;
  }
}

export type SellerCheck = { ok: true; merchant: string } | { ok: false; reason: "id" | "email" | "receivable" | "permissions" | "error" };

/**
 * Asks PayPal which account finished onboarding for this store, by the
 * store's own tracking id — never by an id the browser brought back — and
 * checks it: it can be paid, its email address is confirmed, and it granted
 * Marktmorgen the permissions asked for. PayPal's own words for each.
 */
export async function checkSeller(trackingId: string): Promise<SellerCheck> {
  const p = partner();
  if (!p || !trackingId) return { ok: false, reason: "id" };
  const base = `/v1/customer/partners/${encodeURIComponent(p.merchant)}/merchant-integrations`;
  try {
    const found = await call("GET", `${base}?tracking_id=${encodeURIComponent(trackingId)}`);
    const merchant = typeof found.merchant_id === "string" ? found.merchant_id : "";
    if (!MERCHANT_ID.test(merchant)) return { ok: false, reason: "id" };
    const status = await call("GET", `${base}/${encodeURIComponent(merchant)}`);
    if (status.tracking_id !== undefined && status.tracking_id !== trackingId) return { ok: false, reason: "id" };
    // What the seller granted, as a list ([] is nothing granted). Any other answer is unknown: an error to try again,
    // never "permissions not granted" (CX-123 rule 24).
    if (!Array.isArray(status.oauth_integrations)) {
      console.error("PayPal answered a seller's permissions in an unknown shape", merchant);
      return { ok: false, reason: "error" };
    }
    const granted = (status.oauth_integrations as Record<string, unknown>[]).some(
      (o) =>
        o.integration_type === "OAUTH_THIRD_PARTY" &&
        Array.isArray(o.oauth_third_party) &&
        (o.oauth_third_party as Record<string, unknown>[]).some((t) => t.partner_client_id === p.client),
    );
    if (!granted) return { ok: false, reason: "permissions" };
    if (status.primary_email_confirmed !== true) return { ok: false, reason: "email" };
    if (status.payments_receivable !== true) return { ok: false, reason: "receivable" };
    return { ok: true, merchant };
  } catch (error) {
    if (error instanceof PayPalError && error.status === 404) return { ok: false, reason: "id" };
    console.error("checking a PayPal seller failed", error);
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------- what can be sold

/** Whether a product can be sold through PayPal: one-time, one price, and something to hand over. */
export function sellsWithPayPal(product: Listing): boolean {
  if (product.priceCents <= 0 || product.hidden) return false;
  if (product.recurring || product.call || product.pwyw || product.keys || product.options.length > 0) return false;
  // A limited product holds a unit while its buyer pays; that hold is Stripe's checkout's.
  if (product.stock !== null) return false;
  // A bundle whose buyer chooses is bought through the checkout that writes the choice down.
  if (product.bundle) return product.bundle.length >= 2 && !product.pick;
  if (product.course) return product.course.lessons > 0;
  if (product.podcast) return product.podcast.episodes > 0;
  return product.file !== null || product.link !== null;
}

/**
 * The currencies PayPal takes payments in through its REST APIs, with cents
 * where prices here have them (PayPal's currency codes). Every currency a
 * store can sell in today is one; the check keeps it so if one is added.
 */
export const PAYPAL_CURRENCIES: ReadonlySet<string> = new Set(["aud", "cad", "czk", "dkk", "eur", "hkd", "ils", "jpy", "mxn", "nzd", "nok", "php", "pln", "gbp", "sgd", "sek", "chf", "thb", "usd"]);

/** Whether this store takes PayPal right now, for what PayPal can sell. */
export function sellsThroughPayPal(store: Store): boolean {
  return paypalSalesConfigured() && Boolean(store.paypalSeller) && isPaidUp(store) && PAYPAL_CURRENCIES.has(store.currency) && !store.suspended;
}

/**
 * The PayPal account to ask about this store's orders: the connected one, or the one the creator disconnected within
 * PAYPAL_PAST_SECONDS of the disconnection (lib/store.ts, paypalPast). Null when there is neither.
 */
export function paypalMerchant(store: Pick<Store, "paypalSeller" | "paypalPast">, nowMs = Date.now()): string | null {
  if (store.paypalSeller) return store.paypalSeller.merchant;
  return paypalPastWatched(store, nowMs) ? (store.paypalPast?.merchant ?? null) : null;
}

/** Whether PayPal is disconnected but its orders are still asked about (paypalMerchant). */
export function paypalPastWatched(store: Pick<Store, "paypalSeller" | "paypalPast">, nowMs = Date.now()): boolean {
  const past = store.paypalPast;
  return !store.paypalSeller && Boolean(past) && nowMs >= (past?.at ?? 0) && nowMs < (past?.at ?? 0) + PAYPAL_PAST_SECONDS * 1000;
}

/**
 * How many orders of a store with PayPal disconnected still wait on PayPal to confirm the payment, for the studio's
 * notice: one ZCARD, read exactly. Null when PayPal is connected, past its window, or the answer is not a count.
 */
export async function paypalOrdersWaiting(store: Pick<Store, "statsId" | "paypalSeller" | "paypalPast">): Promise<number | null> {
  if (!store.statsId || !paypalPastWatched(store) || !isRedisConfigured()) return null;
  const read = repliesFor(await redisPipeline([["ZCARD", pendingKey(store.statsId)]]), 1);
  return read && typeof read[0] === "number" && Number.isSafeInteger(read[0]) && read[0] >= 0 ? read[0] : null;
}

/**
 * How many orders a store has left on its three PayPal lists (pending payments, paid orders watched for a refund,
 * paid orders owed their hand-over): three ZCARD in one round trip, read exactly. Null when any answer is not a count.
 */
export async function paypalOrdersLeft(statsId: string): Promise<number | null> {
  const read = repliesFor(await redisPipeline([["ZCARD", pendingKey(statsId)], ["ZCARD", watchKey(statsId)], ["ZCARD", handOverKey(statsId)]]), 3);
  if (!read || !read.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  return (read as number[]).reduce((a, b) => a + b, 0);
}

/** An order canceled because PayPal never confirmed its payment (watchPayPal), as its notices say it. */
export type CanceledOrder = {
  order: string;
  /** The store's stats id and handle, when it was canceled. */
  store: string;
  handle: string;
  product: string;
  cents: number;
  currency: string;
  /** The buyer's PayPal address, as PayPal's order gave it; null when it gave none. */
  email: string | null;
  /** "pending": PayPal still held the payment as pending; "none": no payment was taken. */
  charged: "pending" | "none";
  /** When it was canceled, in seconds. */
  at: number;
};

/**
 * What telling a buyer came to: the sender's own outcome (lib/email.ts, SendOutcome), or "none" when there is no one to
 * write to. Only "refused" (certainly not sent) is tried again; "uncertain" may have gone, so it is never sent twice.
 */
export type TellOutcome = "sent" | "refused" | "uncertain" | "none";
/** Who a notice of a canceled order is for: both at the cancellation, then each on its own while refused. */
export type TellWho = "both" | "buyer" | "creator";
/** What telling came to, for each side; "none" for a side not asked this time. */
export type TellOutcomes = { buyer: TellOutcome; creator: TellOutcome };

/** A canceled order's mark, read exactly (CX-123 rule 24): null when there is none; throws when it does not read. */
async function readCanceled(order: string): Promise<CanceledOrder | null> {
  const read = repliesFor(await redisPipeline([["GET", canceledKey(order)]]), 1);
  if (!read || (read[0] !== null && typeof read[0] !== "string")) throw new UnknownReplyError("a canceled PayPal order");
  if (read[0] === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(read[0]);
  } catch {
    throw new UnknownReplyError("a canceled PayPal order");
  }
  const c = v as Partial<CanceledOrder>;
  if (
    !c || typeof c !== "object" || c.order !== order || typeof c.store !== "string" || typeof c.handle !== "string" || typeof c.product !== "string" ||
    !Number.isSafeInteger(c.cents) || typeof c.currency !== "string" || (c.email !== null && typeof c.email !== "string") ||
    (c.charged !== "pending" && c.charged !== "none") || !Number.isSafeInteger(c.at)
  ) {
    throw new UnknownReplyError("a canceled PayPal order");
  }
  return c as CanceledOrder;
}

/**
 * Whether this store's PayPal order was canceled because PayPal never confirmed its payment, for the page its buyer
 * comes back to (app/[handle]/thanks/page.tsx): what was taken, or null. One GET; throws when it does not read.
 */
export async function canceledFor(store: Pick<Store, "statsId">, order: string): Promise<{ charged: CanceledOrder["charged"] } | null> {
  if (!ORDER_ID.test(order) || !store.statsId || !isRedisConfigured()) return null;
  const c = await readCanceled(order);
  return c && c.store === store.statsId ? { charged: c.charged } : null;
}

/** Who takes the payment, in the words the store's pages use. */
export function takenBy(stripe: boolean, paypal: boolean): string {
  return stripe && paypal ? "Stripe or PayPal" : paypal ? "PayPal" : "Stripe";
}

/** Whether this store takes PayPal for this product right now. */
export function paypalReady(store: Store, product: Listing): boolean {
  // The same plan that opens the Stripe till opens this one.
  return sellsThroughPayPal(store) && sellsWithPayPal(product);
}

/**
 * The percentage off PayPal takes for this visitor: the store's sale or the fair price for the country their
 * connection is in (store.visitorCountry, from the edge, lib/visitor.ts), whichever is larger, never both — what
 * the product page shows (components/store-product.tsx, offNow) and the Stripe checkout takes off.
 */
function payPalOff(store: Store, product: Listing, nowSeconds: number): { sale: number; fair: number } {
  const sale = saleOff(store.sale, product, nowSeconds);
  const fair = fairOff(store.fair, product, store.visitorCountry ?? "");
  return fair > sale ? { sale: 0, fair } : { sale, fair: 0 };
}

/** The price PayPal is asked for: the product's, less the store's sale or the visitor's fair price. */
export function payPalPrice(store: Store, product: Listing, nowSeconds = Math.floor(Date.now() / 1000)): number {
  const off = payPalOff(store, product, nowSeconds);
  return salePrice(product.priceCents, off.sale || off.fair);
}

/** The order PayPal is sent (checkout_orders_v2, order_request): the creator's account is the payee. */
export function orderBody(store: Store, product: Listing, cents: number, urls: { returnUrl: string; cancelUrl: string }): Record<string, unknown> {
  return {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: product.id,
        custom_id: `${store.statsId}:${product.id}`.slice(0, 127),
        description: product.title.slice(0, 127),
        amount: { currency_code: store.currency.toUpperCase(), value: plainAmount(cents, store.currency) },
        payee: { merchant_id: store.paypalSeller?.merchant ?? "" },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: store.name.slice(0, 127),
          locale: "en-US",
          shipping_preference: "NO_SHIPPING",
          user_action: "PAY_NOW",
          return_url: urls.returnUrl,
          cancel_url: urls.cancelUrl,
        },
      },
    },
  };
}

/** An order opened: store, handle, product, cents, currency, the creator's PayPal, and when. */
/**
 * An order opened: the store, the product, the price asked, the merchant, when;
 * and what the visit carried, as a Stripe checkout carries it in its
 * metadata: the channel (lib/visit-channel.ts), the affiliate and their
 * share (lib/affiliates.ts), and what the store sale (with its percent) or the
 * visitor's fair price (noted as meta.fair, its percent only, "50") took off.
 */
type Opened = {
  s: string;
  h: string;
  p: string;
  c: number;
  cur: string;
  m: string;
  at: number;
  meta?: Record<string, string>;
  via?: { aff: string; rate: number };
  off?: number;
  sale?: number;
};

/** What a visit carried into an order, read by the checkout route. */
export type OrderExtras = {
  meta?: Record<string, string>;
  via?: { aff: string; rate: number } | null;
  /** The buyer's yes to start access at once (lib/digital-consent.ts): everything PayPal sells here is handed over digitally, so it is needed. */
  digitalConsent?: DigitalConsent | null;
};

const META_KEY = /^[a-z_]{1,40}$/;
/** The metadata kept on an order: short keys and values only, as Stripe would take them. Pure. */
export function cleanMeta(meta: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (META_KEY.test(key) && typeof value === "string" && Object.keys(out).length < 20) out[key] = value.slice(0, 200);
  }
  return out;
}

export type OrderResult = { ok: true; url: string; order: string } | { ok: false; reason: "unavailable" | "error" | "paused" | "consent" };

/** Opens a PayPal order for one product and returns where the buyer approves it. */
export async function openOrder(store: Store, product: Listing, origin: string, extras: OrderExtras = {}): Promise<OrderResult> {
  if (!paypalReady(store, product) || !store.statsId || !store.paypalSeller || !isRedisConfigured()) return { ok: false, reason: "unavailable" };
  // Refused before an order is admitted or PayPal is asked (lib/digital-consent.ts).
  const digital = deliversDigitally(product);
  if (digital && !validConsent(extras.digitalConsent)) return { ok: false, reason: "consent" };
  // One of the month's orders: a paid store's stop at its plan's figure (lib/order-admission.ts),
  // before PayPal's page opens.
  const admitted = await admitOrders(store, 1);
  if (!admitted.ok) return { ok: false, reason: admitted.reason === "paused" ? "paused" : "error" };
  const at = Math.floor(Date.now() / 1000);
  const cents = payPalPrice(store, product, at);
  const returnUrl = `${origin}/api/store/paypal/return?store=${encodeURIComponent(store.handle)}`;
  const cancelUrl = `${origin}/@${store.handle}/p/${product.id}`;
  try {
    const made = await call("POST", "/v2/checkout/orders", {
      body: orderBody(store, product, cents, { returnUrl, cancelUrl }),
      requestId: `nl-${store.statsId}-${product.id}-${Date.now().toString(36)}`,
    });
    const order = typeof made.id === "string" ? made.id : "";
    const links = Array.isArray(made.links) ? (made.links as { rel?: unknown; href?: unknown }[]) : [];
    const approve = links.find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!ORDER_ID.test(order) || typeof approve?.href !== "string" || !approve.href.startsWith("https://")) return { ok: false, reason: "error" };
    // Which discount it was, as a Stripe checkout notes it (metadata[sale] or metadata[fair]). A fair price keeps
    // its percent only, never the country: the privacy policy (#fair-prices) says the country is not stored.
    const { sale: salePercent, fair: fairPercent } = payPalOff(store, product, at);
    const fairNote: Record<string, string> = fairPercent > 0 ? { fair: String(fairPercent) } : {};
    const opened: Opened = {
      s: store.statsId,
      h: store.handle,
      p: product.id,
      c: cents,
      cur: store.currency,
      m: store.paypalSeller.merchant,
      at: Math.floor(Date.now() / 1000),
      // The yes first, so the cap on kept fields can never leave it out.
      meta: cleanMeta(digital && extras.digitalConsent ? { [CONSENT_META]: consentMetaValue(extras.digitalConsent, "digital"), ...fairNote, ...extras.meta } : { ...fairNote, ...extras.meta }),
      ...(extras.via && /^[a-z0-9]{12}$/.test(extras.via.aff) ? { via: { aff: extras.via.aff, rate: Math.max(0, Math.min(100, Number(extras.via.rate) || 0)) } } : {}),
      ...(salePercent > 0 ? { off: Math.max(0, product.priceCents - cents), sale: salePercent } : fairPercent > 0 ? { off: Math.max(0, product.priceCents - cents) } : {}),
    };
    await redisPipeline([["SET", orderKey(order), JSON.stringify(opened), "EX", PAYPAL_OPEN_ORDER_SECONDS]]);
    return { ok: true, url: approve.href, order };
  } catch (error) {
    console.error("opening a PayPal order failed", error);
    return { ok: false, reason: "error" };
  }
}

/** A PayPal order paid: the store's stats id, the capture, the buyer's PayPal address, what and how much, when. */
export type Paid = {
  store: string;
  order: string;
  capture: string;
  email: string;
  product: string;
  cents: number;
  currency: string;
  at: number;
  /** Added 13 October 2026; absent on orders paid before: the store's handle, and what the visit carried (Opened). */
  handle?: string;
  meta?: Record<string, string>;
  via?: { aff: string; rate: number };
  off?: number;
  sale?: number;
  /**
   * The creator's PayPal account the order was paid to (added 12 November 2026; absent on orders paid before): the
   * refund watch reads the capture as that account, whatever account the store has connected since.
   */
  m?: string;
};
export type CaptureResult =
  | { ok: true; paid: Paid; fresh: boolean }
  /** "confirming": another return of the same order holds its last try right now (captureOrder's "spent"). */
  | { ok: false; reason: "unknown" | "pending" | "declined" | "mismatch" | "error" | "confirming" };

/** Whether PayPal is still being waited on for an order this store opened. */
export async function stillPending(store: Store, order: string): Promise<boolean> {
  if (!ORDER_ID.test(order) || !store.statsId || !isRedisConfigured()) return false;
  // null is not waited on; the mark's score is whole seconds, as watchLater writes it. Anything else is unknown, never
  // "not waited on" (CX-123 rule 24): the caller says it could not check.
  const read = repliesFor(await redisPipeline([["ZSCORE", pendingKey(store.statsId), order]]), 1);
  const score = read?.[0];
  if (!read || (score !== null && (typeof score !== "string" || !REDIS_SCORE.test(score)))) throw new UnknownReplyError("a PayPal order's pending mark");
  return score !== null;
}

/**
 * Whether PayPal was seen refunding this order in full (its mark in refundedKey, written by the refund watch), read
 * exactly (CX-123 rule 24): null is not seen; a score of whole seconds, as the watch writes it, is seen; anything else
 * throws UnknownReplyError.
 */
export async function refundSeen(statsId: string, order: string): Promise<boolean> {
  const read = repliesFor(await redisPipeline([["ZSCORE", refundedKey(statsId), order]]), 1);
  if (!read || (read[0] !== null && (typeof read[0] !== "string" || !REDIS_SCORE.test(read[0])))) throw new UnknownReplyError("a PayPal order's refund mark");
  return read[0] !== null;
}

/**
 * A paid order's record: null only when Redis answered that there is none. A reply in another envelope, text that
 * is not JSON, or a record that is not this order's throws UnknownReplyError, never "no such order" (CX-123 rule 24).
 */
export async function readPaid(order: string): Promise<Paid | null> {
  if (!ORDER_ID.test(order) || !isRedisConfigured()) return null;
  const read = repliesFor(await redisPipeline([["GET", paidKey(order)]]), 1);
  if (!read) throw new UnknownReplyError("a PayPal order's payment");
  if (read[0] === null) return null;
  const record = jsonObject(read[0]);
  if (!record || record.order !== order || typeof record.store !== "string") throw new UnknownReplyError("a PayPal order's payment");
  return record as unknown as Paid;
}

/** Text that is a JSON object, as that object; anything else null. */
function jsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A paid order read exactly, for the refund watch (Codex G on #2791; CX-123 rules 24 and 30): null only when Redis
 * answered that there is no record; a reply in another envelope, text that is not JSON, or a record without its own
 * order, email, product, capture and time is "unknown", never "no record".
 */
export async function readPaidExact(order: string): Promise<Paid | null | "unknown"> {
  if (!ORDER_ID.test(order)) return null;
  const read = repliesFor(await redisPipeline([["GET", paidKey(order)]]), 1);
  return read ? paidFrom(read[0], order) : "unknown";
}

/** A paid order's record as GET answers it, read exactly as readPaidExact reads it: null for none, "unknown" for anything else. */
function paidFrom(raw: unknown, order: string): Paid | null | "unknown" {
  if (raw === null) return null;
  if (typeof raw !== "string") return "unknown";
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return "unknown";
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "unknown";
  const r = v as Record<string, unknown>;
  // Each field the watch acts on in its own format (Codex G on #2791): an address as sign-in reads one, a product id,
  // a capture id and a whole positive time in seconds. Anything else would look under the wrong key or end the watch
  // early, so it is unknown.
  const matches = (key: string, pattern: RegExp) => typeof r[key] === "string" && pattern.test(r[key] as string);
  if (
    r.order !== order ||
    !matches("email", EMAIL_PATTERN) ||
    !matches("product", PAID_PRODUCT_ID) ||
    !matches("capture", CAPTURE_ID) ||
    !Number.isSafeInteger(r.at) ||
    (r.at as number) <= 0 ||
    typeof r.store !== "string" ||
    !r.store ||
    !Number.isSafeInteger(r.cents) ||
    (r.cents as number) < 0 ||
    !matches("currency", /^[A-Za-z]{3}$/)
  ) {
    return "unknown";
  }
  return v as Paid;
}

/**
 * A person's paid PayPal orders for these products, for the copy of their
 * data (619 [SZ3], lib/person-copy.ts): kept on purpose as the order's
 * record (lib/person-data.ts). Only reads.
 */
export async function paypalOrdersOf(statsId: string | null, productIds: string[], email: string): Promise<Paid[]> {
  if (!statsId || !productIds.length || !isRedisConfigured()) return [];
  // One set of order ids for each product ([] when none): any other reply, or a member that is not an order id, is
  // unknown, and the copy fails rather than leave an order out (CX-123 rule 24).
  const sets = repliesFor(await redisPipeline(productIds.map((p) => ["SMEMBERS", ownKey(statsId, email, p)])), productIds.length)?.map(stringList);
  if (!sets || sets.some((set) => !set || set.some((o) => !ORDER_ID.test(o)))) throw new UnknownReplyError("a person's PayPal orders");
  const orders = [...new Set((sets as string[][]).flat())];
  const out: Paid[] = [];
  for (const order of orders) {
    const paid = await readPaidExact(order);
    if (paid === "unknown") throw new UnknownReplyError("a person's PayPal order");
    if (paid) out.push(paid);
  }
  return out;
}

/**
 * An order's own record, read exactly (rule 24): null only when GET answers exactly null (never opened here, or its
 * 30 days are over); a reply cut short or of another shape, or a record that does not read, is "unknown", never
 * expired: the watch keeps such an order and the capture refuses it, both for now.
 */
async function readOpened(order: string): Promise<Opened | null | "unknown"> {
  const read = repliesFor(await redisPipeline([["GET", orderKey(order)]]), 1);
  return read ? openedFrom(read[0]) : "unknown";
}

/**
 * An order's record and how many times its capture was asked for (watchFirst), in one round trip, for captureOrder:
 * a return past CAPTURE_TRIES_PER_ORDER then writes nothing at all. The count read exactly (rule 24): none is 0, a
 * string of digits is that number; anything else, or no answer, is "unknown", never 0.
 */
async function readOpenedAndTries(order: string): Promise<{ opened: Opened | null | "unknown"; tries: number | "unknown" }> {
  const read = repliesFor(await redisPipeline([["GET", orderKey(order)], ["GET", tryKey(order)]]), 2);
  if (!read) return { opened: "unknown", tries: "unknown" };
  const count = read[1];
  const tries = count === null ? 0 : typeof count === "string" && /^[0-9]{1,15}$/.test(count) ? Number(count) : "unknown";
  return { opened: openedFrom(read[0]), tries };
}

/** An order's record as GET answers it: null when there is none, "unknown" for anything that does not read as one. */
function openedFrom(raw: unknown): Opened | null | "unknown" {
  if (raw === null) return null;
  if (typeof raw !== "string") return "unknown";
  try {
    const opened = JSON.parse(raw) as Opened | null;
    return opened && typeof opened === "object" && typeof opened.s === "string" ? opened : "unknown";
  } catch {
    return "unknown";
  }
}

type CaptureRow = { id?: unknown; status?: unknown; amount?: { value?: unknown; currency_code?: unknown }; links?: unknown };

/**
 * Whether an Orders v2 answer is this order's own (#4444, Codex X8): its `id` is the order asked about, and every
 * capture in it whose `up` link names an order names this one. Amount, currency and payee alone do not tell two orders
 * of the same price apart, so an answer holding another order's completed record would otherwise confirm this one with
 * that order's capture and buyer. An `up` link that is there but does not name exactly this order's Orders v2 path
 * (no href, not text, another URL) is not proof either. An answer that is not this order's says nothing about it: its
 * outcome is unknown.
 */
function ownAnswer(done: Record<string, unknown>, order: string): boolean {
  if (done.id !== order) return false;
  const units = Array.isArray(done.purchase_units) ? (done.purchase_units as { payments?: { captures?: unknown } }[]) : [];
  for (const unit of units) {
    const captures = Array.isArray(unit?.payments?.captures) ? (unit.payments.captures as CaptureRow[]) : [];
    for (const capture of captures) {
      const links = Array.isArray(capture?.links) ? (capture.links as { rel?: unknown; href?: unknown }[]) : [];
      for (const link of links) {
        if (link?.rel !== "up") continue;
        // A capture with no links at all is allowed by the API's shape; an `up` link present is declared evidence, so
        // it must be text whose path is exactly this order's (Codex g's MÉDIO on #4453). Anything else is unknown.
        if (typeof link.href !== "string") return false;
        let path: string;
        try {
          path = new URL(link.href).pathname;
        } catch {
          return false;
        }
        if (path !== `/v2/checkout/orders/${order}`) return false;
      }
    }
  }
  return true;
}

/** The capture an order holds, and who paid it, as PayPal describes an order (checkout_orders_v2, order). */
function captureIn(done: Record<string, unknown>): { capture: CaptureRow | null; payee: unknown; email: string } {
  const unit = (Array.isArray(done.purchase_units) ? done.purchase_units[0] : null) as {
    payee?: { merchant_id?: unknown };
    payments?: { captures?: CaptureRow[] };
  } | null;
  const payer = (done.payer ?? {}) as { email_address?: unknown };
  return {
    capture: unit?.payments?.captures?.[0] ?? null,
    payee: unit?.payee?.merchant_id,
    email: typeof payer.email_address === "string" ? payer.email_address.trim().toLowerCase() : "",
  };
}

/** Whether a capture took exactly what the order asked, into the creator's account. */
function matches(opened: Opened, capture: CaptureRow, payee: unknown): boolean {
  return (
    String(capture.amount?.value ?? "") === plainAmount(opened.c, opened.cur) &&
    String(capture.amount?.currency_code ?? "").toLowerCase() === opened.cur &&
    (payee === undefined || payee === opened.m)
  );
}

/**
 * How long an order whose capture was asked for may be kept for the sweep to ask PayPal about, counted from its
 * opening, never from a later try (one rule for the record's ceiling, with the sweep's own; Claude 5).
 */
const ORDER_KEPT_FROM_OPENING_SECONDS = 30 * 86_400;

/**
 * The room PayPal is asked to take a payment with: a day before the record's ceiling at least (Claude 5's second money
 * review of #3411, MEDIUM). With less, a ceiling passing between the check here and the renewal reaching Redis ends the
 * record while Redis still answers 1, and a payment taken and then not written down would leave the sweep no record to
 * write it from. A day is far above the capture's own calls (TIMEOUT_MS each) and the longest a function runs, and
 * leaves the sweep, every few minutes, many rounds to write a taken payment down before the record ends.
 */
const CAPTURE_ROOM_SECONDS = 86_400;

/**
 * How long an order PayPal may have taken a payment for is kept from the answer, when that answer comes back after the
 * record's ceiling (watchLater). Shorter than CAPTURE_ROOM_SECONDS by far more than any function runs, so an answer to a
 * capture asked with its room always keeps the ceiling itself; only an answer held past a day reaches this.
 */
const KEPT_AFTER_LATE_ANSWER_SECONDS = 6 * 3_600;

/**
 * The most times PayPal is asked to take one order's payment (Claude 7's cost MEDIUM on #3411): the return route is held
 * per connection and store, not per order, so a buyer reloading it, or a script replaying it from many addresses, would
 * otherwise send the watch and a capture each time, for as long as the record lives. Three is the first return and two
 * reloads; PayPal's own request id makes each a repeat of the first, so a later one never takes more. A return past
 * them asks PayPal nothing and puts nothing in pending: an order a try left there stays for the sweep (watchPayPal),
 * which reads PayPal's order and writes down a payment it completes. Priced in tests/plan-cost-registry.ts
 * (PAYPAL_CAPTURE_WATCH).
 */
export const CAPTURE_TRIES_PER_ORDER = 3;

/**
 * When an order's record ends at the latest, in unix seconds: thirty days from its opening (`opened.at`, whole seconds,
 * as openOrder writes it). A record without such a time is not known (rule 24): it throws, and PayPal is not asked.
 */
function keptUntil(opened: Opened): number {
  if (!Number.isSafeInteger(opened.at) || opened.at <= 0) throw new UnknownReplyError("a PayPal order's opening time");
  return opened.at + ORDER_KEPT_FROM_OPENING_SECONDS;
}

/**
 * Keeps an order PayPal has not settled for the sweep to ask about, until thirty days from its opening. It runs only
 * after PayPal was asked, when the payment may have been taken, so it never lets the record end (Claude 5's second
 * money review of #3411): an answer that comes back after that ceiling, which the day's room before asking
 * (CAPTURE_ROOM_SECONDS) leaves to a function held past a day, keeps the record KEPT_AFTER_LATE_ANSWER_SECONDS from the
 * answer instead, so the sweep can still write down a payment PayPal completes. Ending the record there could leave a
 * charged buyer with nothing written down; keeping it a few hours more holds no more than the order already held.
 */
async function watchLater(order: string, opened: Opened): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const until = Math.max(keptUntil(opened), now + KEPT_AFTER_LATE_ANSWER_SECONDS);
  await redisPipeline([
    ["SET", orderKey(order), JSON.stringify(opened), "EXAT", String(until)],
    ["ZADD", pendingKey(opened.s), String(now), order],
  ]);
}

/**
 * Puts an order in pending before PayPal is asked to take its payment (Claude 6's second money review of #3385,
 * MEDIUM, probe A): whatever happens after PayPal takes it (the step that writes it down not reaching Redis, its
 * answer lost), the sweep has the order to ask PayPal about and write down (watchPayPal), and settle's script takes it
 * off pending with the same step that writes it down. In the same step the order's record is renewed until thirty
 * days from its opening, as watchLater keeps it (Claude 3's first money review of #3404, LOW 1; one rule for the
 * ceiling, Claude 5): the sweep reads the order by its record and lets go of an entry whose record has ended, so a
 * capture asked for late in the record's first three days keeps it as long as the sweep may need it, and never past
 * thirty days from the opening. PayPal is asked only with a day's room before them (CAPTURE_ROOM_SECONDS; Claude 5's
 * second money review of #3411): with less, nothing is sent and the order is "gone". Both answers read exactly
 * (rule 24): the ZADD 0 or 1 and the EXPIREAT 1 or 0; anything else, or no answer, throws, and PayPal is not asked to
 * take anything, so a buyer is never charged for an order the sweep could not find. "gone" when the EXPIREAT answers 0
 * (the record ended since it was read: PayPal is not asked, and the sweep lets go of the entry), "added" when this call
 * put it in pending (1), "there" when it was there already (0: watched by an earlier try, whose outcome this one does
 * not know).
 *
 * The try is counted first, in a step of its own, and only an admitted try writes anything more (Codex X2's MEDIUM 2
 * and Claude 5's MEDIUM on #3411): the INCR of the order's count, read exactly (a whole number from 1), and that
 * count's EXPIREAT to the same ceiling (1, since the INCR just wrote it); past CAPTURE_TRIES_PER_ORDER the answer is
 * "spent", and the order is neither put in pending nor its record renewed, so returns that all read the count before
 * any of them counted (functions run at once) never write more than the admitted tries do, and a refused one never
 * puts back in pending an order a refusal has just taken off it. A count that does not read throws, as above: PayPal
 * is not asked and nothing more is written. A count taken whose next step then fails spends a try without asking
 * PayPal: fewer captures, never more. Two commands a try counted, two more a try admitted (Upstash: COMMAND in
 * tests/plan-cost-registry.ts, PAYPAL_CAPTURE_WATCH): CAPTURE_TRIES_PER_ORDER admitted tries inside the order's own
 * work (ORDER_COMPUTE, line "orders"), and the count alone for a refused return, priced per return beside the reads
 * every return sends; the record's thirty days are in tests/store-data-registry.ts (nl:ppsell:o:), and the count's
 * (nl:ppsell:try:).
 */
async function watchFirst(order: string, opened: Opened): Promise<"added" | "there" | "gone" | "spent"> {
  const until = keptUntil(opened);
  if (Math.floor(Date.now() / 1000) + CAPTURE_ROOM_SECONDS >= until) return "gone";
  const counted = repliesFor(
    await redisPipeline([
      ["INCR", tryKey(order)],
      ["EXPIREAT", tryKey(order), String(until)],
    ]),
    2,
  );
  if (!counted || typeof counted[0] !== "number" || !Number.isSafeInteger(counted[0]) || counted[0] < 1 || counted[1] !== 1) {
    throw new UnknownReplyError("counting a PayPal order's capture tries");
  }
  if (counted[0] > CAPTURE_TRIES_PER_ORDER) return "spent";
  const replies = repliesFor(
    await redisPipeline([
      ["ZADD", pendingKey(opened.s), String(Math.floor(Date.now() / 1000)), order],
      ["EXPIREAT", orderKey(order), String(until)],
    ]),
    2,
  );
  if (!replies || (replies[0] !== 0 && replies[0] !== 1) || (replies[1] !== 0 && replies[1] !== 1)) {
    throw new UnknownReplyError("putting a PayPal order in pending before its capture");
  }
  if (replies[1] === 0) return "gone";
  return replies[0] === 1 ? "added" : "there";
}

/**
 * Where an order stands once its tries are spent (Codex X2's MEDIUM 1, Claude 5's LEVE on #3411): paid since it was
 * read (settle took it off pending), still in pending (a capture PayPal may hold, under the sweep's watch), or neither
 * (every try refused and let go of, or let go of by the sweep: nothing under watch). One round trip, two reads, each
 * read exactly (rule 24): the ZSCORE null or a score of whole seconds, as the watch writes it; the paid record as
 * readPaidExact reads it. Anything else throws: an unknown answer is taken for neither, and nothing is written.
 */
async function standing(order: string, opened: Opened): Promise<CaptureResult> {
  const read = repliesFor(await redisPipeline([["ZSCORE", pendingKey(opened.s), order], ["GET", paidKey(order)]]), 2);
  if (!read || (read[0] !== null && (typeof read[0] !== "string" || !REDIS_SCORE.test(read[0])))) {
    throw new UnknownReplyError("where a PayPal order stands after its tries");
  }
  const paid = paidFrom(read[1], order);
  if (paid === "unknown") throw new UnknownReplyError("where a PayPal order stands after its tries");
  if (paid) return { ok: true, paid, fresh: false };
  return read[0] !== null ? { ok: false, reason: "pending" } : { ok: false, reason: "unknown" };
}

/** Writes a completed payment down, once. Returns it, and whether this call wrote it. */
async function settle(order: string, opened: Opened, captureId: string, email: string): Promise<{ paid: Paid; fresh: boolean }> {
  const paid: Paid = {
    store: opened.s,
    order,
    capture: captureId,
    email,
    product: opened.p,
    cents: opened.c,
    currency: opened.cur,
    at: Math.floor(Date.now() / 1000),
    handle: opened.h,
    ...(MERCHANT_ID.test(opened.m) ? { m: opened.m } : {}),
    ...(opened.meta ? { meta: opened.meta } : {}),
    ...(opened.via ? { via: opened.via } : {}),
    ...(opened.off ? { off: opened.off, sale: opened.sale } : {}),
  };
  // The record and every list it belongs in, written in one step (PAYPAL_SETTLE): a paid order is never written down
  // and left in no list, whatever reaches Redis or comes back from it. The answer read exactly (rule 24): 1 written
  // here, 0 written before; anything else is unknown and thrown, never taken for either, and the next try finds the
  // payment either written with every list or not written at all (the capture itself is asked again under its own
  // request id).
  const wrote = repliesFor(
    await redisPipeline([[
      "EVAL", PAYPAL_SETTLE, 6,
      paidKey(order), handOverKey(opened.s), watchKey(opened.s), ownKey(opened.s, email, opened.p), pendingKey(opened.s), salesKey(opened.s),
      JSON.stringify(paid), PAID_KEPT_SECONDS, order, String(paid.at), String(nextLook(paid.at, paid.at) ?? paid.at),
      String(paid.at - SALES_KEPT_SECONDS), SALES_KEPT_SECONDS,
    ]]),
    1,
  );
  if (!wrote || (wrote[0] !== 0 && wrote[0] !== 1)) throw new UnknownReplyError("writing a PayPal payment down");
  if (wrote[0] === 0) return { paid: (await readPaid(order)) ?? paid, fresh: false };
  return { paid, fresh: true };
}

/**
 * Takes the payment the buyer approved, once, and checks it is what was
 * asked: this store's order, the creator's account as payee, the price in
 * full. Returns the purchase, and whether this call is the one that took it.
 *
 * A payment PayPal holds as pending (an eCheck, a review) is not handed over:
 * it is watched (watchPayPal) and handed over when PayPal completes it.
 */
export async function captureOrder(store: Store, order: string): Promise<CaptureResult> {
  if (!ORDER_ID.test(order) || !store.statsId || !isRedisConfigured()) return { ok: false, reason: "unknown" };
  let already: Paid | null = null;
  try {
    already = await readPaid(order);
  } catch (error) {
    // Unknown is not "not paid": nothing is taken on it (CX-123 rule 24), and the buyer is told it did not go through.
    if (!(error instanceof UnknownReplyError)) throw error;
    console.error("a PayPal order could not be read before taking it", order, error);
    return { ok: false, reason: "unknown" };
  }
  if (already) return { ok: true, paid: already, fresh: false };
  const { opened, tries } = await readOpenedAndTries(order);
  if (!opened || opened === "unknown" || opened.s !== store.statsId || tries === "unknown") return { ok: false, reason: "unknown" };
  // Asked for as many times as an order may be (CAPTURE_TRIES_PER_ORDER; Claude 7's cost MEDIUM on #3411): PayPal is not
  // asked again and nothing is written. Only an order still in pending goes to the thanks page, where the sweep writes
  // down a payment PayPal completes; one every try was refused for, or the sweep let go of, has nothing under watch,
  // so the buyer is shown the store's notice rather than told PayPal is still taking it (Codex X2's MEDIUM 1, Claude
  // 5's LEVE on #3411); one paid since it was read is shown as paid.
  // A reply that does not read here, or in watchFirst below, takes nothing and writes nothing: the buyer is told it did
  // not go through (the store's notice), never shown a server error (Claude 1's LOW 1 on #3411; CX-123 rule 24).
  const unread = (error: unknown, what: string): CaptureResult => {
    if (!(error instanceof UnknownReplyError)) throw error;
    console.error(`a PayPal order's ${what} could not be read`, order, error);
    return { ok: false, reason: "unknown" };
  };
  if (tries >= CAPTURE_TRIES_PER_ORDER) return standing(order, opened).catch((error) => unread(error, "standing"));
  // Watched first: no capture is asked for an order the sweep could not find (watchFirst throws on anything unknown,
  // and a record ended since it was read, or less than a day from thirty past its opening, is no order to take a payment
  // for).
  let watched: Awaited<ReturnType<typeof watchFirst>>;
  try {
    watched = await watchFirst(order, opened);
  } catch (error) {
    return unread(error, "watch");
  }
  if (watched === "gone") return { ok: false, reason: "unknown" };
  // Two returns at once can both read a count under the bound; the count this step took decides (the INCR), so PayPal
  // is never asked more than CAPTURE_TRIES_PER_ORDER times an order, as above, and a refused one wrote nothing past its
  // count. A refused return proves no capture is under watch: the one that took the last try may not have written the
  // order to pending yet, or may never (Codex X5 on #3411). So it is told it did not go through, never sent to the
  // thanks page; the path that read the count at the bound keeps asking where the order stands (standing).
  // The buyer is told it is being confirmed, never that it could not be matched or that nothing was handed over: the
  // return that took the last try is usually this buyer's own other load, taking the payment now (Claude 5's LOW).
  if (watched === "spent") return { ok: false, reason: "confirming" };
  const watchedHere = watched === "added";
  let done: Record<string, unknown>;
  try {
    done = await call("POST", `/v2/checkout/orders/${encodeURIComponent(order)}/capture`, { body: {}, merchant: opened.m, requestId: `nl-capture-${order}` });
  } catch (error) {
    // PayPal's words for a payment it would not take (Orders v2 errors): nothing was charged. Put in pending by this
    // call only, it holds no capture the sweep could ever find, so it is let go of pending (a removal that fails
    // leaves it to the sweep, which lets it go when its record ends); the buyer approving again comes back here and is
    // watched again. Already there before this call (an earlier try whose answer was lost), it stays for the sweep.
    if (error instanceof PayPalError && DECLINED.has(error.code)) {
      if (watchedHere) await redisPipeline([["ZREM", pendingKey(opened.s), order]]).catch((again) => console.error("letting go of a declined PayPal order failed", again));
      return { ok: false, reason: "declined" };
    }
    // Anything else — taken already by a request that did not get to write it
    // down, or an answer lost on the way — is settled by PayPal's order itself.
    console.error("capturing a PayPal order failed", error);
    try {
      done = await call("GET", `/v2/checkout/orders/${encodeURIComponent(order)}`, { merchant: opened.m });
    } catch (again) {
      console.error("reading a PayPal order failed", again);
      done = {};
    }
    if (!captureIn(done).capture) {
      await watchLater(order, opened);
      return { ok: false, reason: "error" };
    }
  }
  // An answer that is not this order's own (another order's record) proves nothing about this one: unknown, kept in
  // pending for the sweep to ask PayPal again, nothing written down or handed over (#4444, rule 30).
  if (!ownAnswer(done, order)) {
    console.error("a PayPal answer named another order", order);
    await watchLater(order, opened);
    return { ok: false, reason: "error" };
  }
  const { capture, payee, email } = captureIn(done);
  // Taken, but the answer does not say how: the buyer may have paid, so the sweep asks PayPal again (CX-123 rule 24).
  if (!capture) {
    await watchLater(order, opened);
    return { ok: false, reason: "pending" };
  }
  if (!matches(opened, capture, payee)) {
    console.error("a PayPal capture did not match its order", order);
    return { ok: false, reason: "mismatch" };
  }
  if (!email || typeof capture.id !== "string") {
    await watchLater(order, opened);
    return { ok: false, reason: "error" };
  }
  if (capture.status === "PENDING") {
    await watchLater(order, opened);
    return { ok: false, reason: "pending" };
  }
  // Paid (completed, or since refunded in part, which keeps the purchase: CAPTURE_KEEPS) is written down. Declined,
  // failed, refunded or otherwise taken back is declined. A status not known here is not "declined": the order is kept
  // for the sweep to ask about again, as the sweep itself does (Claude 6's second money review of #3392, LEVE 2; rule 30).
  if (typeof capture.status !== "string" || !CAPTURE_PAID.has(capture.status)) {
    if (typeof capture.status === "string" && CAPTURE_TAKEN_BACK.has(capture.status)) {
      // Declined in the answer itself: nothing was charged, as with PayPal's own refusal above, so an order put in
      // pending by this call (watchFirst) is let go of it; one there before stays for the sweep.
      if (watchedHere) await redisPipeline([["ZREM", pendingKey(opened.s), order]]).catch((again) => console.error("letting go of a declined PayPal order failed", again));
      return { ok: false, reason: "declined" };
    }
    console.error("a PayPal capture is in a status not known here; asked again by the sweep", order, capture.status);
    await watchLater(order, opened);
    return { ok: false, reason: "pending" };
  }
  try {
    const { paid, fresh } = await settle(order, opened, capture.id, email);
    return { ok: true, paid, fresh };
  } catch (error) {
    // Taken, but whether it was written down here is unknown: nothing is handed over on it. PAYPAL_SETTLE takes the
    // order off pending only in the same step that writes it down with every list, and watchFirst put it on pending
    // before the capture, so either it is written with its hand-over owed or it is still pending and the sweep asks
    // again; it is never put back on pending here (that would undo a write whose answer was only lost).
    if (!(error instanceof UnknownReplyError)) throw error;
    console.error("a PayPal payment could not be written down", order, error);
    return { ok: false, reason: "error" };
  }
}

/**
 * A PayPal receipt as deliverPayPal makes it: every field that decides the bytes a sender is given for it (the
 * meter is the same for every one). lib/paypal-delivery.ts keeps the first one made, so every try sends it again.
 */
export type PayPalReceipt = { from: string; to: string; subject: string; text: string; replyTo?: string; idempotencyKey: string };

/**
 * Hands a paid PayPal purchase over, once: written down under the buyer's
 * PayPal address, a course dated from today, and the receipt emailed with
 * the link to the list of purchases. True only when the sender accepted the
 * receipt; false when it refused it, its answer is unknown or it threw, so
 * the caller keeps the order to send it again (lib/paypal-delivery.ts), under
 * the same idempotency key, through the same sender (sendEmailPinned) and
 * with the same bytes (keep); false too when mayEmail said no or keep gave
 * none, with no receipt sent.
 * Every other step is written once (HSETNX, SET NX).
 */
export async function deliverPayPal(input: {
  store: Store;
  paid: Paid;
  product: Listing;
  base: string;
  from: string;
  recordStart: (email: string, productId: string, startSeconds: number) => Promise<void>;
  ordersLink: (email: string) => Promise<string | null>;
  /** Asked just before the receipt, before its link: no sends no receipt this time (an unknown throws first). */
  mayEmail?: () => Promise<boolean>;
  /**
   * Given the receipt just made, before anything is sent: the receipt to send (the one kept from its first try, so
   * every try is the same bytes), or null for none this time. A throw sends nothing, as a sender's refusal.
   */
  keep?: (receipt: PayPalReceipt) => Promise<PayPalReceipt | null>;
}): Promise<boolean> {
  const { store, paid, product, base } = input;
  if (!store.statsId) return false;
  const items = product.bundle?.length ? product.bundle : null;
  await grantImported(store.statsId, `paypal:${paid.order}`, [{ email: paid.email, productId: product.id, items }], paid.at, store.sid);
  if (!store.pastBuyers) await setPastBuyers(storeRef(store));
  for (const id of [product.id, ...(items ?? [])]) await input.recordStart(paid.email, id, paid.at);
  const go = !input.mayEmail || (await input.mayEmail());
  const link = go ? ((await input.ordersLink(paid.email)) ?? `${base}/orders`) : "";
  const g = givingWords(store.language);
  const made = (): PayPalReceipt => ({
    from: input.from,
    to: paid.email,
    subject: g.ppSubject(product.title).slice(0, 200),
    text: [
      g.ppThanks(store.name),
      "",
      g.ppWhat(product.title),
      g.ppPaid(formatMoney(paid.cents, paid.currency, speech(store).lang.locale)),
      g.ppTransaction(paid.capture),
      ...consentEmailLines(store, paid.meta),
      "",
      g.openHere,
      link,
      "",
      g.link24(`${base}/orders`),
      "",
      g.ppPaidTo(store.name),
    ].join("\n"),
    replyTo: store.email,
    idempotencyKey: `nimbus-paypal:${paid.order}`,
  });
  const receipted = go && await (async () => {
    const receipt = input.keep ? await input.keep(made()) : made();
    return receipt !== null && (await sendEmailPinned({ meter: { by: "order" }, ...receipt }));
  })().catch((error) => {
    console.error("a PayPal purchase email failed", error);
    return false;
  });
  // One of the month's orders, like a card checkout's (lib/orders.ts). Not counted until
  // 17 October 2026, so a store's PayPal sales were in no plan's figure.
  await countOrder(store, `paypal:${paid.order}`, paid.cents);
  return receipted === true;
}

/**
 * Cancels an order PayPal never confirmed (watchPayPal, PENDING_GIVE_UP_SECONDS), once:
 *
 *   1. its mark (canceledKey, SET NX, kept CANCELED_KEPT_SECONDS) and its two places on the notice queue, the
 *      buyer's and the creator's (ZADD NX, due CANCEL_NOTICE_EVERY_SECONDS later), in one round trip read exactly
 *      (CX-123 rule 24): anything unknown tells nobody and leaves the order for the next run;
 *   2. the order taken off the pending list and its record let go, so a buyer coming back from PayPal's page later
 *      cannot capture it (captureOrder finds no record) and the page says it was canceled (canceledFor);
 *   3. only by the run whose SET wrote the mark: the buyer and the creator told (`tell`, "both"). A notice the sender
 *      did not refuse leaves the queue; one it refused stays there, tried again by retryCancelNotices, so neither the
 *      buyer nor the creator is left without a word because a sender refused it once.
 */
async function cancelOrder(
  statsId: string,
  order: string,
  opened: Opened,
  email: string,
  charged: CanceledOrder["charged"],
  tell: ((order: CanceledOrder, who: TellWho) => Promise<TellOutcomes>) | undefined,
): Promise<void> {
  if (!tell) return;
  const at = Math.floor(Date.now() / 1000);
  const canceled: CanceledOrder = { order, store: statsId, handle: opened.h, product: opened.p, cents: opened.c, currency: opened.cur, email: email || null, charged, at };
  const wrote = repliesFor(
    await redisPipeline([
      ["SET", canceledKey(order), JSON.stringify(canceled), "NX", "EX", CANCELED_KEPT_SECONDS],
      ["ZADD", CANCEL_NOTICE_QUEUE, "NX", String(at + CANCEL_NOTICE_EVERY_SECONDS), order, String(at + CANCEL_NOTICE_EVERY_SECONDS), `c:${order}`],
    ]),
    2,
  );
  if (!wrote || (wrote[0] !== "OK" && wrote[0] !== null) || (wrote[1] !== 0 && wrote[1] !== 1 && wrote[1] !== 2)) return;
  await redisPipeline([["ZREM", pendingKey(statsId), order], ["DEL", orderKey(order)]]);
  // Already canceled by an earlier run, whose notices were sent then or wait on the queue.
  if (wrote[0] === null) return;
  const told: TellOutcomes = await tell(canceled, "both").catch((error) => {
    console.error("telling of a canceled PayPal order failed", error);
    return { buyer: "refused", creator: "refused" } as const;
  });
  const done = [...(told.buyer !== "refused" ? [order] : []), ...(told.creator !== "refused" ? [`c:${order}`] : [])];
  if (done.length) await redisPipeline([["ZREM", CANCEL_NOTICE_QUEUE, ...done]]).catch(() => undefined);
}

/**
 * Tries again the buyers' notices the sender refused (cancelOrder), for every store, once a run of the five-minute job
 * (lib/checkout-sweep.ts): one ZRANGEBYSCORE of the due ones, at most CANCEL_NOTICE_BATCH, then for each its mark
 * (one GET) and one try. A notice the sender took, or may have taken ("uncertain"), leaves the queue; one it refused
 * again is due CANCEL_NOTICE_EVERY_SECONDS later; one whose mark ended (CANCELED_KEPT_SECONDS) leaves it. A mark that
 * does not read stays, asked again next run, never taken for "told". Returns the notices sent.
 */
export async function retryCancelNotices(deadline: number, tell: (order: CanceledOrder, who: TellWho) => Promise<TellOutcomes>): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const now = Math.floor(Date.now() / 1000);
  const [due] = await redisPipeline([["ZRANGEBYSCORE", CANCEL_NOTICE_QUEUE, "0", String(now), "LIMIT", "0", String(CANCEL_NOTICE_BATCH)]]);
  let sent = 0;
  for (const member of Array.isArray(due) ? (due as unknown[]) : []) {
    if (Date.now() >= deadline) break;
    const named = typeof member === "string" ? /^(c:)?([A-Z0-9]{10,36})$/.exec(member) : null;
    if (!named) {
      await redisPipeline([["ZREM", CANCEL_NOTICE_QUEUE, String(member)]]);
      continue;
    }
    const who: TellWho = named[1] ? "creator" : "buyer";
    const order = named[2];
    let canceled: CanceledOrder | null;
    try {
      canceled = await readCanceled(order);
    } catch (error) {
      console.error("reading a canceled PayPal order failed; asked again", error);
      continue;
    }
    if (!canceled || now >= canceled.at + CANCELED_KEPT_SECONDS) {
      await redisPipeline([["ZREM", CANCEL_NOTICE_QUEUE, member as string]]);
      continue;
    }
    const told = await tell(canceled, who).catch((error) => {
      console.error("telling of a canceled PayPal order failed", error);
      return { buyer: "refused", creator: "refused" } as const;
    });
    const outcome = who === "creator" ? told.creator : told.buyer;
    if (outcome === "sent") sent += 1;
    await redisPipeline([outcome === "refused" ? ["ZADD", CANCEL_NOTICE_QUEUE, "XX", String(now + CANCEL_NOTICE_EVERY_SECONDS), member as string] : ["ZREM", CANCEL_NOTICE_QUEUE, member as string]]);
  }
  return sent;
}

/**
 * When a paid order is next asked about: often while refunds are likely, then
 * less and less, until PayPal's refund window closes.
 */
export function nextLook(paidAt: number, now: number): number | null {
  const age = now - paidAt;
  if (age >= WATCH_SECONDS) return null;
  const every = age < 7 * 86_400 ? 3600 : age < 30 * 86_400 ? 6 * 3600 : 86_400;
  return Math.min(now + every, paidAt + WATCH_SECONDS);
}

/**
 * How long after the watch's days an order whose capture PayPal answered in a status the watch does not read waits
 * before it is asked again (Claude 2 on #4536). It is never dropped as "not refunded", but asking every hour until its
 * paid record ends (400 days) would be about 9,600 reads an order: PAYPAL_WATCH_LOOKS in tests/plan-cost-registry.ts,
 * held by tests/paypal-watch-unknown-looks.test.ts.
 */
export const LATE_LOOK_SECONDS = 30 * 86_400;

/** When an order whose capture's answer the watch could not read is asked again: the watch's own schedule while it lasts, then every LATE_LOOK_SECONDS. */
export function unknownLook(paidAt: number, now: number): number {
  return nextLook(paidAt, now) ?? now + LATE_LOOK_SECONDS;
}

/**
 * The orders one sweep of a store reads from each of its two lists (pending payments, orders due a refund look): one
 * ZRANGEBYSCORE of each list a run, never more orders than this (NOT_A_COST.PAYPAL_WATCH_BATCH and PAYPAL_WATCH_RANGES
 * in tests/plan-cost-registry.ts, held by tests/paypal-watch-cost.test.ts). The rest wait for the next run.
 */
export const PAYPAL_WATCH_BATCH = 25;

/**
 * A paid capture's status as the refund watch reads it (inbox C4-13, the owner on 4 November 2026: a payment the
 * bank or PayPal took back closes the whole order, whatever its amount, as a dispute Stripe closed as lost does,
 * lib/refunds.ts). Only COMPLETED, PENDING and PARTIALLY_REFUNDED keep the purchase; a partial refund keeps it,
 * because the creator chose to keep part of the price, the rule every other door follows (lib/refunds.ts). REFUNDED,
 * REVERSED (a chargeback), FAILED and DECLINED are the whole payment taken back. Any other status is not known here:
 * it takes nothing back and gives nothing again, is logged, and stays watched (CX-123 rule 24).
 *
 * PayPal's published capture statuses (Orders v2, capture_status), as Claude 6's second money review of #3392 read them
 * on 9 November 2026 in PayPal's reference and official SDKs (not opened from this change: developer.paypal.com does
 * not resolve here): COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED and FAILED. REVERSED is not among them;
 * it stays in the taken-back set only so that a capture ever reported so never keeps a purchase. A chargeback comes as
 * PayPal's webhook event PAYMENT.CAPTURE.REVERSED or as a dispute, and nothing in the product receives PayPal webhooks
 * or reads its disputes (docs/bx2-earnings-design.md): a chargeback is not seen here, and nothing the creator or the
 * buyer reads may say it is (the studio's PayPal box, components/kept-by-currency.tsx; VR 2).
 */
const CAPTURE_KEEPS: ReadonlySet<string> = new Set(["COMPLETED", "PENDING", "PARTIALLY_REFUNDED"]);
/** Of those, the statuses of a payment taken: written down and handed over when the order is still waiting on it. */
const CAPTURE_PAID: ReadonlySet<string> = new Set(["COMPLETED", "PARTIALLY_REFUNDED"]);
const CAPTURE_TAKEN_BACK: ReadonlySet<string> = new Set(["REFUNDED", "REVERSED", "FAILED", "DECLINED"]);
/**
 * The capture statuses the refund watch reads (#4536, merged with C4-13): the ones that keep the purchase
 * (CAPTURE_KEEPS) and the ones that take it back (CAPTURE_TAKEN_BACK). Any other is unknown to it: looked at again
 * (unknownLook), never read as either and never dropped as "not refunded".
 */
const CAPTURE_STATUSES_READ: ReadonlySet<string> = new Set([...CAPTURE_KEEPS, ...CAPTURE_TAKEN_BACK]);
/** How often a paid order whose capture is in a status not known here is looked at once PayPal's 180 days are over. */
const UNKNOWN_STATUS_LOOK_SECONDS = 86_400;
/**
 * How long a payment refunded in full whose telling to the store's webhooks failed (on.refunded threw: a deletion print
 * or a once-only mark that did not read, rule 24) waits before it is looked at again, and told again then (review of
 * #3491, MEDIUM): an hour, the watch's own first-week pace (nextLook), so an order owed its telling is never looked at
 * more often than PAYPAL_REFUND_WATCH.looksPerOrderPerDayAtMost, and never past its paid record (daysWatchedAtMost).
 * The event's id is its seed's (paypal:<capture>), so telling it again never sends it twice. PAYPAL_REFUND_TOLD in
 * tests/plan-cost-registry.ts prices the look.
 */
export const REFUND_TELL_AGAIN_SECONDS = 3_600;
/** How many due paid orders one run of the refund watch looks at for a store: PAYPAL_WATCH_BATCH, the one batch (PAYPAL_REFUND_WATCH and NOT_A_COST.REFUND_WATCH_BATCH in tests/plan-cost-registry.ts). */
export const REFUND_WATCH_BATCH = PAYPAL_WATCH_BATCH;
/** How many pending orders one run of the sweep asks PayPal about for a store: PAYPAL_WATCH_BATCH, the one batch (PAYPAL_PENDING_SWEEP and NOT_A_COST.PENDING_SWEEP_BATCH in tests/plan-cost-registry.ts). */
export const PENDING_SWEEP_BATCH = PAYPAL_WATCH_BATCH;

/**
 * What the sweep asks of PayPal for one store, a few orders at a time:
 *
 *   - a payment PayPal held as pending and has since completed is written
 *     down and handed over (`handOver`); one that failed is dropped;
 *   - what a payment bought is taken back once PayPal says it was refunded in
 *     full, asking only about the orders whose turn has come (nextLook).
 */
export async function watchPayPal(
  store: Store,
  deadline: number,
  on: {
    handOver: (paid: Paid) => Promise<void>;
    dropStart: (email: string, productId: string) => Promise<void>;
    refunded?: (paid: Paid) => Promise<void>;
    /** Says in the store's webhook log that the refund was not sent, once `refunded` failed for REFUND_TELL_RETRY_SECONDS. */
    notTold?: (paid: Paid) => Promise<void>;
    /** Puts a course back for a payment that keeps the purchase (an HSETNX: nothing for one still there, no email). */
    restoreStart?: (email: string, productId: string, startSeconds: number) => Promise<void>;
    /**
     * Tells the buyer and the creator that an order PayPal never confirmed is canceled (PENDING_GIVE_UP_SECONDS).
     * Asked for "both" at the cancellation; a side whose notice was "refused" is tried again on its own by
     * retryCancelNotices. Without it, such an order is asked about until its record ends, as before.
     */
    canceled?: (order: CanceledOrder, who: TellWho) => Promise<TellOutcomes>;
  },
): Promise<{ cleared: number; revoked: number }> {
  const result = { cleared: 0, revoked: 0 };
  // The connected account, or the one disconnected within PAYPAL_PAST_SECONDS: what PayPal already holds is still
  // answered after the creator stops selling with PayPal (Claude 7, 12 November 2026).
  const merchant = paypalMerchant(store);
  if (!paypalSalesConfigured() || !store.statsId || !merchant || !isRedisConfigured()) return result;
  const storeMerchant = merchant;
  const statsId = store.statsId;
  const now = Math.floor(Date.now() / 1000);

  const [waiting] = await redisPipeline([["ZRANGEBYSCORE", pendingKey(statsId), "-inf", "+inf", "LIMIT", "0", String(PENDING_SWEEP_BATCH)]]);
  for (const order of Array.isArray(waiting) ? (waiting as string[]) : []) {
    if (Date.now() >= deadline) return result;
    // An order asked about and still waiting goes to the back of the list (its score is only an order), so orders PayPal
    // never settles cannot keep a newer, paid one out of the batch until their records end (Claude 2's first and
    // Claude 6's second money reviews of #3392, LEVE 1). XX: never put back an order a capture or another sweep has
    // just taken off.
    // A list write that fails only keeps the order where it was: logged, never thrown out of the sweep, so the store's
    // refund watch still runs this time (Claude 1's LOW on #3392, from Claude 2 and Claude 6).
    const later = () =>
      redisPipeline([["ZADD", pendingKey(statsId), "XX", String(now), order]]).then(
        () => undefined,
        (error: unknown) => console.error("putting a pending PayPal order back in line failed; it stays where it was", error),
      );
    const opened = await readOpened(order);
    // Not read just now: kept, and asked about on a later run (rule 24), never dropped as expired.
    if (opened === "unknown") continue;
    let written: Paid | null;
    try {
      written = opened ? await readPaid(order) : null;
    } catch (error) {
      // Unknown is not "ended": the order stays pending and is read again on the next pass (CX-123 rule 24).
      if (!(error instanceof UnknownReplyError)) throw error;
      console.error("a pending PayPal order could not be read", order, error);
      continue;
    }
    // Thirty days without PayPal settling it: no longer asked about.
    if (!opened || written) {
      await redisPipeline([["ZREM", pendingKey(statsId), order]]);
      continue;
    }
    let done: Record<string, unknown>;
    try {
      done = await call("GET", `/v2/checkout/orders/${encodeURIComponent(order)}`, { merchant: opened.m });
    } catch (error) {
      console.error("reading a PayPal order failed", error);
      await later();
      continue;
    }
    // Another order's record (completed, voided or anything else) says nothing about this one: kept and asked again
    // (#4444, rule 30). A kept order is let go when its record ends (30 days).
    if (!ownAnswer(done, order)) continue;
    const { capture, payee, email } = captureIn(done);
    // Not confirmed PENDING_GIVE_UP_SECONDS after it was opened: canceled, and the buyer and the creator told, only on
    // PayPal's readable word that nothing was taken or that the payment is still pending; never on an answer that
    // fails or cannot be read, which is asked about again (CX-123 rule 24).
    const overdue = Boolean(on.canceled) && now >= opened.at + PENDING_GIVE_UP_SECONDS;
    // No capture in the answer. Only PayPal's word that the order was voided means nothing will be charged; any
    // other answer (approved, created, saved, completed without its captures, no status) is kept and asked again
    // (CX-123 rule 24; review of Codex G on #2681). A kept order is let go when its record ends (30 days).
    if (!capture) {
      if (done.status === "VOIDED") await redisPipeline([["ZREM", pendingKey(statsId), order]]);
      else {
        // Overdue on PayPal's readable word that nothing was taken: canceled (cancelOrder takes it off the list once its
        // mark is written). Anything else, or a cancellation that did not write, goes to the back of the line (later,
        // XX: never put back an order the cancellation took off).
        if (overdue && typeof done.status === "string" && NOT_CHARGED.has(done.status)) await cancelOrder(statsId, order, opened, email, "none", on.canceled);
        await later();
      }
      continue;
    }
    if (capture.status === "PENDING") {
      // Still pending at PayPal: canceled once overdue (the buyer told the payment may still complete, into the
      // creator's account), otherwise asked again later. A paid capture never reaches this branch.
      if (overdue) await cancelOrder(statsId, order, opened, email, "pending", on.canceled);
      await later();
      continue;
    }
    if (typeof capture.status !== "string") {
      await later();
      continue;
    }
    // Paid (completed, or since refunded in part, which keeps the purchase: LEVE 3 of the same review) and what was
    // asked, but without the buyer's address or the capture's id: paid, not yet readable. Never canceled.
    const paidStatus = CAPTURE_PAID.has(capture.status);
    if (paidStatus && matches(opened, capture, payee) && (!email || typeof capture.id !== "string")) {
      await later();
      continue;
    }
    if (paidStatus && matches(opened, capture, payee) && email && typeof capture.id === "string") {
      let settled: { paid: Paid; fresh: boolean };
      try {
        settled = await settle(order, opened, capture.id, email);
      } catch (error) {
        // Not known to be written down by this pass: nothing handed over, still pending, asked again (CX-123 rule 24).
        if (!(error instanceof UnknownReplyError)) throw error;
        console.error("a PayPal payment could not be written down", order, error);
        continue;
      }
      const { paid, fresh } = settled;
      if (fresh) {
        await on.handOver(paid);
        result.cleared += 1;
      }
      continue;
    }
    // A status not known here is not "declined": nothing is handed over yet, and it is asked again until the order's
    // record ends (30 days), never dropped on a word this file does not know (rule 30 of CX-123, with the watch below).
    if (!CAPTURE_KEEPS.has(capture.status) && !CAPTURE_TAKEN_BACK.has(capture.status)) {
      console.error("a pending PayPal order's capture is in a status not known here; asked again", order, capture.status);
      await later();
      continue;
    }
    // Declined, failed, or not what was asked: nothing is handed over.
    await redisPipeline([["ZREM", pendingKey(statsId), order]]);
  }

  const dropStart = on.dropStart;
  const [due] = await redisPipeline([["ZRANGEBYSCORE", watchKey(statsId), "0", String(now), "LIMIT", "0", String(REFUND_WATCH_BATCH)]]);
  let revoked = 0;
  for (const order of Array.isArray(due) ? (due as string[]) : []) {
    if (Date.now() >= deadline) break;
    const paid = await readPaidExact(order);
    // Unknown is looked at again in an hour, never dropped from the watch (Codex G on #2791).
    if (paid === "unknown") {
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
      continue;
    }
    if (!paid || !paid.capture) {
      await redisPipeline([["ZREM", watchKey(statsId), order]]);
      continue;
    }
    // The account the order was paid to, whatever account the store has connected since (C7, 12 November 2026); a
    // record from before it was kept falls back to the store's account now: the connected one, or, while PayPal is
    // disconnected, the one kept (paypalMerchant), never a read of a connection that is not there.
    const merchant = typeof paid.m === "string" && MERCHANT_ID.test(paid.m) ? paid.m : storeMerchant;
    let status = "";
    try {
      const capture = await call("GET", `/v2/payments/captures/${encodeURIComponent(paid.capture)}`, { merchant });
      // Without PayPal's own status it is not known whether it was refunded: asked again (unknownLook), never taken for
      // "not refunded", and moved back so it cannot hold the place of the orders behind it.
      // Nor is a reply about another capture this one's (rule 30), nor a status that is not PayPal's word for money
      // standing or taken back (14 November 2026): every other one is unknown, looked at again (unknownLook) and never
      // dropped from the watch as "not refunded", even past the watch's days.
      if (typeof capture.status !== "string" || !capture.status || capture.id !== paid.capture || !CAPTURE_STATUSES_READ.has(capture.status)) {
        if (typeof capture.status === "string" && capture.id === paid.capture && !CAPTURE_STATUSES_READ.has(capture.status)) {
          console.error("a PayPal capture is in a status the refund watch does not read; looked at again later", order, capture.status);
        }
        // On the watch's own schedule while its days last, then every LATE_LOOK_SECONDS: never every hour for the
        // paid record's 400 days (Claude 2 on #4536).
        await redisPipeline([["ZADD", watchKey(statsId), String(unknownLook(paid.at, now)), order]]);
        continue;
      }
      status = capture.status;
    } catch (error) {
      console.error("reading a PayPal capture failed", error);
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]).catch(() => undefined);
      continue;
    }
    if (!CAPTURE_TAKEN_BACK.has(status)) {
      const known = CAPTURE_KEEPS.has(status);
      // Not known here: nothing taken back, and never let go on it either. Past PayPal's 180 days it is still looked at
      // once a day, until the paid record ends (PAID_KEPT_SECONDS), when the watch lets it go above.
      if (!known) console.error("a paid PayPal capture is in a status not known here; nothing taken back, still watched", order, status);
      const next = nextLook(paid.at, now) ?? (known ? null : now + UNKNOWN_STATUS_LOOK_SECONDS);
      await redisPipeline([next === null ? ["ZREM", watchKey(statsId), order] : ["ZADD", watchKey(statsId), String(next), order]]);
      continue;
    }
    // Taken back in full, refunded or reversed, failed or declined (C4-13): counted as given back in the store's numbers
    // and the affiliate book (the same mark as a refund, so a reversed payment never keeps a purchase for another
    // payment of the same buyer and is never handed over again), whatever is handed back below.
    // The mark is also what stops the hand-over retry (handOverAgain), so it must be known written before the order can
    // leave this watch: both replies read exactly, each 0 or 1 (one member added or already there; the key's expiry
    // set). Anything else is unknown, never "written": the order stays watched and is looked at again in an hour,
    // before anything is told or taken off a list (Claude 6 on #2909; CX-123 rules 24 and 30).
    // Not a refund (reversed, failed, declined): its own mark first, read exactly as the refund mark is, so the refund
    // mark is never there without it and the buyer is never told "refunded" of it (pre-review MEDIUM on C4-13). Not
    // written: nothing marked, nothing taken back; looked at again in an hour.
    if (status !== "REFUNDED") {
      const reversed = repliesFor(
        await redisPipeline([
          ["ZADD", reversedKey(statsId), String(now), order],
          ["EXPIRE", reversedKey(statsId), SALES_KEPT_SECONDS],
        ]),
        2,
      );
      if (!reversed || !reversed.every((reply) => reply === 0 || reply === 1)) {
        console.error("a PayPal payment taken back could not be marked; looked at again in an hour", order);
        await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
        continue;
      }
    }
    const marked = repliesFor(
      await redisPipeline([
        ["ZADD", refundedKey(statsId), String(now), order],
        ["EXPIRE", refundedKey(statsId), SALES_KEPT_SECONDS],
      ]),
      2,
    );
    if (!marked || !marked.every((reply) => reply === 0 || reply === 1)) {
      console.error("a PayPal refund could not be marked; looked at again in an hour", order);
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
      continue;
    }
    // And written down for good, by the payment as the affiliate book names it (backKey): the book's lines are kept for
    // good, so what takes one back must outlive the set above and the paid record, or a refunded sale would be paid
    // again once they expire (P3), or the whole book left unchecked once the record alone did (P4). Charged to the
    // store's room as an order's record (lib/order-data.ts). Its one reply read exactly, 0 or 1 (written, or already
    // there); anything else, or a write that failed, is unknown: the order stays watched, looked at again in an hour,
    // before anything is told (rule 24). The set's mark above still takes the sale back in the meantime, and the
    // affiliate book asks the set about its own orders as well as this record. No count of tries: a refund never
    // kept for good is never let go, so a failure that lasts costs one look an hour, inside the run's 25 orders.
    let lasting: unknown[] | null = null;
    try {
      lasting = await orderWrite(store, [["HSETNX", backKey(statsId), paypalPaymentId(paid.capture), String(now)]]);
    } catch (error) {
      console.error("a PayPal refund could not be kept for the affiliate book", error);
    }
    if (!lasting || lasting.length !== 1 || !(lasting[0] === 0 || lasting[0] === 1)) {
      console.error("a PayPal refund could not be kept for good; looked at again in an hour", order);
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
      continue;
    }
    // Told as a refund only when it is one: the event says fully_refunded, which a chargeback or a failed payment is not.
    // Option A of #3499 (Claude 6, author of #3491 and #3499): what the payment gave is taken back at once (#3491), and
    // a telling that fails is owed, told again an hour later while the order stays on the watch (REFUND_TELL_AGAIN_SECONDS),
    // for at most REFUND_TELL_RETRY_SECONDS after the first failure (Claude 5's L4 on #3491; Codex C2's M1 on #3499);
    // past that the store's webhook log says it was not sent (notTold) and the order leaves the watch. Only the first
    // look at a refund (its refund mark newly added, a ZADD answering 1) tells without the first failure's time; every
    // later look tells only once that time is known, read back exactly, not ahead of the clock and inside the bound. A
    // time that is not known on a later look is never "inside the bound" nor "past it" (CX-123 rule 24): the order is
    // looked at again in an hour and nothing is told or said not sent (what the payment gave was taken back on its
    // first look). The event's own id makes a later try find one already told (emitEvent).
    let owed = false;
    if (on.refunded && status === "REFUNDED") {
      let first: number | null = null;
      if (marked[0] === 0) {
        // A later look. When no failure's time was kept (its write got no answer), the try that failed is taken to
        // have been an hour ago, the earliest a look comes back, so the tries in all still fit the bound.
        first = await tellFirst(order, now - 3600, now);
        if (first === null) {
          console.error("when telling of a PayPal refund first failed is unknown; looked at again in an hour", order);
          await redisPipeline([["ZADD", watchKey(statsId), String(now + REFUND_TELL_AGAIN_SECONDS), order]]).catch(() => undefined);
          continue;
        }
      }
      let told = false;
      if (first === null || now - first <= REFUND_TELL_RETRY_SECONDS) {
        try {
          await on.refunded(paid);
          told = true;
        } catch (error) {
          console.error("telling of a PayPal refund failed; told again when the order is looked at in an hour", order, error);
        }
      }
      if (!told) {
        if (first === null) first = await tellFirst(order, now, now);
        // Owed while inside the bound, or while its first failure's time is not known (never "past it"): the order stays
        // on the watch. Past the bound, said not sent, once, and the order leaves.
        if (first === null || now - first < REFUND_TELL_RETRY_SECONDS) owed = true;
        else if (on.notTold) await on.notTold(paid).catch((lost) => console.error("WEBHOOK EVENT LOST: a PayPal refund could not be told nor said not sent", order, lost));
      }
    }
    // Where the order would leave the watch: kept for its telling's next try while it is owed.
    const leaveCommand = (): (string | number)[] => (owed ? ["ZADD", watchKey(statsId), String(now + REFUND_TELL_AGAIN_SECONDS), order] : ["ZREM", watchKey(statsId), order]);
    // The record read in its exact envelope (Codex G on #2791; CX-123 rule 24): one reply, null or text. Anything else
    // is unknown, looked at again in an hour, never "no record".
    const read = repliesFor(await redisPipeline([["HGET", importedKey(statsId, paid.email), paid.product]]), 1);
    if (!read || (read[0] !== null && typeof read[0] !== "string")) {
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
      continue;
    }
    const given = read[0];
    let items: string[] = [];
    // No record: nothing of this payment is held any more, so nothing to take back. A record that does not read is
    // unknown, never "not this payment's": looked at again in an hour (rule 30, Claude 4 on #2781).
    if (given === null) {
      await redisPipeline([leaveCommand()]);
      continue;
    }
    let v: unknown;
    try {
      v = typeof given === "string" ? JSON.parse(given) : undefined;
    } catch {
      v = undefined;
    }
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof (v as { job?: unknown }).job !== "string") {
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
      continue;
    }
    // Only what this very payment gave is taken back. A payment refunded in full no longer stands either way, so it
    // leaves this buyer's own payments too, read exactly, and is never later taken for one that keeps the purchase
    // (Codex G on #2791).
    if ((v as { job: string }).job !== `paypal:${order}`) {
      // The payment that stands now gets its course back, in case this one's course removal ran after it was handed
      // over (Codex G's M1 on #2791); an HSETNX, nothing for a course still there.
      const standing = /^paypal:(.+)$/.exec((v as { job: string }).job)?.[1];
      if (standing && on.restoreStart) {
        const other = ORDER_ID.test(standing) ? await readPaidExact(standing) : "unknown";
        const listedItems = (v as { items?: unknown }).items;
        const otherItems = Array.isArray(listedItems) ? listedItems.filter((item): item is string => typeof item === "string") : [];
        try {
          if (other === "unknown") throw new Error("the standing payment could not be read");
          if (other && other.product === paid.product) for (const id of [other.product, ...otherItems]) await on.restoreStart(other.email, id, other.at);
        } catch (error) {
          console.error("giving a standing PayPal payment its course back failed; looked at again in an hour", error);
          await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]).catch(() => undefined);
          continue;
        }
      }
      const left = repliesFor(await redisPipeline([["SREM", ownKey(statsId, paid.email, paid.product), order]]), 1);
      if (!left || (left[0] !== 0 && left[0] !== 1)) {
        await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
        continue;
      }
      await redisPipeline([leaveCommand()]);
      continue;
    }
    const listed = (v as { items?: unknown }).items;
    items = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === "string") : [];
    // Another payment of this address for the same product still stands: it keeps it.
    const own = ownKey(statsId, paid.email, paid.product);
    // Read exactly too (rule 30): the SREM answers 0 or 1 and the other payments are a list of text; anything else is
    // unknown, looked at again in an hour, never "no other payment".
    const owned = repliesFor(await redisPipeline([["SREM", own, order], ["SMEMBERS", own]]), 2);
    const others = owned?.[1];
    if (!owned || (owned[0] !== 0 && owned[0] !== 1) || !Array.isArray(others) || !others.every((other) => typeof other === "string")) {
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
      continue;
    }
    // Another payment that stands keeps it; one that cannot be read leaves it unknown, looked at again in an hour.
    let kept: Paid | null = null;
    let unread = false;
    for (const other of others as string[]) {
      // An id that is not an order id is not "no payment": unknown, so the access stays and the order is looked at
      // again (Codex G on #2791).
      if (!ORDER_ID.test(other)) {
        unread = true;
        continue;
      }
      const read = await readPaidExact(other);
      if (read === "unknown") {
        unread = true;
        continue;
      }
      if (read) {
        // A payment already seen refunded in full does not keep it, however long its record stays (Codex G on #2791).
        const seen = repliesFor(await redisPipeline([["ZSCORE", refundedKey(statsId), other]]), 1);
        // The mark's score is whole seconds, as written here; "", " ", "0x10" or "1e309" is not one, and is unknown.
        if (!seen || (seen[0] !== null && (typeof seen[0] !== "string" || !REDIS_SCORE.test(seen[0])))) {
          unread = true;
          continue;
        }
        if (seen[0] !== null) continue;
        kept = read;
        break;
      }
    }
    if (!kept && unread) {
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]);
      continue;
    }
    // Each write confirmed before the order leaves the watch (Codex G on #2791): a reply in another shape keeps the
    // order watched, looked at again in an hour, and the same write is made again then (both are harmless twice).
    const leaveWatch = async (write: (string | number)[]): Promise<boolean> => {
      const wrote = repliesFor(await redisPipeline([write]), 1);
      if (!wrote || (wrote[0] !== 0 && wrote[0] !== 1)) {
        await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]).catch(() => undefined);
        return false;
      }
      await redisPipeline([leaveCommand()]);
      return true;
    };
    if (kept) {
      // Its course back too (an HSETNX), in case an earlier pass took it away before this payment was seen.
      if (on.restoreStart) {
        try {
          for (const id of [kept.product, ...items]) await on.restoreStart(kept.email, id, kept.at);
        } catch (error) {
          console.error("giving a kept PayPal purchase its course back failed; looked at again in an hour", error);
          await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]).catch(() => undefined);
          continue;
        }
      }
      await leaveWatch(["HSET", importedKey(statsId, paid.email), paid.product, JSON.stringify({ at: kept.at, job: `paypal:${kept.order}`, items: items.length ? items : null })]);
      continue;
    }
    // The course first, then the purchase and the watch (Codex G on #2781; rule 30): a course removal that fails keeps
    // both, so the order is looked at again and both are taken away then; taking a course away twice is harmless.
    try {
      for (const id of [paid.product, ...items]) await dropStart(paid.email, id);
    } catch (error) {
      console.error("taking a refunded PayPal sale's course away failed; looked at again in an hour", error);
      await redisPipeline([["ZADD", watchKey(statsId), String(now + 3600), order]]).catch(() => undefined);
      continue;
    }
    // Taken back only if no payment came in since the reading above (Codex G's M1 on #2791): one that did keeps the
    // purchase, and the order is looked at again in a minute, when that payment is read and its course put back.
    const taken = repliesFor(
      await redisPipeline([["EVAL", PAYPAL_REVOKE, 2, importedKey(statsId, paid.email), own, paid.product, `paypal:${order}`, ...(others as string[])]]),
      1,
    );
    const answer = taken?.[0];
    if (answer === 1 || answer === 2) {
      await redisPipeline([leaveCommand()]);
      if (answer === 1) revoked += 1;
    } else {
      await redisPipeline([["ZADD", watchKey(statsId), String(now + (answer === 0 ? 60 : 3600)), order]]).catch(() => undefined);
    }
  }
  result.revoked = revoked;
  return result;
}

/** How many PayPal sales and refunds a store keeps, before they are read (lib/api-read.ts, the numbers); null when a count did not come back. */
export async function paypalCounts(statsId: string | null): Promise<{ sales: number; refunds: number } | null> {
  if (!statsId || !isRedisConfigured()) return { sales: 0, refunds: 0 };
  // ZCARD answers 0 for a key that is not there, never null: a count in any other shape is unknown, never 0.
  const replies = repliesFor(await redisPipeline([["ZCARD", salesKey(statsId)], ["ZCARD", refundedKey(statsId)]]), 2);
  const sales = countOf(replies?.[0]);
  const refunds = countOf(replies?.[1]);
  return sales === null || refunds === null ? null : { sales, refunds };
}

/**
 * The store's PayPal sales paid since `since` (seconds), newest first, at most
 * `limit`: one range and one read of the orders. Nothing is asked of PayPal.
 * `now` (seconds) tells a record that expired by design from one not read.
 */
export async function readPayPalSales(statsId: string | null, since: number, limit: number, now = Math.floor(Date.now() / 1000)): Promise<{ sales: Paid[]; partial: boolean }> {
  if (!statsId || !isRedisConfigured()) return { sales: [], partial: false };
  // Read exactly, as the refunds beside it are (readPayPalRefundsWithCoverage; rule 24): the list as a list of text no
  // longer than asked, each member with its time, else unknown and thrown, never "no PayPal sales".
  const flat = stringList(repliesFor(await redisPipeline([["ZREVRANGEBYSCORE", salesKey(statsId), "+inf", String(Math.max(0, since)), "WITHSCORES", "LIMIT", "0", String(limit + 1)]]), 1)?.[0]);
  if (!flat || flat.length % 2 !== 0 || flat.length > 2 * (limit + 1)) throw new UnknownReplyError("the PayPal sales");
  const orders: string[] = [];
  const paidAt = new Map<string, number>();
  for (let i = 0; i < flat.length; i += 2) {
    const time = /^\d{1,15}$/.test(flat[i + 1]) ? Number(flat[i + 1]) : NaN;
    if (!Number.isSafeInteger(time)) throw new UnknownReplyError("the PayPal sales");
    orders.push(flat[i]);
    paidAt.set(flat[i], time);
  }
  const listed = orders.slice(0, limit);
  // An order that is not an order id, a record Redis answered as missing or one written for another store is a sale
  // this reading could not count: the reading is partial, never whole without it.
  let missing = listed.some((o) => !ORDER_ID.test(o));
  const list = listed.filter((o) => ORDER_ID.test(o));
  const partial = orders.length > limit;
  if (!list.length) return { sales: [], partial: partial || missing };
  const what = "a PayPal sale's record";
  const rows = repliesFor(repliesFor(await redisPipeline([["MGET", ...list.map(paidKey)]]), 1)?.[0], list.length);
  if (!rows) throw new UnknownReplyError(what);
  const sales: Paid[] = [];
  list.forEach((order, i) => {
    const raw = rows[i];
    if (raw === null) {
      // Its record is written with the member, at its time, and kept PAID_KEPT_SECONDS: past that it expired by design
      // and the member is only waiting for the next sale's trim (Codex L and Codex V on #4001), outside what is kept.
      // Missing inside that window, it is a sale this reading could not count.
      if ((paidAt.get(order) ?? now) + PAID_KEPT_SECONDS > now) missing = true;
      return;
    }
    if (typeof raw !== "string") throw new UnknownReplyError(what);
    let paid: unknown;
    try {
      paid = JSON.parse(raw);
    } catch {
      throw new UnknownReplyError(what);
    }
    if (!paid || typeof paid !== "object" || Array.isArray(paid) || (paid as Paid).order !== order || typeof (paid as Paid).store !== "string") throw new UnknownReplyError(what);
    if ((paid as Paid).store === statsId) sales.push(paid as Paid);
    else missing = true;
  });
  return { sales, partial: partial || missing };
}

/** The keys a PayPal order kept, by the order: for a closed store's deletion (lib/closed-store-data.ts). */
export const paypalOrderKeys = (order: string): string[] => (ORDER_ID.test(order) ? [orderKey(order), paidKey(order)] : []);

/** The most refunded PayPal sales one reading of them takes. */
export const PAYPAL_REFUNDS_READ = 500;
/**
 * The most one PayPal sale's record weighs as kept, in bytes: its twenty
 * fields of what the visit carried (cleanMeta: a name of 40 letters and a
 * value of 200 characters, each written as a six-byte escape at the worst),
 * and the order, payment, address, product and amounts beside them.
 */
export const MAX_PAID_BYTES = 20 * (40 + 6 + 6 * 200) + 2_000;

/**
 * How many PayPal sales the store keeps, and its refunds when `refunds` (ZCARD):
 * what a reading of them all (readPayPalSales, readPayPalRefundsWithCoverage)
 * moves is counted from these before it reads (lib/segments.ts, buyerLedger).
 * The sales are read whenever the store's sales are (lib/stats.ts,
 * readPaidSales), PayPal connected or not; the buyer ledger reads their
 * refunds with them, connected or not (#4398).
 */
export async function paypalKept(statsId: string | null, refunds: boolean): Promise<{ sales: number; refunds: number }> {
  if (!statsId || !isRedisConfigured()) return { sales: 0, refunds: 0 };
  // Rule 24: these counts size what a read is counted for before it reads, so only whole counts are counts. A reply
  // in another shape throws, and every caller refuses before reading, never as a store with no PayPal sales.
  const commands = [["ZCARD", salesKey(statsId)], ...(refunds ? [["ZCARD", refundedKey(statsId)]] : [])];
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  const sales = countOf(replies?.[0]);
  const refunded = refunds ? countOf(replies?.[1]) : 0;
  if (sales === null || refunded === null) throw new UnknownReplyError("the PayPal sales kept");
  return { sales, refunds: refunded };
}

/**
 * PayPal sales refunded in full since `since` (seconds): the payment, how
 * much, in what, and when the refund was seen. At most PAYPAL_REFUNDS_READ,
 * their records read in one MGET; `partial` when that did not cover every
 * one (more listed, one listed that is no order's, or one whose record is
 * gone). A member PARTIAL_MARK names (a partial refund's, "part:<order>")
 * is neither a refund in full nor a cut: it is left to its own reader.
 * The affiliate book does not read this: it asks the set about its own
 * orders and reads backKey (lib/affiliates.ts, readBook).
 */
export async function readPayPalRefundsWithCoverage(statsId: string | null, since: number): Promise<{ rows: { order: string; capture: string; cents: number; currency: string; at: number }[]; partial: boolean }> {
  if (!statsId || !isRedisConfigured()) return { rows: [], partial: false };
  const from = Math.max(0, since);
  // The refunds, member and score, as a list of text no longer than the LIMIT asked ([] is none); each score whole
  // seconds, as the sweep writes it (REDIS_SCORE), and within the range asked. Anything else is unknown and throws,
  // never "no refunds" nor a refund dated 0 (CX-123 rules 24 and 30).
  const flat = stringList(repliesFor(await redisPipeline([["ZRANGEBYSCORE", refundedKey(statsId), String(from), "+inf", "WITHSCORES", "LIMIT", "0", String(PAYPAL_REFUNDS_READ + 1)]]), 1)?.[0]);
  if (!flat || flat.length % 2 !== 0 || flat.length > 2 * (PAYPAL_REFUNDS_READ + 1)) throw new UnknownReplyError("the PayPal refunds");
  const listed: { order: string; at: number }[] = [];
  for (let i = 1; i < flat.length; i += 2) {
    if (!REDIS_SCORE.test(flat[i]) || Number(flat[i]) < from) throw new UnknownReplyError("a PayPal refund's date");
  }
  // A partial refund's mark (PARTIAL_MARK) is neither a refund in full nor a cut: passed over, left to its own reader.
  for (let i = 0; i + 1 < Math.min(flat.length, 2 * PAYPAL_REFUNDS_READ); i += 2) {
    if (!PARTIAL_MARK.test(flat[i])) listed.push({ order: flat[i], at: Number(flat[i + 1]) });
  }
  const out: { order: string; capture: string; cents: number; currency: string; at: number }[] = [];
  let missing = listed.some((entry) => !ORDER_ID.test(entry.order));
  const readable = listed.filter((entry) => ORDER_ID.test(entry.order));
  // The records, read exactly (Codex Z on #2964; CX-123 rule 24): one reply to the one MGET, holding exactly one
  // record per order asked. A record Redis answered as missing (null) leaves the reading partial; one in any other
  // shape, or whose order, capture, cents or currency is not its own exact value, throws, so it is never a refund row
  // read as complete.
  const what = "a refunded PayPal sale's record";
  const records = readable.length ? repliesFor(repliesFor(await redisPipeline([["MGET", ...readable.map((entry) => paidKey(entry.order))]]), 1)?.[0], readable.length) : [];
  if (!records) throw new UnknownReplyError(what);
  readable.forEach((entry, i) => {
    const raw = records[i];
    if (raw === null) {
      missing = true;
      return;
    }
    if (typeof raw !== "string") throw new UnknownReplyError(what);
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new UnknownReplyError(what);
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new UnknownReplyError(what);
    const r = v as Record<string, unknown>;
    if (
      r.order !== entry.order ||
      typeof r.store !== "string" ||
      typeof r.capture !== "string" ||
      !CAPTURE_ID.test(r.capture) ||
      !Number.isSafeInteger(r.cents) ||
      (r.cents as number) < 0 ||
      typeof r.currency !== "string" ||
      !/^[A-Za-z]{3}$/.test(r.currency)
    ) {
      throw new UnknownReplyError(what);
    }
    // Another store's record under this store's refunds: not one of its refunds, and the reading is not complete.
    if (r.store === statsId) out.push({ order: entry.order, capture: r.capture, cents: r.cents as number, currency: r.currency, at: entry.at });
    else missing = true;
  });
  return { rows: out, partial: flat.length > 2 * PAYPAL_REFUNDS_READ || missing };
}

/**
 * Every PayPal refund in full since `since`, or a throw: a partial reading (past PAYPAL_REFUNDS_READ, or a record
 * missing) is not every refund, so the affiliate book (lib/affiliates.ts) reads it as refunds not checked and pays
 * no commission on it, never as "these are all the refunds".
 */
export async function readPayPalRefunds(statsId: string | null, since: number): Promise<{ order: string; capture: string; cents: number; currency: string; at: number }[]> {
  const read = await readPayPalRefundsWithCoverage(statsId, since);
  if (read.partial) throw new Error("The PayPal refunds were not all read");
  return read.rows;
}

/** What a payment is called where a refund names it: the capture, so it never mixes with a Stripe payment's id. */
export const paypalPaymentId = (capture: string) => `paypal:${capture}`;
