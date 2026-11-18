/**
 * The quiet-sales email tells the creator how many visits and checkouts the
 * quiet days had, and what that means: "Nobody has visited. Check that the
 * link in your bio..." (lib/quiet-sales.ts, from lib/stats.ts daysCounts).
 * Before, a day Redis answered in another shape was skipped or read as 0, so
 * a store with visitors could be told nobody came. daysCounts now reads each
 * day exactly and throws UnknownReplyError otherwise; the email then goes
 * without the numbers, never with wrong ones. Synthetic data only.
 */
import { daysCounts } from "@/lib/stats";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = (commands: (string | number)[][]) => Promise<unknown[]>;
const original = redis.pipeline.bind(redis) as Pipeline;
const statsId = "dayscountsexact000000000000001";

async function run(swap?: (real: unknown[]) => unknown): Promise<unknown> {
  (redis as unknown as { pipeline: Pipeline }).pipeline = async (commands) => {
    const real = await original(commands);
    return (swap && commands[0]?.[0] === "HMGET" ? swap(real) : real) as unknown[];
  };
  try {
    return await daysCounts(statsId, "2026-11-01", "2026-11-03");
  } catch (error) {
    return error instanceof UnknownReplyError ? "unknown" : `other error: ${String(error)}`;
  } finally {
    (redis as unknown as { pipeline: Pipeline }).pipeline = original;
  }
}

async function main(): Promise<void> {
  redis.clear();
  redis.run(["HSET", `nl:stats:${statsId}:2026-11-01`, "v", "40", "c", "3"]);
  redis.run(["HSET", `nl:stats:${statsId}:2026-11-03`, "v", "2"]);

  part("Days in their shape are read as they always were");
  is("visits and checkouts added up, a day with none is 0", await run(), { views: 42, checkouts: 3 });

  part("A day in another shape is unknown, never no visits");
  const shapes: [string, (real: unknown[]) => unknown][] = [
    ["a short envelope", (real) => real.slice(0, 2)],
    ["a long envelope", (real) => [...real, [null, null]]],
    ["a day that is not a pair", (real) => [real[0], "x", real[2]]],
    ["a day with one field", (real) => [[real[0] && (real[0] as unknown[])[0]], real[1], real[2]]],
    ["a count that is not digits", (real) => [["many", "3"], real[1], real[2]]],
    ["a count that is a number", (real) => [[40, "3"], real[1], real[2]]],
    ["an envelope that is not a list", () => "OK"],
  ];
  for (const [what, swap] of shapes) is(`${what}: unknown`, await run(swap), "unknown");
  done();
}

void main();
