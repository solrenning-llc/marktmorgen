import test from "node:test";
import assert from "node:assert/strict";
import { findStoreSubscriptions } from "@/lib/billing";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_pagination_only";
const store = { statsId: "a".repeat(32), handle: "alpha", previousHandles: [], releasedHandles: [],
  stripeCustomerId: "cus_OneOwner001", email: "owner@example.test", subscriptionId: null, extra: false } as unknown as Store;

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
