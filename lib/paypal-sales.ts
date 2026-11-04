/**
 * Selling with PayPal: the buyer pays straight into the creator's own PayPal
 * account, through PayPal's platform program (Multiparty), and nothing passes
 * through Marktmorgen.
 *
 *   nl:ppsell:o:<order>      an order opened: which store, which product, the price asked (3 days)
 *   nl:ppsell:paid:<order>   an order paid: the capture, the buyer's address (kept 400 days)
 *   nl:ppsell:watch:<stats>  paid orders inside PayPal's refund window, scored by when to ask next
 *   nl:ppsell:pending:<stats> orders whose payment PayPal holds as pending, until it completes or fails
 *   nl:ppsell:own:<stats>:<address hash>:<product>  the paid orders behind one address's product
 *   nl:ppsell:sales:<stats>     every paid order, scored by when it was paid (400 days): the store's numbers read it
 *   nl:ppsell:refunded:<stats>  paid orders PayPal says were refunded in full, scored by when that was seen
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
import { admitOrders } from "@/lib/order-admission";
import { countOrder } from "@/lib/orders";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { addressHash, grantImported, importedKey } from "@/lib/imported-purchases";
import { plainAmount, formatMoney } from "@/lib/money";
import { saleOff, salePrice } from "@/lib/store-sale";
import { sendEmail } from "@/lib/email";
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
const MERCHANT_ID = /^[A-Z0-9]{8,20}$/;
/** How long a refund on PayPal is watched for, after the sale. PayPal allows refunds for 180 days. */
const WATCH_SECONDS = 180 * 86_400;
const PAID_KEPT_SECONDS = 400 * 86_400;

const orderKey = (order: string) => `nl:ppsell:o:${order}`;
const paidKey = (order: string) => `nl:ppsell:paid:${order}`;
const watchKey = (statsId: string) => `nl:ppsell:watch:${statsId}`;
/** Orders whose payment PayPal holds as pending, scored by when they were taken. */
const pendingKey = (statsId: string) => `nl:ppsell:pending:${statsId}`;
/** Issues PayPal answers a capture with when it takes nothing (Orders v2 errors). */
const DECLINED = new Set(["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED", "ORDER_NOT_APPROVED", "PAYEE_ACCOUNT_RESTRICTED", "PAYER_ACCOUNT_RESTRICTED"]);
/** Every PayPal order one address paid for one product, so a refund of one leaves the others standing. */
const ownKey = (statsId: string, email: string, productId: string) => `nl:ppsell:own:${statsId}:${addressHash(email)}:${productId}`;
/** Every paid order, scored by when it was paid, and those refunded in full: what the store's numbers read. */
const salesKey = (statsId: string) => `nl:ppsell:sales:${statsId}`;
/** Exported for the affiliate book's count of what it will read (lib/affiliates.ts, bookSizes). */
export const refundedKey = (statsId: string) => `nl:ppsell:refunded:${statsId}`;
const SALES_KEPT_SECONDS = 400 * 86_400;

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
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
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
    const granted = (Array.isArray(status.oauth_integrations) ? (status.oauth_integrations as Record<string, unknown>[]) : []).some(
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

/** Who takes the payment, in the words the store's pages use. */
export function takenBy(stripe: boolean, paypal: boolean): string {
  return stripe && paypal ? "Stripe or PayPal" : paypal ? "PayPal" : "Stripe";
}

/** Whether this store takes PayPal for this product right now. */
export function paypalReady(store: Store, product: Listing): boolean {
  // The same plan that opens the Stripe till opens this one.
  return sellsThroughPayPal(store) && sellsWithPayPal(product);
}

/** The price PayPal is asked for: the product's, less the store's sale while one runs. */
export function payPalPrice(store: Store, product: Listing, nowSeconds = Math.floor(Date.now() / 1000)): number {
  return salePrice(product.priceCents, saleOff(store.sale, product, nowSeconds));
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
 * share (lib/affiliates.ts), and the store sale's percent and what it took off.
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
  const cents = payPalPrice(store, product);
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
    const salePercent = saleOff(store.sale, product, Math.floor(Date.now() / 1000));
    const opened: Opened = {
      s: store.statsId,
      h: store.handle,
      p: product.id,
      c: cents,
      cur: store.currency,
      m: store.paypalSeller.merchant,
      at: Math.floor(Date.now() / 1000),
      // The yes first, so the cap on kept fields can never leave it out.
      meta: cleanMeta(digital && extras.digitalConsent ? { [CONSENT_META]: consentMetaValue(extras.digitalConsent, "digital"), ...extras.meta } : extras.meta),
      ...(extras.via && /^[a-z0-9]{12}$/.test(extras.via.aff) ? { via: { aff: extras.via.aff, rate: Math.max(0, Math.min(100, Number(extras.via.rate) || 0)) } } : {}),
      ...(salePercent > 0 ? { off: Math.max(0, product.priceCents - cents), sale: salePercent } : {}),
    };
    await redisPipeline([["SET", orderKey(order), JSON.stringify(opened), "EX", 3 * 86_400]]);
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
};
export type CaptureResult = { ok: true; paid: Paid; fresh: boolean } | { ok: false; reason: "unknown" | "pending" | "declined" | "mismatch" | "error" };

/** Whether PayPal is still being waited on for an order this store opened. */
export async function stillPending(store: Store, order: string): Promise<boolean> {
  if (!ORDER_ID.test(order) || !store.statsId || !isRedisConfigured()) return false;
  const [score] = await redisPipeline([["ZSCORE", pendingKey(store.statsId), order]]);
  return score !== null && score !== undefined;
}

export async function readPaid(order: string): Promise<Paid | null> {
  if (!ORDER_ID.test(order) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", paidKey(order)]]);
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as Paid) : null;
  } catch {
    return null;
  }
}

