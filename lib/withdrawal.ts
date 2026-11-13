/**
 * The EU withdrawal function, server side (588 [KB9], unit 1b): records a
 * buyer's online withdrawal statement once per order, sends the
 * acknowledgement (Directive 2011/83/EU art. 11a(4)) and tells the creator.
 * The rules, the statement and the period are in lib/withdrawal-rules.ts.
 *
 * What is kept is the least that proves the withdrawal happened and bounds
 * its emails: under the store and the order's reference, a hash with the
 * time of the first statement ("at"), how many times its acknowledgement was
 * tried ("tries") and whether it went ("sent"), kept WITHDRAWAL_KEEP_DAYS and
 * counted in the store's data room before it is written. The buyer's name and email are not kept here: they
 * travel in the acknowledgement to the buyer and in the message to the
 * creator's inbox (lib/inbox.ts, fileContact), which already holds a buyer's
 * messages.
 *
 * Nothing here refunds, cancels or writes to the creator's Stripe account
 * (the owner's decision C4-20261106-2640-DONO-156): the creator does that.
 * Cost: one inbox message per order, ever (only the statement that creates
 * the record files it), and the acknowledgement tried at most
 * WITHDRAWAL_ACK_SENDS times per order, each taken from the store's
 * transactional emails: a statement made again after the email did not go
 * sends it again, with the first statement's time, until it goes or the
 * ceiling is reached.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { sendEmail } from "@/lib/email";
import { fileContact } from "@/lib/inbox";
import type { Store } from "@/lib/store";
import { takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type OrdersMeter, type Purchase, displayName, senderAddress } from "@/lib/buyer-orders";
import { confirmationKey } from "@/lib/purchase-email";
import { ordersWords } from "@/lib/buyer-words/orders";
import { withdrawalWords } from "@/lib/buyer-words/withdrawal";
import { type WithdrawalFacts, type WithdrawalStatement, type WithdrawalWindow, acknowledgement, submittedInTime, withdrawalWindow, yesEndsOnSupply } from "@/lib/withdrawal-rules";

/** How long the record of a withdrawal is kept, in days. */
export const WITHDRAWAL_KEEP_DAYS = 400;
/** The most times one order's acknowledgement is tried, in all (the re-send ceiling). */
export const WITHDRAWAL_ACK_SENDS = 3;
const DAY_MS = 86_400_000;

/** The record of a withdrawal from one order of one store. */
export const withdrawalKey = (sid: string, reference: string) => `nl:withdraw:${sid}:${reference}`;

/**
 * The reference a withdrawal is kept and named under: the order's own, or for a pre-order handed over, the checkout it
 * was paid at (Purchase.checkout). Before its hand-over the list names it by that checkout; after, by its brought-over
 * reference. Keeping the record under the checkout keeps a statement made before the hand-over standing after it (the
 * function is not offered again, nothing goes twice), and the creator's note names an order their Stripe account knows
 * (Claude 5's F on #2827).
 */
export const withdrawalReference = (purchase: Pick<Purchase, "reference" | "checkout">): string => purchase.checkout ?? purchase.reference;

/**
 * Whether a purchase on the list as brought over is a pre-order this store handed over (lib/preorders.ts grants it under
 * the job "pre:<checkout>", and lib/buyer-orders.ts reads it back with preorder.given): a contract made here, paid at its
 * checkout's time (the entry's `at`, the checkout's created time as for every sale, or the time it was written down when
 * that did not read, never the hand-over).
 */
const handedOverPreorder = (purchase: Purchase) => purchase.kind === "imported" && purchase.preorder?.given === true && !purchase.giftFrom && !purchase.place && !purchase.givenByStore;

/**
 * What deciding the period reads from a purchase on the buyer's list. A PayPal order is a sale made here, and so is a
 * pre-order handed over (Claude 5's focal return on #2827): its yes is not kept with it, so it keeps the 14 days, and
 * its confirmation is never taken as known (the hand-over email carries no art. 8(7) lines, and the nl:confirm: mark
 * lib/purchase-email.ts writes for a hand-over does not say whether any email went).
 */
