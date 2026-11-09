/** G2/C4 settlement regressions; real stores and settlement, synthetic IO only. */
import test from "node:test";
import assert from "node:assert/strict";
import { settleShares } from "@/lib/share-settle";
import { SHARING_INDEX } from "@/lib/platform-share";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const now = Math.floor(Date.now() / 1000), account = "acct_Receipt0001";
const oldMember = { id: "sub_OldShare0001", status: "active", application_fee_percent: 6.25 };
const noFeeMember = { id: "sub_NoShare0001", status: "active", application_fee_percent: null };
const page = (data: unknown[] = [], has_more = false, next_page: unknown = null) => ({ object: "search_result", data, has_more, next_page });
type Options = { reply?: unknown; pages?: (n: number) => unknown; applied?: unknown[]; appliedWrite?: unknown[]; live?: boolean; postFails?: boolean; postReply?: unknown; historyFailure?: "page" | "request" | "charge" | "marker" };
async function world(options: Options = {}) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_fee_refund_only_a_stand_in";
  const owner = "membership-evidence@example.test";
  assert.equal((await claimHandle(owner, "membership-evidence", "Synthetic shop", "")).ok, true);
  assert.equal((await setStripeAccount(owner, account, true)).ok, true);
  if (options.live) await setSubscription(owner, { customerId: "cus_ShareReview0001", subscriptionId: "sub_ShareReview0001", active: true, tier: "creator", cycle: "month", trialEnds: now - 10 * 86400, shared: true, period: paidPeriod() });
  const ref = storeRef((await storeForEmail(owner))!);
  await redis.pipeline([["SADD", SHARING_INDEX, ref], ["HSET", "nl:share:applied", ref, "625"]]);
  if (options.live) await redis.pipeline([["HDEL", "nl:share:applied", ref]]);
  const base = redis.pipeline.bind(redis), oldFetch = globalThis.fetch;
  const posts: { path: string; body: URLSearchParams }[] = [];
  let searches = 0;
  try {
    redis.pipeline = async commands => {
      if (options.historyFailure === "marker" && commands.length === 1 && commands[0][0] === "HSET" && commands[0][1] === "nl:share:read-until") return [null];
      if (commands.length === 1 && commands[0][1] === "nl:share:applied") {
        if (commands[0][0] === "HGET" && options.applied !== undefined) return options.applied;
        if ((commands[0][0] === "HSET" || commands[0][0] === "HDEL") && options.appliedWrite !== undefined) return options.appliedWrite;
      }
      return base(commands);
    };
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? "GET";
      assert.equal(url.origin, "https://api.stripe.com");
      if (url.pathname === "/v1/application_fees") return Response.json({ object: "list", data: [], has_more: false });
      if (url.pathname === "/v1/events") {
        if (options.historyFailure === "page") return Response.json({});
        if (options.historyFailure === "request") return Response.json({ error: { message: "Synthetic history refusal" } }, { status: 500 });
        return Response.json({ object: "list", data: options.historyFailure === "charge" ? [{ id: "evt_MemberHistory0001", data: { object: { charge: "ch_MemberHistory0001" } } }] : [], has_more: false });
      }
      if (url.pathname === "/v1/charges/ch_MemberHistory0001") return Response.json({ error: { message: "Synthetic charge refusal" } }, { status: 500 });
      if (url.pathname === "/v1/subscriptions/search") {
        searches += 1;
        return Response.json(options.pages ? options.pages(searches) : options.reply === undefined ? page() : options.reply);
      }
      if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
        posts.push({ path: url.pathname, body: new URLSearchParams(String(init?.body)) });
        return options.postFails ? Response.json({ error: { message: "Synthetic refusal" } }, { status: 500 }) : Response.json(Object.hasOwn(options, "postReply") ? options.postReply : { id: url.pathname.split("/").pop(), object: "subscription", application_fee_percent: Number(new URLSearchParams(String(init?.body)).get("application_fee_percent")) });
      }
      throw Error("Unexpected synthetic membership request");
    };
    const counts = await settleShares(Date.now() + 60000, now, options.live ?? false);
    const [applied, readUntil] = await base([["HGET", "nl:share:applied", ref], ["HGET", "nl:share:read-until", ref]]);
    return { counts, posts, applied, searches, readUntil };
  } finally { redis.pipeline = base; globalThis.fetch = oldFetch; }
}

