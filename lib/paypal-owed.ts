/**
 * A PayPal payment owed back to its buyer: PayPal took it (its capture COMPLETED, so settle in lib/paypal-sales.ts wrote
 * its paid record), this order's own hand-over never ran, and the product it bought is no longer in the store (the
 * owner's decision 2 of C1-20261109-1029-C5-52). Before 9 November 2026 such an order only left the hand-over list with
 * a log line: the buyer got nothing, nobody refunded them and the creator was never told. A buyer who already held the
 * product through another grant (a gift, an import, an earlier order) is owed this payment too: that grant is not this
 * order's hand-over (Claude 1's pre-review MEDIUM 2).
 *
 * The refund itself is not made here. The owner decided it should be automatic, but this repository has no call to
 * PayPal's refund of a capture, and PayPal's official documentation of that call (its request, its states, its
 * idempotency) was not readable when this was built; a call that moves money is not written from memory. So, until it
 * is: the order is marked "refund owed", and the creator is emailed once to refund the payment in full in their own
 * PayPal account. The buyer's page reads both and says only what is so. When the refund is made in PayPal, the refund
 * watch takes it in as for any other order (watchPayPal), and the page says "refunded".
 *
 * Each step is read exactly (CX-123 rule 24): a read that is unknown throws, and the order stays on the hand-over list
 * for the sweep to try again (lib/paypal-delivery.ts). The email is sent at most once, ever: it is claimed first
 * (lib/claim-mark.ts) for as long as the mark, and the claim is never let go. sendEmail answers false both when the
 * sender refused it and when it may have taken it with its answer lost (SES's lost acknowledgement, whose once-only
 * marker lasts a day), and lib/email.ts does not tell the two apart; so a false is "unsure": not sent again, the order
 * leaves the list marked, the buyer's page says the creator could not be confirmed told, and the log says so (Claude
 * 1's pre-review ALTO 1). Telling a sure refusal from an uncertain send, to try the former again, waits for a
 * sendEmail that says which (a separate unit). A claim another run holds is in flight for up to CLAIM_IN_FLIGHT_SECONDS:
 * the order is left on the list for the next sweep; older, it is unsure too.
 *
 *   nl:ppsell:owed:<statsId>        sorted set: the store's orders whose refund is owed, scored by when (400 days)
 *   nl:ppsell:owed:told:<order>     the creator's email about one of them: its claim, then "sent" or "unsure" (400 days)
 *
 * Neither holds anything about the buyer: the paid record (lib/paypal-sales.ts) holds the order, and the email names
 * only PayPal's transaction id, the amount and the date. Cost: the email takes the order's own place for its receipt
 * (meter "order"), which is not sent, and the order is counted as one of the month's, as a hand-over counts it
 * (PAYPAL_REFUND_OWED in tests/plan-cost-registry.ts).
 */
import { claimMark, claimValue } from "@/lib/claim-mark";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { formatMoney } from "@/lib/money";
import { countOrder } from "@/lib/orders";
import { paypalHandedOver } from "@/lib/paypal-handed";
import type { Paid } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";
import type { Store } from "@/lib/store";

/** How long a mark and its email's state are kept: as long as the paid record (PAID_KEPT_SECONDS in lib/paypal-sales.ts). */
const KEPT_SECONDS = 400 * 86_400;
/** How long a claim another run holds is taken as that run still sending; past it, the email is unsure. */
export const CLAIM_IN_FLIGHT_SECONDS = 3600;
const SENT = "sent";
const UNSURE = "unsure";

export const owedKey = (statsId: string) => `nl:ppsell:owed:${statsId}`;
const toldKey = (order: string) => `nl:ppsell:owed:told:${order}`;
/** A mark's score as this file writes it: whole seconds. */
const SCORE = /^[1-9]\d{0,11}$/;

/** What the email's state says: sent, unsure (refused, its answer lost, or a claim left past CLAIM_IN_FLIGHT_SECONDS), or not yet. */
function toldState(value: unknown, now: number): "sent" | "unsure" | "not yet" {
  if (value === SENT) return "sent";
  if (value === UNSURE) return "unsure";
  // A claim's value starts with the time it was taken, in milliseconds (lib/claim-mark.ts, claimValue).
  const at = typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(at) && now * 1000 - at < CLAIM_IN_FLIGHT_SECONDS * 1000 ? "not yet" : value === null ? "not yet" : "unsure";
}

