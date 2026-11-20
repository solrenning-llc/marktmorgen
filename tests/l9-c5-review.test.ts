/**
 * Claude 5's second review of #2722 (lot L9, CX-123 rule 24), held as tests. Synthetic only: Redis is the stand-in,
 * Stripe and the sender are stand-ins, nothing real is reached.
 *
 *   A. An invite credit's claim answered oddly (SET NX landed, answered "QUEUED") whose read back loses the
 *      connection once is unknown: the run is not complete, and the invited creator's welcome bonus is still written
 *      and paid, once, on a later run; the inviter's share is paid once.
 *   B. A credit sent to Stripe whose "done" write failed is never sent again on an unreadable balance history: the
 *      history read whole or the store fails, before any POST.
 *   C. A one-time email whose claim is unknown is retried later, never lost for good, and never sent twice:
 *      the yearly offer at a store's first sale, and a review request.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { inviteCode, recordInvite, creditKey } from "@/lib/creator-invites";
import { settleInvites } from "@/lib/creator-invite-credit";
import { INVITE_HOLD_DAYS } from "@/lib/creator-invite-rules";
import { noteFirstSale, firstSaleAt } from "@/lib/yearly-offer";
import { sendReviewRequests } from "@/lib/review-requests";
import { ASK_DUE_KEY, askMember, scheduleReviewAsk } from "@/lib/review-ask";
import { addProduct, ensureListId, ensureStatsId, setMailSettings, setProductLink, setReviewAsk, storeForHandle } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipe = typeof redis.pipeline;
const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const errors = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = errors;
  }
};

/**
 * The first SET on `key` lands but is answered ["QUEUED"]; the next GET of `key` (claimMark's read back) loses the
 * connection once. Everything else is the stand-in's own answer.
 */
function oddClaim(real: Pipe, key: string): Pipe {
  let setDone = false;
  let getDone = false;
  return (async (commands: (string | number)[][]) => {
    if (!setDone && commands.length === 1 && commands[0][0] === "SET" && commands[0][1] === key) {
      setDone = true;
      await real(commands);
      return ["QUEUED"];
    }
    if (setDone && !getDone && commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === key) {
      getDone = true;
      throw new Error("redis: connection reset");
    }
    return real(commands);
  }) as Pipe;
}

// ---------------------------------------------------------------- invite credits (A, B)

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 16, 12);
const nowS = Math.floor(NOW / 1000);
const PAST = INVITE_HOLD_DAYS + 4;
const INVITED = PAST + 20;

type Txn = { id: string; amount: number; metadata: Record<string, string> };

async function inviteWorld(history: (customer: string, rows: Txn[]) => unknown) {
  redis.clear();
  const balance = new Map<string, Txn[]>();
  const invoices = new Map<string, Record<string, unknown>[]>();
  process.env.STRIPE_SECRET_KEY = "sk_test_invites_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const path = url.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && path === "/invoices") return answer({ object: "list", data: invoices.get(url.searchParams.get("customer") ?? "") ?? [], has_more: false });
    if (method === "GET" && path === "/refunds") return answer({ object: "list", data: [], has_more: false });
    const txns = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)\/balance_transactions$/);
    if (txns && method === "GET") return answer(history(txns[1], [...(balance.get(txns[1]) ?? [])].reverse()));
    if (txns && method === "POST") {
      // No idempotency kept: the same as a POST more than 24 hours after the first.
      const form = new URLSearchParams(String(init?.body ?? ""));
      const row: Txn = {
        id: `cbtxn_${Math.random().toString(36).slice(2, 10)}`,
        amount: Number(form.get("amount")),
        metadata: { nimbus_invite_credit: form.get("metadata[nimbus_invite_credit]") ?? "" },
      };
      balance.set(txns[1], [...(balance.get(txns[1]) ?? []), row]);
      return answer(row);
    }
    const customer = path.match(/^\/customers\/(cus_[A-Za-z0-9]+)$/);
    if (customer && method === "GET") return answer({ id: customer[1], object: "customer", balance: 0, currency: "usd" });
    return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
  }) as typeof fetch;
  const made = async (email: string, handle: string) => {
    const r = await claimHandle(email, handle, handle, "");
    if (!r.ok) throw new Error(`no store for ${handle}`);
    return r.store;
  };
  const ana = await made("ana@example.com", "ana");
  const bea = await made("bea@example.com", "bea");
  const code = await inviteCode(ana.sid);
  if (!code || (await recordInvite(bea, code, NOW - INVITED * DAY * 1000)) !== "recorded") throw new Error("no invite");
  await setSubscription("ana@example.com", { customerId: "cus_Ana0001", subscriptionId: "sub_Ana0001", active: true, period: paidPeriod() });
  await setSubscription("bea@example.com", { customerId: "cus_Bea0001", subscriptionId: "sub_Bea0001", active: true, period: paidPeriod() });
  invoices.set("cus_Bea0001", [{
    id: "in_BeaFirst01", object: "invoice", status: "paid", amount_paid: 2900, post_payment_credit_notes_amount: 0, currency: "usd",
    created: nowS - PAST * DAY, status_transitions: { paid_at: nowS - PAST * DAY },
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_x" } },
    payments: { object: "list", data: [{ payment: { type: "payment_intent", payment_intent: "pi_bea_first" } }], has_more: false },
  }]);
  const amounts = (customer: string) => (balance.get(customer) ?? []).map((t) => t.amount);
  return { ana, bea, balance, amounts };
}

