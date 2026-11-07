/** Synthetic unknown reschedule acknowledgment, actual eraseClosed; no provider IO. */
import { createHash } from "node:crypto";
import { eraseClosed, markDue, DUE_KEY, WALK_GAP_MS, unmarkDue } from "@/lib/closed-store-data";
import { claimHandle, ensureStatsId, ensureStoreId } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { is, done } from "./check";
const original = redis.pipeline.bind(redis);
type Commands = (string | number)[][];
const email = "backoff@example.com";
const ownerKey = "nl:store:owner:" + createHash("sha256").update("nimbus-store:" + email).digest("hex").slice(0, 40);
async function scenario(unknown: boolean, removed = false): Promise<{ attempts: number; score: unknown; done: boolean }> {
  redis.pipeline = original;
  redis.clear();
  await claimHandle(email, "backoff", "Backoff", "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const now = Date.now();
  await markDue(email, now - 1000);
  let attempts = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (commands.some(c => c[0] === "GET" && c[1] === ownerKey)) {
      attempts += 1;
      if (removed) await unmarkDue(email);
      throw new Error("synthetic unreadable store");
    }
    // The reschedule was NOT applied and its one result slot is unknown, not an acknowledged success.
    if (unknown && commands.some(c => c[0] === "ZADD" && c[1] === DUE_KEY && c[2] === "XX")) return [null];
    return original(commands);
  }) as typeof redis.pipeline;
  const first = await eraseClosed(Date.now() + 30_000, async () => {}, now);
  await eraseClosed(Date.now() + 30_000, async () => {}, now + 3_600_000);
  redis.pipeline = original;
  return { attempts, score: redis.run(["ZSCORE", DUE_KEY, email]), done: first.done };
}
async function main(): Promise<void> {
  const control = await scenario(false);
  is("healthy reschedule prevents another attempt one hour later", control.attempts, 1);
  is("healthy score is a future timestamp", typeof control.score === "string" && Number(control.score) > Date.now() + WALK_GAP_MS / 2, true);
  const unknown = await scenario(true);
  is("unknown reschedule does not silently certify the 20-hour retry interval", unknown.attempts, 1);
  is("unknown reschedule keeps the store reachable", unknown.score !== null, true);
  const removed = await scenario(false, true);
  is("XX does not revive a store concurrently removed from the queue", removed.score, null);
  done();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
