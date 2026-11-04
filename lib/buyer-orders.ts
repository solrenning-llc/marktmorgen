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
import { StripeError, onAccount, platformKey } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import type { ProductFile } from "@/lib/product-file";
import { isLiveSub, soldAMembership } from "@/lib/membership-access";
import { purchaseRefunded, refundedInFull } from "@/lib/refunds";
import type { Listing, Store } from "@/lib/store";
import { listingFinder, readListings, sellsAny, sellsThings } from "@/lib/catalog";
import { paidCalls } from "@/lib/calls";
import { roomsFor } from "@/lib/call-rooms";
import type { CallSetup } from "@/lib/call-setup";
import { type BumpKey, bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { IMPORTED_REFERENCE, type ImportedPurchase, importedFor, importedFrom, importedKey, importedReference } from "@/lib/imported-purchases";
import { ordersWords } from "@/lib/buyer-words/orders";
import { takePublicRequest } from "@/lib/traffic";
import {
  DOWNLOAD_LOOKUP_MS,
  DOWNLOAD_LOOKUP_UNITS,
  ORDERS_IMPORTED_COMMANDS,
  ORDERS_IMPORTED_ENTRY_COMMANDS,
  ORDERS_LISTING_COMMANDS,
  ORDERS_OPEN_UNITS,
  ORDERS_PREORDER_COMMANDS,
  ORDERS_READ_MS,
  ORDERS_ROOM_COMMANDS,
  ORDERS_UNIT_COMMANDS,
} from "@/lib/buyer-orders-rules";

/** How long the emailed link opens the list. */
export const ORDERS_LINK_SECONDS = 24 * 60 * 60;
export const ORDERS_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
/** The most purchases one list shows, newest first. */
export const MAX_LISTED = 40;

export {
  DOWNLOAD_LOOKUP_COMMANDS,
  DOWNLOAD_LOOKUP_MS,
  DOWNLOAD_LOOKUP_UNITS,
  ORDERS_FEED_COMMANDS,
  ORDERS_IMPORTED_COMMANDS,
  ORDERS_IMPORTED_ENTRY_COMMANDS,
  ORDERS_KEY_COMMANDS,
  ORDERS_LISTING_COMMANDS,
  ORDERS_OPEN_COMMANDS,
  ORDERS_OPEN_SECONDS,
  ORDERS_OPEN_UNITS,
  ORDERS_PREORDER_COMMANDS,
  ORDERS_READ_MS,
  ORDERS_ROOM_COMMANDS,
  ORDERS_UNIT_COMMANDS,
} from "@/lib/buyer-orders-rules";

/** The store had no room for what the opening still had to read: nothing more is read. */
export class OrdersBusy extends Error {
  constructor() {
    super("the store has no room to read more of this buyer's purchases");
  }
}

/** The opening ran past ORDERS_READ_MS: nothing more is read, and the page says the purchases could not be read. */
export class OrdersLate extends Error {
  constructor() {
    super("reading this buyer's purchases took too long");
  }
}

/**
 * What an opening reads past its first units, taken from the store's public
 * requests before it is read: as many requests as the commands asked for need,
 * ORDERS_UNIT_COMMANDS each, the rest of the last one kept for the next read.
 * Takes run one after another, so what is left is never counted twice. Once
 * the store has refused one, or the opening has run out of time (stop), every
 * later take and every check before a call to Stripe (alive) throws at once.
 */
export class OrdersMeter {
  private left = 0;
  private ended: "busy" | "late" | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Requests taken through this meter, for the tests. */
  taken = 0;
  constructor(private readonly store: Store) {}
  take(commands: number): Promise<void> {
    const next = this.queue.then(() => this.takeNow(commands));
    this.queue = next.catch(() => {});
    return next;
  }
  /** Throws when nothing more may be read: before a call to Stripe, which costs the opening's time rather than its commands. */
  alive(): void {
    if (this.ended === "busy") throw new OrdersBusy();
    if (this.ended === "late") throw new OrdersLate();
  }
  /** The opening is out of time: nothing more is read through this meter. */
  stop(): void {
    this.ended ??= "late";
  }
  private async takeNow(commands: number): Promise<void> {
    this.alive();
    if (!(commands > 0)) return;
    if (commands <= this.left) {
      this.left -= commands;
      return;
    }
    const units = Math.ceil((commands - this.left) / ORDERS_UNIT_COMMANDS);
    if (!(await takePublicRequest(this.store, "buyer", Date.now(), units))) {
      this.ended ??= "busy";
      throw new OrdersBusy();
    }
    this.alive();
    this.taken += units;
    this.left += units * ORDERS_UNIT_COMMANDS - commands;
  }
}

/**
 * An opening's reading, waited on ORDERS_READ_MS at the most (inside the page's
 * maxDuration, so the buyer is told rather than cut off). Past it the meter is
 * stopped, so nothing more is read or asked of Stripe, and "late" is answered.
 */
export async function withinOpening<T>(work: Promise<T>, meter: OrdersMeter, ms = ORDERS_READ_MS): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  // What is still running when time is up ends on its own, its failure seen by nobody.
  work.catch(() => {});
  try {
    const outcome = await Promise.race([work, late]);
    if (outcome === "late") meter.stop();
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Opening the orders page with a link: ORDERS_OPEN_UNITS of the store's buyer
 * requests taken before anything is read, then the link's address. A token not
 * shaped like one takes nothing and reads nothing; without room, nothing is read.
 */
export async function openOrders(store: Store, token: string): Promise<{ admitted: boolean; email: string | null; meter: OrdersMeter }> {
  const meter = new OrdersMeter(store);
  if (!ORDERS_TOKEN_PATTERN.test(token)) return { admitted: true, email: null, meter };
  if (!(await takePublicRequest(store, "buyer", Date.now(), ORDERS_OPEN_UNITS))) return { admitted: false, email: null, meter };
  return { admitted: true, email: await ordersGrant(store, token), meter };
}

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
export async function callsFor(store: Store, email: string, meter?: OrdersMeter): Promise<BookedCall[]> {
  if (!store.stripeAccountId || !sellsAny(store, "call")) return [];
  const who = normaliseEmail(email);
  const now = Date.now();
  // With a meter (the orders page), each read is taken: this buyer's listings and rooms before they are read. The move of
  // every booking the store's pages hold is read inside lib/calls.ts with the pages, before their number can be known
  // here, so it is taken as soon as it is (one command each, at most five pages of a hundred): an opening the store has
  // no more room for then reads nothing more.
  meter?.alive();
  const paid = await paidCalls(store);
  await meter?.take(paid.length);
  const mine = paid
    .filter((call) => call.email !== null && normaliseEmail(call.email) === who && call.end > now)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_LISTED);
  if (mine.length === 0) return [];
  await meter?.take(new Set(mine.map((call) => call.product)).size * ORDERS_LISTING_COMMANDS);
  const listings = await readListings(store, mine.map((call) => call.product));
  const known = mine.flatMap((call) => {
    const setup = listings.find((p) => p.id === call.product)?.call;
    return setup ? [{ call, setup, title: listings.find((p) => p.id === call.product)!.title }] : [];
  });
  if (store.callsId) await meter?.take(known.length * ORDERS_ROOM_COMMANDS);
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

/** Looks a product up by id, each read once, and, with a meter, taken from it the first time it is asked for. */
type Finder = (id: string | undefined) => Promise<Listing | null>;

function finderFor(store: Store, meter?: OrdersMeter): Finder {
  const listing = listingFinder(store);
  const asked = new Set<string>();
  return async (id) => {
    if (meter && id && !asked.has(id)) {
      asked.add(id);
      await meter.take(ORDERS_LISTING_COMMANDS);
    }
    return listing(id);
  };
}

/**
 * What one checkout of the address hands over again, as its list shows it, or
 * null when it hands over nothing there: the same reading for the whole list
 * (purchasesFor) and for one download (findPurchase). `customer` is the Stripe
 * customer a sale created, whose payments in one click after it are on the list.
 */
async function purchaseFromSession(
  store: Store,
  session: Row,
  find: Finder,
  meter?: OrdersMeter,
): Promise<{ purchase: Purchase; customer: string | null } | null> {
  const account = store.stripeAccountId as string;
  const id = typeof session.id === "string" ? session.id : "";
  if (!SESSION_ID_PATTERN.test(id)) return null;
  // A membership switched to another tier hands over what it is on now (lib/tier-rules.ts).
  const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
  if (!saleHandles(store).has(meta.store ?? "")) return null;
  if (!isSettled(session)) return null;
  if (meta.kind === "call") return null;
  // A gift is on its recipient's list, not its buyer's (lib/gifts.ts).
  if (meta.gift) return null;
  // Bought for several: each place is on the list of whoever took it (lib/group-buy.ts).
  if (meta.group) return null;
  // A pre-order: on the list as one until it is handed over; from then on
  // it is on the list under the buyer's address, as a gift is (lib/preorders.ts).
  if (meta.preorder) {
    const product = await find(meta.product);
    if (!product) return null;
    meter?.alive();
    if (await purchaseRefunded(account, session)) return null;
    await meter?.take(ORDERS_PREORDER_COMMANDS);
    const entry = await readPreorder(store, product.id, id);
    if (entry?.given || entry?.revoked) return null;
    const coming = await soonOne(store, product.id).catch(() => ({ soon: true, day: null }));
    return { customer: null, purchase: {
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
    } };
  }
  // A package of calls: its sessions left, and the way to book them (lib/call-packages.ts).
  if (meta.kind === "package") {
    await meter?.take(1);
    const bought = await readBought(id);
    const product = bought ? await find(meta.product) : null;
    if (!bought || !product) return null;
    meter?.alive();
    if (await purchaseRefunded(account, session)) return null;
    await meter?.take(bought.holds.length);
    const state = await packageState(bought);
    return { customer: null, purchase: {
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
    } };
  }
  const product = await find(meta.product);
  if (!product || product.call) return null;
  meter?.alive();
  if (await purchaseRefunded(account, session)) return null;

  // A membership hands its thing over while it is being paid for.
  const member = soldAMembership(product, { mode: session.mode, metadata: meta });
  if (member) {
    const sub = session.subscription as { status?: unknown } | null;
    if (!sub || typeof sub !== "object" || !isLiveSub(sub)) {
      return { customer: null, purchase: {
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
      } };
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
  if (!delivery && !added.length && !courseProduct && !podcastProduct && !items) return null;

  const customer = typeof session.customer === "string" && CUSTOMER_PATTERN.test(session.customer) ? session.customer : null;
  return { customer, purchase: {
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
  } };
}

/** What one payment taken in one click after a checkout hands over again, or null: the list's reading and one download's. */
async function purchaseFromIntent(store: Store, intent: Row, find: Finder): Promise<Purchase | null> {
  const id = typeof intent.id === "string" ? intent.id : "";
  if (!INTENT_ID_PATTERN.test(id)) return null;
  const meta = (intent.metadata ?? {}) as Record<string, string>;
  if (meta.kind !== "upsell" || !saleHandles(store).has(meta.store ?? "")) return null;
  if (intent.status !== "succeeded" || refunded(intent)) return null;
  const product = await find(meta.product);
  const items = product ? await linesOf(find, bundleFromMeta(meta, "bundle")) : null;
  if (!product || !(product.file || product.link || items)) return null;
  return {
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
  };
}

/** What one purchase brought over or given hands over again, or null: the list's reading and one download's. */
async function purchaseFromImported(store: Store, statsId: string, email: string, given: ImportedPurchase, find: Finder, meter?: OrdersMeter): Promise<Purchase | null> {
  const product = await find(given.productId);
  if (!product) return null;
  const reference = importedReference(statsId, email, product.id);
  // Given at one of the product's prices: that option is what is theirs.
  const { delivery, option } = deliveryOf(product, given.option ?? undefined);
  const items = given.items?.length ? await linesOf(find, given.items) : null;
  const courseProduct = product.course ? product.id : null;
  const podcastProduct = product.podcast ? product.id : null;
  if (!delivery && !courseProduct && !podcastProduct && !items) return null;
  // Who gave it is one read more.
  if (given.job.startsWith("gift:")) await meter?.take(1);
  return {
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
  };
}

/**
 * Everything this address paid this store for that can be handed over again,
 * newest first, read from the creator's own Stripe account.
 */
export async function purchasesFor(store: Store, email: string, meter?: OrdersMeter): Promise<Purchase[]> {
  const account = store.stripeAccountId;
  if (!account && !store.pastBuyers) return [];
  // With a meter (the orders page), each read that grows with what the buyer has is taken before it is made:
  // every listing the first time it is asked for, and each pre-order's, package's and import's records.
  const find = finderFor(store, meter);
  const found = new Map<string, Purchase>();
  const customers = new Set<string>();

  // Stripe keeps the address as it was typed at checkout.
  const variants = account ? [...new Set([email.trim(), normaliseEmail(email)])] : [];
  for (const variant of variants) {
    const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
    query.append("expand[]", "data.subscription");
    query.append("expand[]", "data.payment_intent.latest_charge");
    meter?.alive();
    const listed = (await onAccount("GET", account as string, `/checkout/sessions?${query}`)) as Listed;
    for (const session of rows(listed)) {
      const id = typeof session.id === "string" ? session.id : "";
      if (found.has(id)) continue;
      const got = await purchaseFromSession(store, session, find, meter);
      if (!got) continue;
      found.set(got.purchase.reference, got.purchase);
      if (got.customer) customers.add(got.customer);
    }
  }

  // What was added in one click after paying is its own payment, made for
  // the customer the checkout created.
  for (const customer of account ? [...customers].slice(0, 10) : []) {
    const query = new URLSearchParams({ customer, limit: "50" });
    query.append("expand[]", "data.latest_charge");
    meter?.alive();
    const listed = (await onAccount("GET", account as string, `/payment_intents?${query}`)) as Listed;
    for (const intent of rows(listed)) {
      const id = typeof intent.id === "string" ? intent.id : "";
      if (found.has(id)) continue;
      const purchase = await purchaseFromIntent(store, intent, find);
      if (purchase) found.set(purchase.reference, purchase);
    }
  }

  // Brought over from another platform by the creator, or given as a gift:
  // no payment by this address, so nothing on Stripe to read under it, and
  // shown as exactly that.
  if (store.pastBuyers && store.statsId) {
    if (meter) {
      // The whole record of the address is read at once: its entries are counted first, and paid for before it is read.
      await meter.take(ORDERS_IMPORTED_COMMANDS);
      const [entries] = await redisPipeline([["HLEN", importedKey(store.statsId, email)]]);
      await meter.take((Number(entries) || 0) * ORDERS_IMPORTED_ENTRY_COMMANDS);
    }
    for (const given of await importedFor(store, email)) {
      const purchase = await purchaseFromImported(store, store.statsId, email, given, find, meter);
      if (purchase) found.set(purchase.reference, purchase);
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

export type OrdersRequest = "sent" | "email" | "limited" | "busy" | "unavailable" | "error";

/**
 * Emails a way back to what the address bought here.
 *
 * "sent" is the answer whether or not anything was found, and nothing is sent
 * to an address that bought nothing, so this cannot be used to learn who is a
 * customer of whom, or to fill a stranger's inbox.
 *
 * What is read for the address is paid for before it is read, as an opening
 * of the list is (openOrders): past the per-address and per-IP limits,
 * ORDERS_OPEN_UNITS of the store's buyer requests, then every read that grows
 * with what the address has through an OrdersMeter, waited on ORDERS_READ_MS
 * at the most. "busy" when the store had no room for those units: nothing was
 * read, whatever the address. Once they are taken, the meter takes more only
 * for what the address has, so a refusal from it, or a reading that ran out of
 * time, is answered "sent" like everything else: anything else would tell who
 * bought here. The page's words say so honestly (lib/buyer-words/orders.ts,
 * sentBody and nothingArrived: a link normally arrives; if not, try later).
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

  if (!(await takePublicRequest(store, "buyer", Date.now(), ORDERS_OPEN_UNITS))) return "busy";
  const meter = new OrdersMeter(store);
  let read: [Purchase[], BookedCall[]] | "late";
  try {
    read = await withinOpening(Promise.all([purchasesFor(store, raw, meter), callsFor(store, raw, meter)]), meter);
  } catch (error) {
    if (error instanceof OrdersBusy) return "sent";
    throw error;
  }
  if (read === "late") return "sent";
  const [purchases, calls] = read;
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

/** What a download asks for besides its purchase: a product of a bundle by its id (`pid`), and a product ticked at checkout by its key (`item`). */
export type DownloadWant = { pid?: string; item?: string };

/**
 * The one purchase a download asks for, with the link's address, when that
 * address paid for it. Read again from Stripe, so a refund made a minute ago
 * is already honoured.
 *
 * Only that purchase is read, by its own reference, never the whole list:
 * DOWNLOAD_LOOKUP_UNITS of the store's buyer requests are taken before the
 * link's grant is read, and the listings it reads through the meter, all
 * waited on DOWNLOAD_LOOKUP_MS at the most. A checkout is read alone and must
 * have been paid with the link's address; a payment taken in one click after
 * one, with the checkout it followed, which must, and which the list would
 * hand over; one brought over, its one entry. Of its listings only what the
 * download asks for is read: the product bought, the one ticked (`item`) and
 * the one of a bundle (`pid`), which must be on the order's own list; the
 * other products of a bundle are never read. `listing` hands back what was
 * read, so the route reads nothing again. Throws OrdersBusy when the store
 * has no room (before Stripe is asked anything, or anything more), and
 * OrdersLate past that time.
 */
export async function findPurchase(
  store: Store,
  token: string,
  reference: string,
  want: DownloadWant = {},
): Promise<{ purchase: Purchase; email: string; listing: (id: string) => Promise<Listing | null> } | null> {
  const kind = SESSION_ID_PATTERN.test(reference) ? "session" : INTENT_ID_PATTERN.test(reference) ? "intent" : IMPORTED_REFERENCE.test(reference) ? "imported" : null;
  if (!kind || !ORDERS_TOKEN_PATTERN.test(token)) return null;
  if (!(await takePublicRequest(store, "buyer", Date.now(), DOWNLOAD_LOOKUP_UNITS))) throw new OrdersBusy();
  const email = await ordersGrant(store, token);
  if (!email) return null;
  const meter = new OrdersMeter(store);
  const found = await withinOpening(lookUp(store, email, kind, reference, meter, want), meter, DOWNLOAD_LOOKUP_MS);
  if (found === "late") throw new OrdersLate();
  return found;
}

/** One checkout or payment on the creator's account, null when Stripe has none by that id. */
async function readOne(store: Store, path: string, meter: OrdersMeter): Promise<Row | null> {
  meter.alive();
  try {
    return (await onAccount("GET", store.stripeAccountId as string, path, undefined, undefined, undefined, DOWNLOAD_LOOKUP_MS)) as Row;
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) return null;
    throw error;
  }
}

/** A checkout paid with this address, read alone with what the list reads it with. */
async function sessionOf(store: Store, email: string, id: string, meter: OrdersMeter): Promise<Row | null> {
  const query = new URLSearchParams();
  query.append("expand[]", "subscription");
  query.append("expand[]", "payment_intent.latest_charge");
  const session = await readOne(store, `/checkout/sessions/${encodeURIComponent(id)}?${query}`, meter);
  if (!session || session.status !== "complete") return null;
  const details = session.customer_details as { email?: unknown } | null | undefined;
  const paidWith = typeof details?.email === "string" ? details.email : "";
  return paidWith && normaliseEmail(paidWith) === normaliseEmail(email) ? session : null;
}

/**
 * A finder that reads only the products a download asks for, each once and
 * taken from the meter first, and answers null for every other without
 * reading it.
 */
function onlyFinder(store: Store, meter: OrdersMeter): { find: Finder; allow: (...ids: (string | undefined)[]) => void } {
  const base = finderFor(store, meter);
  const allowed = new Set<string>();
  return {
    find: (id) => (id && allowed.has(id) ? base(id) : Promise.resolve(null)),
    allow: (...ids) => ids.forEach((id) => id && allowed.add(id)),
  };
}

/** A product of a bundle asked for: only one on the order's own list (its metadata), read with nothing else of it. */
const inList = (ids: string[], pid: string | undefined) => !pid || ids.includes(pid);

/**
 * Whether the checkout a payment in one click followed is one the list would
 * hand over and so read that payment under: paid, this store's, not a gift,
 * a place, a call, a package of calls or a pre-order, its product there and
 * not a call, a membership still paid for, and not given back.
 */
async function handsOverAfter(store: Store, session: Row, find: Finder, meter: OrdersMeter): Promise<boolean> {
  const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
  if (!saleHandles(store).has(meta.store ?? "") || !isSettled(session)) return false;
  if (meta.kind === "call" || meta.kind === "package" || meta.gift || meta.group || meta.preorder) return false;
  const product = await find(meta.product);
  if (!product || product.call) return false;
  if (soldAMembership(product, { mode: session.mode, metadata: meta })) {
    const sub = session.subscription as { status?: unknown } | null;
    if (!sub || typeof sub !== "object" || !isLiveSub(sub)) return false;
  }
  meter.alive();
  return !(await purchaseRefunded(store.stripeAccountId, session));
}

async function lookUp(
  store: Store,
  email: string,
  kind: "session" | "intent" | "imported",
  reference: string,
  meter: OrdersMeter,
  want: DownloadWant,
): Promise<{ purchase: Purchase; email: string; listing: (id: string) => Promise<Listing | null> } | null> {
  const { find, allow } = onlyFinder(store, meter);
  const done = (purchase: Purchase | null) => (purchase ? { purchase, email, listing: (id: string) => find(id) } : null);
  if (kind === "imported") {
    if (!store.pastBuyers || !store.statsId) return null;
    const key = importedKey(store.statsId, email);
    // Its ids are read to know which one the reference names (each id a command at the most), then that entry alone.
    const [count] = await redisPipeline([["HLEN", key]]);
    await meter.take(Number(count) || 0);
    const [keys] = await redisPipeline([["HKEYS", key]]);
    const statsId = store.statsId;
    const productId = (Array.isArray(keys) ? keys.map(String) : []).find((id) => importedReference(statsId, email, id) === reference);
    if (!productId) return null;
    const [raw] = await redisPipeline([["HGET", key, productId]]);
    const [given] = importedFrom([productId, raw]);
    if (!given || !inList(given.items ?? [], want.pid)) return null;
    allow(given.productId, want.pid);
    return done(await purchaseFromImported(store, statsId, email, given, find, meter));
  }
  if (!store.stripeAccountId) return null;
  if (kind === "session") {
    const session = await sessionOf(store, email, reference, meter);
    if (!session) return null;
    const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
    const bump = want.item ? bumpsFromMeta(meta).find((b) => b.key === want.item) : undefined;
    if (want.item && !bump) return null;
    if (!inList(bundleFromMeta(meta, bump ? `${bump.key}_bundle` : "bundle"), want.pid)) return null;
    allow(meta.product, bump?.id, want.pid);
    return done((await purchaseFromSession(store, session, find, meter))?.purchase ?? null);
  }
  // A payment taken in one click: its own, made for the customer of the checkout it followed (lib/upsell.ts, metadata[parent]),
  // which must have been paid with this address and be one the list reads such payments under.
  const intent = await readOne(store, `/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`, meter);
  const intentMeta = (intent?.metadata ?? {}) as Record<string, string>;
  const parent = intentMeta.parent ?? "";
  if (!intent || !SESSION_ID_PATTERN.test(parent) || want.item) return null;
  if (!inList(bundleFromMeta(intentMeta, "bundle"), want.pid)) return null;
  const session = await sessionOf(store, email, parent, meter);
  if (!session) return null;
  const customer = (value: unknown) => (typeof value === "string" ? value : value && typeof value === "object" ? (value as { id?: unknown }).id : null);
  const owner = customer(session.customer);
  if (!owner || !CUSTOMER_PATTERN.test(String(owner)) || owner !== customer(intent.customer)) return null;
  allow(currentMeta((session.metadata ?? {}) as Record<string, string>, session).product);
  if (!(await handsOverAfter(store, session, find, meter))) return null;
  allow(intentMeta.product, want.pid);
  return done(await purchaseFromIntent(store, intent, find));
}
