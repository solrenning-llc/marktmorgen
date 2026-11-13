/**
 * One payment's refunds as last read whole from the creator's Stripe, kept a
 * short while so opening the same payment request again does not ask Stripe
 * again (lib/payment-requests.ts, checkRequestRefunds; coordinator's
 * decision C1-20261108-0315-C4-30):
 *
 *   nl:payreq:rf:<sid>:<payment>   the cents Stripe says were refunded, for REFUND_CHECK_SECONDS
 *
 * Only a reading Stripe gave whole, with no refund still under way, is kept.
 * The bound on how old a kept reading can be is REFUND_CHECK_SECONDS: it goes
 * by itself then. A refunded charge seen by the five-minute Stripe events job
 * also forgets it (lib/webhooks.ts, charge.refunded), but that job reads only
 * the stores with an endpoint that wants Stripe events, and usually after the
 * minute has run out, so it helps only sometimes.
 * Its own small file, so the events reader can forget it without loading
 * what payment requests need.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";

/** How long one payment's whole reading is kept: a minute, so a refund made since shows on the next opening after it. */
export const REFUND_CHECK_SECONDS = 60;

const refundCheckKey = (sid: string, payment: string) => `nl:payreq:rf:${sid}:${payment}`;

/**
 * The cents last read as refunded for this payment, or null when none is
 * kept (GET answered null). Throws UnknownReplyError for any other answer:
 * an unknown reading is never a kept one, nor a sure absence.
 */
export async function keptRefundCheck(sid: string, payment: string): Promise<number | null> {
  const replies = repliesFor(await redisPipeline([["GET", refundCheckKey(sid, payment)]]), 1);
  if (!replies) throw new UnknownReplyError("a payment's kept refund check");
  const raw = replies[0];
  if (raw === null) return null;
  if (typeof raw !== "string" || !/^(0|[1-9]\d{0,15})$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new UnknownReplyError("a payment's kept refund check");
  return Number(raw);
}

/** Keeps a whole reading for REFUND_CHECK_SECONDS. Throws UnknownReplyError when the write was not confirmed. */
export async function keepRefundCheck(sid: string, payment: string, refunded: number): Promise<void> {
  const replies = repliesFor(await redisPipeline([["SET", refundCheckKey(sid, payment), String(refunded), "EX", REFUND_CHECK_SECONDS]]), 1);
  if (!replies || replies[0] !== "OK") throw new UnknownReplyError("a payment's refund check kept");
}

/** Forgets this payment's kept reading, so its next opening asks Stripe. Throws UnknownReplyError when the delete was not confirmed. */
export async function forgetRefundCheck(sid: string, payment: string): Promise<void> {
  if (!sid || !payment) return;
  const replies = repliesFor(await redisPipeline([["DEL", refundCheckKey(sid, payment)]]), 1);
  if (!replies || (replies[0] !== 0 && replies[0] !== 1)) throw new UnknownReplyError("a payment's refund check forgotten");
}