export function factsOf(purchase: Purchase): WithdrawalFacts {
  return {
    kind: purchase.paidWith === "paypal" || handedOverPreorder(purchase) ? "sale" : purchase.kind,
    paidAt: purchase.paidAt,
    member: purchase.member || purchase.ended,
    givenByStore: purchase.givenByStore === true || Boolean(purchase.giftFrom),
    consent: purchase.consent ?? null,
    ...(purchase.preorder ? { preorder: purchase.preorder } : {}),
    ...(purchase.shipped === true ? { shipped: true } : {}),
    ...(purchase.confirmed === true && !purchase.preorder ? { confirmed: true } : {}),
  };
}

/** An order's own confirmation is kept under its checkout (cs_) or its payment taken in one click (pi_), lib/purchase-email.ts. */
const CONFIRMED_REFERENCE = /^(cs_(test|live)_|pi_)[A-Za-z0-9]{10,200}$/;

/**
 * The purchases with whether each one's confirmation email is known to have gone (Purchase.confirmed), read only where
 * the art. 16(m) yes would otherwise end the right (art. 16(m)(iii) needs that confirmation on a durable medium too) and
 * the 14 days still run: one GET of its nl:confirm: mark (lib/purchase-email.ts) each, all taken through the opening's
 * meter before they are read, as its other reads that grow with what the buyer has. Only a reply that is exactly "sent"
 * counts: no mark, "sending", any other value, a reply in another shape or a read that fails all leave it not known,
 * so the function stays offered (CX-123: unknown is never "sent"; never hidden on a guess). The mark is kept 40 days
 * from when the confirmation went (SENT_MARK_SECONDS, set at or after payment), and the period ends before payment + 19
 * days (withdrawalEnd: 14 days from the latest calendar day at payment, a weekend moved, the end of the day anywhere on Earth), so a mark gone by expiry belongs
 * to an order whose 14 days are over anyway. A pre-order's mark is never read (factsOf). A confirmation sent by another path that writes no such mark (an order's
 * reserved origin, lib/order-confirmation-outbox.ts; a PayPal order) is not known here and keeps the function offered.
 */
export async function withConfirmations(purchases: Purchase[], meter: Pick<OrdersMeter, "take">, nowSeconds = Math.floor(Date.now() / 1000)): Promise<Purchase[]> {
  const asked = purchases.filter((purchase) => {
    const facts = factsOf(purchase);
    // Never a pre-order's: what its mark says does not prove the art. 8(7) confirmation (factsOf).
    return !purchase.preorder && CONFIRMED_REFERENCE.test(purchase.reference) && yesEndsOnSupply(facts) && withdrawalWindow(facts, nowSeconds).open;
  });
  if (asked.length === 0) return purchases;
  await meter.take(asked.length);
  let replies: unknown[] | null = null;
  try {
    replies = repliesFor(await redisPipeline(asked.map((purchase) => ["GET", confirmationKey(purchase.reference)])), asked.length);
  } catch (error) {
    console.error("an order's confirmation mark could not be read", error);
  }
  const sent = new Set(asked.filter((_, i) => replies?.[i] === "sent").map((purchase) => purchase.reference));
  return purchases.map((purchase) => (sent.has(purchase.reference) ? { ...purchase, confirmed: true } : purchase));
}

/** When the function is offered for this purchase, now. */
export function windowOf(purchase: Purchase, nowSeconds = Math.floor(Date.now() / 1000)): WithdrawalWindow {
  return withdrawalWindow(factsOf(purchase), nowSeconds);
}

/** One order's withdrawal record: when it was first stated (ms), how many acknowledgements were tried, whether one went. */
type WithdrawalRecord = { at: number | null; tries: number; sent: boolean; told: boolean; tells: number };

/** A whole count kept as text in the record, or null for a field not written; NaN when it does not read. */
const countField = (raw: unknown): number => (raw === null ? 0 : typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN);

