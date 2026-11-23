/**
 * The community About page's kept counts are never written back for an erased store (#5010 row 106, Codex
 * G-20261119-1631). aboutCounts read the member count and the recent posts, then kept them under nl:cm:<id>:about with
 * a plain SET EX: a whole-store erasure that removed the store's id key (or marked it erasing) between the reads and the
 * write was followed by the cache coming back. Now the write is setWhileStoreLive (lib/store-live-cache.ts, the store's
 * live fence in the same Redis step): with the store gone or erasing, nothing is written. The counts already worked
 * out still go back to the visit in progress. Synthetic, in-memory Redis only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ABOUT_REFRESH_COMMANDS, aboutCounts } from "@/lib/community-about";
import { readConfig, saveConfig } from "@/lib/community";
import { ERASING_KEY, claimHandle, ensureStatsId, erasingField, setCommunity, setStripeAccount, setSubscription, storeForEmail, storeIdCommand, storeRef, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_about_erasure_only";
globalThis.fetch = (async () => {
  throw new Error("no network in this check");
}) as typeof fetch;

const OWNER = "abouterasure@example.com";
type Batch = (string | number)[][];

async function world(): Promise<{ store: Store; id: string }> {
  redis.clear();
  await claimHandle(OWNER, "abouterasure", "About Club", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_aboutera0000", true);
  await setSubscription(OWNER, { customerId: "cus_abouterasure", subscriptionId: "sub_abouterasure", active: true, tier: "creator", period: paidPeriod() } as never);
  await setCommunity(OWNER, true);
  const store = (await storeForEmail(OWNER))!;
  const id = store.community!.id;
  await saveConfig(id, { ...(await readConfig(id))!, page: { on: true, counts: true } });
  await redis.pipeline([["HSET", `nl:cm:${id}:m`, "a".repeat(32), JSON.stringify({ k: "a".repeat(32), e: "jane@example.com", n: "Jane", h: "", dir: true, mail: false, at: 1, seen: 1, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] })]]);
  return { store, id };
}

/** The final write of the kept counts: the plain SET before the fix, the fenced EVAL after it. */
const keepsAbout = (id: string) => (batch: Batch) =>
  batch.some((c) => (c[0] === "SET" && c[1] === `nl:cm:${id}:about`) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-cache-live:") && c.includes(`nl:cm:${id}:about`)));

/** Runs `before` once, just ahead of the first batch `when` picks, then lets that batch through. */
async function aheadOf<T>(when: (batch: Batch) => boolean, before: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => {
    if (when(batch)) {
      redis.pipeline = original;
      await before();
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    return await run();
  } finally {
    redis.pipeline = original;
  }
}

for (const [label, erase] of [
  ["the store's id key removed", async (store: Store) => redis.run(["DEL", storeIdCommand(store.sid)[1]])],
  ["the store marked erasing", async (store: Store) => redis.run(["HSET", ERASING_KEY, await erasingField(storeRef(store)), "1"])],
] as [string, (store: Store) => Promise<unknown>][]) {
  test(`a refresh in flight writes nothing once its store is erased (${label})`, async () => {
    const { store, id } = await world();
    const counts = await aheadOf(keepsAbout(id), () => erase(store), async () => aboutCounts(store, id, (await readConfig(id))!));
    assert.equal(redis.run(["EXISTS", `nl:cm:${id}:about`]), 0, "the About cache is not recreated");
    assert.equal(counts?.joined, 1, "the counts already worked out still go back to the visit in progress");
  });
}

test("a refresh with the store live keeps the counts, as before", async () => {
  const { store, id } = await world();
  const counts = await aboutCounts(store, id, (await readConfig(id))!);
  assert.equal(counts?.joined, 1);
  assert.equal(redis.run(["EXISTS", `nl:cm:${id}:about`]), 1, "kept for the next visits");
});

test("a refresh sends exactly the commands ABOUT_REFRESH_COMMANDS prices (the fence's three inside its EVAL counted)", async () => {
  // Claude 1 coord on #5169 (6233): cost counted short cannot go in. The refresh's own commands are counted as sent, the
  // store-cache-live EVAL as itself plus its HGET, GET and SET; the store's request count (TAKE_COMMANDS) is priced apart.
  const { store, id } = await world();
  const at = Math.floor(Date.now() / 1000);
  await redis.pipeline([["ZADD", `nl:cm:${id}:feed`, at, "post0000001"], ["SET", `nl:cm:${id}:p:post0000001`, JSON.stringify({ id: "post0000001", at, hid: false })]]);
  const config = (await readConfig(id))!;
  const original = redis.pipeline.bind(redis);
  let billed = 0;
  redis.pipeline = (async (batch: Batch) => {
    for (const c of batch) {
      if (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:store-cache-live:")) billed += 4;
      else if (String(c[1]).startsWith(`nl:cm:${id}:`)) billed += 1;
    }
    return original(batch);
  }) as typeof redis.pipeline;
  try {
    await aboutCounts(store, id, config);
  } finally {
    redis.pipeline = original;
  }
  assert.equal(billed, ABOUT_REFRESH_COMMANDS);
});