const wholeHistory = (_: string, rows: Txn[]) => ({ object: "list", data: rows, has_more: false });

test("A: an unknown claim on an invite credit is not a complete run, and the bonus is still paid, once", async () => {
  const oldFetch = globalThis.fetch;
  const w = await inviteWorld(wholeHistory);
  const real = redis.pipeline.bind(redis);
  try {
    redis.pipeline = oddClaim(real, creditKey("in_BeaFirst01"));
    const bad = await quiet(() => settleInvites(Date.now() + 60_000, NOW));
    redis.pipeline = real;
    assert.equal(bad.complete, false, "an unknown claim is not a complete pass");
    assert.equal(bad.failed >= 1, true, "the store counts as failed");
    for (let round = 0; round < 3; round += 1) await settleInvites(Date.now() + 60_000, NOW);
    assert.deepEqual(
      [redis.run(["EXISTS", creditKey(`bonus_${w.bea.sid}`)]), w.amounts("cus_Bea0001").length],
      [1, 1],
      "Bea's welcome bonus is written and reaches her plan once",
    );
    assert.deepEqual(w.amounts("cus_Ana0001"), [-1450], "Ana's half of Bea's first payment, once");
  } finally {
    redis.pipeline = real;
    globalThis.fetch = oldFetch;
  }
});

test("B: an unreadable balance history after a failed done write never sends the credit again", async () => {
  const oldFetch = globalThis.fetch;
  let broken = false;
  const w = await inviteWorld((customer, rows) => (broken && customer === "cus_Ana0001" ? { object: "list" } : { object: "list", data: rows, has_more: false }));
  const real = redis.pipeline.bind(redis);
  try {
    // The first run sends Ana's credit to Stripe, then its "done" write fails: the credit stays owed.
    let failedDone = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!failedDone && commands.some((c) => c[0] === "SET" && c[1] === creditKey("in_BeaFirst01") && String(c[2]).includes('"done"'))) {
        failedDone = true;
        throw new Error("redis: connection reset");
      }
      return real(commands);
    }) as Pipe;
    await quiet(() => settleInvites(Date.now() + 60_000, NOW));
    redis.pipeline = real;
    assert.deepEqual([failedDone, w.amounts("cus_Ana0001")], [true, [-1450]]);
    // More than a day later: Stripe's key has run out, and the history answers without its rows.
    broken = true;
    const unread = await quiet(() => settleInvites(Date.now() + 60_000, NOW));
    assert.deepEqual(w.amounts("cus_Ana0001"), [-1450], "never sent twice");
    assert.equal(unread.complete, false, "an unreadable history is not a complete pass");
    broken = false;
    await settleInvites(Date.now() + 60_000, NOW);
    assert.deepEqual(w.amounts("cus_Ana0001"), [-1450], "a whole history finds it, and nothing more is sent");
  } finally {
    redis.pipeline = real;
    globalThis.fetch = oldFetch;
  }
});

test("B: a history still going on after the last page read is unknown, not 'not sent'", async () => {
  const oldFetch = globalThis.fetch;
  let endless = false;
  let page = 0;
  const w = await inviteWorld((customer, rows) => {
    if (!endless || customer !== "cus_Ana0001") return { object: "list", data: rows, has_more: false };
    page += 1;
    return { object: "list", data: [{ id: `cbtxn_other${String(page).padStart(4, "0")}`, amount: -1, metadata: {} }], has_more: true };
  });
  const real = redis.pipeline.bind(redis);
  try {
    let failedDone = false;
    redis.pipeline = (async (commands: (string | number)[][]) => {
      if (!failedDone && commands.some((c) => c[0] === "SET" && c[1] === creditKey("in_BeaFirst01") && String(c[2]).includes('"done"'))) {
        failedDone = true;
        throw new Error("redis: connection reset");
      }
      return real(commands);
    }) as Pipe;
    await quiet(() => settleInvites(Date.now() + 60_000, NOW));
    redis.pipeline = real;
    endless = true;
    const cut = await quiet(() => settleInvites(Date.now() + 60_000, NOW));
    assert.deepEqual([w.amounts("cus_Ana0001"), cut.complete], [[-1450], false]);
  } finally {
    redis.pipeline = real;
    globalThis.fetch = oldFetch;
  }
});

