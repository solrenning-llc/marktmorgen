/**
 * The EU withdrawal function, server side (588 [KB9], unit 1b): records a
 * buyer's online withdrawal statement once per order, sends the
 * acknowledgement (Directive 2011/83/EU art. 11a(4)) and tells the creator.
 * The rules, the statement and the period are in lib/withdrawal-rules.ts.
 *
 * What is kept is the least that proves the withdrawal happened and stops a
 * second acknowledgement: the order's reference and the time, under the
 * store, kept WITHDRAWAL_KEEP_DAYS and counted in the store's data room
 * before it is written. The buyer's name and email are not kept here: they
 * travel in the acknowledgement to the buyer and in the message to the
 * creator's inbox (lib/inbox.ts, fileContact), which already holds a buyer's
 * messages.
 *
 * Nothing here refunds, cancels or writes to the creator's Stripe account
 * (the owner's decision C4-20261106-2640-DONO-156): the creator does that.
 * Cost: at most one acknowledgement and one inbox message per order, ever,
 * since the record is written with SET NX before either is sent.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
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

/** When an order was withdrawn from, in milliseconds, or null; throws when the record does not read. */
export async function withdrawnAt(store: Pick<Store, "sid">, reference: string): Promise<number | null> {
  if (!store.sid || !isRedisConfigured()) throw new Error("withdrawals cannot be read");
  const replies = repliesFor(await redisPipeline([["GET", withdrawalKey(store.sid, reference)]]), 1);
  if (!replies) throw new Error("withdrawals cannot be read");
  const raw = replies[0];
  if (raw === null) return null;
  const at = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(at) || at <= 0) throw new Error("a withdrawal record does not read");
  return at;
}

export type WithdrawOutcome = "done" | "unsent" | "already" | "closed" | "full" | "error";

/**
 * Records one withdrawal and sends its acknowledgement and the creator's notice.
 * "closed" when the period is over (art. 11a(5) reads the submission time);
 * "already" when this order was withdrawn from before, nothing sent again;
 * "unsent" when the record is written but the acknowledgement email could
 * not be sent; "full" when the store's data room has no space.
 */
export async function withdraw(store: Store, purchase: Purchase, statement: WithdrawalStatement, nowMs = Date.now()): Promise<WithdrawOutcome> {
  if (!store.sid || !isRedisConfigured() || statement.reference !== purchase.reference) return "error";
  const now = Math.floor(nowMs / 1000);
  if (!submittedInTime(windowOf(purchase, now), now)) return "closed";
  const key = withdrawalKey(store.sid, purchase.reference);
  const room = await takeData(store, [{ until: nowMs + WITHDRAWAL_KEEP_DAYS * DAY_MS, bytes: dataBytes([key, String(nowMs)]) }], nowMs);
  if (!room.ok) return room.reason === "full" ? "full" : "error";
  const replies = repliesFor(await redisPipeline([["SET", key, String(nowMs), "NX", "EX", WITHDRAWAL_KEEP_DAYS * 86_400]]), 1);
  if (!replies) return "error";
  if (replies[0] === null) return "already";
  if (replies[0] !== "OK") return "error";

  const w = withdrawalWords(store.language);
  const ack = acknowledgement(statement, purchase.title, store.name, nowMs, w);
  const sent = await sendEmail({
    meter: { by: "store", store, kind: "transactional" },
    from: `"${ordersWords(store.language).ordersFrom(displayName(store.name))}" <${senderAddress()}>`,
    to: statement.email,
    subject: ack.subject,
    text: ack.text,
  }).catch(() => false);
  // The creator is told in the inbox, with the statement; a failure there does not undo the withdrawal.
  await fileContact({ store, email: statement.email, name: statement.name, text: w.creatorNote(purchase.title, purchase.reference, ack.when), now: nowMs }).catch((error) =>
    console.error("telling the creator about a withdrawal failed", error),
  );
  return sent ? "done" : "unsent";
}
