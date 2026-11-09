/**
 * A store that starts paying a share and stops before the daily share job
 * (lib/share-settle.ts) first runs must still have the memberships it sold
 * in between brought to its plan's percentage.
 *
 * A membership is set up at the checkout with the plan's percentage
 * (planShareBps) and keeps it on every renewal until the job changes it. The
 * job looks only at the stores in the sharing list and those with an applied
 * mark (nl:share:applied), and it writes that mark only after it has read the
 * memberships. Until 9 November 2026, a store that stopped sharing before the
 * job's first run (its plan ended, it turned the share off, or it moved to a
 * plan whose share is 0) left the list with no mark; and one still on the
 * list with a share of 0 and no mark was passed over (applied null, target 0).
 * Either way its memberships were never read again: the creator paid the old
 * share on every renewal. The same for a store that moved back to a smaller
 * share already confirmed: the mark said the smaller one, and the memberships
 * sold at the larger one in between were never read.
 *
 * Real stores and settlement code; Stripe is a stand-in
 * (tests/stripe-subscription-search.ts), nothing real is reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { settleShares } from "@/lib/share-settle";
import { SHARING_INDEX } from "@/lib/platform-share";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail, storeRef } from "@/lib/store";
import type { Tier } from "@/lib/plan";
import { store as redis } from "./redis-stub";
import { subscriptionSearchPage } from "./stripe-subscription-search";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const ACCOUNT = "acct_ShareStopEarly01";
const OWNER = "share-stop-early@example.test";
const HANDLE = "stop-early-shop";
/** The job runs as it would with the commission live (the constant is false today). */
const LIVE = true;

type Member = { id: string; object: "subscription"; status: string; handle: string; metadata: { store: string }; application_fee_percent: number | null };
const member = (id: string, percent: number | null, status = "active"): Member =>
  ({ id, object: "subscription", status, handle: HANDLE, metadata: { store: HANDLE }, application_fee_percent: percent });

const plan = (tier: Tier, shared: boolean, active = true) => ({
  customerId: "cus_ShareStopEarly1", subscriptionId: "sub_ShareStopEarlyPlan", active, tier, cycle: "month" as const,
  trialEnds: NOW - 10 * 86_400, shared, period: active ? paidPeriod() : null,
});

async function opened(): Promise<string> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_share_stop_early_only_a_stand_in";
  assert.equal((await claimHandle(OWNER, HANDLE, "Synthetic shop", "")).ok, true);
  assert.equal((await setStripeAccount(OWNER, ACCOUNT, true)).ok, true);
  return storeRef((await storeForEmail(OWNER))!);
}

type Run = { complete: boolean; failed: number; searches: number; posts: number; applied: unknown; listed: unknown };

/** Runs the job `runs` times against `members`; `refusePosts` refuses every update on the first run. */
async function jobs(ref: string, members: Member[], runs: number, refusePosts = false): Promise<Run[]> {
  const out: Run[] = [];
  let searches = 0, posts = 0, run = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.stripe.com");
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (method === "GET" && url.pathname === "/v1/application_fees") return Response.json({ object: "list", data: [], has_more: false });
    if (method === "GET" && url.pathname === "/v1/events") return Response.json({ object: "list", data: [], has_more: false });
    if (method === "GET" && url.pathname === "/v1/subscriptions/search") {
      searches += 1;
      const [reply, status] = subscriptionSearchPage(members, url.searchParams.get("query") ?? "", url.searchParams.get("page") ?? "", Number(url.searchParams.get("limit")), "cursor");
      return Response.json(reply, { status });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
      posts += 1;
      if (refusePosts && run === 0) return Response.json({ error: { message: "Synthetic refusal" } }, { status: 500 });
      const sub = members.find((s) => s.id === url.pathname.split("/").pop());
      if (!sub) return Response.json({ error: { message: "No such subscription" } }, { status: 404 });
      sub.application_fee_percent = Number(body.get("application_fee_percent"));
      return Response.json(sub);
    }
    throw Error(`Unexpected synthetic request ${method} ${url.pathname}`);
  }) as typeof fetch;
  try {
    for (run = 0; run < runs; run += 1) {
      searches = 0; posts = 0;
      const counts = await settleShares(Date.now() + 60_000, NOW, LIVE);
      const [applied, listed] = await redis.pipeline([["HGET", "nl:share:applied", ref], ["SISMEMBER", SHARING_INDEX, ref]]);
      out.push({ complete: counts.complete, failed: counts.failed, searches, posts, applied, listed });
    }
  } finally { globalThis.fetch = oldFetch; }
  return out;
}

