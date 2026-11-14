/**
 * An erasure that runs between a new feed's index write and its grant write leaves nothing naming the address
 * (Codex L, finding 1, and Codex P on #3473, MEDIUM). feedToken confirms the index (SET NX nl:pod:by:), then writes
 * the grant and adds the address-derived member to the product's list of listeners. When a person's erasure reads the
 * index, removes the member (not there yet), deletes the index and the grant and finishes in between, the grant and
 * the member written afterwards must both go: the erasure already said it had finished, and nothing retries it.
 *
 * Synthetic only: an in-memory Redis, no provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken, forgetPodcastPerson } from "@/lib/podcast-access";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const OWNER = "podcast-feed-erasure-race@example.test";
const BUYER = "hana@example.test";
const original: Pipeline = redis.pipeline.bind(redis);
const addressKey = (email: string) => createHash("sha256").update(`nimbus-podcast:${email}`).digest("hex").slice(0, 32);
const isGrantWrite = (commands: Commands) => commands.some((c) => c.some((x) => String(x).startsWith("nl:pod:t:")) && c.some((x) => x === "SET" || x === "EVAL"));

async function world() {
  redis.clear();
  redis.pipeline = original;
  await claimHandle(OWNER, "podrace", "Podcast Race", "");
  await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodRace", subscriptionId: "sub_PodRace", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
  assert.ok(made.ok);
  return { id: made.product.id, store: async () => (await storeForEmail(OWNER))! };
}

test("an erasure finished between the index and the grant leaves no grant, no index and no listener member", async () => {
  const { id, store } = await world();
  const sid = (await store()).statsId!;
  let erased: number | null = null;
  redis.pipeline = (async (commands: Commands) => {
    if (erased === null && isGrantWrite(commands)) {
      erased = -1;
      redis.pipeline = original;
      erased = await forgetPodcastPerson(await store(), [id], BUYER);
    }
    return original(commands);
  }) as Pipeline;
  let token: unknown;
  try {
    token = await feedToken(await store(), id, BUYER).catch((error: unknown) => error);
  } finally { redis.pipeline = original; }
  assert.notEqual(erased, null, "the erasure ran in between");
  assert.equal(token, null, "no link is given to a feed the erasure took away");
  assert.equal(redis.keys().filter((k) => k.startsWith("nl:pod:t:")).length, 0, "no grant holds the address");
  assert.equal(redis.keys().filter((k) => k.startsWith("nl:pod:by:")).length, 0, "no index leads to one");
  const [listed] = await original([["SISMEMBER", `nl:pod:ls:${sid}:${id}`, addressKey(BUYER)]]);
  assert.equal(listed, 0, "the list of listeners does not keep the address-derived member");
});

test("control: a feed made with no erasure is listed and handed out", async () => {
  const { id, store } = await world();
  const sid = (await store()).statsId!;
  const token = await feedToken(await store(), id, BUYER);
  assert.equal(typeof token, "string");
  const [listed] = await original([["SISMEMBER", `nl:pod:ls:${sid}:${id}`, addressKey(BUYER)]]);
  assert.equal(listed, 1);
});
