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
import { createHash, randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
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
import { refundedInFull } from "@/lib/refunds";
import { methodId, reusableMethod } from "@/lib/instant-pay";
import type { Listing, Product, Store } from "@/lib/store";
import { listingFinder, readListing, readListings, readProduct } from "@/lib/catalog";
import { funnelProductIds } from "@/lib/funnel";
import type { ProductFile } from "@/lib/product-file";
import type { ProductImage } from "@/lib/product-image";
import { bundleFromMeta, bundleMeta, deliverableItems, deliveredIds } from "@/lib/bundle-rules";
import { type BundleContents, contentsOf, offerableAfterPaying } from "@/lib/bundles";
import { applyShareToPayment } from "@/lib/platform-share";
import { CONSENT_META, type DigitalConsent, consentKind, consentMetaValue, deliversDigitally, validConsent } from "@/lib/digital-consent";
import { cartOfferFrom, ownedBeforeCart } from "@/lib/cart-offers";

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
const pendingMember = (handle: string, session: string, slot: string) => `${handle}|${session}|${slot}`;

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

/** The answer to one offer of this order, or null when there is none yet. */
export async function readUpsell(session: string, slot = ""): Promise<UpsellRecord | null> {
  if (!isRedisConfigured() || !SESSION_ID.test(session) || (slot && !SLOT_PATTERN.test(slot))) return null;
  const [raw] = await redisPipeline([["GET", recordKey(session, slot)]]);
  return parseRecord(raw);
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

async function writeUpsell(session: string, slot: string, record: UpsellRecord): Promise<void> {
  await redisPipeline([["SET", recordKey(session, slot), JSON.stringify(record), "EX", RECORD_SECONDS]]);
}

export type TakeResult =
  | { kind: "done" }
  | { kind: "declined" }
  | { kind: "confirm"; url: string }
  | { kind: "failed" }
  /** Stripe's answer did not arrive; the thanks page finds out what happened. */
  | { kind: "checking" }
  | { kind: "unavailable" }
  /** A yes without the box to start access at once checked on this offer's own button (lib/digital-consent.ts): nothing written, nothing charged. */
  | { kind: "consent" };

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
  /** The offer the page showed; the answer only counts for that one. */
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
  if (!store.stripeAccountId || !isRedisConfigured()) return { kind: "unavailable" };
  const found = await paidSession(store, session);
  if (!found) return { kind: "unavailable" };
  const { view, product, cart } = found;
  // A one-click charge cannot carry Stripe Tax, so with tax on there is none.
  // A bundle that holds a course is never offered here (lib/bundles.ts).
  const offered = await offerableAfterPaying(store, await readListings(store, funnelProductIds(product.funnel)));
  const funnel = store.tax.enabled ? null : activeFunnel(offered, product);
  if (!funnel) return { kind: "unavailable" };
  const created = typeof view.created === "number" ? view.created : 0;
  if (!offerOpen(created, secret, view.metadata?.upsell_key)) return { kind: "unavailable" };
  // Paid with something a one-click charge cannot reach again, or in another
  // currency than the store's offers are priced in: there is no offer.
  if (!reusableMethod(view) || (typeof view.currency === "string" ? view.currency : "usd") !== store.currency) {
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
  if (position.kind !== "offer" || position.step.id !== input.step) {
    const asked = funnel.steps.find((s) => s.id === input.step);
    const record = asked ? records.get(stepSlot(funnel, asked)) : undefined;
    if (record?.state === "failed") return { kind: "failed" };
    if (record?.state === "declined") return { kind: "declined" };
    return record ? { kind: "done" } : { kind: "unavailable" };
  }
  const { step, target } = position;
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

  // Once, however many times the button is pressed.
  const [claimed] = await redisPipeline([
    ["SET", recordKey(session, slot), JSON.stringify({ state: "pending", product: target.id, ...extra, at: Date.now() }), "NX", "EX", RECORD_SECONDS],
  ]);
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
  await writeUpsell(session, slot, { state: "pending", product: target.id, ...extra, customer, at: Date.now() });
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
  // An order that came through an affiliate's link carries them on to what
  // is added after it, at the share this product earns today.
  const via = view.metadata?.via ?? "";
  const rate = via ? await funnelRate(store, via, target.id).catch(() => 0) : 0;
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
    if (pi.status === "succeeded") {
      await writeUpsell(session, slot, { state: "paid", product: target.id, ...extra, pi: id, customer, at: Date.now() });
      await unwatchPending(store, session, slot);
      await afterPaid(store, session, target, pi, email);
      await settleAdmitted(store, admitted.hour);
      return { kind: "done" };
    }
    const next = pi.next_action as { redirect_to_url?: { url?: unknown } } | null;
    const url = typeof next?.redirect_to_url?.url === "string" ? next.redirect_to_url.url : "";
    if (pi.status === "requires_action" && url) {
      await writeUpsell(session, slot, { state: "pending", product: target.id, ...extra, pi: id, customer, at: Date.now() });
      return { kind: "confirm", url };
    }
    await writeUpsell(session, slot, { state: "failed", product: target.id, ...extra, pi: id, customer, at: Date.now() });
    await unwatchPending(store, session, slot);
    return { kind: "failed" };
  } catch (error) {
    // Stripe answered and said no — a declined card, a refused request — so
    // nothing was charged.
    if (error instanceof StripeError && error.status < 500) {
      await writeUpsell(session, slot, { state: "failed", product: target.id, ...extra, customer, at: Date.now() });
      await unwatchPending(store, session, slot);
      return { kind: "failed" };
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
 * the order came through is credited, the buyer gets its confirmation, and
 * the creator's phone hears of the sale (lib/sale-events.ts). None can undo
 * the payment, so none failing is passed on.
 */
async function afterPaid(store: Store, session: string, target: Listing, pi: Record<string, unknown>, email: string): Promise<void> {
  await noteCharge(store, pi).catch((error) => console.error("noting an affiliate sale failed", error));
  const reference = typeof pi.id === "string" ? pi.id : "";
  const amountCents = typeof pi.amount === "number" ? pi.amount : 0;
  const currency = typeof pi.currency === "string" && pi.currency ? pi.currency : store.currency;
  // A bundle added this way: its products, from the list on its own payment.
  const listed = bundleFromMeta(pi.metadata as Record<string, string> | null, "bundle");
  const items = listed.length ? (await contentsOf(store, listed).catch(() => null))?.items : undefined;
  const metadata = (pi.metadata as Record<string, string> | null) ?? null;
  await confirmOffer(store, { reference, parent: session, product: target, email, amountCents, currency, items, metadata }).catch((error) =>
    console.error("sending an offer's confirmation failed", error),
  );
  await noteOfferSale(store, target, pi).catch((error) => console.error("telling about an offer's sale failed", error));
}

/** One offer's charge for this order, found among the customer's payments. */
async function findCharge(
  store: Store,
  session: string,
  slot: string,
  customer: string,
): Promise<Record<string, unknown> | null> {
  const listed = await onAccount(
    "GET",
    store.stripeAccountId as string,
    `/payment_intents?${new URLSearchParams({ customer, limit: "20" })}`,
  );
  const rows = Array.isArray(listed.data) ? (listed.data as Record<string, unknown>[]) : [];
  return (
    rows.find((pi) => {
      const meta = pi.metadata as Record<string, string> | null;
      return meta?.kind === "upsell" && meta?.parent === session && (meta?.step ?? "") === slot;
    }) ?? null
  );
}

/** Settles one offer still waiting on an answer. Nothing is ever charged here. */
async function settleOne(store: Store, session: string, slot: string, record: UpsellRecord): Promise<void> {
  if (record.state !== "pending" || !store.stripeAccountId) return;
  try {
    let pi: Record<string, unknown> | null;
    if (record.pi) {
      pi = await onAccount("GET", store.stripeAccountId, `/payment_intents/${encodeURIComponent(record.pi)}`);
    } else if (record.customer) {
      pi = await findCharge(store, session, slot, record.customer);
      if (!pi) {
        // Not there after long enough: the request never reached Stripe.
        if (Date.now() - record.at > LOST_ANSWER_MS) {
          await writeUpsell(session, slot, { ...record, state: "failed" });
          await unwatchPending(store, session, slot);
        }
        return;
      }
    } else {
      return;
    }
    const meta = pi.metadata as Record<string, string> | null;
    if (meta?.parent !== session || (meta?.step ?? "") !== slot) return;
    const id = typeof pi.id === "string" ? pi.id : record.pi;
    if (pi.status === "succeeded" || pi.status === "requires_payment_method" || pi.status === "canceled") {
      await unwatchPending(store, session, slot);
    }
    if (pi.status === "succeeded") {
      await writeUpsell(session, slot, { ...record, pi: id, state: "paid" });
      const target = await readListing(store, record.product);
      const email = typeof pi.receipt_email === "string" ? pi.receipt_email : "";
      if (target) await afterPaid(store, session, target, pi, email);
      else await noteCharge(store, pi).catch((error) => console.error("noting an affiliate sale failed", error));
    } else if (pi.status === "requires_payment_method" || pi.status === "canceled") {
      await writeUpsell(session, slot, { ...record, pi: id, state: "failed" });
    } else if (id !== record.pi) {
      await writeUpsell(session, slot, { ...record, pi: id });
    }
  } catch (error) {
    console.error("settling an upsell failed", error);
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
    if (record.state === "pending") await settleOne(store, session, slot, record);
  }
}

/**
 * The five-minute job's pass over offers still waiting on Stripe, in every
 * store: each is settled from what Stripe says (settleOne), so a paid offer
 * gets its confirmation email and its affiliate credit without waiting for
 * the buyer to come back, and one the bank never confirmed is let go after
 * two days. Nothing is ever charged here. `storeFor` is passed in, as the
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
    const [handle, session, slot = ""] = member.split("|");
    const drop = () => redisPipeline([["ZREM", PENDING_KEY, member]]);
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
        if (Date.now() - record.at > PENDING_WATCH_MS) await drop();
        continue;
      }
      await settleOne(store, session, slot, record);
      const after = await readUpsell(session, slot);
      if (!after || after.state !== "pending") {
        counts.settled += 1;
        await drop();
      } else if (Date.now() - after.at > PENDING_WATCH_MS) {
        await drop();
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
 * Whether an offer's own payment was refunded in full since (lib/refunds.ts),
 * read from Stripe on every download, as the order is. An offer is its own
 * payment, so the order it followed may stand while it is refunded, or the
 * other way round. Throws when Stripe cannot be asked; the download then
 * answers that it could not check, rather than handing the file over.
 */
export async function offerRefunded(store: Store, reference: string): Promise<boolean> {
  if (!/^pi_[A-Za-z0-9]{6,200}$/.test(reference) || !store.stripeAccountId) return false;
  const pi = await onAccount("GET", store.stripeAccountId, `/payment_intents/${encodeURIComponent(reference)}?expand[]=latest_charge`);
  return refundedInFull(pi);
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
    if (record.state === "pending") notes.push({ state: record.pi ? "unconfirmed" : "checking", title });
    if (record.state === "failed") notes.push({ state: "declined", title });
    if (record.state === "declined" || record.state === "failed") declined.push(record.product);
  }

  // The funnel and what it names are read only when an offer could follow.
  const open = input.eligible && !store.tax.enabled && offerOpen(input.created, input.secret, input.upsellKey ?? undefined);
  const owner = input.cart ? input.cart.offerFrom : product.id;
  const full = open && owner ? await readProduct(store, owner) : null;
  const offered = full ? await offerableAfterPaying(store, await readListings(store, funnelProductIds(full.funnel))) : [];
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
  const pictured = step.imageFrom ? offered.find((p) => p.id === step.imageFrom) ?? null : null;
  const afterNo = funnel.steps.some((s) => s.no === step.id && records.get(stepSlot(funnel, s))?.state === "declined");
  return {
    offer: {
      step,
      target,
      image: pictured?.image ?? null,
      afterNo,
    },
    taken,
    notes,
    declined,
  };
}
