/**
 * Hands over what a PayPal payment bought (lib/paypal-sales.ts) with the same
 * pieces a Stripe sale uses: the store's sender and address, the course
 * dated from the payment, and a signed link to the list of purchases. And,
 * as for a Stripe sale (added 13 October 2026), the affiliate and partners
 * credited, and the store's webhooks told: "sale.completed" with
 * `paid_with: "paypal"`, and "refund.issued" when PayPal refunds it in full.
 */
import { createHmac } from "node:crypto";
import { ordersLinkWithToken } from "@/lib/buyer-orders";
import { type Listing, readListing, readListings } from "@/lib/catalog";
import { dropEnrollment, recordEnrollment } from "@/lib/learn";
import { type Paid, type PayPalReceipt, deliverPayPal, handOverKey, readPaidExact, refundSeen, watchPayPal } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { type Store, ensureListId, storeRef } from "@/lib/store";
import { creditPayPalSale } from "@/lib/affiliates";
import { emitEvent } from "@/lib/webhooks";
import { deriveKey } from "@/lib/secret-box";
import { createHash } from "node:crypto";
import { noteForErasure } from "@/lib/erasure-index";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";

/**
 * Where lib/email.ts keeps the sender of a key's email (its pinKey), written just before the first request made under
 * the key, so finding it means a request may have been made. Spelled here because lib/email.ts is reserved by another
 * unit; tests/paypal-receipt-once.test.ts holds the two spellings equal through a real pinned send.
 */
