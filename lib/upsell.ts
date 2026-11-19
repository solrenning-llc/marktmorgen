/**
 * The one-click offers after paying: each press adds another product,
 * charged to the card the buyer just used, on the creator's own account.
 *
 * A product's funnel (lib/funnel.ts) decides what is offered and in what
 * order; this file is what happens when the buyer answers. What keeps it
 * honest and safe is the same for the first offer as for the fifth:
 *
 *   - the card is saved only for payments made while the buyer is there
 *     (setup_future_usage "on_session"), never to be charged behind their back;
 *   - only a card is asked to be saved, so the checkout still offers every
 *     other way to pay; a buyer who paid with one that cannot be charged again
 *     in one click (Klarna, iDEAL and the like) meets no offer at all
 *     (lib/instant-pay.ts, reusableMethod);
 *   - each offer is charged in the currency of the order it follows, which
 *     is the store's; an order in another currency, from before the store
 *     changed it, is followed by no offer;
 *   - the offers only work in the browser that paid: a secret cookie is set
 *     when the checkout opens and its fingerprint travels with the charge, so
 *     a thanks-page link that is forwarded cannot be used to charge the card;
 *   - they are open for an hour after paying, and each can be answered once,
 *     yes or no, guarded so a double press charges once;
 *   - only the offer the buyer is actually at can be answered: the answers
 *     already given are walked again on the server, so no offer is skipped to
 *     and none is taken twice;
 *   - when the bank asks the buyer to confirm, they are sent to confirm it,
 *     nothing is delivered until Stripe says it is paid, and nothing more is
 *     offered until it has;
 *   - when the answer from Stripe is lost on the way back, the charge is not
 *     guessed at: it is found again among the buyer's payments and settled
 *     from what Stripe says happened;
 *   - a card that turns an offer down is not asked again: nothing more is
 *     offered after a decline.
 *
 * Each offer paid is its own payment, with its own reference (the payment's
 * id): its licence key, its stamped copy and its line on the buyer's list of
 * purchases are all kept under it, and the buyer gets a short confirmation
 * for it (lib/purchase-email.ts, confirmOffer), with the key in it.
 *
 * An offer still waiting on an answer — the bank asked the buyer to confirm,
 * or Stripe's answer was lost on the way back — is also kept in a list the
 * five-minute job walks (settlePendingOffers), so its confirmation email and
 * the affiliate's credit follow Stripe's answer within minutes, whether or
 * not the buyer ever comes back to the thanks page.
 */
