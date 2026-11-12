/**
 * Stand-ins for every pass the reminders cron runs (app/api/cron/reminders/route.ts), for
 * tests/cron-reminders-requests-failed.test.ts: each answers an empty count, and the payment-request pass throws while
 * world.requestsThrow is set, so the route's own answer is what is tested. Synthetic only.
 */
export const world = { requestsThrow: false };
export const cronAllowed = async () => true;
export const isBillingConfigured = () => true;
export const sendReminders = async () => ({ trials: 0, renewals: 0 });
export const sendFailedPlanNotices = async () => 0;
export const runBreaks = async () => ({ told: 0, restarted: 0, failed: 0, dropped: 0 });
export const sendTrialNudges = async () => 0;
export const sendDueReminders = async () => {
  if (world.requestsThrow) throw new Error("synthetic: Redis request timed out");
  return { sent: 0, skipped: 0 };
};
