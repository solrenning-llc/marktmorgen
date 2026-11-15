/**
 * Issue #4728 (Codex X8, reproduced by Claude 2): settleStoreList counted the open requests, then took the store off the
 * sweep index in a separate step, so a request opened in between left its store unswept. Synthetic, the Redis stub.
 */
import { OPEN_COUNT_COMMANDS, REMOVE_IDLE_STORE, REMOVE_IDLE_STORE_COMMANDS, settleStoreList } from "@/lib/payment-request-store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main() {
  const original = redis.pipeline;
  const real = original.bind(redis);
  const sid = "synthetic-race-store";
  const open = `nl:payreq:o:${sid}`;
  const stores = "nl:payreq:stores";
  const now = 1000;
  try {
    part("A new open request keeps the store visible to the payment sweep");
    await real([["SADD", stores, sid], ["ZADD", open, now, "expired"]]);
    let interleaved = false;
    redis.pipeline = async (commands) => {
      // Just before the step that takes the store off the list: the separate SREM before, the one-step EVAL now.
      if (!interleaved && (commands[0]?.[0] === "SREM" || commands[0]?.[0] === "EVAL")) {
        interleaved = true;
        await real([["ZADD", open, now + 100, "new"], ["SADD", stores, sid]]);
      }
      return real(commands);
    };
    await settleStoreList(sid, now);
    is("the interleaving happened", interleaved, true);
    is("the open request remains", await real([["ZCARD", open]]), [1]);
    is("the store stays in the payment sweep index", await real([["SISMEMBER", stores, sid]]), [1]);

    // Reviewer 3rjdf on this branch: what the removal costs, counted as sent, and an idle store does leave by it.
    part("An idle store leaves the list in the one step, at the commands its line prices");
    await real([["DEL", open], ["SADD", stores, sid]]);
    const sent: string[] = [];
    redis.pipeline = async (commands) => {
      for (const c of commands) sent.push(String(c[0]));
      return real(commands);
    };
    await settleStoreList(sid, now);
    redis.pipeline = original;
    is("its count, then the one-step removal", sent, ["ZREMRANGEBYSCORE", "ZCARD", "EVAL"]);
    is("OPEN_COUNT_COMMANDS counts the count", OPEN_COUNT_COMMANDS, sent.filter((c) => c !== "EVAL").length);
    is("REMOVE_IDLE_STORE_COMMANDS counts the EVAL and each call inside it", REMOVE_IDLE_STORE_COMMANDS, 1 + (REMOVE_IDLE_STORE.match(/redis\.call\(/g) ?? []).length);
    is("the idle store is off the list", await real([["SISMEMBER", stores, sid]]), [0]);
    // The script alone (lib/redis-memory.ts runs it as Redis does): an open list of the wrong kind stops it.
    await real([["SET", open, "not a sorted set"], ["SADD", stores, sid]]);
    const wrong = await real([["EVAL", REMOVE_IDLE_STORE, 2, open, stores, String(now), sid]]).then(() => "ran", () => "stopped");
    is("an open list of the wrong kind stops the script, as Redis does", wrong, "stopped");
    is("and keeps the store on", await real([["SISMEMBER", stores, sid]]), [1]);
  } finally {
    redis.pipeline = original;
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
