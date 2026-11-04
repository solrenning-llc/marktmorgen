/**
 * A buyer getting back what they bought, at any time, without an account.
 *
 * The link on the thanks page works for three days, which is what stops a
 * leaked link from becoming a free copy for everyone. The cost of that is a
 * buyer who closes the tab, changes phone or comes back a month later and no
 * longer has what they paid for — and who blames the creator, not us.
 *
 * So the buyer types the address they paid with, and we email that address a
 * link to a page that lists everything it bought from this store, each with
 * its download or its link. Only whoever reads that inbox gets in, which is
 * the protection an account gives, without a password to invent or for us to
 * keep.
 *
 * Nothing is written down about purchases here. The list is asked of the
 * creator's own Stripe account every time, which is the record of who paid
 * for what; a refunded sale is left off, because Stripe says so, not because
 * we remembered. A membership that stopped stays on the list with nothing to
 * open and the way to renew, so its former member is told what happened
 * rather than finding it quietly gone (lib/membership-access.ts).
 *
 * Like cancelling a membership, this works whatever state the creator's own
 * Marktmorgen subscription is in: somebody paid for that file, and they get it.
 */
import { currentMeta } from "@/lib/tier-rules";
import { packageState, readBought } from "@/lib/call-packages";
import { giftFrom } from "@/lib/gifts";
import { readPreorder, soonOne } from "@/lib/preorders";
import { isGroupJob } from "@/lib/group-buy";
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount, platformKey } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import type { ProductFile } from "@/lib/product-file";
import { isLiveSub, soldAMembership } from "@/lib/membership-access";
import { disputeLost, purchaseRefunded, refundedInFull } from "@/lib/refunds";
import type { Listing, Store } from "@/lib/store";
import { listingFinder, readListings, sellsAny, sellsThings } from "@/lib/catalog";
import { paidCalls } from "@/lib/calls";
import { roomsFor } from "@/lib/call-rooms";
import type { CallSetup } from "@/lib/call-setup";
import { type BumpKey, bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { IMPORTED_REFERENCE, importedFor, importedReference } from "@/lib/imported-purchases";
import { ordersWords } from "@/lib/buyer-words/orders";

/** How long the emailed link opens the list. */
export const ORDERS_LINK_SECONDS = 24 * 60 * 60;
export const ORDERS_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
/** The most purchases one list shows, newest first. */
export const MAX_LISTED = 40;

const IP_LIMIT = 10;
const ADDRESS_LIMIT = 5;
const RATE_WINDOW_SECONDS = 60 * 60;
const SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const INTENT_ID_PATTERN = /^pi_[A-Za-z0-9]{10,200}$/;
const CUSTOMER_PATTERN = /^cus_[A-Za-z0-9]{6,64}$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenKey = (token: string) => `nl:orders:link:${sha(`nimbus-orders:${token}`).slice(0, 40)}`;
const ipKey = (ip: string, handle: string) => `nl:rl:orders:ip:${sha(`nimbus-orders-ip:${ip}:${handle}`).slice(0, 32)}`;
const addressKey = (email: string) => `nl:rl:orders:addr:${sha(`nimbus-orders-addr:${email}`).slice(0, 32)}`;

/** One thing a buyer can open again. */
export type Delivery = {
  title: string;
  file: ProductFile | null;
  link: string | null;
};

/** One product of a bundle on the list of purchases, with what it hands over. */
export type PurchaseLine = {
  productId: string;
  title: string;
  delivery: Delivery | null;
  /** A course opens on its own page. */
  courseProduct: string | null;
};

/** What a bundle on the list hands over, and how many of its products the store no longer has. */
export type PurchaseItems = { lines: PurchaseLine[]; missing: number };

/** A product ticked at checkout, on a purchase. */
/** `courseProduct`: a course anywhere in a cart opens on its own page, as the first one does (lib/order-courses.ts). */
export type AddedPurchase = { key: BumpKey; id: string; title: string; delivery: Delivery | null; items: PurchaseItems | null; courseProduct: string | null };

export type Purchase = {
  /**
   * The Checkout Session, or the one-click payment, that paid for it — or,
   * for something brought over from another platform, an "imp_" reference
   * of its own (lib/imported-purchases.ts).
   */
  reference: string;
  /**
   * "sale" is a checkout; "upsell" is what was added in one click after it;
   * "imported" was brought over by the creator from another platform, with
   * no payment here.
   */
  kind: "sale" | "upsell" | "imported";
  title: string;
  /** The price option chosen, when the product has several. */
  option: string | null;
  paidAt: number;
  /** A membership, still being paid for. */
  member: boolean;
  /**
   * A membership that has ended. It hands nothing over any more; the page
   * says so and offers the way back.
   */
  ended: boolean;
  /** The product bought, as the store lists it. */
  productId: string;
  /** A course opens on its own page rather than as a download. */
  courseProduct: string | null;
  main: Delivery | null;
  /** When the product is a bundle: its products, from the list on the order. */
  items: PurchaseItems | null;
  /**
   * The products ticked at checkout, delivered with it, in the order of
   * their boxes: each under the key the order names it by
   * (lib/bundle-rules.ts, BUMP_KEYS), with its file or link, or its
   * products when it is a bundle.
   */
  added: AddedPurchase[];
  /** Given as a gift (lib/gifts.ts): the name of whoever gave it, "someone" when they gave none. */
  giftFrom?: string | null;
  /** A place in a purchase somebody made for several people (lib/group-buy.ts). */
  place?: boolean;
  /** Paid for with PayPal, into the creator's own PayPal account (lib/paypal-sales.ts). */
  paidWith?: "paypal";
  /** Given by the creator's own tools, through the API (lib/api-write.ts): no payment, and not brought over either. */
  givenByStore?: boolean;
  /** A private podcast opens as a feed of the buyer's own (lib/podcast-access.ts). */
  podcastProduct?: string | null;
  /** A package of calls: where its sessions are booked, and how many are left (lib/call-packages.ts). */
  packageBook?: string | null;
  packageLeft?: number;
  packageExpired?: boolean;
  /**
   * A pre-order (lib/preorders.ts): still waiting for the day it comes out,
   * with that day when one is set, or handed over since.
   */
  preorder?: { day: string | null; given: boolean };
};

/** The products of a list on an order, each with what it hands over now. */
async function linesOf(find: (id: string | undefined) => Promise<Listing | null>, ids: string[]): Promise<PurchaseItems | null> {
  if (ids.length === 0) return null;
  const lines: PurchaseLine[] = [];
  let missing = 0;
  for (const id of ids) {
    const item = await find(id);
    if (!item) {
      missing += 1;
      continue;
    }
    const delivery = item.options.length === 0 && (item.file || item.link) ? { title: item.title, file: item.file, link: item.link } : null;
    lines.push({ productId: item.id, title: item.title, delivery, courseProduct: item.course ? item.id : null });
  }
  return { lines, missing };
}

/**
 * Whether this store's buyers can be offered this at all: its sales are on a
 * Stripe account we can read, or it brought buyers over from another
 * platform (lib/imported-purchases.ts), who have no Stripe sale to look up.
 */
export function canRecover(store: Store): boolean {
  const stripe = Boolean(store.stripeAccountId) && platformKey() !== null;
  return (stripe || store.pastBuyers) && isRedisConfigured() && isSenderConfigured();
}

/**
 * What an emailed link is tied to: the Stripe account the purchases are on,
 * or, for a store that has only buyers brought over, the store itself. A link
 * stops working when that changes.
 */
function grantAccount(store: Store): string {
  return store.stripeAccountId ?? `imports:${store.statsId ?? ""}`;
}

/** One booked call still to come, as the buyer's list shows it. */
export type BookedCall = {
  /** The checkout session that paid for it: the key to its calendar file and its move page. */
  session: string;
  productId: string;
  title: string;
  start: number;
  end: number;
  /** The buyer's own time zone, as they booked in it. */
  buyerTz: string;
  moves: number;
  setup: CallSetup;
  /** Where to join: the room made for it, the creator's own link, or null when they send one. */
  room: string | null;
};

/**
 * The calls this address booked here that have not ended yet, soonest
 * first, each with where to join. Read from the creator's Stripe account, the
 * ledger, with any move applied.
 */
export async function callsFor(store: Store, email: string): Promise<BookedCall[]> {
  if (!store.stripeAccountId || !sellsAny(store, "call")) return [];
  const who = normaliseEmail(email);
  const now = Date.now();
  const mine = (await paidCalls(store))
    .filter((call) => call.email !== null && normaliseEmail(call.email) === who && call.end > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_LISTED);
  if (mine.length === 0) return [];
  const listings = await readListings(store, mine.map((call) => call.product));
  const known = mine.flatMap((call) => {
    const setup = listings.find((p) => p.id === call.product)?.call;
    return setup ? [{ call, setup, title: listings.find((p) => p.id === call.product)!.title }] : [];
  });
  const rooms = await roomsFor(
    store.callsId,
    known.map(({ call, setup }) => ({ product: call.product, setup, session: call.session, start: call.start, end: call.end })),
  );
  // In person (lib/call-place.ts): no link, not even a room kept from when it was online.
  known.forEach(({ setup }, i) => {
    if (setup.place) rooms[i] = null;
  });
  return known.map(({ call, setup, title }, i) => ({
    session: call.session,
    productId: call.product,
    title,
    start: call.start,
    end: call.end,
    buyerTz: call.buyerTz,
    moves: call.moves,
    setup,
    room: rooms[i],
  }));
}

/** Whether the store sells anything a buyer would come back for: a thing, or a call to join. */
export function sellsDeliverables(store: Store): boolean {
  return sellsThings(store) || sellsAny(store, "call");
}

function deliveryOf(product: Listing, optionId: string | undefined): { delivery: Delivery | null; option: string | null } {
  if (product.options.length > 0) {
    const option = product.options.find((o) => o.id === optionId) ?? null;
    if (!option) return { delivery: null, option: null };
    const delivery = option.file || option.link ? { title: product.title, file: option.file, link: option.link } : null;
    return { delivery, option: option.label };
  }
  const delivery = product.file || product.link ? { title: product.title, file: product.file, link: product.link } : null;
  return { delivery, option: null };
}

type Row = Record<string, unknown>;
type Listed = { data?: unknown };

function rows(listed: Listed): Row[] {
  return Array.isArray(listed.data) ? (listed.data as Row[]) : [];
}

/** Whether Stripe says this charge was given back in full: the shared rule (lib/refunds.ts). */
const refunded = refundedInFull;

/**
 * Everything this address paid this store for that can be handed over again,
 * newest first, read from the creator's own Stripe account.
 */
export async function purchasesFor(store: Store, email: string): Promise<Purchase[]> {
  const account = store.stripeAccountId;
  if (!account && !store.pastBuyers) return [];
  const handles = saleHandles(store);
  const find = listingFinder(store);
  const found = new Map<string, Purchase>();
  const customers = new Set<string>();

  // Stripe keeps the address as it was typed at checkout.
  const variants = account ? [...new Set([email.trim(), normaliseEmail(email)])] : [];
  for (const variant of variants) {
    const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
    query.append("expand[]", "data.subscription");
    query.append("expand[]", "data.payment_intent.latest_charge");
    const listed = (await onAccount("GET", account as string, `/checkout/sessions?${query}`)) as Listed;
    for (const session of rows(listed)) {
      const id = typeof session.id === "string" ? session.id : "";
      if (!SESSION_ID_PATTERN.test(id) || found.has(id)) continue;
      // A membership switched to another tier hands over what it is on now (lib/tier-rules.ts).
      const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
      if (!handles.has(meta.store ?? "")) continue;
      if (!isSettled(session)) continue;
      if (meta.kind === "call") continue;
      // A gift is on its recipient's list, not its buyer's (lib/gifts.ts).
      if (meta.gift) continue;
      // Bought for several: each place is on the list of whoever took it (lib/group-buy.ts).
      if (meta.group) continue;
      // A pre-order: on the list as one until it is handed over; from then on
      // it is on the list under the buyer's address, as a gift is (lib/preorders.ts).
      if (meta.preorder) {
        const product = await find(meta.product);
        if (!product) continue;
        if (await purchaseRefunded(account, session)) continue;
        const entry = await readPreorder(store, product.id, id);
        if (entry?.given || entry?.revoked) continue;
        const coming = await soonOne(store, product.id).catch(() => ({ soon: true, day: null }));
        found.set(id, {
          reference: id,
          kind: "sale",
          title: product.title,
          option: null,
          paidAt: typeof session.created === "number" ? session.created : 0,
          member: false,
          ended: false,
          productId: product.id,
          courseProduct: null,
          main: null,
          items: null,
          added: [],
          preorder: { day: coming.day, given: false },
        });
        continue;
      }
      // A package of calls: its sessions left, and the way to book them (lib/call-packages.ts).
      if (meta.kind === "package") {
        const bought = await readBought(id);
        const product = bought ? await find(meta.product) : null;
        if (!bought || !product) continue;
        if (await purchaseRefunded(account, session)) continue;
        const state = await packageState(bought);
        found.set(id, {
          reference: id,
          kind: "sale",
          title: ordersWords(store.language).packageTitle(product.title, bought.total),
          option: null,
          paidAt: typeof session.created === "number" ? session.created : 0,
          member: false,
          ended: false,
          productId: product.id,
          courseProduct: null,
          main: null,
          items: null,
          added: [],
          packageBook: state.left > 0 ? `/@${store.handle}/book/${product.id}?pkg=${bought.token}` : null,
          packageLeft: state.left,
          packageExpired: state.expired,
        });
        continue;
      }
      const product = await find(meta.product);
      if (!product || product.call) continue;
      if (await purchaseRefunded(account, session)) continue;

      // A membership hands its thing over while it is being paid for.
      const member = soldAMembership(product, { mode: session.mode, metadata: meta });
      if (member) {
        const sub = session.subscription as { status?: unknown } | null;
        if (!sub || typeof sub !== "object" || !isLiveSub(sub)) {
          found.set(id, {
            reference: id,
            kind: "sale",
            title: product.title,
            option: null,
            paidAt: typeof session.created === "number" ? session.created : 0,
            member: false,
            ended: true,
            productId: product.id,
            courseProduct: null,
            main: null,
            items: null,
            added: [],
          });
          continue;
        }
      }

      const { delivery, option } = deliveryOf(product, meta.option);
      const courseProduct = product.course ? product.id : null;
      const podcastProduct = product.podcast ? product.id : null;
      // A bundle, bought or ticked: its products, from the list on the order.
      const items = await linesOf(find, bundleFromMeta(meta, "bundle"));
      const added: AddedPurchase[] = [];
      for (const { key, id: addedId } of bumpsFromMeta(meta)) {
        const listing = await find(addedId);
        if (!listing) continue;
        const delivery = listing.file || listing.link ? { title: listing.title, file: listing.file, link: listing.link } : null;
        const inside = await linesOf(find, bundleFromMeta(meta, `${key}_bundle`));
        const course = listing.course ? listing.id : null;
        if (delivery || inside || course) added.push({ key, id: listing.id, title: listing.title, delivery, items: inside, courseProduct: course });
      }
      if (!delivery && !added.length && !courseProduct && !podcastProduct && !items) continue;

      if (typeof session.customer === "string" && CUSTOMER_PATTERN.test(session.customer)) customers.add(session.customer);
      found.set(id, {
        reference: id,
        kind: "sale",
        title: product.title,
        option,
        paidAt: typeof session.created === "number" ? session.created : 0,
        member,
        ended: false,
        productId: product.id,
        courseProduct,
        podcastProduct,
        // A course is its own way in. Bought at one of several prices, the
        // price chosen may include a file or a link of its own: handed over
        // here too, for as long as the course is (it used to be on the page
        // after paying only, which closes after three days).
        main: courseProduct && product.options.length === 0 ? null : delivery,
        items,
        added,
      });
    }
  }

  // What was added in one click after paying is its own payment, made for
  // the customer the checkout created.
  for (const customer of account ? [...customers].slice(0, 10) : []) {
    const query = new URLSearchParams({ customer, limit: "50" });
    query.append("expand[]", "data.latest_charge");
    const listed = (await onAccount("GET", account as string, `/payment_intents?${query}`)) as Listed;
    for (const intent of rows(listed)) {
      const id = typeof intent.id === "string" ? intent.id : "";
      if (!INTENT_ID_PATTERN.test(id) || found.has(id)) continue;
      const meta = (intent.metadata ?? {}) as Record<string, string>;
      if (meta.kind !== "upsell" || !handles.has(meta.store ?? "")) continue;
      if (intent.status !== "succeeded" || refunded(intent)) continue;
      // Lost to a dispute is given back too (lib/refunds.ts); asked only of a charge Stripe marks disputed.
      if (await disputeLost(account as string, intent)) continue;
      const product = await find(meta.product);
      const items = product ? await linesOf(find, bundleFromMeta(meta, "bundle")) : null;
      if (!product || !(product.file || product.link || items)) continue;
      found.set(id, {
        reference: id,
        kind: "upsell",
        title: product.title,
        option: null,
        paidAt: typeof intent.created === "number" ? intent.created : 0,
        member: false,
        ended: false,
        productId: product.id,
        courseProduct: null,
        main: product.file || product.link ? { title: product.title, file: product.file, link: product.link } : null,
        items,
        added: [],
      });
    }
  }

  // Brought over from another platform by the creator, or given as a gift:
  // no payment by this address, so nothing on Stripe to read under it, and
  // shown as exactly that.
  if (store.pastBuyers && store.statsId) {
    for (const given of await importedFor(store, email)) {
      const product = await find(given.productId);
      if (!product) continue;
      const reference = importedReference(store.statsId, email, product.id);
      // Given at one of the product's prices: that option is what is theirs.
      const { delivery, option } = deliveryOf(product, given.option ?? undefined);
      const items = given.items?.length ? await linesOf(find, given.items) : null;
      const courseProduct = product.course ? product.id : null;
      const podcastProduct = product.podcast ? product.id : null;
      if (!delivery && !courseProduct && !podcastProduct && !items) continue;
      found.set(reference, {
        reference,
        kind: "imported",
        giftFrom: await giftFrom(given.job),
        ...(isGroupJob(given.job) ? { place: true } : {}),
        ...(given.job.startsWith("paypal:") ? { paidWith: "paypal" as const } : {}),
        ...(given.job.startsWith("api:") ? { givenByStore: true } : {}),
        ...(given.job.startsWith("pre:") ? { preorder: { day: null, given: true } } : {}),
        podcastProduct,
        title: product.title,
        option,
        paidAt: given.at,
        member: false,
        ended: false,
        productId: product.id,
        courseProduct,
        main: courseProduct && product.options.length === 0 ? null : delivery,
        items,
        added: [],
      });
    }
  }

  // An ended membership is shown once, and not at all when the same address
  // has joined again since: the running one is what they have.
  const all = [...found.values()].sort((a, b) => b.paidAt - a.paidAt);
  const running = new Set(all.filter((p) => p.member).map((p) => p.productId));
  const shownEnded = new Set<string>();
  const kept = all.filter((p) => {
    if (!p.ended) return true;
    if (running.has(p.productId) || shownEnded.has(p.productId)) return false;
    shownEnded.add(p.productId);
    return true;
  });
  return kept.slice(0, MAX_LISTED);
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

function senderAddress(): string {
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return (match ? match[1] : NIMBUS_FROM).trim();
}

type Grant = {
  /** The connected account the purchases are on. */
  a: string;
  /** The address that proved it reads its own inbox. */
  e: string;
};

export type OrdersRequest = "sent" | "email" | "limited" | "unavailable" | "error";

/**
 * Emails a way back to what the address bought here.
 *
 * "sent" is the answer whether or not anything was found, and nothing is sent
 * to an address that bought nothing, so this cannot be used to learn who is a
 * customer of whom, or to fill a stranger's inbox.
 */
export async function requestOrdersLink(input: {
  store: Store;
  email: string;
  ip: string;
  origin: string;
}): Promise<OrdersRequest> {
  const { store, ip, origin } = input;
  const raw = input.email.trim();
  if (!raw || raw.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(raw)) return "email";
  const email = normaliseEmail(raw);
  if (!canRecover(store)) return "unavailable";

  if (!(await within(ipKey(ip, store.handle), IP_LIMIT))) return "limited";
  if (!(await within(addressKey(email), ADDRESS_LIMIT))) return "limited";

  const [purchases, calls] = await Promise.all([purchasesFor(store, raw), callsFor(store, raw)]);
  if (purchases.length === 0 && calls.length === 0) return "sent";

  const token = randomBytes(32).toString("hex");
  // Kept as typed: Stripe matches the address as it was written at checkout.
  const grant: Grant = { a: grantAccount(store), e: raw };
  await redisPipeline([["SET", tokenKey(token), JSON.stringify(grant), "EX", ORDERS_LINK_SECONDS]]);

  const name = store.name;
  const count = purchases.length + calls.length;
  const link = `${origin}/@${store.handle}/orders?token=${token}`;
  const words = ordersWords(store.language);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: `"${words.ordersFrom(displayName(name))}" <${senderAddress()}>`,
    to: email,
    subject: words.ordersSubject(name),
    text: [
      words.ordersIntro(name, count),
      "",
      link,
      "",
      words.ordersLinkNote,
      "",
      words.ordersIgnore,
      "",
      `${words.ordersSentBy(name)} ${chargedLine(name, purchases, store.language)}`,
    ].join("\n"),
  });
  return sent ? "sent" : "error";
}

