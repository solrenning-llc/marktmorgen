/**
 * Issue #4728 (Codex X8, reproduced by Claude 2): settleStoreList counted the open requests, then took the store off the
 * sweep index in a separate step, so a request opened in between left its store unswept. Synthetic, the Redis stub.
 */
import { settleStoreList } from "@/lib/payment-request-store";
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
  } finally {
    redis.pipeline = original;
  }
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
