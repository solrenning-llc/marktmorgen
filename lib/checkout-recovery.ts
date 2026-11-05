/**
 * An abandoned checkout: one reminder, only to a buyer who said yes to it.
 *
 * A buyer who opens a store's checkout and leaves without paying is usually
 * someone who meant to come back and did not. One email an hour later, with
 * the way back to the product, is the whole of this feature. What makes it
 * something we are willing to send is what stands in front of it:
 *
 *   - The creator switches it on, in the studio. It is off for every store
 *     until they do, and it needs the postal address US law asks every email
 *     about buying something to carry.
 *   - The buyer agrees, on Stripe's own checkout page. The checkout is opened
 *     with Stripe's promotional-consent collection (consent_collection
 *     .promotions = "auto") and with recovery switched on
 *     (after_expiration.recovery), which is the pair Stripe documents for
 *     abandoned-cart email. A reminder goes out only when Stripe reports the
 *     buyer's consent as "opt_in"; a buyer who was not asked, or said no, is
 *     never written to. Stripe decides where the question is shown, and it
 *     offers it only to businesses in the United States, so the studio
 *     switches this on only for a Stripe account whose country is the US.
 *   - One email per checkout, one per address and product in a week, none to
 *     someone who has since paid for that product, and none ever again to an
 *     address that pressed stop — or that left the creator's list.
 *
 * Every checkout here is a direct charge on the creator's own account, and so
 * is the consent: the buyer agrees to hear from the business named on that
 * checkout page, which is the creator. We send for them, from their name.
 *
 * The link in the email is to the product on the store, not the one-time
 * recovery address Stripe also makes. That address re-opens a copy of the
 * old checkout — its old price, and none of the unit a limited product held
 * for it — while the store page opens a new one at today's price, with
 * today's stock. The store page is the one that cannot sell something wrong.
 *
 *   nl:recover:sent:<session>                the reminder for that checkout went
 *   nl:recover:once:<statsId>:<hash>         that address heard about that product this week
 *   nl:recover:off:<statsId>:<hash>          that address pressed stop, kept for good
 *   nl:recover:link:<token>                  who a stop link belongs to
 */
import { fromPrice, listedLengths } from "@/lib/call-lengths";
import { takeDataBytes } from "@/lib/store-data";
import { saleHandles } from "@/lib/store";
import { activeIntro } from "@/lib/intro-price";
import { createHash, randomBytes } from "node:crypto";
import { normaliseEmail } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount, platformKey } from "@/lib/stripe-account";
import { RECOVERY_OPEN_SECONDS, recoveryOn } from "@/lib/recovery-setting";
import { isSettled } from "@/lib/instant-pay";
import { leadsKey, parseContact } from "@/lib/contacts";
import { canSellProduct, fromPriceCents } from "@/lib/store-checkout";
import { stockLeft } from "@/lib/stock";
import { type SessionRecord, fromCreator, storeBase } from "@/lib/purchase-email";
import { activePwyw } from "@/lib/pay-what-you-want";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";
import { readListing, readListings } from "@/lib/catalog";
import { BUMP_KEYS } from "@/lib/bundle-rules";
import { cartable, readCartIds } from "@/lib/cart-rules";
import { cartWords } from "@/lib/buyer-words/cart";
import { saleOff, salePrice } from "@/lib/store-sale";
import { cartAskIds } from "@/lib/checkout-ask-cart";
import type { Listing } from "@/lib/store";
import { membershipLine, speech } from "@/lib/buyer-words";
import { givingWords } from "@/lib/buyer-words/giving";
import { type CallListing, slotsForProduct } from "@/lib/calls";
import { isTimeZone, readableTime, zoneName } from "@/lib/call-setup";
import { chargeNow } from "@/lib/call-deposit";
import { bookingWords } from "@/lib/buyer-words/booking";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { noteForErasure } from "@/lib/erasure-index";
import { suppressedCommand, wasSuppressed } from "@/lib/suppression";
import { assistRemindKey } from "@/lib/assistant-reminder-rules";

/** A checkout that closed longer ago than this is left alone. */
export const REMIND_WITHIN_SECONDS = 6 * 60 * 60;
/** One reminder per address and product in this long, however many checkouts. */
export const ONCE_PER_SECONDS = 7 * 24 * 60 * 60;
/** How long a stop link keeps working. */
const LINK_SECONDS = 400 * 24 * 60 * 60;

