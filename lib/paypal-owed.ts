/**
 * A PayPal payment owed back to its buyer: PayPal took it (its capture COMPLETED, so settle in lib/paypal-sales.ts wrote
 * its paid record), nothing was handed over, and the product it bought is no longer in the store (the owner's decision
 * 2 of C1-20261109-1029-C5-52). Before 9 November 2026 such an order only left the hand-over list with a log line: the
 * buyer got nothing, nobody refunded them and the creator was never told.
 *
 * The refund itself is not made here. The owner decided it should be automatic, but this repository has no call to
 * PayPal's refund of a capture, and PayPal's official documentation of that call (its request, its states, its
 * idempotency) was not readable when this was built; a call that moves money is not written from memory. So, until it
 * is: the order is marked "refund owed", and the creator is emailed once to refund the payment in full in their own
 * PayPal account. The buyer's page reads both and says only what is so. When the refund is made in PayPal, the refund
 * watch takes it in as for any other order (watchPayPal), and the page says "refunded".
 *
 * Each step is read exactly (CX-123 rule 24): a read that is unknown throws, and the order stays on the hand-over list
 * for the sweep to try again (lib/paypal-delivery.ts). The email is claimed before it goes (lib/claim-mark.ts), for an
 * hour, and kept as "sent" for as long as the mark once the sender took it, so it never goes twice; its idempotency
 * key covers an answer lost on the way. One the sender did not take lets its claim go and is tried again
 * TELL_RETRY_SECONDS later, through the hand-over list's own score, until TELL_WINDOW_SECONDS after the payment
 * (TELL_TRIES_AT_MOST tries in all); past it the order leaves the list marked, with the creator not told, and the
 * buyer's page then does not say they were.
 *
 *   nl:ppsell:owed:<statsId>        sorted set: the store's orders whose refund is owed, scored by when (400 days)
 *   nl:ppsell:owed:told:<order>     the creator's email about one of them: claimed (1 hour), then "sent" (400 days)
 *
 * Neither holds anything about the buyer: the paid record (lib/paypal-sales.ts) holds the order, and the email names
 * only PayPal's transaction id, the amount and the date. Cost: the email takes the order's own place for its receipt
 * (meter "order"), which is not sent, and the order is counted as one of the month's, as a hand-over counts it
 * (PAYPAL_REFUND_OWED in tests/plan-cost-registry.ts).
 */
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { formatMoney } from "@/lib/money";
import { countOrder } from "@/lib/orders";
import { paypalHandedOver } from "@/lib/paypal-handed";
import { type Paid, handOverKey } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";

/** How long a mark and its "sent" are kept: as long as the paid record (PAID_KEPT_SECONDS in lib/paypal-sales.ts). */
const KEPT_SECONDS = 400 * 86_400;
/** How long the email's claim holds while it is being sent: one that is never let go runs out by then. */
const CLAIM_SECONDS = 3600;
/** How long after a try the sender did not take the email is tried again. */
export const TELL_RETRY_SECONDS = 6 * 3600;
/** How long after the payment the email is tried at all. */
export const TELL_WINDOW_SECONDS = 3 * 86_400;
/** The most tries of the email for one order: the first, then one every TELL_RETRY_SECONDS inside the window. */
export const TELL_TRIES_AT_MOST = 1 + Math.ceil(TELL_WINDOW_SECONDS / TELL_RETRY_SECONDS);
/** The grace handOverAgain waits from an order's score (HAND_OVER_GRACE_SECONDS in lib/paypal-delivery.ts). */
const HAND_OVER_GRACE_SECONDS = 600;
const SENT = "sent";

export const owedKey = (statsId: string) => `nl:ppsell:owed:${statsId}`;
const toldKey = (order: string) => `nl:ppsell:owed:told:${order}`;
/** A mark's score as this file writes it: whole seconds. */
const SCORE = /^[1-9]\d{0,11}$/;

/**
 * This order's refund, read exactly for the buyer's page (one pipeline: ZSCORE, GET): "told" when it is owed and the
 * creator was emailed, "owed" when it is owed and the email has not gone (yet, or at all), false when it is not owed,
 * "unknown" when the mark's reply is not one of those. An email whose state does not read is taken as not sent: the
 * page then says less, never more.
 */
export async function refundOwed(statsId: string, order: string): Promise<"told" | "owed" | false | "unknown"> {
  const read = repliesFor(await redisPipeline([["ZSCORE", owedKey(statsId), order], ["GET", toldKey(order)]]), 2);
  if (!read) return "unknown";
  if (read[0] === null) return false;
  if (typeof read[0] !== "string" || !SCORE.test(read[0])) return "unknown";
  return read[1] === SENT ? "told" : "owed";
}

