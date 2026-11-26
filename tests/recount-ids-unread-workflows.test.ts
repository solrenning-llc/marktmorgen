/**
 * #4185: while the one-time recount learns which ids name each store's keys (lib/data-recount.ts noteIds), a store's
 * workflows that do not read must stop the page: the ids cursor stays where it was and the same page of stores is read
 * again on a later run, never learned from an empty list in their place (rule 24). Main already does this since #2501
 * (readFlows throws UnknownReplyError, and nothing in noteIds catches it); this holds it. RED by mutation: a
 * `.catch(() => [])` on the workflows read in noteIds fails it. Not held here (Claude 5 id8Ws and ichw on #5483): the
 * products read, readAllListings. This test's store has no products, so readListingsMeasured returns before any read
 * and a `.catch` on readAllListings passes it. A store with products outside its record's head reads them from Redis
 * through getMany, which throws on an inexact reply, and listingRead, which throws on an unreadable record (a missing
 * one is skipped); noteIds catches neither.
 * Synthetic data only, against the in-memory Redis.
 */
import { IDS_KEY, RECOUNT_VERSION, STATE_KEY, recountStep } from "@/lib/data-recount";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const pipeline = redis.pipeline.bind(redis);

async function main() {
  const OWNER = "recount-unread@example.com";
  for (const [label, reply] of [["a number", [5]], ["no reply", []], ["an object", [{}]], ["a garbled list", ["{"]]] as [string, unknown][]) {
    part(`the store's workflows answered with ${label}`);
    redis.pipeline = pipeline;
    redis.clear();
    await claimHandle(OWNER, "recountunread", "Recount", "");
    await ensureStatsId(OWNER);
    await ensureListId(OWNER);
    await ensureStoreId(OWNER);
    const store = (await storeForEmail(OWNER))!;
    const flows = `nl:mail:flows:${store.listId}`;
    redis.run(["SET", flows, JSON.stringify([])]);
    redis.run(["HSET", STATE_KEY, "phase", "ids", "cursor", "0", "version", RECOUNT_VERSION]);
    redis.pipeline = async (commands: Command[]) =>
      commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === flows ? (reply as unknown[]) : pipeline(commands);
    // The run stops on the workflows' own unknown reply, never on another error before it (Claude 5 ichw on #5483).
    let refused: unknown = null;
    try { await recountStep(Date.now() + 5_000); } catch (error) { refused = error; }
    is("the run stops on the store's workflows read in an unknown shape",
      [refused instanceof UnknownReplyError, refused instanceof Error && /the store's workflows/.test(refused.message)], [true, true]);
    is("the ids cursor and phase stay where they were", [redis.run(["HGET", STATE_KEY, "phase"]), redis.run(["HGET", STATE_KEY, "cursor"])], ["ids", "0"]);
    // The phase is checked with it: a run that went on to the end deletes IDS_KEY too (Claude 5 ichw on #5483).
    is("nothing was learned for the store from an empty list, and the count did not go on", [redis.run(["EXISTS", IDS_KEY]), redis.run(["HGET", STATE_KEY, "phase"])], [0, "ids"]);

    // On the healthy run, what the ids phase learned is read just before the done step deletes it.
    let learned = 0;
    redis.pipeline = async (commands: Command[]) => {
      if (commands.some((c) => c[0] === "DEL" && c[1] === IDS_KEY)) learned = Number(redis.run(["EXISTS", IDS_KEY]));
      return pipeline(commands);
    };
    const healed = await recountStep(Date.now() + 30_000);
    redis.pipeline = pipeline;
    is("read again on a healthy run, the store's ids are learned before the end", learned, 1);
    is("and the count goes on to the end", [healed.done, healed.stores], [true, 1]);
  }
  redis.pipeline = pipeline;
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
