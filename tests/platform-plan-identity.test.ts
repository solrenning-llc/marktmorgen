import test from "node:test";
import assert from "node:assert/strict";
import { observeStoreSubscriptions, ownedBy } from "@/lib/billing";
import type { Store } from "@/lib/store";

process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_plan_identity_only";
const second = Math.floor(Date.now() / 1000);
const owner = () => ({
  statsId: "a".repeat(32), handle: "alpha", previousHandles: [],
  handleOwnership: [{ handle: "xray", acquiredAt: (second - 200) * 1000, releasedAt: (second - 100) * 1000 }],
  releasedHandles: ["xray"], releasedHandleAt: { xray: second - 100 },
  stripeCustomerId: "cus_OneOwner001", email: "owner@example.test",
  subscriptionId: null, extra: false,
} as unknown as Store & { releasedHandleAt: Record<string, number> });
const plan = (metadata: Record<string, string>, created = second) => ({
  id: "sub_StoreB00001", created, status: "active", metadata,
  customer: { id: "cus_OneOwner001", email: "owner@example.test" },
  items: { data: [{ quantity: 1, current_period_start: second - 86400,
    current_period_end: second + 86400 * 30,
    price: { lookup_key: "nimbus_creator_month", unit_amount: 6900, currency: "usd",
      recurring: { interval: "month", interval_count: 1 } } }] },
});

test("C86-1 shared customer cannot make store A own store B's immutable identity", () => {
  const a = owner();
  assert.equal(ownedBy(a, plan({ store: "xray", store_id: "b".repeat(32) })), false);
  assert.equal(ownedBy(a, plan({ store: "alpha", store_id: "b".repeat(32) })), false);
});

test("C86-1 a legacy released name proves ownership only before its recorded release", () => {
  const a = owner();
  assert.equal(ownedBy(a, plan({ store: "xray" }, second)), false);
  assert.equal(ownedBy(a, plan({ store: "xray" }, second - 100)), false, "equal seconds do not prove before");
  assert.equal(ownedBy(a, plan({ store: "xray" }, second - 101)), true);
  a.handleOwnership = [];
  assert.equal(ownedBy(a, plan({ store: "xray" }, second - 101)), false, "missing date is not invented");
});

test("a legacy subscription older than store A cannot become A's through a later release", () => {
  const a = owner();
  a.createdAt = new Date((second - 200) * 1000).toISOString();
  assert.equal(ownedBy(a, plan({ store: "xray" }, second - 300)), false);
});

test("C86-1 recovery and late-plan candidates exclude the other store paid by the same customer", async () => {
  const original = globalThis.fetch;
  const a = owner();
  const foreign = plan({ store: "xray" });
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method !== "GET") writes++;
    const url = new URL(String(input));
    return Response.json({ data: url.pathname.endsWith("/search") ? [] : [foreign], has_more: false });
  };
  try {
    const observation = await observeStoreSubscriptions(a);
    assert.deepEqual(await observation.find(), { live: null, customerId: null, lapsed: [] });
    assert.deepEqual(observation.customerPlans(), []);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = original; }
});

test("C86 foreign search owner is filtered even under the store's current name", async () => {
  const original = globalThis.fetch;
  const a = owner();
  const foreign = { ...plan({ store: "alpha" }), customer: { id: "cus_Foreign001", email: "foreign@example.test" } };
  globalThis.fetch = async input => Response.json({ data: new URL(String(input)).pathname.endsWith("/search") ? [foreign] : [], has_more: false });
  try {
    const observation = await observeStoreSubscriptions(a);
    assert.deepEqual(await observation.find(), { live: null, customerId: null, lapsed: [] });
    assert.deepEqual(observation.customerPlans(), []);
  } finally { globalThis.fetch = original; }
});

test("C86-1 closing store A cannot expire store B's checkout under its released name", async () => {
  const { expirePlanCheckouts } = await import("@/lib/closing-plan-guard");
  const original = globalThis.fetch;
  const a = owner();
  const expired: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      expired.push(url.pathname);
      return Response.json({ status: "expired" });
    }
    assert.equal(url.pathname, "/v1/checkout/sessions");
    return Response.json({ data: [{ id: "cs_test_StoreB000001", mode: "subscription", status: "open", created: second,
      customer: a.stripeCustomerId, metadata: { store: "xray", store_id: "b".repeat(32) } }], has_more: false });
  };
  try {
    assert.equal(await expirePlanCheckouts(a, [a.stripeCustomerId!]), 0);
    assert.deepEqual(expired, []);
  } finally { globalThis.fetch = original; }
});

