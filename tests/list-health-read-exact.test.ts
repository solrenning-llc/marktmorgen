/**
 * #2314, Claude 1 cloud's MEDIUM at 5ffedf826b (CX-123 rule 24): the studio's email-health table drew
 * lib/mail-health.ts listHealth, which reads loosely, so a short pipeline reply, a day row that is not one or a field
 * that is not a count became 0 and the page showed counts, a level and a distance from a pause that were not known.
 * Scenario: 1,000 sent and 25 bounced in the window, the day holding 20 of the bounces answered null: the table said
 * bounced 5, "under half of the level that pauses", 20 more to a pause, when the next notice pauses the list.
 *
 * The page now reads the same keys through listHealthExact (lib/list-health-read.ts), which throws on any reply it
 * cannot read whole, so the section says "not read just now". Synthetic Redis only.
 */
import { readFileSync } from "node:fs";
import { listHealthExact } from "@/lib/list-health-read";
import { listHealth } from "@/lib/mail-health";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ID = "health-fixture";
const NOW = Date.parse("2026-11-16T12:00:00Z");
const day = (back: number) => new Date(NOW - back * 86_400_000).toISOString().slice(0, 10);
const real = redis.pipeline.bind(redis);

async function outcome(alter?: (replies: unknown[]) => unknown): Promise<string> {
  if (alter) redis.pipeline = (async (batch: (string | number)[][]) => alter(await real(batch))) as typeof redis.pipeline;
  try {
    return JSON.stringify(await listHealthExact(ID, NOW));
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `threw ${String(error)}`;
  } finally {
    redis.pipeline = real;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await real([
    ["HSET", `nl:mail:health:${ID}:${day(0)}`, "s", "1000", "b", "5"],
    ["HSET", `nl:mail:health:${ID}:${day(1)}`, "b", "20", "c", "1"],
  ]);

  part("Control: a whole read gives the same seven days as listHealth");
  is("the counts", await outcome(), JSON.stringify({ sent: 1000, bounced: 25, complained: 1 }));
  is("as listHealth counts them", await outcome(), JSON.stringify(await listHealth(ID, NOW)));

  part("A reply not read whole is unknown, never counts (the page then says not read)");
  const damaged: [string, (r: unknown[]) => unknown][] = [
    ["the day holding 20 bounces answered null", (r) => r.map((row, i) => (i === 2 ? null : row))],
    ["a reply of four rows for eight commands", (r) => r.slice(0, 4)],
    ["one reply too many", (r) => [...r, null]],
    ["no reply at all", () => null],
    ["a field that is not a count", (r) => r.map((row, i) => (i === 2 ? ["0", "twenty", "1"] : row))],
    ["a negative count", (r) => r.map((row, i) => (i === 2 ? ["0", "-20", "1"] : row))],
    ["a day row of two fields", (r) => r.map((row, i) => (i === 2 ? ["0", "20"] : row))],
    ["a pause's end that is not a day", (r) => ["soon", ...r.slice(1)]],
  ];
  for (const [label, alter] of damaged) is(label, await outcome(alter), "unknown");

  part("A served pause's end still starts the count again, as listHealth");
  await real([["SET", `nl:mail:health:${ID}:from`, day(0)]]);
  is("only today counts", await outcome(), JSON.stringify({ sent: 1000, bounced: 5, complained: 0 }));
  is("as listHealth", await outcome(), JSON.stringify(await listHealth(ID, NOW)));

  part("The studio's health section reads through the exact reader, and says only what the code does");
  const page = readFileSync("app/studio/email/page.tsx", "utf8");
  is("the page reads listHealthExact", page.includes("listHealthExact(healthId(store))"), true);
  is("not the loose listHealth", /\blistHealth\(/.test(page), false);
  const table = readFileSync("components/list-health-table.tsx", "utf8");
  is("no comment says listHealth throws on an incomplete read", /listHealth\s+throws/.test(table) || /listHealth refuses an incomplete read/.test(page), false);
}

main().then(done, (error) => { console.error(error); process.exit(1); });