const shape = (runs: Run[]) => runs.map((r) => [r.complete, r.failed, r.searches, r.posts, r.applied, r.listed]);

test("a plan that ends before the job's first run: the memberships sold under it stop paying the share, then the mark goes", async () => {
  // Before: the store left the list with no mark; 0 searches, 0 POST, and the member paid 6.25% for good.
  const ref = await opened();
  await setSubscription(OWNER, plan("creator", true));
  const members = [member("sub_StopEarlyEnd01", 6.25), member("sub_StopEarlyEnd02", 6.25, "past_due")];
  await setSubscription(OWNER, plan("creator", true, false));
  const runs = await jobs(ref, members, 2);
  assert.deepEqual(members.map((m) => m.application_fee_percent), [0, 0]);
  // One search changes both; the second run has no mark and the store is off the list: nothing is read again.
  assert.deepEqual(shape(runs), [[true, 0, 1, 2, null, 0], [true, 0, 0, 0, null, 0]]);
});

test("a share turned off before the job's first run, the plan still running: the same", async () => {
  const ref = await opened();
  await setSubscription(OWNER, plan("pro", true));
  const members = [member("sub_StopEarlyOff01", 2.75)];
  await setSubscription(OWNER, plan("pro", false));
  const runs = await jobs(ref, members, 2);
  assert.equal(members[0].application_fee_percent, 0);
  assert.deepEqual(shape(runs), [[true, 0, 1, 1, null, 0], [true, 0, 0, 0, null, 0]]);
});

test("a move to a plan whose share is 0 before the job's first run: the store stays on the list, its memberships are still lowered", async () => {
  // Before: on the list with no mark and a target of 0, the job passed it over (applied null, target 0).
  const ref = await opened();
  await setSubscription(OWNER, plan("creator", true));
  const members = [member("sub_StopEarlyScale1", 6.25)];
  await setSubscription(OWNER, plan("scale", true));
  const runs = await jobs(ref, members, 2);
  assert.equal(members[0].application_fee_percent, 0);
  assert.deepEqual(shape(runs), [[true, 0, 1, 1, null, 1], [true, 0, 0, 0, null, 1]]);
});

test("back to a smaller share already confirmed, before the job read the larger one: what was sold at the larger one is lowered", async () => {
  // Before: the mark said 275 (confirmed under Studio), the target was 275 again, and the member sold under Store kept 6.25%.
  const ref = await opened();
  await setSubscription(OWNER, plan("pro", true));
  const studio = [member("sub_StopEarlyBack01", 2.75)];
  assert.deepEqual(shape(await jobs(ref, studio, 1)), [[true, 0, 1, 0, "275", 1]]);
  await setSubscription(OWNER, plan("creator", true));
  const members = [...studio, member("sub_StopEarlyBack02", 6.25)];
  await setSubscription(OWNER, plan("pro", true));
  const runs = await jobs(ref, members, 2);
  assert.deepEqual(members.map((m) => m.application_fee_percent), [2.75, 2.75]);
  assert.deepEqual(shape(runs), [[true, 0, 1, 1, "275", 1], [true, 0, 0, 0, "275", 1]]);
});

test("an update Stripe refuses keeps the mark, so the next run tries again; only then the mark goes", async () => {
  const ref = await opened();
  await setSubscription(OWNER, plan("creator", true));
  const members = [member("sub_StopEarlyRetry1", 6.25)];
  await setSubscription(OWNER, plan("creator", true, false));
  const runs = await jobs(ref, members, 3, true);
  assert.equal(members[0].application_fee_percent, 0);
  assert.deepEqual(shape(runs), [[false, 1, 1, 1, "625", 0], [true, 0, 1, 1, null, 0], [true, 0, 0, 0, null, 0]]);
});

test("a store that never paid a share is never searched (rule 24)", async () => {
  const ref = await opened();
  await setSubscription(OWNER, plan("creator", false));
  await setSubscription(OWNER, plan("creator", false, false));
  const runs = await jobs(ref, [member("sub_StopEarlyNever1", 0)], 1);
  assert.deepEqual(shape(runs), [[true, 0, 0, 0, null, 0]]);
});
