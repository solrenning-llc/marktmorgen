/**
 * The daily share job (lib/share-settle.ts) must find what a store sold under
 * every address it has had, not only the one it has now. A rename does not
 * rewrite the metadata Stripe keeps (renameHandle), so a membership sold
 * before a rename still says `metadata[store] = <old address>`, and a released
 * address leads nowhere by name (storeForHandle answers null for it).
 *
 * Until 9 November 2026:
 *   - keepMemberships (step 3) searched only the current address: a membership
 *     sold under a previous or released one kept the old percentage when the
 *     plan's share went down or ended, and the applied mark was written (or
 *     deleted) anyway, so it was never looked at again: the creator paid the
 *     old share on every renewal (audit of handles, finding 2).
 *   - owedOnFee found the store of a membership invoice by its address alone:
 *     for a released one it threw UnknownAmount, so the share of a refunded
 *     membership never came back and the account's reading never moved on
 *     (finding 4); the same for a recent invoice (step 1, rule 30 sibling).
 *
 * Each store has a connected account of its own (lib/stripe-connect.ts,
 * POST /v2/core/accounts), so on that account every address the store ever had
 * (saleHandles) is the store's. Real stores and settlement code; Stripe is a
 * stand-in (tests/stripe-subscription-search.ts), nothing real is reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { settleShares } from "@/lib/share-settle";
import { SHARING_INDEX } from "@/lib/platform-share";
import { claimHandle, releaseHandle, renameHandle, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { subscriptionSearchPage } from "./stripe-subscription-search";

const NOW = Math.floor(Date.now() / 1000);
const ACCOUNT = "acct_ShareHandles0001";
const OWNER = "share-handles@example.test";

type Member = { id: string; object: "subscription"; status: string; handle: string; metadata: { store: string }; application_fee_percent: number | null };
const member = (id: string, handle: string, percent: number | null = 15, status = "active"): Member =>
  ({ id, object: "subscription", status, handle, metadata: { store: handle }, application_fee_percent: percent });

type Fee = { id: string; account: string; charge: string; amount: number; amount_refunded: number; currency: string };
type World = {
  /** Addresses taken in turn: the first is claimed, each next one is a rename. */
  handles: string[];
  /** Previous addresses let go of, after the renames. */
  release?: string[];
  members?: Member[];
  applied?: string | null;
  /** A search for this address is refused by Stripe. */
  refuse?: string;
  /** A fee in the recent list (step 1), or found through a refund event (step 2). */
  recent?: Fee[];
  refunded?: Fee[];
  charges?: Map<string, unknown>;
  runs?: number;
};