test("checkout expiration captures the store identity before awaiting its customer page", async () => {
  const { expirePlanCheckouts } = await import("@/lib/closing-plan-guard");
  const original = globalThis.fetch, a = owner();
  let expired = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") { expired++; return Response.json({ status: "expired" }); }
    a.statsId = "b".repeat(32);
    a.releasedHandleAt.xray = second + 100;
    return Response.json({ data: [{ id: "cs_test_StoreB000001", mode: "subscription", status: "open", created: second,
      customer: "cus_OneOwner001", metadata: { store: "xray", store_id: "b".repeat(32) } }], has_more: false });
  };
  try {
    assert.equal(await expirePlanCheckouts(a, ["cus_OneOwner001"]), 0);
    assert.equal(expired, 0);
  } finally { globalThis.fetch = original; }
});

test("C86-1 the daily sync cannot apply store A's removed-name marker to store B's immutable identity", async () => {
  const { store: redis } = await import("./redis-stub");
  const { markShut } = await import("@/lib/closing-plan-guard");
  const { syncSubscriptions } = await import("@/lib/billing-sync");
  redis.clear();
  const original = globalThis.fetch, a = owner();
  await markShut(a, Date.now() - 1000, Date.now() - 40 * 86400_000);
  const foreign = plan({ store: "xray", store_id: "b".repeat(32) });
  const stopped: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/subscriptions") return Response.json({ data: [foreign], has_more: false });
    if (url.pathname === "/v1/subscriptions/" + foreign.id) {
      if (init?.method === "DELETE") stopped.push(foreign.id);
      return Response.json({ ...foreign, status: stopped.length ? "canceled" : "active" });
    }
    if (url.pathname === "/v1/invoices") return Response.json({ data: [], has_more: false });
    if (url.pathname === "/v1/customers/cus_OneOwner001") return Response.json({ id: "cus_OneOwner001", email: a.email });
    throw new Error("Unexpected synthetic provider request: " + init?.method + " " + url.pathname);
  };
  try {
    await syncSubscriptions(Date.now() + 60_000);
    assert.deepEqual(stopped, [], "a released name marker is not another store's closing identity");
  } finally { globalThis.fetch = original; }
});


test("CX96 current-name legacy ownership needs an acquisition interval too", () => {
  const a = owner();
  assert.equal(ownedBy(a, plan({ store: "alpha" })), false);
});

test("CX96 the gap before acquiring a released name never proves ownership", () => {
  const a = owner();
  Object.assign(a, { handleOwnership: [{ handle: "xray", acquiredAt: (second - 200) * 1000, releasedAt: (second - 100) * 1000 }] });
  assert.equal(ownedBy(a, plan({ store: "xray" }, second - 300)), false);
  assert.equal(ownedBy(a, plan({ store: "xray" }, second - 150)), true);
});


test("CX96 an undated legacy plan refuses checkout recovery and keeps final closing coverage unknown", async () => {
  const original = globalThis.fetch, a = owner();
  a.handleOwnership = [];
  const legacy = plan({store:"alpha"}); let writes = 0;
  globalThis.fetch = async (_input, init) => {if(init?.method !== "GET") writes++; return Response.json({data:[legacy],has_more:false});};
  try {
    const observation = await observeStoreSubscriptions(a);
    await assert.rejects(observation.find(), /ownership is unknown/);
    await assert.rejects(observation.customerLive(), /ownership is unknown/);
    assert.deepEqual(observation.closingPlans(), {complete:false,plans:[]});
    assert.equal(writes,0);
  } finally {globalThis.fetch = original;}
});

test("CX96 a closing marker and shared customer alone cannot cancel or refund a legacy plan", async () => {
  const {store:redis} = await import("./redis-stub");
  const {markShut,refusePlanIfClosing,UNDO_KEY,settleOne} = await import("@/lib/closing-plan-guard");
  redis.clear(); const original=globalThis.fetch, a=owner(); let writes=0;
  globalThis.fetch=async()=>{writes++;throw Error("No money operation is authorized");};
  try {
    await markShut(a,Date.now()-1000);
    assert.equal(await refusePlanIfClosing({store:null,handle:"alpha",subscriptionId:"sub_StoreB00001",customerId:a.stripeCustomerId!,subscription:plan({store:"alpha"})}),"returning");
    await redis.run(["HSET",UNDO_KEY,"sub_Unproved001",JSON.stringify({h:"alpha",c:a.stripeCustomerId,to:"",name:"",since:Date.now()-1000,at:Date.now(),n:0})]);
    assert.equal(await settleOne("sub_Unproved001"),false);
    assert.equal(writes,0);
  } finally {globalThis.fetch=original;}
});
