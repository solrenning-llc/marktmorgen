/**
 * A membership sold to end after a set number of payments ("12 monthly
 * payments") is given that end as Stripe's cancel_at as soon as it is bought,
 * even in its free trial (lib/plans.ts, finishPlan). That cancel_at is the end
 * that was sold, not a choice anybody made to leave: the member can still
 * cancel it, as the thanks page, the confirmation email and the store's facts
 * promise. A cancel_at before that end is a cancellation, the member's or the
 * creator's.
 *
 * The end is worked out exactly as finishPlan works it out, from the same
 * fields, so the two can only agree (tests/fixed-end-cancel.test.ts checks
 * the end finishPlan writes is read back as the sold one).
 */
import { addPeriods } from "@/lib/plans";
import { isInterval } from "@/lib/product-recurring";

export type FixedEndSub = {
  metadata?: Record<string, string> | null;
  cancel_at?: unknown;
  trial_end?: unknown;
  billing_cycle_anchor?: unknown;
  current_period_end?: unknown;
  ended_at?: unknown;
  items?: { data?: { current_period_end?: unknown }[] };
};

const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Whether this subscription was sold to end after a set number of payments. */
export function hasSoldEnd(sub: FixedEndSub): boolean {
  return Boolean(sub.metadata?.ends_after) && sub.metadata?.kind !== "plan";
}

/**
 * The moment the end that was sold falls, in seconds; 0 when it was not sold
 * with one, or when it cannot be read. A caller treats 0 on a fixed-end
 * membership as unknown, never as "no end".
 */
export function soldEndOf(sub: FixedEndSub): number {
  if (!hasSoldEnd(sub)) return 0;
  const payments = Number(sub.metadata?.ends_after);
  const named = sub.metadata?.ends_interval;
  const interval = isInterval(named) ? named : "month";
  // After a free trial the first payment is taken when it ends; finishPlan
  // counts from the later of the two, and so does this.
  const anchor = Math.max(seconds(sub.billing_cycle_anchor), seconds(sub.trial_end));
  if (!Number.isInteger(payments) || payments < 2 || !anchor) return 0;
  return addPeriods(anchor, interval, payments);
}

/** The end of the period already paid for (or of the free trial), in seconds; 0 when Stripe gave none. */
export function currentPeriodEnd(sub: FixedEndSub): number {
  // Stripe moved the period's end onto the items in 2025; an older account
  // may still carry it on the subscription.
  return seconds(sub.items?.data?.[0]?.current_period_end) || seconds(sub.current_period_end);
}

/**
 * Whether a fixed-end membership is set to stop, or stopped, before the end
 * that was sold: the member or the creator cancelled it. False when it was not
 * sold with one or that end cannot be read (counted as before, a completion).
 */
export function stopsBeforeSoldEnd(sub: FixedEndSub): boolean {
  const sold = soldEndOf(sub);
  if (!sold) return false;
  const at = seconds(sub.cancel_at);
  const ended = seconds(sub.ended_at);
  return (at > 0 && at < sold) || (ended > 0 && ended < sold);
}

/**
 * Whether the cancel_at on a fixed-end membership is still just the end that
 * was sold, with payments left to come: the member may cancel it. False when
 * it is set to stop sooner (cancelled), when the period paid for already runs
 * to the end (nothing left to cancel), and when either end cannot be read.
 */
export function onlySoldEnd(sub: FixedEndSub): boolean {
  const at = seconds(sub.cancel_at);
  if (!at || !hasSoldEnd(sub)) return false;
  const sold = soldEndOf(sub);
  const period = currentPeriodEnd(sub);
  return sold > 0 && at >= sold && period > 0 && period < sold;
}
