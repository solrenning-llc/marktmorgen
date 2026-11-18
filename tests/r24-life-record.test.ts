/**
 * The path's numbers read the all-time record and the short links exactly (CX-123 rule 24; lib/stats.ts
 * readLifeRecord, lib/short-links.ts countLinks, lib/path-facts.ts readPathCounts). readPathCounts promises null
 * when the database could not be read, so the last reading stays shown: an answer in another shape is that, never
 * an empty record or no links. A record that is not there yet, and no links, are still read as zeros.
 *
 * Before: readLifeRecord read the record with the loose `pairs`, so a number, a string, an object, an odd-length
 * list or a count in words became an empty record (or a 0 count), and countLinks took any odd answer for 0 links:
 * the path showed zeros in place of the last reading. Rule 30: readLife (the studio's all-time numbers) read its
 * counts with the same loose `pairs`, so a count in words was taken for 0 views.
 */
import { readFileSync } from "node:fs";
import { readPathCounts } from "@/lib/path-facts";
import { readStats } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let target = "";
let command = "";
let reply: unknown = "real";
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const real = await pipeline(commands);
  if (reply === "real" || commands.length !== 1 || commands[0][0] !== command || commands[0][1] !== target) return real;
  if (reply === "throw") throw new Error("synthetic: connection reset");
  if (reply === "drop") return [];
  return [reply];
}) as typeof redis.pipeline;

const NOW = Date.UTC(2026, 10, 6, 12);
const today = new Date(NOW).toISOString().slice(0, 10);
const lifeKey = (statsId: string) => `nl:stats:${statsId}:life`;
const linksKey = (statsId: string) => `nl:slink:store:${statsId}`;
const storeOf = (statsId: string) => ({ statsId, handle: statsId, createdAt: new Date(NOW - 20 * 86_400_000).toISOString() }) as Store;

/** A record already filled: 4 visits from Instagram, 2 from direct, 2 addresses left, 3 visitors; and 2 short links. */
async function seed(statsId: string): Promise<void> {
  await pipeline([
    ["HSET", lifeKey(statsId), "started", today, "since", today, "filled", today, "r:instagram", 4, "r:direct", 2, "fs:email", 2, "lc", 2, "u", 3, "vgap", 0],
    ["HSET", linksKey(statsId), "a1", "{}", "b2", "{}"],
  ]);
}
const counts = async (statsId: string) => {
  const got = await readPathCounts(storeOf(statsId), NOW);
  return got && { social: got.social, visitors: got.visitors, links: got.links, leads: got.leads };
};

async function main() {
  part("read as kept: the path counts the record and the links");
  await seed("lifereal");
  is("the record and the links, read as they are", await counts("lifereal"), { social: 4, visitors: 3, links: 2, leads: 2 });

  part("confirmed absence: no record yet and no links are zeros, not an unreadable answer");
  is("nothing kept yet", await counts("lifenone"), { social: 0, visitors: 0, links: 0, leads: 0 });

  const RECORD_ODD: [string, unknown][] = [
    ["a number", 7],
    ["a string", "x"],
    ["an object", { 0: "r:instagram", 1: "4" }],
    ["an odd-length list", ["r:instagram", "4", "u"]],
    ["a list holding a number", ["r:instagram", 4]],
    ["a count in words", ["r:instagram", "four", "u", "3"]],
    ["a count that is not whole", ["r:instagram", "4.5", "u", "3"]],
    ["a negative count (no writer ever subtracts)", ["r:instagram", "-4", "u", "3"]],
    ["no reply in the pipeline", "drop"],
    ["the request failed", "throw"],
  ];
  part("the all-time record answered in another shape: no counts this time, so the last reading stays shown");
  for (const [label, odd] of RECORD_ODD) {
    const id = `liferec${RECORD_ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    command = "HGETALL";
    target = lifeKey(id);
    reply = odd;
    const got = await counts(id);
    reply = "real";
    is(`${label}: null, never zeros`, got, null);
  }

  const LINKS_ODD: [string, unknown][] = [
    ["a count as text", "2"],
    ["a negative count", -1],
    ["a count that is not whole", 1.5],
    ["an object", { n: 2 }],
    ["no reply in the pipeline", "drop"],
    ["the request failed", "throw"],
  ];
  part("rule 30: the short links' count answered in another shape is no count this time, never 0 links");
  for (const [label, odd] of LINKS_ODD) {
    const id = `lifelinks${LINKS_ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    command = "HLEN";
    target = linksKey(id);
    reply = odd;
    const got = await counts(id);
    reply = "real";
    is(`${label}: null, never zeros`, got, null);
  }

  part("rule 30: the studio's all-time numbers never take a count in words for 0 views");
  await seed("lifestudio");
  is("read as kept: 6 views", (await readStats(storeOf("lifestudio"), NOW))?.life?.views, 6);
  await pipeline([["HSET", lifeKey("lifestudio"), "r:direct", "two"]]);
  is("a count in words: no all-time record this time, not 4 views", (await readStats(storeOf("lifestudio"), NOW))?.life ?? null, null);

  part("source: the all-time record is never read with the loose pairs");
  const stats = readFileSync("lib/stats.ts", "utf8");
  const record = stats.slice(stats.indexOf("export async function readLifeRecord"), stats.indexOf("/** Sales in the last STATS_DAYS days"));
  is("readLifeRecord does not use pairs(", /\bpairs\(/.test(record), false);
  const life = stats.slice(stats.indexOf("async function readLife(store"), stats.indexOf("// All-time views are the sum"));
  is("readLife does not use pairs(", /\bpairs\(/.test(life), false);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
