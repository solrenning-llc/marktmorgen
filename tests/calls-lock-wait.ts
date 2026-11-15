/**
 * The wait between a call lock's retries, run at once in the call-lock tests
 * (tests/calls-lock-shape.test.ts, tests/calls-lock-owner.test.ts).
 *
 * lib/calls.ts takeLock tries a held lock's SET NX 12 times, 250 ms apart, so
 * every case with a lock held burns about 2.75 s of real time doing nothing.
 * Here only that wait is cut short: a timer of exactly 250 ms set right after
 * a SET NX of a call's lock (nl:call:lock:*) answered nil, before the event
 * loop moves on, fires on the next turn instead. Every attempt still runs on
 * the in-memory Redis, so the number of SET NX tries, their order and what the
 * code does after the last one are the same; any other timer, and any 250 ms timer not following such a reply,
 * runs as before. The clock is not touched: a lock taken "now" stays young and
 * one left 20 seconds ago stays old, as with the real wait (2.75 s < 15 s).
 *
 * Call it once, after the test has put its own wrapper on the stub's pipeline,
 * so the replies seen are the ones the code sees.
 */
import { store as redis } from "./redis-stub";

const LOCK = "nl:call:lock:";
const RETRY_MS = 250;

export function runCallLockWaitsAtOnce(): void {
  /**
   * Lock waits now owed: one per SET NX of a call's lock that answered nil. takeLock sets its wait in the
   * same run of promise callbacks that reads the reply, so one not taken by then (after the last of the 12
   * tries) lapses on the next turn of the event loop and can never cut another timer short.
   */
  const owed = new Set<symbol>();
  const inner = redis.pipeline;
  redis.pipeline = async (commands) => {
    const replies = await inner(commands);
    commands.forEach((c, i) => {
      if (c[0] !== "SET" || !c.includes("NX") || !String(c[1] ?? "").startsWith(LOCK) || replies[i] !== null) return;
      const one = Symbol("call lock wait");
      owed.add(one);
      setImmediate(() => owed.delete(one));
    });
    return replies;
  };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const [one] = owed;
    if (ms === RETRY_MS && one) {
      owed.delete(one);
      return realSetTimeout(handler, 0, ...args);
    }
    return realSetTimeout(handler, ms, ...args);
  }) as typeof setTimeout;
}
