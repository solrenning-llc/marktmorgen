import { createHook } from "node:async_hooks";

/**
 * A test-only clock for tests whose code waits for real: a lock polled every
 * few hundred milliseconds, a pace between batches, a poll every few seconds.
 *
 * While installed, every setTimeout of at most `maxMs` is kept on a virtual
 * timeline instead of the real one. When the process has nothing else to do
 * (a short real gap, so promise chains finish first, and no one-shot request
 * such as a crypto job is still pending in the thread pool), the
 * earliest of them fires and Date.now() and performance.now() move forward to
 * its time, as if the wait had passed. The order of the waits is the order
 * the real clock would give, and every reading of the clock sees the time
 * that passed: only the sitting is left out. Longer timers (request cutoffs,
 * the harness's exit) stay on the real clock.
 *
 * `restore()` puts back the real functions and drops the clock offset, so
 * call it once the virtual waits are over; a wait still pending then goes
 * back on the real clock.
 */

type Callback = (...args: unknown[]) => void;
type Virtual = { id: number; due: number; fn: Callback; args: unknown[]; refed: boolean; handle: VirtualHandle };
type VirtualHandle = {
  ref(): VirtualHandle;
  unref(): VirtualHandle;
  hasRef(): boolean;
  refresh(): VirtualHandle;
  [Symbol.toPrimitive](): number;
};

export type VirtualClock = { restore(): void; skipped(): number };

export function installVirtualClock({ maxMs, gapMs = 2 }: { maxMs: number; gapMs?: number }): VirtualClock {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realDateNow = Date.now;
  const realPerformanceNow = performance.now.bind(performance);
  let offset = 0;
  let seq = 0;
  const queue: Virtual[] = [];
  let pump: ReturnType<typeof realSetTimeout> | null = null;

  // One-shot native requests (a WebCrypto digest, randomBytes with a callback, a file read) still in flight:
  // virtual time waits for them, as the real clock would have, up to a real bound so nothing can hang on one.
  const inFlight = new Set<number>();
  const oneShot = /REQUEST$|REQWRAP$|^FSREQ/;
  const hook = createHook({
    init(asyncId, type, _trigger, resource) {
      if (!oneShot.test(type)) return;
      inFlight.add(asyncId);
      // A crypto job run synchronously (randomBytes(n), generateKeyPairSync, a sync digest) is done already and only
      // waits to be collected: only one given a callback (ondone) is still in flight.
      if (type.endsWith("REQUEST")) {
        queueMicrotask(() => { if (typeof (resource as { ondone?: unknown }).ondone !== "function") inFlight.delete(asyncId); });
      }
    },
    after(asyncId) { inFlight.delete(asyncId); },
    destroy(asyncId) { inFlight.delete(asyncId); },
  }).enable();
  let busySince = 0;
  const BUSY_BOUND_MS = 2_000;

  const now = () => realDateNow() + offset;
  Date.now = now;
  performance.now = () => realPerformanceNow() + offset;

  const schedule = () => {
    if (pump !== null) realClearTimeout(pump);
    pump = null;
    if (!queue.length) return;
    pump = realSetTimeout(step, gapMs);
    if (!queue.some((t) => t.refed)) pump.unref();
  };
  function step(): void {
    pump = null;
    if (!queue.length) return;
    if (inFlight.size && (busySince === 0 || realDateNow() - busySince < BUSY_BOUND_MS)) {
      if (busySince === 0) busySince = realDateNow();
      schedule();
      return;
    }
    busySince = 0;
    let next = 0;
    for (let i = 1; i < queue.length; i += 1) {
      if (queue[i].due < queue[next].due || (queue[i].due === queue[next].due && queue[i].id < queue[next].id)) next = i;
    }
    const [timer] = queue.splice(next, 1);
    const late = timer.due - now();
    if (late > 0) offset += late;
    schedule();
    timer.fn(...timer.args);
  }

  const virtualSetTimeout = ((fn: Callback, ms?: number, ...args: unknown[]) => {
    const wait = Math.max(0, Number(ms) || 0);
    if (typeof fn !== "function" || wait > maxMs) return realSetTimeout(fn as never, ms, ...args);
    seq += 1;
    const timer = { id: seq, due: now() + wait, fn, args, refed: true } as Virtual;
    timer.handle = {
      ref() { timer.refed = true; schedule(); return timer.handle; },
      unref() { timer.refed = false; schedule(); return timer.handle; },
      hasRef() { return timer.refed; },
      refresh() { timer.due = now() + wait; return timer.handle; },
      [Symbol.toPrimitive]() { return -timer.id; },
    };
    queue.push(timer);
    schedule();
    return timer.handle;
  }) as unknown as typeof setTimeout;
  const virtualClearTimeout = ((handle: unknown) => {
    const i = queue.findIndex((t) => t.handle === handle);
    if (i >= 0) {
      queue.splice(i, 1);
      schedule();
      return;
    }
    realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  globalThis.setTimeout = virtualSetTimeout;
  globalThis.clearTimeout = virtualClearTimeout;

  return {
    restore() {
      if (pump !== null) realClearTimeout(pump);
      pump = null;
      hook.disable();
      // Anything still waiting goes back on the real clock, for the time it had left.
      for (const t of queue.splice(0)) {
        const real = realSetTimeout(t.fn as never, Math.max(0, t.due - now()), ...t.args);
        if (!t.refed) real.unref();
      }
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      Date.now = realDateNow;
      performance.now = realPerformanceNow;
    },
    skipped: () => offset,
  };
}
