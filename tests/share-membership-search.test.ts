/**
 * Step 3 of the daily share job (lib/share-settle.ts, keepMemberships) keeps
 * every membership a store sold at its plan's percentage. Its search asked
 * for every subscription the store ever sold, ended ones included, read at
 * most 20 pages a run and started again from the first page on every run: a
 * store with 2,000 or more ended memberships never reached the live ones past
 * them, so after a move to a smaller share (or none) they went on paying the
 * old one, and every run spent 20 searches on the same ended pages (the same
 * defect as stopRenewals, #3332, rule 30).
 *
 * The search now leaves out canceled and incomplete_expired. A member who
 * ends mid-pass then leaves the search, and a page cut by an offset may skip
 * a live one; so a pass of several pages that changed a percentage is not
 * taken for the last, and the store's applied mark is written only on a pass
 * of one page or a pass that changed none.
 *
 * Real stores and settlement code; Stripe is a stand-in
 * (tests/stripe-subscription-search.ts), nothing real is reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { settleShares } from "@/lib/share-settle";
import { SHARING_INDEX } from "@/lib/platform-share";
import { claimHandle, setStripeAccount, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { subscriptionSearchPage, type SearchPaging } from "./stripe-subscription-search";

const NOW = Math.floor(Date.now() / 1000);
const ACCOUNT = "acct_MemberSearch0001";
const OWNER = "membership-search@example.test";
const HANDLE = "membership-search";

type Member = { id: string; object: "subscription"; status: string; handle: string; metadata: { store: string }; application_fee_percent: number | null };
const many = (count: number, status: string, tag: string, percent: number | null = 6.25): Member[] =>
  Array.from({ length: count }, (_, i) => ({ id: `sub_${tag}${String(i).padStart(5, "0")}`, object: "subscription", status, handle: HANDLE, metadata: { store: HANDLE }, application_fee_percent: percent }));
const live = (s: Member) => !["canceled", "incomplete_expired"].includes(s.status);

/**
 * A store with no plan any more (its share is 0) whose memberships were last
 * set to 6.25%, run day after day over `subs` until a run writes its applied
 * mark or `most` have run. `during(search, run)` may change `subs` before a
 * search is answered (a member ending mid-pass).
 */
async function days(subs: Member[], paging: SearchPaging, most: number, during?: (search: number, run: number) => void) {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_membership_search_only_a_stand_in";
  assert.equal((await claimHandle(OWNER, HANDLE, "Synthetic shop", "")).ok, true);
  assert.equal((await setStripeAccount(OWNER, ACCOUNT, true)).ok, true);
  const ref = storeRef((await storeForEmail(OWNER))!);
  await redis.pipeline([["SADD", SHARING_INDEX, ref], ["HSET", "nl:share:applied", ref, "625"]]);
  const oldFetch = globalThis.fetch;
  let searches = 0, run = 0, posts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input)), method = init?.method ?? "GET";
    assert.equal(url.origin, "https://api.stripe.com");
    if (url.pathname === "/v1/application_fees" || url.pathname === "/v1/events") return Response.json({ object: "list", data: [], has_more: false });
    if (method === "GET" && url.pathname === "/v1/subscriptions/search") {
      searches += 1;
      during?.(searches, run);
      const [body, status] = subscriptionSearchPage(subs, url.searchParams.get("query") ?? "", url.searchParams.get("page") ?? "", Number(url.searchParams.get("limit")), paging);
      return Response.json(body, { status });
    }
    if (method === "POST" && url.pathname.startsWith("/v1/subscriptions/")) {
      posts += 1;
      const sub = subs.find((s) => s.id === url.pathname.split("/").pop());
      if (!sub) return Response.json({ error: { message: "No such subscription" } }, { status: 404 });
      sub.application_fee_percent = Number(new URLSearchParams(String(init?.body)).get("application_fee_percent"));
      return Response.json(sub);
    }
    throw Error(`Unexpected synthetic request ${method} ${url.pathname}`);
  }) as typeof fetch;
  let finished = false, mostSearches = 0, doneTooEarly = false;
  try {
    while (run < most && !finished) {
      run += 1;
      searches = 0;
      const counts = await settleShares(Date.now() + 60_000, NOW, false);
      mostSearches = Math.max(mostSearches, searches);
      const [applied] = await redis.pipeline([["HGET", "nl:share:applied", ref]]);
      finished = applied === null;
      if (finished !== counts.complete) throw Error(`run ${run}: applied mark ${String(applied)} but complete ${counts.complete}`);
      if (finished && subs.some((s) => live(s) && s.application_fee_percent !== 0)) doneTooEarly = true;
    }
  } finally { globalThis.fetch = oldFetch; }
  const stillPaying = subs.filter((s) => live(s) && s.application_fee_percent !== 0).length;
  return { finished, ran: run, mostSearches, doneTooEarly, stillPaying, posts };
}

test("a live membership behind 2,100 ended ones is lowered, in one run with one search", async () => {
  // Before: the search held every membership ever sold; 20 pages of ended ones came first on every run, so the live one
  // was never reached and went on paying 6.25% after the store's share ended; each run spent 20 searches and wrote
  // nothing, and the store never left the job.
  const subs = [...many(2_000, "canceled", "Old"), ...many(100, "incomplete_expired", "Exp"), ...many(1, "active", "StillLive")];
  const r = await days(subs, "cursor", 3);
  assert.deepEqual(r, { finished: true, ran: 1, mostSearches: 1, doneTooEarly: false, stillPaying: 0, posts: 1 });
});

test("1,500 live memberships on pages that stay put: lowered on the first run, confirmed by the second", async () => {
  const subs = [...many(3_000, "canceled", "Old"), ...many(1_500, "active", "Live")];
  const r = await days(subs, "cursor", 5);
  assert.deepEqual(r, { finished: true, ran: 2, mostSearches: 15, doneTooEarly: false, stillPaying: 0, posts: 1_500 });
});

test("a member who ends mid-pass shifts the offset pages: the skipped one is still lowered, never done before", async () => {
  const subs = many(1_500, "active", "Live");
  // On the first run, as its second page is asked for, a member of its first page ends: an offset page skips one.
  const r = await days(subs, "offset", 6, (search, run) => { if (run === 1 && search === 2) subs[0].status = "canceled"; });
  assert.equal(r.doneTooEarly, false);
  assert.deepEqual({ finished: r.finished, stillPaying: r.stillPaying }, { finished: true, stillPaying: 0 });
  assert.ok(r.ran <= 3, `ran ${r.ran}`);
  assert.ok(r.mostSearches <= 15, `searched ${r.mostSearches}`);
});

test("past 2,000 live memberships a run never says done, at most 20 searches a run", async () => {
  // Rule 24 bound and a known limit: the run reads 20 pages of what can still pay and starts again from the first page.
  // A store with more than 2,000 live memberships is not finished by this job (its applied mark is never written),
  // and is never said to be.
  const subs = many(2_050, "active", "Big");
  const r = await days(subs, "cursor", 3);
  assert.deepEqual({ finished: r.finished, doneTooEarly: r.doneTooEarly, mostSearches: r.mostSearches, stillPaying: r.stillPaying }, { finished: false, doneTooEarly: false, mostSearches: 20, stillPaying: 50 });
});
