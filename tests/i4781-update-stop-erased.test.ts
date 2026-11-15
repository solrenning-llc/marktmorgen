/**
 * Issue #4781 (erasure, MEDIUM; Codex V, transcribed by Claude 2): a product update's stop link noted its key for
 * erasure, then wrote the grant holding the buyer's address in another step. An erasure that completed between the
 * two deleted the note (and the key, not there yet) and said done, and the grant was then written, kept up to 400
 * days with nothing leading to it. Now the note is read again after the grant is written; gone, the grant is taken
 * back and nothing is sent to them. Transcribed from the issue; synthetic store, mocked Stripe and Resend.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { advanceUpdate, startUpdate } from "@/lib/product-updates";
import { erasePerson } from "@/lib/person-erasure";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

type Pipeline = typeof redis.pipeline;
type Commands = (string | number)[][];
const person = "v-update-person@example.test";
const original: Pipeline = redis.pipeline.bind(redis);
const grants = () => redis.keys().filter((k) => k.startsWith("nl:upd:stop:"));
const isGrantWrite = (commands: Commands) => commands.length === 1 && commands[0][0] === "EVAL" && commands[0].some((x) => String(x).startsWith("nl:upd:stop:"));

test("a completed erasure falls between the confirmed note and the stop-grant write", async () => {
  redis.clear();
  redis.pipeline = original;
  const owner = "update-owner@example.test";
  let productId = "";
  process.env.STRIPE_SECRET_KEY = "sk_test_updates_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_updates_only_a_stand_in";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body));
      return Response.json({ data: batch.map((_: unknown, i: number) => ({ id: `synthetic_${i}` })) });
    }
    if (url.hostname !== "api.stripe.com") throw new Error("No real provider call allowed");
    const data = url.pathname === "/v1/checkout/sessions" ? [{
      id: "cs_update_evidence", object: "checkout.session", status: "complete", payment_status: "paid",
      created: Math.floor(Date.now() / 1000) - 86400, amount_total: 2700, currency: "usd",
      customer_details: { email: person }, metadata: { store: "vupdaterace", product: productId },
    }] : [];
    return Response.json({ object: "list", data, has_more: false });
  }) as typeof fetch;
  await claimHandle(owner, "vupdaterace", "V Update Race", "");
  await ensureStatsId(owner); await ensureListId(owner);
  await setStripeAccount(owner, "acct_1TestHarbor0001", true);
  await setSubscription(owner, { customerId: "cus_UpdateProof", subscriptionId: "sub_UpdateProof", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(owner, { fromName: "V Update Race", address: "1 Example St, Example City" });
  const made = await addProduct(owner, "Update evidence", "", "27", null);
  assert.ok(made.ok);
  productId = made.product.id;
  await setProductLink(owner, productId, "https://example.com/update");
  const shop = (await storeForEmail(owner))!;
  const product = (await readListing(shop, productId))!;
  const started = await startUpdate(shop, product, "A verified update");
  assert.ok(started.ok, JSON.stringify(started));

  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let paused = false;
  redis.pipeline = (async (commands: Commands) => {
    if (!paused && isGrantWrite(commands)) { paused = true; reached(); await hold; }
    return original(commands);
  }) as Pipeline;
  const pending = advanceUpdate(started.job.id, storeForHandle, Date.now() + 20000);
  await reachedP;
  let erased = false;
  try {
    erased = (await erasePerson(shop, person, { kind: "person" })).ok;
  } finally { release(); }
  await pending;
  redis.pipeline = original;
  assert.equal(erased, true, "the person's erasure completed in the gap");
  assert.deepEqual(grants(), [], "no stop grant naming the erased person survives");
  assert.deepEqual(redis.keys().filter((k) => k.startsWith("nl:erase:ix:")).length, 0);
});
