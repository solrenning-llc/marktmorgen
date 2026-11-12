/**
 * Stand-ins for every job the daily plans cron runs (app/api/cron/plans/route.ts),
 * for tests/plans-cron-billing-ok.test.ts: each answers what the test sets, so the
 * route's own "ok" is what is tested. Synthetic only.
 */
export type Billing = { seen: number; updated: number; adopted: number; checked: number; failed: number; complete: boolean };
export const world: { billing: Billing | null; billingThrows: boolean; throwing: Set<string> } = { billing: null, billingThrows: false, throwing: new Set() };
/** A stand-in that throws while its name is in world.throwing (tests/cron-failed-passes.test.ts), else answers `value`. */
const pass = <T>(name: string, value: T) => async (): Promise<T> => {
  if (world.throwing.has(name)) throw new Error(`synthetic ${name} failure`);
  return value;
};

export const cronAllowed = async () => true;
export const isBillingConfigured = () => true;
export const settlePlans = async () => ({ settled: 0 });
export const syncPlanDisputes = async () => ({ seen: 0, recorded: 0, unmatched: 0, reread: 0, failed: 0, complete: true });
export const syncSubscriptions = async () => {
  if (world.billingThrows) throw new Error("synthetic sync failure");
  return world.billing;
};
export const recoverFailedPayments = pass("recoverFailedPayments", null);
export const sendWinBacks = pass("sendWinBacks", null);
export const sendMemberNudges = pass("sendMemberNudges", null);
export const sendYearlyAsks = pass("sendYearlyAsks", null);
export const sendVerified = pass("sendVerified", null);
export const refreshRanges = pass("refreshRanges", null);
export const settleInvites = pass("settleInvites", null);
export const moveAllStores = pass("moveAllStores", null);
export const pruneResearch = pass("pruneResearch", undefined);
export const ensureDemoStore = pass("ensureDemoStore", null);