import { admitOrders, settleAdmitted } from "@/lib/order-admission";
import { saleClock, saleOff, salePrice } from "@/lib/store-sale";
import { countOrder } from "@/lib/orders";
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import { StripeError, onAccount } from "@/lib/stripe-account";
import {
  type FunnelStep,
  type StepAnswer,
  activeFunnel,
  funnelPosition,
  stepSlot,
} from "@/lib/funnel";
import { funnelRate, noteCharge } from "@/lib/affiliates";
import { confirmOffer } from "@/lib/purchase-email";
import { noteOfferSale } from "@/lib/sale-events";
import { givenBack } from "@/lib/refunds";
import { methodId, reusableMethod } from "@/lib/instant-pay";
import type { Listing, Product, Store } from "@/lib/store";
import { listingFinder, readListing, readListings, readProduct } from "@/lib/catalog";
import { funnelProductIds } from "@/lib/funnel";
import type { ProductFile } from "@/lib/product-file";
import { type ProductImage, picturedFrom } from "@/lib/product-image";
import { bundleFromMeta, bundleMeta, deliverableItems, deliveredIds } from "@/lib/bundle-rules";
import { type BundleContents, contentsOf, offerableAfterPaying } from "@/lib/bundles";
import { applyShareToPayment } from "@/lib/platform-share";
import { CONSENT_META, type DigitalConsent, consentKind, consentMetaValue, deliversDigitally, validConsent } from "@/lib/digital-consent";
import { cartOfferFrom, ownedBeforeCart } from "@/lib/cart-offers";
import { canSell, canSellProduct } from "@/lib/store-checkout";
import { STRIPE_LIST_VERSION, StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";

export const UPSELL_COOKIE = "nl_upsell";
export const UPSELL_WINDOW_SECONDS = 60 * 60;
const RECORD_SECONDS = 8 * 24 * 60 * 60;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const SLOT_PATTERN = /^[a-z0-9]{4,12}$/;

/** How long an upsell whose answer was lost is looked for before it counts as not charged. */
const LOST_ANSWER_MS = 10 * 60 * 1000;

type UpsellRecord = {
  state: "pending" | "paid" | "failed" | "declined";
  product: string;
  pi?: string;
  /** The creator's customer the charge is made for, so it can be found again. */
  customer?: string;
  at: number;
  /**
   * When the product offered is a bundle: the products it held when the
   * offer was taken, which is what this buyer gets (lib/bundle-rules.ts).
   */
  items?: string[];
  /**
   * "processing" while Stripe last said the payment is processing: it can still be paid, so the buyer is told it is
   * being checked (charged once at most), never that it was not charged. Absent while it waits on the buyer's bank.
   */
  waiting?: "processing";
};

/**
 * One answer per offer per order. The first offer keeps the key the single
 * upsell always had, so one taken before funnels existed is still found.
 */
const recordKey = (session: string, slot = "") => (slot ? `nl:upsell:${session}:${slot}` : `nl:upsell:${session}`);
/** Which other offers of this order have an answer, so they can all be read. */
const slotsKey = (session: string) => `nl:upsell-slots:${session}`;
/**
 * Every offer waiting on Stripe, across all stores, scored by when it began:
 * members are "<store handle>|<checkout>|<slot>".
 */
const PENDING_KEY = "nl:upsell:pending";
/** How long an offer waiting on the bank is looked at before the job lets it be. */
const PENDING_WATCH_MS = 2 * 24 * 60 * 60 * 1000;
/**
 * A payment Stripe still says is "processing" (a bank debit can take days to clear) is not let go after
 * PENDING_WATCH_MS: it is looked at again every PROCESSING_RECHECK_MS, until it settles or PROCESSING_WATCH_MS
 * have passed, so a late success still gets its confirmation, count and commission (afterPaid). Seven days covers
 * a US bank debit (Link paid from a bank account, lib/instant-pay.ts) and stays inside the record's own
 * RECORD_SECONDS, so nothing is kept longer than before. Once a day, inside OFFER_WATCH_LOOKS_MOST looks an offer in all
 * (tests/plan-cost-registry.ts, line "orders").
 */
const PROCESSING_WATCH_MS = 7 * 24 * 60 * 60 * 1000;
const PROCESSING_RECHECK_MS = 24 * 60 * 60 * 1000;
/**
 * When the job looks at a waiting offer again, by how long after it began: its first look comes a minute after it
 * began (settlePendingOffers' grace), then once its lost answer can be told apart (LOST_ANSWER_MS), after an hour,
 * six hours, a day, and at the end of PENDING_WATCH_MS. The buyer's own thanks page settles it at once whenever it is
 * opened (settleUpsells), so this is only the job's catch-up: six looks over two days instead of one every five
 * minutes, at most OFFER_WATCH_LOOKS_MOST with the daily looks of a payment still processing
 * (tests/plan-cost-registry.ts, line "orders").
 */
const WATCH_AFTER_MS = [LOST_ANSWER_MS + 60_000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, PENDING_WATCH_MS + 60_000];

/** When an offer that began at `at` is next looked at, or null once its watch is over. */
function nextLook(at: number, now: number): number | null {
  for (const after of WATCH_AFTER_MS) if (at + after > now) return at + after;
  return null;
}
const pendingMember = (handle: string, session: string, slot: string) => `${handle}|${session}|${slot}`;

/**
 * The states of an offer's payment, answered at once, in which nothing was or will be taken without the buyer:
 * declined or stopped (requires_payment_method, canceled), or waiting on a step the buyer is not sent to
 * (requires_action with no page to confirm on, requires_confirmation). Any other is still on its way.
 */
const NOTHING_TAKEN = new Set(["requires_payment_method", "canceled", "requires_action", "requires_confirmation"]);

/**
 * Adds an offer to the job's list, and takes it off. Best effort: the list
 * only makes the settling sooner, the thanks page settles an offer too, so a
 * moment of Redis trouble here never stands in the way of the buyer's answer.
 */
async function watchPending(store: Store, session: string, slot: string): Promise<void> {
  await redisPipeline([["ZADD", PENDING_KEY, Date.now(), pendingMember(store.handle, session, slot)]]).catch((error) =>
    console.error("listing a waiting offer failed", error),
  );
}

/**
 * A paid offer whose affiliate credit failed (noteCharge: an unknown read of the affiliate, rule 24, or Redis
 * trouble): kept in the job's list as `<member>|credit`, so the five-minute job credits it again from what Stripe
 * says of its payment (creditAgain), never by charging, emailing or delivering again. noteCharge writes with HSETNX,
 * so a second credit changes nothing that was written. Best effort, as the list itself is.
 */
const CREDIT_MARK = /^credit:(\d{13})$/;
const creditMember = (handle: string, session: string, slot: string, since: number) => `${pendingMember(handle, session, slot)}|credit:${since}`;
async function creditCharge(store: Store, session: string, slot: string, pi: Record<string, unknown>): Promise<void> {
  await noteCharge(store, pi).catch(async (error) => {
    console.error("noting an affiliate sale failed; credited again by the job", error);
    await redisPipeline([["ZADD", PENDING_KEY, Date.now(), creditMember(store.handle, session, slot, Date.now())]]).catch(() => undefined);
  });
}

/**
 * Credits again a paid offer kept by creditCharge, from Stripe's own record of its payment. Throws while unknown: an
 * offer record that does not read (it is kept far longer than an offer is watched) or a payment Stripe does not give.
 */
async function creditAgain(store: Store, session: string, slot: string): Promise<void> {
  const record = await readUpsell(session, slot);
  if (!record) throw new Error("a paid offer's record did not read");
  // Never paid, or paid before a payment id was known: nothing to credit from.
  if (record.state !== "paid" || !record.pi || !store.stripeAccountId) return;
  // With its settled charge, so a partner's dated end is compared with when it was paid (noteCharge, Codex G on #1924).
  const pi = await onAccount("GET", store.stripeAccountId, `/payment_intents/${encodeURIComponent(record.pi)}?expand[]=latest_charge.balance_transaction`);
  const meta = pi.metadata as Record<string, string> | null;
  if (meta?.parent !== session || (meta?.step ?? "") !== slot) return;
  await noteCharge(store, pi);
}

async function unwatchPending(store: Store, session: string, slot: string): Promise<void> {
  await redisPipeline([["ZREM", PENDING_KEY, pendingMember(store.handle, session, slot)]]).catch((error) =>
    console.error("unlisting a settled offer failed", error),
  );
}

export function newUpsellKey(): { secret: string; fingerprint: string } {
  const secret = randomBytes(24).toString("hex");
  return { secret, fingerprint: fingerprint(secret) };
}

export function fingerprint(secret: string): string {
  return createHash("sha256").update(`nimbus-upsell:${secret}`).digest("hex").slice(0, 40);
}

function parseRecord(raw: unknown): UpsellRecord | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as UpsellRecord;
  } catch {
    return null;
  }
}

/**
 * The answer to one offer of this order, or null when there is none yet (GET null). A reply in any other shape,
 * or a record that does not parse, is unknown and throws (CX-123 rule 24): an offer waiting on Stripe is never
 * let go, and a paid one never read as not there, on it.
 */
export async function readUpsell(session: string, slot = ""): Promise<UpsellRecord | null> {
  if (!isRedisConfigured() || !SESSION_ID.test(session) || (slot && !SLOT_PATTERN.test(slot))) return null;
  const replies = repliesFor(await redisPipeline([["GET", recordKey(session, slot)]]), 1);
  if (!replies) throw new UnknownReplyError("an offer's answer");
  if (replies[0] === null) return null;
  const record = parseRecord(replies[0]);
  if (!record || typeof record !== "object" || typeof record.state !== "string") throw new UnknownReplyError("an offer's answer");
  return record;
}

/** Every answer this order has, keyed by slot ("" for the first offer). */
async function readAnswers(session: string): Promise<Map<string, UpsellRecord>> {
  const out = new Map<string, UpsellRecord>();
  if (!isRedisConfigured() || !SESSION_ID.test(session)) return out;
  const [first, members] = await redisPipeline([
    ["GET", recordKey(session)],
    ["SMEMBERS", slotsKey(session)],
  ]);
  const root = parseRecord(first);
  if (root) out.set("", root);
  const slots = (Array.isArray(members) ? members.map(String) : []).filter((s) => SLOT_PATTERN.test(s)).slice(0, 20);
  if (slots.length) {
    const values = await redisPipeline(slots.map((slot) => ["GET", recordKey(session, slot)]));
    slots.forEach((slot, i) => {
      const record = parseRecord(values[i]);
      if (record) out.set(slot, record);
    });
  }
  return out;
}

