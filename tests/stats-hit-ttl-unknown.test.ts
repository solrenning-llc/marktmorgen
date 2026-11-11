/**
 * A counted hit whose answer is not known still leaves the day's records with their expiry
 * (lib/stats.ts, recordHit; rule 24 sweep of Claude 4, cloud F, 11 November 2026).
 *
 * The defect: the day's expiry (and the live list's, and the day's visitors') was written only when the
 * count came back exactly 1, the day's first write. A count whose answer was lost after Redis wrote it
 * (a timeout), or came back in a shape that cannot be read, was taken as "not the first" ([] or 0), so a
 * day whose first write was that one kept its record for good. Now an unknown answer sends the expiries
 * anyway; it never writes the all-time record's start, which only a known first write may say.
 */
import { recordHit } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const STATS = "e".repeat(32);
const NOW = Date.UTC(2026, 10, 11, 3, 0, 0);
const DAY = "2026-11-11";
const COUNTS = `nl:stats:${STATS}:${DAY}`;
const VISITORS = `${COUNTS}:u`;
const LIVE = `nl:stats:${STATS}:live`;
const LIFE = `nl:stats:${STATS}:life`;
const KEPT = 400 * 86_400;
const store = { statsId: STATS, handle: "harbor" } as unknown as Store;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const view = { kind: "view" as const, ip: "203.0.113.7", userAgent: UA, source: "direct" };

const real = redis.pipeline.bind(redis);
type Pipe = typeof real;
/** Runs the first pipeline that holds an EVAL for real, then answers it in another shape or not at all. */
function garbleFirstEval(how: "shape" | "lost"): void {
  let armed = true;
  redis.pipeline = (async (commands: Parameters<Pipe>[0]) => {
    const replies = await real(commands);
    if (armed && commands.some((c) => c[0] === "EVAL")) {
      armed = false;
      if (how === "lost") throw new Error("synthetic timeout after the write");
      return replies.map((r, i) => (commands[i][0] === "EVAL" ? "?" : r));
    }
    return replies;
  }) as Pipe;
}
const ttl = async (key: string) => Number((await real([["TTL", key]]))[0]);
const kept = (left: number) => left > 0 && left <= KEPT;

async function main(): Promise<void> {
  part("Control: a day's first view, answered");
  redis.clear();
  redis.pipeline = real;
  await recordHit(store, view, NOW);
  is("the day's record expires", kept(await ttl(COUNTS)), true);
  is("the day's visitors expire", kept(await ttl(VISITORS)), true);
  is("the all-time record's start is written", (await real([["HGET", LIFE, "started"]]))[0], DAY);

  part("A day's first view whose count came back in a shape that cannot be read");
  redis.clear();
  garbleFirstEval("shape");
  await recordHit(store, view, NOW);
  redis.pipeline = real;
  is("the view was written", (await real([["HGET", COUNTS, "v"]]))[0], "1");
  is("the day's record still expires", kept(await ttl(COUNTS)), true);
  is("the live list still expires", (await ttl(LIVE)) > 0, true);
  is("the day's visitors still expire", kept(await ttl(VISITORS)), true);
  is("an unknown answer never says when the all-time record started", (await real([["HGET", LIFE, "started"]]))[0], null);

  part("A day's first view whose count came back in a shape that cannot be read: each expiry sent once");
  redis.clear();
  garbleFirstEval("shape");
  const sent: string[] = [];
  const garbled = redis.pipeline;
  redis.pipeline = (async (commands: Parameters<Pipe>[0]) => {
    for (const c of commands) if (c[0] === "EXPIRE") sent.push(String(c[1]));
    return garbled(commands);
  }) as Pipe;
  await recordHit(store, view, NOW);
  redis.pipeline = real;
  is("no key's expiry is sent twice", sent.length, new Set(sent).size);
  is("(the visitors' expiry is among them)", sent.includes(VISITORS), true);

  part("A day's first view whose answer was lost after the write");
  redis.clear();
  garbleFirstEval("lost");
  let threw = false;
  try {
    await recordHit(store, view, NOW);
  } catch {
    threw = true;
  }
  redis.pipeline = real;
  is("the lost answer is still an error to the caller", threw, true);
  is("the view was written", (await real([["HGET", COUNTS, "v"]]))[0], "1");
  is("the day's record still expires", kept(await ttl(COUNTS)), true);
  is("the day's visitors still expire", kept(await ttl(VISITORS)), true);

  part("A product page's view whose answer was lost after the write");
  redis.clear();
  garbleFirstEval("lost");
  const shown = await recordHit(store, { kind: "product", id: "prod01", ip: "203.0.113.7", userAgent: UA }, NOW);
  redis.pipeline = real;
  is("the product page still answers nothing, as before", shown, null);
  is("its view was written", (await real([["HGET", COUNTS, "pv:prod01"]]))[0], "1");
  is("the day's record still expires", kept(await ttl(COUNTS)), true);

  part("A product page's view, answered, after the day's first: no extra command");
  redis.clear();
  await recordHit(store, { kind: "product", id: "prod01", ip: "203.0.113.7", userAgent: UA }, NOW);
  let expiries = 0;
  redis.pipeline = (async (commands: Parameters<Pipe>[0]) => {
    expiries += commands.filter((c) => c[0] === "EXPIRE").length;
    return real(commands);
  }) as Pipe;
  await recordHit(store, { kind: "product", id: "prod01", ip: "203.0.113.7", userAgent: UA }, NOW + 1_000);
  redis.pipeline = real;
  is("a known second view sends no expiry", expiries, 0);

  done();
}

main();