/** The email that asks the creator to refund it. */
export function owedEmail(store: Pick<Store, "name">, paid: Pick<Paid, "capture" | "cents" | "currency" | "at">): { subject: string; text: string } {
  const amount = formatMoney(paid.cents, paid.currency);
  const when = new Date(paid.at * 1000).toISOString().replace("T", " ").slice(0, 16);
  return {
    subject: `${store.name}: refund a PayPal payment for a removed product`.slice(0, 180),
    text: [
      `A buyer paid ${store.name} ${amount} with PayPal on ${when} UTC for a product you have since removed from your store. There was nothing left to give them, so they got nothing.`,
      "",
      "Please refund this payment in full in your PayPal account:",
      `  PayPal transaction ID: ${paid.capture}`,
      `  Amount: ${amount}`,
      "",
      "Log in to PayPal, find the payment by its transaction ID, and refund the whole amount.",
      "",
      "The buyer's order page now says the product is no longer available and that we asked you to refund them. Once PayPal shows the refund, the page says so too.",
      "",
      "Marktmorgen does not refund PayPal payments for you: the money is in your own PayPal account.",
      "",
      "This email comes once for this payment.",
    ].join("\n"),
  };
}

/**
 * For a paid order whose product the store no longer has:
 *   "owed"        marked, and its creator told (or past the window for telling them): it leaves the hand-over list;
 *   "later"       marked, the email not taken by the sender: it stays on the list, due again TELL_RETRY_SECONDS on;
 *   "handed"      handed over before the product went, or the buyer holds it through another grant: nothing owed;
 *   "taken back"  PayPal took the payment back meanwhile: nothing owed.
 * Throws, when a read or a write is unknown, before anything is sent.
 */
export async function owePayPalRefund(store: Store, paid: Paid, now = Math.floor(Date.now() / 1000)): Promise<"owed" | "later" | "handed" | "taken back"> {
  if (!store.statsId || !isRedisConfigured()) throw new UnknownReplyError("a PayPal order's refund owed (no store records)");
  // Nothing handed over is the condition: the buyer's grant, read exactly (lib/paypal-handed.ts).
  const handed = await paypalHandedOver(paid);
  if (handed === "unknown") throw new UnknownReplyError("a PayPal order's hand-over");
  if (handed === true || handed === "owned") return "handed";
  if (handed !== false) return "taken back";
  const marked = repliesFor(
    await redisPipeline([
      ["ZADD", owedKey(store.statsId), "NX", String(now), paid.order],
      ["EXPIRE", owedKey(store.statsId), KEPT_SECONDS],
      ["ZREMRANGEBYSCORE", owedKey(store.statsId), "-inf", String(now - KEPT_SECONDS)],
      ["GET", toldKey(paid.order)],
    ]),
    4,
  );
  if (
    !marked ||
    (marked[0] !== 0 && marked[0] !== 1) ||
    (marked[1] !== 0 && marked[1] !== 1) ||
    !Number.isSafeInteger(marked[2]) ||
    (marked[2] as number) < 0 ||
    (marked[3] !== null && typeof marked[3] !== "string")
  ) {
    throw new UnknownReplyError("a PayPal order's refund owed mark");
  }
  // One of the month's orders, as a hand-over counts it (deliverPayPal); counted once (its own SET NX), never throws.
  await countOrder(store, `paypal:${paid.order}`, paid.cents);
  if (marked[3] === SENT) return "owed";
  const value = claimValue();
  const claim = marked[3] === null ? await claimMark(toldKey(paid.order), CLAIM_SECONDS, value) : "taken";
  if (claim === "unknown") throw new UnknownReplyError("a PayPal refund email's claim");
  if (claim === "ours") {
    const { subject, text } = owedEmail(store, paid);
    const sent = await sendEmail({ meter: { by: "order" }, from: NIMBUS_FROM, to: store.email, subject, text, idempotencyKey: `nimbus-paypal-owed:${paid.order}` }).catch((error) => {
      console.error("emailing a creator to refund a PayPal payment failed", error);
      return false;
    });
    if (sent) {
      // Kept as sent for as long as the mark. Not written: the claim runs out in an hour and the page says less; the
      // order has left the list, so the email is not sent again.
      await redisPipeline([["SET", toldKey(paid.order), SENT, "EX", KEPT_SECONDS]]).catch((error) => console.error("keeping a PayPal refund email as sent failed", paid.order, error));
      return "owed";
    }
    await releaseMark(toldKey(paid.order), value);
  }
  // Not sent now (refused, or another run holds the claim): tried again later, inside the window.
  if (now >= paid.at + TELL_WINDOW_SECONDS) {
    console.error("the creator could not be emailed to refund a PayPal payment for a removed product; marked, no longer tried", store.handle, paid.order);
    return "owed";
  }
  // The list's score is when it is due less the grace the sweep waits. XX: one a concurrent run took out is not put back.
  await redisPipeline([["ZADD", handOverKey(store.statsId), "XX", String(now + TELL_RETRY_SECONDS - HAND_OVER_GRACE_SECONDS), paid.order]]).catch(() => undefined);
  return "later";
}
