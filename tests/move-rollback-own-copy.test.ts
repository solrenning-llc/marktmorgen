/**
 * Issue #4343 (Codex G hidden #4341, transcribed by Claude 1): when an account move fails on one of its extra stores,
 * its rollback deleted whatever was at the new address's record key, not only the copy the move wrote there. Something
 * that wrote that key in the meantime (a session already open for the new address saving its store, a repair) lost it.
 * The rollback must take back only its own copy: a compare-and-delete, never a bare DEL.
 *
 * Synthetic: in-memory Redis through the runner's alias; no network.
 */
import { createHash } from "node:crypto";
import { claimHandle, createStore, ensureStatsId, ensureStoreId, moveAccount } from "@/lib/store";
import { redisPipeline } from "@/lib/redis";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const ownerKey = (email: string) => `nl:store:owner:${createHash("sha256").update(`nimbus-store:${email.toLowerCase()}`).digest("hex").slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  const A = "mover-4343@example.com";
  const B = "moved-4343@example.com";
  await claimHandle(A, "moverfirst", "Mover", "");
  await ensureStatsId(A);
  await ensureStoreId(A);
  const extra = await createStore(A, "moversecond", "Mover two", "");
  is("the account has an extra store", extra.ok, true);

  const toKey = ownerKey(B);
  const theirs = JSON.stringify({ handle: "someoneelse", email: B, note: "written by another writer meanwhile" });
  const real = redis.pipeline.bind(redis);
  let provisional = false;
  redis.pipeline = (async (batch: Command[]) => {
    const one = batch.length === 1 && batch[0][0] === "EVAL" ? batch[0] : null;
    const script = one ? String(one[1]) : "";
    // The move's provisional copy at the new address lands, then another writer replaces it at once.
    if (one && script.includes("fenced-set-new") && one[4] === toKey) {
      const replies = await real(batch);
      provisional = true;
      await real([["SET", toKey, theirs]]);
      return replies;
    }
    // The extra store's own write is then refused (its lock lost): the move must roll back.
    if (one && provisional && script.includes("fenced-set:v1")) return [0];
    return real(batch);
  }) as typeof redis.pipeline;

  part("A move whose extra store's write fails, after another writer replaced the new address's record");
  const quiet = console.error;
  console.error = () => {};
  let outcome = "";
  try {
    const moved = await moveAccount(A, B);
    outcome = moved.ok ? "moved" : `refused:${moved.reason}`;
  } catch (error) {
    outcome = `threw:${(error as Error).name}`;
  } finally {
    console.error = quiet;
    redis.pipeline = real;
  }
  is("the move did not complete", outcome === "moved", false);
  is("the provisional copy was written first", provisional, true);
  const [left] = await redisPipeline([["GET", toKey]]);
  is("the rollback leaves the other writer's record in place", left, theirs);
  done();
}

void main();
