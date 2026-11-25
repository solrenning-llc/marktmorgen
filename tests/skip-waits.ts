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
 * real clock, and the clock never moves back: only a timer whose first named
 * frame below setTimeout is the named function itself is skipped (ownWait), so
 * a timer set deeper inside it, such as timed()'s cutoff in lib/fetch-timeout.ts
 * under the real lib/redis.ts, keeps its real time (Claude 2 on #4523, 6877011736).
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

/**
 * Whether a setTimeout's stack is one of the named functions' own sleep. Below the setTimeout wrapper (the first
 * frame), the named function is the next frame (a setTimeout it calls itself), or it comes right after the arrow and
 * the Promise constructor of `await new Promise((resolve) => setTimeout(resolve, ms))`, the shape both lib/redis-lock.ts
 * and lib/mail.ts sleep in. A timer set by anything that function calls has that callee's frames there instead and is
 * not one. (V8 may give the arrow an inferred name, so it is told apart by its place, not by having no name.)
 */
export function ownWait(stack: string, names: readonly SkippedWait[]): boolean {
  const frames = stack.split("\n").filter((line) => /^\s*at /.test(line)).slice(1);
  const named = (line: string | undefined) => line !== undefined && names.some((name) => NAMES[name].test(line));
  return named(frames[0]) || (/^\s*at new Promise \(<anonymous>\)$/.test(frames[1] ?? "") && named(frames[2]));
}

let offset = 0;
let installed: readonly SkippedWait[] | null = null;

export function skipWaits(names: readonly SkippedWait[]): { skipped(): number } {
  if (installed) throw new Error(`skipWaits is already installed for ${installed.join(", ")}`);
  installed = names;
  const realNow = Date.now.bind(Date);
  const realSetTimeout = globalThis.setTimeout;
  const now = () => realNow() + offset;
  Date.now = now;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (typeof ms === "number" && ms > 0) {
      const stack = new Error().stack ?? "";
      if (ownWait(stack, names)) {
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
