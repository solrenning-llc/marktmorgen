/**
 * #5010 row 134 (Codex X4-20261119-1743), cost: an after-payment thanks note is now written fenced by the store's
 * erasure (lib/live-fence.ts keepIfStoreLive), one EVAL and its HGET, GET and SET in place of the plain SET, so
 * STORE_KEEP_LIVE_COMMANDS - 1 billed commands more per save, which take a note save past the studio request's priced
 * commands (Claude 7 fdy's measure on #5164: 28 against 27). The coordinator's decision (00:53 on #5164): price those
 * extra commands on every studio request of the month (thanksNoteFenceUsd), since a note can be saved again and again.
 * This holds the measured count of one fenced save and the line that prices it. Synthetic store; in-memory Redis.
 */
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { STORE_ALLOWANCES } from "@/lib/store-allowance-rules";
import { STORE_KEEP_LIVE_COMMANDS, keepIfStoreLive } from "@/lib/live-fence";
import { storeLiveFence } from "@/lib/store-live-cache";
import { COMMAND, thanksNoteFenceUsd } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("One fenced save, counted as Upstash bills a script: the EVAL and each command inside it");
  {
    redis.clear();
    await claimHandle("note-fence@example.test", "notefence", "Note Fence", "");
    await ensureStatsId("note-fence@example.test");
    const store = (await storeForEmail("note-fence@example.test"))!;
    const fence = await storeLiveFence(store);
    const real = redis.pipeline.bind(redis);
    let commands = 0;
    redis.pipeline = (async (batch: (string | number)[][]) => {
      commands += batch.length;
      return real(batch);
    }) as typeof redis.pipeline;
    const calls = redis.scriptCalls;
    const kept = await keepIfStoreLive(fence, `nl:product:note:${store.statsId}:p1`, JSON.stringify({ text: "Thanks" }));
    redis.pipeline = real;
    is("the note is kept", kept, "kept");
    is("one EVAL plus its inner commands is STORE_KEEP_LIVE_COMMANDS", commands + (redis.scriptCalls - calls), STORE_KEEP_LIVE_COMMANDS);
  }

  part("Priced on every studio request of the month, for each plan (thanksNoteFenceUsd)");
  for (const tier of Object.keys(STORE_ALLOWANCES) as (keyof typeof STORE_ALLOWANCES)[]) {
    const floor = STORE_ALLOWANCES[tier].studio * (STORE_KEEP_LIVE_COMMANDS - 1) * COMMAND;
    is(`${tier}: the extra commands of a save are priced on the whole studio figure`, thanksNoteFenceUsd(tier) >= floor - 1e-12 && floor > 0, true);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