async function world(w: World) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_share_handles_only_a_stand_in";
  assert.equal((await claimHandle(OWNER, w.handles[0], "Synthetic shop", "")).ok, true);
  for (const next of w.handles.slice(1)) {
    const renamed = await renameHandle(OWNER, next);
    assert.equal(renamed.ok, true, `rename to ${next}`);
    for (const old of w.release ?? []) if ((await storeForEmail(OWNER))!.previousHandles.includes(old)) assert.equal((await releaseHandle(OWNER, old)).ok, true);
  }
  assert.equal((await setStripeAccount(OWNER, ACCOUNT, true)).ok, true);
  const ref = storeRef((await storeForEmail(OWNER))!);
  await redis.pipeline([["SADD", SHARING_INDEX, ref]]);
  if (w.applied !== null) await redis.pipeline([["HSET", "nl:share:applied", ref, w.applied ?? "1500"]]);
  const members = w.members ?? [];
  const queries: string[] = [], refunds: { fee: string; amount: number }[] = [];
  let posts = 0, searches = 0, mostSearches = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.stripe.com");
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (method === "GET" && url.pathname === "/v1/application_fees") return Response.json({ object: "list", data: (w.recent ?? []).map((f) => ({ object: "application_fee", ...f })), has_more: false });
    if (method === "GET" && url.pathname.startsWith("/v1/application_fees/")) {
      const fee = [...(w.recent ?? []), ...(w.refunded ?? [])].find((f) => url.pathname === `/v1/application_fees/${f.id}`);
      return fee ? Response.json({ object: "application_fee", ...fee }) : Response.json({ error: { message: "No such fee" } }, { status: 404 });
    }
    if (method === "POST" && /^\/v1\/application_fees\/[^/]+\/refunds$/.test(url.pathname)) {
      const fee = url.pathname.split("/")[3], amount = Number(body.get("amount"));
      refunds.push({ fee, amount });
      return Response.json({ object: "fee_refund", id: `fr_ShareHandles${String(refunds.length).padStart(4, "0")}`, fee, amount, currency: "usd" });
    }
    if (method === "GET" && url.pathname === "/v1/events") {
      return Response.json({ object: "list", has_more: false, data: (w.refunded ?? []).map((f, i) => ({ id: `evt_ShareHandles${i}`, type: "charge.refunded", data: { object: { id: f.charge, application_fee: f.id } } })) });
    }
    if (method === "GET" && url.pathname.startsWith("/v1/charges/")) {
      const charge = w.charges?.get(url.pathname.split("/").pop()!);
      return charge ? Response.json(charge) : Response.json({ error: { message: "No such charge" } }, { status: 404 });
    }
    if (method === "GET" && url.pathname === "/v1/subscriptions/search") {
      searches += 1;
      const query = url.searchParams.get("query") ?? "";
      queries.push(query);
      if (w.refuse && query.includes(`'${w.refuse}'`)) return Response.json({ error: { message: "Synthetic refusal" } }, { status: 500 });
      const [reply, status] = subscriptionSearchPage(members, query, url.searchParams.get("page") ?? "", Number(url.searchParams.get("limit")), "cursor");
      return Response.json(reply, { status });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
      posts += 1;
      const sub = members.find((s) => s.id === url.pathname.split("/").pop());
      if (!sub) return Response.json({ error: { message: "No such subscription" } }, { status: 404 });
      sub.application_fee_percent = Number(body.get("application_fee_percent"));
      return Response.json(sub);
    }
    throw Error(`Unexpected synthetic request ${method} ${url.pathname}`);
  }) as typeof fetch;
  const runs: { complete: boolean; failed: number; unknownAmounts: number; applied: unknown; readUntil: unknown }[] = [];
  try {
    for (let run = 0; run < (w.runs ?? 1); run += 1) {
      searches = 0;
      const counts = await settleShares(Date.now() + 60_000, NOW, false);
      mostSearches = Math.max(mostSearches, searches);
      const [applied, readUntil] = await redis.pipeline([["HGET", "nl:share:applied", ref], ["HGET", "nl:share:read-until", ref]]);
      runs.push({ complete: counts.complete, failed: counts.failed, unknownAmounts: counts.unknownAmounts, applied, readUntil });
    }
  } finally { globalThis.fetch = oldFetch; }
  return { runs, queries, posts, refunds, mostSearches, members, store: (await storeForEmail(OWNER))! };
}

test("a membership sold under the previous address is lowered with the plan, and the store is done only after (proof A)", async () => {
  // Before: one search, for 'new-shop' only; 0 POST; the applied mark deleted; the old member paid 15% for good.
  const r = await world({ handles: ["old-shop", "new-shop"], members: [member("sub_OldMember01", "old-shop")] });
  assert.deepEqual(r.store.previousHandles, ["old-shop"]);
  assert.ok(r.queries.some((q) => q.startsWith("metadata['store']:'old-shop'")), "the previous address is searched");
  assert.equal(r.posts, 1);
  assert.equal(r.members[0].application_fee_percent, 0);
  assert.deepEqual(r.runs.map((x) => [x.complete, x.applied]), [[true, null]]);
});

test("a membership sold under a released address is lowered too, on the store's own account", async () => {
  const r = await world({ handles: ["first-shop", "second-shop"], release: ["first-shop"], members: [member("sub_Released01", "first-shop"), member("sub_Current01", "second-shop")] });
  assert.deepEqual([r.store.previousHandles, r.store.releasedHandles], [[], ["first-shop"]]);
  assert.deepEqual(r.members.map((m) => m.application_fee_percent), [0, 0]);
  assert.deepEqual(r.runs.map((x) => [x.complete, x.applied]), [[true, null]]);
});

