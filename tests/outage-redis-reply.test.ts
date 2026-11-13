/**
 * Outage drill (Claude 7, 13 November 2026): a Redis pipeline whose reply is
 * partial or malformed is unknown, never "the key is not there". A proxy or a
 * dropped connection can cut a reply short after the writes were applied; a
 * missing slot read as undefined is a counter at zero, a mark not yet taken or
 * a grant not found, so a caller could grant, count or send again. The client
 * fails such a reply as it fails a network error. Synthetic only: fetch is a
 * stand-in, nothing reaches a real service.
 */
import { redisPipeline, redisPipelineBase64 } from "@/lib/redis";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL = "https://redis.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "synthetic";
const answer = (body: string, status = 200) => {
  globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
};
const threw = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
};
const two: (string | number)[][] = [["SET", "a", "1", "NX"], ["GET", "b"]];

(async () => {
  for (const [name, call] of [["redisPipeline", redisPipeline], ["redisPipelineBase64", redisPipelineBase64]] as const) {
    part(`${name}: a reply that does not answer every command is unknown`);
    answer(JSON.stringify([{ result: "OK" }]));
    is("a reply one slot short throws", await threw(() => call(two)), true);
    answer(JSON.stringify([{ result: "OK" }, { result: null }, { result: "extra" }]));
    is("a reply with a slot too many throws", await threw(() => call(two)), true);
    answer(JSON.stringify([{ result: "OK" }, {}]));
    is("a slot with neither result nor error throws", await threw(() => call(two)), true);
    answer(JSON.stringify([{ result: "OK" }, null]));
    is("a null slot throws", await threw(() => call(two)), true);
    answer(JSON.stringify({ error: "WRONGPASS" }));
    is("an object instead of a list throws", await threw(() => call(two)), true);
    answer("<html>502 Bad Gateway</html>");
    is("a page instead of JSON throws", await threw(() => call(two)), true);
    answer("", 503);
    is("a 503 throws", await threw(() => call(two)), true);
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    is("a refused connection throws", await threw(() => call(two)), true);

    part(`${name}: a whole reply still reads`);
    answer(JSON.stringify([{ result: "OK" }, { result: null }]));
    is("one reply per command, null kept as null", await call(two), ["OK", null]);
    answer(JSON.stringify([]));
    is("no command, no reply", await call([]), []);
  }
  done();
})();
