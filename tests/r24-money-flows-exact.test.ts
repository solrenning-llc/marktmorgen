/**
 * Rule 24 where money and other people's systems hang on a read (lib/upsell.ts,
 * lib/webhooks.ts): a reply in an unknown shape is never "no affiliate", never
 * "no such offer", never "this click may charge" and never "no webhook settings".
 *
 *   - a one-click offer whose affiliate cannot be read is not charged at all,
 *     rather than charged without the affiliate's share on it;
 *   - an offer's once-only claim (SET NX) is ours on "OK", or read back holding
 *     its own value; another press's on null; a claim that landed is never stuck;
 *   - the five-minute job keeps an offer waiting on Stripe on its list while
 *     its record cannot be read; a record that is gone still lets it go;
 *   - the Stripe watch keeps a store whose webhook settings cannot be read; a
 *     store with none is still let go;
 *   - a queued delivery whose record cannot be read stays queued; one that is
 *     gone is still taken off;
 *   - an event is never said to have no listeners when the settings cannot be read.
 *
 * Synthetic store, checkout and Stripe answers; nothing leaves this machine.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductFunnel, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { newUpsellKey, readUpsell, settlePendingOffers, takeUpsell } from "@/lib/upsell";
import { QUEUE_KEY, deliverDue, emitEvent, setSendHooksForTests, watchStripe } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { shownRef } from "./upsell-ref-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_r24_money_only";
process.env.RESEND_API_KEY = "re_test_r24_money_only";
setSendHooksForTests({ fetch: { resolve: async () => { throw new Error("a stand-in that answers nothing"); } } as never });

const OWNER = "r24-money@example.com";
const ACCOUNT = "acct_1TestR24Money01";
const NOW = Math.floor(Date.now() / 1000);
const AFFILIATE = "0123456789ab";
const charges: URLSearchParams[] = [];
const sessions: Record<string, Record<string, unknown>> = {};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const session = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
  if (session && method === "GET") return sessions[session[1]] ? answer(sessions[session[1]]) : answer({ error: { message: "no such checkout" } }, 404);
  if (path === "/payment_intents" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    charges.push(body);
    return answer({ id: `pi_test_${String(charges.length).padStart(10, "0")}`, object: "payment_intent", amount: Number(body.get("amount")), currency: body.get("currency"), status: "succeeded", created: NOW, metadata: {} });
  }
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

type Cmd = (string | number)[];
const memory = redis.pipeline.bind(redis);
/** The webhook queue's lease (lib/webhooks.ts, LEASE_SCRIPT), modelled as Redis runs it, as tests/webhooks-delivery.test.ts does. */
const original = (async (commands: Cmd[]) => {
  const [only] = commands;
  if (commands.length === 1 && only[0] === "EVAL" && String(only[1]).includes('redis.call("ZSCORE", KEYS[1], ARGV[1])')) {
    const [, , , key, member, now, until] = only.map(String);
    const [due] = await memory([["ZSCORE", key, member]]);
    if (due === null || due === undefined || Number(due) > Number(now)) return [0];
    await memory([["ZADD", key, Number(until), member]]);
    return [1];
  }
  return memory(commands);
}) as typeof redis.pipeline;
redis.pipeline = original;
/** Commands `match` picks answer `reply` ("throw": the pipeline fails; "short": no replies at all). */
async function withReply<T>(match: (cmd: Cmd) => boolean, reply: unknown, work: () => Promise<T>): Promise<T> {
  redis.pipeline = (async (commands: Cmd[]) => {
    if (!commands.some(match)) return original(commands);
    if (reply === "throw") throw new Error("Redis could not be reached");
    const out = await original(commands);
    if (reply === "short") return [];
    return commands.map((cmd, i) => (match(cmd) ? reply : out[i]));
  }) as typeof redis.pipeline;
  try {
    return await work();
  } finally {
    redis.pipeline = original;
  }
}

function paidCheckout(id: string, product: string, fingerprint: string, via = ""): Record<string, unknown> {
  return {
    id,
    status: "complete",
    payment_status: "paid",
    created: NOW - 60,
    customer: "cus_TestBuyer01",
    currency: "usd",
    metadata: { store: "r24money", product, upsell_key: fingerprint, ...(via ? { via } : {}) },
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: "pi_test_front00001", payment_method: { id: "pm_test_card0001", type: "card", customer: "cus_TestBuyer01" } },
  };
}

