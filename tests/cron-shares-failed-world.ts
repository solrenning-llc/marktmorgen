/**
 * Stand-ins for tests/cron-shares-failed.test.ts: the share is taken as live (COMMISSION_LIVE is false on main, not
 * changed here) and settleShares answers the counts the test sets, so the route's answer is what is checked.
 */
import type { SettleCounts } from "../lib/share-settle";

export const COMMISSION_LIVE = true;

export const next: { counts: SettleCounts } = {
  counts: { fees: 0, gaveBack: 0, cents: 0, stores: 0, memberships: 0, failed: 0, complete: true, unknownDisputes: 0, unknownDisputeFees: [], unknownAmounts: 0, unknownAmountFees: [], listUnknown: 0 },
};

export async function settleShares(): Promise<SettleCounts> {
  return next.counts;
}
