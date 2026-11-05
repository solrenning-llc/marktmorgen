/**
 * Independent review of PR #2554 (lib/plan-closing.ts, closingNews and
 * closingLetter): cases the PR's own test does not reach. Each check here
 * failed on head 3bded984e and states what should hold instead.
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

  // Left out here: two checks of this review that read as a known zero below
  // closingNews, a paid row that cannot be read (bad JSON, no period) and an
  // HKEYS answer that is not a list. Both are swallowed inside
  // lib/closing-holds.ts (holdCounts, paidPeriods) and lib/closing-refunds.ts
  // (unusedRows) before closingNews sees them; they depend on Codex X's fix of
  // those files (SG2 findings 21 and 29) and are tested there.

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
    // No sentence that says a refund is made whatever happens on the day.
    const promised = /is given back the unused part|are made for you|are still made for you/.test(text);
    // The creator is told this member's time is theirs to refund, in the singular.
    const told = text.includes("1 membership's payments are not paused: past this closing's limit.") && text.includes("What this member paid for after") && text.includes("please check their membership in Stripe and refund that time yourself.");
    // What closingDay gives back is giveBackUnused over unusedRows: the over-limit member is never in it.
    const refunded = (await unusedRows(rita, day)).some((r) => r.sub === "sub_member0009");
    is("the letter promises a refund only to members the closing day can refund, and tells the creator to refund the rest", { promised, told, overLimit: news.overLimit, refunded }, { promised: false, told: true, overLimit: 1, refunded: false });
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
