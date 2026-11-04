import test from "node:test";
import assert from "node:assert/strict";
import { findStoreSubscriptions } from "@/lib/billing";
import type { Store } from "@/lib/store";
import { PLATFORM_PLAN_MAX_PAGES } from "@/lib/platform-plan-rules";

process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_pagination_only";
const store = { statsId: "a".repeat(32), handle: "alpha", previousHandles: [], releasedHandles: [],
  stripeCustomerId: "cus_OneOwner001", email: "owner@example.test", subscriptionId: null, extra: false } as unknown as Store;
function ownedPlan() {
  const created = Math.floor(Date.now() / 1000);
  return { id: "sub_OwnPage0001", created, status: "active", metadata: { store: "alpha", store_id: store.statsId },
    customer: { id: store.stripeCustomerId, email: store.email },
    items: { data: [{ quantity: 1, current_period_start: created - 1, current_period_end: created + 30 * 86400,
      price: { lookup_key: "nimbus_creator_month", currency: "usd", unit_amount: 6900,
        recurring: { interval: "month", interval_count: 1 } } }] } };
}

test("C86-2 a shared customer's complete second page permits an empty owned observation", async () => {
  const original = globalThis.fetch;
  const first = Array.from({ length: 100 }, (_, i) => ({ id: "sub_Other" + String(i).padStart(6, "0"),
    status: "canceled", created: 1, metadata: { store: "another-store" },
    customer: { id: store.stripeCustomerId, email: store.email } }));
  let reads = 0, pages = 0;
  globalThis.fetch = async (input, init) => {
    reads++;
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) return Response.json({ data: [], has_more: false });
    assert.equal(url.pathname, "/v1/subscriptions");
    assert.equal(url.searchParams.get("customer"), store.stripeCustomerId);
    assert.equal(url.searchParams.get("status"), "all");
    pages++;
    if (pages === 1) return Response.json({ data: first, has_more: true });
    assert.equal(url.searchParams.get("starting_after"), first.at(-1)!.id);
    return Response.json({ data: [], has_more: false });
  };
  try {
    assert.deepEqual(await findStoreSubscriptions(store), { live: null, customerId: null, lapsed: [] });
    assert.equal(pages, 2);
    assert.equal(reads, 3);
  } finally { globalThis.fetch = original; }
});

test("C86-3 final closing stops an owned late plan found by Search when the independent List fails", async () => {
  const { store: redis } = await import("./redis-stub");
  const { claimHandle, setSubscription, storeForEmail, storeRef } = await import("@/lib/store");
  const { FINAL_INDEX } = await import("@/lib/closing-holds");
  const { closeOne } = await import("@/lib/plan-closing");
  redis.clear();
  const original = globalThis.fetch;
  const email = "late-coverage@example.test";
  await claimHandle(email, "late-coverage", "Late coverage", "");
  await setSubscription(email, { customerId: "cus_OneOwner001", subscriptionId: "sub_PriorPlan001", active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  const ref = storeRef((await storeForEmail(email))!);
  const now = Date.now(), created = Math.floor(now / 1000) + 1;
  await redis.run(["ZADD", FINAL_INDEX, now - 40 * 86400_000, ref]);
  const late = { id: "sub_LatePlan0001", status: "active", created,
    customer: { id: "cus_OneOwner001", email }, metadata: { store: "late-coverage" },
    items: { data: [{ quantity: 1, current_period_start: created, current_period_end: created + 30 * 86400,
      price: { lookup_key: "nimbus_creator_month", unit_amount: 6900, currency: "usd",
        recurring: { interval: "month", interval_count: 1 } } }] } };
  const stopped: string[] = [];
  let searchReads = 0, listReads = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/subscriptions/search") { searchReads++; return Response.json({ data: [late], has_more: false }); }
    if (url.pathname === "/v1/subscriptions") { listReads++; return Response.json({ error: { message: "Synthetic independent List failure" } }, { status: 503 }); }
    if (url.pathname === "/v1/subscriptions/" + late.id) {
      if (init?.method === "DELETE") stopped.push(late.id);
      return Response.json({ ...late, status: stopped.length ? "canceled" : "active" });
    }
    if (["/v1/invoices", "/v1/checkout/sessions"].includes(url.pathname)) return Response.json({ data: [], has_more: false });
    throw new Error("Unexpected synthetic provider request: " + init?.method + " " + url.pathname);
  };
  try {
    const result = await closeOne(ref, now, { measure: async () => 0, list: async () => [], remove: async () => {} });
    assert.equal(searchReads, 1);
    assert.equal(listReads, 1);
    assert.equal(result.state, "held", "failed List coverage must still prevent deletion");
    assert.deepEqual(stopped, [late.id], "independent coverage failure cannot hide a confirmed owned charge");
  } finally { globalThis.fetch = original; }
});

test("Search uses its opaque next_page as page and still requires the complete customer observation", async () => {
  const original = globalThis.fetch, own = ownedPlan();
  let searchPages = 0, customerPages = 0;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) {
      searchPages++;
      assert.equal(url.searchParams.has("starting_after"), false);
      if (searchPages === 1) {
        assert.equal(url.searchParams.has("page"), false);
        return Response.json({ data: [{ ...own, id: "sub_ForeignPage01", metadata: { store: "alpha", store_id: "b".repeat(32) } }], has_more: true, next_page: "opaque-page-two" });
      }
      assert.equal(url.searchParams.get("page"), "opaque-page-two");
      return Response.json({ data: [own], has_more: false, next_page: null });
    }
    customerPages++;
    return Response.json({ data: [], has_more: false });
  };
  try {
    assert.equal((await findStoreSubscriptions(store)).live?.subscriptionId, own.id);
    assert.deepEqual([searchPages, customerPages], [2, 1]);
  } finally { globalThis.fetch = original; }
});

