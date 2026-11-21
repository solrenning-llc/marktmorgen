import assert from "node:assert/strict";
import test from "node:test";
import { store as redis } from "./redis-stub";
import { NOW, paidShop, world } from "./plan-refund-stripe-world";
import { refundPlanPayment, lockKeyOf, WRITE_BY_MS } from "@/lib/plan-refund-write";
import { redisPipeline } from "@/lib/redis";

// The shared world replaces fetch completely; no payment service is reached.
process.env.STRIPE_SECRET_KEY = "sk_test_x8_synthetic_only";
const inner = globalThis.fetch;
let override: { body: unknown } | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (override && (init?.method ?? "GET") === "GET" && url.pathname === "/v1/refunds") {
    return Response.json(override.body);
  }
  return inner(input, init);
}) as typeof fetch;

async function attempt(body: unknown) {
  redis.clear();
  const shop = await paidShop();
  const store = await shop.store();
  const before = world.calls.length;
  let planned = 0;
  override = { body };
  try {
    const answer = await refundPlanPayment(store, NOW, 6_900, async () => { planned += 1; });
    return { answer, planned, posts: world.calls.slice(before).filter(c => c === "POST /refunds").length,
      made: shop.refunds().length, lock: (await redisPipeline([["GET", lockKeyOf(store.sid)]]))[0] };
  } finally { override = null; }
}

for (const [name, body] of [
  ["object absent", { data: [], has_more: false }],
  ["object null", { object: null, data: [], has_more: false }],
  ["another object", { object: "invoice", data: [], has_more: false }],
  ["a search envelope", { object: "search_result", data: [], has_more: false }],
] as const) {
  test(`the pre-write refund list refuses ${name} before noting or posting`, async () => {
    assert.deepEqual(await attempt(body), { answer: { ok: false, reason: "failed" }, planned: 0, posts: 0, made: 0, lock: null });
  });
}

test("an exact empty list still refunds once and releases its lock", async () => {
  const r = await attempt({ object: "list", data: [], has_more: false });
  assert.equal(r.answer.ok, true);
  assert.deepEqual([r.planned, r.posts, r.made, r.lock], [1, 1, 1, null]);
});

for (const [name, body] of [
  ["more promised", { object: "list", data: [], has_more: true }],
  ["data absent", { object: "list", has_more: false }],
  ["a foreign refund", { object: "list", data: [{ id: "re_foreign0001", object: "refund", charge: "ch_foreign0001", status: "failed" }], has_more: false }],
] as const) {
  test(`existing refusal remains closed: ${name}`, async () => {
    assert.deepEqual(await attempt(body), { answer: { ok: false, reason: "failed" }, planned: 0, posts: 0, made: 0, lock: null });
  });
}

test("a failed pre-write note never posts and releases the lock", async () => {
  redis.clear();
  const shop = await paidShop(), store = await shop.store();
  await assert.rejects(refundPlanPayment(store, NOW, 6_900, async () => { throw new Error("synthetic note failure"); }), /synthetic note failure/);
  assert.equal(shop.refunds().length, 0);
  assert.equal((await redisPipeline([["GET", lockKeyOf(store.sid)]]))[0], null);
});

test("a note that uses the write budget never posts afterward", async () => {
  redis.clear();
  const shop = await paidShop(), store = await shop.store();
  const realNow = Date.now;
  try {
    const answer = await refundPlanPayment(store, NOW, 6_900, async () => {
      const at = realNow(); Date.now = () => at + WRITE_BY_MS + 1;
    });
    assert.deepEqual(answer, { ok: false, reason: "failed" });
    assert.equal(shop.refunds().length, 0);
    assert.equal((await redisPipeline([["GET", lockKeyOf(store.sid)]]))[0], null);
  } finally { Date.now = realNow; }
});
