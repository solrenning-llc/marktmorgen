/**
 * The daily usage run goes on past a store whose figure cannot be read
 * (audit SG2 L8, CX-123 rule 24).
 *
 * watchedIn (lib/watch.ts) now throws when a month's video seconds are not
 * in their exact shape, rather than reading them as 0. settleAllUsage
 * (lib/usage-billing.ts) asked each store's figure outside its per-store
 * try, so one unknown store stopped the whole run: no other store was
 * settled, and the hourly job (app/api/cron/usage/route.ts) returned before
 * writing to any creator. Now that store is left for the next run, logged,
 * and the others go on.
 */
import { settleAll } from "@/lib/watch-billing";
import { VIDEO_SECONDS_INCLUDED } from "@/lib/watch-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Rule = { when: (commands: (string | number)[][]) => boolean; reply: unknown };
let rule: Rule | null = null;
const pipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  if (rule && rule.when(commands)) {
    if (rule.reply === "throw") throw new Error("the database did not answer");
    return rule.reply as unknown[];
  }
  return pipeline(commands);
}) as typeof redis.pipeline;

/** "rejected" when the promise rejects, otherwise what it resolved to. */
async function outcome<T>(run: () => Promise<T>): Promise<T | "rejected"> {
  try {
    return await run();
  } catch {
    return "rejected";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(String(args[0]));
  };

  // A day past the days the month before is still closed: one month is run.
  const now = Date.UTC(2026, 10, 20, 14);
  const month = "2026-11";
  // Read in folder order (watchedFolders sorts them): the unknown one comes first.
  const unknown = "0000000000000000000000000000000a";
  const valid = "0000000000000000000000000000000b";
  await redis.pipeline([
    ["SADD", `nl:watch:folders:${month}`, unknown, valid],
    ["SET", `nl:watch:sec:${unknown}:${month}`, String(VIDEO_SECONDS_INCLUDED + 3600)],
    ["SET", `nl:watch:sec:${valid}:${month}`, String(VIDEO_SECONDS_INCLUDED + 3600)],
  ]);
  const unknownSeconds = (commands: (string | number)[][]) => commands[0]?.[0] === "GET" && commands[0]?.[1] === `nl:watch:sec:${unknown}:${month}`;

  part("settleAll: one store's unknown figure does not stop the run");
  for (const [label, reply] of [
    ["a count that is not a number", ["lots"]],
    ["a fractional count", ["1.5"]],
    ["a negative count", ["-5"]],
    ["a count that is an object", [{ n: 1 }]],
    ["an empty reply", []],
    ["a Redis that cannot be asked", "throw"],
  ] as [string, unknown][]) {
    rule = { when: unknownSeconds, reply };
    errors.length = 0;
    const settled = await outcome(() => settleAll(now));
    is(`settleAll, ${label}: the run ends`, settled !== "rejected", true);
    const folders = settled === "rejected" ? [] : settled.map((row) => row.folder);
    is(`settleAll, ${label}: the store that can be read is settled`, folders.includes(valid), true);
    is(`settleAll, ${label}: the unknown one is left for the next run`, folders.includes(unknown), false);
    is(`settleAll, ${label}: and it is logged`, errors.some((line) => line.includes("settling a store's watch failed")), true);
  }
  rule = null;
  const both = (await settleAll(now)).map((row) => row.folder).sort();
  is("settleAll: with both readable, both are settled", both, [unknown, valid]);

  console.error = error;
  done();
}

void main();
