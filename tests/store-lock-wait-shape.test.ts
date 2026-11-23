/**
 * #5010 row 182 (coordinator's B2, c1bf; Claude 6 NQoup's inventory 7104754946): every write of a store waits for the
 * store's lock (lib/store.ts withStore, LOCK_WAIT_MS), and the studio routes that write a store are billed at
 * SHAPES.studio's seconds (tests/plan-cost-registry.ts). A wait of 8,000 ms slept about 8 s at its worst, more than
 * five times the 1.5 s the shape holds, so a busy store's write was priced far below what it can cost. Now the whole
 * wait at its worst, every sleep's jitter included, stays inside the shape with room for the route's work, and a write
 * that waits past it is refused as busy (StoreBusyError, the existing "store_busy"), never dropped in silence: the
 * store is left exactly as it was. Measured on the real takeLock with a virtual clock; synthetic only.
 */
import { StoreBusyError, claimHandle, setCurrency, storeForEmail } from "@/lib/store";
import { STORE_LOCK_TRIES } from "@/lib/read-ceilings";
import { SHAPES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const OWNER = "lock-wait-shape@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lock-wait-shape", "Lock wait", "");
  const before = (await storeForEmail(OWNER))?.currency;

  part("A store write waiting for another write's lock, at its worst");
  const real = redis.pipeline.bind(redis);
  const savedNow = Date.now;
  const savedRandom = Math.random;
  const savedTimeout = globalThis.setTimeout;
  let now = Date.UTC(2026, 10, 23);
  const start = now;
  let tries = 0;
  // Another write holds the store's lock the whole time: every SET NX of the lock is refused.
  redis.pipeline = (async (commands: Command[]) => {
    if (commands.length === 1 && commands[0][0] === "SET" && String(commands[0][1]).startsWith("nl:store:lock:") && commands[0].includes("NX")) {
      tries += 1;
      return [null];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  Date.now = () => now;
  // The jitter at its largest: every sleep is its wait plus 19 ms.
  Math.random = () => 0.999;
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    now += Number(delay ?? 0);
    queueMicrotask(run);
    return 0;
  }) as unknown as typeof setTimeout;
  let outcome = "";
  try {
    const result = await setCurrency(OWNER, before === "eur" ? "usd" : "eur");
    outcome = result.ok ? "written" : `refused: ${result.reason}`;
  } catch (error) {
    outcome = error instanceof StoreBusyError ? "busy" : String(error);
  } finally {
    Date.now = savedNow;
    Math.random = savedRandom;
    globalThis.setTimeout = savedTimeout;
    redis.pipeline = real;
  }
  const slept = now - start;
  const shapeMs = SHAPES.studio.seconds * 1_000;
  console.log(`the store lock's worst wait: ${slept} ms in ${tries} tries, of the studio shape's ${shapeMs} ms`);
  is("the write is refused as busy (store_busy), never written over the other one", outcome, "busy");
  is("and the store is left as it was", (await storeForEmail(OWNER))?.currency, before);
  is(`its whole wait, jitter included (${slept} ms), leaves at least a third of the studio shape (${shapeMs} ms) for the route's work`, slept <= (shapeMs * 2) / 3, true);
  is(`the registry's STORE_LOCK_TRIES (${STORE_LOCK_TRIES}) still counts every try (${tries})`, STORE_LOCK_TRIES >= tries, true);
  done();
}

void main();
