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
import { type Purchase, displayName, senderAddress } from "@/lib/buyer-orders";
import { ordersWords } from "@/lib/buyer-words/orders";
import { withdrawalWords } from "@/lib/buyer-words/withdrawal";
import { type WithdrawalFacts, type WithdrawalStatement, type WithdrawalWindow, acknowledgement, submittedInTime, withdrawalWindow } from "@/lib/withdrawal-rules";

/** How long the record of a withdrawal is kept, in days. */
export const WITHDRAWAL_KEEP_DAYS = 400;
/** The most times one order's acknowledgement is tried, in all (the re-send ceiling). */
export const WITHDRAWAL_ACK_SENDS = 3;
const DAY_MS = 86_400_000;

/** The record of a withdrawal from one order of one store. */
export const withdrawalKey = (sid: string, reference: string) => `nl:withdraw:${sid}:${reference}`;

/** What deciding the period reads from a purchase on the buyer's list. A PayPal order is a sale made here. */
export function factsOf(purchase: Purchase): WithdrawalFacts {
  return {
    kind: purchase.paidWith === "paypal" ? "sale" : purchase.kind,
    paidAt: purchase.paidAt,
    member: purchase.member || purchase.ended,
    givenByStore: purchase.givenByStore === true || Boolean(purchase.giftFrom),
    consent: purchase.consent ?? null,
    ...(purchase.preorder ? { preorder: purchase.preorder } : {}),
  };
}

/** When the function is offered for this purchase, now. */
export function windowOf(purchase: Purchase, nowSeconds = Math.floor(Date.now() / 1000)): WithdrawalWindow {
  return withdrawalWindow(factsOf(purchase), nowSeconds);
}

/** One order's withdrawal record: when it was first stated (ms), how many acknowledgements were tried, whether one went. */
type WithdrawalRecord = { at: number | null; tries: number; sent: boolean };

/** Reads one order's record exactly; throws when it does not read (CX-123: unknown is never "not withdrawn"). */
async function readRecord(sid: string, reference: string): Promise<WithdrawalRecord> {
  const replies = repliesFor(await redisPipeline([["HMGET", withdrawalKey(sid, reference), "at", "tries", "sent"]]), 1);
  const fields = replies?.[0];
  if (!Array.isArray(fields) || fields.length !== 3) throw new Error("a withdrawal record does not read");
  const [rawAt, rawTries, rawSent] = [fields[0], fields[1], fields[2]];
  if (rawAt === null) {
    if (rawTries !== null || rawSent !== null) throw new Error("a withdrawal record does not read");
    return { at: null, tries: 0, sent: false };
  }
  const at = typeof rawAt === "string" && /^\d{1,16}$/.test(rawAt) ? Number(rawAt) : Number.NaN;
  const tries = rawTries === null ? 0 : typeof rawTries === "string" && /^\d{1,6}$/.test(rawTries) ? Number(rawTries) : Number.NaN;
  if (!Number.isSafeInteger(at) || at <= 0 || !Number.isSafeInteger(tries) || (rawSent !== null && rawSent !== "1")) throw new Error("a withdrawal record does not read");
  return { at, tries, sent: rawSent === "1" };
}

/** When an order was withdrawn from, in milliseconds, or null; throws when the record does not read. */
export async function withdrawnAt(store: Pick<Store, "sid">, reference: string): Promise<number | null> {
  if (!store.sid || !isRedisConfigured()) throw new Error("withdrawals cannot be read");
  return (await readRecord(store.sid, reference)).at;
}

export type WithdrawOutcome = "done" | "unsent" | "already" | "closed" | "full" | "error";

/**
 * Records one withdrawal and sends its acknowledgement and the creator's notice.
 * "closed" when the period is over (art. 11a(5) reads the submission time);
 * "already" when this order's acknowledgement went before, or was tried
 * WITHDRAWAL_ACK_SENDS times, nothing sent again; "unsent" when the record is
 * written but the acknowledgement email could not be sent (the next statement
 * tries again); "full" when the store's data room has no space.
 */
export async function withdraw(store: Store, purchase: Purchase, statement: WithdrawalStatement, nowMs = Date.now()): Promise<WithdrawOutcome> {
  if (!store.sid || !isRedisConfigured() || statement.reference !== purchase.reference) return "error";
  const key = withdrawalKey(store.sid, purchase.reference);
  let record: WithdrawalRecord;
  try {
    record = await readRecord(store.sid, purchase.reference);
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
        record = await readRecord(store.sid, purchase.reference);
      } catch {
        return "error";
      }
      if (record.at === null) return "error";
    } else record = { at: nowMs, tries: 0, sent: false };
  }
  if (record.sent || record.tries >= WITHDRAWAL_ACK_SENDS) return "already";
  // Each try is counted before it is made, so no order's acknowledgement is ever tried more than the ceiling.
  const counted = repliesFor(await redisPipeline([["HINCRBY", key, "tries", 1]]), 1);
  const tries = counted ? countOf(counted[0]) : null;
  if (tries === null || tries < 1) return "error";
  if (tries > WITHDRAWAL_ACK_SENDS) return "already";

  const at = record.at as number;
  const w = withdrawalWords(store.language);
  const ack = acknowledgement(statement, purchase.title, store.name, at, w);
  const sent = await sendEmail({
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
  // The creator is told once, by the statement that created the record; a failure there does not undo the withdrawal.
  if (created) {
    await fileContact({ store, email: statement.email, name: statement.name, text: w.creatorNote(purchase.title, purchase.reference, ack.when), now: nowMs }).catch((error) =>
      console.error("telling the creator about a withdrawal failed", error),
    );
  }
  return sent ? "done" : "unsent";
}
