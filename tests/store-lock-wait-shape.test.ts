/**
 * #5010 row 182 (coordinator's B2, c1bf; Claude 6 NQoup's inventory 7104754946): every write of a store waits for the
 * store's lock (lib/store.ts withStore, LOCK_WAIT_MS), and the studio routes that write a store are billed at
 * SHAPES.studio's seconds (tests/plan-cost-registry.ts). A wait of 8,000 ms slept about 8 s at its worst, more than
 * five times the 1.5 s the shape holds, so a busy store's write was priced far below what it can cost. Now the whole
 * wait at its worst, every sleep's jitter included, stays inside the shape with room for the route's work, and a write
 * that waits past it is refused as busy (StoreBusyError, the existing "store_busy"), never dropped in silence: the
 * store is left exactly as it was. A scheduled job (every app/api/cron/** route runs inside runStoreJob) still waits the
 * job's whole wait, as every write did before, so a closing or a billing sync waits for a person's write in flight
 * (the coordinator's per-caller choice, 2933; tests/podcast-public-erasure.test.ts). Measured on the real takeLock with
 * a virtual clock; synthetic only.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { StoreBusyError, claimHandle, setCurrency, storeForEmail } from "@/lib/store";
import { runStoreJob } from "@/lib/store-lock-wait";
import { STORE_LOCK_TRIES } from "@/lib/read-ceilings";
import { SHAPES } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const OWNER = "lock-wait-shape@example.com";

/** Runs `write` while another write holds the store's lock the whole time, on a virtual clock with the largest jitter. */
async function waitedWrite(write: () => Promise<{ ok: boolean; reason?: string }>): Promise<{ outcome: string; slept: number; tries: number }> {
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
    const result = await write();
    outcome = result.ok ? "written" : `refused: ${result.reason}`;
  } catch (error) {
    outcome = error instanceof StoreBusyError ? "busy" : String(error);
  } finally {
    Date.now = savedNow;
    Math.random = savedRandom;
    globalThis.setTimeout = savedTimeout;
    redis.pipeline = real;
  }
  return { outcome, slept: now - start, tries };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "lock-wait-shape", "Lock wait", "");
  const before = (await storeForEmail(OWNER))?.currency;

  const shapeMs = SHAPES.studio.seconds * 1_000;

  part("A store write for a person, waiting for another write's lock, at its worst");
  const person = await waitedWrite(() => setCurrency(OWNER, before === "eur" ? "usd" : "eur"));
  console.log(`a person's store write: ${person.slept} ms in ${person.tries} tries, of the studio shape's ${shapeMs} ms`);
  is("the write is refused as busy (store_busy), never written over the other one", person.outcome, "busy");
  is("and the store is left as it was", (await storeForEmail(OWNER))?.currency, before);
  is(`its whole wait, jitter included (${person.slept} ms), leaves at least a third of the studio shape (${shapeMs} ms) for the route's work`, person.slept <= (shapeMs * 2) / 3, true);
  is(`the registry's STORE_LOCK_TRIES (${STORE_LOCK_TRIES}) still counts every try (${person.tries})`, STORE_LOCK_TRIES >= person.tries, true);

  part("The same write made by a scheduled job still waits the job's whole wait");
  const job = await waitedWrite(() => runStoreJob(() => setCurrency(OWNER, before === "eur" ? "usd" : "eur")));
  console.log(`a job's store write: ${job.slept} ms in ${job.tries} tries`);
  is("refused as busy only after the job's wait", [job.outcome, job.slept > 7_000, job.slept <= 8_019], ["busy", true, true]);
  is(`STORE_LOCK_TRIES (${STORE_LOCK_TRIES}) counts the job's tries (${job.tries}), the dearer side, for every caller`, STORE_LOCK_TRIES >= job.tries, true);
  is("a person's write after a job's waits a person's wait again", (await waitedWrite(() => setCurrency(OWNER, before === "eur" ? "usd" : "eur"))).slept <= (shapeMs * 2) / 3, true);

  part("Every scheduled job runs inside runStoreJob");
  const crons = readdirSync(join(process.cwd(), "app/api/cron"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const outside = crons.filter((name) => !/export async function GET\(request: NextRequest\) \{\n[^\n]*\n  return runStoreJob\(\(\) => runJob\(request\)\);/.test(readFileSync(join(process.cwd(), "app/api/cron", name, "route.ts"), "utf8")));
  is(`each of the ${crons.length} cron routes' GET runs its job inside runStoreJob`, outside, []);
  done();
}

void main();
