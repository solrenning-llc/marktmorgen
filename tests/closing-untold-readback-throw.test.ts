/**
 * Codex C2's second review of #3009 (MEDIUM): a failure on markUntold's own round trips gives back the credit
 * certainly taken before it in the same round, once.
 *
 * Two buyers, two emails each, a credit of two: the first takes its two (confirmed), the second is not covered and
 * is marked untold. That HSETNX lands but its reply is out of shape, and the read-back (HGET) throws a synthetic
 * timeout. Before, the throw skipped returnCredit(certain): the first buyer's two emails stayed spent though nothing
 * was sent, and the next healthy run marked that buyer cap-untold for good. The same holds for an HSETNX whose round
 * trip throws. Controls: the read-back out of shape (already gave back), and a healthy run.
 *
 * Synthetic data only: the in-memory Redis (tests/redis-stub.ts), with replies swapped per command.
 */
import { creditKey, startClosingCredit } from "@/lib/closing-credit";
import { workKey } from "@/lib/closing-holds";
import { tellBuyers, toldKey } from "@/lib/closing-buyers";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Batch = (string | number)[][];
const pipe = redis.pipeline.bind(redis);
let swap: null | ((b: Batch, next: () => Promise<unknown[]>) => Promise<unknown[]>) = null;
redis.pipeline = (async (b: Batch) => (swap ? swap(b, () => pipe(b)) : pipe(b))) as typeof redis.pipeline;
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "returned";
  } catch {
    return "rejected";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  process.env.COMPANY_POSTAL_ADDRESS = "1 Test Street, Testville, DE 19901, USA";
  const owner = "untold-throw@example.com";
  await claimHandle(owner, "untoldthrow", "Untold Throw", "");
  const shop = await storeForEmail(owner);
  if (!shop) throw new Error("the test store was not made");
  const folder = await storeFolder(storeRef(shop));
  const told = toldKey(folder);
  const tell = () => tellBuyers(shop, Date.UTC(2026, 10, 1), Date.UTC(2026, 11, 1), "", Date.now() + 60_000);
  const credit = async () => (await pipe([["GET", creditKey(folder)]]))[0];
  const firstMark = async () => (await pipe([["HGET", told, "first@example.test"]]))[0];

  async function seed(): Promise<void> {
    swap = null;
    await pipe([["DEL", told, workKey(folder)], ["HSET", workKey(folder), "m:sub_first", "first@example.test", "m:sub_second", "second@example.test"]]);
    await startClosingCredit(folder, 2);
  }

  // Untold on the healthy retry: only the second buyer, and only when its mark did not land in the failed round.
  const cases: [string, number, (b: Batch, next: () => Promise<unknown[]>) => Promise<unknown[]>][] = [
    ["the read-back throws", 0, async (b, next) => {
      if (b[0]?.[0] === "HSETNX" && b[0][1] === told) { await next(); return [undefined]; }
      if (b[0]?.[0] === "HGET" && b[0][1] === told) throw new Error("synthetic read timeout");
      return next();
    }],
    ["the mark's own round trip throws", 1, async (b, next) => {
      if (b[0]?.[0] === "HSETNX" && b[0][1] === told) throw new Error("synthetic write timeout");
      return next();
    }],
    ["control: the read-back out of shape", 0, async (b, next) => {
      if (b[0]?.[0] === "HSETNX" && b[0][1] === told) { await next(); return [undefined]; }
      if (b[0]?.[0] === "HGET" && b[0][1] === told) return [undefined];
      return next();
    }],
  ];
  for (const [label, untold, rule] of cases) {
    part(label);
    await seed();
    swap = rule;
    is(`${label}: the round holds before sending`, await outcome(tell), "rejected");
    swap = null;
    is(`${label}: the first buyer is not marked`, await firstMark(), null);
    is(`${label}: the first buyer's certain credit is given back, once`, await credit(), "2");
    const next = await tell();
    is(`${label}: the healthy retry counts only the second buyer as not told`, next.untold, untold);
    is(`${label}: the first buyer is not labeled not told`, String((await firstMark()) ?? "").startsWith("x"), false);
  }
  done();
}

void main();
