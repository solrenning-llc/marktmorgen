/**
 * The tests' own forget of one payment's kept refund reading (lib/payment-request-refund-cache.ts). It lives here,
 * not in lib/, so no production caller can drop a reading (Codex X6's LOW on #3291, 7046132508): the reading goes
 * only by itself, REFUND_CHECK_SECONDS after it was kept. Read exactly: only 0 or 1 is a deletion.
 */
import { refundCheckKey } from "@/lib/payment-request-refund-cache";
import { store as redis } from "./redis-stub";

export async function forgetRefundCheck(sid: string, payment: string): Promise<void> {
  if (!sid || !payment) return;
  const [gone] = (await redis.pipeline([["DEL", refundCheckKey(sid, payment)]])) as unknown[];
  if (gone !== 0 && gone !== 1) throw new Error("a payment's refund check was not forgotten exactly");
}
