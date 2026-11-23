/**
 * Stand-ins for every module the five-minute mail job (app/api/cron/mail/route.ts) calls, for
 * tests/mail-cron-failed-passes.test.ts (issue #4090): each pass answers at once, or throws when its name is in
 * `world.throwing`. The job's lock is always ours; nothing is sent and nothing is read. Synthetic only.
 */
export const world = { throwing: new Set<string>(), sender: true, ran: [] as string[] };

function pass<T>(name: string, value: T) {
  return async (..._args: unknown[]): Promise<T> => {
    void _args;
    world.ran.push(name);
    if (world.throwing.has(name)) throw new Error(`${name} failed (stand-in)`);
    return value;
  };
}

// lib/request-guard, lib/redis, lib/claim-mark, lib/email, lib/fetch-timeout
export const cronAllowed = async () => true;
export const isRedisConfigured = () => true;
export const claimValue = () => "stand-in-lock";
export const claimMark = async () => "ours" as const;
export const releaseMark = async () => true;
export const isSenderConfigured = () => world.sender;
export const sendQueuedShipmentMail = async () => true;
export const withCutoff = async <T>(_cutoff: number, work: () => Promise<T>) => work();

// Values passed through, never called by the stand-ins.
export const storeForHandle = async () => null;
export const storeForScheduledWork = async () => null;
export const storeForReminders = async () => null;
export const readListing = async () => null;
export const SITE_URL = "https://marktmorgen.com";
export const preorderDeps = {};
export const lowStockJobDeps = {};

// The passes.
export const runShipmentMail = pass("runShipmentMail", { sent: 0 });
export const runOrderConfirmationMail = pass("runOrderConfirmationMail", { sent: 0 });
export const sweepCheckouts = pass("sweepCheckouts", { checked: 0 });
export const sendAsked = pass("sendAsked", 0);
export const sendAssistReminders = pass("sendAssistReminders", 0);
export const settlePendingOffers = pass("settlePendingOffers", { settled: 0 });
export const runEventQueue = pass("runEventQueue", { sent: 0 });
export const advanceAll = pass("advanceAll", 3);
export const sendDueSteps = pass("sendDueSteps", { sent: 2, dropped: 0, later: 1 });
export const advanceAnnouncements = pass("advanceAnnouncements", 1);
export const advanceUpdates = pass("advanceUpdates", 1);
export const runLaunches = pass("runLaunches", 1);
export const runPreorderReleases = pass("runPreorderReleases", 1);
export const runRestocks = pass("runRestocks", 1);
export const runLowStockChecks = pass("runLowStockChecks", undefined);
export const sendCallReminders = pass("sendCallReminders", { sent: 0 });
export const sendReviewRequests = pass("sendReviewRequests", { sent: 0 });
export const watchStripe = pass("watchStripe", { events: 0 });
export const replayKept = pass("replayKept", 0);
export const deliverDue = pass("deliverDue", { delivered: 0 });
export const syncMeetings = pass("syncMeetings", { synced: 0 });
export const syncDue = pass("syncDue", { sent: 0 });
