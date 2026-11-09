/**
 * Claude 2's review of #2571 (comment 6750216416), LOW 1 (rule 24): a reply
 * that cannot be read is said as unknown, never as a number. The time
 * record's reply off its shape is "can't be read right now", not "0 so far";
 * the readings' MGET off its shape, or a transport error, is "unknown", not
 * "this month is complete" (null). LOW 2: a block id "constructor" is a block
 * like any other in reachShares too (the read route lets any visitor send it).
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PageTime } from "@/components/page-time";
import { countDepth, reachShares, readDepth } from "@/lib/page-depth";
import { readingsPartial } from "@/lib/page-read";
import { readingsUnknownWords } from "@/lib/page-read-sample";
import { claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;

/** Runs `task` with the reply of the first command named `name` on a key starting `prefix` replaced by `swap`. */
async function swapped(name: string, prefix: string, swap: (reply: unknown[]) => unknown[] | Promise<unknown[]>, task: () => Promise<void>): Promise<number> {
  const original: Pipeline = redis.pipeline;
  let hits = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = (await original.call(redis, commands)) as unknown[];
    const at = commands.findIndex((command) => String(command[0]) === name && String(command[1]).startsWith(prefix));
    if (at < 0) return reply;
    hits += 1;
    return swap(reply);
  }) as Pipeline;
  try {
    await task();
  } finally {
    redis.pipeline = original;
  }
  return hits;
}

async function main(): Promise<void> {
  redis.clear();
  const STATS = "c".repeat(32);
  await countDepth(STATS, "prod01", "blk001", "", "", 42);
  await countDepth(STATS, "prod01", "blk002", "", "", 5);

  part("The time record");
  const healthy = await readDepth(STATS, "prod01");
  is("read as it is: the stays, and nothing unread", [healthy.time, healthy.timeUnread], [{ "@t2": 1, "@t0": 1 }, false]);
  for (const [what, garbled] of [
    ["a number", 42],
    ["text", "x"],
    ["an odd list", ["@t2"]],
    ["nothing", null],
  ] as const) {
    let read: Awaited<ReturnType<typeof readDepth>> | null = null;
    const hits = await swapped("HGETALL", `nl:depth:${STATS}:prod01:t`, (reply) => [reply[0], garbled], async () => {
      read = await readDepth(STATS, "prod01");
    });
    is(`a time reply off its shape (${what}) is unread, never an empty record`, [hits, read!.timeUnread, read!.time], [1, true, {}]);
    is(`and the blocks are still read (${what})`, read!.visitors, 2);
  }
  const unread = renderToStaticMarkup(createElement(PageTime, { ranges: [], least: 20, unread: true }));
  is("the screen says it can't be read now, never 0 so far", [unread.includes("can't be read right now"), unread.includes("so far")], [true, false]);
  is("the route says it too", readFileSync("app/api/store/depth/route.ts", "utf8").includes("timeUnread"), true);
  is("and the editor passes it on", readFileSync("components/page-editor.tsx", "utf8").includes("unread={"), true);

  part("Whether this month's readings are partial");
  const email = "unknown-partial@example.com";
  await claimHandle(email, "unknownpartial", "A Paying Store", "");
  await ensureStatsId(email);
  await setSubscription(email, { customerId: "cus_unknownpar", subscriptionId: "sub_unknownpar", active: true, tier: "creator", cycle: "month", period: paidPeriod() });
  const shop = (await storeForEmail(email))!;
  is("no readings yet: nothing said", await readingsPartial(shop), null);
  for (const [what, swap] of [
    ["no envelope", () => []],
    ["a number for the pair", () => [7]],
    ["a pair of three", () => [["1", null, null]]],
    ["a count that is not text", () => [[5, null]]],
    ["a count that is not a number", () => [["many", null]]],
  ] as const) {
    let got: unknown = "not read";
    const hits = await swapped("MGET", "nl:traffic:read:", swap as () => unknown[], async () => {
      got = await readingsPartial(shop);
    });
    is(`an MGET reply off its shape (${what}) is unknown, never "complete"`, [hits, got], [1, "unknown"]);
  }
  let thrown: unknown = "not read";
  await swapped(
    "MGET",
    "nl:traffic:read:",
    () => {
      throw new Error("SYNTHETIC_TRANSPORT");
    },
    async () => {
      thrown = await readingsPartial(shop);
    },
  );
  is("a transport error is unknown too", thrown, "unknown");
  is("the words for it say it cannot be told now", readingsUnknownWords().includes("can't be checked right now"), true);
  const panel = readFileSync("components/stats-panel.tsx", "utf8");
  is("the store page's numbers say it", panel.includes("readingsUnknownWords()"), true);
  const unknownTime = renderToStaticMarkup(createElement(PageTime, { ranges: [{ words: "Under 10 seconds", count: 30, share: 100 }], least: 20, partial: "unknown" }));
  is("and the sales page editor's time does", unknownTime.includes("can't be checked right now"), true);

  part("A block named constructor");
  const order = ["constructor", "blk001"];
  const shares = reachShares(order, { blk001: 4 }, 4);
  is("nobody stopped at it: its share is the blocks below it, a number", [typeof shares.shares.constructor, shares.shares.constructor, shares.shares.blk001], ["number", 100, 100]);
  const own = reachShares(order, Object.fromEntries([["constructor", 2], ["blk001", 2]]), 4);
  is("people who stopped at it count as at any block", [own.shares.constructor, own.shares.blk001], [100, 50]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
