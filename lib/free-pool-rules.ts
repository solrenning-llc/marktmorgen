/**
 * The shared ceiling on stores that pay nothing (added 17 October 2026, the
 * owner's decision "Teto mínimo pago pela empresa", AGENTS.md).
 *
 * A store in its free trial, a store with no plan and a store whose plan
 * ended bring in nothing, so no margin can be worked out on them. Each has
 * small allowances of its own (lib/store-allowance-rules.ts, the trial's
 * visits, orders and emails...), and until now there was no bound on how
 * many of them there could be at once: a thousand trials started in a month
 * cost a thousand trials' worst windows, with nothing paid.
 *
 * Now a store that pays nothing must hold one of the month's places before
 * anything it does costs us: its studio, its public pages and requests, its
 * orders and free copies, its emails (lib/free-pool.ts). The places in a
 * calendar month (UTC) are
 *
 *   FREE_POOL_BASE_STORES + floor(paying stores / PAID_STORES_PER_FREE_STORE)
 *
 * so the pool grows only with the stores that pay for it:
 *
 *   - each paying store carries 1/PAID_STORES_PER_FREE_STORE of the worst a
 *     store that pays nothing can cost in a window, and that share is a line
 *     of every plan's worst month (tests/plan-cost-registry.ts, free-share),
 *     held with the rest to the owner's 60%;
 *   - FREE_POOL_BASE_STORES are the minimum the company pays for itself, so a
 *     new creator can try the product before anyone pays: a fixed cost, at
 *     most FREE_POOL_BASE_STORES times that worst window a month, covered by
 *     the minimum paid base like the other fixed costs
 *     (docs/funded-exposure-review.md).
 *
 * A store past the places is told so plainly, and nothing it does costs us
 * until the month turns or its plan is paid. A store already holding a place
 * keeps it for the month. The places are counted by store, never by person.
 */
export const FREE_POOL_BASE_STORES = 10;
export const PAID_STORES_PER_FREE_STORE = 40;

/** The stores that pay us now: kept by the one place a plan is written down (lib/store.ts, setSubscription). */
export const PAYING_INDEX = "nl:plan:paying";

/** The places this calendar month, for this many paying stores. */
export function freePoolSize(paying: number): number {
  const counted = Number.isSafeInteger(paying) && paying > 0 ? paying : 0;
  return FREE_POOL_BASE_STORES + Math.floor(counted / PAID_STORES_PER_FREE_STORE);
}

/** What a store past the places is told, in the studio. */
export const POOL_FULL_WORDS =
  "Stores without a paid plan are full for this month, so this can't run right now. It opens again on the 1st (UTC).";

/** The same, with the way out a paid plan gives, said only while a plan can be bought (PLANS_ON_SALE, passed in so this file stays browser-safe). */
export function poolFullWords(plansOnSale: boolean): string {
  return plansOnSale ? `${POOL_FULL_WORDS} A paid plan opens it at once.` : POOL_FULL_WORDS;
}
