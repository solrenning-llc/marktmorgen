/**
 * A free intro call (551 [FB1], unit 1; the owner's decision of 2 November
 * 2026, 16h15 Fortaleza): the rules, before anything is held or sent. Pure
 * and browser-safe, so the studio shows the same numbers the booking keeps.
 *
 * What the owner decided, and how it is read here:
 *
 *   - Free intro calls are limited to 20% of the plan's monthly bookings,
 *     taken from its own limit, adding nothing. A booking counts as
 *     CALL_ORDER_UNITS orders of the plan's monthly orders (lib/order-rules.ts),
 *     so the plan's monthly bookings are its orders divided by that, and the
 *     free calls a month are a fifth of those, rounded down. Each free call is
 *     taken from the same orders (FREE_CALL_ORDER_UNITS each, below): it never
 *     adds to them.
 *   - Their email and video cost stays inside the worst case the plan already
 *     covers. A paid booking is CALL_ORDER_UNITS orders, which pay for its four
 *     emails (two confirmations, two reminders; tests/plan-cost-registry.ts,
 *     ORDER_COST is two emails). A free call sends more: the link that
 *     confirms it and, when the creator approves each one, a note to approve.
 *     So it is taken from the plan's own orders as FREE_CALL_ORDER_UNITS,
 *     when its time is held and before any email: a hold that runs out has
 *     spent them, so asking again and again only uses up the plan's own
 *     orders, never more. An address may hold at most FREE_CALL_HOLDS_PER_DAY
 *     a day. Video costs nothing per booking here: a call's room is a third
 *     party's or the creator's own (lib/call-rooms.ts).
 *
 * And what the request itself asks (551 [FB1]):
 *
 *   - One person per time, on weekly hours: a free call is never a group, a
 *     dated session, nor bought from a package.
 *   - No Stripe: the time is held for at most FREE_CALL_HOLD_SECONDS and is
 *     booked only when the person opens the link sent to their email; a hold
 *     never renews itself.
 *   - At most one free call to come per email address in each store; an
 *     address the creator blocked is refused; the creator may ask to approve
 *     each one before it is confirmed.
 */
import { CALL_ORDER_UNITS, paidOrdersLimitFor } from "@/lib/order-rules";
import type { PlanFields } from "@/lib/plan-standing";
import type { Tier } from "@/lib/plan";

/** The owner's share of a plan's monthly bookings that free calls may take. */
export const FREE_CALL_SHARE_PERCENT = 20;

/** How long a free call's time is held while its confirmation link waits, at most. */
export const FREE_CALL_HOLD_SECONDS = 15 * 60;

/** Free calls to come one email address may have in one store. */
export const FREE_CALLS_PER_ADDRESS = 1;

/**
 * Orders one free call is taken as: a paid booking's four emails, the link
 * that confirms it and a note to approve it, six emails, three orders' worth.
 */
export const FREE_CALL_ORDER_UNITS = CALL_ORDER_UNITS + 1;

/** Times one email address may hold a free call's time in one store in a day, held or booked. */
export const FREE_CALL_HOLDS_PER_DAY = 3;

/**
 * The bookings a plan's monthly orders cover, and the free calls a month
 * taken from them: none where the plan takes no orders (null or 0).
 */
export function freeCallsMonthly(ordersLimit: number | null): { bookings: number; free: number } {
  if (ordersLimit === null || !Number.isFinite(ordersLimit) || ordersLimit <= 0) return { bookings: 0, free: 0 };
  const bookings = Math.floor(ordersLimit / CALL_ORDER_UNITS);
  return { bookings, free: Math.floor((bookings * FREE_CALL_SHARE_PERCENT) / 100) };
}

/** The free calls a month for a store, from the same reading of its plan as its orders (none with no plan, the trial's in a trial). */
export function freeCallsFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): { bookings: number; free: number } {
  return freeCallsMonthly(paidOrdersLimitFor(store, nowSeconds));
}

/** Whether a call's setup can be a free intro call: one person per time, weekly hours. */
export function canBeFree(setup: { kind: string; seats: number }): boolean {
  return setup.kind === "weekly" && setup.seats === 1;
}

export type FreeCallRefusal = "plan" | "month" | "address" | "blocked" | "orders";

/**
 * What a person asking for a free call is told: that they already have one
 * (or asked too often today), or that none can be booked right now. Never that
 * the creator blocked them, nor anything about the store's plan.
 */
export function buyerRefusal(why: FreeCallRefusal): "address" | "unavailable" {
  return why === "address" ? "address" : "unavailable";
}

/**
 * Whether one more free call may be held now, and why not. Read in this
 * order, so the reason said is the first that holds:
 *
 *   - "plan": the store's plan gives no free calls (no orders this month);
 *   - "blocked": the creator blocked this address;
 *   - "address": this address already has a free call to come here, or has
 *     held FREE_CALL_HOLDS_PER_DAY today;
 *   - "month": this month's free calls are all taken (held or booked);
 *   - "orders": the plan's orders this month cannot take FREE_CALL_ORDER_UNITS
 *     more, paid ones included. This is a check before asking: the booking
 *     still admits them against the store's orders (lib/order-admission.ts,
 *     admitOrders), which also counts the ones being paid for.
 */
export function freeCallAllowed(input: {
  ordersLimit: number | null;
  /** Free calls this month, held or booked, in this store. */
  usedThisMonth: number;
  /** Orders this month, paid and free together, in this store. */
  ordersUsed: number;
  /** Free calls to come for this address in this store, held or booked. */
  toComeForAddress: number;
  /** Holds this address made today in this store, run out or not. */
  heldTodayByAddress: number;
  blocked: boolean;
}): { ok: true } | { ok: false; why: FreeCallRefusal } {
  const { free } = freeCallsMonthly(input.ordersLimit);
  if (free === 0) return { ok: false, why: "plan" };
  if (input.blocked) return { ok: false, why: "blocked" };
  if (input.toComeForAddress >= FREE_CALLS_PER_ADDRESS || input.heldTodayByAddress >= FREE_CALL_HOLDS_PER_DAY) return { ok: false, why: "address" };
  if (input.usedThisMonth >= free) return { ok: false, why: "month" };
  // Taken from the plan's own orders, as a paid booking is: never added to them.
  if (input.ordersLimit !== null && input.ordersUsed + FREE_CALL_ORDER_UNITS > input.ordersLimit) return { ok: false, why: "orders" };
  return { ok: true };
}

/** When a hold made at `heldAt` (seconds) lets go: never later than FREE_CALL_HOLD_SECONDS after it. */
export function holdEnds(heldAt: number): number {
  return heldAt + FREE_CALL_HOLD_SECONDS;
}

/** Whether a hold is still holding at `now` (seconds); one that has run out is free again, never renewed. */
export function holding(heldAt: number, now: number): boolean {
  return Number.isFinite(heldAt) && now < holdEnds(heldAt);
}
