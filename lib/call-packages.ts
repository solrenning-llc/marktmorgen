/**
 * Packages of calls, sold, kept and spent (the rules are in
 * lib/call-package-rules.ts).
 *
 *   nl:pkg:<checkout>        a package bought: who, which call, how many, until when, its sessions
 *   nl:pkg:t:<sha(token)>    the checkout a booking link's token stands for
 *
 * The purchase is a checkout of its own on the creator's Stripe account
 * (metadata kind "package"). Each session is then booked like any call, on a
 * checkout that a single-use coupon for the whole of it makes free, and that
 * carries metadata "package" — so the booking, its reminders, its meeting
 * link, its move and the creator's list of bookings are exactly those of a
 * call bought on its own, and none of that had to learn anything new.
 *
 * A session counts as spent from the moment its time is held; if the buyer
 * leaves Stripe's page without finishing, it comes back once the hold is
 * over. A package refunded in full books nothing more. A package with a last
 * day to book is kept a year past it, then dropped.
 */
import { ADMITTED_FIELD, OrdersPausedError, admitOrders } from "@/lib/order-admission";
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type DataOwner, orderWrite } from "@/lib/order-data";
import { normaliseEmail } from "@/lib/auth";
import { StripeError, onAccount } from "@/lib/stripe-account";
import { isConfirmed } from "@/lib/calls";
import { inTheCurrencyShown, isSettled, onlyInstantMethods } from "@/lib/instant-pay";
import { purchaseRefunded } from "@/lib/refunds";
import { sendEmail } from "@/lib/email";
import { applyTax, applyTaxDocuments, openKeepingTheSale } from "@/lib/tax";
import { withLock } from "@/lib/redis-lock";
import { type CallPackage, MAX_PACKAGE_SESSIONS, MIN_PACKAGE_SESSIONS, PACKAGE_DAYS } from "@/lib/call-package-rules";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { speechFor, wordsIn } from "@/lib/buyer-words";
import { bookingWords } from "@/lib/buyer-words/booking";
import type { Listing, Store } from "@/lib/store";
import { applyShare, leastPaid, linesTotal, shareBps } from "@/lib/platform-share";
import { codesMayTakeOff } from "@/lib/discount";

export const PACKAGE_TOKEN = /^[0-9a-f]{48}$/;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
/** A held session is counted as spent a little past its hold, until the mail job has confirmed or freed it. */
const HOLD_GRACE_SECONDS = 15 * 60;

export type Hold = { session: string; until: number };
export type Bought = {
  /** The store's statsId, its handle when bought, the call product. */
  s: string;
  h: string;
  p: string;
  /** Who bought it: the address that books its sessions. */
  e: string;
  total: number;
  /** When bought, and the last moment to book, in seconds; 0 is no limit. */
  at: number;
  until: number;
  token: string;
  /** Every session booked or being booked from it. */
  holds: Hold[];
};

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const pkgKey = (checkout: string) => `nl:pkg:${checkout}`;
const tokenKey = (token: string) => `nl:pkg:t:${sha(token)}`;
/**
 * The packages a store sold (added 18 October 2026): a package with no last
 * day is kept for as long as it can be used, and is named by its checkout,
 * not by its store, so a store that closes finds its packages here
 * (lib/closed-store-data.ts). Kept with the store: a checkout's id a package.
 */
export const packagesKey = (statsId: string) => `nl:pkg:s:${statsId}`;
export const packageKeys = (checkout: string, token: string): string[] => [pkgKey(checkout), `${pkgKey(checkout)}:lock`, ...(token ? [tokenKey(token)] : [])];
const now = () => Math.floor(Date.now() / 1000);
/** Kept a year past its last day to book; a package with no limit is kept as long as it can be used. */
const KEEP_AFTER_SECONDS = 365 * 86_400;
const keep = (bought: Bought): string[] => (bought.until ? ["EX", String(Math.max(60, bought.until + KEEP_AFTER_SECONDS - now()))] : []);

const unconfirmedPackage = () => new Error("The package purchase could not be confirmed.");

/** Capture paid evidence without inheriting fields or evaluating computed values. */
function ownPackageValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, "value") ? field.value : undefined;
}

function ownPackageFields(value: unknown, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, ownPackageValue(value, key)]));
}

/** Only an explicit null confirms absence; a partial read cannot replace a purchase. */
function packageReply(reply: unknown): string | null {
  if (!Array.isArray(reply) || reply.length !== 1) throw unconfirmedPackage();
  const slot = Object.getOwnPropertyDescriptor(reply, "0");
  if (!slot || !Object.hasOwn(slot, "value") || (slot.value !== null && typeof slot.value !== "string")) throw unconfirmedPackage();
  return slot.value;
}

const seconds = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value * 1000).getTime());

