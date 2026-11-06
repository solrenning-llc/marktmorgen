/**
 * Whether a paid PayPal order was handed over, for the thanks page (PF1, Claude 5's MEDIUM on #2911).
 *
 * The only proof is this very order's grant: deliverPayPal (lib/paypal-sales.ts) writes the buyer's record
 * `nl:imp:buy:<statsId>:<address hash>` field <product> = { job: "paypal:<order>", ... } as its first step of the
 * hand-over. The pending mark is no proof: settle() clears it BEFORE anything is handed over, so a paid order with no
 * mark may still be waiting for (or have failed) its hand-over.
 *
 *   true       the grant is there and names this order
 *   false      no grant, or a grant written by another payment, gift or import (this order's hand-over not proven)
 *   "unknown"  the read failed or did not answer in its exact shape: never taken as handed over
 *
 * One HGET, read in its exact envelope (lib/redis-reply.ts), as the refund watch reads the same record.
 */
import { importedKey } from "@/lib/imported-purchases";
import type { Paid } from "@/lib/paypal-sales";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

export async function paypalHandedOver(paid: Pick<Paid, "store" | "email" | "product" | "order">): Promise<boolean | "unknown"> {
  if (!isRedisConfigured() || !paid.store || !paid.email || !paid.product || !paid.order) return "unknown";
  const read = repliesFor(await redisPipeline([["HGET", importedKey(paid.store, paid.email), paid.product]]), 1);
  if (!read) return "unknown";
  const given = read[0];
  if (given === null) return false;
  if (typeof given !== "string") return "unknown";
  let value: unknown;
  try {
    value = JSON.parse(given);
  } catch {
    return "unknown";
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { job?: unknown }).job !== "string") return "unknown";
  return (value as { job: string }).job === `paypal:${paid.order}`;
}