export const pinnedSenderKey = (key: string) =>
  `nl:mail:pin:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

/**
 * Paid PayPal orders still owed their hand-over (handOverKey in lib/paypal-sales.ts): settle puts each one there with
 * the writes that take it off pending, before anything is handed over, and handOverPayPal takes it out once it is
 * handed over (Claude 5's MEDIUM on #2909). The sweep tries again (handOverAgain) those whose score is
 * HAND_OVER_GRACE_SECONDS old, so it does not hand over an order whose return is handing it over at that moment.
 */
const HAND_OVER_GRACE_SECONDS = 600;
/** How many of them one sweep of a store tries (NOT_A_COST.HAND_OVER_BATCH and PAYPAL_HAND_OVER_RETRY in tests/plan-cost-registry.ts). */
export const HAND_OVER_BATCH = 25;
/** The score of an order to be tried at the next sweep: due now, behind those due before it. */
const dueNow = () => String(Math.floor(Date.now() / 1000) - HAND_OVER_GRACE_SECONDS);
/**
 * How long after its first try a receipt the sender did not accept is tried again (audit R48, finding 4): 22 hours.
 * Every key a try leaves is made at the first try or after it and kept a day (Resend's idempotency key; lib/email.ts
 * viaAmazon's once-mark and the sender kept by sendEmailPinned, each EX 86400), and no try is sent once the window is
 * over (checked before sending, receiptMayGo), so every try falls under those keys: a receipt whose answer was lost is
 * never sent a second time. Past it, the order leaves the list without its receipt.
 */
export const RECEIPT_RETRY_SECONDS = 22 * 3600;
/**
 * How long the time of a receipt's first try is kept (receiptTryKey): a week. No receipt is sent once the payment is
 * that old, so a mark that may have expired is never read as "not tried yet".
 */
export const RECEIPT_MARK_SECONDS = 7 * 86_400;
const receiptTryKey = (order: string) => `nl:ppsell:receipt:${order}`;
/**
 * When such a receipt is due again: after a wait as long as its first try is old, at least one five-minute run and at
 * most four hours, and never after the window's end. A refusal that lasts is tried at most RECEIPT_TRIES_AT_MOST
 * times in the window, never every run (each try runs the hand-over again, whose writes find themselves already there).
 */
function receiptDue(firstAt: number, now: number): number {
  return Math.min(now + Math.min(Math.max(now - firstAt, 300), 4 * 3600), firstAt + RECEIPT_RETRY_SECONDS);
}
/** The most tries receiptDue allows in the window, the first one included (PAYPAL_HAND_OVER_RETRY in tests/plan-cost-registry.ts). */
export const RECEIPT_TRIES_AT_MOST = (() => {
  let tries = 0;
  for (let at = 0; at < RECEIPT_RETRY_SECONDS; at = receiptDue(0, at)) tries += 1;
  return tries;
})();

/**
 * Whether a receipt may be sent now, before anything of it is: the time of its first try, kept on its first ask (SET NX,
 * read back by the same pipeline's GET), and no for a try at or past RECEIPT_RETRY_SECONDS after it, or for a payment
 * RECEIPT_MARK_SECONDS old. Throws UnknownReplyError when a reply is not exactly what those commands answer (CX-123
 * rule 24): nothing is sent, and the order stays on the list.
 */
async function receiptMayGo(paid: Paid, now: number): Promise<{ go: boolean; firstAt: number }> {
  if (now >= paid.at + RECEIPT_MARK_SECONDS) return { go: false, firstAt: paid.at };
  const key = receiptTryKey(paid.order);
  const replies = repliesFor(await redisPipeline([["SET", key, String(now), "NX", "EX", RECEIPT_MARK_SECONDS], ["GET", key]]), 2);
  const kept = replies?.[1];
  if (!replies || (replies[0] !== "OK" && replies[0] !== null) || typeof kept !== "string" || !/^[0-9]{1,12}$/.test(kept)) {
    throw new UnknownReplyError("a PayPal receipt's first try");
  }
  const firstAt = Number(kept);
  if (replies[0] === "OK" && firstAt !== now) throw new UnknownReplyError("a PayPal receipt's first try");
  return { go: now < firstAt + RECEIPT_RETRY_SECONDS, firstAt };
}

/**
 * The purchases link of an order's receipt, the same on every try so the receipt is the same email each time: its
 * token made from the order with a key derived for it from the deployment's root secret (lib/secret-box.ts), kept
 * nowhere, its grant written again each try. Null (the generic orders link, the same each time too) without that
 * secret or Redis. Throws UnknownReplyError when the grant's write is not confirmed, so nothing is sent with it.
 */
async function receiptLink(store: Store, email: string, base: string, order: string): Promise<string | null> {
  const secret = deriveKey("paypal-receipt-link");
  if (!secret || !isRedisConfigured()) return null;
  const token = createHmac("sha256", secret).update(`nimbus-paypal-receipt:${order}`).digest("hex");
  const link = await ordersLinkWithToken(store, email, base, token);
  if (!link) throw new UnknownReplyError("a PayPal receipt's purchases link");
  return link;
}

/**
 * How long a receipt is kept as first made (receiptMailKey): a day, as long as the sender kept for its key
 * (lib/email.ts PINNED_SENDER_SECONDS). It is written at or after the receipt's first try, so it outlasts every try
 * (none past RECEIPT_RETRY_SECONDS after the first, receiptMayGo).
 */
export const RECEIPT_MAIL_SECONDS = 86_400;
/**
 * The most a kept receipt weighs, in bytes (nl:ppsell:mail: in tests/store-data-registry.ts): the fixed words of a
 * receipt in the store's language, the store's name and the product's title at their longest (MAX_NAME_LENGTH,
 * MAX_TITLE_LENGTH), the confirmation of the buyer's yes, both addresses and three links come to well under half of
 * it. One that weighs more is never kept, so it is never sent: no receipt is sent that was not kept first.
 */
export const RECEIPT_MAIL_BYTES = 8 * 1024;
const receiptMailKey = (order: string) => `nl:ppsell:mail:${order}`;
const RECEIPT_FIELDS = ["from", "to", "subject", "text", "replyTo", "idempotencyKey"];

/**
 * A kept receipt read back, only in the exact shape JSON.stringify gives a PayPalReceipt, and only for the receipt
 * just made (the same buyer, the same key). Throws UnknownReplyError otherwise (CX-123 rule 24): nothing is sent,
 * and the receipt is never made again in its place.
 */
function keptReceipt(raw: string, made: PayPalReceipt): PayPalReceipt {
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not JSON: the same as any other shape below.
  }
  const v = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const text = (name: string) => v !== null && Object.hasOwn(v, name) && typeof v[name] === "string";
  if (
    !v || Object.keys(v).some((name) => !RECEIPT_FIELDS.includes(name)) ||
    !["from", "to", "subject", "text", "idempotencyKey"].every(text) || (Object.hasOwn(v, "replyTo") && !text("replyTo")) ||
    v.to !== made.to || v.idempotencyKey !== made.idempotencyKey
  ) {
    throw new UnknownReplyError("a PayPal receipt kept as first made");
  }
  const { from, to, subject, text: body, replyTo, idempotencyKey } = v as PayPalReceipt;
  return { from, to, subject, text: body, ...(Object.hasOwn(v, "replyTo") ? { replyTo } : {}), idempotencyKey };
}

/**
 * Keeps a receipt as first made, noted for the person's deletion, in one step, unless the person was deleted from the
 * store at or after the payment (lib/suppression.ts: erasePerson writes their print before it deletes anything, and
 * the print is kept): a deletion that ran between the receipt being made and kept finds the note and deletes the
 * receipt, or the receipt is never kept. A person deleted before they paid again is sent the new receipt.
 * KEYS[1] the receipt, KEYS[2] the store's prints of deleted people, KEYS[3] the person's erasure notes
 * (lib/erasure-index.ts); ARGV[1] the receipt, ARGV[2] its seconds, ARGV[3] the person's print, ARGV[4] when it was
 * paid (seconds), ARGV[5..7] the note's score, the oldest score kept and the notes' seconds (noteForErasure).
 * Answers 0 when the person was deleted (nothing written), else {1 when this SET kept it or 0, the receipt kept};
 * lib/redis-memory.ts runs it the same way.
 */
export const KEEP_RECEIPT = `-- marktmorgen:paypal-receipt-keep:v1
local erased = redis.call("HGET", KEYS[2], ARGV[3])
if erased then
  local at = tonumber(erased)
  if not at or at >= tonumber(ARGV[4]) then return 0 end
