/**
 * The note that a checkout coupon with a fixed id was made on a creator's
 * Stripe account (lib/intro-coupon.ts, lib/fair-coupon.ts).
 *
 * Only a shortcut: Stripe is the record. The coupon's id is fixed, so a note
 * that is lost or cannot be read never makes a second coupon: Stripe answers
 * resource_already_exists, and the coupon found there is used only when it is
 * exactly the one the checkout needs (each caller checks its shape).
 *
 * Each reply is read in its exact shape (rule 24): the note counts only as the
 * string "1" and is written only on "OK". Anything else is said in the log,
 * never passed over in silence, and the next checkout asks Stripe again; the
 * checkout itself goes on, because the coupon it uses was made or verified.
 */
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

/** True only when the note reads exactly "1"; any other answer asks Stripe, said in the log unless it is plain "no note". */
export async function couponNoted(key: string): Promise<boolean> {
  let reply: unknown[] | null;
  try {
    reply = repliesFor(await redisPipeline([["GET", key]]), 1);
  } catch (error) {
    console.error(`could not read a coupon's note (${key}); asking Stripe`, error);
    return false;
  }
  if (reply && reply[0] === "1") return true;
  if (!reply || reply[0] !== null) console.error(`a coupon's note (${key}) answered in an unknown shape; asking Stripe`);
  return false;
}

/** Writes the note; true only on an exact "OK". A note not written is said in the log, and the next checkout asks Stripe. */
export async function noteCoupon(key: string): Promise<boolean> {
  try {
    const reply = repliesFor(await redisPipeline([["SET", key, "1"]]), 1);
    if (reply && reply[0] === "OK") return true;
    console.error(`a coupon's note (${key}) was not written (unknown answer); the next checkout asks Stripe again`);
  } catch (error) {
    console.error(`a coupon's note (${key}) was not written; the next checkout asks Stripe again`, error);
  }
  return false;
}
