/** Synthetic regression: actual account transfer while the real count refresh awaits its read. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, updateLook, storeForEmail, moveAccount, storeRef, storeIdCommand, ERASING_KEY, erasingField } from "@/lib/store";
import { DEFAULT_LOOK } from "@/lib/store-look";
import { refreshSoldCounts, readSoldCounts } from "@/lib/sold-count";
import { setWhileStoreLive } from "@/lib/store-live-cache";
import { store as redis } from "./redis-stub";

async function seed() {
  redis.clear();
  const email = "sold-before@example.com";
  await claimHandle(email, "soldmoved", "Synthetic sold", "");
  await ensureStatsId(email); await ensureStoreId(email);
  await setStripeAccount(email, "acct_1SyntheticSold", true);
  await updateLook(email, { ...DEFAULT_LOOK, sold: true });
  return (await storeForEmail(email))!;
}
for (const erasing of [false, true]) test(`stale count refresh refuses moved identity; erasing=${erasing}`, async () => {
  const before = await seed();
  const key = `nl:sold:${before.statsId}`;
  const result = await refreshSoldCounts(before, async () => {
    const moved = await moveAccount(before.email, "sold-after@example.com");
    assert.equal(moved.ok, true);
    const after = (await storeForEmail("sold-after@example.com"))!;
    assert.equal(after.sid, before.sid);
    assert.equal(after.statsId, before.statsId);
    assert.equal(redis.run(["GET", storeIdCommand(before.sid)[1]]), storeRef(after));
    if (erasing) await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(after)), "1800000000000"], ["DEL", key, `nl:sold:lock:${before.statsId}`]]);
    return { byProduct: { synthetic_product: { sales: 42 } } };
  }, 1_800_000_000_000);
  assert.deepEqual({ result, raw: redis.run(["GET", key]), read: await readSoldCounts(before) }, { result: null, raw: null, read: null });
});
test("current moved owner remains live and erasing moved owner cannot write", async () => {
  const before = await seed();
  assert.equal((await moveAccount(before.email, "sold-after@example.com")).ok, true);
  const after = (await storeForEmail("sold-after@example.com"))!;
  assert.equal(await setWhileStoreLive(after, "nl:test:sold-live", "kept", 60), "kept");
  await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(after)), "1800000000000"]]);
  assert.equal(await setWhileStoreLive(after, "nl:test:sold-erased", "late", 60), "gone");
  assert.equal(redis.run(["GET", "nl:test:sold-erased"]), null);
});