test("B: a history row without a string id, or with an odd credit mark, is unknown", async () => {
  for (const odd of [{ amount: -1, metadata: {} }, { id: "cbtxn_odd00001", amount: -1, metadata: { nimbus_invite_credit: 5 } }, { id: "cbtxn_odd00002", amount: -1 }]) {
    const oldFetch = globalThis.fetch;
    let broken = false;
    const w = await inviteWorld((customer, rows) => (broken && customer === "cus_Ana0001" ? { object: "list", data: [...rows, odd], has_more: false } : { object: "list", data: rows, has_more: false }));
    const real = redis.pipeline.bind(redis);
    try {
      let failedDone = false;
      redis.pipeline = (async (commands: (string | number)[][]) => {
        if (!failedDone && commands.some((c) => c[0] === "SET" && c[1] === creditKey("in_BeaFirst01") && String(c[2]).includes('"done"'))) {
          failedDone = true;
          throw new Error("redis: connection reset");
        }
        return real(commands);
      }) as Pipe;
      await quiet(() => settleInvites(Date.now() + 60_000, NOW));
      redis.pipeline = real;
      broken = true;
      const run = await quiet(() => settleInvites(Date.now() + 60_000, NOW));
      assert.deepEqual([w.amounts("cus_Ana0001"), run.complete], [[-1450], false], JSON.stringify(odd));
    } finally {
      redis.pipeline = real;
      globalThis.fetch = oldFetch;
    }
  }
});

// ---------------------------------------------------------------- yearly offer at the first sale (C)

const YEAR_NOW = 1_791_700_000;

test("C: an unknown first-sale claim is retried later, and the yearly offer goes out exactly once", async () => {
  const oldFetch = globalThis.fetch;
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_yearly_offer_only";
  process.env.RESEND_API_KEY = "re_test_yearly_offer_only";
  const emails: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com") {
      if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
      if (url.pathname === "/v1/subscriptions/sub_c5yearly0001") {
        return new Response(JSON.stringify({
          id: "sub_c5yearly0001", status: "active", cancel_at: null, cancel_at_period_end: false,
          items: { data: [{ current_period_end: YEAR_NOW + 20 * 86_400, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "no such" } }), { status: 404 });
    }
    if (url.hostname === "api.resend.com") {
      emails.push(String(JSON.parse(String(init?.body ?? "{}")).subject));
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }
    throw new Error("No real provider call allowed");
  }) as typeof fetch;
  const real = redis.pipeline.bind(redis);
  try {
    await claimHandle("c5-yearly@example.com", "cfiveyearly", "A store", "");
    await setStripeAccount("c5-yearly@example.com", "acct_1TestYearly0001");
    await setSubscription("c5-yearly@example.com", { subscriptionId: "sub_c5yearly0001", active: true, tier: "creator", cycle: "month" });
    const store = (await storeForEmail("c5-yearly@example.com"))!;
    const rows = [{ created: YEAR_NOW, amount_total: 1900, payment_status: "paid", metadata: { store: store.handle } }];
    redis.pipeline = oddClaim(real, `nl:firstsale:${store.sid || `h:${store.handle}`}`);
    await quiet(() => noteFirstSale(store, rows, true));
    redis.pipeline = real;
    assert.equal(emails.length, 0, "nothing sent on an unknown claim");
    for (let round = 0; round < 3; round += 1) await noteFirstSale(store, rows, true);
    assert.equal(emails.length, 1, "the yearly offer goes out exactly once over the rounds");
    assert.equal(await firstSaleAt(store), YEAR_NOW, "the first sale's day is noted, in seconds");
  } finally {
    redis.pipeline = real;
    globalThis.fetch = oldFetch;
  }
});