/**
 * Who charged what, in one sentence, for the email that sends the list of
 * purchases: in the store's language, English when none is given.
 */
export function chargedLine(
  name: string,
  purchases: Pick<Purchase, "kind" | "giftFrom" | "paidWith" | "place">[],
  language?: unknown,
): string {
  const brought = purchases.some((p) => p.kind === "imported" && !p.giftFrom && !p.paidWith && !p.place);
  const paypal = purchases.some((p) => p.paidWith === "paypal");
  const words = ordersWords(language);
  return brought ? words.chargedBrought(name, paypal) : words.chargedAll(name, paypal);
}

/**
 * A link to the list of purchases for one address, made without asking:
 * for someone who was just given something (lib/gifts.ts), whose email is
 * the proof. Null when this store's purchases cannot be listed.
 */
export async function ordersLinkFor(store: Store, email: string, base: string): Promise<string | null> {
  if (!isRedisConfigured()) return null;
  const token = randomBytes(32).toString("hex");
  const grant: Grant = { a: grantAccount(store), e: normaliseEmail(email) };
  await redisPipeline([["SET", tokenKey(token), JSON.stringify(grant), "EX", ORDERS_LINK_SECONDS]]);
  return `${base}/orders?token=${token}`;
}

/** The address a live link was issued to, for this store only. */
export async function ordersGrant(store: Store, token: string): Promise<string | null> {
  if (!ORDERS_TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", tokenKey(token)]]);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const grant = JSON.parse(raw) as Partial<Grant>;
    if (grant.a !== grantAccount(store) || typeof grant.e !== "string" || !grant.e) return null;
    return grant.e;
  } catch {
    return null;
  }
}

/**
 * The one purchase a download asks for, when the link's address paid for it.
 * Read again from Stripe, so a refund made a minute ago is already honoured.
 */
export async function findPurchase(store: Store, token: string, reference: string): Promise<Purchase | null> {
  if (reference.startsWith("imp_") && !IMPORTED_REFERENCE.test(reference)) return null;
  const email = await ordersGrant(store, token);
  if (!email) return null;
  const purchases = await purchasesFor(store, email);
  return purchases.find((p) => p.reference === reference) ?? null;
}