/** Reads one order's record exactly; throws when it does not read (CX-123: unknown is never "not withdrawn"). */
async function readRecord(sid: string, reference: string): Promise<WithdrawalRecord> {
  const replies = repliesFor(await redisPipeline([["HMGET", withdrawalKey(sid, reference), "at", "tries", "sent", "told", "tells"]]), 1);
  const fields = replies?.[0];
  if (!Array.isArray(fields) || fields.length !== 5) throw new Error("a withdrawal record does not read");
  const [rawAt, rawTries, rawSent, rawTold, rawTells] = [fields[0], fields[1], fields[2], fields[3], fields[4]];
  if (rawAt === null) {
    if (rawTries !== null || rawSent !== null || rawTold !== null || rawTells !== null) throw new Error("a withdrawal record does not read");
    return { at: null, tries: 0, sent: false, told: false, tells: 0 };
  }
  const at = typeof rawAt === "string" && /^\d{1,16}$/.test(rawAt) ? Number(rawAt) : Number.NaN;
  const tries = countField(rawTries);
  const tells = countField(rawTells);
  const flag = (raw: unknown) => raw === null || raw === "1";
  if (!Number.isSafeInteger(at) || at <= 0 || !Number.isSafeInteger(tries) || !Number.isSafeInteger(tells) || !flag(rawSent) || !flag(rawTold)) {
    throw new Error("a withdrawal record does not read");
  }
  return { at, tries, sent: rawSent === "1", told: rawTold === "1", tells };
}

/** When an order was withdrawn from, in milliseconds, or null; throws when the record does not read. */
export async function withdrawnAt(store: Pick<Store, "sid">, reference: string): Promise<number | null> {
  if (!store.sid || !isRedisConfigured()) throw new Error("withdrawals cannot be read");
  return (await readRecord(store.sid, reference)).at;
}

/** What a recorded withdrawal still owes: the acknowledgement with the store told ("unsent"), the acknowledgement with the store not told ("unreached"), or only the creator's notice ("untold"). */
export type WithdrawalOwed = "unsent" | "unreached" | "untold";

/**
 * Where one order's withdrawal stands, for its page: when it was recorded (or null), and what is still owed to it while a
 * try of it is left: the acknowledgement, said "unreached" when the creator was not told either (whether or not a try of
 * the notice is left: it never says the store got it) and "unsent" when they were; or the creator's notice ("untold").
 * Throws when the record does not read.
 */
export async function withdrawalStanding(store: Pick<Store, "sid">, reference: string): Promise<{ at: number | null; owed: WithdrawalOwed | null }> {
  if (!store.sid || !isRedisConfigured()) throw new Error("withdrawals cannot be read");
  const record = await readRecord(store.sid, reference);
  if (record.at === null) return { at: null, owed: null };
  const owed = !record.sent && record.tries < WITHDRAWAL_ACK_SENDS ? (record.told ? "unsent" : "unreached") : !record.told && record.tells < WITHDRAWAL_ACK_SENDS ? "untold" : null;
  return { at: record.at, owed };
}

export type WithdrawOutcome = "done" | "unsent" | "unreached" | "untold" | "already" | "closed" | "full" | "error";

/**
 * Records one withdrawal and sends its acknowledgement and the creator's notice.
 * "closed" when the period is over (art. 11a(5) reads the submission time);
 * "already" when this order's acknowledgement went before, or was tried
 * WITHDRAWAL_ACK_SENDS times and the creator was told (or was tried as
 * often), nothing sent again; "unsent" when the record is written and the
 * creator told but the acknowledgement email could not be sent (the next
 * statement tries again); "unreached" when the record is written but neither
 * the creator's notice nor the acknowledgement went (Claude 5 on #2827: never
 * said as sent; the next statement tries both again);
 * "untold" when the acknowledgement went but the creator's notice was refused
 * (an inbox quota, say): it is never reported as passed on, the
 * acknowledgement says so, and the next statement tries the notice again, at
 * most WITHDRAWAL_ACK_SENDS times (Codex N on #2827); "full" when the store's
 * data room has no space.
 */