export const STOP_TOKEN = /^[0-9a-f]{40}$/;
const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const who = (email: string) => sha(`nimbus-recover:${normaliseEmail(email)}`).slice(0, 32);
const sentKey = (session: string) => `nl:recover:sent:${session}`;
const onceKey = (statsId: string, email: string, product: string) =>
  `nl:recover:once:${statsId}:${sha(`nimbus-recover-once:${normaliseEmail(email)}|${product}`).slice(0, 32)}`;
const offKey = (statsId: string, email: string) => `nl:recover:off:${statsId}:${who(email)}`;
/** What a reminder's stop mark can keep for good, counted in the store's data room before it is sent. */
export const RECOVER_TRACE_BYTES = 192;
const linkKey = (token: string) => `nl:recover:link:${token}`;

export type CountryAnswer = { state: "ok"; country: string } | { state: "unknown" };

/** The country of the creator's Stripe account, as Stripe says. */
export async function accountCountry(store: Store): Promise<CountryAnswer> {
  if (!store.stripeAccountId || !platformKey()) return { state: "unknown" };
  try {
    const account = await onAccount("GET", store.stripeAccountId, "/account");
    return typeof account.country === "string" && account.country
      ? { state: "ok", country: account.country.toUpperCase() }
      : { state: "unknown" };
  } catch (error) {
    console.error("reading the account country failed", error);
    return { state: "unknown" };
  }
}

/** Where a cart's reminder leads: the store, with the cart put back as it was and open (components/store-cart.tsx). */
export function cartLink(store: Store, ids: string[]): string {
  return `${storeBase(store)}?restore=${ids.map(encodeURIComponent).join(",")}#cart`;
}

/** Where a reminder's link leads: the product's own page on the store. */
export function productLink(store: Store, productId: string): string {
  return `${storeBase(store)}/p/${encodeURIComponent(productId)}`;
}

async function stopLink(store: Store, email: string): Promise<{ page: string; oneClick: string }> {
  const token = randomBytes(20).toString("hex");
  const grant = { k: store.statsId, e: normaliseEmail(email), h: store.handle, n: store.name };
  await redisPipeline([["SET", linkKey(token), JSON.stringify(grant), "EX", LINK_SECONDS], ...noteForErasure(store.statsId, email, linkKey(token))]);
  return {
    page: `${SITE_URL}/unsubscribe?r=${token}`,
    oneClick: `${SITE_URL}/api/mail/unsubscribe?r=${token}`,
  };
}

/** Who a stop link belongs to, without acting on it. */
export async function readStopToken(
  token: string,
): Promise<{ email: string; storeName: string; stopped: boolean; handle: string } | null> {
  if (!STOP_TOKEN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const grant = JSON.parse(raw) as { k?: unknown; e?: unknown; n?: unknown; h?: unknown };
    if (typeof grant.k !== "string" || typeof grant.e !== "string" || !grant.k || !grant.e) return null;
    const [off] = await redisPipeline([["EXISTS", offKey(grant.k, grant.e)]]);
    // The store's handle, so the page can speak the store's language.
    const handle = typeof grant.h === "string" ? grant.h : "";
    return { email: grant.e, storeName: typeof grant.n === "string" ? grant.n : "", stopped: Number(off) === 1, handle };
  } catch {
    return null;
  }
}

/** Stops every reminder from that store to that address, for good. Safe to press twice. */
export async function stopReminders(token: string): Promise<boolean> {
  if (!STOP_TOKEN.test(token) || !isRedisConfigured()) return false;
  const [raw] = await redisPipeline([["GET", linkKey(token)]]);
  if (typeof raw !== "string" || !raw) return false;
  try {
    const grant = JSON.parse(raw) as { k?: unknown; e?: unknown };
    if (typeof grant.k !== "string" || typeof grant.e !== "string" || !grant.k || !grant.e) return false;
    await redisPipeline([["SET", offKey(grant.k, grant.e), new Date().toISOString()]]);
    return true;
  } catch {
    return false;
  }
}