/** Writes an offer's record; true only on Redis's exact "OK" (CX-123 rule 24), so a caller can refuse to go on. */
async function writeUpsell(session: string, slot: string, record: UpsellRecord): Promise<boolean> {
  const reply = repliesFor(await redisPipeline([["SET", recordKey(session, slot), JSON.stringify(record), "EX", RECORD_SECONDS]]), 1);
  return reply?.[0] === "OK";
}

/**
 * Writes the record naming the customer before Stripe is asked: true on Redis's exact "OK", or, when that reply is
 * unclear, only when a read-back finds exactly this write's own payload (Codex's focal review on #3834: the SET may
 * have landed and only its reply been lost; refusing then would hold a claim that was never sent to Stripe). The
 * payload carries this press's own time and the claim is this press's alone (SET NX), so no other write matches it.
 * A read-back that is lost, garbled or different is unknown: false, and the press is refused, nothing is sent.
 */
async function writeUpsellConfirmed(session: string, slot: string, record: UpsellRecord): Promise<boolean> {
  const key = recordKey(session, slot);
  const payload = JSON.stringify(record);
  const reply = repliesFor(await redisPipeline([["SET", key, payload, "EX", RECORD_SECONDS]]), 1);
  if (reply?.[0] === "OK") return true;
  const back = repliesFor(await redisPipeline([["GET", key]]), 1);
  return back !== null && back[0] === payload;
}

export type TakeResult =
  | { kind: "done" }
  | { kind: "declined" }
  | { kind: "confirm"; url: string }
  | { kind: "failed" }
  /** Stripe's answer did not arrive; the thanks page finds out what happened. */
  | { kind: "checking" }
  /** Stripe answered 429 (too many requests) to the yes: the offer was let go of and can be answered again, under the same idempotency key. */
  | { kind: "busy" }
  | { kind: "unavailable" }
  /** A yes without the box to start access at once checked on this offer's own button (lib/digital-consent.ts): nothing written, nothing charged. */
  | { kind: "consent" }
  /** The step no longer has the terms the page showed (offerRef): nothing written, nothing charged; the page shows it as it stands now. */
  | { kind: "changed" };

type SessionView = {
  status?: unknown;
  payment_status?: unknown;
  created?: unknown;
  customer?: unknown;
  currency?: unknown;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: unknown } | null;
  payment_intent?: { id?: unknown; payment_method?: unknown } | string | null;
};

/**
 * Reads a paid checkout of this store, with what an upsell needs from it:
 * the product whose funnel follows it, which for a cart is the one its
 * checkout named (lib/cart-offers.ts), and nothing when it named none.
 */
async function paidSession(store: Store, session: string): Promise<{ view: SessionView; product: Product; cart: boolean } | null> {
  if (!store.stripeAccountId || !SESSION_ID.test(session)) return null;
  let view: SessionView;
  try {
    view = (await onAccount(
      "GET",
      store.stripeAccountId,
      `/checkout/sessions/${encodeURIComponent(session)}?expand[]=payment_intent.payment_method`,
    )) as SessionView;
  } catch {
    return null;
  }
  if (view.status !== "complete" || view.payment_status !== "paid") return null;
  if (view.metadata?.store !== store.handle) return null;
  const cart = view.metadata?.cart === "yes";
  const from = cart ? cartOfferFrom(view.metadata) : view.metadata?.product;
  const product = from ? await readProduct(store, from) : null;
  return product ? { view, product, cart } : null;
}

/** Whether the offers can still be shown to this browser, for this order. */
export function offerOpen(createdSeconds: number, secret: string | undefined, key: string | undefined): boolean {
  if (!secret || !key || fingerprint(secret) !== key) return false;
  return Date.now() / 1000 - createdSeconds <= UPSELL_WINDOW_SECONDS;
}

/**
 * The listings an offer after paying may lead to: only what the store could
 * sell on its own right now (lib/store-checkout.ts, canSellProduct), so a
 * product that is a draft again or has nothing to hand over is passed over
 * as if it were gone, on the thanks page and when the answer is taken alike.
 */
// At the price each costs on its own right now: a store-wide sale (lib/store-sale.ts) lowers it, so an offer dearer
// than the product bought alone is paused as "dearer" (lib/funnel.ts, stepPause), never charged (DISC-B-3).
const sellableTargets = (store: Store, listings: Listing[]) =>
  listings
    .filter((p) => canSellProduct(store, p))
    .map((p) => {
      const off = saleOff(store.sale, p, saleClock());
      return off > 0 ? { ...p, priceCents: salePrice(p.priceCents, off) } : p;
    });

/**
 * How the thanks page's form names the offer it drew: the step's id, a dot, and a fingerprint of every term drawn
 * with it — the product, its title and price on its own, the offer's price and the store's currency, the creator's
 * words, the picture and which box to start access at once is asked. The answer counts only while the step still
 * has those exact terms (takeUpsell), so an edit made while the buyer reads the page is never charged or answered
 * on their click. Compared, never charged: the charge is the server's own current price.
 */
export function offerRef(store: Pick<Store, "currency">, step: FunnelStep, target: Listing): string {
  const terms = JSON.stringify([
    step.id,
    target.id,
    target.title,
    target.priceCents,
    step.priceCents,
    store.currency,
    step.headline,
    step.text,
    step.imageFrom,
    deliversDigitally(target) ? consentKind(target) : "",
  ]);
  return `${step.id}.${createHash("sha256").update(`marktmorgen-offer-terms:v1:${terms}`).digest("hex").slice(0, 32)}`;
}

const toAnswers = (records: Map<string, UpsellRecord>) =>
  new Map<string, StepAnswer>([...records].map(([slot, record]) => [slot, record.state]));

/**
 * Answers the offer the buyer is at: "yes" charges it to the card they just
 * paid with, "no" moves on without charging anything.
 *
 * `secret` is the cookie from the buyer's own browser; without it, or after
 * the hour, or for an offer that is not the one they are at, or a second
 * time, nothing happens.
 */
