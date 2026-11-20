/**
 * A checkout reminder ask is kept in one queue for every store and in one index for the person at the store
 * (lib/checkout-ask.ts, askIndexKey), so a person's erasure and copy read only their own asks (#4290).
 *
 * - Claude 7 (6876533256), MEDIUM 1: the index was only ever seeded by hand in the tests; here the asks are made
 *   through askReminder and askCartReminder, the paths every ask takes, and the index is read back.
 * - Claude 7, MEDIUM 2: the erasure read the whole store's index (every buyer's asks, about 330 KB at the store's
 *   ceiling) outside what an erasure is charged; it now reads the person's own.
 * - Codex L and U: the global removal and the index removal went in one pipeline; a failed global removal with the
 *   index's applied left the address in the queue with nothing to find it by. The global one goes first now.
 * - Claude 7 (6876338779): what an ask costs is measured against a later page, the request it is paid as.
 * Synthetic only: an in-memory Redis, no provider reached.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { askCartReminder, askIndexKey, askMember, askReminder, forgetAskPerson } from "@/lib/checkout-ask";
import { ASK_WHENS } from "@/lib/ask-when";
import { readListing, readListings } from "@/lib/catalog";
import { MAX_CART } from "@/lib/cart-rules";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { COMMANDS } from "./traffic-cost";

const QUEUE = "nl:recover:asks";
const PERSON = "ask-index@example.test";
const OTHER = "ask-index-other@example.test";
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

test("asks made the way every ask is made are in the person's own index, and only theirs", async () => {
  const { store, ids } = await shop();
  const product = (await readListing(store, ids[0]))!;
  assert.equal(await askReminder({ store, product, email: PERSON, ip: "203.0.113.5", from: "page", when: "days" }), "asked");
  assert.equal(await askCartReminder({ store, items: [product, (await readListing(store, ids[1]))!], email: PERSON.toUpperCase(), ip: "203.0.113.6" }), "asked");
  assert.equal(await askReminder({ store, product, email: OTHER, ip: "203.0.113.7" }), "asked");
  const theirs = redis.run(["ZRANGEBYSCORE", askIndexKey(store.statsId!, PERSON), "-inf", "+inf"]) as string[];
  assert.equal(theirs.length, 2, "their two asks, the product's and the cart's, are in their index");
  assert.ok(theirs.every((member) => member.includes(PERSON)), "and nobody else's");
  assert.equal((redis.run(["ZRANGEBYSCORE", askIndexKey(store.statsId!, OTHER), "-inf", "+inf"]) as string[]).length, 1, "the other buyer's ask is in theirs");
  assert.equal(redis.run(["TTL", askIndexKey(store.statsId!, PERSON)]), -1, "the erasure locator stays until its queued addresses leave");
  assert.equal(await forgetAskPerson(store.statsId!, PERSON), 2, "their erasure takes both off the queue");
  assert.equal((redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[]).filter((m) => m.includes(PERSON)).length, 0);
  assert.equal((redis.run(["ZRANGEBYSCORE", QUEUE, "-inf", "+inf"]) as string[]).filter((m) => m.includes(OTHER)).length, 1, "the other buyer's stays");
});

test("an ask costs no more than the later page it is paid as", async () => {
  const { store, ids } = await shop();
  const real = redis.pipeline.bind(redis);
  let sent = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent += commands.length;
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    // What the route sends besides the public request it takes (app/api/store/remind/route.ts): the store, the
    // listing and the ask.
    const found = (await storeForHandle(store.handle))!;
    const product = (await readListing(found, ids[0]))!;
    assert.equal(await askReminder({ store: found, product, email: PERSON, ip: "203.0.113.8", from: "page", when: "days" }), "asked");
  } finally {
    redis.pipeline = real;
  }
  console.log(`an ask sends ${sent} commands besides its public request; a later page is priced at ${COMMANDS.laterPage}`);
  assert.ok(sent <= COMMANDS.laterPage, `an ask sends ${sent} commands, a later page is priced at ${COMMANDS.laterPage}`);
  // A whole cart, at its largest (MAX_CART), reads every listing it names (Claude 7).
  assert.equal(ids.length, MAX_CART);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    sent += commands.length;
    return real(commands);
  }) as typeof redis.pipeline;
  sent = 0;
  try {
    const found = (await storeForHandle(store.handle))!;
    assert.equal(await askCartReminder({ store: found, items: await readListings(found, ids), email: OTHER, ip: "203.0.113.9" }), "asked");
  } finally {
    redis.pipeline = real;
  }
  console.log(`a cart's ask (${MAX_CART} products) sends ${sent} commands besides its public request`);
  assert.ok(sent <= COMMANDS.laterPage, `a cart's ask sends ${sent} commands, a later page is priced at ${COMMANDS.laterPage}`);
});

test("a failed global removal keeps the person's index for the erasure's retry (Codex L and U)", async () => {
  redis.clear();
  const statsId = "abcdefabcdefabcdefabcdefabcdef12";
  const now = Math.floor(Date.now() / 1000);
  const member = askMember({ statsId, handle: "askretry", productId: "prod01", email: PERSON, askedAt: now, from: "page", after: ASK_WHENS.days });
  redis.run(["ZADD", QUEUE, now + ASK_WHENS.days, member]);
  redis.run(["ZADD", askIndexKey(statsId, PERSON), now + ASK_WHENS.days, member]);
  const real = redis.pipeline.bind(redis);
  let injected = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!injected && commands.some((c) => (c[0] === "ZREM" && c[1] === QUEUE) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:ask-forget:")))) {
      injected = true;
      // The global removal fails, and every other command of the same batch is applied.
      const later = commands.filter((c) => !((c[0] === "ZREM" && c[1] === QUEUE) || (c[0] === "EVAL" && String(c[1]).startsWith("-- marktmorgen:ask-forget:"))));
      if (later.length) await real(later);
      throw new Error("synthetic: global ZREM unavailable");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    await assert.rejects(forgetAskPerson(statsId, PERSON), /global ZREM unavailable/);
  } finally {
    redis.pipeline = real;
  }
  assert.equal(await forgetAskPerson(statsId, PERSON), 1, "the index still names the ask, so the retry takes the global copy");
  assert.equal(redis.run(["ZSCORE", QUEUE, member]), null);
  assert.equal(redis.run(["ZSCORE", askIndexKey(statsId, PERSON), member]), null);
});
