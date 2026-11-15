/**
 * Issue #4664 (erasure, HIGH): a feed request in flight (lib/podcast-access.ts, feedToken) wrote the listener's
 * grant, which holds their address, after their erasure had deleted the index that leads to it: a grant no repeat
 * erasure could find, with no expiry. Transcribed from Claude 2's reproduction on main @e4dbb5e9bf. The grant now
 * stays only while the index still leads to it; a fresh request after the erasure still gets its feed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken, feedsOf } from "@/lib/podcast-access";
import { erasePerson } from "@/lib/person-erasure";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const OWNER = "podcast-grant-erasure@example.test";
const original: Pipeline = redis.pipeline.bind(redis);
const grants = () => redis.keys().filter((k) => k.startsWith("nl:pod:t:")).length;
const indexes = () => redis.keys().filter((k) => k.startsWith("nl:pod:by:")).length;
const isGrantWrite = (commands: Commands) =>
  commands.length === 1 && commands[0][0] === "EVAL" && commands[0].some((x) => String(x).startsWith("nl:pod:t:"));

test("an in-flight grant write after the listener's erasure leaves no grant", async () => {
  redis.clear();
  redis.pipeline = original;
  await claimHandle(OWNER, "podgrant", "Podcast Grant", "");
  await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodGrant", subscriptionId: "sub_PodGrant", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
  assert.ok(made.ok);
  const id = made.product.id;
  const shop = (await storeForEmail(OWNER))!;
  globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 })) as typeof fetch;
  let reached!: () => void;
  const grantWriteReached = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!paused && isGrantWrite(commands)) { paused = true; reached(); await hold; }
    return original(commands);
  }) as Pipeline;
  const email = "ana@example.test";
  const pending = feedToken(shop, id, email);
  await grantWriteReached;
  try {
    assert.equal(indexes(), 1);
    assert.equal(grants(), 0);
    assert.equal((await erasePerson(shop, email, { kind: "person" })).ok, true);
    assert.equal(indexes(), 0);
  } finally { release(); }
  await pending;
  redis.pipeline = original;
  assert.equal(grants(), 0, "erasure leaves no grant with the listener's address");
  assert.deepEqual(await feedsOf(shop, [id], email), []);
});

test("a fresh request after the erasure still gets its feed, kept with its index", async () => {
  redis.pipeline = original;
  const shop = (await storeForEmail(OWNER))!;
  const id = shop.catalog.items[0].id;
  const token = await feedToken(shop, id, "ana@example.test");
  assert.equal(typeof token, "string");
  assert.equal(grants(), 1);
  assert.equal(indexes(), 1);
});
