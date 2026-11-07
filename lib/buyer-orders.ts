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
import { readPreorderJob } from "@/lib/preorder-rules";
import { isGroupJob } from "@/lib/group-buy";
import { saleHandles } from "@/lib/store";
import { createHash, randomBytes } from "node:crypto";
import { after } from "next/server";
import { EMAIL_PATTERN, MAX_EMAIL_LENGTH, normaliseEmail } from "@/lib/auth";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { StripeError, onAccount, platformKey } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import type { ProductFile } from "@/lib/product-file";
import { isLiveSub, soldAMembership } from "@/lib/membership-access";
import { keptUnlessLost, purchaseRefunded, refundedInFull } from "@/lib/refunds";
import type { Listing, Store } from "@/lib/store";
import { listingFinder, readListings, sellsAny, sellsThings } from "@/lib/catalog";
import { paidCalls } from "@/lib/calls";
import { roomsFor } from "@/lib/call-rooms";
import type { CallSetup } from "@/lib/call-setup";
import { type BumpKey, bumpsFromMeta, bundleFromMeta } from "@/lib/bundle-rules";
import { IMPORTED_REFERENCE, type ImportedPurchase, importedFor, importedFrom, importedKey, importedReference } from "@/lib/imported-purchases";
import { ordersWords } from "@/lib/buyer-words/orders";
import { type KeptConsent, readConsentMeta } from "@/lib/digital-consent";
import { takePublicRequest } from "@/lib/traffic";
import {
  ORDERS_LINK_READ_MS,
  DOWNLOAD_LOOKUP_MS,
  DOWNLOAD_LOOKUP_UNITS,
  ORDERS_CALL_MOVES,
  ORDERS_IMPORTED_COMMANDS,
  ORDERS_IMPORTED_ENTRY_COMMANDS,
  ORDERS_LISTING_COMMANDS,
  ORDERS_OPEN_UNITS,
  ORDERS_PREORDER_COMMANDS,
  ORDERS_READ_MS,
  ORDERS_ROOM_COMMANDS,
  ORDERS_UNIT_COMMANDS,
  ORDERS_BUNDLE_UNITS,
  ORDERS_KEY_COMMANDS,
  ORDERS_OLDER_UNITS,
  ORDERS_OLDER_MOST,
  ORDERS_OLDER_PAID_MOST,
  ORDERS_ONE_CLICK_LISTS,
  ORDERS_STRIPE_CALLS,
  ORDERS_STRIPE_LISTS,
  PLAN_REFUND_CALLS,
  ordersMovesCommands,
} from "@/lib/buyer-orders-rules";
import { type SaleKey, activeKeys, keyForSale } from "@/lib/licence-keys";

/** How long the emailed link opens the list. */
export const ORDERS_LINK_SECONDS = 24 * 60 * 60;
export const ORDERS_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
/** The most purchases one list shows, newest first. */
export const MAX_LISTED = 40;

