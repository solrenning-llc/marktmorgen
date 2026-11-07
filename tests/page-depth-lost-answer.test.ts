/**
 * A sales page's reading counted with its time, whose answer is lost after it was written, still keeps both records
 * to their 400 days (Claude 5's second review of #2571, LOW 2): an answer that is not exactly the two counts sent
 * sends both expiries again, never none. Synthetic records (MemoryRedis); no outside request.
 */
import { countDepth } from "@/lib/page-depth";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async () => {
  throw new Error("No outside request in this test");
}) as typeof fetch;

const STATS = "statsdepth01";
const PRODUCT = "prod000001";

async function main(): Promise<void> {
  const pipe = redis.pipeline.bind(redis);
  for (const [label, lose] of [
    ["the answer is lost after the write", async (cs: (string | number)[][]) => {
      await pipe(cs);
      throw new Error("Redis request failed with status 504");
    }],
    ["the answer comes back empty", async (cs: (string | number)[][]) => {
      await pipe(cs);
      return [];
    }],
    ["the answer is cut to one count", async (cs: (string | number)[][]) => {
      const [reply] = await pipe(cs);
      return [Array.isArray(reply) ? [reply[0]] : reply];
    }],
  ] as [string, (cs: (string | number)[][]) => Promise<unknown[]>][]) {
    part(label);
    redis.clear();
    let once = true;
    redis.pipeline = (async (cs: (string | number)[][]) => {
      if (once && cs.length === 1 && cs[0][0] === "EVAL") {
        once = false;
        return lose(cs);
      }
      return pipe(cs);
    }) as typeof redis.pipeline;
    await countDepth(STATS, PRODUCT, "blok0001", "", "", 42);
    redis.pipeline = pipe;
    const [blocks, time] = (await pipe([["TTL", `nl:depth:${STATS}:${PRODUCT}`], ["TTL", `nl:depth:${STATS}:${PRODUCT}:t`]])) as number[];
    is(`${label}: the blocks' record keeps its expiry`, blocks > 0, true);
    is(`${label}: the time's record keeps its expiry`, time > 0, true);
  }
  done();
}
void main();