test("priced pagination stops at its ceiling without adoption and retains positive rows only for closing", async () => {
  const { observeStoreSubscriptions } = await import("@/lib/billing");
  const original = globalThis.fetch, own = ownedPlan();
  let reads = 0, pages = 0, after = "";
  globalThis.fetch = async input => {
    reads++;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/search")) return Response.json({ data: [], has_more: false });
    assert.equal(url.searchParams.get("starting_after") ?? "", after);
    pages++;
    after = "sub_Page" + String(pages).padStart(6, "0");
    const unrelated = { id: after, metadata: { store: "elsewhere" }, customer: own.customer, created: 1, status: "canceled" };
    return Response.json({ data: pages === 1 ? [own, unrelated] : [unrelated], has_more: true });
  };
  try {
    const observed = await observeStoreSubscriptions(store);
    await assert.rejects(observed.find(), /priced page ceiling/);
    await assert.rejects(observed.customerLive(), /priced page ceiling/);
    assert.throws(() => observed.customerPlans(), /priced page ceiling/);
    assert.equal(observed.closingPlans().complete, false);
    assert.deepEqual(observed.closingPlans().plans.map(row => row.id), [own.id]);
    assert.equal(pages, PLATFORM_PLAN_MAX_PAGES);
    assert.equal(reads, PLATFORM_PLAN_MAX_PAGES + 1);
  } finally { globalThis.fetch = original; }
});

test("a repeated Search cursor refuses coverage before a third Search request", async () => {
  const original = globalThis.fetch, own = ownedPlan();
  let pages = 0;
  globalThis.fetch = async input => {
    if (!new URL(String(input)).pathname.endsWith("/search")) return Response.json({ data: [], has_more: false });
    pages++;
    return Response.json({ data: [own], has_more: true, next_page: "same-cursor" });
  };
  try {
    await assert.rejects(findStoreSubscriptions(store), /repeated cursor/);
    assert.equal(pages, 2);
  } finally { globalThis.fetch = original; }
});

test("a malformed List member cannot hide another positively owned charge from closing", async () => {
  const { observeStoreSubscriptions } = await import("@/lib/billing");
  const original = globalThis.fetch, own = ownedPlan();
  globalThis.fetch = async input => Response.json({ data: new URL(String(input)).pathname.endsWith("/search") ? [] : [null, own], has_more: false });
  try {
    const observed = await observeStoreSubscriptions(store);
    await assert.rejects(observed.find(), /listed member is unknown/);
    assert.equal(observed.closingPlans().complete, false);
    assert.deepEqual(observed.closingPlans().plans.map(row => row.id), [own.id]);
  } finally { globalThis.fetch = original; }
});

test("contradictory store IDs on overlapping observations cannot adopt or cancel the shared subscription ID", async () => {
  const { observeStoreSubscriptions } = await import("@/lib/billing");
  const original = globalThis.fetch, own = ownedPlan();
  globalThis.fetch = async input => Response.json({ data: [{ ...own,
    metadata: { ...own.metadata, store_id: new URL(String(input)).pathname.endsWith("/search") ? store.statsId : "b".repeat(32) },
  }], has_more: false });
  try {
    const observed = await observeStoreSubscriptions(store);
    await assert.rejects(observed.find(), /overlap|identity/);
    assert.equal(observed.closingPlans().complete, false);
    assert.deepEqual(observed.closingPlans().plans, []);
  } finally { globalThis.fetch = original; }
});
