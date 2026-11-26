/**
 * How long a write of a store waits for another write of the same store (lib/store.ts withStore, the store's lock),
 * by where the write runs (#5010 row 182, the coordinator's B2 per caller, 2933).
 *
 * A write made for a person (a studio route, a page, a buyer's request, an API call) waits STUDIO_STORE_LOCK_WAIT_MS:
 * its whole wait at its worst (about 0.9 s, every sleep's jitter included) stays inside the studio shape such a write is
 * billed at (SHAPES.studio, 1.5 s, tests/plan-cost-registry.ts), with room for the route's work; one held past it is
 * refused as busy (StoreBusyError, "store_busy"), never dropped. A write made by a scheduled job (every
 * app/api/cron/** route runs inside runStoreJob) waits the job's wait (lib/store.ts LOCK_WAIT_MS), as every write did before: a closing or a
 * billing sync waits for a person's write in flight rather than giving up, and its lines price the whole wait
 * (STORE_LOCK_TRIES in lib/read-ceilings.ts counts the job's tries, the dearer side, for every caller).
 *
 * The job's mark is kept in an AsyncLocalStorage, found the way lib/fetch-timeout.ts finds its own: the one Next.js
 * puts on globalThis, or Node's. Where there is none (a browser), every write waits the person's wait.
 */
export const STUDIO_STORE_LOCK_WAIT_MS = 1_000;

type JobStore = { getStore(): true | undefined; run<R>(store: true, fn: () => R): R };
const jobs: JobStore | null = (() => {
  const g = globalThis as { AsyncLocalStorage?: new () => JobStore };
  if (typeof g.AsyncLocalStorage === "function") return new g.AsyncLocalStorage();
  const node = typeof process === "undefined" ? undefined : (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const hooks = node?.("node:async_hooks") as { AsyncLocalStorage?: new () => JobStore } | undefined;
  return hooks?.AsyncLocalStorage ? new hooks.AsyncLocalStorage() : null;
})();

/** Runs `work` as a scheduled job: every store write inside it waits the job's wait. */
export function runStoreJob<T>(work: () => Promise<T>): Promise<T> {
  return jobs ? jobs.run(true, work) : work();
}

/** The wait of a store write made here: `jobWaitMs` inside runStoreJob, a person's anywhere else (never more than the job's). */
export function storeLockWaitMs(jobWaitMs: number): number {
  return jobs?.getStore() === true ? jobWaitMs : Math.min(STUDIO_STORE_LOCK_WAIT_MS, jobWaitMs);
}
