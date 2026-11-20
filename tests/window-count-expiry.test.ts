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
import { takeMoveRoom } from "@/lib/auth";
import { withinChallengeWrites } from "@/lib/community-challenges";
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

  // Review of #2271 (Claude 4 cloud AI, MEDIUM): the month's room for sign-in address moves (lib/auth.ts, countMove)
  // counted with the same SET NX EX + INCR pair, so a key that expired between them refused every move for good.
  part("takeMoveRoom: the month's move counts expire between the two commands");
  {
    redis.clear();
    const moveKeys = () => (redis.run(["SCAN", "0", "MATCH", "nl:auth:move-room:*", "COUNT", 10_000]) as [string, string[]])[1];
    const store = { id: "synthetic-move-store", paid: true };
    is("the first move is within", await takeMoveRoom(store), "within");
    expireBetween = true;
    await takeMoveRoom(store);
    is("no move count is left without an expiry", moveKeys().filter((k) => redis.run(["TTL", k]) === -1), []);
    is("and a move is still counted within afterward", await takeMoveRoom(store), "within");
  }

  // Review of #3452 (Claude 4 cloud Z, MEDIUM): a creator's changes to challenges in an hour (lib/community-challenges.ts,
  // withinChallengeWrites) counted with the same SET NX EX + INCR pair, so a key that expired between them locked the
  // creator out of making or deleting challenges for good.
  part("withinChallengeWrites: the hour's count expires between the two commands");
  {
    redis.clear();
    const keys = () => (redis.run(["SCAN", "0", "MATCH", "*:chw", "COUNT", 10_000]) as [string, string[]])[1];
    is("the first change is within", await withinChallengeWrites("synthetic-community"), true);
    expireBetween = true;
    await withinChallengeWrites("synthetic-community");
    is("no count is left without an expiry", keys().filter((k) => redis.run(["TTL", k]) === -1), []);
    is("and a change is still counted within afterward", await withinChallengeWrites("synthetic-community"), true);
  }

  part("The window starts with the first use and is not moved by the next ones (the EXPIRE's NX)");
  // Without NX every use would give the key its whole window again: a steady caller would never see the count end.
  redis.clear();
  is("the first use opens a window of 60 seconds", await withinLimit("synthetic-fixed", "203.0.113.9", 100, 60), true);
  const key = (redis.run(["SCAN", "0", "MATCH", "nl:rl*", "COUNT", 10_000]) as [string, string[]])[1][0];
  advance(40_000);
  await withinLimit("synthetic-fixed", "203.0.113.9", 100, 60);
  const secondsLeft = redis.run(["TTL", key]) as number;
  is("a use 40 seconds in leaves the window's end where it was (20 seconds left, not 60)", secondsLeft > 0 && secondsLeft <= 20, true);
  advance(21_000);
  is("and once it ends, the count starts again from one", redis.run(["GET", key]), null);

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
  // Either order of the SET's options: `"EX", n, "NX"` and `"NX", "EX", n` race the same way (Claude 7 on #3369).
  // A pair followed at once by the key's own EXPIRE … NX gives the key its expiry back whatever happened, so it is safe
  // (lib/calendar-sync.ts, the day's key in lib/store-readings.ts).
  const pair = /\["SET", ([^,\]]+), "0", (?:"EX", [^\]]+, "NX"|"NX", "EX", [^\]]+)\],\s*\["INCR(?:BY)?", \1[^\]]*\](?!,\s*\["EXPIRE", \1, [^\]]+, "NX"\])/;
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
