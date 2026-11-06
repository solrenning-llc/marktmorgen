/**
 * A product's heavy rest (nl:catalog:<id>:x:<product>: its checkout questions and its funnel) is read only in its
 * exact shape (CX-123 rule 24):
 *
 *   - readProduct / readProducts: a GET nil is "no questions, no funnel", as productWrites deletes the key when a
 *     product has neither; a reply of another type, a record that is not JSON, not an object, whose questions are not
 *     a list, or whose funnel does not read throws UnknownReplyError, never "this product asks nothing";
 *   - so a checkout is never opened without a required question the creator set, and an edit made while the reply is
 *     unknown never writes the product back without its questions and funnel (productWrites would DEL the key).
 *
 * Synthetic data only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductDisplay, setProductFields, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readProduct, readProducts } from "@/lib/catalog";
import { applyCheckoutFields } from "@/lib/checkout-fields";
import { UnknownReplyError } from "@/lib/redis-reply";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "product-extras-exact@example.com";
type Batch = (string | number)[][];

const SIZE = { label: "Your size", type: "dropdown" as const, optional: false, options: ["Small", "Large"] };

const fixture = (async () => {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_product_extras_exact";
  await claimHandle(OWNER, "extrasexact", "Extras Exact", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_ExtrasExact01", subscriptionId: "sub_ExtrasExact01", active: true, period: paidPeriod() });
  const asking = await addProduct(OWNER, "Synthetic shirt", "", "19", null);
  const plain = await addProduct(OWNER, "Synthetic guide", "", "9", null);
  if (!asking.ok || !plain.ok) throw new Error("no products");
  const set = await setProductFields(OWNER, asking.product.id, [SIZE]);
  assert.equal(set.ok, true, JSON.stringify(set));
  const store = (await storeForEmail(OWNER)) as Store;
  assert.ok(store.catalog.id, "the products have records of their own");
  const extras = (id: string) => `nl:catalog:${store.catalog.id}:x:${id}`;
  return { store, asking: asking.product.id, plain: plain.product.id, extras };
})();

const extrasGet = (command: (string | number)[]) => command[0] === "GET" && String(command[1]).includes(":x:");

/** Answers every GET of a product's heavy rest with `reply`, the rest as Redis does. */
async function withExtrasReply<T>(reply: unknown, run: () => Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const original = redis.pipeline.bind(redis);
  redis.pipeline = (async (batch: Batch) => {
    const answers = await original(batch);
    return answers.map((answer, i) => (extrasGet(batch[i]) ? reply : answer));
  }) as typeof redis.pipeline;
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  } finally {
    redis.pipeline = original;
  }
}

const UNKNOWN: [string, unknown][] = [
  ["a number", 7],
  ["an array", ["{}"]],
  ["an object", { fields: [] }],
  ["an empty string", ""],
  ["a string that is not JSON", "{not json"],
  ["JSON that is a string", JSON.stringify("fields")],
  ["JSON that is a list", JSON.stringify([SIZE])],
  ["JSON null", "null"],
  ["questions that are not a list", JSON.stringify({ fields: { 0: SIZE }, funnel: null })],
  ["questions missing", JSON.stringify({ funnel: null })],
  ["a question that does not read", JSON.stringify({ fields: [SIZE, { label: "", type: "text", optional: false, options: [] }], funnel: null })],
  ["a funnel that does not read", JSON.stringify({ fields: [SIZE], funnel: { steps: "x" } })],
];

test("control: the questions a creator set are read back, and a product with none reads none", async () => {
  const { store, asking, plain } = await fixture;
  assert.deepEqual((await readProduct(store, asking))?.fields, [SIZE]);
  assert.deepEqual((await readProduct(store, plain))?.fields, []);
  assert.deepEqual((await readProducts(store, [asking, plain])).map((p) => p.fields.length), [1, 0]);
});

test("control: a confirmed-absent heavy rest (GET nil) is no questions and no funnel", async () => {
  const { store, asking } = await fixture;
  const read = await withExtrasReply(null, () => readProduct(store, asking));
  assert.equal(read.error, undefined);
  assert.deepEqual(read.value?.fields, []);
  assert.equal(read.value?.funnel, null);
});

for (const [name, reply] of UNKNOWN) {
  test(`a heavy rest answered as ${name} throws UnknownReplyError, never "asks nothing"`, async () => {
    const { store, asking } = await fixture;
    const one = await withExtrasReply(reply, () => readProduct(store, asking));
    assert.ok(one.error instanceof UnknownReplyError, `readProduct answered ${JSON.stringify(one.value?.fields)}`);
    const many = await withExtrasReply(reply, () => readProducts(store, [asking]));
    assert.ok(many.error instanceof UnknownReplyError, `readProducts answered ${JSON.stringify(many.value?.map((p) => p.fields))}`);
  });
}

test("a checkout is never built without the required question while the heavy rest is unknown", async () => {
  const { store, asking } = await fixture;
  const built = await withExtrasReply(7, async () => {
    const product = await readProduct(store, asking);
    const body = new URLSearchParams();
    applyCheckoutFields(body, product?.fields);
    return body;
  });
  assert.ok(built.error instanceof UnknownReplyError, `a checkout body was built: ${built.value?.toString()}`);
});

test("an edit made while the heavy rest is unknown is refused and leaves the questions stored", async () => {
  const { store, asking, extras } = await fixture;
  const [before] = await redis.pipeline([["GET", extras(asking)]]);
  assert.equal(typeof before, "string");
  const edit = await withExtrasReply(7, () => setProductDisplay(OWNER, asking, "callout"));
  assert.ok(edit.error instanceof UnknownReplyError || (edit.value && !edit.value.ok), `the edit went through, writing the questions as ${JSON.stringify(edit.value && edit.value.ok ? edit.value.product.fields : null)}`);
  const [after] = await redis.pipeline([["GET", extras(asking)]]);
  assert.equal(after, before, "the stored questions and funnel are untouched");
  assert.deepEqual((await readProduct(store, asking))?.fields, [SIZE]);
});
