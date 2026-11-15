/**
 * The daily usage watch ends inside its time limit and goes on from where it stopped (#4583).
 *
 * app/api/cron/usage walked every store of each part (video settling, video, visits, orders) one after the other, with
 * no end of its own, under `maxDuration = 60`. With enough stores the run met the limit and was stopped, and the next
 * day began again from the top in the same order: the same last stores were never settled or written to. Each part now
 * walks until its share of the run has gone, keeps where it reached (nl:usage-watch:at:<part>), and the next run goes on
 * from there, wrapping round, so every store is reached.
 *
 * Synthetic folders with no store; a fake clock that moves on with every Redis round trip; real MemoryRedis.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calendarWindow } from "@/lib/allowance-window";
import { GET as usage } from "@/app/api/cron/usage/route";
import { store as redis } from "./redis-stub";

delete process.env.CRON_SECRET;
globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;

type Command = (string | number)[];
const realNow = Date.now;
let clock = Date.UTC(2026, 10, 15, 14);
Date.now = () => clock;
const STEP_MS = 250;
const LIMIT_MS = 60_000;
const real = redis.pipeline.bind(redis);
const reads = new Map<string, number>();
const folders = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(32, "0"));
// Where the platform stops the function: past the limit, nothing more it asks of Redis is done, as after a kill.
let runStarted = Number.POSITIVE_INFINITY;
redis.pipeline = (async (commands: Command[]) => {
  clock += STEP_MS;
  if (clock - runStarted > LIMIT_MS) throw new Error("the function was stopped at its time limit");
  for (const command of commands) {
    for (const part of command.slice(1)) {
      const text = String(part);
      for (const folder of folders) if (text.includes(folder) && command[0] !== "SADD") reads.set(folder, (reads.get(folder) ?? 0) + 1);
    }
  }
  return real(commands);
}) as typeof redis.pipeline;

const run = async () => {
  const errors = console.error;
  const logs = console.log;
  console.error = () => {};
  console.log = () => {};
  runStarted = clock;
  try {
    const response = await usage({ headers: new Headers(), nextUrl: new URL("https://marktmorgen.com/api/cron/usage") } as unknown as Parameters<typeof usage>[0]);
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return { stopped: true };
  } finally {
    runStarted = Number.POSITIVE_INFINITY;
    console.error = errors;
    console.log = logs;
  }
};

test.after(() => {
  Date.now = realNow;
  redis.pipeline = real;
});

test("a run with many stores ends inside the time limit and says how far each part got", async () => {
  redis.clear();
  reads.clear();
  const month = calendarWindow(clock).id;
  await real([["SADD", `nl:traffic:folders:${month}`, ...folders], ["SADD", `nl:orders:folders:${month}`, ...folders]]);
  const start = clock;
  const body = await run();
  assert.ok(clock - start < LIMIT_MS, `the run took ${clock - start} ms on the fake clock, past the ${LIMIT_MS} ms limit`);
  const visits = body.visits as { walked?: { reached: number; of: number; done: boolean } };
  const orders = body.orders as { walked?: { reached: number; of: number; done: boolean } };
  assert.equal(typeof visits.walked, "object", "the visits part says how far it got");
  assert.equal(visits.walked?.of, folders.length);
  assert.ok((visits.walked?.reached ?? 0) > 0 && visits.walked?.done === false, "the visits part stopped partway");
  assert.ok((orders.walked?.reached ?? 0) > 0, "the orders part still ran after visits used its share");
});

test("the next runs go on from where the last one stopped, so every store is reached", async () => {
  // Same folders as above, a day later each time: the walk goes on from its kept place and wraps round.
  for (let day = 0; day < 6 && folders.some((folder) => (reads.get(folder) ?? 0) === 0); day += 1) {
    clock += 86_400_000;
    const month = calendarWindow(clock).id;
    await real([["SADD", `nl:traffic:folders:${month}`, ...folders], ["SADD", `nl:orders:folders:${month}`, ...folders]]);
    const start = clock;
    await run();
    assert.ok(clock - start < LIMIT_MS, `run ${day + 2} took ${clock - start} ms on the fake clock`);
  }
  const never = folders.filter((folder) => (reads.get(folder) ?? 0) === 0);
  assert.deepEqual(never, [], `${never.length} stores were never reached`);
});

test("an unknown place walks nothing for that part and leaves the place as it was", async () => {
  redis.clear();
  reads.clear();
  const month = calendarWindow(clock).id;
  // A value of another type at the place's key is not a place this job wrote.
  await real([["SADD", `nl:traffic:folders:${month}`, ...folders.slice(0, 5)], ["SADD", "nl:usage-watch:at:visits", "x"]]);
  const body = await run();
  assert.equal((body.visits as { walked?: unknown }).walked, "unknown");
  assert.equal(folders.slice(0, 5).some((folder) => (reads.get(folder) ?? 0) > 0), false, "no visited store was read on an unknown place");
  assert.deepEqual(await real([["SMEMBERS", "nl:usage-watch:at:visits"]]), [["x"]], "the place was left as it was");
});
