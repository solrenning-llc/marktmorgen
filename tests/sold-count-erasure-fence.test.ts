/**
 * A slow sales-count refresh must not recreate the store's family after erasure
 * (Codex L-20261120-0538): refreshSoldCounts waits on the Stripe read, and the erasure
 * walk can delete nl:sold:<statsId> meanwhile; the late write is fenced on the store's life.
 */
import {
  ERASING_KEY,
  claimHandle,
  ensureStatsId,
  ensureStoreId,
  erasingField,
  setStripeAccount,
  storeForEmail,
  storeIdCommand,
  storeRef,
  updateLook,
} from "@/lib/store";
import { DEFAULT_LOOK } from "@/lib/store-look";
import { readSoldCounts, refreshSoldCounts } from "@/lib/sold-count";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function seed(owner: string, handle: string) {
  await claimHandle(owner, handle, "Sold Erasure", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1SyntheticSold", true);
  await updateLook(owner, { ...DEFAULT_LOOK, sold: true });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  part("A live store keeps its refreshed counts");
  redis.clear();
  const live = await seed("sold-live@example.com", "soldlive");
  const kept = await refreshSoldCounts(live, async () => ({ byProduct: { p1: { sales: 3 } } }), 1_800_000_000_000);
  is("the live store gets its counts", kept?.byProduct, { p1: 3 });
  is("and they are kept", Number(redis.run(["EXISTS", `nl:sold:${live.statsId}`])), 1);

  part("An erasure that starts during the read leaves nothing behind");
  redis.clear();
  const store = await seed("sold-erasure@example.com", "solderasure");
  const statsId = store.statsId!;
  const sold = `nl:sold:${statsId}`;
  const lock = `nl:sold:lock:${statsId}`;
  const refreshed = await refreshSoldCounts(store, async () => {
    await redis.pipeline([
      ["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(Date.now())],
      ["DEL", storeIdCommand(store.sid)[1], sold, lock],
    ]);
    return { byProduct: { p1: { sales: 42 } } };
  }, 1_800_000_000_000);
  is("the erased store receives no refreshed count", refreshed, null);
  is("and its sold-count family stays absent", Number(redis.run(["EXISTS", sold])), 0);
  is("so nothing is read back", await readSoldCounts(store).catch(() => "unknown"), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
