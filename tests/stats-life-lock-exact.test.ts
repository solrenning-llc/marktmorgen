/**
 * The all-time record's fill lock is read exactly (CX-123 rule 24, lib/stats.ts readLife; lib/claim-mark.ts): "OK"
 * is this read's to fill, nil is another read filling it now. Any other answer, or none, is read back: the lock
 * holding this read's own value is ours, another value is somebody else's, anything else is unknown, so nothing is
 * filled, the lock this read may have taken is let go (only while it holds this read's value) and the all-time
 * record is "could not be read" (null) this time, never filled twice.
 *
 * Before: any reply but nil was the lock won, so a malformed reply filled the record a second time beside the run
 * holding the lock, and every count it copied was doubled.
 */
import { readFileSync } from "node:fs";
import { readStats } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** How the lock's SET NX is answered ("real", "drop", "throw" or a value in its place); `readBack` likewise for a GET of it. */
let lockReply: unknown = "real";
let readBack: unknown = "real";
let target = "";
/** How a lone HGETALL of `recordTarget` is answered, from its `recordAt`-th read on (0: the first): "real" or as above. */
let recordReply: unknown = "real";
let recordTarget = "";
let recordAt = 0;
let recordSeen = 0;
/** How the fill's read of the kept days (its HGETALLs of each day, then a PFCOUNT each) is answered: "real", or a function of the real replies. */
let daysReply: "real" | ((real: unknown[]) => unknown) = "real";
let daysTarget = "";
const pipeline = redis.pipeline.bind(redis);
const shaped = (real: unknown[], at: number, how: unknown): unknown[] => {
  if (how === "throw") throw new Error("synthetic: connection reset");
  if (how === "drop") return real.filter((_, i) => i !== at);
  return real.map((r, i) => (i === at ? how : r));
};
redis.pipeline = (async (commands: (string | number)[][]) => {
  const real = await pipeline(commands);
  // The fill's read only: every day's HGETALL, then every day's single-key PFCOUNT (readStats' own read adds
  // multi-key PFCOUNTs for its windows, and is never answered oddly here).
  const half = commands.length / 2;
  const fillRead = commands.length > 2 && Number.isInteger(half) &&
    commands.every((c, i) => c.length === 2 && c[0] === (i < half ? "HGETALL" : "PFCOUNT") && String(c[1]).startsWith(`nl:stats:${daysTarget}:`));
  if (daysReply !== "real" && fillRead) {
    return daysReply(real) as unknown[];
  }
  if (commands.length === 1 && commands[0][0] === "HGETALL" && commands[0][1] === recordTarget && recordReply !== "real") {
    recordSeen += 1;
    if (recordSeen > recordAt) return shaped(real, 0, recordReply);
  }
  const nx = commands.findIndex((c) => c[0] === "SET" && c[1] === target && c.includes("NX"));
  if (nx >= 0 && lockReply !== "real") return shaped(real, nx, lockReply);
  const get = commands.length === 1 ? commands.findIndex((c) => c[0] === "GET" && c[1] === target) : -1;
  if (get >= 0 && readBack !== "real") return shaped(real, get, readBack);
  return real;
}) as typeof redis.pipeline;
const reset = () => {
  lockReply = "real";
  readBack = "real";
  target = "";
  recordReply = "real";
  recordTarget = "";
  recordAt = 0;
  recordSeen = 0;
  daysReply = "real";
  daysTarget = "";
};

const NOW = Date.UTC(2026, 10, 6, 12);
const day = (back: number) => new Date(NOW - back * 86_400_000).toISOString().slice(0, 10);
const storeOf = (statsId: string) => ({ statsId, createdAt: new Date(NOW - 20 * 86_400_000).toISOString() }) as Store;
const lifeKey = (statsId: string) => `nl:stats:${statsId}:life`;
const lockKey = (statsId: string) => `nl:stats:${statsId}:life:lock`;

