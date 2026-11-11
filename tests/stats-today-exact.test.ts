/**
 * The studio's numbers for today and right now (lib/stats.ts: readToday, readLive, sourcesToday, viewsBefore) are
 * read in their exact shape (CX-123 rule 24, rule 30; VR item 2). Found by Claude 3 (cloud D)'s audit of main
 * @7b04206e7 (11 November 2026): each read a reply of another shape (a lost reply, text where a count belongs, a
 * hash that is not pairs) as nothing, so the studio showed "0 visitors today" and "nobody here now" as real
 * numbers, and viewsBefore read the last two weeks as zeros, so the busy-day email (lib/stats-report.ts,
 * maybeBusyAlert) could tell a creator today beat "any day in the last two weeks" on a history nobody read.
 *
 * Now each throws UnknownReplyError on such a reply. Its callers already treat a throw as "not read": the live
 * route (app/api/store/live/route.ts) answers today as null, which the studio says as a reading that failed, or
 * answers 502; the busy-day email is asked inside the visit's own try (lib/visit.ts) and is simply not sent.
 * Readable replies give the same numbers as before. Synthetic only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { store as redis } from "./redis-stub";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { readLive, readToday, sourcesToday, viewsBefore } from "@/lib/stats";
import { UnknownReplyError } from "@/lib/redis-reply";

const real = redis.pipeline.bind(redis);
let odd: { command: string; reply: unknown } | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  const replies = (await real(commands)) as unknown[];
  if (!odd) return replies;
  if (odd.reply === "LOST" && commands.some((c) => c[0] === odd!.command)) return [];
  return commands.map((c, i) => (c[0] === odd!.command ? odd!.reply : replies[i]));
}) as typeof redis.pipeline;

beforeEach(() => {
  redis.clear();
  odd = null;
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
});

async function aStore() {
  const OWNER = "statsexact@example.com";
  await claimHandle(OWNER, "statsexactshop", "Stats Exact Shop", "");
  await ensureStatsId(OWNER);
  return (await storeForEmail(OWNER))!;
}

const unknown = (error: unknown) => error instanceof UnknownReplyError;

for (const reply of ["LOST", "lots", 7, null, { a: 1 }, ["only-a-field"]]) {
  test(`today's counts whose HGETALL reads ${JSON.stringify(reply)} are unknown, never zero visitors`, async () => {
    const store = await aStore();
    odd = { command: "HGETALL", reply };
    await assert.rejects(readToday(store), unknown);
  });
}

for (const reply of ["LOST", "12", -1, 1.5, null]) {
  test(`today's visitors whose PFCOUNT reads ${JSON.stringify(reply)} are unknown, never zero`, async () => {
    const store = await aStore();
    odd = { command: "PFCOUNT", reply };
    await assert.rejects(readToday(store), unknown);
  });
}

for (const reply of ["LOST", "who|direct", null, 3, ["a|direct"]]) {
  test(`who is here now, read ${JSON.stringify(reply)}, is unknown, never nobody`, async () => {
    const store = await aStore();
    odd = { command: "ZRANGEBYSCORE", reply };
    await assert.rejects(readLive(store), unknown);
  });
}

for (const reply of ["LOST", "lots", -3, 2.5, { v: 1 }]) {
  test(`the last two weeks' views, a day read ${JSON.stringify(reply)}, are unknown, never zero`, async () => {
    const store = await aStore();
    odd = { command: "HGET", reply };
    await assert.rejects(viewsBefore(store, 14), unknown);
  });
}

for (const reply of ["LOST", "r:direct", { "r:direct": "3" }]) {
  test(`today's channels whose HGETALL reads ${JSON.stringify(reply)} are unknown, never none`, async () => {
    const store = await aStore();
    odd = { command: "HGETALL", reply };
    await assert.rejects(sourcesToday(store), unknown);
  });
}

test("readable replies give the numbers as before: none yet is zero, and a day never written is zero", async () => {
  const store = await aStore();
  const today = await readToday(store);
  assert.equal(today.visitors, 0);
  assert.equal(today.views, 0);
  assert.deepEqual(today.sources, []);
  assert.deepEqual(await readLive(store), { visitors: 0, sources: [] });
  assert.deepEqual(await viewsBefore(store, 3), [0, 0, 0]);
  assert.deepEqual(await sourcesToday(store), []);
});

test("a day's counts written as Redis keeps them are read back", async () => {
  const store = await aStore();
  const day = new Date().toISOString().slice(0, 10);
  await real([["HSET", `nl:stats:${store.statsId}:${day}`, "v", "5", "r:direct", "4"], ["PFADD", `nl:stats:${store.statsId}:${day}:u`, "a", "b"]]);
  const today = await readToday(store);
  assert.equal(today.views, 5);
  assert.ok(today.sources.some((s) => s.source === "direct"));
});
