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
import { importedKey } from "@/lib/imported-purchases";
import { forgetBoughtCommands } from "@/lib/buyer-library";
import { bondPlace, forgetBondCommand } from "@/lib/affiliate-bond";
import { PAYPAL_OPEN_ORDER_SECONDS, type Paid, type PayPalReceipt, deliverPayPal, handOverKey, paypalOrdersLeft, paypalPastWatched, readPaidExact, refundSeen, retryCancelNotices, watchPayPal } from "@/lib/paypal-sales";
import { tellCanceled } from "@/lib/paypal-cancel";
import { storeForHandleExactly } from "@/lib/store-exact";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor, stringList } from "@/lib/redis-reply";
import { fromStore, storeBase } from "@/lib/purchase-email";
import { type Store, ensureListId, forgetPayPalPast, storeRef } from "@/lib/store";
import { creditPayPalSale } from "@/lib/affiliates";
import { emitEvent } from "@/lib/webhooks";
import { deriveKey } from "@/lib/secret-box";
import { createHash } from "node:crypto";
import { noteForErasure } from "@/lib/erasure-index";
import { ownErasureField, suppressedKey, suppressionPrint } from "@/lib/suppression";
import { countOrder } from "@/lib/orders";

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

/** What follows the first try's time on receiptTryKey once the receipt was accepted and the order kept only for its webhook event. */
const SENT_SUFFIX = ":sent";

/**
 * Whether a receipt may be sent now, before anything of it is: the time of its first try, kept on its first ask (SET NX,
 * read back by the same pipeline's GET), and no for a try at or past RECEIPT_RETRY_SECONDS after it, or for a payment
 * RECEIPT_MARK_SECONDS old. `sent` when an earlier try's receipt was accepted and the order stayed on the list only for
 * its webhook event (markReceiptSent): no receipt is sent again. Throws UnknownReplyError when a reply is not exactly
 * what those commands answer (CX-123 rule 24): nothing is sent, and the order stays on the list.
 */
async function receiptMayGo(paid: Paid, now: number): Promise<{ go: boolean; firstAt: number; sent: boolean }> {
  if (now >= paid.at + RECEIPT_MARK_SECONDS) return { go: false, firstAt: paid.at, sent: false };
  const key = receiptTryKey(paid.order);
  const replies = repliesFor(await redisPipeline([["SET", key, String(now), "NX", "EX", RECEIPT_MARK_SECONDS], ["GET", key]]), 2);
  const kept = replies?.[1];
  const read = typeof kept === "string" ? /^([0-9]{1,12})(:sent)?$/.exec(kept) : null;
  if (!replies || (replies[0] !== "OK" && replies[0] !== null) || !read) {
    throw new UnknownReplyError("a PayPal receipt's first try");
  }
  const firstAt = Number(read[1]);
  if (replies[0] === "OK" && kept !== String(now)) throw new UnknownReplyError("a PayPal receipt's first try");
  return { go: now < firstAt + RECEIPT_RETRY_SECONDS, firstAt, sent: read[2] === SENT_SUFFIX };
}

/**
 * Notes on receiptTryKey that the order's receipt was accepted, when the order stays on the list only because its
 * webhook event is still owed (issue #3937), so its next try sends no receipt again (receiptMayGo). XX: a mark gone is
 * never made again; never kept past RECEIPT_MARK_SECONDS after the payment. A write that fails or is not confirmed only
 * means the next try asks the sender again, under the same idempotency key and the one sender kept for it.
 */