test("C: an unknown once-per-subscription claim is retried at the next pass, once", async () => {
  const oldFetch = globalThis.fetch;
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_yearly_offer_only";
  process.env.RESEND_API_KEY = "re_test_yearly_offer_only";
  const emails: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.stripe.com") {
      if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ data: [], has_more: false }), { status: 200 });
      if (url.pathname === "/v1/subscriptions/sub_c5yearly0002") {
        return new Response(JSON.stringify({
          id: "sub_c5yearly0002", status: "active", cancel_at: null, cancel_at_period_end: false,
          items: { data: [{ current_period_end: YEAR_NOW + 20 * 86_400, price: { lookup_key: "nimbus_labs_creator_month", unit_amount: 2900, recurring: { interval: "month" } } }] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: "no such" } }), { status: 404 });
    }
    if (url.hostname === "api.resend.com") {
      emails.push(String(JSON.parse(String(init?.body ?? "{}")).subject));
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }
    throw new Error("No real provider call allowed");
  }) as typeof fetch;
  const real = redis.pipeline.bind(redis);
  try {
    await claimHandle("c5-offer@example.com", "cfiveoffer", "A store", "");
    await setStripeAccount("c5-offer@example.com", "acct_1TestYearly0002");
    await setSubscription("c5-offer@example.com", { subscriptionId: "sub_c5yearly0002", active: true, tier: "creator", cycle: "month" });
    const store = (await storeForEmail("c5-offer@example.com"))!;
    const rows = [{ created: YEAR_NOW, amount_total: 1900, payment_status: "paid", metadata: { store: store.handle } }];
    redis.pipeline = oddClaim(real, "nl:yearly-offer:sub_c5yearly0002");
    await quiet(() => noteFirstSale(store, rows, true));
    redis.pipeline = real;
    assert.equal(emails.length, 0, "nothing sent on an unknown claim");
    for (let round = 0; round < 3; round += 1) await noteFirstSale(store, rows, true);
    assert.equal(emails.length, 1, "the yearly offer goes out exactly once over the rounds");
  } finally {
    redis.pipeline = real;
    globalThis.fetch = oldFetch;
  }
});

// ---------------------------------------------------------------- review request (C)

test("C: an unknown review-request claim is retried later, and the request is sent exactly once", async () => {
  const oldFetch = globalThis.fetch;
  redis.clear();
  const owner = "c5-review-owner@example.test";
  const person = "c5-review-person@example.test";
  const reference = "cs_test_C5ReviewProof01";
  const batches: unknown[][] = [];
  let productId = "";
  const now = Math.floor(Date.now() / 1000);
  const paidAt = now - 8 * 86400;
  process.env.STRIPE_SECRET_KEY = "sk_test_reviews_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      batches.push(batch);
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    if (url.pathname === `/v1/checkout/sessions/${reference}`) return Response.json({
      id: reference, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
      created: paidAt, amount_total: 2700, currency: "usd", customer_details: { email: person },
      metadata: { store: "cfivereview", product: productId },
      payment_intent: { id: "pi_C5ReviewProof1", status: "succeeded", latest_charge: { id: "ch_C5ReviewProof1", amount: 2700, amount_refunded: 0, disputed: false, refunded: false } },
    });
    return Response.json({ object: "list", data: [], has_more: false });
  }) as typeof fetch;
  const base = redis.pipeline.bind(redis);
  try {
    await claimHandle(owner, "cfivereview", "Review Proof", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setStripeAccount(owner, "acct_1TestHarbor0001", true);
    await setSubscription(owner, { customerId: "cus_C5ReviewProof", subscriptionId: "sub_C5ReviewProof", active: true, tier: "pro", period: paidPeriod() });
    await setMailSettings(owner, { fromName: "Review Proof", address: "1 Example St, Example City" });
    await setReviewAsk(owner, { days: 7 });
    const made = await addProduct(owner, "Review evidence", "", "27", null);
    assert.ok(made.ok);
    productId = made.product.id;
    await setProductLink(owner, productId, "https://example.com/review");
    const shop = (await storeForEmail(owner))!;
    assert.equal(await scheduleReviewAsk(shop, reference, paidAt), true);
    const member = askMember({ statsId: shop.statsId!, handle: shop.handle, reference, paidAt });
    // MemoryRedis lacks ZADD XX: the same stand-in for native Redis 7.4.2 as tests/l9-review-request-exact.test.ts.
    const original: Pipe = async (commands) => {
      if (!commands.some((c) => c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX")) return base(commands);
      const replies: unknown[] = [];
      for (const c of commands) {
        if (c[0] === "ZADD" && c[1] === ASK_DUE_KEY && c[2] === "XX" && c.length === 5) {
          if (redis.run(["ZSCORE", ASK_DUE_KEY, c[4]]) !== null) redis.run(["ZADD", ASK_DUE_KEY, c[3], c[4]]);
          replies.push(0);
        } else replies.push(...(await base([c])));
      }
      return replies;
    };
    redis.pipeline = oddClaim(original, `nl:rev:ask:sent:${reference}`);
    const counts = [];
    counts.push(await quiet(() => sendReviewRequests(storeForHandle, Date.now() + 20000, now)));
    redis.pipeline = original;
    assert.equal(batches.flat().length, 0, "nothing sent on an unknown claim");
    assert.equal(redis.run(["ZSCORE", ASK_DUE_KEY, member]) !== null, true, "the order is still due, not dropped");
    for (let round = 1; round < 4; round += 1) counts.push(await sendReviewRequests(storeForHandle, Date.now() + 20000, now + round));
    assert.equal(batches.flat().length, 1, `exactly one request over four rounds: ${JSON.stringify(counts)}`);
  } finally {
    redis.pipeline = base;
    globalThis.fetch = oldFetch;
  }
});
