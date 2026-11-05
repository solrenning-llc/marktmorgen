import assert from "node:assert/strict";
import test from "node:test";
import { paidCheckoutsOf } from "@/lib/person-copy-stripe";
import { copyPerson } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

// Independent review: real reader/copiers, in-memory Redis and synthetic HTTP.
const email = "Review-Person@example.test";
const sessionId = "cs_test_" + "v".repeat(24);
const row = () => ({ id: sessionId, status: "complete", payment_status: "paid", metadata: { store: "vreview", product: "product000001" } });
const page = (data: unknown[] = [row()]) => ({ object: "list", has_more: false, data });

async function fixture(answer: (variant: string) => Response) {
  redis.clear();
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_review_only";
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.stripe.com");
    assert.equal(url.pathname, "/v1/checkout/sessions");
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(url.searchParams.get("limit"), "100");
    assert.equal(url.searchParams.get("status"), "complete");
    const variant = url.searchParams.get("customer_details[email]")!;
    calls.push(variant);
    return answer(variant);
  }) as typeof fetch;
  const owner = "v-review-owner@example.test";
  await claimHandle(owner, "vreview", "Review", "");
  await ensureListId(owner); await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestCopy", true);
  const shop = (await storeForEmail(owner))!;
  return { shop, calls, restore() {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = priorKey;
  } };
}

test("two complete maximum-sized pages are deduplicated with exactly two GETs", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...row(), id: `cs_test_${String(i).padStart(24, "0")}` }));
  const f = await fixture(() => Response.json(page(rows)));
  try {
    assert.deepEqual(await paidCheckoutsOf(f.shop, email), rows.map(r => ({ id: r.id, meta: r.metadata, payment: "" })));
    assert.deepEqual(f.calls, [email, email.toLowerCase()]);
  } finally { f.restore(); }
});

test("a continuation flag rejects an otherwise complete empty page without pagination", async () => {
  const f = await fixture(() => Response.json({ ...page([]), has_more: true }));
  try { assert.equal(await paidCheckoutsOf(f.shop, email), null); assert.equal(f.calls.length, 1); }
  finally { f.restore(); }
});

for (const [name, malformed] of [
  ["foreign", { ...row(), metadata: { store: "foreign" }, payment_status: "future_status" }],
  ["unpaid", { ...row(), payment_status: "unpaid", metadata: { store: 1 } }],
] as const) test(`invalid ${name} row cannot be discarded before validating evidence`, async () => {
  const f = await fixture(() => Response.json(page([row(), malformed])));
  try { assert.equal(await paidCheckoutsOf(f.shop, email), null); assert.equal(f.calls.length, 1); }
  finally { f.restore(); }
});

test("an HTTP failure is unknown without a retry", async () => {
  const f = await fixture(() => Response.json({ error: { message: "synthetic unavailable" } }, { status: 503 }));
  try { assert.equal(await paidCheckoutsOf(f.shop, email), null); assert.equal(f.calls.length, 1); }
  finally { f.restore(); }
});

for (const complete of [false, true]) test(`actual copy with retained shipment and ${complete ? "complete" : "unknown"} second variant`, async () => {
  const f = await fixture(variant => Response.json(variant === email || complete ? page() : {}));
  try {
    const tracking = "https://example.test/review-tracking";
    redis.run(["SET", `nl:ship:done:${sessionId}`, JSON.stringify({ at: 1_790_000_000, tracking })]);
    const scope = await erasureScope(f.shop, email);
    assert.ok(scope);
    if (complete) {
      const copy = await copyPerson(scope);
      assert.deepEqual(copy.sections.find(s => s.module === "lib/shipments.ts")?.records.map(r => (r as { tracking: string }).tracking), [tracking]);
    } else await assert.rejects(copyPerson(scope), /payments could not be read in full/);
    assert.deepEqual(f.calls, [email, email.toLowerCase()], "one shared read across all copy sections");
  } finally { f.restore(); }
});