async function markReceiptSent(paid: Paid, firstAt: number, now: number): Promise<void> {
  const seconds = paid.at + RECEIPT_MARK_SECONDS - now;
  if (seconds <= 0) return;
  const replies = await redisPipeline([["SET", receiptTryKey(paid.order), `${firstAt}${SENT_SUFFIX}`, "XX", "EX", seconds]]).catch(() => null);
  if (!Array.isArray(replies) || replies[0] !== "OK") {
    console.error("a PayPal receipt accepted could not be noted as sent; its next try asks the sender again under the same key", paid.order);
  }
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
 * The store's list id, where the prints of its deleted people are kept (lib/suppression.ts). A store from before lists
 * is given its list first (ensureListId, as an erasure does), so a deletion is always checked where it is written.
 * Throws UnknownReplyError when the store does not read: nothing of the order is handed over, and it stays owed.
 */
async function deletionListId(store: Store): Promise<string> {
  const listId = store.listId ?? (await ensureListId(storeRef(store)))?.listId ?? null;
  if (!listId) throw new UnknownReplyError("the store's list, to check a deletion before a PayPal hand-over");
  return listId;
}

/**
 * Whether the person was deleted from the store at or after the payment: the same print and the same rule as
 * KEEP_RECEIPT (erasePerson writes the print before it deletes anything, and it is kept). With `own`, only a deletion
 * the person asked for themselves (lib/suppression.ts ownErasureField, written beside the print): a team's deletion
 * keeps their purchases, so an order still owed is handed over (second review of #3449, finding 1). False when there
 * is none, or when they were deleted before they paid again. One HGET, read exactly (CX-123 rule 24): nothing, or a
 * time in seconds; any other reply throws UnknownReplyError, so nothing of them is written and the order stays owed.
 */
async function erasedSincePaid(listId: string, paid: Paid, own = false): Promise<boolean> {
  const field = own ? ownErasureField(listId, paid.email) : suppressionPrint(listId, paid.email);
  const replies = repliesFor(await redisPipeline([["HGET", suppressedKey(listId), field]]), 1);
  const mark = replies?.[0];
  if (!replies || (mark !== null && (typeof mark !== "string" || !/^[0-9]{1,12}$/.test(mark)))) {
    throw new UnknownReplyError("a person's deletion mark, before a PayPal hand-over");
  }
  return mark !== null && Number(mark) >= paid.at;
}

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
 *   (KEEP_RECEIPT): "erased", and nothing is sent. Otherwise what is kept is sent. `listId` is the store's
 *   (deletionListId), given its list before the hand-over.
 * - None kept but a sender kept: a request was made with words now gone (deleted with the person, or lost). Their
 *   print read after the receipt was found gone (erasedSincePaid; erasePerson writes it before deleting the receipt):
 *   deleted at or after the payment, "erased", and the order leaves the list; otherwise null: nothing is sent with
 *   other words, and the order waits out its window (RECEIPT_RETRY_SECONDS).
 *
 * Throws UnknownReplyError when a reply is not exactly what its command answers: nothing is sent, the order stays.
 */
async function sameReceipt(store: Store, paid: Paid, made: PayPalReceipt, listId: string | null): Promise<PayPalReceipt | "erased" | null> {
  if (!isRedisConfigured()) return made;
  if (!listId) throw new UnknownReplyError("the store's list, to check a deletion where a PayPal receipt is kept");
  const key = receiptMailKey(paid.order);
  const seen = repliesFor(await redisPipeline([["GET", key], ["GET", pinnedSenderKey(made.idempotencyKey)]]), 2);
  if (!seen || (seen[0] !== null && typeof seen[0] !== "string") || (seen[1] !== null && seen[1] !== "ses" && seen[1] !== "resend")) {
    throw new UnknownReplyError("a PayPal receipt kept as first made");
  }
  if (typeof seen[0] === "string") return keptReceipt(seen[0], made);
  if (seen[1] !== null) {
    if (await erasedSincePaid(listId, paid)) return "erased";
    console.error("a PayPal purchase's receipt is no longer kept, though a request was made under its key; not sent in other words", paid.order);
    return null;
  }
  const value = JSON.stringify(made);
  if (Buffer.byteLength(value) > RECEIPT_MAIL_BYTES) throw new Error("a PayPal receipt weighs more than RECEIPT_MAIL_BYTES; not kept, so not sent");
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

/**
 * Takes back, in one step, what a hand-over wrote of a person deleted at their own request, bound to the purchase it
 * read (Codex C2 on #3449): only while the purchase is still exactly the record read (KEYS[1] field ARGV[1] equal to
 * ARGV[2]); otherwise -1 and nothing is touched, so a purchase they made after the read, and the store in their
 * library and the bond that go with it, are kept. The store leaves their library (KEYS[3..], SREM ARGV[5]) only while
 * this purchase is their only one here; the bond (KEYS[2] field ARGV[3]) only while it names this order's affiliate
 * (ARGV[4]); the purchase last. 1 when the purchase was deleted.
 */
export const TAKE_BACK_OWN = `-- marktmorgen:paypal-take-back:v1
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return -1 end
if ARGV[5] ~= "" and redis.call("HLEN", KEYS[1]) == 1 then
  for i = 3, #KEYS do redis.call("SREM", KEYS[i], ARGV[5]) end
end
if ARGV[3] ~= "" and redis.call("HGET", KEYS[2], ARGV[3]) == ARGV[4] then redis.call("HDEL", KEYS[2], ARGV[3]) end
return redis.call("HDEL", KEYS[1], ARGV[1])`;

/** The job a purchase's record names (lib/imported-purchases.ts grantImported), or null when it does not read so. */
function grantJob(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    const job = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).job : null;
    return typeof job === "string" ? job : null;
  } catch {
    return null;
  }
}

