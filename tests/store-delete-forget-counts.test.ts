/**
 * Siblings of #4752 (Claude 5): three more steps of a store's deletion
 * (app/api/store/stores/route.ts) sent a DEL and never read its reply, so an
 * unknown answer resolved as a finished erasure, exactly as forgetRecentSales did:
 * forgetStoreBenefits (lib/tier-benefits.ts), forgetStoreCalendar
 * (lib/calendar-sync.ts) and forgetStoreReadings (lib/store-readings.ts).
 * Now each confirms only a count from 0 up to the keys it named. Synthetic Redis only.
 */
import { forgetStoreBenefits } from "@/lib/tier-benefits";
import { forgetStoreCalendar } from "@/lib/calendar-sync";
import { forgetStoreReadings } from "@/lib/store-readings";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";

const STATS = "5d1f0e6a2b3c4d5e6f708192a3b4c5d6";
const real = redis.pipeline.bind(redis);
let broken: unknown[] | null = null;
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (broken && commands.length === 1 && commands[0]?.[0] === "DEL") return broken as never;
  return real(commands);
}) as typeof redis.pipeline;

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "resolved";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other ${String(error)}`;
  }
}

const STEPS: [string, () => Promise<unknown>][] = [
  ["forgetStoreBenefits", () => forgetStoreBenefits(STATS)],
  ["forgetStoreCalendar", () => forgetStoreCalendar(STATS)],
  ["forgetStoreReadings", () => forgetStoreReadings(STATS)],
];

const BAD: [string, unknown[]][] = [
  ["no reply", []],
  ["an empty slot", [undefined]],
  ["text", ["OK"]],
  ["a count below zero", [-1]],
  ["a fraction", [0.5]],
  ["more than the keys it named", [99]],
  ["an extra reply", [1, 1]],
];

void (async () => {
  for (const [name, run] of STEPS) {
    part(`${name}: a store's deletion is never confirmed on an unknown DEL reply`);
    for (const [label, reply] of BAD) {
      redis.clear();
      broken = reply;
      is(`${name}, ${label}: not confirmed`, await outcome(run), "UnknownReplyError");
      broken = null;
    }
    redis.clear();
    is(`${name}: a real deletion still resolves`, await outcome(run), "resolved");
  }
  done();
})();