/**
 * A person's paid PayPal orders for these products, for the copy of their
 * data (619 [SZ3], lib/person-copy.ts): kept on purpose as the order's
 * record (lib/person-data.ts). Only reads.
 */
export async function paypalOrdersOf(statsId: string | null, productIds: string[], email: string): Promise<Paid[]> {
  if (!statsId || !productIds.length || !isRedisConfigured()) return [];
  const sets = await redisPipeline(productIds.map((p) => ["SMEMBERS", ownKey(statsId, email, p)]));
  const orders = [...new Set(sets.flatMap((set) => (Array.isArray(set) ? set.map(String) : [])))].filter((o) => ORDER_ID.test(o));
  const out: Paid[] = [];
  for (const order of orders) {
    const paid = await readPaid(order);
    if (paid) out.push(paid);
  }
  return out;
}

async function readOpened(order: string): Promise<Opened | null> {
  const [raw] = await redisPipeline([["GET", orderKey(order)]]);
  try {
    const opened = JSON.parse(String(raw)) as Opened | null;
    return opened && typeof opened.s === "string" ? opened : null;
  } catch {
    return null;
  }
}

type CaptureRow = { id?: unknown; status?: unknown; amount?: { value?: unknown; currency_code?: unknown } };

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

/** Keeps an order PayPal has not settled for the sweep to ask about, for up to 30 days. */
async function watchLater(order: string, opened: Opened): Promise<void> {
  await redisPipeline([
    ["SET", orderKey(order), JSON.stringify(opened), "EX", 30 * 86_400],
    ["ZADD", pendingKey(opened.s), String(Math.floor(Date.now() / 1000)), order],
  ]);
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
    ...(opened.meta ? { meta: opened.meta } : {}),
    ...(opened.via ? { via: opened.via } : {}),
    ...(opened.off ? { off: opened.off, sale: opened.sale } : {}),
  };
  const [fresh] = await redisPipeline([["SET", paidKey(order), JSON.stringify(paid), "NX", "EX", PAID_KEPT_SECONDS]]);
  if (fresh === null) return { paid: (await readPaid(order)) ?? paid, fresh: false };
  await redisPipeline([
    ["ZADD", watchKey(opened.s), String(nextLook(paid.at, paid.at) ?? paid.at), order],
    ["SADD", ownKey(opened.s, email, opened.p), order],
    ["EXPIRE", ownKey(opened.s, email, opened.p), PAID_KEPT_SECONDS],
    ["ZREM", pendingKey(opened.s), order],
    // Counted in the store's numbers like a Stripe sale (lib/stats.ts readPaidSales).
    ["ZADD", salesKey(opened.s), String(paid.at), order],
    ["ZREMRANGEBYSCORE", salesKey(opened.s), "-inf", String(paid.at - SALES_KEPT_SECONDS)],
    ["EXPIRE", salesKey(opened.s), SALES_KEPT_SECONDS],
  ]);
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
  const already = await readPaid(order);
  if (already) return { ok: true, paid: already, fresh: false };
  const opened = await readOpened(order);
  if (!opened || opened.s !== store.statsId) return { ok: false, reason: "unknown" };
  let done: Record<string, unknown>;
  try {
    done = await call("POST", `/v2/checkout/orders/${encodeURIComponent(order)}/capture`, { body: {}, merchant: opened.m, requestId: `nl-capture-${order}` });
  } catch (error) {
    // PayPal's words for a payment it would not take (Orders v2 errors): nothing was charged.
    if (error instanceof PayPalError && DECLINED.has(error.code)) return { ok: false, reason: "declined" };
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
  const { capture, payee, email } = captureIn(done);
  if (!capture) return { ok: false, reason: "pending" };
  if (!matches(opened, capture, payee)) {
    console.error("a PayPal capture did not match its order", order);
    return { ok: false, reason: "mismatch" };
  }
  if (!email || typeof capture.id !== "string") return { ok: false, reason: "error" };
  if (capture.status === "PENDING") {
    await watchLater(order, opened);
    return { ok: false, reason: "pending" };
  }
  if (capture.status !== "COMPLETED") return { ok: false, reason: "declined" };
  const { paid, fresh } = await settle(order, opened, capture.id, email);
  return { ok: true, paid, fresh };
}

