/**
 * A store record that cannot be read is never "no store" for the walk that
 * erases closed stores (rule 24, CX-123; found by Claude 2's money review of
 * #3073): lib/closed-store-data.ts eraseClosed took an unreadable store out of
 * line (ZREM) without preparing it, so its data, and what keeping it costs, was
 * never erased. It now stays in line, moved back a walk, and is prepared once
 * its record reads.
 *
 * Synthetic stores, in-memory Redis; the unreadable record is a read that times out.
 */
import { createHash } from "node:crypto";
import { BATCH_KEY, DUE_KEY, WALK_GAP_MS, eraseClosed, markDue } from "@/lib/closed-store-data";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const ownerKey = (email: string) => "nl:store:owner:" + createHash("sha256").update("nimbus-store:" + email).digest("hex").slice(0, 40);

// A store record that cannot be read: the read times out, what a lost connection looks like. (A damaged reply
// throws too once #2878 is in; until then lib/store.ts reads it as no store, which is that PR's to fix.)
const unreadable = new Set<string>();
const realPipeline = redis.pipeline;
redis.pipeline = async (commands: (string | number)[][]) => {
  if (commands.some((c) => c[0] === "GET" && unreadable.has(String(c[1])))) throw new Error("Redis request timed out (test)");
  return realPipeline(commands);
};

async function makeStore(email: string, handle: string) {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = await storeForEmail(email);
  if (!store) throw new Error(`setup: ${handle}`);
  return store;
}

async function main(): Promise<void> {
  redis.clear();
  const A = "unknown-a@example.com";
  const B = "readable-b@example.com";
  await makeStore(A, "unknowna");
  await makeStore(B, "readableb");
  if (redis.run(["GET", ownerKey(A)]) === null) throw new Error("setup: the owner key formula does not match lib/store.ts");

  part("The erasing walk keeps an unreadable store in line");
  const T = Date.now();
  await markDue(A, T - 1000);
  await markDue(B, T - 1000);
  unreadable.add(ownerKey(A));
  const walked = await eraseClosed(Date.now() + 30_000, async () => {}, T);
  unreadable.delete(ownerKey(A));
  const scoreA = redis.run(["ZSCORE", DUE_KEY, A]);
  is("the readable store is prepared and out of line", [walked.stores, redis.run(["ZSCORE", DUE_KEY, B])], [1, null]);
  is("the unreadable one is not prepared, and is still in line", [redis.run(["HEXISTS", BATCH_KEY, A]), scoreA !== null], [0, true]);
  is("moved back a walk, so it does not hold the head of the line", Number(scoreA) >= T + WALK_GAP_MS, true);

  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
