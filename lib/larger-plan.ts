/**
 * Whether a store can be told to move to a larger plan (534 [FQ1], unit 41;
 * added 2 November 2026): only while plans are on sale (lib/opening.ts), only
 * to a store that pays for its plan now (not in a trial, not without one), and
 * only when a plan above its own is sold: none above Scale, and Pro only while
 * it is on sale. Anywhere else a sentence offering one would be false.
 */
import { PLANS_ON_SALE } from "@/lib/opening";
import { PRO_ON_SALE, type Tier } from "@/lib/plan";
import { type PlanFields, standingOf } from "@/lib/plan-standing";

/**
 * Whether a plan above this one can be moved to: none above Scale, and none
 * at all while Pro is not on sale, since the switch then takes no plan but
 * the Store one (app/api/billing/switch/route.ts). A store with no tier
 * written is read on the Store plan, as its figures are (allowanceFor).
 */
export function planAboveSold(tier: Tier | undefined, proOnSale = PRO_ON_SALE): boolean {
  const own = tier ?? "creator";
  return own === "creator" || own === "pro" ? proOnSale : false;
}

/** Whether this store can move to a larger plan now. */
export function largerPlanFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000, plansOnSale = PLANS_ON_SALE, proOnSale = PRO_ON_SALE): boolean {
  return plansOnSale && standingOf(store, nowSeconds) === "paid" && planAboveSold(store.tier, proOnSale);
}
