/**
 * A free intro call (551 [FB1], unit 1; lib/free-call-rules.ts; the owner's
 * decision of 2 November 2026, 16h15 Fortaleza). Pure. Checked:
 *
 *   - free calls a month are 20% of the plan's monthly bookings, and the
 *     bookings are the plan's orders over what one booking counts as; none
 *     where the plan takes no orders;
 *   - one more free call is refused, in this order, for a plan with none, a
 *     blocked address, an address with one to come, a month whose free calls
 *     are taken, and a month whose orders are taken (paid ones included):
 *     taken from the plan's own orders, never added to them;
 *   - only a one-to-one call on weekly hours can be free;
 *   - a hold lets go after fifteen minutes and is never renewed.
 */
import { CALL_ORDER_UNITS, ORDERS_INCLUDED, TRIAL_ORDERS } from "@/lib/order-rules";
import { FREE_CALL_HOLDS_PER_DAY, FREE_CALL_HOLD_SECONDS, FREE_CALL_ORDER_UNITS, FREE_CALL_SHARE_PERCENT, buyerRefusal, canBeFree, freeCallAllowed, freeCallsFor, freeCallsMonthly, holdEnds, holding } from "@/lib/free-call-rules";
import { done, is, part } from "./check";

part("How many a month");
is("the owner's share; a free call is taken as one order more than a paid booking, for its confirmation and approval emails", [FREE_CALL_SHARE_PERCENT, CALL_ORDER_UNITS, FREE_CALL_ORDER_UNITS, FREE_CALL_HOLDS_PER_DAY], [20, 2, 3, 3]);
is(
  "a fifth of the bookings the plan's orders cover, rounded down, on each plan and in the trial",
  [freeCallsMonthly(ORDERS_INCLUDED.creator), freeCallsMonthly(ORDERS_INCLUDED.pro), freeCallsMonthly(ORDERS_INCLUDED.scale), freeCallsMonthly(TRIAL_ORDERS)],
  [{ bookings: 100, free: 20 }, { bookings: 225, free: 45 }, { bookings: 750, free: 150 }, { bookings: 50, free: 10 }],
);
is("a store with no plan gets none, by the same reading of its plan as its orders", freeCallsFor({ tier: "creator" } as never).free, 0);
is("none where the plan takes no orders", [freeCallsMonthly(null), freeCallsMonthly(0), freeCallsMonthly(Number.NaN), freeCallsMonthly(1)], [{ bookings: 0, free: 0 }, { bookings: 0, free: 0 }, { bookings: 0, free: 0 }, { bookings: 0, free: 0 }]);

part("One more");
const base = { ordersLimit: 200, usedThisMonth: 0, ordersUsed: 0, toComeForAddress: 0, heldTodayByAddress: 0, blocked: false };
is("allowed when nothing stops it", freeCallAllowed(base), { ok: true });
is(
  "refused, the first reason that holds: no plan, blocked, one to come, the month's free calls, the month's orders",
  [
    freeCallAllowed({ ...base, ordersLimit: null }),
    freeCallAllowed({ ...base, blocked: true, toComeForAddress: 1 }),
    freeCallAllowed({ ...base, toComeForAddress: 1, usedThisMonth: 20 }),
    freeCallAllowed({ ...base, usedThisMonth: 20 }),
    freeCallAllowed({ ...base, ordersUsed: 198 }),
  ],
  [{ ok: false, why: "plan" }, { ok: false, why: "blocked" }, { ok: false, why: "address" }, { ok: false, why: "month" }, { ok: false, why: "orders" }],
);
is("the last three orders that fit are taken, and the last free call of the month", [freeCallAllowed({ ...base, ordersUsed: 197 }), freeCallAllowed({ ...base, usedThisMonth: 19 })], [{ ok: true }, { ok: true }]);
is("an address that held three times today is refused, run out or not", [freeCallAllowed({ ...base, heldTodayByAddress: 2 }), freeCallAllowed({ ...base, heldTodayByAddress: 3 })], [{ ok: true }, { ok: false, why: "address" }]);
is("the person asking is never told they were blocked, nor about the plan", (["plan", "blocked", "month", "orders", "address"] as const).map(buyerRefusal), ["unavailable", "unavailable", "unavailable", "unavailable", "address"]);

part("Which calls");
is("one person per time on weekly hours only", [canBeFree({ kind: "weekly", seats: 1 }), canBeFree({ kind: "weekly", seats: 2 }), canBeFree({ kind: "live", seats: 1 })], [true, false, false]);

part("The hold");
is("fifteen minutes at most", [FREE_CALL_HOLD_SECONDS, holdEnds(1_000)], [900, 1_900]);
is("holding until then, free after, never renewed", [holding(1_000, 1_899), holding(1_000, 1_900), holding(Number.NaN, 0)], [true, false, false]);

done();