/** A store whose record started today, with five direct views kept from yesterday, not yet copied into it. */
async function seed(statsId: string): Promise<void> {
  await pipeline([
    ["HSET", lifeKey(statsId), "started", day(0)],
    ["HINCRBY", `nl:stats:${statsId}:${day(1)}`, "r:direct", 5],
    ["HINCRBY", `nl:stats:${statsId}:${day(1)}`, "v", 5],
  ]);
}
const life = async (statsId: string) => {
  const [raw] = await pipeline([["HGETALL", lifeKey(statsId)]]);
  const flat = (Array.isArray(raw) ? raw : []).map(String);
  const at = (name: string) => {
    const i = flat.indexOf(name);
    return i >= 0 && i % 2 === 0 ? flat[i + 1] : null;
  };
  return { filled: at("filled") !== null, direct: Number(at("r:direct") ?? 0) };
};
const ODD: [string, unknown][] = [["no reply", "drop"], ["a number", 1], ["a list", ["OK"]], ["an empty string", ""], ["the request failed", "throw"]];

async function main(): Promise<void> {
  redis.clear();

  part("healthy: filled once, from the days kept");
  await seed("lifehealthy");
  const healthy = await readStats(storeOf("lifehealthy"), NOW);
  is("the record is filled with yesterday's views", [await life("lifehealthy"), healthy?.life?.views], [{ filled: true, direct: 5 }, 5]);
  is("and its lock let go", (await pipeline([["GET", lockKey("lifehealthy")]]))[0], null);

  part("another read is filling it (its lock held): a malformed answer never fills it twice");
  for (const [label, odd] of ODD) {
    const id = `lifeheld${ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    await pipeline([["SET", lockKey(id), "1730000000000.000000001", "EX", 60]]);
    target = lockKey(id);
    lockReply = odd;
    await readStats(storeOf(id), NOW);
    reset();
    is(`${label}: nothing copied by this read`, await life(id), { filled: false, direct: 0 });
    is(`${label}: the other read's lock is kept`, (await pipeline([["GET", lockKey(id)]]))[0], "1730000000000.000000001");
  }

  part("a lock that landed but was answered oddly is read back as ours: filled once");
  for (const [label, odd] of ODD) {
    const id = `lifelanded${ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    target = lockKey(id);
    lockReply = odd;
    await readStats(storeOf(id), NOW);
    reset();
    is(`${label}: filled once`, await life(id), { filled: true, direct: 5 });
  }

  part("a lock that cannot be read back is unknown: not filled, let go, the all-time record not read this time");
  for (const [label, odd] of ODD) {
    const id = `lifeunread${ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    target = lockKey(id);
    lockReply = odd;
    readBack = "throw";
    const got = await readStats(storeOf(id), NOW);
    reset();
    is(`${label}: the all-time record is not given`, got?.life ?? null, null);
    is(`${label}: nothing copied`, await life(id), { filled: false, direct: 0 });
    is(`${label}: the lock is not held`, (await pipeline([["GET", lockKey(id)]]))[0], null);
    await readStats(storeOf(id), NOW);
    is(`${label}: the next read fills it once`, await life(id), { filled: true, direct: 5 });
  }

  // Review of #2905 (Claude 5): the record itself was read loosely, so any answer but a list read as an empty record,
  // "filled" was not seen, the lock (let go by the first fill) was free, and every kept day was added a second time.
  const RECORD_ODD: [string, unknown][] = [
    ["no reply", "drop"],
    ["a number", 7],
    ["a string", "filled"],
    ["an object", { filled: "x" }],
    ["an odd-length list", ["filled"]],
    ["a list holding a number", ["filled", 1]],
    ["the request failed", "throw"],
  ];
  part("a record already filled, answered oddly, is never filled again: not given this time, counted once");
  for (const [label, odd] of RECORD_ODD) {
    const id = `liferecord${RECORD_ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    await readStats(storeOf(id), NOW);
    is(`${label}: filled once by the first read`, await life(id), { filled: true, direct: 5 });
    recordTarget = lifeKey(id);
    recordReply = odd;
    const got = await readStats(storeOf(id), NOW);
    reset();
    is(`${label}: a second read never fills it again`, (await life(id)).direct, 5);
    is(`${label}: and gives no all-time record this time`, got?.life ?? null, null);
    is(`${label}: no lock left taken`, (await pipeline([["GET", lockKey(id)]]))[0], null);
    is(`${label}: the next read gives it, counted once`, (await readStats(storeOf(id), NOW))?.life?.views, 5);
  }

  part("the record read again after filling, answered oddly: filled once, not given this time");
  for (const [label, odd] of RECORD_ODD) {
    const id = `lifereread${RECORD_ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    recordTarget = lifeKey(id);
    recordReply = odd;
    recordAt = 1;
    const got = await readStats(storeOf(id), NOW);
    reset();
    is(`${label}: filled once`, await life(id), { filled: true, direct: 5 });
    is(`${label}: not given from a guess`, got?.life ?? null, null);
    is(`${label}: the next read gives it, counted once`, (await readStats(storeOf(id), NOW))?.life?.views, 5);
  }

  // Review of #2905 (Claude 5, MEDIUM, rule 30): the fill read the kept days loosely, so an answer in another shape
  // made every day empty and its visitors 0, and the record was still marked filled: those views were gone for good.
  const DAYS_ODD: [string, (real: unknown[]) => unknown][] = [
    ["a number", () => 7],
    ["a string", () => "x"],
    ["an object", () => ({ 0: [] })],
    ["a short pipeline", (real) => real.slice(0, -1)],
    ["a day answered as an odd-length list", (real) => real.map((r, i) => (i === real.length / 2 - 1 ? ["r:direct"] : r))],
    ["a day holding a count that is not a whole number", (real) => real.map((r, i) => (i === real.length / 2 - 1 ? ["r:direct", "five"] : r))],
    ["a visitor count answered as text", (real) => real.map((r, i) => (i === real.length - 1 ? "3" : r))],
    ["the request failed", () => { throw new Error("synthetic: connection reset"); }],
  ];
  part("the kept days answered oddly: the record is never marked filled without them, and the next read fills it once");
  for (const [label, odd] of DAYS_ODD) {
    const id = `lifedays${DAYS_ODD.findIndex(([l]) => l === label)}`;
    await seed(id);
    daysTarget = id;
    daysReply = odd;
    const got = await readStats(storeOf(id), NOW);
    reset();
    is(`${label}: the record is not marked filled without the 5 kept views`, await life(id), { filled: false, direct: 0 });
    is(`${label}: no all-time record from a guess this time`, got?.life ?? null, null);
    is(`${label}: no lock left taken`, (await pipeline([["GET", lockKey(id)]]))[0], null);
    is(`${label}: the next read fills it once`, [await (async () => (await readStats(storeOf(id), NOW))?.life?.views)(), await life(id)], [5, { filled: true, direct: 5 }]);
  }

  part("confirmed absence: a store with no record yet is filled once, and its lock let go by its own value");
  await pipeline([["HINCRBY", `nl:stats:lifenone:${day(1)}`, "r:direct", 3]]);
  const none = await readStats(storeOf("lifenone"), NOW);
  is("no record at all: filled from the kept days", [await life("lifenone"), none?.life?.views], [{ filled: true, direct: 3 }, 3]);
  is("read again: still counted once", (await readStats(storeOf("lifenone"), NOW))?.life?.views, 3);

  part("the fill lets go only its own lock (LEVE of the review of #2905)");
  const stats = readFileSync("lib/stats.ts", "utf8");
  const fill = stats.slice(stats.indexOf('if (claimed === "ours")'), stats.indexOf("// All-time views are the sum"));
  is("no unconditional DEL of the lock in the fill", fill.includes('["DEL", lifeLockKey(statsId)]'), false);
  is("the lock is let go with this read's value", fill.includes("await releaseMark(lifeLockKey(statsId), mine);"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
