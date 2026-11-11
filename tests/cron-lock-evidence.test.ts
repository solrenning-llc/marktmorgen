import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { GET as recount } from "@/app/api/cron/recount/route";
import { GET as closed } from "@/app/api/cron/closed-data/route";
import { GET as imports } from "@/app/api/cron/imports/route";
import { GET as closing } from "@/app/api/cron/closing/route";
import { GET as plans } from "@/app/api/cron/plans/route";
import { GET as stream } from "@/app/api/cron/stream/route";
import { seedFingerprint } from "@/lib/demo-seed";
import { store as redis } from "./redis-stub";

const routes = [
  { name: "recount", key: "nl:recount:lock", run: recount },
  { name: "closed-data", key: "nl:closed:lock", run: closed },
  { name: "imports", key: "nl:imports:lock", run: imports },
  { name: "closing", key: "nl:closing:lock", run: closing },
  { name: "plans", key: "nl:plans:lock", run: plans },
  { name: "stream", key: "nl:stream:lock", run: stream },
];
const pipeline = redis.pipeline.bind(redis);
const fetchBefore = globalThis.fetch;
const cronBefore = process.env.CRON_SECRET;
const streamKeys = ["BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY", "BUNNY_STREAM_TOKEN_KEY"] as const;
const streamBefore = streamKeys.map(key => process.env[key]);
let providerCalls = 0;
beforeEach(() => {
  redis.clear(); providerCalls = 0;
  process.env.CRON_SECRET = "synthetic-cron-lock-fixture";
  process.env.BUNNY_STREAM_LIBRARY_ID = "123";
  process.env.BUNNY_STREAM_API_KEY = "synthetic-cron-lock-stream-fixture";
  process.env.BUNNY_STREAM_TOKEN_KEY = "synthetic-cron-lock-player-fixture";
  redis.run(["SET", "nl:house:seed", JSON.stringify({ v: seedFingerprint(), at: Math.floor(Date.now() / 1000), pending: [], store: true, photo: "", image: "", images: {} })]);
  globalThis.fetch = async () => { providerCalls += 1; throw new Error("No provider request is allowed in a cron lock test"); };
});
afterEach(() => {
  redis.pipeline = pipeline; globalThis.fetch = fetchBefore;
  if (cronBefore === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = cronBefore;
  streamKeys.forEach((key, i) => { if (streamBefore[i] === undefined) delete process.env[key]; else process.env[key] = streamBefore[i]; });
});
function request(name: string, allowed = true) {
  return new NextRequest(`https://example.test/api/cron/${name}`, { headers: allowed ? { authorization: "Bearer synthetic-cron-lock-fixture" } : {} });
}

for (const route of routes) {
  for (const reply of [[], Array(1), [undefined], [false], [0], [1], [{}], [["OK"]], ["OK", null], [null, "OK"]]) {
    test(`${route.name}: unknown lock ${JSON.stringify(reply)} cannot start work or release another lock`, async () => {
      redis.run(["SET", route.key, "another-run", "EX", 300]);
      const commands: (string | number)[][] = [];
      redis.pipeline = async batch => {
        commands.push(...batch);
        return batch[0][0] === "SET" && batch[0][1] === route.key ? reply : pipeline(batch);
      };
      const response = await route.run(request(route.name));
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
      assert.deepEqual(commands.map(c => c[0]), ["SET"]);
      assert.equal(redis.run(["GET", route.key]), "another-run");
      assert.equal(providerCalls, 0);
    });
  }

  test(`${route.name}: confirmed contention returns busy without work or release`, async () => {
    redis.run(["SET", route.key, "another-run", "EX", 300]);
    const commands: (string | number)[][] = [];
    redis.pipeline = async batch => { commands.push(...batch); return pipeline(batch); };
    const response = await route.run(request(route.name));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, busy: true });
    assert.deepEqual(commands.map(c => c[0]), ["SET"]);
    assert.equal(redis.run(["GET", route.key]), "another-run");
  });

  test(`${route.name}: an explicit OK still runs and releases the existing lock`, async () => {
    const commands: (string | number)[][] = [];
    redis.pipeline = async batch => { commands.push(...batch); return pipeline(batch); };
    const response = await route.run(request(route.name));
    assert.equal(response.status, 200);
    assert.ok(commands.length > 1);
    assert.equal(commands.filter(c => c[0] === "SET" && c[1] === route.key).length, 1);
    assert.equal(commands.filter(c => c[0] === "DEL" && c[1] === route.key).length, 1);
    assert.equal(redis.run(["GET", route.key]), null);
    assert.equal(providerCalls, 0);
  });

  test(`${route.name}: unauthorized requests never attempt a lock`, async () => {
    let called = false; redis.pipeline = async () => { called = true; return []; };
    assert.equal((await route.run(request(route.name, false))).status, 401);
    assert.equal(called, false);
  });
}