/**
 * Takes back what a hand-over of this order wrote of a person deleted at their own request at or after the payment
 * (second review of #3449, finding 3): a deletion that completed during a try, after its check, deleted what was
 * there before the try's writes, not those writes. Only when their purchase of the product is this order's (its job
 * `paypal:<order>`), so a purchase they made after their deletion, and what goes with it, is kept: the courses of the
 * order taken off their ledger (dropEnrollment), the store out of the stores they bought from when this was their
 * only purchase here, the bond to the order's affiliate, and the purchase itself last, so a try stopped part way finds
 * it and takes back the rest. The last three are one step bound to the purchase read (TAKE_BACK_OWN, Codex C2 on
 * #3449): a purchase the deletion took and one they made after it, both after the read, are never taken for this one;
 * then nothing is taken back in that try, and the order stays owed for the next, which reads again.
 *
 * The purchase already gone (review of #3449, MEDIUM 1): the deletion's erasers run one after another, and one that ran
 * before a write of this order left that write; the purchases' eraser runs after the courses' and the bonds', so a
 * deletion that took the purchase can leave the course and the bond written after it. They are taken back all the
 * same, each only as this order wrote it: the course only while it began at this payment (recordEnrollment's start),
 * the bond only while it names this order's affiliate, so one a later sale wrote with another affiliate, or a course a
 * later order began, is kept. The store in their library is written before the purchase and deleted after it, so it is
 * not touched then, nor is a purchase. A bond holds only the affiliate: one a later sale wrote to this same affiliate
 * reads as this order's and is taken back too; the person's next sale credited to them writes it again.
 *
 * Every reply read exactly (CX-123 rule 24): otherwise UnknownReplyError, and the order stays owed, tried again at the
 * next sweep, which takes back what is left. The link's grant is not: it expires in a day (ORDERS_LINK_SECONDS), as
 * one the deletion found does.
 */
async function takeBack(store: Store, paid: Paid, product: Listing, bundled: Map<string, Listing>): Promise<void> {
  const statsId = store.statsId as string;
  const key = importedKey(statsId, paid.email);
  const read = repliesFor(await redisPipeline([["HGET", key, product.id], ["HLEN", key]]), 2);
  const [raw, count] = read ?? [];
  if (!read || (raw !== null && typeof raw !== "string") || typeof count !== "number" || !Number.isSafeInteger(count) || count < (raw === null ? 0 : 1)) {
    throw new UnknownReplyError("a deleted person's purchase, to take back what a PayPal hand-over wrote");
  }
  if (raw !== null) {
    const job = grantJob(raw);
    if (job === null) throw new UnknownReplyError("a deleted person's purchase, to take back what a PayPal hand-over wrote");
    if (job !== `paypal:${paid.order}`) return;
  }
  for (const id of [product.id, ...(product.bundle ?? [])]) {
    if ((id === product.id ? product : bundled.get(id))?.course) await dropEnrollment(store, paid.email, id, paid.at);
  }
  if (raw === null) {
    // The purchase already gone: only the bond to this order's affiliate (the course is above); no library, no purchase.
    if (!paid.via) return;
    const replies = repliesFor(await redisPipeline([forgetBondCommand(statsId, paid.email, paid.via.aff)]), 1);
    if (!replies || (replies[0] !== 0 && replies[0] !== 1)) throw new UnknownReplyError("taking back what a PayPal hand-over wrote of a deleted person");
    return;
  }
  // This order's purchase read: the library, the bond and the purchase taken back together, and only while the
  // purchase is still the record read (TAKE_BACK_OWN). One written after the read is kept, and so is what goes with it.
  const library = forgetBoughtCommands(store.sid, paid.email).map((command) => String(command[1]));
  const bond = paid.via ? bondPlace(statsId, paid.email) : null;
  const replies = repliesFor(await redisPipeline([[
    "EVAL", TAKE_BACK_OWN, 2 + library.length, key, bond ? bond.key : key, ...library,
    product.id, raw, bond ? bond.field : "", paid.via ? paid.via.aff : "", library.length ? store.sid : "",
  ]]), 1);
  const reply = replies?.[0];
  if (reply === -1) {
    // Not taken back now: the purchase is no longer the one read. The order stays owed; the next try reads it again.
    throw new Error("a deleted person's purchase changed after the take-back read it; nothing taken back in this try");
  }
  if (reply !== 0 && reply !== 1) throw new UnknownReplyError("taking back what a PayPal hand-over wrote of a deleted person");
}