export async function withdraw(store: Store, purchase: Purchase, statement: WithdrawalStatement, nowMs = Date.now()): Promise<WithdrawOutcome> {
  if (!store.sid || !isRedisConfigured() || statement.reference !== purchase.reference) return "error";
  const reference = withdrawalReference(purchase);
  const key = withdrawalKey(store.sid, reference);
  let record: WithdrawalRecord;
  try {
    record = await readRecord(store.sid, reference);
  } catch {
    return "error";
  }
  let created = false;
  if (record.at === null) {
    // A first statement: in time only if submitted before the period ended. One recorded before keeps its time.
    const now = Math.floor(nowMs / 1000);
    if (!submittedInTime(windowOf(purchase, now), now)) return "closed";
    const room = await takeData(store, [{ until: nowMs + WITHDRAWAL_KEEP_DAYS * DAY_MS, bytes: dataBytes([key, "at", String(nowMs), "tries", String(WITHDRAWAL_ACK_SENDS), "sent", "1"]) }], nowMs);
    if (!room.ok) return room.reason === "full" ? "full" : "error";
    const replies = repliesFor(await redisPipeline([["HSETNX", key, "at", String(nowMs)], ["EXPIRE", key, WITHDRAWAL_KEEP_DAYS * 86_400]]), 2);
    const made = replies ? countOf(replies[0]) : null;
    if (made === null || made > 1 || countOf(replies?.[1]) !== 1) return "error";
    created = made === 1;
    if (!created) {
      try {
        record = await readRecord(store.sid, reference);
      } catch {
        return "error";
      }
      if (record.at === null) return "error";
    } else record = { at: nowMs, tries: 0, sent: false, told: false, tells: 0 };
  }
  const at = record.at as number;
  const w = withdrawalWords(store.language);
  const when = acknowledgement(statement, purchase.title, store.name, at, w).when;
  const tellLeft = !record.told && record.tells < WITHDRAWAL_ACK_SENDS;
  const ackLeft = !record.sent && record.tries < WITHDRAWAL_ACK_SENDS;
  if (!tellLeft && !ackLeft) return "already";

  // The creator first, so the acknowledgement says truthfully whether the statement was passed on. Each try of either is
  // counted before it is made, so neither is ever tried more than WITHDRAWAL_ACK_SENDS times for an order.
  let told = record.told;
  if (tellLeft) {
    const counted = repliesFor(await redisPipeline([["HINCRBY", key, "tells", 1]]), 1);
    const tells = counted ? countOf(counted[0]) : null;
    if (tells === null || tells < 1) return "error";
    if (tells <= WITHDRAWAL_ACK_SENDS) {
      told = await fileContact({ store, email: statement.email, name: statement.name, text: w.creatorNote(purchase.title, reference, when, purchase.paidWith === "paypal" ? "PayPal" : "Stripe"), now: nowMs }).catch((error) => {
        console.error("telling the creator about a withdrawal failed", error);
        return false;
      });
      if (told) {
        const marked = repliesFor(await redisPipeline([["HSET", key, "told", "1"]]).catch(() => null), 1);
        if (!marked || countOf(marked[0]) === null) console.error("a withdrawal's notice was filed but could not be marked told");
      }
    }
  }

  let sent = record.sent;
  if (ackLeft) {
    const counted = repliesFor(await redisPipeline([["HINCRBY", key, "tries", 1]]), 1);
    const tries = counted ? countOf(counted[0]) : null;
    if (tries === null || tries < 1) return "error";
    if (tries <= WITHDRAWAL_ACK_SENDS) {
      const ack = acknowledgement(statement, purchase.title, store.name, at, w, told);
      sent = await sendEmail({
        meter: { by: "store", store, kind: "transactional" },
        from: `"${ordersWords(store.language).ordersFrom(displayName(store.name))}" <${senderAddress()}>`,
        to: statement.email,
        subject: ack.subject,
        text: ack.text,
      }).catch(() => false);
      if (sent) {
        const marked = repliesFor(await redisPipeline([["HSET", key, "sent", "1"]]).catch(() => null), 1);
        if (!marked || countOf(marked[0]) === null) console.error("a withdrawal's acknowledgement went but could not be marked sent");
      }
    }
  }
  if (!sent) return told ? "unsent" : "unreached";
  return told ? "done" : "untold";
}
