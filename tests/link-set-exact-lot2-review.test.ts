/**
 * The review request (lib/review-requests.ts sendReviewRequests) emails a link
 * to write a review (lib/review-proof.ts mintReviewLink) only once Redis said it
 * stored that link (rule 24, the signin-link-set-exact pattern, lot 2):
 *
 *   - the link's write (its SET and the three commands that note it for the
 *     person's erasure) answered short, long, or with anything but exactly "OK"
 *     for the SET gives no link: no paid email goes, the link, in case it landed
 *     with its answer lost, is deleted, the order's claim is undone and the
 *     order stays due an hour later, when it is sent once;
 *   - the same for the one reminder, which goes back on the list;
 *   - a write that throws takes the same path, and never stops the run: the
 *     other orders of the run are still sent;
 *   - with Redis answering "OK", the request goes once, as before.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY, askMember, scheduleReviewAsk } from "@/lib/review-ask";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const person = "review-person@example.test";
const reference = "cs_test_ReviewLinkSet01";
const LINK = "nl:rev:link:";
const SENT = `nl:rev:ask:sent:${reference}`;

async function setup() {
  redis.clear();
  const owner = "review-set-owner@example.test";
  const batches: { to: string | string[]; text?: string }[][] = [];
  let productId = "";
  const now = Math.floor(Date.now() / 1000);
  const paidAt = now - 8 * 86400;
  process.env.STRIPE_SECRET_KEY = "sk_test_reviews_only_a_stand_in";
  // Existing allowlisted synthetic provider credential; never a live account.
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body)); batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    if (url.pathname === `/v1/checkout/sessions/${reference}`) return Response.json({
      id: reference, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
      created: paidAt, amount_total: 2700, currency: "usd", customer_details: { email: person },
      metadata: { store: "reviewlinkset", product: productId },
      payment_intent: { id: "pi_ReviewLinkSet01", status: "succeeded", latest_charge: { id: "ch_ReviewLinkSet01", amount: 2700, amount_refunded: 0, disputed: false, refunded: false } },
    });
    return Response.json({ object: "list", data: [], has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "reviewlinkset", "Review Link Set", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_ReviewLinkSet", subscriptionId: "sub_ReviewLinkSet", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "Review Link Set", address: "1 Example St, Example City" });
  await setReviewAsk(owner, { days: 7, again: 7 } as Parameters<typeof setReviewAsk>[1]);
  const made = await addProduct(owner, "Review link", "", "27", null);
  assert.ok(made.ok); productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/review");
  const shop = (await storeForEmail(owner))!;
  assert.equal(await scheduleReviewAsk(shop, reference, paidAt), true);
  const member = askMember({ statsId: shop.statsId!, handle: shop.handle, reference, paidAt });
  const base = redis.pipeline.bind(redis);
  // MemoryRedis lacks ZADD XX: native Redis 7.4.2's existing-member update, as tests/review-request-erasure-evidence.test.ts.
  const original: typeof redis.pipeline = async commands => {
    if (!commands.some(c => c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX")) return base(commands);
    const replies: unknown[] = [];
    for (const c of commands) {
      if (c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX" && c.length === 5) {
        if (redis.run(["ZSCORE", ASK_DUE_KEY, c[4]]) !== null) redis.run(["ZADD", ASK_DUE_KEY, c[3], c[4]]);
        replies.push(0);
      } else replies.push(...await base([c]));
    }
    return replies;
  };
  redis.pipeline = original;
  return { shop, now, member, batches, original, base };
}

/** Answers to the link's write that do not say the SET stored it. */
const ODD: [string, (n: number) => unknown[]][] = [
  ["no reply at all", () => []],
  ["a null SET reply", (n) => [null, ...Array(n - 1).fill(1)]],
  ["an undefined SET reply", (n) => [undefined, ...Array(n - 1).fill(1)]],
  ["a SET reply of another word", (n) => ["QUEUED", ...Array(n - 1).fill(1)]],
  ["the SET's reply alone", () => ["OK"]],
  ["one reply too many", (n) => ["OK", ...Array(n).fill(1)]],
  // The write thrown (a timeout, a Redis error status, an error item): the same path, never a run aborted with its sending mark left.
  ["a thrown write", () => { throw new Error("Redis request failed with status 500"); }],
];

const links = () => redis.keys().filter((key) => key.startsWith(LINK)).length;
const sentTo = (batches: { to: string | string[] }[][]) => batches.flat().flatMap((m) => [m.to].flat());

