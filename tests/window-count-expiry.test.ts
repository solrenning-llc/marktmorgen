/**
 * A count in a window never outlives its window (C7 TTL hunt, lib/window-count.ts).
 *
 * Before: every limiter counted with `["SET", key, "0", "EX", window, "NX"], ["INCR", key]`. An Upstash pipeline is not
 * one step: when the key was there for the SET (so it did nothing) and expired before the INCR, the INCR made it again
 * with no expiry. Every later SET NX did nothing, the count only grew, and whoever it counted was refused for good, the
 * key with its hashed address kept forever. Now the INCR comes first and the expiry is set when the key has none.
 *
 * Synthetic: the in-memory Redis stand-in, whose pipeline is made to let the key expire between the first command and
 * the next, the worst moment.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { essentialLimitState, withinLimit, withinMonth } from "@/lib/request-guard";
import { advance, store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
/** When set, the key the pipeline's first command names expires right after that command runs. */
let expireBetween = false;
redis.pipeline = (async (commands: Command[]) => {
  if (!expireBetween || commands.length < 2) return real(commands);
  expireBetween = false;
  const key = String(commands[0][1]);
  const first = await real([commands[0]]);
  await real([["DEL", key]]);
  return [...first, ...(await real(commands.slice(1)))];
}) as typeof redis.pipeline;

/** Every key with no expiry. */
const forever = () => (redis.run(["SCAN", "0", "MATCH", "nl:rl*", "COUNT", 10_000]) as [string, string[]])[1].filter((k) => redis.run(["TTL", k]) === -1);

async function main(): Promise<void> {
  for (const [name, count] of [
    ["withinLimit", () => withinLimit("synthetic", "203.0.113.7", 3, 60)],
    ["essentialLimitState", () => essentialLimitState("synthetic-essential", "203.0.113.7", 3, 60).then((s) => s === "within")],
    ["withinMonth", () => withinMonth("synthetic-month", "203.0.113.7", 3, "2026-11")],
  ] as const) {
    part(`${name}: the key expires between the two commands`);
    redis.clear();
    is("the first use is counted", await count(), true);
    expireBetween = true;
    await count();
    is("no counter is left without an expiry", forever(), []);
    // The window goes by; the next uses start a fresh window, never a count that only grows.
    advance(61_000);
    is("after it, uses are counted again from one", [await count(), await count(), await count()], [true, true, true]);
  }

  part("No limiter counts with SET NX then INCR in a pipeline any more");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk("lib");
  walk("app");
  const pair = /\["SET", ([^,\]]+), "0", "EX", [^\]]+, "NX"\],\s*\["INCR(?:BY)?", \1/;
  const left = files.filter((f) => f !== join("lib", "redis-memory.ts") && pair.test(readFileSync(f, "utf8"))).sort();
  // Reserved by other agents (docs/reservations/): their owners move them to lib/window-count.ts in their own units.
  // lib/letter-access.ts keeps the pattern on purpose (no EXPIRE option, tests/letter-members.test.ts) and reads the
  // key's TTL in the same round, giving one back to a key left with none.
  const reserved = ["lib/card-update.ts", "lib/community-access.ts", "lib/community-events.ts", "lib/community.ts", "lib/free.ts", "lib/membership-manage.ts", "lib/letter-access.ts"].map((f) => join(...f.split("/")));
  is("only the files reserved by other agents, and the one that repairs its key, still do; no new one", left, reserved.sort());
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