test("the applied mark waits for every address: a refused search on an old one keeps it, and the next run finishes", async () => {
  // Before: the old address was never searched, so its refusal could not even be seen and the mark was deleted.
  const refused = await world({ handles: ["kept-shop", "later-shop"], refuse: "kept-shop", members: [member("sub_Kept0001", "kept-shop"), member("sub_Later0001", "later-shop")] });
  assert.deepEqual(refused.runs.map((x) => [x.complete, x.applied]), [[false, "1500"]]);
  const fine = await world({ handles: ["kept-shop", "later-shop"], members: [member("sub_Kept0001", "kept-shop"), member("sub_Later0001", "later-shop")], runs: 2 });
  assert.deepEqual(fine.runs.map((x) => [x.complete, x.applied]), [[true, null], [true, null]]);
  assert.equal(fine.posts, 2);
});

test("rule 24: at most 20 searches a store a run across all its addresses; past that, never said done", async () => {
  // 1 current + 9 previous + 15 released = 25 addresses, one search each: more than a run's 20.
  const names = Array.from({ length: 25 }, (_, i) => `many-shop-${String(i).padStart(2, "0")}`);
  const r = await world({ handles: names, release: names.slice(0, 15), runs: 2 });
  assert.equal(new Set([r.store.handle, ...r.store.previousHandles, ...r.store.releasedHandles]).size, 25);
  assert.equal(r.mostSearches, 20);
  assert.deepEqual(r.runs.map((x) => [x.complete, x.applied]), [[false, "1500"], [false, "1500"]]);
});

const membershipCharge = (id: string, handle: string, refunded: number) => ({
  object: "charge", id, currency: "usd", amount: 10_000, amount_refunded: refunded, disputed: false, payment_intent: null,
  invoice: { object: "invoice", id: `in_${id.slice(3)}`, charge: id, currency: "usd", created: NOW - 5 * 86_400, total_excluding_tax: 10_000, subscription_details: { metadata: { store: handle, share_bps: "1500" } } },
});

test("finding 4: the share of a refunded membership sold under a released address comes back, and the reading moves on", async () => {
  // Before: storeForHandle('gone-shop') is null, so UnknownAmount: no refund of the fee and read-until never written.
  const fee = { id: "fee_ShareHandles01", account: ACCOUNT, charge: "ch_ShareHandles01", amount: 1_500, amount_refunded: 0, currency: "usd" };
  const r = await world({ handles: ["gone-shop", "kept-name"], release: ["gone-shop"], applied: null, refunded: [fee], charges: new Map([[fee.charge, membershipCharge(fee.charge, "gone-shop", 10_000)]]) });
  assert.deepEqual(r.refunds, [{ fee: fee.id, amount: 1_500 }]);
  assert.deepEqual(r.runs.map((x) => [x.complete, x.failed, x.readUntil]), [[true, 0, String(NOW)]]);
});

test("finding 4, step 1: a recent membership payment under a released address gives back what is not owed", async () => {
  // The store has no plan now, so nothing is owed on the renewal; the fee written at 15% comes back in full.
  const fee = { id: "fee_ShareHandles02", account: ACCOUNT, charge: "ch_ShareHandles02", amount: 1_500, amount_refunded: 0, currency: "usd" };
  const r = await world({ handles: ["gone-again", "kept-again"], release: ["gone-again"], applied: null, recent: [fee], charges: new Map([[fee.charge, membershipCharge(fee.charge, "gone-again", 0)]]) });
  assert.deepEqual(r.refunds, [{ fee: fee.id, amount: 1_500 }]);
  assert.deepEqual(r.runs.map((x) => [x.complete, x.failed]), [[true, 0]]);
});

test("an address the account's store never had stays unknown: no money moves", async () => {
  const fee = { id: "fee_ShareHandles03", account: ACCOUNT, charge: "ch_ShareHandles03", amount: 1_500, amount_refunded: 0, currency: "usd" };
  const r = await world({ handles: ["mine-shop"], applied: null, recent: [fee], charges: new Map([[fee.charge, membershipCharge(fee.charge, "someone-else", 0)]]) });
  assert.deepEqual(r.refunds, []);
  assert.deepEqual(r.runs.map((x) => [x.complete, x.failed, x.unknownAmounts]), [[false, 1, 1]]);
});