export async function takeUpsell(input: {
  store: Store;
  session: string;
  secret: string | undefined;
  origin: string;
  /** The offer the page showed, as its form names it (offerRef); the answer only counts for that one, on those terms. */
  step: string;
  answer: "yes" | "no";
  /**
   * The box to start access at once, checked on this offer's own button
   * (lib/digital-consent.ts). Each offer is its own contract, so the yes
   * given for the order before it never counts for this one.
   */
  consent?: DigitalConsent | null;
}): Promise<TakeResult> {
  const { store, session, secret, origin, answer } = input;
  // A store that cannot sell (lib/store-checkout.ts, canSell: switched off
  // after notices, plan not paid, Stripe not cleared) takes no offer: refused
  // before Stripe is asked anything and before anything is written.
  if (!store.stripeAccountId || !isRedisConfigured() || !canSell(store)) return { kind: "unavailable" };
  const found = await paidSession(store, session);
  if (!found) return { kind: "unavailable" };
  const { view, product, cart } = found;
  // A one-click charge cannot carry Stripe Tax, so with tax on there is none.
  // A bundle that holds a course is never offered here (lib/bundles.ts).
  const offered = sellableTargets(store, await offerableAfterPaying(store, await readListings(store, funnelProductIds(product.funnel))));
  const funnel = store.tax.enabled ? null : activeFunnel(offered, product);
  if (!funnel) return { kind: "unavailable" };
  const created = typeof view.created === "number" ? view.created : 0;
  if (!offerOpen(created, secret, view.metadata?.upsell_key)) return { kind: "unavailable" };
  // Paid with something a one-click charge cannot reach again, or in another
  // currency than the store's offers are priced in, or in one Stripe's answer
  // does not name (never taken for dollars, rule 24): there is no offer.
  if (!reusableMethod(view) || typeof view.currency !== "string" || view.currency !== store.currency) {
    return { kind: "unavailable" };
  }

  // Where the buyer is, worked out from what they already answered: only
  // that offer can be answered now.
  const owned = new Set(deliveredIds(view.metadata));
  // After a cart, nothing the buyer already has from the store either, read
  // as the page read it; unreadable, nothing is offered (lib/cart-offers.ts).
  if (cart) {
    const before = await ownedBeforeCart(store, typeof view.customer_details?.email === "string" ? view.customer_details.email : null);
    if (!before) return { kind: "unavailable" };
    before.forEach((id) => owned.add(id));
  }
  const records = await readAnswers(session);
  // After a cart, a product turned down in this order is never offered again,
  // not even at a lower price on a "no thanks" path (lib/cart-offers.ts).
  if (cart) for (const record of records.values()) if (record.state === "declined" || record.state === "failed") owned.add(record.product);
  const position = funnelPosition(funnel, offered, toAnswers(records), owned);
  const askedId = input.step.split(".")[0];
  if (position.kind !== "offer" || position.step.id !== askedId) {
    const asked = funnel.steps.find((s) => s.id === askedId);
    const record = asked ? records.get(stepSlot(funnel, asked)) : undefined;
    if (record?.state === "failed") return { kind: "failed" };
    if (record?.state === "declined") return { kind: "declined" };
    return record ? { kind: "done" } : { kind: "unavailable" };
  }
  const { step, target } = position;
  // Answered only on the terms the page drew: a step edited since, or a form that does not name them, is shown
  // again as it stands now, with nothing written and nothing charged.
  if (input.step !== offerRef(store, step, target)) return { kind: "changed" };
  const slot = stepSlot(funnel, step);
  // A bundle offered: what it holds now is what this buyer gets, kept with
  // the answer and on the charge.
  const items = target.bundle ? deliverableItems(target, await readListings(store, target.bundle)).map((p) => p.id) : null;
  const extra = items ? { items } : {};

  if (answer === "no") {
    // Nothing is charged; the answer is written once, like a yes.
    await redisPipeline([
      ["SET", recordKey(session, slot), JSON.stringify({ state: "declined", product: target.id, ...extra, at: Date.now() }), "NX", "EX", RECORD_SECONDS],
      ...(slot ? [["SADD", slotsKey(session), slot], ["EXPIRE", slotsKey(session), RECORD_SECONDS]] : []),
    ]);
    return { kind: "declined" };
  }

  // Handed over digitally at once: not without this offer's own yes, asked
  // before anything is written or charged, so the buyer can check it and
  // answer the same offer again.
  const digital = deliversDigitally(target);
  if (digital && !validConsent(input.consent)) return { kind: "consent" };

  // An order that came through an affiliate's link carries them on to what
  // is added after it, at the share this product earns today. Read before
  // anything is written or charged: a share that cannot be read throws
  // (CX-123 rule 24), and the offer is not charged without it.
  const via = view.metadata?.via ?? "";
  const rate = via ? await funnelRate(store, via, target.id) : 0;

  // Once, however many times the button is pressed. Taken here only on exactly "OK"; null is an answer already
  // written. Any other reply (none, a number, another word, more than one) does not say the claim is this press's,
  // so it is unknown (CX-123 rule 24): the card is not charged and nothing more is written.
  const claim = repliesFor(
    await redisPipeline([
      ["SET", recordKey(session, slot), JSON.stringify({ state: "pending", product: target.id, ...extra, at: Date.now() }), "NX", "EX", RECORD_SECONDS],
    ]),
    1,
  );
  const claimed = claim?.[0];
  if (!claim || (claimed !== "OK" && claimed !== null)) throw new UnknownReplyError("an offer's claim");
  if (claimed === null) {
    const existing = await readUpsell(session, slot);
    return existing?.state === "failed" ? { kind: "failed" } : existing?.state === "declined" ? { kind: "declined" } : { kind: "done" };
  }
  // An offer taken is one of the month's orders: a paid store's stop at its plan's figure
  // (lib/order-admission.ts) before anything is charged. Not admitted, the answer is taken
  // back and the buyer goes on to what they already bought.
  const admitted = await admitOrders(store, 1);
  if (!admitted.ok) {
    await redisPipeline([["DEL", recordKey(session, slot)]]);
    return { kind: "unavailable" };
  }
  if (slot) await redisPipeline([["SADD", slotsKey(session), slot], ["EXPIRE", slotsKey(session), RECORD_SECONDS]]);

  const method = methodId(view);
  const customer = typeof view.customer === "string" ? view.customer : null;
  if (!method || !customer) {
    await writeUpsell(session, slot, { state: "failed", product: target.id, ...extra, at: Date.now() });
    return { kind: "failed" };
  }

  // Written down before Stripe is asked, so a lost answer can be looked for,
  // by the thanks page and by the five-minute job.
  // Only on an exact "OK" is Stripe asked (Claude 1 on #3834): a write that did not land would leave a bare claim,
  // which the orphan release lets go once old, so a charge posted after it could be asked again. Unconfirmed, the
  // press is refused here, nothing is sent, and the bare claim is released as an orphan (settleUpsells).
  // An unclear reply is read back: the exact payload of this write found means it landed, and the press goes on.
  if (!(await writeUpsellConfirmed(session, slot, { state: "pending", product: target.id, ...extra, customer, at: Date.now() }))) {
    throw new UnknownReplyError("an offer's record naming the customer before its charge");
  }
  await watchPending(store, session, slot);

  const email = typeof view.customer_details?.email === "string" ? view.customer_details.email : "";
  const body = new URLSearchParams({
    amount: String(step.priceCents),
    currency: store.currency,
    customer,
    payment_method: method,
    confirm: "true",
    return_url: `${origin}/@${store.handle}/thanks?session_id=${encodeURIComponent(session)}&upsell=back`,
    description: target.title.slice(0, 200),
    "metadata[store]": store.handle,
    "metadata[product]": target.id,
    "metadata[title]": target.title.slice(0, 480),
    "metadata[kind]": "upsell",
    "metadata[parent]": session,
  });
  if (items) {
    for (const [key, value] of Object.entries(bundleMeta("bundle", items))) body.set(`metadata[${key}]`, value);
  }
  // The first offer's charge looks exactly as a single upsell's always did.
  if (slot) body.set("metadata[step]", slot);
  // Which offer of the funnel this is — its own id and its place in the
  // list — so what Stripe sends on about the charge (the creator's webhooks,
  // lib/webhooks.ts) can say which step was taken.
  body.set("metadata[step_id]", step.id);
  body.set("metadata[step_number]", String(funnel.steps.findIndex((s) => s.id === step.id) + 1));
  // The yes to start access at once, its version and its time, on the offer's own payment.
  if (digital && input.consent) body.set(`metadata[${CONSENT_META}]`, consentMetaValue(input.consent, consentKind(target)));
  if (email) body.set("receipt_email", email);
  if (via && rate > 0) {
    body.set("metadata[via]", via);
    body.set("metadata[via_rate]", String(rate));
  }
  // The share, when the store's plan has one (lib/platform-share.ts): the
  // amount is known exactly, since nothing comes off an offer.
  applyShareToPayment(body, store, step.priceCents);

  try {
    // One key per offer of each order: however this request is repeated,
    // Stripe charges once.
    const pi = await onAccount(
      "POST",
      store.stripeAccountId,
      "/payment_intents",
      body,
      undefined,
      slot ? `nimbus-upsell:${session}:${slot}` : `nimbus-upsell:${session}`,
    );
    const id = typeof pi.id === "string" ? pi.id : "";
    // Only Stripe's answer for this charge (rule 30, DISC-C-4): a payment intent, with its id, for the amount and
    // currency asked. Any other answer proves nothing: the offer stays pending, with no id taken from it, and is
    // found among the buyer's payments and settled from what Stripe says (settleOne), never written down as paid.
    // An answer with no amount at all (audit R48) is still this payment intent by its id, object and currency: it
    // goes on as Stripe says, and its email leaves the amount line out (afterPaid). An amount that is there and is
    // not the one asked is another charge's.
    const amountAsked = pi.amount === undefined || pi.amount === null || pi.amount === step.priceCents;
    const own = pi.object === "payment_intent" && /^pi_\w+$/.test(id) && amountAsked && typeof pi.currency === "string" && pi.currency.toLowerCase() === store.currency.toLowerCase();
    if (!own) {
      await writeUpsell(session, slot, { state: "pending", product: target.id, ...extra, customer, at: Date.now() });
      return { kind: "checking" };
    }
    if (pi.status === "succeeded") {
      await writeUpsell(session, slot, { state: "paid", product: target.id, ...extra, pi: id, customer, at: Date.now() });
      await unwatchPending(store, session, slot);
      // Its place is given back only once the offer is counted (or covered by its share): a count not confirmed
      // keeps it held until its hours end, never given back as if counted (lib/orders.ts, countOrder).
      if ((await afterPaid(store, session, slot, target, pi, email)) !== "unknown") await settleAdmitted(store, admitted.hour);
      return { kind: "done" };
    }
    const next = pi.next_action as { redirect_to_url?: { url?: unknown } } | null;
    const url = typeof next?.redirect_to_url?.url === "string" ? next.redirect_to_url.url : "";
    if (pi.status === "requires_action" && url) {
      await writeUpsell(session, slot, { state: "pending", product: target.id, ...extra, pi: id, customer, at: Date.now() });
      return { kind: "confirm", url };
    }
    // Still on its way (DISC-B-4): "processing" (Link paid from a bank account, now and then a card) or any state not
    // read as one that took nothing can still be paid. It stays pending on the five-minute job's list and is settled
    // from what Stripe says (settleOne), never told as declined while the buyer may yet be charged.
    if (!NOTHING_TAKEN.has(String(pi.status))) {
      await writeUpsell(session, slot, { state: "pending", product: target.id, ...extra, pi: id, customer, at: Date.now(), waiting: "processing" });
      return { kind: "checking" };
    }
    await writeUpsell(session, slot, { state: "failed", product: target.id, ...extra, pi: id, customer, at: Date.now() });
    await unwatchPending(store, session, slot);
    return { kind: "failed" };
  } catch (error) {
    // Stripe answered and said no — a declined card, a refused request — so
    // nothing was charged. Never a 429 (too many requests: nothing done, and
    // nothing said of the card), a 409 or an idempotency error (a request
    // under this key is still being worked on, or was made before): those
    // say nothing of a charge, and go the way of no answer below.
    if (
      error instanceof StripeError &&
      error.status < 500 &&
      error.status !== 409 &&
      error.status !== 429 &&
      error.code !== "idempotency_error" &&
      error.code !== "idempotency_key_in_use"
    ) {
      await writeUpsell(session, slot, { state: "failed", product: target.id, ...extra, customer, at: Date.now() });
      await unwatchPending(store, session, slot);
      return { kind: "failed" };
    }
    // Too many requests: not a word about the card, and the yes is not lost to it (outage drill, 13 November 2026).
    // The offer is let go of so the buyer can answer it again; that yes goes under this same idempotency key, so
    // whatever Stripe did with this one, it is charged once at most.
    if (error instanceof StripeError && error.status === 429) {
      await redisPipeline([["DEL", recordKey(session, slot)], ...(slot ? [["SREM", slotsKey(session), slot]] : [])]);
      await unwatchPending(store, session, slot);
      return { kind: "busy" };
    }
    // No answer, or Stripe's own failure: the charge may have gone through.
    // It stays pending and is settled from what Stripe says (settleUpsells),
    // never reported as declined on a guess.
    console.error("upsell charge failed", error);
    return { kind: "checking" };
  }
}