export async function readBought(checkout: string): Promise<Bought | null> {
  if (!SESSION_ID.test(checkout)) return null;
  if (!isRedisConfigured()) throw unconfirmedPackage();
  const raw = packageReply(await redisPipeline([["GET", pkgKey(checkout)]]));
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Bought;
    if (!value || ["s", "h", "p", "e", "total", "at", "until", "token", "holds"].some(key => ownPackageValue(value, key) === undefined) ||
      [value.s, value.h, value.p, value.e].some((field) => typeof field !== "string" || !field) ||
      !Number.isSafeInteger(value.total) || value.total < 1 || value.total > MAX_PACKAGE_SESSIONS ||
      !seconds(value.at) || !seconds(value.until) || (value.until !== 0 && value.until < value.at) ||
      typeof value.token !== "string" || !PACKAGE_TOKEN.test(value.token) || !Array.isArray(value.holds) ||
      !value.holds.every((hold) => {
        const session = ownPackageValue(hold, "session"), until = ownPackageValue(hold, "until");
        return typeof session === "string" && SESSION_ID.test(session) && seconds(until);
      })) throw unconfirmedPackage();
    return value;
  } catch {
    throw unconfirmedPackage();
  }
}

export async function boughtByToken(token: string): Promise<{ checkout: string; bought: Bought } | null> {
  if (!PACKAGE_TOKEN.test(token)) return null;
  if (!isRedisConfigured()) throw unconfirmedPackage();
  const checkout = packageReply(await redisPipeline([["GET", tokenKey(token)]]));
  if (checkout === null) return null;
  if (!SESSION_ID.test(checkout)) throw unconfirmedPackage();
  const bought = await readBought(checkout);
  return bought && bought.token === token ? { checkout, bought } : null;
}

/** Sessions spent: booked, or held now. */
export async function spent(bought: Bought, at = now()): Promise<number> {
  let n = 0;
  for (const hold of bought.holds) {
    if (hold.until + HOLD_GRACE_SECONDS > at || (await isConfirmed(hold.session))) n += 1;
  }
  return n;
}

export type PackageState = { left: number; total: number; expired: boolean; until: number };

export async function packageState(bought: Bought, at = now()): Promise<PackageState> {
  const used = await spent(bought, at);
  const expired = bought.until > 0 && at > bought.until;
  return { left: expired ? 0 : Math.max(0, bought.total - used), total: bought.total, expired, until: bought.until };
}

/** Opens the checkout that buys a package, on the creator's own account. */
/** The checkout that buys a package, as Stripe is sent it. */
export function packageCheckoutBody(store: Store, product: Listing, pkg: CallPackage, origin: string): URLSearchParams {
  // Stripe's page, and what it lists, in the store's language (lib/store-language.ts).
  const b = bookingWords(store.language);
  const name = b.packageName(product.title, pkg.sessions);
  const body = new URLSearchParams({
    mode: "payment",
    locale: LANGUAGES[parseLanguage(store.language)].stripe,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": store.currency,
    "line_items[0][price_data][unit_amount]": String(pkg.priceCents),
    "line_items[0][price_data][product_data][name]": name.slice(0, 250),
    "line_items[0][price_data][product_data][description]": b.packageDescription(pkg.sessions, wordsIn(parseLanguage(store.language)).packageLimit(pkg.days)),
    "metadata[store]": store.handle,
    "metadata[product]": product.id,
    "metadata[title]": name.slice(0, 480),
    "metadata[kind]": "package",
    "metadata[sessions]": String(pkg.sessions),
    "metadata[days]": String(pkg.days),
    "payment_intent_data[metadata][store]": store.handle,
    "payment_intent_data[metadata][product]": product.id,
    "payment_intent_data[metadata][kind]": "package",
    success_url: `${origin}/@${store.handle}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/@${store.handle}/book/${product.id}`,
  });
  if (store.hasDiscounts) body.set("allow_promotion_codes", "true");
  applyTax(store, body);
  // A package is the dearest single payment a store takes, and so the one a
  // business buyer most often needs a tax number on and an invoice for.
  applyTaxDocuments(store, body, false);
  // Like every checkout here: only ways to pay that settle while the buyer is
  // on the page, in the currency the page showed (lib/instant-pay.ts).
  onlyInstantMethods(body);
  inTheCurrencyShown(body);
  return body;
}

