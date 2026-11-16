/**
 * Whether a paid PayPal order was handed over, for the thanks page (PF1, Claude 5's MEDIUM on #2911).
 *
 * The proof is the buyer's grant: deliverPayPal (lib/paypal-sales.ts) writes the buyer's record
 * (importedKey: the store's imported purchases for that address) field <product> = { job: "paypal:<order>", ... } as
 * its first step of the hand-over. The pending mark is no proof: settle() clears it BEFORE anything is handed over, so a paid order with no
 * mark may still be waiting for (or have failed) its hand-over.
 *
 * grantImported writes with HSETNX, so the record keeps the FIRST grant's job (the Claude 4 team's re-review of #2911):
 * when the address already held the product (an earlier PayPal purchase, a gift, an import, a place), this order's own
 * hand-over leaves the earlier job there. Then the address holds what it bought, and this order counts as handed over
 * only while it is one of the paid orders standing behind that product (the set ownKey names, written by settle() and
 * taken off when PayPal refunds it in full), read exactly.
 *
 *   true       the grant names this order: this order's own hand-over ran
 *   "owned"    another grant holds the product and this order stands behind it: paid, and the buyer holds it, but this
 *              order's own hand-over (its receipt among it) is not proven
 *   "refunded" no grant (or not standing behind another), and PayPal's full refund of this order was taken in by the
 *              refund watch (its mark in refundedKey, read exactly): nothing is being handed over, ever (the Claude 4
 *              team's second money review of #2911)
 *   "reversed" the same, but PayPal took the payment back by another way than a refund (a capture reversed, failed or
 *              declined: its mark in reversedKey too, read exactly), so the page never says "refunded" of it
 *              (pre-review MEDIUM on C4-13)
 *   false      no grant; or another grant holds it and this order does not stand behind it; and no refund mark
 *   "unknown"  a read failed or did not answer in its exact shape: never taken as handed over
 *
 * One HGET, read in its exact envelope (lib/redis-reply.ts), as the refund watch reads the same record; one
 * SISMEMBER more only when the grant names another job; one ZSCORE of the refund mark more only before answering false;
 * one ZSCORE of the taken-back mark more only when the refund mark is there.
 */
import { importedKey } from "@/lib/imported-purchases";
import { type Paid, ownKey, refundedKey, reversedKey } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

/** A refund mark's score: the time the watch took the refund in (as lib/paypal-sales.ts writes it with ZADD). */
const REFUND_SCORE = /^[1-9]\d{0,11}$/;

/** One mark's ZSCORE, read exactly: true, false, or "unknown". */
async function marked(key: string, order: string): Promise<boolean | "unknown"> {
  const read = repliesFor(await redisPipeline([["ZSCORE", key, order]]), 1);
  if (!read) return "unknown";
  if (read[0] === null) return false;
  return typeof read[0] === "string" && REFUND_SCORE.test(read[0]) ? true : "unknown";
}

/**
 * Whether the refund watch took this whole payment back, and how: "refunded" (a refund in full), "reversed" (reversed,
 * failed or declined: the watch writes that mark before the refund mark), false, or "unknown" (either read failed).
 */
async function takenBack(paid: Pick<Paid, "store" | "order">): Promise<"refunded" | "reversed" | false | "unknown"> {
  const refunded = await marked(refundedKey(paid.store), paid.order);
  if (refunded !== true) return refunded;
  const reversed = await marked(reversedKey(paid.store), paid.order);
  return reversed === "unknown" ? "unknown" : reversed ? "reversed" : "refunded";
}

export async function paypalHandedOver(paid: Pick<Paid, "store" | "email" | "product" | "order">): Promise<boolean | "owned" | "refunded" | "reversed" | "unknown"> {
  if (!isRedisConfigured() || !paid.store || !paid.email || !paid.product || !paid.order) return "unknown";
  const read = repliesFor(await redisPipeline([["HGET", importedKey(paid.store, paid.email), paid.product]]), 1);
  if (!read) return "unknown";
  const given = read[0];
  // No grant: being handed over, or taken back after PayPal refunded it in full (the watch removes the grant and keeps
  // the paid record); only the refund mark tells them apart, and the taken-back mark tells a refund from the rest.
  const notHanded = (): Promise<false | "refunded" | "reversed" | "unknown"> => takenBack(paid);
  if (given === null) return notHanded();
  if (typeof given !== "string") return "unknown";
  let value: unknown;
  try {
    value = JSON.parse(given);
  } catch {
    return "unknown";
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { job?: unknown }).job !== "string") return "unknown";
  if ((value as { job: string }).job === `paypal:${paid.order}`) return true;
  // Another grant holds the product: while this order stands behind it, the buyer holds what it bought ("owned"). That
  // proves the payment and the access, not that this order's own hand-over ran: settle() adds the order to the set
  // before anything is handed over, so its receipt is never promised on it (Claude 5's LOW on #2911). SISMEMBER answers
  // 0 or 1; anything else is unknown, never "owned" and never "not yet".
  const stands = repliesFor(await redisPipeline([["SISMEMBER", ownKey(paid.store, paid.email, paid.product), paid.order]]), 1);
  if (!stands || (stands[0] !== 0 && stands[0] !== 1)) return "unknown";
  return stands[0] === 1 ? "owned" : notHanded();
}
