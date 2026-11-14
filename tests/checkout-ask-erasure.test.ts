/**
 * A checkout reminder someone asked for, deleted with them (webhooks/cron audit, Claude 1, 12/11/2026). Each ask
 * waits in one queue for every store (lib/checkout-ask.ts, nl:recover:asks), its member holding the address in
 * plain text, for up to three days when asked on a product's page ("in three days", lib/ask-when.ts), and longer
 * with the send's retries. A person's erasure (lib/person-erasure.ts) never took it out: the address stayed in the
 * database until the five-minute job came to it and skipped it, while the data page said "expires, 1 day". Now the
 * erasure takes that person's asks at that store off the queue, read exactly; other people's and other stores'
 * asks stay.
 * Synthetic only: an in-memory Redis, no provider reached.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ASK_AFTER_SECONDS, askMember, asksOf, parseAsk } from "@/lib/checkout-ask";
import { ASK_WHENS } from "@/lib/ask-when";
import { erasePerson } from "@/lib/person-erasure";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const QUEUE = "nl:recover:asks";
const PERSON = "ask-erased@example.test";
const OTHER = "ask-kept@example.test";

test("a person's checkout reminder asks leave the queue with them, and nobody else's do", async () => {
  redis.clear();
  const oldFetch = globalThis.fetch;
  const oldLog = console.error;
  globalThis.fetch = async () => {
    throw new Error("No external provider allowed");
  };
  console.error = () => {};
  try {
    const owner = "ask-erasure-owner@example.test";
    await claimHandle(owner, "askerasure", "Ask Erasure", "");
    await ensureStoreId(owner);
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setSubscription(owner, { customerId: "cus_AskErasure1", subscriptionId: "sub_AskErasure1", active: true, tier: "pro", period: paidPeriod() });
    const made = await addProduct(owner, "Synthetic course", "", "27", null);
    assert.ok(made.ok);
    const shop = (await storeForEmail(owner))!;
    const statsId = shop.statsId!;
    const now = Math.floor(Date.now() / 1000);
    const base = { statsId, handle: shop.handle, productId: made.product.id, askedAt: now };
    const onPage = askMember({ ...base, email: PERSON, from: "page", after: ASK_WHENS.days });
    const atCheckout = askMember({ ...base, email: PERSON, from: "checkout", after: ASK_AFTER_SECONDS });
    const someoneElse = askMember({ ...base, email: OTHER, from: "page", after: ASK_WHENS.days });
    const otherStore = askMember({ ...base, statsId: "0123456789abcdef0123456789abcdef", email: PERSON, from: "checkout", after: ASK_AFTER_SECONDS });
    redis.run(["ZADD", QUEUE, now + ASK_WHENS.days, onPage, now + ASK_AFTER_SECONDS, atCheckout, now + ASK_WHENS.days, someoneElse, now + ASK_AFTER_SECONDS, otherStore]);
    // Each store's own index, as an ask is written (lib/checkout-ask.ts keep).
    redis.run(["ZADD", `nl:recover:asks:s:${statsId}`, now + ASK_WHENS.days, onPage, now + ASK_AFTER_SECONDS, atCheckout, now + ASK_WHENS.days, someoneElse]);
    redis.run(["ZADD", "nl:recover:asks:s:0123456789abcdef0123456789abcdef", now + ASK_AFTER_SECONDS, otherStore]);

    const copy = await asksOf(statsId, PERSON);
    assert.deepEqual(copy.map((a) => a.from).sort(), ["checkout", "page"], "their copy lists both asks still waiting at this store");

    const result = await erasePerson(shop, PERSON, { kind: "person" });
    assert.equal(result.ok, true, JSON.stringify(result));
    const left = (redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[]).map((m) => parseAsk(m));
    assert.equal(left.filter((a) => a?.statsId === statsId && a.email === PERSON).length, 0, "no ask of theirs at this store is left");
    assert.equal(left.filter((a) => a?.email === OTHER).length, 1, "another person's ask stays");
    assert.equal(left.filter((a) => a?.statsId !== statsId && a?.email === PERSON).length, 1, "their ask at another store is that store's to delete");
    assert.deepEqual(await asksOf(statsId, PERSON), [], "and their copy has none left");
  } finally {
    globalThis.fetch = oldFetch;
    console.error = oldLog;
  }
});

/**
 * Claude 2 nuvem B's MEDIUM on #4290: the erasure scanned the whole queue (every store's asks, ZSCAN pages of 500 up
 * to 1,000 rounds), a cost that grows with the platform, not the store, outside the erasure's own unit. A store's
 * asks are now also kept in its own index, written and taken out with the queue, and the erasure and the copy read
 * only that index.
 */
