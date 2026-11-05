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
  test(`${route.name}: an ambiguous contender cannot work or unlock an active confirmed run`, async () => {
    const commands: (string | number)[][] = [];
    let lockAttempts = 0;
    let unblock!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { unblock = resolve; });
    let held = false;
    redis.pipeline = async batch => {
      commands.push(...batch);
      if (batch[0][0] === "SET" && batch[0][1] === route.key) {
        lockAttempts += 1;
        if (lockAttempts === 2) return [];
      } else if (!held) {
        held = true;
        entered();
        await release;
      }
      return pipeline(batch);
    };
    const first = route.run(request(route.name));
    await paused;
    try {
      assert.equal(redis.run(["GET", route.key]), "1");
      const offset = commands.length;
      const contender = await route.run(request(route.name));
      assert.equal(contender.status, 503);
      assert.deepEqual(await contender.json(), { ok: false, error: "unavailable" });
      assert.deepEqual(commands.slice(offset).map(command => command[0]), ["SET"]);
      assert.equal(redis.run(["GET", route.key]), "1");
      assert.equal(providerCalls, 0);
    } finally {
      unblock();
      const completed = await first;
      assert.equal(completed.status, 200);
    }
    assert.equal(lockAttempts, 2);
    assert.equal(commands.filter(command => command[0] === "DEL" && command[1] === route.key).length, 1);
    assert.equal(redis.run(["GET", route.key]), null);
  });
}