/** Opens the checkout that buys a package, on the creator's own account. */
export async function packageCheckout(
  store: Store,
  product: Listing,
  pkg: CallPackage,
  origin: string,
  /** The channel this sale is credited to, as Stripe metadata (lib/visit-channel.ts channelOfRequest). */
  channel: Record<string, string> = {},
): Promise<{ url: string; id: string }> {
  if (!store.stripeAccountId) throw new Error("This store has no account");
  const account = store.stripeAccountId;
  const body = packageCheckoutBody(store, product, pkg, origin);
  for (const [key, value] of Object.entries(channel)) body.set(`metadata[${key}]`, value);
  // A package is an order (lib/order-admission.ts): admitted before Stripe's page opens.
  const admitted = await admitOrders(store, 1);
  if (!admitted.ok) throw new OrdersPausedError(admitted.reason);
  if (admitted.hour !== null) body.set(`metadata[${ADMITTED_FIELD}]`, String(admitted.hour));
  // The share of the sale, when the store's plan has one (lib/platform-share.ts).
  const mayComeOff = store.hasDiscounts && shareBps(store) > 0 ? await codesMayTakeOff(store.stripeAccountId, store.currency) : [];
  applyShare(body, store, { recurring: false, least: leastPaid(linesTotal(body).cents, mayComeOff) });
  const made = await openKeepingTheSale(body, () => onAccount("POST", account, "/checkout/sessions", body));
  if (typeof made.url !== "string" || typeof made.id !== "string") throw new Error("Stripe returned no checkout");
  return { url: made.url, id: made.id };
}

type Session = {
  id?: unknown;
  status?: unknown;
  payment_status?: unknown;
  created?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
};

/**
 * Writes a paid package down, once, and emails its buyer the link that books
 * its sessions. Returns the package, or null when this checkout is not one.
 */
export async function recordPackage(input: { store: Store; session: Session; product: Listing; base: string; from: string }): Promise<Bought | null> {
  const { store, product } = input;
  const session = ownPackageFields(input.session, ["id", "status", "payment_status", "created", "amount_total", "currency", "metadata", "customer_details"]) as Session;
  const meta = ownPackageFields(session.metadata, ["kind", "days", "sessions"]);
  const emailValue = ownPackageValue(session.customer_details, "email");
  const checkout = typeof session.id === "string" ? session.id : "";
  if (meta.kind !== "package" || !SESSION_ID.test(checkout) || !isSettled(session) || !store.statsId) return null;
  const existing = await readBought(checkout);
  // The token's key is written last, after the email: a record without it
  // is a purchase whose writes stopped half way (a lost reply, a failed
  // write), finished here, on the thanks page's reload or the sweep.
  if (existing) return (await tokenWritten(existing.token, checkout)) ? existing : finishPackage(store, product, input, session, checkout, existing);
  const email = typeof emailValue === "string" ? normaliseEmail(emailValue) : "";
  if (!email) return null;
  const integer = (value: unknown): number | null => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  };
  const at = session.created;
  const days = integer(meta.days);
  const total = integer(meta.sessions);
  if (!seconds(at) || days === null || !(PACKAGE_DAYS as readonly number[]).includes(days) ||
    total === null || total < MIN_PACKAGE_SESSIONS || total > MAX_PACKAGE_SESSIONS ||
    typeof session.amount_total !== "number" || !Number.isSafeInteger(session.amount_total) || session.amount_total < 0 ||
    typeof session.currency !== "string" || !/^[a-zA-Z]{3}$/.test(session.currency)) throw unconfirmedPackage();
  const until = days ? at + days * 86_400 : 0;
  if (!seconds(until)) throw unconfirmedPackage();
  const token = randomBytes(24).toString("hex");
  const bought: Bought = { s: store.statsId, h: store.handle, p: product.id, e: email, total, at, until, token, holds: [] };
  // Counted in the store's room at what they really add (lib/order-data.ts).
  const [fresh] = await orderWrite(store, [["SET", pkgKey(checkout), JSON.stringify(bought), "NX", ...keep(bought)]]);
  // Only "OK" is a new record; null is one written before; anything else is unknown.
  if (fresh === null) {
    const written = await readBought(checkout);
    if (!written) throw unconfirmedPackage();
    return (await tokenWritten(written.token, checkout)) ? written : finishPackage(store, product, input, session, checkout, written);
  }
  if (fresh !== "OK") throw unconfirmedPackage();
  return finishPackage(store, product, input, session, checkout, bought);
}

/** Is the booking link's token written, for this checkout? Unknown throws. */
async function tokenWritten(token: string, checkout: string): Promise<boolean> {
  const value = packageReply(await redisPipeline([["GET", tokenKey(token)]]));
  if (value === null) return false;
  if (value !== checkout) throw unconfirmedPackage();
  return true;
}

/**
 * The rest of a package's writes, safe to run again: its place in the
 * store's list, the email (the same idempotency key, so a retry within the
 * provider's window is not sent twice) and, last, the token's key, which
 * marks the purchase finished.
 */
