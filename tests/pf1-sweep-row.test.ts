/**
 * One buyer's unknown reading holds back nobody else's reminder (review of
 * #2951, LEVE). remindAbandoned throws UnknownReplyError when a reading is
 * not whole (CX-123 rule 24): here ann's "paid since" list answers
 * has_more: true with no match, which is unknown, never "not paid". The
 * sweep's reminder loop (lib/checkout-sweep.ts) had no catch of its own, so
 * the throw ended the store's whole pass: bob's reminder was not sent, his
 * "paid since" was never asked, the workflows and later pages were skipped,
 * failed stayed 0 and "reading a store's checkouts failed" was logged on
 * every pass while ann's row was inside REMIND_WITHIN_SECONDS. Through the
 * real sweepCheckouts, three passes: bob's reminder goes once, nothing goes
 * to ann, each pass counts her checkout as failed and the store's pass never
 * ends on it. Synthetic records, the in-memory Redis and stand-in senders only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_pf1_sweep_row_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const ANN = "ann@example.com";
const BOB = "bob@example.com";
let sessions: unknown[] = [];
const sent: string[] = [];
const paidAsked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails/batch") {
      const batch = JSON.parse(String(init?.body)) as { to: string | string[] }[];
      for (const m of batch) sent.push([m.to].flat()[0]);
      return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
    }
    const body = JSON.parse(String(init?.body)) as { to: string | string[] };
    sent.push([body.to].flat()[0]);
    return Response.json({ id: `email_${sent.length}` });
  }
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions") {
    const who = url.searchParams.get("customer_details[email]");
    // A buyer's "paid since" list: ann's is cut short with no match, bob's is whole and empty.
    if (who !== null) {
      paidAsked.push(who);
      return Response.json({ object: "list", data: [], has_more: who === ANN });
    }
    return Response.json({ object: "list", data: sessions, has_more: false });
  }
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "pfsweeprow@example.com";
const HANDLE = "pfsweeprow";

test("one buyer's unknown reading is that checkout's failure only: the next buyer's reminder goes, pass after pass", async () => {
  await claimHandle(OWNER, HANDLE, "Row Kiln", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPfSwRow01", true);
  await setSubscription(OWNER, { customerId: "cus_PfSwRow00001", subscriptionId: "sub_PfSwRow00001", active: true, period: paidPeriod() });
  await setRecovery(OWNER, { enabled: true, address: "9 Kiln Road, Portland, OR 97201", asks: true });
  const made = await addProduct(OWNER, "Glaze Recipes", "", "24", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, `https://example.com/${made.product.id}`);
  await storeForEmail(OWNER);
  const now = Math.floor(Date.now() / 1000);
  const left = (id: string, email: string) => ({
    id,
    object: "checkout.session",
    status: "expired",
    payment_status: "unpaid",
    created: now - 3700,
    expires_at: now - 100,
    consent: { promotions: "opt_in" },
    customer_details: { email },
    metadata: { store: HANDLE, product: made.product.id },
  });
  sessions = [left("cs_test_pfsweeprowann0001", ANN), left("cs_test_pfsweeprowbob0001", BOB)];

  const logged: string[] = [];
  const errors = console.error;
  console.error = (...args: unknown[]) => void logged.push(String(args[0]));
  const failed: number[] = [];
  try {
    for (let pass = 0; pass < 3; pass += 1) failed.push((await sweepCheckouts(Date.now() + 20_000)).failed);
  } finally {
    console.error = errors;
  }
  assert.deepEqual(sent.filter((to) => to === ANN), [], "nothing goes to ann on an unknown reading");
  assert.ok(paidAsked.includes(BOB), "bob's \"paid since\" is asked in the same pass");
  assert.deepEqual(sent.filter((to) => to === BOB), [BOB], "bob's reminder goes, once");
  assert.deepEqual(failed, [1, 1, 1], "each pass counts ann's checkout as failed, never as 0");
  assert.equal(logged.filter((line) => line === "reading a store's checkouts failed").length, 0, `the store's pass never ends on ann's checkout: ${logged.join(" | ")}`);
});
