/** #4290, Codex V (V-20261119-1245-fix-pr-4290, MEDIUM, erasure): the locator of a person's checkout asks outlived by the asks themselves. Synthetic outage/retry checks for the lifetime of the checkout ask erasure locator. No service is contacted. */
import assert from "node:assert/strict";
import test from "node:test";
import { askIndexKey, askReminder, asksOf, forgetAskPerson, sendAsked } from "@/lib/checkout-ask";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const QUEUE = "nl:recover:asks";
const PERSON = "ask-index@example.test";
const OWNER = "ask-index-owner@example.test";

async function shop() {
  redis.clear();
  // Existing allowlisted synthetic provider credential; never a live account. No email is sent by these tests.
  process.env.RESEND_API_KEY ??= "re_test_updates_only_a_stand_in";
  process.env.STRIPE_SECRET_KEY ??= "sk_test_ask_index_stand_in";
  globalThis.fetch = async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  await claimHandle(OWNER, "askindexshop", "Ask Index Shop", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  await setSubscription(OWNER, { customerId: "cus_AskIndex01", subscriptionId: "sub_AskIndex01", active: true, tier: "pro", period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
  const ids: string[] = [];
  for (const title of ["Glaze Chart", "Kiln Guide", "Clay Notes", "Wheel Basics"]) {
    const made = await addProduct(OWNER, title, "", "12", null);
    assert.ok(made.ok);
    await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
    ids.push(made.product.id);
  }
  return { store: (await storeForEmail(OWNER))!, ids };
}

async function queued() {
  const { store, ids } = await shop();
  const product = (await readListing(store, ids[0]))!;
  assert.equal(await askReminder({ store, product, email: PERSON, ip: "203.0.113.123", from: "page", when: "days" }), "asked");
  const index = askIndexKey(store.statsId!, PERSON);
  const members = redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[];
  assert.equal(members.length, 1, "the real public writer queued the ask");
  return { store, ids, index, member: members[0] };
}

test("an ask remains erasable after eleven days without a worker", async () => {
  const { store, index } = await queued();
  redis.advance(11 * 86_400 * 1000);
  const removed = await forgetAskPerson(store.statsId!, PERSON);
  const after = redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[];
  console.log("ASK_INDEX_RETENTION", JSON.stringify({ removed, indexCount: redis.run(["ZCARD", index]), queueCount: after.length, containsAddress: after.some((m) => m.includes(PERSON)) }));
  assert.equal(after.some((m) => m.includes(PERSON)), false, "erasure cannot finish while the queue retains the address");
  assert.equal(removed, 1);
  assert.equal(redis.run(["EXISTS", index]), 0, "erasure also removes its locator");
});

test("a person's copy still lists the ask after the old index expiry", async () => {
  const { store } = await queued();
  redis.advance(11 * 86_400 * 1000);
  assert.equal((await asksOf(store.statsId!, PERSON)).length, 1);
});

test("a new ask clears a previous index expiry and healthy completion removes the index", async () => {
  const { store, ids, index } = await queued();
  redis.run(["EXPIRE", index, 60]);
  const product = (await readListing(store, ids[1]))!;
  assert.equal(await askReminder({ store, product, email: PERSON, ip: "203.0.113.124" }), "asked");
  assert.equal(redis.run(["TTL", index]), -1, "new writes preserve the locator for both old and new queued asks");
  const members = redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[];
  for (const member of members) redis.run(["ZADD", QUEUE, 0, member]);
  assert.deepEqual(await sendAsked(async () => null, Date.now() + 10_000), { sent: 0, skipped: 2, retried: 0 });
  assert.equal(redis.run(["EXISTS", QUEUE]), 0);
  assert.equal(redis.run(["EXISTS", index]), 0, "the last completed ask removes the entire index key");
});

test("a retry clears a previous index expiry and remains erasable", async () => {
  const { store, index, member } = await queued();
  redis.run(["EXPIRE", index, 60]);
  redis.run(["ZADD", QUEUE, 0, member]);
  const error = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await sendAsked(async () => { throw new Error("synthetic store read unavailable"); }, Date.now() + 10_000), { sent: 0, skipped: 0, retried: 1 });
  } finally {
    console.error = error;
  }
  assert.equal(redis.run(["TTL", index]), -1, "retry cannot lose its erasure locator before the queue member");
  redis.advance(11 * 86_400 * 1000);
  assert.equal(await forgetAskPerson(store.statsId!, PERSON), 1);
  assert.equal(redis.run(["EXISTS", QUEUE]), 0);
  assert.equal(redis.run(["EXISTS", index]), 0);
});

test("control: a healthy worker removes the queue member and the empty index", async () => {
  const { index, member } = await queued();
  redis.run(["ZADD", QUEUE, 0, member]);
  assert.deepEqual(await sendAsked(async () => null, Date.now() + 10_000), { sent: 0, skipped: 1, retried: 0 });
  assert.equal(redis.run(["EXISTS", QUEUE]), 0);
  assert.equal(redis.run(["EXISTS", index]), 0);
});