/**
 * What follows an offer being paid, wherever that is learned: the affiliate
 * the order came through is credited, the buyer gets its confirmation, it is
 * one of the month's orders, and the creator's phone hears of the sale
 * (lib/sale-events.ts). None can undo the payment, so none failing is passed
 * on. Answers what counting it answered (lib/orders.ts, countOrder).
 */
async function afterPaid(store: Store, session: string, slot: string, target: Listing, pi: Record<string, unknown>, email: string): Promise<boolean | "unknown"> {
  await creditCharge(store, session, slot, pi);
  const reference = typeof pi.id === "string" ? pi.id : "";
  // What Stripe charged, read exactly (CX-123 rule 24; audit R48): a whole number of cents, never below zero, in a
  // three-letter currency. Anything else is null, and the confirmation leaves its "Paid" line out (lib/purchase-email.ts
  // offerConfirmationFor), never "$0" or the store's own currency.
  const exact = Number.isSafeInteger(pi.amount) && Number(pi.amount) >= 0 && typeof pi.currency === "string" && /^[a-z]{3}$/.test(pi.currency);
  const amountCents = exact ? Number(pi.amount) : null;
  const currency = exact ? String(pi.currency) : null;
  // A bundle added this way: its products, from the list on its own payment.
  const listed = bundleFromMeta(pi.metadata as Record<string, string> | null, "bundle");
  const items = listed.length ? (await contentsOf(store, listed).catch(() => null))?.items : undefined;
  const metadata = (pi.metadata as Record<string, string> | null) ?? null;
  const sent = await confirmOffer(store, { reference, parent: session, product: target, email, amountCents, currency, items, metadata }).catch((error) => {
    console.error("sending an offer's confirmation failed", error);
    return "failed" as const;
  });
  // One of the month's orders, by its own payment, whether or not its email went: it was paid. Only an offer this
  // store does not confirm by email ("skip") is left as before.
  // An amount not read exactly is counted as an order no share covered (this branch, audit R48): while COMMISSION_LIVE
  // is false no store's sales pay a share, so every order is counted whatever it paid (lib/orders.ts coveredByShare).
  const counted = sent === "skip" ? false : await countOrder(store, `offer:${reference}`, amountCents ?? 0);
  await noteOfferSale(store, target, pi).catch((error) => console.error("telling about an offer's sale failed", error));
  return counted;
}

