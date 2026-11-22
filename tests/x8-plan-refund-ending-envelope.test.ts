import assert from "node:assert/strict";
import test from "node:test";
import { store as redis } from "./redis-stub";
import { NOW, paidShop, world } from "./plan-refund-stripe-world";
import { finishPlanRefunds, refundAndEndPlan } from "@/lib/plan-refund-flow";

// Real flow, in-memory Redis and the repository's synthetic provider only.
process.env.STRIPE_SECRET_KEY = "sk_test_x8_synthetic_only";
const inner = globalThis.fetch;
let override: { status: string; body: unknown } | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (override && (init?.method ?? "GET") === "GET" && url.pathname === "/v1/invoices" && url.searchParams.get("status") === override.status) {
    return Response.json(override.body);
  }
  return inner(input, init);
}) as typeof fetch;

async function attempt(status: string, body: unknown) {
  redis.clear();
  const shop = await paidShop();
  override = { status, body };
  try {
    const answer = await refundAndEndPlan(await shop.store(), NOW, 6_900);
    return { shop, result: {
      refunded: answer.ok,
      ended: answer.ok && answer.ended,
      refunds: shop.refunds().length,
      noteKept: (await shop.note()) !== null,
      localActive: (await shop.store()).subscriptionActive,
      invoices: shop.invoices().map(x => x.split(":")[1]).sort(),
    } };
  } finally { override = null; }
}

const bodies = [
  ["object absent", { data: [], has_more: false }],
  ["object null", { object: null, data: [], has_more: false }],
  ["another object", { object: "invoice", data: [], has_more: false }],
  ["a search envelope", { object: "search_result", data: [], has_more: false }],
] as const;

for (const status of ["open", "draft"]) {
  for (const [name, body] of bodies) {
    test(`ending keeps recovery pending when ${status} invoices answer ${name}`, async () => {
      const { result } = await attempt(status, body);
      assert.deepEqual(result, { refunded: true, ended: false, refunds: 1, noteKept: true, localActive: true,
        invoices: status === "open" ? ["draft", "open"] : ["draft", "void"] });
    });
  }
}

test("exact invoice lists finish the refund, void the invoice and remove the draft", async () => {
  redis.clear();
  const shop = await paidShop();
  const answer = await refundAndEndPlan(await shop.store(), NOW, 6_900);
  assert.equal(answer.ok && answer.ended, true);
  assert.deepEqual([shop.refunds().length, await shop.note(), (await shop.store()).subscriptionActive, shop.invoices()],
    [1, null, false, [`in_${(await shop.store()).handle}open:void`]]);
});

test("truly empty exact lists finish without inventing an invoice", async () => {
  redis.clear();
  const shop = await paidShop();
  world.invoices = world.invoices.filter(i => i.subscription !== shop.subId || i.status === "paid");
  const answer = await refundAndEndPlan(await shop.store(), NOW, 6_900);
  assert.deepEqual([answer.ok && answer.ended, shop.refunds().length, await shop.note(), shop.invoices()], [true, 1, null, []]);
});

test("a repaired list lets the daily job finish without refunding twice", async () => {
  const { shop, result } = await attempt("open", { object: "invoice", data: [], has_more: false });
  assert.equal(result.noteKept, true);
  const settled = await finishPlanRefunds(Date.now() + 10_000, NOW + 60);
  assert.deepEqual([settled.ended, shop.refunds().length, await shop.note(), (await shop.store()).subscriptionActive], [1, 1, null, false]);
});