/**
 * Hands a paid PayPal purchase over, once: written down under the buyer's
 * PayPal address, a course dated from today, and the receipt emailed with
 * the link to the list of purchases.
 */
export async function deliverPayPal(input: {
  store: Store;
  paid: Paid;
  product: Listing;
  base: string;
  from: string;
  recordStart: (email: string, productId: string, startSeconds: number) => Promise<void>;
  ordersLink: (email: string) => Promise<string | null>;
}): Promise<void> {
  const { store, paid, product, base } = input;
  if (!store.statsId) return;
  const items = product.bundle?.length ? product.bundle : null;
  await grantImported(store.statsId, `paypal:${paid.order}`, [{ email: paid.email, productId: product.id, items }], paid.at, store.sid);
  if (!store.pastBuyers) await setPastBuyers(storeRef(store));
  for (const id of [product.id, ...(items ?? [])]) await input.recordStart(paid.email, id, paid.at);
  const link = (await input.ordersLink(paid.email)) ?? `${base}/orders`;
  const g = givingWords(store.language);
  await sendEmail({ meter: { by: "order" },
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
  }).catch((error) => console.error("a PayPal purchase email failed", error));
  // One of the month's orders, like a card checkout's (lib/orders.ts). Not counted until
  // 17 October 2026, so a store's PayPal sales were in no plan's figure.
  await countOrder(store, `paypal:${paid.order}`, paid.cents);
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
  on: { handOver: (paid: Paid) => Promise<void>; dropStart: (email: string, productId: string) => Promise<void>; refunded?: (paid: Paid) => Promise<void> },
): Promise<{ cleared: number; revoked: number }> {
  const result = { cleared: 0, revoked: 0 };
  if (!paypalSalesConfigured() || !store.statsId || !store.paypalSeller || !isRedisConfigured()) return result;
  const statsId = store.statsId;
  const now = Math.floor(Date.now() / 1000);

  const [waiting] = await redisPipeline([["ZRANGEBYSCORE", pendingKey(statsId), "-inf", "+inf", "LIMIT", "0", "25"]]);
  for (const order of Array.isArray(waiting) ? (waiting as string[]) : []) {
    if (Date.now() >= deadline) return result;
    const opened = await readOpened(order);
    // Thirty days without PayPal settling it: no longer asked about.
    if (!opened || (await readPaid(order))) {
      await redisPipeline([["ZREM", pendingKey(statsId), order]]);
      continue;
    }
    let done: Record<string, unknown>;
    try {
      done = await call("GET", `/v2/checkout/orders/${encodeURIComponent(order)}`, { merchant: opened.m });
    } catch (error) {
      console.error("reading a PayPal order failed", error);
      continue;
    }
    const { capture, payee, email } = captureIn(done);
    // Approved and never taken: nothing was charged, and nothing is taken now.
    if (!capture) {
      if (done.status !== "APPROVED" && done.status !== "CREATED" && done.status !== "SAVED") await redisPipeline([["ZREM", pendingKey(statsId), order]]);
      continue;
    }
    if (capture.status === "PENDING") continue;
    if (capture.status === "COMPLETED" && matches(opened, capture, payee) && email && typeof capture.id === "string") {
      const { paid, fresh } = await settle(order, opened, capture.id, email);
      if (fresh) {
        await on.handOver(paid);
        result.cleared += 1;
      }
      continue;
    }
    // Declined, failed, or not what was asked: nothing is handed over.
    await redisPipeline([["ZREM", pendingKey(statsId), order]]);
  }

  const dropStart = on.dropStart;
  const [due] = await redisPipeline([["ZRANGEBYSCORE", watchKey(statsId), "0", String(now), "LIMIT", "0", "25"]]);
  let revoked = 0;
  for (const order of Array.isArray(due) ? (due as string[]) : []) {
    if (Date.now() >= deadline) break;
    const paid = await readPaid(order);
    if (!paid || !paid.capture) {
      await redisPipeline([["ZREM", watchKey(statsId), order]]);
      continue;
    }
    let status = "";
    try {
      const capture = await call("GET", `/v2/payments/captures/${encodeURIComponent(paid.capture)}`, { merchant: store.paypalSeller.merchant });
      status = typeof capture.status === "string" ? capture.status : "";
    } catch (error) {
      console.error("reading a PayPal capture failed", error);
      continue;
    }
    if (status !== "REFUNDED") {
      const next = nextLook(paid.at, now);
      await redisPipeline([next === null ? ["ZREM", watchKey(statsId), order] : ["ZADD", watchKey(statsId), String(next), order]]);
      continue;
    }
    // Refunded in full: counted as a refund in the store's numbers and the affiliate book, whatever is handed back below.
    await redisPipeline([
      ["ZADD", refundedKey(statsId), String(now), order],
      ["EXPIRE", refundedKey(statsId), SALES_KEPT_SECONDS],
    ]);
    if (on.refunded) await on.refunded(paid).catch((error) => console.error("telling of a PayPal refund failed", error));
    const [given] = await redisPipeline([["HGET", importedKey(statsId, paid.email), paid.product]]);
    let items: string[] = [];
    try {
      const v = JSON.parse(String(given)) as { job?: unknown; items?: unknown };
      // Only what this very payment gave is taken back.
      if (v.job !== `paypal:${order}`) {
        await redisPipeline([["ZREM", watchKey(statsId), order]]);
        continue;
      }
      items = Array.isArray(v.items) ? (v.items as string[]) : [];
    } catch {
      await redisPipeline([["ZREM", watchKey(statsId), order]]);
      continue;
    }
    // Another payment of this address for the same product still stands: it keeps it.
    const own = ownKey(statsId, paid.email, paid.product);
    const [, others] = await redisPipeline([["SREM", own, order], ["SMEMBERS", own]]);
    let kept: Paid | null = null;
    for (const other of Array.isArray(others) ? (others as string[]) : []) {
      kept = await readPaid(other);
      if (kept) break;
    }
    if (kept) {
      await redisPipeline([
        ["HSET", importedKey(statsId, paid.email), paid.product, JSON.stringify({ at: kept.at, job: `paypal:${kept.order}`, items: items.length ? items : null })],
        ["ZREM", watchKey(statsId), order],
      ]);
      continue;
    }
    await redisPipeline([
      ["HDEL", importedKey(statsId, paid.email), paid.product],
      ["ZREM", watchKey(statsId), order],
    ]);
    for (const id of [paid.product, ...items]) await dropStart(paid.email, id);
    revoked += 1;
  }
  result.revoked = revoked;
  return result;
}