test("a person's erasure reads only their store's asks, however many other stores' asks wait", async () => {
  redis.clear();
  const { forgetAskPerson, sendAsked } = await import("@/lib/checkout-ask");
  const statsId = "abcdefabcdefabcdefabcdefabcdef12";
  const now = Math.floor(Date.now() / 1000);
  const mine = askMember({ statsId, handle: "askindex", productId: "prod01", email: PERSON, askedAt: now, from: "page", after: ASK_WHENS.days });
  const STORE_QUEUE = `nl:recover:asks:s:${statsId}`;
  // Their ask, put back by the job after a failed send: the queue's own path (again), so it is written as the code writes it.
  redis.run(["ZADD", QUEUE, now - 10, mine]);
  const broken = async () => {
    throw new Error("synthetic: the store could not be read");
  };
  const oldLog = console.error;
  console.error = () => {};
  try {
    await sendAsked(broken, Date.now() + 10_000);
  } finally {
    console.error = oldLog;
  }
  const back = (redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[]).filter((m) => parseAsk(m)?.email === PERSON);
  assert.equal(back.length, 1, "(control) the job put their ask back for a later try");
  assert.deepEqual(redis.run(["ZRANGEBYSCORE", STORE_QUEUE, "-inf", "+inf"]), back, "and it is in their store's own index too");

  // Thousands of other stores' asks in the one queue.
  const others: (string | number)[] = [];
  for (let i = 0; i < 3_000; i += 1) others.push(now + 3600, askMember({ statsId: `${String(i).padStart(32, "0")}`, handle: `shop${i}`, productId: "p", email: `buyer${i}@example.test`, askedAt: now, from: "checkout", after: ASK_AFTER_SECONDS }));
  redis.run(["ZADD", QUEUE, ...others]);

  const real = redis.pipeline.bind(redis);
  const seen: (string | number)[][] = [];
  redis.pipeline = (async (commands: (string | number)[][]) => {
    seen.push(...commands);
    return real(commands);
  }) as typeof redis.pipeline;
  let taken: number;
  try {
    taken = await forgetAskPerson(statsId, PERSON);
  } finally {
    redis.pipeline = real;
  }
  assert.equal(taken, 1, "their ask was taken off");
  assert.equal(seen.some((c) => c[0] === "ZSCAN" || ((c[0] === "ZRANGE" || c[0] === "ZRANGEBYSCORE") && c[1] === QUEUE)), false, "the whole queue is never read");
  assert.ok(seen.length <= 3, `a few commands, whatever the queue holds (got ${seen.length})`);
  assert.equal((redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[]).filter((m) => parseAsk(m)?.email === PERSON).length, 0, "nothing of theirs is left in the queue");
  assert.equal(redis.run(["ZCARD", STORE_QUEUE]), 0, "nor in their store's index");

  // Sent (or dropped) by the job: it leaves the index with the queue.
  const later = askMember({ statsId, handle: "askindex", productId: "prod01", email: OTHER, askedAt: now - 100, from: "checkout", after: ASK_AFTER_SECONDS });
  redis.run(["ZADD", QUEUE, now - 5, later]);
  redis.run(["ZADD", STORE_QUEUE, now - 5, later]);
  const gone = async () => null;
  await sendAsked(gone, Date.now() + 10_000);
  assert.equal(redis.run(["ZSCORE", STORE_QUEUE, later]), null, "an ask the job took leaves the store's index too");
});