/** The link's write answered by `reply`, landed or not, for the next run only. */
function oddLinkWrite(r: Awaited<ReturnType<typeof setup>>, reply: (n: number) => unknown[], apply: boolean): void {
  redis.pipeline = async (commands) => {
    if (commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith(LINK)) {
      if (apply) await r.original(commands);
      return reply(commands.length);
    }
    return r.original(commands);
  };
}

for (const [what, reply] of ODD) {
  for (const apply of [false, true]) {
    const label = `${what}${apply ? " (the write landed)" : ""}`;
    test(`${label}: the first request sends nothing, leaves no link and is asked again an hour later`, async () => {
      const oldFetch = globalThis.fetch;
      const r = await setup();
      try {
        oddLinkWrite(r, reply, apply);
        const result = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
        redis.pipeline = r.original;
        assert.deepEqual(result, { sent: 0, dropped: 0, waiting: 1 });
        assert.equal(r.batches.length, 0, "no email");
        assert.equal(links(), 0, "no link left behind");
        assert.equal(redis.run(["GET", SENT]), null, "the send claim is undone");
        assert.deepEqual(redis.run(["ZRANGEBYSCORE", ASK_DUE_KEY, r.now + 1, r.now + 3600]), [r.member], "still due, an hour later");
        assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 3601), { sent: 1, dropped: 0, waiting: 0 });
        assert.deepEqual(sentTo(r.batches), [person], "then sent once");
        assert.equal(links(), 1, "with its one link");
      } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
    });

    test(`${label}: the reminder sends nothing, leaves no link and goes back on the list`, async () => {
      const oldFetch = globalThis.fetch;
      const r = await setup();
      try {
        assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now), { sent: 1, dropped: 0, waiting: 0 });
        const due = Number(redis.run(["ZSCORE", ASK_DUE_KEY, r.member]));
        assert.ok(due > r.now, "the reminder is on the list");
        const linksBefore = links();
        oddLinkWrite(r, reply, apply);
        const result = await sendReviewRequests(storeForHandle, Date.now() + 20000, due);
        redis.pipeline = r.original;
        assert.deepEqual(result, { sent: 0, dropped: 0, waiting: 1 });
        assert.equal(r.batches.length, 1, "no reminder email");
        assert.equal(links(), linksBefore, "no link left behind");
        assert.deepEqual(redis.run(["ZRANGEBYSCORE", ASK_DUE_KEY, due + 1, due + 3600]), [r.member], "back on the list, an hour later");
        assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, due + 3601), { sent: 1, dropped: 0, waiting: 0 });
        assert.equal(r.batches.length, 2, "then the reminder goes once");
      } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
    });
  }
}

test("a link write that throws for one order leaves the other orders of the run to be sent", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  const second = "cs_test_ReviewLinkSet02";
  const person2 = "review-person-two@example.test";
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === `/v1/checkout/sessions/${second}`) {
      const body = await (await inner(`https://api.stripe.com/v1/checkout/sessions/${reference}`)).json();
      const charge = { ...body.payment_intent.latest_charge, id: "ch_ReviewLinkSet02" };
      return Response.json({ ...body, id: second, customer_details: { email: person2 }, payment_intent: { ...body.payment_intent, id: "pi_ReviewLinkSet02", latest_charge: charge } });
    }
    return inner(input, init);
  }) as typeof fetch;
  try {
    assert.equal(await scheduleReviewAsk(r.shop, second, r.now - 8 * 86400), true);
    let thrown = 0;
    redis.pipeline = async (commands) => {
      if (thrown === 0 && commands[0]?.[0] === "SET" && String(commands[0][1]).startsWith(LINK)) {
        thrown += 1;
        throw new Error("Redis request failed with status 500");
      }
      return r.original(commands);
    };
    const result = await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now);
    redis.pipeline = r.original;
    assert.equal(thrown, 1, "one link write threw");
    assert.deepEqual(result, { sent: 1, dropped: 0, waiting: 1 }, "the other order is sent in the same run");
    assert.equal(sentTo(r.batches).length, 1);
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now + 3601), { sent: 1, dropped: 0, waiting: 0 });
    assert.deepEqual(sentTo(r.batches).sort(), [person, person2].sort(), "each order asked once");
    assert.equal(links(), 2, "each with its one link");
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});

test("control: Redis answers OK, the request goes once with a link that is stored", async () => {
  const oldFetch = globalThis.fetch;
  const r = await setup();
  try {
    assert.deepEqual(await sendReviewRequests(storeForHandle, Date.now() + 20000, r.now), { sent: 1, dropped: 0, waiting: 0 });
    assert.deepEqual(sentTo(r.batches), [person]);
    assert.equal(links(), 1);
  } finally { redis.pipeline = r.base; globalThis.fetch = oldFetch; }
});
