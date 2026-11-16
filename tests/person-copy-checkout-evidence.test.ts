import assert from "node:assert/strict";
import test from "node:test";
import { paidCheckoutsOf } from "@/lib/person-copy-stripe";
import { copyPerson } from "@/lib/person-copy";
import { erasureScope } from "@/lib/person-erasure";
import { claimHandle, ensureListId, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";

const person = "copy-person@example.test";
const sessionId = "cs_test_" + "c".repeat(24);
const checkout = () => ({ id: sessionId, status: "complete", payment_status: "paid", payment_intent: "pi_CopyEvidence", metadata: { store: "copyevidence", product: "product000001" } });
const page = (data: unknown = [checkout()]) => ({ object: "list", data, has_more: false });

async function setup(reply: unknown | ((variant: string) => unknown)) {
  redis.clear();
  const priorFetch = globalThis.fetch;
  const calls: { method: string; variant: string }[] = [];
  process.env.STRIPE_SECRET_KEY = "sk_test_person_copy_only";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "api.stripe.com", "outside providers are forbidden");
    assert.equal(url.pathname, "/v1/checkout/sessions");
    const variant = url.searchParams.get("customer_details[email]")!;
    assert.equal(url.searchParams.get("limit"), "100");
    calls.push({ method: init?.method ?? "GET", variant });
    return Response.json(typeof reply === "function" ? reply(variant) : reply);
  }) as typeof fetch;
  const owner = "copy-owner@example.test";
  await claimHandle(owner, "copyevidence", "Copy Evidence", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestCopy", true);
  const shop = (await storeForEmail(owner))!;
  return { shop, calls, restore: () => { globalThis.fetch = priorFetch; } };
}

const unknownPages: [string, unknown][] = [
  ["missing page fields", {}], ["null page", null], ["array page", []],
  ["missing data", { object: "list", has_more: false }],
  ["null data", page(null)], ["object data", page({})],
  ["missing continuation evidence", { object: "list", data: [] }],
  ["null continuation evidence", { ...page(), has_more: null }],
  ["text continuation evidence", { ...page(), has_more: "false" }],
  ["wrong list discriminator", { ...page(), object: "checkout.session" }],
  ["page beyond the requested bound", page(Array.from({ length: 101 }, checkout))],
  ["null row", page([null])], ["array row", page([[]])],
  ["missing row id", page([{ ...checkout(), id: undefined }])],
  ["invalid row id", page([{ ...checkout(), id: "not-a-checkout" }])],
  ["wrong metadata", page([{ ...checkout(), metadata: false }])],
  ["non-string metadata value", page([{ ...checkout(), metadata: { store: "copyevidence", gift: 1 } }])],
  ["missing status", page([{ ...checkout(), status: undefined }])],
  ["unknown payment status", page([{ ...checkout(), payment_status: "unknown" }])],
  ["wrong payment intent", page([{ ...checkout(), payment_intent: {} }])],
  ["mixed complete and malformed rows", page([checkout(), {}])],
];
for (const [name, reply] of unknownPages) test(`${name} cannot certify a complete personal payment list`, async () => {
  const r = await setup(reply);
  try {
    assert.equal(await paidCheckoutsOf(r.shop, person), null);
    assert.equal(r.calls.length, 1, "unknown evidence is not retried or paginated");
    assert.ok(r.calls.every(c => c.method === "GET"));
  } finally { r.restore(); }
});

test("confirmed empty and complete pages preserve empty, unpaid, foreign and deduplicated results", async () => {
  const variants: unknown[] = [page([]), page([
    checkout(), { ...checkout(), id: "cs_test_" + "f".repeat(24), metadata: { store: "foreign" } },
    { ...checkout(), id: "cs_test_" + "u".repeat(24), payment_status: "unpaid" },
  ])];
  let at = 0;
  const r = await setup(() => variants[at++]);
  try {
    assert.deepEqual(await paidCheckoutsOf(r.shop, person), []);
    assert.deepEqual(await paidCheckoutsOf(r.shop, person), [{ id: sessionId, meta: checkout().metadata, payment: "pi_CopyEvidence" }]);
    assert.equal(r.calls.length, 2);
  } finally { r.restore(); }
});

test("a second address variant must also be confirmed before returning the first variant's records", async () => {
  const r = await setup((variant: string) => variant === "Copy-Person@example.test" ? page() : {});
  try {
    assert.equal(await paidCheckoutsOf(r.shop, "Copy-Person@example.test"), null);
    assert.equal(r.calls.length, 2);
  } finally { r.restore(); }
});

test("both confirmed address variants deduplicate the same checkout without another request", async () => {
  const r = await setup(page());
  try {
    assert.deepEqual(await paidCheckoutsOf(r.shop, "Copy-Person@example.test"), [{ id: sessionId, meta: checkout().metadata, payment: "pi_CopyEvidence" }]);
    assert.equal(r.calls.length, 2);
  } finally { r.restore(); }
});

test("confirmed null metadata and a no-payment-required checkout keep their existing meaning", async () => {
  const r = await setup(page([
    { ...checkout(), id: "cs_test_" + "n".repeat(24), metadata: null },
    { ...checkout(), payment_status: "no_payment_required", payment_intent: null },
  ]));
  try {
    assert.deepEqual(await paidCheckoutsOf(r.shop, person), [{ id: sessionId, meta: checkout().metadata, payment: "" }]);
    assert.deepEqual(await paidCheckoutsOf({ ...r.shop, stripeAccountId: null }, person), []);
    assert.equal(r.calls.length, 1);
  } finally { r.restore(); }
});

test("the actual personal copy refuses unknown checkout evidence rather than omitting a retained shipment", async () => {
  const r = await setup({});
  try {
    redis.run(["SET", `nl:ship:done:${sessionId}`, JSON.stringify({ at: 1_790_000_000, tracking: "https://example.test/tracking" })]);
    const scope = await erasureScope(r.shop, person);
    assert.ok(scope);
    await assert.rejects(copyPerson(scope), /payments could not be read in full/);
    assert.equal(r.calls.length, 1, "the shared checkout read is not repeated per copy section");
  } finally { r.restore(); }
});
