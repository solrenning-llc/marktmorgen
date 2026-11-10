/**
 * The numbers "Do this next" is chosen from (484 [IT1] complement WG, unit 2; lib/next-actions-rules.ts has the
 * rules). Only readings the studio already keeps, never a new one:
 *
 *   - the store's kept memberships reading (lib/store-readings.ts, keptMembersCopy): one GET of the copy the
 *     memberships page and the totals already keep, no call to Stripe and nothing taken from the day's readings.
 *     That GET is inside the three kept readings KEPT_READINGS_SHAPE prices for each studio page (lib/read-ceilings.ts,
 *     priced in tests/plan-cost-registry.ts), so the page costs what it already cost: the ceiling is set before the
 *     read, and this file reads nothing else.
 *   - the store's record, already read for the page (whether it sells memberships, whether its come-back email is on).
 *
 * From the copy: the paying members whose latest payment failed and is being retried (Numbers.atRisk, with what they
 * pay a month, atRiskMrr), and, while the come-back email is off (lib/winback.ts, winbackOn), the members who left in
 * the last 30 days (ended30, endedMrr30). The other actions are not read here yet: left out, never said to be missing.
 *
 * Rule 24 (CX-123): a copy that could not be read, or is not in its shape, is "unknown" (each count null), never
 * none; a reading that did not read every membership (`complete` false) counts too few, so its counts are unknown as
 * well. No copy kept is no reading on this screen: nothing is shown, and nothing is said to be missing.
 */
import type { NextFacts } from "@/lib/next-actions-rules";
import type { Numbers } from "@/lib/membership-numbers";
import { sellsMemberships } from "@/lib/membership-manage";
import { keptMembersCopy } from "@/lib/store-readings";
import type { Store } from "@/lib/store";
import { winbackOn } from "@/lib/winback";

export type NextReadDeps = {
  copy: (store: Store) => Promise<{ at: number; value: Numbers | null } | null | "unknown">;
  sells: (store: Store) => boolean;
};

const LIVE: NextReadDeps = { copy: keptMembersCopy, sells: sellsMemberships };

const whole = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** The facts for this store, from its kept readings only. Never throws: what fails is unknown. */
export async function nextFactsOf(store: Store, deps: NextReadDeps = LIVE): Promise<NextFacts> {
  let sells: boolean;
  try {
    sells = deps.sells(store);
  } catch {
    sells = false;
  }
  if (!sells) return {};
  const askWinback = !winbackOn(store);
  const unknown = (): NextFacts => ({
    failedPayments: { count: null, at: null },
    ...(askWinback ? { formerMembers: { count: null, at: null } } : {}),
  });
  let copy: Awaited<ReturnType<NextReadDeps["copy"]>>;
  try {
    copy = await deps.copy(store);
  } catch {
    return unknown();
  }
  if (copy === null) return {};
  if (copy === "unknown") return unknown();
  // A reading that found no store counts at all: nothing to say.
  if (copy.value === null) return {};
  const numbers = copy.value;
  if (numbers.complete !== true) return unknown();
  const at = copy.at;
  const currency = typeof numbers.currency === "string" ? numbers.currency : "";
  const money = (amount: unknown) => {
    const cents = whole(amount);
    return cents === null || !currency ? null : { amount: cents, currency };
  };
  return {
    failedPayments: { count: whole(numbers.atRisk), monthly: money(numbers.atRiskMrr), at },
    ...(askWinback ? { formerMembers: { count: whole(numbers.ended30), monthly: money(numbers.endedMrr30), at } } : {}),
  };
}
