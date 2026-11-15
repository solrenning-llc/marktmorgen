/**
 * Defect #4391 (Codex G): before a closing store's record goes (lib/closed-store-data.ts, prepareStore), the slots
 * its calendar hosts claimed for it are taken out of each host's claims (`nl:host:claims:<host>`). That walk reads
 * every HSCAN page exactly (a cursor and string pairs), must reach cursor zero within its page ceiling, and each HDEL
 * must answer one whole count from 0 to the fields asked. Anything else is unknown (rule 24): the store is not
 * prepared, its record stays, it waits a walk, and the next run removes the claim. Synthetic records only.
 */
import { DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { claimsKey, hostId } from "@/lib/host-claims";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Batch = (string | number)[][];
/** What the next HSCAN (or HDEL) of a host's claims answers instead of Redis, given Redis's own answer. */
let hscan: ((real: unknown[]) => unknown) | null = null;
let hdel: ((real: unknown[]) => unknown) | null = null;
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: Batch) => {
  const one = commands.length === 1 && String(commands[0][1]).startsWith("nl:host:claims:");
  if (one && commands[0][0] === "HSCAN" && hscan) return hscan(await realPipeline(commands)) as never;
  if (one && commands[0][0] === "HDEL" && hdel) {
    // The deletion is done, as a lost receipt would leave it, or not: either way its answer is not one Redis gives.
    return hdel(await realPipeline(commands)) as never;
  }
  return realPipeline(commands);
};

const X = "claims-host@example.com";
const FIELD = "k000000000000000000000001";

async function closing(): Promise<{ key: string; at: number }> {
  redis.clear();
  await claimHandle(X, "claimshost", "claimshost", "");
  await ensureStatsId(X);
  await ensureStoreId(X);
  const store = await storeForEmail(X);
  if (!store?.sid) throw new Error("setup: no store");
  const key = claimsKey(hostId(X));
  await realPipeline([["HSET", key, FIELD, `1|2|0|${store.sid}`]]);
  const at = Date.now();
  await markDue(X, at - 1000);
  return { key, at };
}

async function main(): Promise<void> {
  part("Control: read whole, the claim goes and the store is prepared");
  {
    const { key, at } = await closing();
    const run = await eraseClosed(Date.now() + 30_000, async () => {}, at);
    is("prepared, record closed, claim gone", [run.stores, (await storeForEmail(X)) === null, redis.run(["HEXISTS", key, FIELD])], [1, true, 0]);
  }

  const cases: [string, "hscan" | "hdel", (real: unknown[]) => unknown][] = [
    ["an HSCAN with no reply", "hscan", () => []],
    ["an HSCAN page that is not a pair", "hscan", (real) => [Array.isArray(real[0]) ? (real[0] as unknown[]).slice(0, 1) : real[0]]],
    ["an HSCAN page with an odd list of fields and values", "hscan", (real) => {
      const page = real[0] as [string, string[]];
      return [[page[0], [...page[1], "stray"]]];
    }],
    ["an HSCAN slot that is not a list", "hscan", () => ["0"]],
    ["an HSCAN still open at the page ceiling", "hscan", (real) => {
      const page = real[0] as [string, string[]];
      return [["17", page[1].length ? [] : page[1]]];
    }],
    ["an HDEL with no reply", "hdel", () => []],
    ["an HDEL answered as text", "hdel", () => ["1"]],
    ["an HDEL that says it removed more than it was asked", "hdel", () => [2]],
  ];
  for (const [what, where, shaped] of cases) {
    part(`${what}: the store waits, and the next run removes the claim`);
    const { key, at } = await closing();
    if (where === "hscan") hscan = shaped;
    else hdel = shaped;
    let threw = false;
    let first = { stores: -1 };
    try {
      first = await eraseClosed(Date.now() + 30_000, async () => {}, at);
    } catch {
      threw = true;
    }
    hscan = null;
    hdel = null;
    is("not prepared: its record stays, and it is still in line", [threw ? 0 : first.stores, (await storeForEmail(X)) !== null, redis.run(["ZSCORE", DUE_KEY, X]) !== null], [0, true, true]);
    const second = await eraseClosed(Date.now() + 30_000, async () => {}, at + WALK_GAP_MS + 1);
    is("read whole the next time: prepared, and the claim is gone", [second.stores, redis.run(["HEXISTS", key, FIELD])], [1, 0]);
  }
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
