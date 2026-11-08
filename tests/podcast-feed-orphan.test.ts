/**
 * A feed's index never leads to a grant that is not there (finding and proof by Claude 6,
 * tests/podcast-feed-orphan-proof.test.ts on claude6/c5-proofs; CX-123 rules 24 and 30).
 *
 * feedToken writes the address's index (SET NX nl:pod:by:) and then its grant (nl:pod:t:). When the index landed
 * and the grant write failed, every later call found the index and handed out its token, which opens no feed: the
 * buyer's feed answered 404 for good. A token found in the index is handed out only once its grant is read exactly
 * and is the one for this store, product and address; a grant that is missing is written again, so the buyer's
 * existing feed address keeps working. A grant read that is unknown hands out nothing and writes nothing.
 *
 * Synthetic only: an in-memory Redis, no provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { feedToken, readFeedToken, tokenKey } from "@/lib/podcast-access";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const OWNER = "podcast-feed-orphan@example.test";
const original: Pipeline = redis.pipeline.bind(redis);

async function world() {
  redis.clear();
  redis.pipeline = original;
  await claimHandle(OWNER, "podorphan", "Podcast Orphan", "");
  await ensureStoreId(OWNER); await ensureStatsId(OWNER); await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_PodOrphan", subscriptionId: "sub_PodOrphan", active: true, tier: "pro", period: paidPeriod() });
  const made = await addProduct(OWNER, "Synthetic Radio", "", "19", null);
  assert.ok(made.ok);
  return { id: made.product.id, store: async () => (await storeForEmail(OWNER))! };
}

const grants = () => redis.keys().filter((k) => k.startsWith("nl:pod:t:")).length;
const indexes = () => redis.keys().filter((k) => k.startsWith("nl:pod:by:")).length;
const indexKey = () => redis.keys().find((k) => k.startsWith("nl:pod:by:"))!;
const isGrantWrite = (commands: Commands) =>
  commands.length === 1 && commands[0][0] === "EVAL" && commands[0].some((x) => String(x).startsWith("nl:pod:t:"));
const isGrantRead = (commands: Commands) =>
  commands.length === 1 && commands[0][0] === "GET" && String(commands[0][1]).startsWith("nl:pod:t:");

/** Fails the grant's write once, as Claude 6's proof does, and leaves the index written before it. */
async function orphaned(id: string, store: () => Promise<Awaited<ReturnType<typeof storeForEmail>>>, email: string) {
  let fail = true;
  redis.pipeline = (async (commands: Commands) => {
    if (fail && isGrantWrite(commands)) { fail = false; throw new Error("synthetic: connection lost"); }
    return original(commands);
  }) as Pipeline;
  try {
    const first = await feedToken((await store())!, id, email).catch(() => null);
    assert.equal(first, null, "no link is given while its grant was not written");
  } finally { redis.pipeline = original; }
  assert.equal(indexes(), 1, "the index landed before the grant's write failed");
  assert.equal(grants(), 0, "the grant is not there");
}

test("Claude 6's proof: after the grant's write failed once, the next call hands out a token that opens the feed", async () => {
  const { id, store } = await world();
  await orphaned(id, store, "dana@example.test");
  const indexed = await original([["GET", indexKey()]]);
  const second = await feedToken((await store())!, id, "dana@example.test");
  assert.equal(typeof second, "string");
  assert.equal(second, indexed[0], "the address keeps the feed address its index already holds");
  assert.deepEqual(await readFeedToken(second!), { s: (await store())!.statsId, h: "podorphan", p: id, e: "dana@example.test" });
  assert.equal(await feedToken((await store())!, id, "dana@example.test"), second, "and keeps it after");
  assert.equal(indexes(), 1);
  assert.equal(grants(), 1);
});

for (const [label, reply] of [["no reply", () => []], ["a number", () => [5]], ["an object", () => [{}]], ["undefined", () => [undefined]], ["not a list", () => null]] as const) {
  test(`an indexed token whose grant read is answered as ${label} is not handed out, and nothing is written`, async () => {
    const { id, store } = await world();
    await orphaned(id, store, "eli@example.test");
    redis.pipeline = (async (commands: Commands) => (isGrantRead(commands) ? reply() : original(commands))) as Pipeline;
    let token: unknown;
    try {
      token = await feedToken((await store())!, id, "eli@example.test").catch((error: unknown) => error);
    } finally { redis.pipeline = original; }
    assert.ok(typeof token !== "string", "no link to a grant that may not exist");
    assert.equal(grants(), 0, "no grant is written on an unknown read");
    assert.equal(indexes(), 1, "the index stays");
  });
}

test("an indexed token whose grant names another address is not handed out, and the grant is not overwritten", async () => {
  const { id, store } = await world();
  await orphaned(id, store, "fay@example.test");
  const [token] = (await original([["GET", indexKey()]])) as string[];
  const other = JSON.stringify({ s: (await store())!.statsId, h: "podorphan", p: id, e: "someone-else@example.test" });
  await original([["SET", tokenKey(token), other]]);
  assert.equal(await feedToken((await store())!, id, "fay@example.test"), null);
  assert.deepEqual(await original([["GET", tokenKey(token)]]), [other]);
});

test("healthy control: a feed with its grant is handed out as it is, with no write", async () => {
  const { id, store } = await world();
  const token = (await feedToken((await store())!, id, "gil@example.test"))!;
  let writes = 0;
  redis.pipeline = (async (commands: Commands) => {
    if (isGrantWrite(commands)) writes += 1;
    return original(commands);
  }) as Pipeline;
  try {
    assert.equal(await feedToken((await store())!, id, "gil@example.test"), token);
  } finally { redis.pipeline = original; }
  assert.equal(writes, 0);
  assert.equal(grants(), 1);
});