export {
  ORDERS_LINK_READ_MS,
  DOWNLOAD_LOOKUP_COMMANDS,
  DOWNLOAD_LOOKUP_MS,
  DOWNLOAD_LOOKUP_UNITS,
  ORDERS_CALL_MOVES,
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
  ORDERS_BUNDLE_BYTES,
  ORDERS_BUNDLE_PER_HOUR,
  ORDERS_BUNDLE_UNITS,
  ORDERS_PAGE_BYTES,
  ORDERS_OLDER_BYTES,
  ORDERS_OLDER_COMMANDS,
  ORDERS_OLDER_PER_HOUR,
  ORDERS_OLDER_UNITS,
  ORDERS_OLDER_MOST,
  ORDERS_OLDER_PAID_MOST,
  ORDERS_ONE_CLICK_LISTS,
  ORDERS_STRIPE_CALLS,
  ORDERS_STRIPE_LISTS,
  LINK_SHOWN,
  HOST_SHOWN,
  PLAN_REFUND_CALLS,
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
  /** Calls to the creator's Stripe account still free for refund checks: ORDERS_STRIPE_CALLS, less the lists every opening may read. */
  private stripeLeft = ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS;
  /**
   * Checkouts not read because their refund could not be checked inside
   * ORDERS_STRIPE_CALLS, newest first: the page says how many, and the buyer
   * checks them a batch at a time when they ask (olderFor), from the first.
   * What was added to one of them in one click after paying waits with it.
   */
  older: string[] = [];
  /** Whether a checkout in `older` made a customer, so payments taken in one click after it may wait with it, not counted yet. */
  olderAdded = false;
  /**
   * Customers whose payments taken in one click are not shown because they
   * could not be checked inside ORDERS_STRIPE_CALLS (their list, or the
   * disputes of the charges Stripe marks disputed), each as "cus_…", or
   * "cus_…:n" when its first n were shown: checked by the next batch, first.
   */
  paid: string[] = [];
  /** Lists of payments taken in one click still free inside ORDERS_STRIPE_LISTS. */
  private lists = ORDERS_ONE_CLICK_LISTS;
  constructor(private readonly store: Store) {}
  /** Takes `calls` to the creator's Stripe account before they are made; false, taking nothing, when they would pass the ceiling. */
  stripe(calls: number): boolean {
    if (calls > this.stripeLeft) return false;
    this.stripeLeft -= calls;
    return true;
  }
  /** Takes one list of payments taken in one click: one of the ORDERS_ONE_CLICK_LISTS every reading may make, or past them a call from the ceiling. */
  list(): boolean {
    if (this.lists > 0) {
      this.lists -= 1;
      return true;
    }
    return this.stripe(1);
  }
  /** A checkout whose refund cannot be checked now: noted, newest first, for a batch to check when the buyer asks. */
  defer(session: Row): void {
    this.older.push(typeof session.id === "string" ? session.id : "");
    if (customerOf(session)) this.olderAdded = true;
  }
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
  /**
   * The opening is out of time: nothing more is read through this meter. A take
   * already asking the store when it stops keeps what it took without reading
   * for it: at most one take's requests, of an opening that already paid its own.
   */
  stop(): void {
    this.ended ??= "late";
  }
  /**
   * Takes the most a read can use before it is made, and holds every later
   * take until it says how many it used: what it did not use pays for those,
   * so none asks the store for more while the rest is still unknown. More than
   * the most is taken before it is used; less is kept for this opening only.
   */
  takeFor<T>(most: number, read: () => Promise<T>, used: (value: T) => number): Promise<T> {
    const done = this.queue.then(async () => {
      await this.takeNow(most);
      const value = await read();
      const n = used(value);
      if (n > most) await this.takeNow(n - most);
      else this.left += most - n;
      return value;
    });
    this.queue = done.then(() => {}, () => {});
    return done;
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

/**
 * What a bundle on the list hands over: the ids of its products, from the list
 * on the order, and, when they were read, each with what it hands over and how
 * many the store no longer has. The list of purchases does not read them: a
 * bundle's products are read when the buyer asks for them (bundleFor), so an
 * opening never draws every product of every bundle (C3-80).
 */
export type PurchaseItems = { ids: string[]; lines: PurchaseLine[]; missing: number };

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
  /**
   * The buyer's yes to start during the cancellation period, as kept on the
   * order (lib/digital-consent.ts, readConsentMeta), or null; read for the
   * withdrawal function (lib/withdrawal-rules.ts, 588 [KB9]).
   */
  consent?: KeptConsent | null;
  /**
   * The order's confirmation email is known to have gone (its nl:confirm: mark read exactly "sent"), set only by
   * lib/withdrawal.ts (withConfirmations) where the withdrawal function needs it; absent is not known.
   */
  confirmed?: boolean;
  /** Shipped by the creator (the checkout's metadata ship=yes): its withdrawal period runs from a receipt not known here. */
  shipped?: boolean;
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
  /**
   * A pre-order handed over (job "pre:<checkout>"): the checkout it was paid at. The list names it by its brought-over
   * reference, but the contract is the checkout's, so the withdrawal function keeps its record and names the order to the
   * creator by it (lib/withdrawal.ts, withdrawalReference; Claude 5's F on #2827).
   */
  checkout?: string;
};

/**
 * The products of a list on an order, each with what it hands over now; with
 * `read` false (the list of purchases), only their ids, nothing read.
 */
async function linesOf(find: (id: string | undefined) => Promise<Listing | null>, ids: string[], read = true): Promise<PurchaseItems | null> {
  if (ids.length === 0) return null;
  if (!read) return { ids, lines: [], missing: 0 };
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
  return { ids, lines, missing };
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
  // With a meter (the orders page), each read is taken before it is made. The move of every booking the store's pages
  // hold is read inside lib/calls.ts with the pages, before their number can be known here, so the most it can be,
  // ORDERS_CALL_MOVES (a hundred moves at a command), is taken first; what those moves did not use is given back to the same opening's meter, which pays
  // this buyer's listings, rooms, feeds and keys from it. (Until lib/calls.ts says how many it is about to read.)
  // The other reads of the same opening wait for that number and use what is left, so they never ask the store meanwhile.
  const paid = meter ? await meter.takeFor(ORDERS_CALL_MOVES, () => paidCalls(store), (calls) => ordersMovesCommands(calls.length)) : await paidCalls(store);
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

/** Whether Stripe marks this payment's charge as disputed: only then does lib/refunds.ts ask it for the charge's disputes. */
function disputed(payment: unknown): boolean {
  if (!payment || typeof payment !== "object") return false;
  const value = payment as { object?: unknown; disputed?: unknown; latest_charge?: unknown };
  const charge = value.object === "charge" ? value : value.latest_charge;
  return Boolean(charge && typeof charge === "object" && (charge as { disputed?: unknown }).disputed === true);
}

/**
 * The calls lib/refunds.ts (purchaseRefunded) makes to the creator's Stripe
 * account for this checkout, at the most: none when its own payment, read with
 * the list, already says it was refunded; one for the disputes of a charge
 * Stripe marks disputed (keptUnlessLost); and for a payment plan its first
 * invoice, that invoice's payments and each payment's disputes
 * (PLAN_REFUND_CALLS).
 */
function refundCalls(session: Row): number {
  if (refundedInFull(session.payment_intent)) return 0;
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  return (disputed(session.payment_intent) ? 1 : 0) + (session.mode === "subscription" && meta.kind === "plan" ? PLAN_REFUND_CALLS : 0);
}

/**
 * Whether a checkout was given back in full (lib/refunds.ts), its calls to
 * Stripe taken from the meter's ceiling first: "unchecked", noted on the
 * meter (older) and with nothing asked, when they would pass it. A purchase
 * that could not be checked is never handed over, and never said to be not
 * bought: the page says it is not checked yet, and checks it when asked.
 */
async function refundedFor(account: string, session: Row, meter?: OrdersMeter): Promise<boolean | "unchecked"> {
  meter?.alive();
  const calls = refundCalls(session);
  if (meter && calls > 0 && !meter.stripe(calls)) {
    meter.defer(session);
    return "unchecked";
  }
  return purchaseRefunded(account, session);
}

/**
 * Whether a checkout is one the list would hand over once its refund is
 * checked, read from what came with it alone (nothing more is read): this
 * store's, paid, and neither a call, a gift nor a place bought for several
 * (as purchaseFromSession reads it), and one that needs its calls to Stripe.
 */
function waitsForCheck(store: Store, session: Row): boolean {
  const id = typeof session.id === "string" ? session.id : "";
  if (!SESSION_ID_PATTERN.test(id) || refundCalls(session) === 0) return false;
  const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
  return saleHandles(store).has(meta.store ?? "") && isSettled(session) && meta.kind !== "call" && !meta.gift && !meta.group;
}

/** The address's checkouts on the creator's Stripe account under both spellings of it, each once, newest first. */
async function checkoutsOf(store: Store, email: string, meter?: OrdersMeter): Promise<Row[]> {
  const account = store.stripeAccountId;
  if (!account) return [];
  // Stripe keeps the address as it was typed at checkout.
  const variants = [...new Set([email.trim(), normaliseEmail(email)])];
  const checkouts = new Map<string, Row>();
  for (const variant of variants) {
    const query = new URLSearchParams({ "customer_details[email]": variant, status: "complete", limit: "100" });
    query.append("expand[]", "data.subscription");
    query.append("expand[]", "data.payment_intent.latest_charge");
    meter?.alive();
    const listed = (await onAccount("GET", account, `/checkout/sessions?${query}`)) as Listed;
    for (const session of rows(listed)) {
      const id = typeof session.id === "string" ? session.id : "";
      if (!checkouts.has(id)) checkouts.set(id, session);
    }
  }
  const createdAt = (row: Row) => (typeof row.created === "number" ? row.created : 0);
  return [...checkouts.values()].sort((a, b) => createdAt(b) - createdAt(a));
}

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
  lines = true,
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
    if ((await refundedFor(account, session, meter)) !== false) return null;
    await meter?.take(ORDERS_PREORDER_COMMANDS);
    const entry = await readPreorder(store, product.id, id);
    if (entry?.given || entry?.revoked) return null;
    const coming = await soonOne(store, product.id).catch(() => ({ soon: true, day: null }));
    return { customer: null, purchase: {
      reference: id,
      kind: "sale",
      consent: readConsentMeta(meta),
      shipped: meta.ship === "yes",
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
    if ((await refundedFor(account, session, meter)) !== false) return null;
    await meter?.take(bought.holds.length);
    const state = await packageState(bought);
    return { customer: null, purchase: {
      reference: id,
      kind: "sale",
      consent: readConsentMeta(meta),
      shipped: meta.ship === "yes",
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
  if ((await refundedFor(account, session, meter)) !== false) return null;

  // A membership hands its thing over while it is being paid for.
  const member = soldAMembership(product, { mode: session.mode, metadata: meta });
  if (member) {
    const sub = session.subscription as { status?: unknown } | null;
    if (!sub || typeof sub !== "object" || !isLiveSub(sub)) {
      return { customer: null, purchase: {
        reference: id,
        kind: "sale",
        consent: readConsentMeta(meta),
        shipped: meta.ship === "yes",
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
  const items = await linesOf(find, bundleFromMeta(meta, "bundle"), lines);
  const added: AddedPurchase[] = [];
  for (const { key, id: addedId } of bumpsFromMeta(meta)) {
    const listing = await find(addedId);
    if (!listing) continue;
    const delivery = listing.file || listing.link ? { title: listing.title, file: listing.file, link: listing.link } : null;
    const inside = await linesOf(find, bundleFromMeta(meta, `${key}_bundle`), lines);
    const course = listing.course ? listing.id : null;
    if (delivery || inside || course) added.push({ key, id: listing.id, title: listing.title, delivery, items: inside, courseProduct: course });
  }
  if (!delivery && !added.length && !courseProduct && !podcastProduct && !items) return null;

  const customer = customerOf(session);
  return { customer, purchase: {
    reference: id,
    kind: "sale",
    consent: readConsentMeta(meta),
    shipped: meta.ship === "yes",
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

/** A payment taken in one click after a checkout of this store, paid and not given back in full: what the list may show once its dispute is checked. */
function oneClickHere(store: Store, intent: Row): boolean {
  const id = typeof intent.id === "string" ? intent.id : "";
  const meta = (intent.metadata ?? {}) as Record<string, string>;
  return INTENT_ID_PATTERN.test(id) && meta.kind === "upsell" && saleHandles(store).has(meta.store ?? "") && intent.status === "succeeded" && !refunded(intent);
}

/** The checkout a payment taken in one click followed (lib/upsell.ts, metadata[parent]), or "". */
const parentOf = (intent: Row) => String(((intent.metadata ?? {}) as Record<string, unknown>).parent ?? "");

/** The Stripe customer a checkout made, whose payments taken in one click after it are its own, or null. */
function customerOf(session: Row): string | null {
  return typeof session.customer === "string" && CUSTOMER_PATTERN.test(session.customer) ? session.customer : null;
}

/**
 * What one payment taken in one click after a checkout hands over again, or
 * null: the list's reading and one download's. `checked` when the caller
 * already took the call its dispute needs from the meter's ceiling.
 */
async function purchaseFromIntent(store: Store, intent: Row, find: Finder, lines = true, meter?: OrdersMeter, checked = false): Promise<Purchase | null> {
  if (!oneClickHere(store, intent)) return null;
  const id = intent.id as string;
  const meta = (intent.metadata ?? {}) as Record<string, string>;
  // Lost to a dispute is given back too (lib/refunds.ts): Stripe is asked only of a charge it marks disputed, that one call
  // taken from the ceiling (ORDERS_STRIPE_CALLS) first. Past the opening's time, or once its meter was refused, nothing more
  // goes to Stripe (C3-87). With no room left for it, it is not handed over: never shown as checked when it was not (the
  // list says it is not checked yet and a batch checks it, oneClickOf), never downloaded unchecked (lookUp).
  meter?.alive();
  const account = store.stripeAccountId;
  if (account && disputed(intent)) {
    if (meter && !checked && !meter.stripe(1)) return null;
    if (await keptUnlessLost(account, intent)) return null;
  }
  const product = await find(meta.product);
  const items = product ? await linesOf(find, bundleFromMeta(meta, "bundle"), lines) : null;
  if (!product || !(product.file || product.link || items)) return null;
  return {
    reference: id,
    kind: "upsell",
    consent: readConsentMeta(meta),
    shipped: meta.ship === "yes",
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

/**
 * A pre-order handed over (job "pre:<checkout>", with ":s" or ":d" since Claude 1's H on #2827): its checkout, when the
 * job names one, and whether it is shipped, as its job says, or else read from its entry (one HGET, taken through the
 * meter before it is made). Shipped unless the entry says exactly it is not:
 * an entry written before the shipping was kept with it, a read that fails or no entry are not known, and its withdrawal
 * function is then kept open with no end rather than closed on a guess (CX-123; Claude 5's G on #2827).
 */
async function handedOver(store: Store, productId: string, job: string, meter?: OrdersMeter): Promise<{ checkout: string | null; shipped: boolean }> {
  const named = readPreorderJob(job);
  if (!named || !SESSION_ID_PATTERN.test(named.checkout)) return { checkout: null, shipped: true };
  const { checkout } = named;
  // Said by the grant's own job, which never expires (Claude 1's H on #2827): no read, and an entry gone changes nothing.
  if (named.ship !== null) return { checkout, shipped: named.ship };
  await meter?.take(1);
  const entry = await readPreorder(store, productId, checkout).catch((error) => {
    console.error("a handed-over pre-order's entry could not be read", error);
    return null;
  });
  return { checkout, shipped: entry?.ship !== false };
}

/** What one purchase brought over or given hands over again, or null: the list's reading and one download's. */
async function purchaseFromImported(store: Store, statsId: string, email: string, given: ImportedPurchase, find: Finder, meter?: OrdersMeter, lines = true): Promise<Purchase | null> {
  const product = await find(given.productId);
  if (!product) return null;
  const reference = importedReference(statsId, email, product.id);
  // Given at one of the product's prices: that option is what is theirs.
  const { delivery, option } = deliveryOf(product, given.option ?? undefined);
  const items = given.items?.length ? await linesOf(find, given.items, lines) : null;
  const courseProduct = product.course ? product.id : null;
  const podcastProduct = product.podcast ? product.id : null;
  if (!delivery && !courseProduct && !podcastProduct && !items) return null;
  // Who gave it is one read more.
  if (given.job.startsWith("gift:")) await meter?.take(1);
  // A pre-order handed over: its checkout, and whether it is shipped, one read of its entry more (lib/preorders.ts).
  const handed = given.job.startsWith("pre:") ? await handedOver(store, product.id, given.job, meter) : null;
  return {
    reference,
    kind: "imported",
    giftFrom: await giftFrom(given.job),
    ...(isGroupJob(given.job) ? { place: true } : {}),
    ...(given.job.startsWith("paypal:") ? { paidWith: "paypal" as const } : {}),
    ...(given.job.startsWith("api:") ? { givenByStore: true } : {}),
    ...(given.job.startsWith("pre:") ? { preorder: { day: null, given: true } } : {}),
    ...(handed?.checkout ? { checkout: handed.checkout } : {}),
    ...(handed?.shipped ? { shipped: true } : {}),
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

/** A customer's payments taken in one click, newest first, as Stripe lists them with their charges. */
async function oneClickList(account: string, customer: string): Promise<Row[]> {
  const query = new URLSearchParams({ customer, limit: "50" });
  query.append("expand[]", "data.latest_charge");
  const listed = (await onAccount("GET", account, `/payment_intents?${query}`)) as Listed;
  const created = (row: Row) => (typeof row.created === "number" ? row.created : 0);
  // One order for every reading, so a batch that resumes a customer's list after its first n resumes at the same one.
  return rows(listed).sort((a, b) => created(b) - created(a) || String(a.id).localeCompare(String(b.id)));
}

/** A customer waiting in a batch's address: "cus_…", or "cus_…:n" once its first n payments taken in one click were shown. */
const paidEntry = (customer: string, shown: number) => (shown > 0 ? `${customer}:${shown}` : customer);

/**
 * The payments taken in one click for one customer, each checked before it is
 * shown, through the meter (C3-80): the list is one of ORDERS_ONE_CLICK_LISTS,
 * or a call from the ceiling past them; the disputes of the charges Stripe
 * marks disputed are taken together, so either every one of them is checked
 * or none is shown. What does not fit, the list itself, those disputes, or
 * the purchases past `room`, is not shown: `next` names the customer, with
 * how many were shown, for a batch to check, said as not checked yet. `skip`
 * leaves out the ones that followed a checkout not checked yet, which wait
 * with it; `only` keeps the ones that followed those checkouts alone. `from`
 * skips the first ones, shown before.
 */
async function oneClickOf(
  store: Store,
  customer: string,
  find: Finder,
  meter: OrdersMeter,
  { skip, only, room = Infinity, from = 0 }: { skip?: Set<string>; only?: Set<string>; room?: number; from?: number },
): Promise<{ purchases: Purchase[]; next: string | null }> {
  const wait = { purchases: [], next: paidEntry(customer, from) };
  meter.alive();
  if (!meter.list()) return wait;
  const listed = await oneClickList(store.stripeAccountId as string, customer);
  const mine = listed.filter((intent) => oneClickHere(store, intent) && !skip?.has(parentOf(intent)) && (!only || only.has(parentOf(intent))));
  const taken = mine.slice(from, from + room);
  // No room left for them in this batch: read only to know whether any wait, so no batch is asked for nothing.
  if (taken.length === 0) return { purchases: [], next: mine.length > from ? paidEntry(customer, from) : null };
  if (!meter.stripe(taken.filter(disputed).length)) return wait;
  const purchases: Purchase[] = [];
  for (const intent of taken) {
    const purchase = await purchaseFromIntent(store, intent, find, false, meter, true);
    if (purchase) purchases.push(purchase);
  }
  return { purchases, next: mine.length > from + taken.length ? paidEntry(customer, from + taken.length) : null };
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

  // Both spellings' checkouts together, newest first, so the calls to Stripe a refund check needs (ORDERS_STRIPE_CALLS) go
  // to the newest. Once one could not be checked, every older one that needs a check is only noted (meter.older), with
  // nothing read, for the buyer to check when they ask (olderFor). Once MAX_LISTED purchases that are always shown
  // (anything but an ended membership) are found, every other older checkout is past the newest MAX_LISTED the list
  // shows, so none is read any further.
  let shown = 0;
  for (const session of await checkoutsOf(store, email, meter)) {
    if (meter?.older.length && refundCalls(session) > 0) {
      if (waitsForCheck(store, session)) meter.defer(session);
      continue;
    }
    if (shown >= MAX_LISTED) {
      if (meter?.older.length) continue;
      break;
    }
    const got = await purchaseFromSession(store, session, find, meter, false);
    if (!got) continue;
    found.set(got.purchase.reference, got.purchase);
    if (got.customer) customers.add(got.customer);
    if (!got.purchase.ended) shown += 1;
  }

  // What was added in one click after paying is its own payment, made for
  // the customer the checkout created. One that followed a checkout not checked yet waits with it (olderFor); a customer
  // whose list, or whose disputes, do not fit in the ceiling waits whole, said as not checked yet (C3-80).
  if (account && meter) {
    const waiting = new Set(meter.older);
    for (const customer of customers) {
      const read = await oneClickOf(store, customer, find, meter, { skip: waiting });
      for (const purchase of read.purchases) if (!found.has(purchase.reference)) found.set(purchase.reference, purchase);
      if (read.next) meter.paid.push(read.next);
    }
  }
  for (const customer of account && !meter ? [...customers].slice(0, ORDERS_ONE_CLICK_LISTS) : []) {
    for (const intent of await oneClickList(account as string, customer)) {
      const id = typeof intent.id === "string" ? intent.id : "";
      if (found.has(id)) continue;
      const purchase = await purchaseFromIntent(store, intent, find, false);
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
      const purchase = await purchaseFromImported(store, store.statsId, email, given, find, meter, false);
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
export function displayName(name: string): string {
  return name.replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
}

/** The address part of the sender (NIMBUS_FROM). */
export function senderAddress(): string {
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
 * with what the address has through an OrdersMeter, waited on
 * ORDERS_LINK_READ_MS at the most so the link's grant and its email still fit
 * in the route's maxDuration. "busy" when the store had no room for those
 * units: nothing was read, whatever the address. Once they are taken, the
 * answer is always "sent", and at once, for an address that bought and one
 * that did not: what the address has is read, and its link made and emailed,
 * only after the answer is sent (afterAnswer), so neither its words nor its
 * time tell them apart;
 * a refusal from the meter, a reading that failed or ran out of time, and an
 * email that could not be sent (its figure used, its provider down) go only
 * to the server's log, since anything else would tell who bought here. The
 * page's words hold for both (lib/buyer-words/orders.ts, sentBody and
 * nothingArrived: a link normally arrives; if not, the spam folder, another
 * address, or later). They promise no way to reach the creator: not every
 * email a buyer gets about a purchase answers to the creator (a gift's, a
 * place's), and a store's contact form is the creator's choice.
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

  // A count that could not be read takes, reads and sends nothing, for every address alike, so saying so tells nobody
  // who bought here; it is said as an error on our side, never as too many requests (CX-123 rule 24).
  const byConnection = await within(ipKey(ip, store.handle), IP_LIMIT);
  if (byConnection === null) return "error";
  if (!byConnection) return "limited";
  const byAddress = await within(addressKey(email), ADDRESS_LIMIT);
  if (byAddress === null) return "error";
  if (!byAddress) return "limited";

  if (!(await takePublicRequest(store, "buyer", Date.now(), ORDERS_OPEN_UNITS))) return "busy";
  // From here the answer is "sent" whatever happens, and at once: the reading, the grant and the email run after it,
  // so how long the answer takes does not tell an address that bought from one that did not. What failed is said only in the server's log.
  afterAnswer(() => sendLink(store, raw, email, origin));
  return "sent";
}

/**
 * Runs a link's reading, grant and email after the answer is sent, inside the
 * route's maxDuration (ORDERS_OPEN_SECONDS; ORDERS_LINK_READ_MS bounds the
 * reading); at once, unwaited, when there is no request to wait for.
 */
function afterAnswer(task: () => Promise<void>): void {
  const run = () =>
    task().catch((error) => {
      if (!(error instanceof OrdersBusy)) console.error("sending a purchases link failed", error);
    });
  try {
    after(run);
  } catch {
    void run();
  }
}

/** Reads what the address has and, when it has anything, emails it the link; throws or logs what failed, never says it. */
async function sendLink(store: Store, raw: string, email: string, origin: string): Promise<void> {
  const meter = new OrdersMeter(store);
  const read = await withinOpening(Promise.all([purchasesFor(store, raw, meter), callsFor(store, raw, meter)]), meter, ORDERS_LINK_READ_MS);
  if (read === "late") return;
  const [purchases, calls] = read;
  // A purchase whose refund could not be checked yet is still a purchase of this address: the link is sent, and the page
  // checks it when asked. Whoever asked is answered "sent" either way, so this tells them nothing.
  const unchecked = meter.older.length + meter.paid.length;
  if (purchases.length === 0 && calls.length === 0 && unchecked === 0) return;

  const token = randomBytes(32).toString("hex");
  // Kept as typed: Stripe matches the address as it was written at checkout.
  const grant: Grant = { a: grantAccount(store), e: raw };
  await redisPipeline([["SET", tokenKey(token), JSON.stringify(grant), "EX", ORDERS_LINK_SECONDS]]);

  const name = store.name;
  // Only what was checked is counted; the rest is said as older purchases not checked yet, never as bought for certain.
  const count = purchases.length + calls.length;
  const link = `${origin}/@${store.handle}/orders?token=${token}`;
  const words = ordersWords(store.language);
  const sent = await sendEmail({ meter: { by: "store", store: store, kind: "transactional" },
    from: `"${words.ordersFrom(displayName(name))}" <${senderAddress()}>`,
    to: email,
    subject: words.ordersSubject(name),
    text: [
      words.ordersIntro(name, count, unchecked > 0),
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
  if (!sent) console.error("a purchases link could not be emailed");
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

/**
 * The address a live link was issued to, for this store only.
 *
 * Only the exact shape the grant was written in counts (Codex K2, CX-123
 * rule 24): one reply for the one GET, from the list's own slot; a record
 * that is exactly `{"a":…,"e":…}` as JSON.stringify wrote it, so an extra
 * field, a duplicated member or any other spelling is unknown; and an
 * address the request form itself would accept. Anything else, like an
 * exact null (expired), grants nothing and never returns an address.
 */
export async function ordersGrant(store: Store, token: string): Promise<string | null> {
  if (!ORDERS_TOKEN_PATTERN.test(token) || !isRedisConfigured()) return null;
  const replies = repliesFor(await redisPipeline([["GET", tokenKey(token)]]), 1);
  const raw = replies?.[0];
  if (typeof raw !== "string" || !raw) return null;
  return grantFrom(raw, grantAccount(store));
}

/** The address in a grant record written exactly as `Grant` for this account, or null. */
function grantFrom(raw: string, account: string): string | null {
  let grant: unknown;
  try {
    grant = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return null;
  const keys = Object.keys(grant);
  if (keys.length !== 2 || !Object.hasOwn(grant, "a") || !Object.hasOwn(grant, "e")) return null;
  const { a, e } = grant as Record<string, unknown>;
  if (typeof a !== "string" || typeof e !== "string") return null;
  // A duplicated member parses as its last value; the record's own text is
  // then not what writing that value gives, so it is refused as unknown.
  const exact: Grant = { a, e };
  if (JSON.stringify(exact) !== raw) return null;
  if (a !== account || !e || e.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(e)) return null;
  return e;
}

/**
 * What a download asks for besides its purchase: a product of a bundle by its
 * id (`pid`), and a product ticked at checkout by its key (`item`). Or, to
 * show a bundle's products (bundleFor), which bundle: the one bought
 * ("main") or the one ticked under that key.
 */
export type DownloadWant = { pid?: string; item?: string; bundle?: "main" | BumpKey };

/**
 * The one purchase a download asks for, with the link's address, when that
 * address paid for it. Read again from Stripe, so a refund made a minute ago
 * is already honoured.
 *
 * Only that purchase is read, by its own reference, never the whole list:
 * the link's grant first (one read, inside the download's own request), then
 * DOWNLOAD_LOOKUP_UNITS of the store's buyer requests before anything else,
 * and the listings it reads through the meter, all
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
): Promise<{ purchase: Purchase; email: string; listing: (id: string) => Promise<Listing | null>; meter: OrdersMeter } | null> {
  const kind = referenceKind(reference);
  if (!kind || !ORDERS_TOKEN_PATTERN.test(token)) return null;
  // The grant is one read, paid by the download's own request: a link that opens nothing takes nothing more.
  const email = await ordersGrant(store, token);
  if (!email) return null;
  if (!(await takePublicRequest(store, "buyer", Date.now(), DOWNLOAD_LOOKUP_UNITS))) throw new OrdersBusy();
  const meter = new OrdersMeter(store);
  const found = await withinOpening(lookUp(store, email, kind, reference, meter, want), meter, DOWNLOAD_LOOKUP_MS);
  if (found === "late") throw new OrdersLate();
  // The lookup's meter goes with what it found, so a caller's further reads of it (the withdrawal function's
  // confirmation mark, lib/withdrawal.ts) are taken from it before they are made, as the lookup's own were.
  return found && { ...found, meter };
}

/** A customer waiting in a batch's address, with how many of its payments taken in one click were shown before. */
const PAID_ENTRY = /^cus_[A-Za-z0-9]{6,64}(?::[1-9][0-9]{0,2})?$/;

/** Where the next batch of older purchases starts: the first checkout not checked yet, and the customers whose payments taken in one click wait. */
export type OlderCursor = { from: string | null; paid: string[] };

/**
 * The address of the next batch, as the button and the link without
 * JavaScript carry it (`older`): the checkout, then "~" and the customers
 * waiting, joined by "."; null when nothing waits.
 */
export function olderCursor(from: string | null, paid: string[]): string | null {
  if (!from && paid.length === 0) return null;
  // At most one customer for each purchase a list shows and each a batch adds, far under ORDERS_OLDER_PAID_MOST.
  return `${from ?? ""}${paid.length ? `~${paid.slice(0, ORDERS_OLDER_PAID_MOST).join(".")}` : ""}`;
}

/** What an opening left for the batches: where they start, how many checkouts wait, and whether anything added in one click may wait too. */
export function olderOf(meter: OrdersMeter): { cursor: string | null; count: number; added: boolean } {
  return { cursor: olderCursor(meter.older[0] ?? null, meter.paid), count: meter.older.length, added: meter.olderAdded || meter.paid.length > 0 };
}

/** A batch's address read back; null when it is not shaped like one, so nothing is read for it. */
export function readOlderCursor(raw: string): OlderCursor | null {
  const parts = raw.split("~");
  if (raw.length > 8_192 || parts.length > 2) return null;
  const [from, list] = parts;
  if (from && !SESSION_ID_PATTERN.test(from)) return null;
  const paid = list ? list.split(".") : [];
  if (paid.length > ORDERS_OLDER_PAID_MOST || !paid.every((entry) => PAID_ENTRY.test(entry))) return null;
  if (!from && paid.length === 0) return null;
  return { from: from || null, paid };
}

/**
 * The next batch of the older purchases the list could not check inside
 * ORDERS_STRIPE_CALLS, from `older` (olderCursor), asked for with the button
 * under the list (components/older-purchases.tsx,
 * app/api/store/orders/older/route.ts) or its link without JavaScript
 * (app/[handle]/orders/page.tsx). Paid for as an opening is, before anything
 * is read: the link's grant, then ORDERS_OLDER_UNITS of the store's buyer
 * requests, then every read through a meter of its own, with the same ceiling
 * of calls to Stripe. It shows ORDERS_OLDER_MOST purchases at the most: first
 * the payments taken in one click that waited (their customers must be ones
 * the address's own checkouts made), then the checkouts not checked yet, from
 * the first, each with what was added to it in one click after paying (C3-80).
 * What does not fit is in the next batch's address, and said as not checked
 * yet: `count` checkouts, and `added` when something added in one click may
 * wait too. `more` reads what the purchases need besides themselves
 * (lib/purchase-cards.ts, extrasFor) through the same meter, inside the same
 * time (ORDERS_READ_MS). Null when the link opens nothing or the address is
 * not one of this buyer's. Throws OrdersBusy when the store has no room,
 * before Stripe is asked anything, and OrdersLate past that time.
 */
export async function olderFor<T>(
  store: Store,
  token: string,
  older: string,
  more: (purchases: Purchase[], email: string, meter: OrdersMeter) => Promise<T>,
): Promise<{ purchases: Purchase[]; cursor: string | null; count: number; added: boolean; extra: T } | null> {
  const cursor = readOlderCursor(older);
  if (!cursor || !ORDERS_TOKEN_PATTERN.test(token) || !store.stripeAccountId) return null;
  const email = await ordersGrant(store, token);
  if (!email) return null;
  if (!(await takePublicRequest(store, "buyer", Date.now(), ORDERS_OLDER_UNITS))) throw new OrdersBusy();
  const meter = new OrdersMeter(store);
  const done = await withinOpening(
    (async () => {
      const checkouts = await checkoutsOf(store, email, meter);
      let waiting: Row[] = [];
      if (cursor.from) {
        const at = checkouts.findIndex((session) => session.id === cursor.from);
        if (at < 0) return null;
        waiting = checkouts.slice(at).filter((session) => waitsForCheck(store, session));
      }
      // Only a customer one of the address's own checkouts made is read.
      const theirs = new Set(checkouts.map(customerOf));
      const later = new Set(waiting.map((session) => session.id as string));
      const find = finderFor(store, meter);
      const purchases: Purchase[] = [];
      const paid: string[] = [];
      for (const [i, entry] of cursor.paid.entries()) {
        if (purchases.length >= ORDERS_OLDER_MOST) {
          paid.push(...cursor.paid.slice(i));
          break;
        }
        const [customer, shown] = entry.split(":");
        if (!theirs.has(customer)) continue;
        const read = await oneClickOf(store, customer, find, meter, { skip: later, room: ORDERS_OLDER_MOST - purchases.length, from: Number(shown ?? 0) });
        purchases.push(...read.purchases);
        if (read.next) paid.push(read.next);
      }
      let next = waiting.length;
      for (const [i, session] of waiting.entries()) {
        if (purchases.length >= ORDERS_OLDER_MOST) {
          next = i;
          break;
        }
        const got = await purchaseFromSession(store, session, find, meter, false);
        // Its refund check did not fit: it, and every one after it, waits for the next batch.
        if (meter.older.length) {
          next = i;
          break;
        }
        if (!got) continue;
        purchases.push(got.purchase);
        if (!got.customer) continue;
        const read = await oneClickOf(store, got.customer, find, meter, { only: new Set([session.id as string]), room: ORDERS_OLDER_MOST - purchases.length });
        purchases.push(...read.purchases);
        if (read.next) paid.push(read.next);
      }
      const rest = waiting.slice(next);
      return {
        purchases,
        cursor: olderCursor((rest[0]?.id as string | undefined) ?? null, paid),
        count: rest.length,
        added: paid.length > 0 || rest.some((session) => customerOf(session) !== null),
        extra: await more(purchases, email, meter),
      };
    })(),
    meter,
  );
  if (done === "late") throw new OrdersLate();
  return done;
}

const referenceKind = (reference: string) =>
  SESSION_ID_PATTERN.test(reference) ? "session" : INTENT_ID_PATTERN.test(reference) ? "intent" : IMPORTED_REFERENCE.test(reference) ? "imported" : null;

/** A bundle's products as the buyer asked to see them, each read now, with the license key of each that hands one out. */
export type BundleShown = { purchase: Purchase; items: PurchaseItems; keys: Map<string, SaleKey | "error"> };

/**
 * The products of one bundle of one purchase, read when the buyer asks to see
 * them on the list of purchases (app/api/store/orders/bundle/route.ts), the
 * way a download reads its purchase (findPurchase): the link's grant first,
 * then ORDERS_BUNDLE_UNITS of the store's buyer requests before anything else,
 * then only that purchase by its reference and that bundle's listings, and the
 * key of each product that hands one out, each taken through the meter before
 * it is read; all waited on DOWNLOAD_LOOKUP_MS at the most. Null when the link
 * or the purchase does not hand that bundle over (refunded, ended, not this
 * address's, no such bundle). Throws OrdersBusy when the store has no room,
 * before Stripe is asked anything, and OrdersLate past that time.
 */
export async function bundleFor(store: Store, token: string, reference: string, which: "main" | BumpKey): Promise<BundleShown | null> {
  const kind = referenceKind(reference);
  if (!kind || !ORDERS_TOKEN_PATTERN.test(token)) return null;
  const email = await ordersGrant(store, token);
  if (!email) return null;
  if (!(await takePublicRequest(store, "buyer", Date.now(), ORDERS_BUNDLE_UNITS))) throw new OrdersBusy();
  const meter = new OrdersMeter(store);
  const shown = await withinOpening(
    (async (): Promise<BundleShown | null> => {
      const found = await lookUp(store, email, kind, reference, meter, { bundle: which });
      if (!found || found.purchase.ended) return null;
      const { purchase } = found;
      const items = which === "main" ? purchase.items : (purchase.added.find((added) => added.key === which)?.items ?? null);
      if (!items) return null;
      const keys = new Map<string, SaleKey | "error">();
      // Nothing brought over from another platform was sold here, so no key is given for it (as on the list).
      if (purchase.kind === "imported") return { purchase, items, keys };
      const keyed: { productId: string; product: Listing }[] = [];
      for (const line of items.lines) {
        const product = await found.listing(line.productId);
        if (product && activeKeys(product)) keyed.push({ productId: line.productId, product });
      }
      await meter.take(keyed.length * ORDERS_KEY_COMMANDS);
      await Promise.all(
        keyed.map(async ({ productId, product }) => {
          try {
            const key = await keyForSale(store, product, purchase.reference, email);
            if (key) keys.set(productId, key);
          } catch (error) {
            console.error("reading a license key failed", error);
            keys.set(productId, "error");
          }
        }),
      );
      return { purchase, items, keys };
    })(),
    meter,
    DOWNLOAD_LOOKUP_MS,
  );
  if (shown === "late") throw new OrdersLate();
  return shown;
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
    // What was brought over holds one bundle at the most: its own.
    if (want.bundle && (want.bundle !== "main" || !given.items?.length)) return null;
    allow(given.productId, want.pid, ...(want.bundle ? (given.items ?? []) : []));
    return done(await purchaseFromImported(store, statsId, email, given, find, meter));
  }
  if (!store.stripeAccountId) return null;
  if (kind === "session") {
    const session = await sessionOf(store, email, reference, meter);
    if (!session) return null;
    const meta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
    // A bundle asked to be shown is the one bought, or the one ticked under that key: as a download's `item` names it.
    const key = want.bundle && want.bundle !== "main" ? want.bundle : want.item;
    const bump = key ? bumpsFromMeta(meta).find((b) => b.key === key) : undefined;
    if (key && !bump) return null;
    const list = bundleFromMeta(meta, bump ? `${bump.key}_bundle` : "bundle");
    if (!inList(list, want.pid)) return null;
    if (want.bundle && list.length === 0) return null;
    allow(meta.product, bump?.id, want.pid, ...(want.bundle ? list : []));
    return done((await purchaseFromSession(store, session, find, meter))?.purchase ?? null);
  }
  // A payment taken in one click: shown on the list when it was made for the customer of one of the address's checkouts
  // that the list hands over (purchasesFor: that checkout's own reading names the customer). Read here with the checkout
  // it followed (lib/upsell.ts, metadata[parent]), which must have been paid with this address and be read by that same
  // rule: its product and the products checked with it, and nothing of a bundle.
  const intent = await readOne(store, `/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`, meter);
  const intentMeta = (intent?.metadata ?? {}) as Record<string, string>;
  const parent = intentMeta.parent ?? "";
  if (!intent || !SESSION_ID_PATTERN.test(parent) || want.item) return null;
  // A payment taken in one click holds one bundle at the most: its own.
  const inside = bundleFromMeta(intentMeta, "bundle");
  if (want.bundle && (want.bundle !== "main" || inside.length === 0)) return null;
  if (!inList(inside, want.pid)) return null;
  const session = await sessionOf(store, email, parent, meter);
  if (!session) return null;
  const parentMeta = currentMeta((session.metadata ?? {}) as Record<string, string>, session);
  allow(parentMeta.product, ...bumpsFromMeta(parentMeta).map((bump) => bump.id));
  const customer = (await purchaseFromSession(store, session, find, meter))?.customer ?? null;
  if (!customer || customer !== intent.customer) return null;
  allow(intentMeta.product, want.pid, ...(want.bundle ? inside : []));
  return done(await purchaseFromIntent(store, intent, find, true, meter));
}