end
redis.call("ZADD", KEYS[3], ARGV[5], KEYS[1])
redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", ARGV[6])
redis.call("EXPIRE", KEYS[3], ARGV[7])
local written = redis.call("SET", KEYS[1], ARGV[1], "NX", "EX", ARGV[2])
return {written and 1 or 0, redis.call("GET", KEYS[1])}`;

/**
 * The receipt an order's every try sends: the one kept from its first try, word for word, so a sender asked again is
 * given the same bytes under the same key (the guarded Resend transport's attempt is its path, body and key; other
 * words would be another attempt and another request after an answer that was not known; second money review of
 * #3387). A product or store edited between tries changes nothing that is sent.
 *
 * - Kept: that one, read in its exact shape (keptReceipt).
 * - None kept and no sender kept for its key (pinnedSenderKey, written by lib/email.ts just before the first request):
 *   no request was ever made under the key, so the receipt just made is kept, noted for the person's deletion
 *   (lib/erasure-index.ts), in one step that refuses it when the person was deleted at or after the payment
 *   (KEEP_RECEIPT): "erased", and nothing is sent. Otherwise what is kept is sent. A store from before lists is given
 *   its list first (ensureListId, as an erasure does), so the deletion is always checked where it is written.
 * - None kept but a sender kept: a request was made with words now gone (deleted with the person, or lost). Null:
 *   nothing is sent with other words, and the order waits out its window (RECEIPT_RETRY_SECONDS).
 *
 * Throws UnknownReplyError when a reply is not exactly what its command answers: nothing is sent, the order stays.
 */
async function sameReceipt(store: Store, paid: Paid, made: PayPalReceipt): Promise<PayPalReceipt | "erased" | null> {
  if (!isRedisConfigured()) return made;
  const key = receiptMailKey(paid.order);
  const seen = repliesFor(await redisPipeline([["GET", key], ["GET", pinnedSenderKey(made.idempotencyKey)]]), 2);
  if (!seen || (seen[0] !== null && typeof seen[0] !== "string") || (seen[1] !== null && seen[1] !== "ses" && seen[1] !== "resend")) {
    throw new UnknownReplyError("a PayPal receipt kept as first made");
  }
  if (typeof seen[0] === "string") return keptReceipt(seen[0], made);
  if (seen[1] !== null) {
    console.error("a PayPal purchase's receipt is no longer kept, though a request was made under its key; not sent in other words", paid.order);
    return null;
  }
  const value = JSON.stringify(made);
  if (Buffer.byteLength(value) > RECEIPT_MAIL_BYTES) throw new Error("a PayPal receipt weighs more than RECEIPT_MAIL_BYTES; not kept, so not sent");
  const listId = store.listId ?? (await ensureListId(storeRef(store)))?.listId ?? null;
  if (!listId) throw new UnknownReplyError("the store's list, to check a deletion where a PayPal receipt is kept");
  const [add, trim, expire] = noteForErasure(store.statsId, made.to, key);
  if (add?.[0] !== "ZADD" || trim?.[0] !== "ZREMRANGEBYSCORE" || expire?.[0] !== "EXPIRE" || add[1] !== trim[1] || add[1] !== expire[1]) {
    throw new Error("a PayPal receipt could not be noted for the person's deletion; not kept, so not sent");
  }
  const replies = repliesFor(await redisPipeline([[
    "EVAL", KEEP_RECEIPT, 3, key, suppressedKey(listId), add[1],
    value, RECEIPT_MAIL_SECONDS, suppressionPrint(listId, made.to), paid.at, add[2], trim[3], expire[2],
  ]]), 1);
  const reply = replies?.[0];
  if (reply === 0) return "erased";
  const [written, kept] = Array.isArray(reply) && reply.length === 2 ? reply : [];
  if ((written !== 1 && written !== 0) || typeof kept !== "string" || (written === 1 && kept !== value)) {
    throw new UnknownReplyError("a PayPal receipt kept as first made");
  }
  return keptReceipt(kept, made);
}

/** Takes a handed-over order out of the list. Not known whether it left: it stays, and the next try finds it handed over. */
async function handedOver(statsId: string, order: string): Promise<void> {
  await redisPipeline([["ZREM", handOverKey(statsId), order]]).catch((error) => console.error("taking a handed-over PayPal order out of the list failed", order, error));
}

/**
 * Gives the buyer what they paid for and emails the receipt. False when the product is gone (Redis answered that
 * its record is not there). Everything it hands over is read first, a bundle's products too; a read that is
 * unknown throws before anything is handed over, and the order is kept for the sweep to hand over, never taken
 * for a product that is gone. Handed over but its receipt not accepted by the sender (refused, unknown or thrown):
 * the order stays on the list, due again at receiptDue, until RECEIPT_RETRY_SECONDS after its first try; the
 * hand-over runs again then, and every step but the receipt finds itself already written (HSETNX, SET NX). The
 * receipt is the same email each try (receiptLink), goes only through the sender of its first request
 * (sendEmailPinned) and is never sent once its window is over (receiptMayGo).
 */
export async function handOverPayPal(store: Store, paid: Paid): Promise<boolean> {
  return (await handOver(store, paid)) !== "gone";
}

/** handOverPayPal, saying whether the order left the list handed over, its product gone, or its receipt still owed. */
async function handOver(store: Store, paid: Paid): Promise<"handed" | "gone" | "receipt owed"> {
  let product: Listing | null;
  let bundled: Map<string, Listing>;
  try {
    product = await readListing(store, paid.product);
    bundled = new Map(product?.bundle?.length ? (await readListings(store, product.bundle)).map((listing) => [listing.id, listing]) : []);
  } catch (error) {
    // Already in the list since it was written down (settle): this only makes it due at the next sweep (XX: one a
    // concurrent run took out is not put back), and the read's own error is the one thrown, whatever this answers.
    if (store.statsId && isRedisConfigured()) await redisPipeline([["ZADD", handOverKey(store.statsId), "XX", dueNow(), paid.order]]).catch(() => undefined);
    throw error;
  }
  if (!product) {
    console.error("a PayPal purchase named a product the store no longer has", store.handle, paid.order);
    if (store.statsId) await handedOver(store.statsId, paid.order);
    return "gone";
  }
  const base = storeBase(store);
  // What receiptMayGo answered, when the receipt was asked about (not when the hand-over stopped before it), and
  // whether the receipt was refused because its person was deleted from the store at or after the payment.
  const asked: { window: { go: boolean; firstAt: number } | null; erased: boolean } = { window: null, erased: false };
  const receipted = await deliverPayPal({
    store,
    paid,
    product,
    base,
    from: fromStore(store),
    recordStart: async (email, productId, start) => {
      const course = productId === product.id ? product : bundled.get(productId);
      if (course?.course) await recordEnrollment(store, email, productId, start);
    },
    ordersLink: (email) => receiptLink(store, email, base, paid.order),
    mayEmail: async () => {
      if (!isRedisConfigured()) return true;
      asked.window = await receiptMayGo(paid, Math.floor(Date.now() / 1000));
      return asked.window.go;
    },
    // deliverPayPal makes no receipt without a stats id; with none, nothing could be noted for deletion, and none is kept.
    keep: async (receipt) => {
      const kept = await sameReceipt(store, paid, receipt);
      if (kept !== "erased") return kept;
      asked.erased = true;
      return null;
    },
  });
  await creditPayPalSale(store, paid, product.title).catch((error) => console.error("crediting a PayPal sale failed", error));
  await emitEvent(store, "sale.completed", `paypal:${paid.order}`, {
    paypal_order: paid.order,
    paypal_capture: paid.capture,
    paid_with: "paypal",
    kind: "one_time",
    product: { id: product.id, title: product.title },
    bundle_items: product.bundle?.length ? product.bundle.map((id) => ({ id, title: null })) : null,
    amount_cents: paid.cents,
    discount_cents: paid.off ?? 0,
    currency: paid.currency,
    buyer: { email: paid.email, name: null },
    channel: paid.meta?.channel ?? null,
    paid_at: new Date(paid.at * 1000).toISOString(),
  }, paid.at * 1000).catch((error) => console.error("telling the webhooks of a PayPal sale failed", error));
  if (!store.statsId) return "handed";
  const window = asked.window;
  if (receipted || !window?.go || asked.erased) {
    if (asked.erased) console.error("a PayPal purchase's person was deleted from the store; its receipt is not kept or sent, and not tried again", store.handle, paid.order);
    else if (!receipted) console.error("a PayPal purchase's receipt was not accepted within its retry window; no longer tried", store.handle, paid.order);
    await handedOver(store.statsId, paid.order);
  } else {
    // Still in the list since settle wrote it: this only sets when it is due again (receiptDue; the list's score is
    // the due time less the grace handOverAgain waits). XX: one a concurrent run took out is not put back. A ZADD that
    // fails leaves it due as it was; its next try is still held to the window (receiptMayGo).
    console.error("a PayPal purchase's receipt was not accepted; tried again later", store.handle, paid.order);
    const due = receiptDue(window.firstAt, Math.floor(Date.now() / 1000)) - HAND_OVER_GRACE_SECONDS;
    await redisPipeline([["ZADD", handOverKey(store.statsId), "XX", String(due), paid.order]]).catch(() => undefined);
    return "receipt owed";
  }
  return "handed";
}

/**
 * Tries again the orders still owed their hand-over, oldest try first, a few a sweep, once their grace is over. One
 * handed over, whose product Redis answers is gone, or that PayPal refunded in full meanwhile, leaves the list; one
 * whose paid record Redis answers is not there any more (erased, or past its time) leaves it too, with nothing to hand
 * over; one whose paid record, refund mark or product does not read, or reads in another shape, is kept and tried
 * again at the next sweep (Claude 6's MEDIUM on #2909: unknown is never "no paid record"). The list itself read in
 * another shape throws UnknownReplyError. Returns how many were handed over.
 */
async function handOverAgain(store: Store, deadline: number): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const key = handOverKey(store.statsId);
  const read = repliesFor(await redisPipeline([["ZRANGEBYSCORE", key, "-inf", dueNow(), "LIMIT", 0, HAND_OVER_BATCH]]), 1);
  const orders = read ? stringList(read[0]) : null;
  if (!orders) throw new UnknownReplyError("the PayPal orders waiting to be handed over");
  let handed = 0;
  for (const order of orders) {
    if (Date.now() >= deadline) break;
    try {
      const paid = await readPaidExact(order);
      if (paid === "unknown") throw new UnknownReplyError("a PayPal order's paid record");
      if (paid === null) {
        console.error("a PayPal order waiting to be handed over has no paid record any more", store.handle, order);
        await redisPipeline([["ZREM", key, order]]);
        continue;
      }
      // Refunded in full meanwhile (the refund watch saw it before anything was granted, and looks at it no more):
      // never handed over, it leaves the list. Unknown throws below and it is kept (Claude 5's MEDIUM on #2909). A
      // refund seen after a hand-over is taken back by the watch, as for any other order. One ZSCORE an order tried.
      if (await refundSeen(store.statsId, order)) {
        console.error("a PayPal order waiting to be handed over was refunded in full; nothing handed over", store.handle, order);
        await redisPipeline([["ZREM", key, order]]);
        continue;
      }
      // Handed over with its receipt accepted, or its product gone: handOver takes it out of the list. Its receipt
      // not accepted: kept and tried again later, inside RECEIPT_RETRY_SECONDS, and not counted as handed over yet.
      if ((await handOver(store, paid)) === "handed") handed += 1;
    } catch (error) {
      // Still unknown: kept, moved behind the others, tried at the next sweep (XX: one a concurrent run took out is not
      // put back). A receipt is still sent only inside its window (receiptMayGo), whenever it is tried.
      console.error("handing over a PayPal purchase again failed; tried again at the next sweep", store.handle, order, error);
      await redisPipeline([["ZADD", key, "XX", dueNow(), order]]).catch(() => undefined);
    }
  }
  return handed;
}

/**
 * The checkout sweep's PayPal part for one store: pending payments cleared, refunds taken back, and paid orders
 * whose product could not be read handed over (counted as cleared).
 */
export async function sweepPayPal(store: Store, deadline: number): Promise<{ cleared: number; revoked: number }> {
  const done = await watchPayPal(store, deadline, {
    handOver: async (paid) => {
      await handOverPayPal(store, paid);
    },
    dropStart: (email, productId) => dropEnrollment(store, email, productId),
    // A course put back for a payment that keeps the purchase (Codex G's M1 on #2791): HSETNX, so nothing for one
    // still there, and no email; only for a product that is a course, as handing over does.
    restoreStart: async (email, productId, start) => {
      const course = await readListing(store, productId);
      if (course?.course) await recordEnrollment(store, email, productId, start);
    },
    refunded: async (paid) => {
      const product = await readListing(store, paid.product).catch(() => null);
      await emitEvent(store, "refund.issued", `paypal:${paid.capture}`, {
        paypal_capture: paid.capture,
        paid_with: "paypal",
        product: { id: paid.product, title: product?.title ?? null },
        amount_refunded_cents: paid.cents,
        total_refunded_cents: paid.cents,
        amount_cents: paid.cents,
        fully_refunded: true,
        currency: paid.currency,
        buyer: { email: paid.email, name: null },
        refunded_at: new Date().toISOString(),
      });
    },
  });
  done.cleared += await handOverAgain(store, deadline);
  return done;
}
