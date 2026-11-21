/**
 * Skips the sitting, never the work, of two library waits that only space out
 * tries: lib/redis-lock.ts takeLock's pause between tries of a held lock, and
 * lib/mail.ts paced's gap between list batches (BATCH_GAP_MS).
 *
 * While installed, a setTimeout of more than 0 ms set from inside one of the
 * named functions fires on the next turn instead, and Date.now() moves forward
 * by the time it would have waited, as if that time had passed. Every try still
 * runs, in the same order, and every reading of the clock sees the time that
 * passed: takeLock gives up at the same point of its loop, and a lock or a key
 * that would have expired meanwhile has expired (the in-memory Redis reads the
 * same Date.now). Any other timer, a request's cutoff included, stays on the
 * real clock, and the clock never moves back.
 *
 * The same technique as the `waitsSkipped` helpers in tests/plan-switch-idempotency.test.ts
 * and tests/readings-erasure.test.ts, shared here for the files that only wait on these two.
 *
 * A file may replace Date.now after this is installed with one built on the
 * one it found (realNow() + shift), which keeps the moved time. One that drops
 * it would leave takeLock spinning for real, so each skipped wait checks that
 * Date.now() moved on by at least that wait, and throws if not.
 */
const NAMES = { takeLock: /\bat (?:async )?takeLock\d* \(/, paced: /\bat (?:async )?paced\d* \(/ } as const;
export type SkippedWait = keyof typeof NAMES;

let offset = 0;
let installed: readonly SkippedWait[] | null = null;

export function skipWaits(names: readonly SkippedWait[]): { skipped(): number } {
  if (installed) throw new Error(`skipWaits is already installed for ${installed.join(", ")}`);
  installed = names;
  const realNow = Date.now.bind(Date);
  const realSetTimeout = globalThis.setTimeout;
  const now = () => realNow() + offset;
  Date.now = now;
  const patterns = names.map((name) => NAMES[name]);
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms > 0) {
      const stack = new Error().stack ?? "";
      if (patterns.some((pattern) => pattern.test(stack))) {
        const before = Date.now();
        offset += ms;
        if (Date.now() - before < ms) throw new Error("skipWaits: Date.now no longer reads the moved clock; the skipped wait would not pass");
        return realSetTimeout(fn, 0, ...args);
      }
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  return { skipped: () => offset };
}
