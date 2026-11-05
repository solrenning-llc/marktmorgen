import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { GET as recount } from "@/app/api/cron/recount/route";
import { GET as closed } from "@/app/api/cron/closed-data/route";
import { GET as imports } from "@/app/api/cron/imports/route";
import { GET as closing } from "@/app/api/cron/closing/route";
import { GET as plans } from "@/app/api/cron/plans/route";
import { GET as stream } from "@/app/api/cron/stream/route";
import { store as redis } from "./redis-stub";

const routes = [
  ["recount", "nl:recount:lock", recount], ["closed-data", "nl:closed:lock", closed],
  ["imports", "nl:imports:lock", imports], ["closing", "nl:closing:lock", closing],
  ["plans", "nl:plans:lock", plans], ["stream", "nl:stream:lock", stream],
] as const;
const pipeline = redis.pipeline.bind(redis);
const fetchBefore = globalThis.fetch;
const keys = ["CRON_SECRET", "BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY", "BUNNY_STREAM_TOKEN_KEY"] as const;
const env = keys.map((key) => process.env[key]);
beforeEach(() => {
  redis.clear();
  process.env.CRON_SECRET = "synthetic-j-cron-proof";
  process.env.BUNNY_STREAM_LIBRARY_ID = "123";
  process.env.BUNNY_STREAM_API_KEY = "synthetic-j-stream-proof";
  process.env.BUNNY_STREAM_TOKEN_KEY = "synthetic-j-player-proof";
  globalThis.fetch = async () => { throw new Error("No outside request allowed"); };
});
afterEach(() => {
  redis.pipeline = pipeline;
  globalThis.fetch = fetchBefore;
  keys.forEach((key, i) => { if (env[i] === undefined) delete process.env[key]; else process.env[key] = env[i]; });
});
for (const [name, key, run] of routes) {
  test(`${name}: an applied SET whose OK was lost retains the lock without work or release`, async () => {
    const commands: (string | number)[][] = [];
    redis.pipeline = async (batch) => {
      commands.push(...batch);
      if (batch[0][0] === "SET" && batch[0][1] === key) {
        assert.deepEqual(await pipeline(batch), ["OK"]);
        return [];
      }
      return pipeline(batch);
    };
    const response = await run(new NextRequest(`https://example.test/api/cron/${name}`, { headers: { authorization: "Bearer synthetic-j-cron-proof" } }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "unavailable" });
    assert.deepEqual(commands.map((command) => command[0]), ["SET"]);
    assert.equal(redis.run(["GET", key]), "1");
  });
}
