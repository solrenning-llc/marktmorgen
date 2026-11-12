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