/** The offer step's reference the page posts, read once the store holds its funnel. */
let STEP = "kit001";
const world = (async () => {
  redis.clear();
  await claimHandle(OWNER, "r24money", "R24 Money", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const add = async (title: string, price: string) => {
    const result = await addProduct(OWNER, title, "", price, null);
    if (!result.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, result.product.id, `https://example.com/${result.product.id}`);
    return result.product.id;
  };
  const front = await add("Synthetic Course", "49");
  const kit = await add("Synthetic Kit", "29");
  const saved = await setProductFunnel(OWNER, front, { steps: [{ id: "kit001", productId: kit, priceCents: 1900, headline: "", text: "", imageFrom: null, yes: null, no: null }] });
  assert.equal(saved.ok, true);
  const plain = (await storeForEmail(OWNER))!;
  // The programme on, read from the store as the page would have it.
  const withAffiliates: Store = { ...plain, affiliates: { ...plain.affiliates, enabled: true } };
  // The step as the thanks page's form names it (lib/upsell.ts, offerRef: answered only on the terms the page drew).
  STEP = await shownRef(plain, "kit001");
  return { front, plain, withAffiliates, browser: newUpsellKey() };
})();

let n = 0;
const nextSession = () => `cs_test_r24money${String(++n).padStart(8, "0")}`;
const isAffiliateRead = (cmd: Cmd) => cmd[0] === "HGET" && String(cmd[1]).startsWith("nl:aff:") && String(cmd[1]).endsWith(":people");

test("an offer with an affiliate nobody approved is charged, without a share (confirmed-absence control)", async () => {
  const { front, withAffiliates, browser } = await world;
  const session = nextSession();
  sessions[session] = paidCheckout(session, front, browser.fingerprint, AFFILIATE);
  const before = charges.length;
  const result = await takeUpsell({ store: withAffiliates, session, secret: browser.secret, origin: "https://marktmorgen.com", step: STEP, answer: "yes", consent: TEST_CONSENT });
  assert.equal(result.kind, "done");
  assert.equal(charges.length, before + 1);
  assert.equal(charges.at(-1)?.get("metadata[via]"), null);
});

// Only a read that fails outright reaches lib/upsell.ts: a reply of another shape is read by lib/affiliates.ts
// readAffiliate, outside this change, which still answers "no such affiliate" on it (reported, not changed here).
for (const [label, reply] of [["a Redis failure", "throw"]] as [string, unknown][]) {
  test(`an offer whose affiliate read is ${label} is not charged without the affiliate`, async () => {
    const { front, withAffiliates, browser } = await world;
    const session = nextSession();
    sessions[session] = paidCheckout(session, front, browser.fingerprint, AFFILIATE);
    const before = charges.length;
    await withReply(isAffiliateRead, reply, async () => {
      const outcome = await takeUpsell({ store: withAffiliates, session, secret: browser.secret, origin: "https://marktmorgen.com", step: STEP, answer: "yes", consent: TEST_CONSENT }).then(
        (result) => result.kind,
        () => "rejected",
      );
      assert.notEqual(outcome, "done");
    });
    assert.equal(charges.length, before, "nothing charged");
  });
}

const isClaim = (session: string) => (cmd: Cmd) => cmd[0] === "SET" && cmd[1] === `nl:upsell:${session}` && cmd.includes("NX");

const yes = (store: Store, session: string, secret: string) =>
  takeUpsell({ store, session, secret, origin: "https://marktmorgen.com", step: STEP, answer: "yes", consent: TEST_CONSENT });
const outcomeOf = (work: Promise<{ kind: string }>) => work.then((result) => result.kind, () => "threw");

// Revisor 1 on #2897: a claim that landed with its reply lost is ours. It is read back by its own value
// (lib/claim-mark.ts), never taken for another press, which would leave the offer pending with nothing charged.
for (const [label, reply] of [["undefined", undefined], ["a short pipeline", "short"], ["an object", {}], ["a number", 1]] as [string, unknown][]) {
  test(`an offer's once-only claim that landed, answering ${label}, is ours: charged once, never stuck`, async () => {
    const { front, plain, browser } = await world;
    const session = nextSession();
    sessions[session] = paidCheckout(session, front, browser.fingerprint);
    const before = charges.length;
    const first = await withReply(isClaim(session), reply, () => outcomeOf(yes(plain, session, browser.secret)));
    const second = await outcomeOf(yes(plain, session, browser.secret));
    assert.deepEqual({ first, second, charged: charges.length - before }, { first: "done", second: "done", charged: 1 });
    assert.equal((await readUpsell(session, ""))?.state, "paid");
  });
}

test("an offer's claim whose reply and read-back are both unknown charges nothing, and a retry charges once", async () => {
  const { front, plain, browser } = await world;
  const session = nextSession();
  sessions[session] = paidCheckout(session, front, browser.fingerprint);
  const before = charges.length;
  const readBack = (cmd: Cmd) => cmd[0] === "GET" && cmd[1] === `nl:upsell:${session}`;
  redis.pipeline = (async (commands: Cmd[]) => {
    const out = await original(commands);
    if (commands.length === 1 && (isClaim(session)(commands[0]) || readBack(commands[0]))) return [{}];
    return out;
  }) as typeof redis.pipeline;
  let first: string;
  try {
    first = await outcomeOf(yes(plain, session, browser.secret));
  } finally {
    redis.pipeline = original;
  }
  assert.deepEqual({ first, charged: charges.length - before }, { first: "threw", charged: 0 });
  const second = await outcomeOf(yes(plain, session, browser.secret));
  assert.deepEqual({ second, charged: charges.length - before }, { second: "done", charged: 1 });
});

// A write after the claim was won fails (Claude 5 on #2897, MEDIUM 1): the claim is let go, so the "try again"
// the buyer is told is true; the retry claims it again and charges once. Both a write that never landed and one that
// landed with its reply lost are covered. Nothing is charged before the retry.
for (const [label, landed] of [["never landed", false], ["landed, its reply lost", true]] as [string, boolean][]) {
  test(`an offer whose record write after the claim ${label} is let go, and a retry charges once`, async () => {
    const { front, plain, browser } = await world;
    const session = nextSession();
    sessions[session] = paidCheckout(session, front, browser.fingerprint);
    const before = charges.length;
    let failed = false;
    redis.pipeline = (async (commands: Cmd[]) => {
      const write = commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === `nl:upsell:${session}` && !commands[0].includes("NX");
      if (!write || failed) return original(commands);
      failed = true;
      if (landed) await original(commands);
      throw new Error("Redis could not be reached");
    }) as typeof redis.pipeline;
    let first: string;
    try {
      first = await outcomeOf(yes(plain, session, browser.secret));
    } finally {
      redis.pipeline = original;
    }
    assert.equal(failed, true, "the record write after the claim was reached");
    assert.deepEqual({ first, charged: charges.length - before }, { first: "threw", charged: 0 });
    const second = await outcomeOf(yes(plain, session, browser.secret));
    assert.deepEqual({ second, charged: charges.length - before, state: (await readUpsell(session))?.state }, { second: "done", charged: 1, state: "paid" });
  });
}

test("an offer's once-only claim already held (null) charges nothing and says done (confirmed control)", async () => {
  const { front, plain, browser } = await world;
  const session = nextSession();
  sessions[session] = paidCheckout(session, front, browser.fingerprint);
  const before = charges.length;
  const result = await withReply(isClaim(session), null, () => takeUpsell({ store: plain, session, secret: browser.secret, origin: "https://marktmorgen.com", step: STEP, answer: "yes", consent: TEST_CONSENT }));
  assert.equal(result.kind, "done");
  assert.equal(charges.length, before);
});

const PENDING = "nl:upsell:pending";
async function pendingOffer(): Promise<{ session: string; member: string }> {
  const session = nextSession();
  const member = `r24money|${session}|`;
  await original([
    ["SET", `nl:upsell:${session}`, JSON.stringify({ state: "pending", product: "p_none", at: Date.now() - 5 * 60_000 }), "EX", 3600],
    ["ZADD", PENDING, Date.now() - 5 * 60_000, member],
  ]);
  return { session, member };
}
const listed = async (member: string) => (await original([["ZSCORE", PENDING, member]]))[0] !== null;

test("the job lets go of an offer whose record is gone (confirmed-absence control)", async () => {
  await world;
  const { session, member } = await pendingOffer();
  await original([["DEL", `nl:upsell:${session}`]]);
  await settlePendingOffers(async () => null, Date.now() + 5_000);
  assert.equal(await listed(member), false);
});

for (const [label, reply] of [["undefined", undefined], ["a short pipeline", "short"], ["an object", {}], ["text that is not a record", "{oops"]] as [string, unknown][]) {
  test(`the job keeps an offer whose record reads as ${label}`, async () => {
    await world;
    const { session, member } = await pendingOffer();
    await withReply((cmd) => cmd[0] === "GET" && cmd[1] === `nl:upsell:${session}`, reply, () => settlePendingOffers(async () => null, Date.now() + 5_000));
    assert.equal(await listed(member), true);
  });
}

const STORES = "nl:hooks:stores";
const watched = async (statsId: string) => (await original([["SISMEMBER", STORES, statsId]]))[0] === 1;
const cfgOf = (statsId: string) => (cmd: Cmd) => cmd[0] === "GET" && cmd[1] === `nl:hooks:cfg:${statsId}`;

test("the Stripe watch lets go of a store with no webhook settings (confirmed-absence control)", async () => {
  const statsId = "f".repeat(32);
  await original([["DEL", STORES], ["SADD", STORES, statsId]]);
  await watchStripe(Date.now() + 5_000);
  assert.equal(await watched(statsId), false);
});

for (const [label, reply] of [["undefined", undefined], ["an object", {}], ["text that is not settings", "{oops"]] as [string, unknown][]) {
  test(`the Stripe watch keeps a store whose settings read as ${label}`, async () => {
    const statsId = "e".repeat(32);
    await original([["DEL", STORES], ["SADD", STORES, statsId]]);
    await withReply(cfgOf(statsId), reply, () => watchStripe(Date.now() + 5_000).catch(() => undefined));
    assert.equal(await watched(statsId), true);
  });
}

const DELIVERY = "dlv_0123456789abcdef01234567";
const queued = async (member: string) => (await original([["ZSCORE", QUEUE_KEY, member]]))[0] !== null;

test("a queued delivery whose record is gone is taken off the queue (confirmed-absence control)", async () => {
  const member = `${"d".repeat(32)}|${DELIVERY}`;
  await original([["DEL", QUEUE_KEY], ["ZADD", QUEUE_KEY, Date.now() - 60_000, member], ["DEL", `nl:hooks:d:${DELIVERY}`]]);
  await deliverDue(Date.now() + 5_000);
  assert.equal(await queued(member), false);
});

for (const [label, reply] of [["undefined", undefined], ["an object", {}], ["text that is not a delivery", "{oops"]] as [string, unknown][]) {
  test(`a queued delivery whose record reads as ${label} stays queued`, async () => {
    const member = `${"d".repeat(32)}|${DELIVERY}`;
    await original([["DEL", QUEUE_KEY], ["ZADD", QUEUE_KEY, Date.now() - 60_000, member]]);
    await withReply((cmd) => cmd[0] === "GET" && cmd[1] === `nl:hooks:d:${DELIVERY}`, reply, () => deliverDue(Date.now() + 5_000).catch(() => undefined));
    assert.equal(await queued(member), true);
  });
}

test("an event of a store with no webhook settings has nobody to send to (confirmed-absence control)", async () => {
  const store = { statsId: "c".repeat(32), handle: "r24money" } as Store;
  assert.equal(await emitEvent(store, "sale.completed", "seed-1", {}), 0);
});

for (const [label, reply] of [["undefined", undefined], ["an object", {}], ["text that is not settings", "{oops"]] as [string, unknown][]) {
  test(`an event is never said to have no listeners when the settings read as ${label}`, async () => {
    const store = { statsId: "b".repeat(32), handle: "r24money" } as Store;
    await withReply(cfgOf(store.statsId as string), reply, () => assert.rejects(() => emitEvent(store, "sale.completed", "seed-2", {})));
  });
}
