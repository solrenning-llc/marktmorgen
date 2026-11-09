/**
 * The count of stores prepared for the closing walk (HLEN) is read exactly (rules 24 and 30, follow-up of #3156).
 * Until now a reply in another shape read as "no store prepared", so the run said it was done and the prepared
 * stores' keys were never walked. It now throws UnknownReplyError and changes nothing; and a run whose line of stores
 * due is empty still reads the count, so a store that left the line before its walk started is still walked. (The
 * walk's state and its line, HMGET and ZRANGEBYSCORE, are read exactly in Claude 6's claude6/plan-closing-score-exact.)
 *
 * Synthetic stores, in-memory Redis; each store is closed the way the closing job leaves it.
 */
import { BATCH_KEY, DUE_KEY, eraseClosed, markDue } from "@/lib/closed-store-data";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { closeForErasure } from "./closed-for-erasure";
import { done, is, part } from "./check";

type Command = (string | number)[];
const realPipeline = redis.pipeline;
// The one read answered in another shape, once.
let odd: { word: string; reply: unknown } | null = null;
redis.pipeline = async (commands: Command[]) => {
  if (odd && commands.length === 1 && commands[0][0] === odd.word) {
    const { reply } = odd;
    odd = null;
    return reply as never;
  }
  return realPipeline(commands);
};

async function dueStore(email: string, handle: string, at: number) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  if (!(await storeForEmail(email))) throw new Error(`setup: ${handle}`);
  await closeForErasure(email);
  await markDue(email, at - 1000);
}

async function run(now: number): Promise<{ outcome: string; done?: boolean; finished?: number }> {
  try {
    const report = await eraseClosed(Date.now() + 30_000, async () => {}, now);
    return { outcome: "returned", done: report.done, finished: report.finished };
  } catch (error) {
    return { outcome: error instanceof UnknownReplyError ? "UnknownReplyError" : String(error) };
  }
}

const SHAPES: [string, unknown][] = [
  ["no reply", []],
  ["a null reply", [null]],
  ["a text reply", ["1"]],
  ["an object reply", [{}]],
];

async function main(): Promise<void> {
  for (const [shape, reply] of SHAPES) {
    const T = Date.now();
    part(`The count of stores prepared answered with ${shape}`);
    redis.clear();
    await dueStore("count@example.com", "countshop", T);
    odd = { word: "HLEN", reply };
    const count = await run(T);
    is("the run throws UnknownReplyError, never 'done'", count.outcome, "UnknownReplyError");
    is("the prepared store's entry stays for the walk", redis.run(["HLEN", BATCH_KEY]), 1);
    // The store left the line before the count was read, so the next run sees an empty line: it must still find the
    // prepared store and walk it, never say it is done with its entry left behind.
    is("the store already left the line", redis.run(["ZSCORE", DUE_KEY, "count@example.com"]), null);
    const countAgain = await run(T);
    is("control: the next run, with an empty line, still walks the prepared store to its end", [countAgain.outcome, countAgain.finished, redis.run(["HLEN", BATCH_KEY])], ["returned", 1, 0]);
  }
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