/**
 * The store's PayPal sales paid since `since` (seconds), newest first, at most
 * `limit`: one range and one read of the orders. Nothing is asked of PayPal.
 */
export async function readPayPalSales(statsId: string | null, since: number, limit: number): Promise<{ sales: Paid[]; partial: boolean }> {
  if (!statsId || !isRedisConfigured()) return { sales: [], partial: false };
  const [orders] = await redisPipeline([["ZREVRANGEBYSCORE", salesKey(statsId), "+inf", String(Math.max(0, since)), "LIMIT", "0", String(limit + 1)]]);
  const list = (Array.isArray(orders) ? (orders as string[]) : []).filter((o) => ORDER_ID.test(o));
  if (!list.length) return { sales: [], partial: false };
  const partial = list.length > limit;
  const read = await redisPipeline([["MGET", ...list.slice(0, limit).map(paidKey)]]);
  const rows = Array.isArray(read[0]) ? (read[0] as unknown[]) : [];
  const sales: Paid[] = [];
  for (const raw of rows) {
    try {
      const paid = typeof raw === "string" ? (JSON.parse(raw) as Paid) : null;
      if (paid && paid.store === statsId && typeof paid.order === "string") sales.push(paid);
    } catch {
      // An order that cannot be read is left out, not guessed at.
    }
  }
  return { sales, partial };
}

