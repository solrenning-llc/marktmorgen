/**
 * #5285 row #3039 (the pre-existing LEVE on #3039, a Codex-family PR): a change to the Store assistant's memory waits
 * for another change's lock (lib/assistant-memory-store.ts, MEMORY_LOCK_WAIT_MS), and its route is billed as one
 * studio request, held at SHAPES.studio's seconds (tests/plan-cost-registry.ts). A wait of 2,000 ms slept about
 * 1.99 s at its worst, past the 1.5 s the shape holds, so the request's own time was understated. Now the whole wait
 * at its worst, the jitter of each sleep included, stays inside the shape with room for the route's work, and a change
 * that waits past it is refused as busy, as before. Measured on the real takeLock with a virtual clock; synthetic only.
 */
import { MEMORY_FORGET_COMMANDS, MEMORY_LOCK_WAIT_MS } from "@/lib/assistant-memory-store";
import { LockBusyError, takeLock } from "@/lib/redis-lock";
import { SHAPES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function worstWaitMs(waitMs: number): Promise<{ slept: number; tries: number; busy: boolean }> {
  const savedNow = Date.now;
  const savedRandom = Math.random;
  const savedTimeout = globalThis.setTimeout;
  let now = Date.UTC(2026, 10, 23);
  const start = now;
  let tries = 0;
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = async (commands) => {
    if (commands[0][0] === "SET" && commands[0][1] === "nl:amem:lock:waitprobe") tries += 1;
    return pipeline(commands);
  };
  Date.now = () => now;
  // The jitter at its largest: every sleep is its wait plus 19 ms.
  Math.random = () => 0.999;
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    now += Number(delay ?? 0);
    queueMicrotask(run);
    return 0;
  }) as unknown as typeof setTimeout;
  let busy = false;
  try {
    redis.clear();
    redis.run(["SET", "nl:amem:lock:waitprobe", "another-change", "EX", 10]);
    await takeLock("nl:amem:lock:waitprobe", 10, waitMs).catch((error: unknown) => {
      busy = error instanceof LockBusyError;
    });
  } finally {
    Date.now = savedNow;
    Math.random = savedRandom;
    globalThis.setTimeout = savedTimeout;
    redis.pipeline = pipeline;
  }
  return { slept: now - start, tries, busy };
}

async function main(): Promise<void> {
  part("A memory change waiting for another one's lock, at its worst");
  const worst = await worstWaitMs(MEMORY_LOCK_WAIT_MS);
  const shapeMs = SHAPES.studio.seconds * 1_000;
  console.log(`the memory lock's worst wait: ${worst.slept} ms in ${worst.tries} tries, of the studio shape's ${shapeMs} ms`);
  is("it is refused as busy once the wait is over", worst.busy, true);
  is(`its whole wait, jitter included (${worst.slept} ms), leaves at least a third of the studio shape (${shapeMs} ms) for the route's work`, worst.slept <= (shapeMs * 2) / 3, true);
  is("forgetMemory's declared commands still cover every try at the lock and its three other dispatches", MEMORY_FORGET_COMMANDS >= worst.tries + 3, true);
  done();
}

void main();
