import assert from "node:assert/strict";
import { after, test } from "node:test";
import { remindAbandoned } from "@/lib/checkout-recovery";
import { UnknownReplyError } from "@/lib/redis-reply";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_marks_exact_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const sent: string[] = [];
let transports = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  transports += 1;
  assert.ok(transports <= 100, "admitted synthetic transport ceiling");
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    sent.push([body.to].flat()[0]);
    return Response.json({ id: `synthetic_${sent.length}` });
  }
  assert.equal(url.hostname, "api.stripe.com", "no unexpected or external transport");
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const untouched = Symbol("untouched");
let injected: unknown = untouched;
let injectedReads = 0;
let commands = 0;
const original = redis.pipeline.bind(redis);
redis.pipeline = (async (batch: (string | number)[][]) => {
  commands += batch.length;
  assert.ok(commands <= 2000, "admitted synthetic command ceiling");
  const replies = await original(batch);
  if (injected !== untouched && batch.length === 5 && batch[0][0] === "EXISTS" && String(batch[0][1]).startsWith("nl:recover:sent:")) {
    assert.deepEqual(batch[3], ["EXISTS", "nl:none"]);
    injectedReads += 1;
    replies[3] = injected as never;
  }
  return replies;
}) as typeof redis.pipeline;

const owner = "recmarks@example.com";
let product = "";
async function shop() {
  if (!product) {
    await claimHandle(owner, "recmarkskiln", "Recmarks Kiln", "");
    await ensureStatsId(owner);
    await ensureListId(owner);
    await setStripeAccount(owner, "acct_1TestRecMarks01", true);
    await setSubscription(owner, { customerId: "cus_RecMarks0001", subscriptionId: "sub_RecMarks0001", active: true, period: paidPeriod() });
    await setRecovery(owner, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
    const made = await addProduct(owner, "Glaze Recipes", "", "24", null);
    assert.ok(made.ok);
    product = made.product.id;
    await setProductLink(owner, product, `https://example.com/${product}`);
  }
  const store = await storeForEmail(owner);
  assert.ok(store);
  return { ...store, listId: null };
}

for (const [label, value, known] of [["zero", 0, true], ["one", 1, true], ["two", 2, false], ["missing", undefined, false]] as const) {
  test(`one-key no-list EXISTS reply ${label}`, async () => {
    const store = await shop();
    const email = `${label}@example.com`;
    const id = `cs_test_znolistreturn${label}`;
    const now = Math.floor(Date.now() / 1000);
    const checkout = { id, object: "checkout.session", status: "expired", payment_status: "unpaid", created: now - 3700, expires_at: now - 100, consent: { promotions: "opt_in" }, customer_details: { email }, metadata: { store: "recmarkskiln", product } };
    const before = sent.length;
    const readsBefore = injectedReads;
    injected = value;
    let outcome: unknown;
    try {
      outcome = await remindAbandoned(store, checkout as never).catch(error => error);
    } finally { injected = untouched; }
    const mark = (await redis.pipeline([["GET", `nl:recover:sent:${id}`]]))[0];
    console.log(JSON.stringify({ label, emails: sent.length - before, mark, outcome: outcome instanceof Error ? outcome.name : outcome, injectedReads: injectedReads - readsBefore }));
    assert.equal(injectedReads - readsBefore, 1, "the real no-list pipeline was exercised");
    if (known) {
      assert.equal(outcome, "sent");
      assert.deepEqual(sent.slice(before), [email]);
      assert.equal(mark, "sent");
    } else {
      assert.ok(outcome instanceof UnknownReplyError, "unknown must refuse before paid email or marking sent");
      assert.equal(sent.length, before);
      assert.notEqual(mark, "sent");
    }
  });
}
after(() => console.log(JSON.stringify({ commands, syntheticTransports: transports, externalRequests: 0 })));