/**
 * Pages of a hundred of the customer's payments read before "not there" is no longer known, per offer still waiting
 * (Claude 4's cost note on #2759, rule MR). On the buyer's own page (settleUpsells, at most the first offer and 20 more
 * that readAnswers keeps, 21 a visit) one page, as many requests as before this lot; in the five-minute job (settlePendingOffers, at most
 * 50 offers a run, stopped earlier by its deadline) up to five. An offer not found within its pages stays waiting for
 * the job, never closed: the worst case is OFFER_PAGES_ON_PAGE × 21 = 21 requests a visit and OFFER_PAGES_IN_JOB × 50
 * = 250 a run, all reads on the creator's own Stripe account, none of them a charge.
 */
export const OFFER_PAGES_ON_PAGE = 1;
export const OFFER_PAGES_IN_JOB = 5;

/**
 * One offer's charge for this order, found among the customer's payments, each page read in its exact shape
 * (lib/stripe-list.ts) and pinned to one version. Found on any readable row is found. Null ("not there", after which
 * the offer is closed as never charged) only when the payments were read to their end with every row readable;
 * a page in another shape, a row not readable or more pages than are read throw, and the offer stays waiting.
 */
export async function findOfferCharge(
  store: Store,
  session: string,
  slot: string,
  customer: string,
  pages: number = OFFER_PAGES_IN_JOB,
): Promise<Record<string, unknown> | null> {
  let after = "";
  let unreadable = 0;
  for (let page = 0; page < pages; page += 1) {
    const query = new URLSearchParams({ customer, limit: "100" });
    if (after) query.set("starting_after", after);
    const read = readStripePage(
      await onAccount("GET", store.stripeAccountId as string, `/payment_intents?${query}`, undefined, STRIPE_LIST_VERSION),
      (pi) => {
        const meta = ownField(pi, "metadata");
        return meta === null || plainObject(meta);
      },
    );
    unreadable += read.unreadable;
    const found = read.rows.find((pi) => {
      const meta = ownField(pi, "metadata");
      if (!plainObject(meta)) return false;
      const step = ownField(meta, "step");
      return ownField(meta, "kind") === "upsell" && ownField(meta, "parent") === session && (step === undefined ? "" : step) === slot;
    });
    if (found) return found;
    if (!read.hasMore) {
      if (unreadable) throw new StripeListUnreadable("a payment not readable");
      return null;
    }
    if (!read.lastId) throw new StripeListUnreadable("more payments and no readable last one");
    after = read.lastId;
  }
  throw new StripeListUnreadable("more payments than are read");
}

/**
 * Deletes an offer's record only while it is still exactly the orphan claim that was read (ARGV[1]): a record
 * written since — naming the customer, a payment or an answer — is never taken off.
 */
