/**
 * #4185: while the one-time recount learns which ids name each store's keys (lib/data-recount.ts noteIds), a store's
 * workflows or products that do not read must stop the page: the ids cursor stays where it was and the same page of
 * stores is read again on a later run, never learned from an empty list in their place (rule 24). Main already does
 * this since #2501 (readFlows and readAllListings throw UnknownReplyError, and nothing in noteIds catches it); this
 * holds it. RED by mutation: a `.catch(() => [])` on either read in noteIds fails it.
 * Synthetic data only, against the in-memory Redis.
 */
import { IDS_KEY, RECOUNT_VERSION, STATE_KEY, recountStep } from "@/lib/data-recount";
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
    let refused = false;
    try { await recountStep(Date.now() + 5_000); } catch { refused = true; }
    is("the run stops on it", refused, true);
    is("the ids cursor and phase stay where they were", [redis.run(["HGET", STATE_KEY, "phase"]), redis.run(["HGET", STATE_KEY, "cursor"])], ["ids", "0"]);
    is("nothing was learned for the store from an empty list", redis.run(["EXISTS", IDS_KEY]), 0);

    redis.pipeline = pipeline;
    const healed = await recountStep(Date.now() + 30_000);
    is("read again on a healthy run, the store is learned and the count goes on to the end", [healed.done, healed.stores], [true, 1]);
  }
  redis.pipeline = pipeline;
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
