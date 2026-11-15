/**
 * Whether a creator may open a plan checkout in Stripe's test mode, and with
 * which key (444 [TS2] unit 1, docs/plan-test-subscribe.md).
 *
 * "Try the plan checkout" lets a creator in test mode go through the very
 * screen a real subscription goes through, for any plan and interval, with
 * nothing charged and nothing switched on. It must never be a way to a real
 * subscription, so the decision is made here, once, and opens only when every
 * one of these holds:
 *
 *   1. The switch is on: STORE_TEST_MODE_ON (443 [TS1] unit 1, false until its
 *      exposure review passes), passed in by the caller.
 *   2. The store is in test mode, read as a boolean. A mode that could not be
 *      read is not "off" and not "on": it refuses.
 *   3. The choice is a plan and an interval of lib/plan.ts.
 *   4. The test key is a test key (planTestKey): a key Stripe will not let
 *      move real money.
 *   5. Our own platform key is a live key. Stripe keeps test and live objects
 *      apart, so the real way back, the daily sync, the subscription search and
 *      the trial history, all signed with the live key, can never see what a
 *      test checkout makes. While the site itself runs on a test key, or on
 *      none, the two would not be apart, and nothing opens.
 *
 * It reads no gate and changes none: PLANS_ON_SALE, OPENING_REQUESTED, the tax
 * gate, art. 9a, the commercial review and the platform eligibility stay what
 * they are, and the real checkout (app/api/billing/checkout) keeps refusing
 * on its own. Nothing here asks Stripe or Redis anything.
 */
import { parseCycle, parseTier, type Cycle, type Tier } from "@/lib/plan";

/**
 * Where the test key is read from. The owner chooses which key it is (TS1,
 * "What depends on the owner": the demo's own key, if its account matches the
 * live platform's settings, or a new test key of the platform's account); the
 * demo's key is never taken in its place without that choice.
 */
export const PLAN_TEST_KEY_ENV = "STRIPE_TEST_SECRET_KEY";

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/;
const LIVE_KEY = /^(sk|rk)_live_[A-Za-z0-9]+$/;

/** The key a test plan checkout is signed with, or null: anything but a test key is refused, never used. */
export function planTestKey(): string | null {
  const key = process.env[PLAN_TEST_KEY_ENV]?.trim();
  return key && TEST_KEY.test(key) ? key : null;
}

/** Whether our own platform key is a live one, so the two modes are kept apart by Stripe itself. */
function platformKeyIsLive(): boolean {
  return LIVE_KEY.test(process.env.STRIPE_SECRET_KEY?.trim() ?? "");
}

export type PlanTestRefusal =
  | "switch-off"
  | "store-not-in-test"
  | "store-mode-unknown"
  | "choice"
  | "no-test-key"
  | "modes-not-apart";

export type PlanTestDecision =
  | { open: true; mode: "test"; key: string; tier: Tier; cycle: Cycle }
  | { open: false; reason: PlanTestRefusal };

export function decidePlanTestCheckout(input: {
  /** STORE_TEST_MODE_ON (443 [TS1] unit 1). */
  switchOn: boolean;
  /** The store's own test mode; null when it could not be read. */
  storeInTestMode: boolean | null;
  /** As the form sent them. */
  tier: unknown;
  cycle: unknown;
}): PlanTestDecision {
  if (input.switchOn !== true) return { open: false, reason: "switch-off" };
  if (input.storeInTestMode === false) return { open: false, reason: "store-not-in-test" };
  if (input.storeInTestMode !== true) return { open: false, reason: "store-mode-unknown" };
  const tier = parseTier(input.tier);
  const cycle = parseCycle(input.cycle);
  if (!tier || !cycle) return { open: false, reason: "choice" };
  const key = planTestKey();
  if (!key) return { open: false, reason: "no-test-key" };
  if (!platformKeyIsLive()) return { open: false, reason: "modes-not-apart" };
  return { open: true, mode: "test", key, tier, cycle };
}
