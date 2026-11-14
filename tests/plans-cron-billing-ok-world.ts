/**
 * Stand-ins for every job the daily plans cron runs (app/api/cron/plans/route.ts),
 * for tests/plans-cron-billing-ok.test.ts: each answers what the test sets, so the
 * route's own "ok" is what is tested. Synthetic only.
 */
export type Billing = { seen: number; updated: number; adopted: number; checked: number; failed: number; complete: boolean };
export const world: { billing: Billing | null; billingThrows: boolean } = { billing: null, billingThrows: false };

export const cronAllowed = async () => true;
export const isBillingConfigured = () => true;
export const settlePlans = async () => ({ settled: 0 });
// The route passes the plans' limit (claude5/plans-stuck-entries, merged with main): only its name is needed here.
export const PLANS_PER_RUN = 200;
export const syncPlanDisputes = async () => ({ seen: 0, recorded: 0, unmatched: 0, reread: 0, failed: 0, complete: true });
export const syncSubscriptions = async () => {
  if (world.billingThrows) throw new Error("synthetic sync failure");
  return world.billing;
};
export const recoverFailedPayments = async () => null;
export const sendWinBacks = async () => null;
export const sendMemberNudges = async () => null;
export const sendYearlyAsks = async () => null;
export const sendVerified = async () => null;
export const refreshRanges = async () => null;
export const settleInvites = async () => null;
export const moveAllStores = async () => null;
export const pruneResearch = async () => undefined;
export const ensureDemoStore = async () => null;