/** Whether the address paid this store for any of these products after the checkout opened. */
async function paidSince(store: Store, email: string, productIds: string[], since: number): Promise<boolean> {
  const handles = saleHandles(store);
  const query = new URLSearchParams({
    "customer_details[email]": email,
    status: "complete",
    "created[gte]": String(since),
    limit: "100",
  });
  const listed = await onAccount("GET", store.stripeAccountId as string, `/checkout/sessions?${query}`);
  const rows = Array.isArray(listed.data) ? (listed.data as SessionRecord[]) : [];
  // The product an order is for, and the ones added to it, as from a cart (lib/bundle-rules.ts, BUMP_KEYS).
  const bought = (row: SessionRecord) => [row.metadata?.product, ...BUMP_KEYS.map((key) => row.metadata?.[key])];
  return rows.some(
    (row) => isSettled(row) && handles.has(row.metadata?.store ?? "") && bought(row).some((id) => id && productIds.includes(id)),
  );
}

export type RemindOutcome = "sent" | "skip" | "failed";

/** The products of a cart that can still go in one and be bought now, in its order. */
async function cartItems(store: Store, raw: (string | undefined)[]): Promise<Listing[]> {
  const ids = readCartIds(raw.filter((id): id is string => typeof id === "string" && id !== ""));
  if (ids.length === 0) return [];
  const listed = await readListings(store, ids);
  return ids.flatMap((id) => {
    const product = listed.find((p) => p.id === id);
    return product && cartable(product) && canSellProduct(store, product) ? [product] : [];
  });
}

/**
 * Sends the reminder for one checkout that closed unpaid, when everything
 * above allows it. Called by the five-minute job with each closed checkout
 * of a store that has reminders on.
 */
export async function remindAbandoned(
  store: Store,
  session: SessionRecord,
  nowSeconds = Date.now() / 1000,
): Promise<RemindOutcome> {
  if (!recoveryOn(store) || !store.stripeAccountId || !store.statsId) return "skip";
  const id = typeof session.id === "string" ? session.id : "";
  if (!SESSION_ID_PATTERN.test(id) || session.status !== "expired") return "skip";
  // Consent, as Stripe recorded it. Nothing else counts as a yes.
  if (session.consent?.promotions !== "opt_in") return "skip";
  const meta = session.metadata ?? {};
  const handles = saleHandles(store);
  if (!handles.has(meta.store ?? "")) return "skip";
  const closed = typeof session.expires_at === "number" ? session.expires_at : 0;
  if (!closed || nowSeconds - closed > REMIND_WITHIN_SECONDS || closed > nowSeconds) return "skip";
  const typed = session.customer_details?.email;
  const email = typeof typed === "string" && typed ? typed : typeof session.customer_email === "string" ? session.customer_email : "";
  if (!email) return "skip";
  // The buyer checked the Store assistant's own box for this checkout
  // (lib/assistant-reminder.ts): its reminder is the one, an hour on.
  const [assisted] = await redisPipeline([["EXISTS", assistRemindKey(id)]]);
  if (Number(assisted) === 1) return "skip";

  const created = typeof session.created === "number" ? session.created : closed - RECOVERY_OPEN_SECONDS;
  // A call (lib/calls.ts): its time was held only while the checkout was
  // open, so the reminder leads back to the times still open, never to a
  // time that may have gone. Not for a session from a package: nothing was
  // to be paid, and its own link books another.
  if (meta.kind === "call") {
    if (meta.package) return "skip";
    const start = Number(meta.start);
    const product = meta.product ? await readListing(store, meta.product) : null;
    if (!Number.isSafeInteger(start) || start <= 0) return "skip";
    if (!product || !product.call || product.hidden || !canSellProduct(store, product)) return "skip";
    // The length chosen, on a call with several (lib/call-lengths.ts), as the sale keeps it.
    const minutes = /^\d{1,3}$/.test(meta.minutes ?? "") ? Number(meta.minutes) : undefined;
    if (!(await hasOpenTime(store, product as CallListing, minutes))) return "skip";
    return deliver(store, { kind: "call", product, start, tz: meta.tz ?? "", minutes }, email, {
      claim: id,
      since: created,
      why: givingWords(store.language).recoverWhyCheckout(store.name),
    });
  }
  // A cart (lib/cart-checkout.ts): one reminder of what is in it that can still be bought.
  if (meta.cart === "yes") {
    const items = await cartItems(store, [meta.product, ...BUMP_KEYS.map((key) => meta[key])]);
    if (items.length === 0) return "skip";
    return deliver(store, { kind: "cart", items }, email, {
      claim: id,
      since: created,
      why: givingWords(store.language).recoverWhyCheckout(store.name),
    });
  }

  // Only something that can still be bought, and bought now.
  const product = meta.product ? await readListing(store, meta.product) : null;
  if (!product || product.call || !canSellProduct(store, product)) return "skip";
  const left = await stockLeft(store, product).catch(() => null);
  if (left === 0) return "skip";

  return deliver(store, { kind: "product", product }, email, {
    claim: id,
    since: created,
    why: givingWords(store.language).recoverWhyCheckout(store.name),
  });
}

