/**
 * Makes the plan refund that lib/plan-refund.ts reads (305 [SY1] unit 2a):
 * the money only. Ending the subscription and closing the store's paid
 * features, the button, its review page and the confirmation email are the
 * next unit; nothing calls this yet, and no route may call it without them.
 *
 * Never twice:
 *   - one store at a time: a lock (lockKeyOf, lib/redis-lock.ts: SET NX
 *     with LOCK_SECONDS, released only by its holder), so a double click or
 *     two tabs do not both go through (the second is told "busy");
 *   - read again under the lock: the amount is what the published policy
 *     gives now, after what was refunded already (planRefund takes
 *     `amount_refunded` off), so once given it is not given again;
 *   - the charge's own refunds are read first (GET /v1/refunds?charge=,
 *     newest first, at most 100): one still pending or waiting for an action
 *     means nothing new is made ("pending") until it settles;
 *   - the refund carries a Stripe idempotency key made of the charge and the
 *     number of its refunds that failed or were canceled: a retry, a time-out
 *     or a crash after Stripe made it replays Stripe's first answer for 24
 *     hours instead of making a second, and only a refund the bank turned
 *     down (which gives the money back to the charge) is made again.
 * The lock is released at the end, even on an error; if the process dies it
 * expires by itself after LOCK_SECONDS. The reading's budget only stops new
 * requests, so its last one may run a whole STRIPE_TIMEOUT_MS past it: the
 * lock covers the budget, three time-outs (that last read, the list, the
 * write) and a minute, and no write starts later than WRITE_BY_MS after the
 * lock was taken, so a write always ends while the lock still holds.
 *
 * Bounded: one reading (lib/plan-refund.ts, at most MAX_CALLS requests), one
 * list and one write.
 */
import { onPlatformAt } from "@/lib/billing";
import { STRIPE_TIMEOUT_MS } from "@/lib/fetch-timeout";
import { MAX_PARTS, READ_BUDGET_MS, readPlanRefund } from "@/lib/plan-refund";
import { isRedisConfigured } from "@/lib/redis";
import { LockBusyError, releaseLock, takeLock } from "@/lib/redis-lock";
import type { Store } from "@/lib/store";

const AT = "2024-06-20";
/** The lock of one store's plan refund. */
export const lockKeyOf = (sid: string): string => `nl:plan-refund:${sid}:lock`;
/** The reading's budget, its last read's time-out, a list and a write for each payment given back, and a minute of room. */
export const LOCK_SECONDS = Math.ceil((READ_BUDGET_MS + (1 + 2 * MAX_PARTS) * STRIPE_TIMEOUT_MS) / 1000) + 60;
/** The last moment after taking the lock a write may start: it ends, time-out included, a minute before the lock expires. */
export const WRITE_BY_MS = (LOCK_SECONDS - 60) * 1000 - STRIPE_TIMEOUT_MS;
const REFUND_ID = /^re_[A-Za-z0-9]{6,128}$/;

export type PlanRefundMade =
  | { ok: true; cents: number; currency: string; refundId: string; refundIds: string[]; status: "succeeded" | "pending" }
  | { ok: false; reason: "busy" | "no_lock" | "not_owed" | "unknown" | "pending" | "failed" | "changed" };

type Row = Record<string, unknown>;
const rows = (page: Row): Row[] => (Array.isArray(page.data) ? (page.data as unknown[]).filter((r): r is Row => Boolean(r) && typeof r === "object") : []);

/**
 * `expectCents`: the amount the creator was shown and confirmed (the review page). When the policy gives another
 * amount now (a month of a yearly plan started meanwhile), nothing is made ("changed"), for the page to show the new one.
 */
export async function refundPlanPayment(
  store: Store,
  nowSeconds = Math.floor(Date.now() / 1000),
  expectCents?: number,
  onPlan?: (parts: { chargeId: string; cents: number }[]) => Promise<unknown>,
): Promise<PlanRefundMade> {
  if (!isRedisConfigured()) return { ok: false, reason: "no_lock" };
  let held;
  const takenAt = Date.now();
  try {
    held = await takeLock(lockKeyOf(store.sid), LOCK_SECONDS, 0);
  } catch (error) {
    if (error instanceof LockBusyError) return { ok: false, reason: "busy" };
    throw error;
  }
  try {
    const reading = await readPlanRefund(store, nowSeconds);
    // Not decidable (a failed read, a list too long…): said so, for the page to send the creator to support.
    if (reading.refund.kind === "unknown") return { ok: false, reason: "unknown" };
    if (!("chargeId" in reading)) return { ok: false, reason: "not_owed" };
    const { currency, parts } = reading;
    const cents = reading.refund.cents;
    if (expectCents !== undefined && cents !== expectCents) return { ok: false, reason: "changed" };
    if (!parts.length || parts.reduce((sum, part) => sum + part.cents, 0) !== cents) return { ok: false, reason: "unknown" };
    // Every charge's refunds read before anything is made: one still on its way, or a list not read whole, makes nothing.
    const turnedDown: number[] = [];
    for (const part of parts) {
      let refunds: Row[];
      try {
        const page = await onPlatformAt(AT, "GET", `/refunds?${new URLSearchParams({ charge: part.chargeId, limit: "100" })}`);
        if (page.has_more !== false) return { ok: false, reason: "failed" };
        refunds = rows(page);
      } catch (error) {
        console.error("reading a plan payment's refunds failed", error);
        return { ok: false, reason: "failed" };
      }
      if (refunds.some((r) => r.status === "pending" || r.status === "requires_action")) return { ok: false, reason: "pending" };
      if (refunds.some((r) => typeof r.status !== "string" || !["succeeded", "failed", "canceled"].includes(r.status))) return { ok: false, reason: "failed" };
      turnedDown.push(refunds.filter((r) => r.status === "failed" || r.status === "canceled").length);
    }
    // The charges about to be refunded, for the caller to note before any money moves (lib/plan-refund-flow.ts).
    if (onPlan) await onPlan(parts.map((part) => ({ chargeId: part.chargeId, cents: part.cents })));
    const made: { id: string; pending: boolean }[] = [];
    for (const [i, part] of parts.entries()) {
      // Too late to be sure this write ends while the lock holds: stopped here, the creator may ask again (what was
      // made is not made again: the reading takes it off, and each charge keeps its own idempotency key).
      if (Date.now() - takenAt > WRITE_BY_MS) return { ok: false, reason: "failed" };
      try {
        const refund = await onPlatformAt(
          AT,
          "POST",
          "/refunds",
          new URLSearchParams({ payment_intent: part.paymentIntent, amount: String(part.cents), reason: "requested_by_customer", "metadata[plan_refund]": store.sid }),
          `plan-refund:${part.chargeId}:${turnedDown[i]}`,
        );
        const refundId = typeof refund.id === "string" ? refund.id : "";
        if (refund.object !== "refund" || !REFUND_ID.test(refundId) || refund.amount !== part.cents || refund.currency !== currency) return { ok: false, reason: "failed" };
        if (refund.status !== "succeeded" && refund.status !== "pending" && refund.status !== "requires_action") return { ok: false, reason: "failed" };
        made.push({ id: refundId, pending: refund.status !== "succeeded" });
      } catch (error) {
        console.error("making a plan refund failed", error);
        return { ok: false, reason: "failed" };
      }
    }
    return { ok: true, cents, currency, refundId: made[0].id, refundIds: made.map((m) => m.id), status: made.some((m) => m.pending) ? "pending" : "succeeded" };
  } finally {
    // Only our own lock: one that expired and was taken by another request is left alone.
    await releaseLock(held);
  }
}
