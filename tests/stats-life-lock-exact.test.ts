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
import { readStats } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

/** How the lock's SET NX is answered ("real", "drop", "throw" or a value in its place); `readBack` likewise for a GET of it. */
let lockReply: unknown = "real";
let readBack: unknown = "real";
let target = "";
const pipeline = redis.pipeline.bind(redis);
const shaped = (real: unknown[], at: number, how: unknown): unknown[] => {
  if (how === "throw") throw new Error("synthetic: connection reset");
  if (how === "drop") return real.filter((_, i) => i !== at);
  return real.map((r, i) => (i === at ? how : r));
};
redis.pipeline = (async (commands: (string | number)[][]) => {
  const real = await pipeline(commands);
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
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
