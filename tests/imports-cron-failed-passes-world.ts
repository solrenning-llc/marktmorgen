/**
 * Stand-ins for every module the imports job (app/api/cron/imports/route.ts) calls, for
 * tests/imports-cron-failed-passes.test.ts (issue #4091): each pass answers at once, or throws when its name is in
 * `world.throwing`. The job's lock is always ours; nothing is read or sent. Synthetic only.
 */
export const world = { throwing: new Set<string>(), ran: [] as string[] };

function pass<T>(name: string, value: T) {
  return async (..._args: unknown[]): Promise<T> => {
    void _args;
    world.ran.push(name);
    if (world.throwing.has(name)) throw new Error(`${name} failed (stand-in)`);
    return value;
  };
}

export const cronAllowed = async () => true;
export const isRedisConfigured = () => true;
export const claimValue = () => "stand-in-lock";
export const claimMark = async () => "ours" as const;
export const releaseMark = async () => true;
export const withCutoff = async <T>(_cutoff: number, work: () => Promise<T>) => work();
export const storeForId = async () => null;
export const noticeCreator = async () => undefined;

export const advanceImports = pass("advanceImports", { advanced: 1 });
export const readMetaDue = pass("readMetaDue", { read: 2 });
export const sendWelcomeReminders = pass("sendWelcomeReminders", { sent: 1 });
export const activateScheduledCodes = pass("activateScheduledCodes", { activated: 1 });
export const sendMoveReminders = pass("sendMoveReminders", 1);