/** The keys a PayPal order kept, by the order: for a closed store's deletion (lib/closed-store-data.ts). */
export const paypalOrderKeys = (order: string): string[] => (ORDER_ID.test(order) ? [orderKey(order), paidKey(order)] : []);

/** PayPal sales refunded in full since `since` (seconds): the payment, how much, in what, and when the refund was seen. */
export async function readPayPalRefundsWithCoverage(statsId: string | null, since: number): Promise<{ rows: { order: string; capture: string; cents: number; currency: string; at: number }[]; partial: boolean }> {
  if (!statsId || !isRedisConfigured()) return { rows: [], partial: false };
  const [orders] = await redisPipeline([["ZRANGEBYSCORE", refundedKey(statsId), String(Math.max(0, since)), "+inf", "WITHSCORES", "LIMIT", "0", "501"]]);
  const flat = Array.isArray(orders) ? (orders as string[]) : [];
  const out: { order: string; capture: string; cents: number; currency: string; at: number }[] = [];
  let missing = false;
  for (let i = 0; i + 1 < Math.min(flat.length, 1000); i += 2) {
    const paid = await readPaid(flat[i]);
    if (paid && paid.store === statsId) out.push({ order: paid.order, capture: paid.capture, cents: paid.cents, currency: paid.currency, at: Number(flat[i + 1]) || 0 });
    else missing = true;
  }
  return { rows: out, partial: flat.length > 1000 || missing };
}

export async function readPayPalRefunds(statsId: string | null, since: number): Promise<{ order: string; capture: string; cents: number; currency: string; at: number }[]> {
  return (await readPayPalRefundsWithCoverage(statsId, since)).rows;
}

/** What a payment is called where a refund names it: the capture, so it never mixes with a Stripe payment's id. */
export const paypalPaymentId = (capture: string) => `paypal:${capture}`;
