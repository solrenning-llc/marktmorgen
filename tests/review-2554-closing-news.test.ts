/**
 * Independent review of PR #2554 (lib/plan-closing.ts, closingNews and
 * closingLetter): cases the PR's own test does not reach. Each check here
 * fails on head 3bded984e and states what should hold instead.
 *
 * Against the Redis stand-in only; nothing real is reached.
 */
import { paidKey, workKey } from "@/lib/closing-holds";
import { unusedRows } from "@/lib/closing-refunds";
import { closingLetter, closingNews, readUnusedSummary, removalDay } from "@/lib/plan-closing";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 24 * 60 * 60 * 1000;

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const endedAt = now - 2 * DAY;
  const day = removalDay(endedAt);
  await claimHandle("rita@example.com", "rita", "Rita Shop", "");
  const rita = await storeForEmail("rita@example.com");
  if (!rita) throw new Error("the test store was not made");
  const folder = await storeFolder(storeRef(rita));

  part("Regra 24: a written-down payment that cannot be read is dropped below closingNews, and the notice reads it as none");
  {
    // One member's row is unreadable (bad JSON); another's has no usable period.
    await redis.pipeline([
      ["HSET", paidKey(folder), "sub_member0001", "{not json"],
      ["HSET", paidKey(folder), "sub_member0002", JSON.stringify({ inv: "in_member0002", amt: 3000, cur: "usd", e: "m2@buyers.example.com" })],
    ]);
    const news = await closingNews(rita, endedAt, day, 0);
    is("two unreadable paid rows are not a known zero (members should be null)", news.members, null);
    await redis.pipeline([["DEL", paidKey(folder)]]);
  }

  part("Regra 24: a malformed HKEYS answer is normalised to zero inside holdCounts, before readHoldCounts sees it");
  {
    redis.pipeline = (async (commands: Commands) => {
      if (commands.some((c) => c[0] === "HKEYS" && c[1] === workKey(folder))) return [null];
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    const news = await closingNews(rita, endedAt, day, 0);
    redis.pipeline = realPipeline as typeof redis.pipeline;
    is("a non-list HKEYS answer is unknown, not 0 unpaused", [news.notHeld, news.overLimit], [null, null]);
  }

  part("Regra 24: readUnusedSummary takes a repeated currency, and more currencies than members, as a count");
  {
    is("the same currency twice is not one total per currency", readUnusedSummary({ members: 2, totals: [{ cur: "usd", amount: 1500 }, { cur: "usd", amount: 1000 }] }), null);
    is("USD and usd are the same currency", readUnusedSummary({ members: 2, totals: [{ cur: "usd", amount: 1500 }, { cur: "USD", amount: 1000 }] }), null);
    is("one member cannot have paid in two currencies", readUnusedSummary({ members: 1, totals: [{ cur: "usd", amount: 1500 }, { cur: "eur", amount: 1000 }] }), null);
  }

  part("Regra 27: 'each of them is given back' also promises it to a member past the closing's limit, whom the closing day never refunds");
  {
    // A member the hold could not reach within the call budget: marked o:, its last payment never written down.
    await redis.pipeline([
      ["HSET", workKey(folder), "m:sub_member0009", "m9@buyers.example.com"],
      ["HSET", workKey(folder), "o:sub_member0009", "1"],
    ]);
    redis.pipeline = (async (commands: Commands) => {
      if (commands.some((c) => c[0] === "HGETALL" && c[1] === paidKey(folder))) throw new Error("Redis request failed with status 503");
      return realPipeline(commands);
    }) as typeof redis.pipeline;
    const real = console.error;
    console.error = () => {};
    const news = await closingNews(rita, endedAt, day, 0);
    console.error = real;
    redis.pipeline = realPipeline as typeof redis.pipeline;
    const text = closingLetter("ended", rita.name, endedAt, day, now, news).text;
    const promised = text.includes("each of them is given back the unused part of their last payment");
    // What closingDay gives back is giveBackUnused over unusedRows: the over-limit member is never in it.
    const refunded = (await unusedRows(rita, day)).some((r) => r.sub === "sub_member0009");
    is("the letter promises a refund only to members the closing day can refund", { promised, overLimit: news.overLimit, refunded }, { promised, overLimit: 1, refunded: promised });
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