test("C4: explicit null is known zero and does not block lowering another membership", async () => {
  const r = await world({ reply: page([noFeeMember, oldMember]) });
  assert.equal(r.counts.complete, true); assert.equal(r.counts.failed, 0); assert.equal(r.applied, null);
  assert.equal(r.posts.length, 1); assert.equal(r.posts[0].path, "/v1/subscriptions/" + oldMember.id);
  assert.equal(r.posts[0].body.get("application_fee_percent"), "0.00");
});
test("C4: explicit null may move to the existing live plan percentage", async () => {
  const r = await world({ live: true, reply: page([noFeeMember]) });
  assert.equal(r.counts.complete, true); assert.equal(r.counts.failed, 0); assert.equal(r.applied, "625");
  assert.equal(r.posts.length, 1); assert.equal(r.posts[0].body.get("application_fee_percent"), "6.25");
});
for (const written of [undefined, "0", -1, {}, [], 101]) test("unknown percentage cannot prevent a later valid adjustment: " + String(written), async () => {
  const r = await world({ reply: page([{ ...noFeeMember, application_fee_percent: written }, oldMember]) });
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.applied, "625");
  assert.equal(r.posts.length, 1); assert.equal(r.posts[0].path, "/v1/subscriptions/" + oldMember.id);
});
for (const [label, reply] of [
  ["missing envelope", {}], ["null data", { object: "search_result", data: null, has_more: false }],
  ["missing more", { object: "search_result", data: [] }], ["text more", { object: "search_result", data: [], has_more: "false" }],
  ["more without cursor", page([oldMember], true)], ["empty more", page([], true, "next")],
  ["malformed row after valid", page([oldMember, {}])], ["missing identity", page([{ status: "active", application_fee_percent: 6.25 }])],
  ["missing status", page([{ id: oldMember.id, application_fee_percent: 6.25 }])], ["duplicate identity", page([oldMember, oldMember])],
] as const) test("unconfirmed subscription page preserves applied and authorizes no POST: " + label, async () => {
  const r = await world({ reply });
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.counts.listUnknown, 1);
  assert.equal(r.applied, "625"); assert.equal(r.posts.length, 0);
});
for (const applied of [[], [undefined], [""], ["-1"], ["1.5"], ["10001"], [0], ["625", "0"]]) test("unconfirmed applied marker must not turn into a synchronized target: " + JSON.stringify(applied), async () => {
  const r = await world({ applied });
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.counts.listUnknown, 1);
  assert.equal(r.applied, "625"); assert.equal(r.searches, 0); assert.equal(r.posts.length, 0);
});
test("G2: confirmed empty search may clear the previous applied percentage", async () => {
  const r = await world(); assert.equal(r.counts.complete, true); assert.equal(r.applied, null); assert.equal(r.posts.length, 0);
});
test("confirmed two-page search lowers the percentage; applied waits for a pass that changes none", async () => {
  const r = await world({ pages: n => n === 1 ? page([oldMember], true, "next") : page() });
  // Rule 23: was complete true and applied null on this one run. The search now leaves out ended memberships, so a
  // member who ends mid-pass can cut a later page short; a pass of several pages that changed a percentage is
  // confirmed by the next run's pass changing none (tests/share-membership-search.test.ts runs both).
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 0); assert.equal(r.searches, 2); assert.equal(r.applied, "625"); assert.equal(r.posts.length, 1);
});
test("repeated search cursor never certifies applied", async () => {
  const r = await world({ pages: () => page([noFeeMember], true, "same") });
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.applied, "625"); assert.equal(r.searches, 2); assert.equal(r.posts.length, 0);
});
test("unfinished twentieth search page retains applied", async () => {
  const r = await world({ pages: n => page([{ ...noFeeMember, id: "sub_ZeroShare" + n }], true, "page" + n) });
  assert.equal(r.counts.complete, false); assert.equal(r.searches, 20); assert.equal(r.applied, "625"); assert.equal(r.posts.length, 0);
});
test("canceled memberships need no percentage update", async () => {
  const r = await world({ reply: page([{ id: oldMember.id, status: "canceled" }]) });
  assert.equal(r.counts.complete, true); assert.equal(r.applied, null); assert.equal(r.posts.length, 0);
});
for (const postReply of [{}, null, [], { id: oldMember.id, object: "subscription" }, { id: "sub_Another0001", object: "subscription", application_fee_percent: 0 }, { id: oldMember.id, object: "other", application_fee_percent: 0 }, { id: oldMember.id, object: "subscription", application_fee_percent: "0" }, { id: oldMember.id, object: "subscription", application_fee_percent: 6.25 }]) test("an unconfirmed percentage POST never certifies the applied marker: " + JSON.stringify(postReply), async () => {
  const r = await world({ reply: page([oldMember]), postReply });
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.counts.memberships, 0);
  assert.equal(r.applied, "625"); assert.equal(r.posts.length, 1, "unknown writes are not retried");
});
for (const appliedWrite of [[], [undefined], [null], ["OK"], [2], [1, 0]]) test("an unconfirmed applied-marker write cannot be reported complete: " + JSON.stringify(appliedWrite), async () => {
  const r = await world({ appliedWrite });
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.counts.listUnknown, 1); assert.equal(r.applied, "625");
});
for (const appliedWrite of [[], [undefined], [null], ["OK"], [2], [1, 0]]) test("an unconfirmed live applied-marker write remains unknown: " + JSON.stringify(appliedWrite), async () => {
  const r = await world({ live: true, reply: page([noFeeMember]), appliedWrite });
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.counts.listUnknown, 1); assert.equal(r.applied, null);
});
test("an explicit null percentage in the confirmed subscription reply is known zero", async () => {
  const r = await world({ reply: page([oldMember]), postReply: { id: oldMember.id, object: "subscription", application_fee_percent: null } });
  assert.equal(r.counts.complete, true); assert.equal(r.counts.failed, 0); assert.equal(r.counts.memberships, 1); assert.equal(r.applied, null);
});
for (const historyFailure of ["page", "request", "charge", "marker"] as const) test("unknown historical work does not block an independently confirmed membership reduction: " + historyFailure, async () => {
  const r = await world({ historyFailure, reply: page([oldMember]) });
  assert.equal(r.posts.length, 1); assert.equal(r.posts[0].body.get("application_fee_percent"), "0.00");
  assert.equal(r.counts.memberships, 1); assert.equal(r.applied, null);
  assert.equal(r.counts.complete, false); assert.equal(r.counts.failed, 1); assert.equal(r.readUntil, null);
});