/** Takes a handed-over order out of the list. Not known whether it left: it stays, and the next try finds it handed over. */
async function handedOver(statsId: string, order: string): Promise<void> {
  await redisPipeline([["ZREM", handOverKey(statsId), order]]).catch((error) => console.error("taking a handed-over PayPal order out of the list failed", order, error));
}

/**
 * A PayPal sale whose affiliate or partner credit failed after it was handed over (an unknown read of the affiliate,
 * rule 24, or Redis trouble): kept in the same list as `credit:<order>`, so the sweep credits it again from the paid
 * record (creditAgain), never by handing the order over or emailing the buyer twice. Its own read is the one the list
 * already costs a sweep. Best effort, as the hand-over's own retry mark is.
 */
const CREDIT_PREFIX = "credit:";
async function oweCredit(store: Store, order: string, error: unknown): Promise<void> {
  console.error("crediting a PayPal sale failed; credited again at the next sweep", order, error);
  if (store.statsId && isRedisConfigured()) await redisPipeline([["ZADD", handOverKey(store.statsId), dueNow(), `${CREDIT_PREFIX}${order}`]]).catch(() => undefined);
}

/** Credits again a sale kept by oweCredit; true once it is credited or there is nothing left to credit. Throws while unknown. */
async function creditAgain(store: Store, order: string): Promise<boolean> {
  const paid = await readPaidExact(order);
  if (paid === "unknown") throw new UnknownReplyError("a PayPal order's paid record");
  // Erased, or past its time: nothing left to credit from.
  if (paid === null) return true;
  // The person deleted from the store at their own request since paying: credited for the sale paid, with nothing that
  // names them (no bond), as the hand-over does (Claude 1 cloud, MEDIUM on #3858). An unknown mark throws: the credit
  // stays owed for the next sweep, never made on a guess (rule 24).
  const listId = await deletionListId(store);
  const erased = await erasedSincePaid(listId, paid, true);
  const product = await readListing(store, paid.product);
  await creditPayPalSale(store, paid, product?.title ?? "", !erased);
  // Read once more after the bond, as the hand-over does (Claude 6, MEDIUM on #3858): a deletion that wrote its mark
  // between the read above and the bond did not see that bond, so it is taken back here. Also when the first read said
  // erased, so a bond an earlier try wrote before stopping is taken back too. One HGET a try; the forget's reply is
  // read exactly, and anything but 0 or 1 throws, so the credit stays owed for the next sweep (rule 24).
  if (paid.via && store.statsId && (erased || (await erasedSincePaid(listId, paid, true)))) {
    const replies = repliesFor(await redisPipeline([forgetBondCommand(store.statsId, paid.email, paid.via.aff)]), 1);
    if (!replies || (replies[0] !== 0 && replies[0] !== 1)) throw new UnknownReplyError("taking back the bond of a person deleted during a PayPal credit's retry");
  }
  return true;
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

/**
 * handOverPayPal, saying whether the order left the list handed over, its product gone, or its receipt or its webhook
 * event still owed. A "sale.completed" emitEvent could not record (it throws so its caller tries again: its once-only
 * mark unknown, or its deliveries not written) keeps the order on the list as a receipt not accepted does, due again at
 * receiptDue and only inside RECEIPT_RETRY_SECONDS after the receipt's first try (issue #3937). A receipt already
 * accepted is noted so (markReceiptSent) and not asked of the sender again; the event's id is made from the order, so
 * it is recorded once whatever the tries. A person deleted at their own request is checked on every try, the first
 * and each one again, before and after the hand-over's writes (erasedSincePaid, own), so one deleted between tries is
 * never written back nor told to the webhooks.
 */
async function handOver(store: Store, paid: Paid): Promise<"handed" | "gone" | "owed"> {
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
  // The person deleted from the store at their own request at or after the payment (erasedSincePaid, own): nothing of
  // them is handed over or written again (the purchase, the library, the course, the link's grant, the receipt, the
  // affiliate's bond, the webhooks), nothing is sent, and the order leaves the list; it is still one of the month's
  // orders (countOrder, once an order), and the affiliate and partners are credited for the sale paid, with nothing
  // that names the buyer (creditPayPalSale without rememberBuyer; finding 2). What an earlier try wrote after the
  // deletion is taken back first (takeBack). A deletion by the store's team keeps their purchases, so the order is
  // handed over as any other (finding 1); its receipt is refused where it is kept (KEEP_RECEIPT). Checked again after
  // the hand-over's writes (below), since a deletion can complete between this read and them.
  const listId = store.statsId && isRedisConfigured() ? await deletionListId(store) : null;
  if (store.statsId && listId && (await erasedSincePaid(listId, paid, true))) {
    console.error("a PayPal purchase's person was deleted from the store at their request after paying; nothing of them is handed over or written again", store.handle, paid.order);
    await takeBack(store, paid, product, bundled);
    await creditPayPalSale(store, paid, product.title, false).catch((error) => console.error("crediting a PayPal sale failed", error));
    await countOrder(store, `paypal:${paid.order}`, paid.cents);
    await handedOver(store.statsId, paid.order);
    return "handed";
  }
  const base = storeBase(store);
  // What receiptMayGo answered, when the receipt was asked about (not when the hand-over stopped before it), and
  // whether the receipt was refused because its person was deleted from the store at or after the payment.
  const asked: { window: { go: boolean; firstAt: number; sent: boolean } | null; erased: boolean } = { window: null, erased: false };
  const receiptedNow = await deliverPayPal({
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
      return asked.window.go && !asked.window.sent;
    },
    // deliverPayPal makes no receipt without a stats id; with none, nothing could be noted for deletion, and none is kept.
    keep: async (receipt) => {
      const kept = await sameReceipt(store, paid, receipt, listId);
      if (kept !== "erased") return kept;
      asked.erased = true;
      return null;
    },
  });
  await creditPayPalSale(store, paid, product.title).catch((error) => oweCredit(store, paid.order, error));
  // The person's own deletion completed during this try, after its check (finding 3): what the try wrote of them is
  // taken back, the webhooks are not told, and the order leaves the list. Read once more, after every write that names
  // them (the bond last), so a deletion that writes its mark after this read deletes those writes itself. One HGET a try.
  if (store.statsId && listId && (await erasedSincePaid(listId, paid, true))) {
    console.error("a PayPal purchase's person was deleted from the store at their request during its hand-over; what it wrote of them is taken back", store.handle, paid.order);
    await takeBack(store, paid, product, bundled);
    await handedOver(store.statsId, paid.order);
    return "handed";
  }
  const told = await emitEvent(store, "sale.completed", `paypal:${paid.order}`, {
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
  }, paid.at * 1000).then(
    () => true,
    (error) => {
      console.error("telling the webhooks of a PayPal sale failed", error);
      return false;
    },
  );
  if (!store.statsId) return "handed";
  const window = asked.window;
  // An earlier try's receipt accepted, the order kept only for its event, counts as accepted.
  const receipted = receiptedNow || window?.sent === true;
  // Tried again only inside the receipt's window, and never for a person deleted from the store, as their receipt.
  const eventOwed = !told && !asked.erased && window?.go === true;
  if ((receipted || !window?.go || asked.erased) && !eventOwed) {
    if (asked.erased) console.error("a PayPal purchase's person was deleted from the store; its receipt is not kept or sent, and not tried again", store.handle, paid.order);
    else if (!receipted) console.error("a PayPal purchase's receipt was not accepted within its retry window; no longer tried", store.handle, paid.order);
    if (!told) console.error("WEBHOOK EVENT LOST: a PayPal sale could not be told to the store's webhooks within its retry window; no longer tried", store.handle, paid.order);
    await handedOver(store.statsId, paid.order);
  } else if (window) {
    // Still in the list since settle wrote it: this only sets when it is due again (receiptDue; the list's score is
    // the due time less the grace handOverAgain waits). XX: one a concurrent run took out is not put back. A ZADD that
    // fails leaves it due as it was; its next try is still held to the window (receiptMayGo).
    const now = Math.floor(Date.now() / 1000);
    if (eventOwed) console.error("a PayPal sale could not be told to the store's webhooks; tried again later", store.handle, paid.order);
    if (!receipted) console.error("a PayPal purchase's receipt was not accepted; tried again later", store.handle, paid.order);
    else if (receiptedNow) await markReceiptSent(paid, window.firstAt, now);
    const due = receiptDue(window.firstAt, now) - HAND_OVER_GRACE_SECONDS;
    await redisPipeline([["ZADD", handOverKey(store.statsId), "XX", String(due), paid.order]]).catch(() => undefined);
    return "owed";
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
    if (order.startsWith(CREDIT_PREFIX)) {
      try {
        if (await creditAgain(store, order.slice(CREDIT_PREFIX.length))) await redisPipeline([["ZREM", key, order]]);
      } catch (error) {
        console.error("crediting a PayPal sale again failed; tried again at the next sweep", store.handle, order, error);
        await redisPipeline([["ZADD", key, dueNow(), order]]).catch(() => undefined);
      }
      continue;
    }
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
      // Handed over with its receipt accepted and its sale told to the webhooks, or its product gone: handOver takes it
      // out of the list. Its receipt not accepted or its event not recorded: kept and tried again later, inside
      // RECEIPT_RETRY_SECONDS, and not counted as handed over yet.
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
  // PayPal disconnected (lib/store.ts, paypalPast): its orders are still answered, but only while some are left on the
  // store's three lists and within PAYPAL_PAST_SECONDS of the disconnection (three ZCARD in one round trip first,
  // PAYPAL_PAST_WATCH in tests/plan-cost-registry.ts). With none left, or past the window, the account is forgotten
  // and the store is no longer swept for PayPal; an unknown count is asked again next run, never taken for "none".
  // Not before PAYPAL_OPEN_ORDER_SECONDS after the disconnection, though: an order opened just before it is on none of
  // the lists until its buyer comes back (openOrder keeps it that long), and a payment PayPal holds as pending then
  // must still be asked about with this account (review of #3924, MEDIUM).
  if (!store.paypalSeller && store.paypalPast) {
    const past = store.paypalPast;
    const left = paypalPastWatched(store) && store.statsId ? await paypalOrdersLeft(store.statsId) : 0;
    if (left === null) return { cleared: 0, revoked: 0 };
    if (left === 0) {
      const openable = paypalPastWatched(store) && Date.now() < past.at + PAYPAL_OPEN_ORDER_SECONDS * 1000;
      if (!openable) await forgetPayPalPast(storeRef(store), past.at).catch((error) => console.error("forgetting a disconnected PayPal account failed", store.handle, error));
      return { cleared: 0, revoked: 0 };
    }
  }
  const done = await watchPayPal(store, deadline, {
    // An order PayPal never confirmed: the buyer and the creator are told it is canceled (lib/paypal-cancel.ts).
    canceled: (order, who) => tellCanceled(store, order, who),
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
      // A person deleted from the store at their own request at or after the payment is not named (second review of
      // #3449); a mark that does not read exactly is taken as such a deletion. A store with no list deleted nobody.
      const erased = store.listId && isRedisConfigured() ? await erasedSincePaid(store.listId, paid, true).catch(() => true) : false;
      await emitEvent(store, "refund.issued", `paypal:${paid.capture}`, {
        paypal_capture: paid.capture,
        paid_with: "paypal",
        product: { id: paid.product, title: product?.title ?? null },
        amount_refunded_cents: paid.cents,
        total_refunded_cents: paid.cents,
        amount_cents: paid.cents,
        fully_refunded: true,
        currency: paid.currency,
        buyer: { email: erased ? null : paid.email, name: null },
        refunded_at: new Date().toISOString(),
        // Nobody the store deleted at or after the payment is named (R38, rule 30; review of #3491).
      }, Date.now(), { email: paid.email, paidAt: paid.at });
    },
  });
  done.cleared += await handOverAgain(store, deadline);
  return done;
}

/**
 * Tries again, once a run of the five-minute job, the notices of canceled PayPal orders the sender refused, to their
 * buyers and their creators (lib/paypal-sales.ts, retryCancelNotices): each told from its store as it is now, found by the handle kept with the
 * order and checked by its stats id. A store that cannot be read is tried again next time; a store that is gone, or is
 * another store now, leaves nobody to send from, and the page the buyer comes back to still says the order was
 * canceled.
 */
export async function retryPayPalCancelNotices(deadline: number): Promise<number> {
  return retryCancelNotices(deadline, async (canceled, who) => {
    // Read exactly (rule 24): a reply out of shape is not "no store". It throws, and retryCancelNotices reads the
    // throw as "refused", so both notices wait for the next run instead of being dropped for good.
    const store = await storeForHandleExactly(canceled.handle);
    if (store === "unknown") throw new UnknownReplyError("the store of a canceled PayPal order");
    if (store === "none" || store.statsId !== canceled.store) return { buyer: "none", creator: "none" };
    return tellCanceled(store, canceled, who);
  });
}
