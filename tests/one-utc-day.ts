/**
 * A test file's clock, kept inside one UTC day: from the call on it runs at its real pace from noon of the UTC day it
 * started on. Some checks name a day or a month read once (a fixture's month, the visits window a check reads before
 * and after) while the code reads the clock again at each call (Date.now(), new Date()); a real midnight passing
 * mid-file, or the last midnight of a month, moved the code to the next day's or month's keys while the check still
 * named the first one. Twelve hours of room is far more than any file runs. Time still passes, so a deadline or a lock
 * still gives up when it should; only the starting point moves, never a limit or an assertion. Only Date is replaced
 * (Date.now(), new Date() without arguments); a date built from a given time is the real one. Returns the restore.
 */
export function withinOneUtcDay(): () => void {
  const RealDate = Date;
  const started = RealDate.now();
  const noon = Math.floor(started / 86_400_000) * 86_400_000 + 43_200_000;
  const now = () => noon + (RealDate.now() - started);
  class OneUtcDay extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length) super(...(args as [number]));
      else super(now());
    }
    static now(): number {
      return now();
    }
  }
  globalThis.Date = OneUtcDay as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}