/** Whether a call has a time or a session anybody could book now. Unreadable is no. */
async function hasOpenTime(store: Store, product: CallListing, minutes?: number): Promise<boolean> {
  // At the length the buyer chose, on a call with several (lib/call-lengths.ts): the link leads to its times.
  const chosen = minutes && listedLengths(product.call, product.priceCents).some((l) => l.minutes === minutes) ? minutes : null;
  const offer = await slotsForProduct(store, product, null, chosen);
  if (!offer) return false;
  return offer.sessions.length > 0 || offer.days.some((day) => day.starts.length > 0);
}

/** Where a call's reminder leads: its page of open times on the store. */
export function bookLink(store: Store, productId: string): string {
  return `${storeBase(store)}/book/${encodeURIComponent(productId)}`;
}

/**
 * Sends the reminder a buyer asked for themselves, on the way back from a
 * checkout they did not finish (lib/checkout-ask.ts). The same email, under
 * the same limits; what differs is who said yes, and where.
 */
export async function remindAsked(
  store: Store,
  ask: { productId: string; email: string; askedAt: number; key: string; from?: "checkout" | "page" },
): Promise<RemindOutcome> {
  if (!recoveryOn(store) || !store.stripeAccountId || !store.statsId) return "skip";
  // A cart, asked for on the way back from its checkout (lib/checkout-ask.ts, CART_ASK).
  const cart = cartAskIds(ask.productId);
  if (cart) {
    const items = await cartItems(store, cart);
    if (items.length === 0) return "skip";
    return deliver(store, { kind: "cart", items }, ask.email, { claim: `ask-${ask.key}`, since: ask.askedAt, why: givingWords(store.language).recoverWhyAsked(store.name) });
  }
  const product = await readListing(store, ask.productId);
  if (!product || product.call || product.hidden || !canSellProduct(store, product)) return "skip";
  const left = await stockLeft(store, product).catch(() => null);
  if (left === 0) return "skip";
  const g = givingWords(store.language);
  return deliver(store, { kind: "product", product }, ask.email, {
    claim: `ask-${ask.key}`,
    since: ask.askedAt,
    why: g.recoverWhyAsked(store.name),
    // Asked for on the product's page: no checkout was left, and the email says what was asked.
    ...(ask.from === "page"
      ? { subject: g.pageAskSubject(product.title), lead: g.pageAskLead(product.title, store.name), only: g.pageAskOnly(g.recoverWhyAsked(store.name)) }
      : {}),
  });
}

/**
 * Sends the Store assistant's reminder for one checkout that closed unpaid
 * (lib/assistant-reminder.ts), to the address the buyer typed beside the box
 * they checked at checkout. The same email under the same limits as the
 * other two; what differs is who said yes, where (`why`), and the AI line
 * (`note`). Needs the postal address and a checkout of this store that
 * Stripe says expired; the caller has checked the consent and the timing.
 */
export async function remindAssisted(
  store: Store,
  session: SessionRecord,
  input: { email: string; why: string; note?: (products: Listing[]) => Promise<string[]> },
  nowSeconds = Date.now() / 1000,
): Promise<RemindOutcome> {
  if (!store.stripeAccountId || !store.statsId || !store.recovery.address || !input.email) return "skip";
  const id = typeof session.id === "string" ? session.id : "";
  if (!SESSION_ID_PATTERN.test(id) || session.status !== "expired") return "skip";
  const meta = session.metadata ?? {};
  if (!saleHandles(store).has(meta.store ?? "")) return "skip";
  const closed = typeof session.expires_at === "number" ? session.expires_at : 0;
  if (!closed || closed > nowSeconds) return "skip";
  const created = typeof session.created === "number" ? session.created : closed - RECOVERY_OPEN_SECONDS;
  const how = { claim: id, since: created, why: input.why, note: input.note };
  if (meta.cart === "yes") {
    const items = await cartItems(store, [meta.product, ...BUMP_KEYS.map((key) => meta[key])]);
    if (items.length === 0) return "skip";
    return deliver(store, { kind: "cart", items }, input.email, how);
  }
  const product = meta.product ? await readListing(store, meta.product) : null;
  if (!product || product.call || meta.kind === "call" || !canSellProduct(store, product)) return "skip";
  const left = await stockLeft(store, product).catch(() => null);
  if (left === 0) return "skip";
  return deliver(store, { kind: "product", product }, input.email, how);
}