/**
 * This order's refund, read exactly for the buyer's page (one pipeline: ZSCORE, GET): "told" when it is owed and the
 * creator's email was taken by the sender, "unsure" when it is owed and the email went without that being confirmed,
 * "owed" when it is owed and the email has not gone yet, false when it is not owed, "unknown" when the mark's reply is
 * not one of those. An email state that does not read is taken as unsure: the page then says less, never more.
 */
export async function refundOwed(statsId: string, order: string, now = Math.floor(Date.now() / 1000)): Promise<"told" | "unsure" | "owed" | false | "unknown"> {
  const read = repliesFor(await redisPipeline([["ZSCORE", owedKey(statsId), order], ["GET", toldKey(order)]]), 2);
  if (!read) return "unknown";
  if (read[0] === null) return false;
  if (typeof read[0] !== "string" || !SCORE.test(read[0])) return "unknown";
  const told = read[1] === null || typeof read[1] === "string" ? toldState(read[1], now) : "unsure";
  return told === "sent" ? "told" : told === "unsure" ? "unsure" : "owed";
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
      "The buyer's order page now says the product is no longer available and that this payment is owed back to them. Once PayPal shows the refund, the page says so.",
      "",
      "Marktmorgen does not refund PayPal payments for you: the money is in your own PayPal account.",
      "",
      "This email comes once for this payment.",
    ].join("\n"),
  };
}

/**
 * For a paid order whose product the store no longer has:
 *   "owed"        marked, and its creator emailed once (sent, or unsure): it leaves the hand-over list;
 *   "later"       marked, another run holds the email's claim: it stays on the list for the next sweep;
 *   "handed"      this order's own hand-over ran before the product went: nothing owed;
 *   "taken back"  PayPal took the payment back meanwhile: nothing owed.
 * Throws, when a read or a write is unknown, before anything is sent.
 */
export async function owePayPalRefund(store: Store, paid: Paid, now = Math.floor(Date.now() / 1000)): Promise<"owed" | "later" | "handed" | "taken back"> {
  if (!store.statsId || !isRedisConfigured()) throw new UnknownReplyError("a PayPal order's refund owed (no store records)");
  // This order's own hand-over is the condition: the buyer's grant, read exactly (lib/paypal-handed.ts). "owned" is a
  // grant of another job (a gift, an import, an earlier order) holding the product: not this order's hand-over.
  const handed = await paypalHandedOver(paid);
  if (handed === "unknown") throw new UnknownReplyError("a PayPal order's hand-over");
  if (handed === true) return "handed";
  if (handed !== false && handed !== "owned") return "taken back";
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
  if (marked[3] !== null) return toldState(marked[3], now) === "not yet" ? "later" : "owed";
  const claim = await claimMark(toldKey(paid.order), KEPT_SECONDS, claimValue(now * 1000));
  if (claim === "unknown") throw new UnknownReplyError("a PayPal refund email's claim");
  if (claim === "taken") return "later";
  const { subject, text } = owedEmail(store, paid);
  const sent = await sendEmail({ meter: { by: "order" }, from: NIMBUS_FROM, to: store.email, subject, text, idempotencyKey: `nimbus-paypal-owed:${paid.order}` }).catch((error) => {
    console.error("emailing a creator to refund a PayPal payment failed", error);
    return false;
  });
  if (!sent) console.error("the email asking a creator to refund a PayPal payment was not confirmed sent; never sent again", store.handle, paid.order);
  // The claim is never let go, so the email is never sent twice. Not written: the claim stays, and runs out of its
  // in-flight time into "unsure", which the page then says (less than "sent", never more).
  await redisPipeline([["SET", toldKey(paid.order), sent ? SENT : UNSURE, "XX", "EX", KEPT_SECONDS]]).catch((error) => console.error("keeping a PayPal refund email's state failed", paid.order, error));
  return "owed";
}
