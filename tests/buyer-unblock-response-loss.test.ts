/**
 * Codex G's MEDIUM on #3839 (G-20261117-1533-review-3839.md): an unblock whose HDEL applies but whose reply is lost
 * must not leave the block's data-room charge (BLOCK_ENTRY_BYTES and the slot's own 64 bytes) counted for ever. The
 * first call is unknown, the retry sees no block, and the room is back where it was. Synthetic data, in-memory Redis.
 */
import { claimHandle, ensureStatsId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { blockKey, blockPerson, blockedState, unblockPerson } from "@/lib/buyer-block";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function shop(): Promise<Store> {
  const owner = "unblock-loss-owner@example.com";
  await claimHandle(owner, "unblockloss", "Loss probe", "");
  await ensureStatsId(owner);
  await setSubscription(owner, {
    customerId: "cus_unblockloss0001",
    subscriptionId: "sub_unblockloss0001",
    active: true,
    tier: "pro",
    trialEnds: 0,
    period: paidPeriod(),
  });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  const store = await shop();
  const email = "blocked@example.com";
  const before = (await dataUsed(store))?.used ?? -1;
  is("setup block", await blockPerson(store, email, "synthetic"), "blocked");

  part("HDEL applied but its response is lost");
  const realPipeline = redis.pipeline.bind(redis);
  let loseOnce = true;
  (redis as { pipeline: typeof redis.pipeline }).pipeline = async (commands) => {
    if (
      loseOnce &&
      commands.some(
        (command) =>
          (command[0] === "HDEL" && String(command[1]) === blockKey(store.sid!)) ||
          (command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:buyer-unblock:v1\n")),
      )
    ) {
      loseOnce = false;
      await realPipeline(commands);
      throw new Error("synthetic response loss after HDEL applied");
    }
    return realPipeline(commands);
  };

  is("first unblock is unknown", await unblockPerson(store, email), "error");
  is("the block was nevertheless removed", await blockedState(store, email), { blocked: false });
  is("retry sees no block", await unblockPerson(store, email), false);
  (redis as { pipeline: typeof redis.pipeline }).pipeline = realPipeline;

  is("retry also restores the data-room accounting", (await dataUsed(store))?.used, before);
  done();
}

main();