async function finishPackage(store: Store, product: Listing, input: { base: string; from: string }, session: Session, checkout: string, bought: Bought): Promise<Bought> {
  const { base } = input;
  const { token, total, e: email } = bought;
  if (typeof session.amount_total !== "number" || !Number.isSafeInteger(session.amount_total) || session.amount_total < 0 ||
    typeof session.currency !== "string" || !/^[a-zA-Z]{3}$/.test(session.currency)) throw unconfirmedPackage();
  await orderWrite(store, [["SADD", packagesKey(bought.s), checkout]]);
  const amount = session.amount_total;
  const currency = session.currency;
  // In the store's language (lib/buyer-words/booking.ts), with the amount and
  // the date written its way, in the currency actually paid.
  const b = bookingWords(store.language);
  const said = speechFor(store.language, currency);
  await sendEmail({ meter: { by: "order" },
    from: input.from,
    to: email,
    subject: b.packageSubject(total, product.title).slice(0, 200),
    text: [
      b.packageThanks(store.name),
      "",
      b.packageWhat(product.title, total),
      b.packagePaid(said.money(amount)),
      b.packageReference(checkout),
      bought.until ? b.packageBookByDate(said.date(bought.until * 1000)) : b.packageNoLimit,
      "",
      b.packageBookHere,
      `${base}/book/${product.id}?pkg=${token}`,
      "",
      // In person (lib/call-place.ts): no meeting link is promised.
      product.call?.place ? b.packageKeepPlace : b.packageKeep,
      "",
      b.packageCharged(store.name),
    ].join("\n"),
    replyTo: store.email,
    idempotencyKey: `nimbus-package:${checkout}`,
  }).catch((error) => console.error("a package confirmation failed", error));
  await orderWrite(store, [["SET", tokenKey(token), checkout, ...keep(bought)]]);
  return bought;
}

/** The coupon that makes one session of a package free: all of it, once, for one checkout. */
export function sessionCouponBody(checkout: string, language: unknown = "en"): URLSearchParams {
  return new URLSearchParams({
    percent_off: "100",
    duration: "once",
    max_redemptions: "1",
    // Shown on Stripe's page, so in the store's language (lib/buyer-words/booking.ts).
    name: bookingWords(language).packageCoupon,
    "metadata[made_by]": "nimbus-labs",
    "metadata[purpose]": "call-package",
    "metadata[package]": checkout,
  });
}

export type BookResult =
  | { ok: true; fromPackage: { id: string; coupon: string; email: string; back: string } }
  | { ok: false; reason: "gone" | "used" | "expired" | "refunded" | "error" };

/**
 * Makes ready one session's checkout from a package: checks it is still
 * paid, not used up and not past its date, and makes the single-use coupon
 * that takes the whole session off. The session is counted by `holdSession`
 * once its time is held.
 */
export async function prepareSession(store: Store, token: string, origin: string): Promise<BookResult & { checkout?: string }> {
  const found = await boughtByToken(token);
  if (!found || found.bought.s !== store.statsId || !store.stripeAccountId) return { ok: false, reason: "gone" };
  const state = await packageState(found.bought);
  if (state.expired) return { ok: false, reason: "expired" };
  if (state.left <= 0) return { ok: false, reason: "used" };
  try {
    const session = await onAccount("GET", store.stripeAccountId, `/checkout/sessions/${encodeURIComponent(found.checkout)}?expand[]=payment_intent.latest_charge`);
    if (!isSettled(session)) return { ok: false, reason: "gone" };
    if (await purchaseRefunded(store.stripeAccountId, session)) return { ok: false, reason: "refunded" };
    const coupon = await onAccount("POST", store.stripeAccountId, "/coupons", sessionCouponBody(found.checkout, store.language));
    const id = typeof coupon.id === "string" ? coupon.id : "";
    if (!id) return { ok: false, reason: "error" };
    return {
      ok: true,
      checkout: found.checkout,
      fromPackage: { id: found.checkout, coupon: id, email: found.bought.e, back: `${origin}/@${store.handle}/book/${found.bought.p}?pkg=${token}` },
    };
  } catch (error) {
    if (!(error instanceof StripeError)) console.error("preparing a package session failed", error);
    return { ok: false, reason: "error" };
  }
}

/**
 * Counts a held session against its package, under a lock, and says no when
 * another tab took the last one first — in which case the caller lets the
 * time go again.
 */
export async function holdSession(store: DataOwner, checkout: string, session: string, until: number): Promise<boolean> {
  return withLock(`nl:pkg:${checkout}:lock`, 30, 10_000, async () => {
    const bought = await readBought(checkout);
    if (!bought) return false;
    const state = await packageState(bought);
    if (state.left <= 0) return false;
    bought.holds.push({ session, until });
    // What the record grows by is counted in the store's room (lib/order-data.ts).
    await orderWrite(store, [["SET", pkgKey(checkout), JSON.stringify(bought), ...keep(bought)]]);
    return true;
  });
}