/**
 * The one email, and everything that stands in front of it whoever agreed:
 * never twice for one checkout, once per address and product in a week,
 * never to an address that pressed stop or left the creator's list, and
 * never to somebody who has paid for it since.
 */
async function deliver(
  store: Store,
  about: { kind: "product"; product: Listing } | { kind: "cart"; items: Listing[] } | { kind: "call"; product: Listing; start: number; tz: string; minutes?: number },
  email: string,
  how: {
    claim: string;
    since: number;
    why: string;
    subject?: string;
    lead?: string;
    only?: string;
    /**
     * Lines written for this email once every gate above has let it through
     * and its room is taken, put under its first line: the Store assistant's
     * AI line with its label (lib/assistant-reminder.ts). None is fine.
     */
    note?: (products: Listing[]) => Promise<string[]>;
  },
): Promise<RemindOutcome> {
  const id = how.claim;
  const statsId = store.statsId as string;
  const ids = about.kind === "cart" ? about.items.map((p) => p.id) : [about.product.id];
  // What "once a week" counts: one product, or one cart of the same products in any order.
  const onceFor = about.kind === "cart" ? `cart:${[...ids].sort().join(",")}` : about.product.id;
  const [sent, off, once, contact, deleted] = await redisPipeline([
    ["EXISTS", sentKey(id)],
    ["EXISTS", offKey(statsId, email)],
    ["EXISTS", onceKey(statsId, email, onceFor)],
    store.listId ? ["HGET", leadsKey(store.listId), normaliseEmail(email)] : ["EXISTS", "nl:none"],
    suppressedCommand(store.listId, email),
  ]);
  if (Number(sent) === 1 || Number(off) === 1 || Number(once) === 1) return "skip";
  // Somebody deleted from this store is never written to again (lib/suppression.ts).
  if (wasSuppressed(deleted)) return "skip";
  // Someone who left the creator's list has said no to their email, and a
  // reminder is their email.
  if (store.listId && parseContact(contact)?.unsub) return "skip";

  if (await paidSince(store, email, ids, how.since)) {
    await redisPipeline([["SET", sentKey(id), "paid", "EX", ONCE_PER_SECONDS]]);
    return "skip";
  }

  // Taken before sending: whichever pass gets here first is the only one.
  const [claimed, claimedOnce] = await redisPipeline([
    ["SET", sentKey(id), "sending", "NX", "EX", ONCE_PER_SECONDS * 2],
    ["SET", onceKey(statsId, email, onceFor), "1", "NX", "EX", ONCE_PER_SECONDS],
  ]);
  if (claimed === null || claimedOnce === null) return "skip";

  // The stop mark this email's link may leave is kept for as long as the
  // store is, so it takes its room before the email goes (lib/store-data.ts):
  // a store whose room is full sends no reminder until it has room again.
  if (!(await takeDataBytes(store, "off", RECOVER_TRACE_BYTES)).ok) {
    await redisPipeline([["DEL", sentKey(id)], ["DEL", onceKey(statsId, email, onceFor)]]);
    return "failed";
  }
  const name = store.name;
  const { w, money } = speech(store);
  const g = givingWords(store.language);
  const stop = await stopLink(store, email);
  const noted = how.note ? await how.note(about.kind === "cart" ? about.items : [about.product]).catch(() => [] as string[]) : [];
  const note = noted.length ? ["", ...noted] : [];
  const foot = [how.only ?? g.recoverOnly(how.why), "", g.recoverStop(name, stop.page), `${name} · ${store.recovery.address}`, g.sentWith];
  let subject: string;
  let text: string;
  if (about.kind === "cart") {
    const c = cartWords(store.language);
    const titles = about.items.map((p) => p.title);
    const listed = titles.length > 1 ? `${titles.slice(0, -1).join(", ")} ${c.and} ${titles[titles.length - 1]}` : titles[0];
    const now = Math.floor(Date.now() / 1000);
    subject = c.mailSubject(name);
    text = [
      c.mailLead(listed, name),
      ...note,
      "",
      c.mailHere,
      cartLink(store, ids),
      "",
      c.mailPrices,
      ...about.items.map((p) => `- ${p.title}: ${money(salePrice(p.priceCents, saleOff(store.sale, p, now)))}`),
      "",
      ...foot,
    ].join("\n");
  } else if (about.kind === "call") {
    // The time the buyer picked, in the time zone they picked it in, so they know which checkout this was.
    const product = about.product;
    const tz = isTimeZone(about.tz) ? about.tz : (product.call?.tz ?? "UTC");
    const locale = LANGUAGES[parseLanguage(store.language)].locale;
    const when = `${readableTime(about.start, tz, locale)} (${zoneName(about.start, tz, locale)})`;
    subject = g.callSubject(product.title);
    // A deposit on an in-person booking (lib/call-deposit.ts): said as the booking page and Stripe's page say it, at today's price.
    const due = chargeNow({ priceCents: product.priceCents, currency: store.currency, deposit: product.call?.deposit ?? null, inPerson: Boolean(product.call?.place) });
    const deposit = due.rest > 0 ? [bookingWords(store.language).depositRest(money(due.rest), store.name)] : [];
    // A call with several lengths (lib/call-lengths.ts): the length chosen, at its price today, and the link to its times;
    // a length since taken off the list leads to the call's lengths, from the lowest price.
    const lengths = product.call ? listedLengths(product.call, product.priceCents) : [];
    const chosen = lengths.find((l) => l.minutes === about.minutes) ?? null;
    const title = chosen ? `${product.title}${bookingWords(store.language).chosenLength(chosen.minutes)}` : product.title;
    const price = chosen ? money(chosen.cents) : lengths.length ? w.fromPrice(money(fromPrice(lengths) as number)) : money(product.priceCents);
    const link = chosen ? `${bookLink(store, product.id)}?length=${chosen.minutes}` : bookLink(store, product.id);
    text = [g.callLead(title, when, name), "", g.callHere, link, "", g.recoverPrice(price), ...deposit, "", ...foot].join("\n");
  } else {
  const product = about.product;
  // The price as the store page says it: the floor of a price the buyer
  // chooses, and a membership's trial and set number of payments with it.
  const price = money(fromPriceCents(product));
  const from = (said: string) => (product.options.length > 1 ? w.fromPrice(said) : said);
  const priceWords = activePwyw(product)
    ? g.youChoosePrice(money(product.priceCents))
    : product.recurring
      ? from(membershipLine(store, product.recurring, price, activeIntro(product, store.tiers)))
      : from(price);
  subject = how.subject ?? g.recoverSubject(product.title);
  text = [
    how.lead ?? g.recoverLead(product.title, name),
    ...note,
    "",
    g.recoverHere,
    productLink(store, product.id),
    "",
    g.recoverPrice(priceWords),
    "",
    ...foot,
  ].join("\n");
  }

  let ok = false;
  try {
    ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
      // An email that asks for a sale is the creator's, like their list's:
      // from their own address where there is one (lib/mail-from.ts).
      from: fromCreator(store),
      to: email,
      subject: subject.slice(0, 200),
      text,
      replyTo: store.email,
      headers: { "List-Unsubscribe": `<${stop.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      idempotencyKey: `nimbus-recover:${id}`,
    });
  } finally {
    if (ok) {
      await redisPipeline([["SET", sentKey(id), "sent", "EX", ONCE_PER_SECONDS * 2]]);
    } else {
      await redisPipeline([["DEL", sentKey(id)], ["DEL", onceKey(statsId, email, onceFor)]]);
    }
  }
  return ok ? "sent" : "failed";
}

/**
 * Forgets that one person heard a reminder about each product this week
 * (lib/person-erasure.ts). Their press of "stop" is kept: it is their own
 * no, a one-way hash of the address, and the store's fingerprint of the
 * deleted address says the same (lib/suppression.ts).
 */
export async function forgetRecoveryPerson(statsId: string | null, productIds: string[], email: string): Promise<number> {
  if (!statsId || !productIds.length || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", ...productIds.map((p) => onceKey(statsId, email, p))]]);
  return Number(gone) || 0;
}