const ORPHAN_RELEASE = `-- marktmorgen:upsell-orphan-release:v1
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * What settleOne answers when Stripe could not be read (an error status, a timeout, a list it could not page
 * through) or the answer could not be acted on: unknown, so never read as "not processing" (rule 24). Kept apart
 * from null, which is an answer that was read and is not about this offer (or no payment to read).
 */
const UNREAD = Symbol("unread");

/**
 * Settles one offer still waiting on an answer. Nothing is ever charged here.
 * Answers the payment's status as Stripe gave it, null when there was no status to read for this offer (no payment
 * found, or a reply about another offer), or UNREAD when Stripe could not be read.
 */
async function settleOne(
  store: Store,
  session: string,
  slot: string,
  record: UpsellRecord,
  pages: number,
): Promise<string | null | typeof UNREAD> {
  if (record.state !== "pending" || !store.stripeAccountId) return null;
  try {
    let pi: Record<string, unknown> | null;
    if (record.pi) {
      pi = await onAccount("GET", store.stripeAccountId, `/payment_intents/${encodeURIComponent(record.pi)}`);
    } else if (record.customer) {
      pi = await findOfferCharge(store, session, slot, record.customer, pages);
      if (!pi) {
        // Not there after long enough: the request never reached Stripe.
        if (Date.now() - record.at > LOST_ANSWER_MS) {
          await writeUpsell(session, slot, { ...record, state: "failed" });
          await unwatchPending(store, session, slot);
        }
        return null;
      }
    } else {
      // Neither a customer nor a payment: only the claim was written (its reply lost, or the write naming the
      // customer failed), and the charge is asked of Stripe only after that write. So it was never sent and nothing
      // was charged: once older than a request in flight could still be, it is let go, only while it is still this
      // very record, and the buyer can answer the offer again. Never shown as checking until it expires.
      if (Date.now() - record.at > LOST_ANSWER_MS) {
        await redisPipeline([["EVAL", ORPHAN_RELEASE, 1, recordKey(session, slot), JSON.stringify(record)]]);
      }
      return null;
    }
    const meta = pi.metadata as Record<string, string> | null;
    if (meta?.parent !== session || (meta?.step ?? "") !== slot) return null;
    const id = typeof pi.id === "string" ? pi.id : record.pi;
    if (pi.status === "succeeded" || pi.status === "requires_payment_method" || pi.status === "canceled") {
      await unwatchPending(store, session, slot);
    }
    if (pi.status === "succeeded") {
      await writeUpsell(session, slot, { ...record, pi: id, state: "paid" });
      const target = await readListing(store, record.product);
      const email = typeof pi.receipt_email === "string" ? pi.receipt_email : "";
      if (target) await afterPaid(store, session, slot, target, pi, email);
      else await creditCharge(store, session, slot, pi);
    } else if (pi.status === "requires_payment_method" || pi.status === "canceled") {
      await writeUpsell(session, slot, { ...record, pi: id, state: "failed" });
    } else {
      // Still pending: told as checking while Stripe says processing, as not confirmed while it waits on the buyer.
      const waiting = pi.status === "processing" ? "processing" : pi.status === "requires_action" ? undefined : record.waiting;
      if (id !== record.pi || waiting !== record.waiting) {
        const next: UpsellRecord = { ...record, pi: id };
        if (waiting) next.waiting = waiting;
        else delete next.waiting;
        await writeUpsell(session, slot, next);
      }
    }
    return typeof pi.status === "string" ? pi.status : null;
  } catch (error) {
    console.error("settling an upsell failed", error);
    return UNREAD;
  }
}

/**
 * Settles every offer of this order still waiting on an answer: one the bank
 * asked the buyer to confirm, or one whose answer from Stripe was lost on the
 * way back. Paid only if Stripe says so, for this very order and this very
 * offer. Nothing is ever charged here.
 */
export async function settleUpsells(store: Store, session: string): Promise<void> {
  const records = await readAnswers(session);
  for (const [slot, record] of records) {
    if (record.state === "pending") await settleOne(store, session, slot, record, OFFER_PAGES_ON_PAGE);
  }
}

/**
 * The five-minute job's pass over offers still waiting on Stripe, in every
 * store: each is settled from what Stripe says (settleOne), so a paid offer
 * gets its confirmation email and its affiliate credit without waiting for
 * the buyer to come back, and one the bank never confirmed is let go after
 * two days (seven while Stripe still says it is processing, looked at once a
 * day after the second). Each is looked at less often the longer it waits
 * (WATCH_AFTER_MS). Nothing is ever charged here. `storeFor` is passed in, as the
 * other jobs do, so this file does not depend on the store record's.
 */
export async function settlePendingOffers(
  storeFor: (handle: string) => Promise<Store | null>,
  deadline: number,
): Promise<{ checked: number; settled: number }> {
  const counts = { checked: 0, settled: 0 };
  if (!isRedisConfigured()) return counts;
  // A minute's grace: the buyer's own browser is usually back by then and
  // settles it itself on the thanks page.
  const [members] = await redisPipeline([["ZRANGEBYSCORE", PENDING_KEY, 0, Date.now() - 60_000, "LIMIT", 0, 50]]);
  const list = Array.isArray(members) ? (members as unknown[]).map(String) : [];
  for (const member of list) {
    if (Date.now() >= deadline) break;
    const [handle, session, slot = "", mark = ""] = member.split("|");
    const drop = () => redisPipeline([["ZREM", PENDING_KEY, member]]);
    const since = CREDIT_MARK.exec(mark)?.[1];
    if (since && handle && SESSION_ID.test(session ?? "") && (!slot || SLOT_PATTERN.test(slot))) {
      counts.checked += 1;
      try {
        const store = await storeFor(handle);
        if (!store) throw new Error("the offer's store did not read");
        await creditAgain(store, session, slot);
        await drop();
      } catch (error) {
        // Still unknown: kept, moved behind the others, tried at the next run, for as long as an offer is watched
        // from the first failure (the member carries its time, so no read is needed to let it go).
        console.error("crediting a paid offer again failed; tried again by the job", error);
        if (Date.now() - Number(since) > PENDING_WATCH_MS) await drop().catch(() => undefined);
        else await redisPipeline([["ZADD", PENDING_KEY, Date.now(), creditMember(handle, session, slot, Number(since))]]).catch(() => undefined);
      }
      continue;
    }
    if (!handle || !SESSION_ID.test(session ?? "") || (slot && !SLOT_PATTERN.test(slot))) {
      await drop();
      continue;
    }
    counts.checked += 1;
    try {
      const record = await readUpsell(session, slot);
      if (!record || record.state !== "pending") {
        await drop();
        continue;
      }
      const store = await storeFor(handle);
      if (!store || !store.stripeAccountId) {
        const next = nextLook(record.at, Date.now());
        if (next === null) await drop();
        else await redisPipeline([["ZADD", PENDING_KEY, next, pendingMember(handle, session, slot)]]);
        continue;
      }
      const status = await settleOne(store, session, slot, record, OFFER_PAGES_IN_JOB);
      const after = await readUpsell(session, slot);
      if (!after || after.state !== "pending") {
        counts.settled += 1;
        await drop();
      } else {
        // Looked at again later, less often the longer it waits (WATCH_AFTER_MS); past its watch, a payment still
        // clearing at the bank is looked at once a day, so a late success is handed over in full. An answer that
        // could not be read is unknown, not "not processing" (rule 24): it is looked at again the same way, a day
        // later, still only inside PROCESSING_WATCH_MS, so its looks stay inside OFFER_WATCH_LOOKS_MOST.
        const next = nextLook(after.at, Date.now());
        if (next !== null) {
          await redisPipeline([["ZADD", PENDING_KEY, next, pendingMember(handle, session, slot)]]);
        } else if ((status === "processing" || status === UNREAD) && Date.now() - after.at <= PROCESSING_WATCH_MS) {
          await redisPipeline([["ZADD", PENDING_KEY, Date.now() + PROCESSING_RECHECK_MS, pendingMember(handle, session, slot)]]);
        } else {
          await drop();
        }
      }
    } catch (error) {
      console.error("settling a waiting offer failed", error);
    }
  }
  return counts;
}

/**
 * The reference a paid offer is known by: its own payment's id, as the
 * buyer's list of purchases shows it, or, before Stripe gave one, the order
 * and the offer's slot.
 */
export function upsellReference(session: string, slot: string, record: UpsellRecord): string {
  return record.pi ?? (slot ? `${session}:upsell:${slot}` : `${session}:upsell`);
}

/**
 * Whether an offer's own payment was refunded in full, or lost to a dispute,
 * since (lib/refunds.ts),
 * read from Stripe on every download, as the order is. An offer is its own
 * payment, so the order it followed may stand while it is refunded, or the
 * other way round. Throws when Stripe cannot be asked; the download then
 * answers that it could not check, rather than handing the file over.
 */
export async function offerRefunded(store: Store, reference: string): Promise<boolean> {
  if (!/^pi_[A-Za-z0-9]{6,200}$/.test(reference) || !store.stripeAccountId) return false;
  const pi = await onAccount("GET", store.stripeAccountId, `/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`);
  return givenBack(store.stripeAccountId, pi);
}

/** What one offer delivers, once it is paid. `slot` is "" for the first. */
export async function upsellDelivery(
  store: Store,
  session: string,
  slot = "",
): Promise<{ product: Listing; file: ProductFile | null; link: string | null; reference: string; paidAt: number; items: BundleContents | null } | null> {
  const record = await readUpsell(session, slot);
  if (!record || record.state !== "paid") return null;
  const product = await readListing(store, record.product);
  // Its own payment's id, when Stripe gave one: the same reference the
  // buyer's list of purchases shows it under, so a license key or a stamped
  // copy made for it is found again from either page.
  const reference = upsellReference(session, slot, record);
  // When it was paid, in seconds: the date a stamped copy carries.
  const paidAt = Math.floor(record.at / 1000);
  const items = record.items?.length ? await contentsOf(store, record.items) : null;
  return product ? { product, file: product.file, link: product.link, reference, paidAt, items } : null;
}

export type FunnelView = {
  /** The offer to show now, when there is one. */
  offer: {
    step: FunnelStep;
    target: Listing;
    /** What the form posts as the step: its id and the terms drawn (offerRef). */
    ref: string;
    image: ProductImage | null;
    /** Reached by saying no to an earlier offer. */
    afterNo: boolean;
  } | null;
  /**
   * What was added and paid for, each with the slot its download is asked
   * by, and what it hands over when it is a bundle.
   */
  taken: { slot: string; product: Listing; reference: string; items: BundleContents | null }[];
  /** An offer still waiting on the bank or Stripe, or one the card turned down. */
  notes: { state: "checking" | "unconfirmed" | "declined"; title: string }[];
  /** The products the buyer said no to, or whose charge the card turned down: never suggested to them again (lib/next-offer.ts). */
  declined: string[];
};

/**
 * What the thanks page shows of the offers after paying: the one the buyer
 * is at — only to the browser that paid, within the hour — what they added,
 * and anything still waiting or turned down.
 */
export async function funnelView(input: {
  store: Store;
  session: string;
  /** The product bought; its funnel is read here. */
  product: Listing;
  /** What else this order holds: what was ticked at checkout. */
  alsoOwned: string[];
  /** Whether this order can be followed by offers at all. */
  eligible: boolean;
  created: number;
  secret: string | undefined;
  upsellKey: string | null;
  /**
   * Paid for from the cart (lib/cart-offers.ts): the product whose funnel
   * follows, as its checkout named it (none: no offer), and the address it
   * was paid with, to pass over what the buyer already has from the store.
   */
  cart?: { offerFrom: string | null; email: string | null };
}): Promise<FunnelView> {
  const { store, session, product } = input;
  const records = await readAnswers(session);
  const taken: FunnelView["taken"] = [];
  const notes: FunnelView["notes"] = [];
  const declined: string[] = [];
  const find = listingFinder(store);
  for (const [slot, record] of records) {
    const known = await find(record.product);
    const title = known?.title ?? "The product you were offered";
    if (record.state === "paid" && known) {
      const items = record.items?.length ? await contentsOf(store, record.items) : null;
      taken.push({ slot, product: known, reference: upsellReference(session, slot, record), items });
    }
    if (record.state === "pending") notes.push({ state: record.pi && record.waiting !== "processing" ? "unconfirmed" : "checking", title });
    if (record.state === "failed") notes.push({ state: "declined", title });
    if (record.state === "declined" || record.state === "failed") declined.push(record.product);
  }

  // The funnel and what it names are read only when an offer could follow.
  // Never shown where the answer would be refused (takeUpsell): a store that cannot sell, a product that cannot be sold.
  const open = input.eligible && !store.tax.enabled && canSell(store) && offerOpen(input.created, input.secret, input.upsellKey ?? undefined);
  const owner = input.cart ? input.cart.offerFrom : product.id;
  const full = open && owner ? await readProduct(store, owner) : null;
  const listed = full ? await offerableAfterPaying(store, await readListings(store, funnelProductIds(full.funnel))) : [];
  const offered = sellableTargets(store, listed);
  const funnel = full ? activeFunnel(offered, full) : null;
  if (!funnel) return { offer: null, taken, notes, declined };
  // After a cart, what was turned down in this order is passed over too, as on the server (takeUpsell).
  const owned = new Set([product.id, ...input.alsoOwned, ...(input.cart ? declined : [])]);
  let position = funnelPosition(funnel, offered, toAnswers(records), owned);
  // After a cart, what the buyer already has from the store is passed over
  // too, read only when there is an offer to show (lib/cart-offers.ts).
  if (position.kind === "offer" && input.cart) {
    const before = await ownedBeforeCart(store, input.cart.email);
    if (!before) return { offer: null, taken, notes, declined };
    before.forEach((id) => owned.add(id));
    position = funnelPosition(funnel, offered, toAnswers(records), owned);
  }
  if (position.kind !== "offer") return { offer: null, taken, notes, declined };
  const { step, target } = position;
  // Never a picture moved after a notice to a name no public page gives out (R44); a draft's, as the editor shows it.
  const pictured = step.imageFrom ? listed.find((p) => p.id === step.imageFrom && picturedFrom(p)) ?? null : null;
  const afterNo = funnel.steps.some((s) => s.no === step.id && records.get(stepSlot(funnel, s))?.state === "declined");
  return {
    offer: {
      step,
      target,
      ref: offerRef(store, step, target),
      image: pictured?.image ?? null,
      afterNo,
    },
    taken,
    notes,
    declined,
  };
}
