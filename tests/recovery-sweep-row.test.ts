/**
 * One checkout whose reminder cannot be decided holds back nobody else's
 * (CX-116 second money review of #2929, F2). remindAbandoned throws
 * UnknownReplyError when one of its marks comes back in an unknown shape
 * (CX-123 rule 24), and the sweep's reminder loop (lib/checkout-sweep.ts)
 * had no catch of its own: the throw left the whole store's pass, so the
 * next buyer's reminder, the abandoned-checkout workflows and the later
 * pages were skipped, and the run's failed count said 0. Through the real
 * sweepCheckouts: ann's marks come back unknown, bob's are whole; bob's
 * reminder still goes, ann's checkout is counted as failed and nothing goes
 * to her. Synthetic records, the in-memory Redis and stand-in senders only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductLink, setRecovery, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_recovery_sweep_row_only";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

let sessions: unknown[] = [];
const sent: string[] = [];
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
  // The store's page of checkouts; a buyer's "paid since" list is whole and empty.
  if (url.pathname === "/v1/checkout/sessions" && !url.searchParams.has("customer_details[email]")) {
    return Response.json({ object: "list", data: sessions, has_more: false });
  }
  return Response.json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "recsweeprow@example.com";
const HANDLE = "recsweeprow";

test("one checkout's unknown mark is counted as failed and does not hold back the next buyer's reminder", async () => {
  await claimHandle(OWNER, HANDLE, "Row Kiln", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestRecSwRow1", true);
  await setSubscription(OWNER, { customerId: "cus_RecSwRow0001", subscriptionId: "sub_RecSwRow0001", active: true, period: paidPeriod() });
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
  const ANN = "cs_test_recsweeprowann0001";
  sessions = [left(ANN, "ann@example.com"), left("cs_test_recsweeprowbob0001", "bob@example.com")];

  // Ann's five marks come back with no reply where her sent mark goes.
  const original = redis.pipeline;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await original.call(redis, commands);
    if (commands.length === 5 && commands[0]?.[0] === "EXISTS" && commands[0][1] === `nl:recover:sent:${ANN}`) return replies.map((r, i) => (i === 0 ? null : r));
    return replies;
  }) as typeof redis.pipeline;
  const logged: string[] = [];
  const errors = console.error;
  console.error = (...args: unknown[]) => void logged.push(String(args[0]));
  let counts;
  try {
    counts = await sweepCheckouts(Date.now() + 20_000);
  } finally {
    redis.pipeline = original;
    console.error = errors;
  }
  assert.deepEqual(sent.filter((to) => to === "ann@example.com"), [], "nothing goes to ann on an unknown mark");
  assert.deepEqual(sent.filter((to) => to === "bob@example.com"), ["bob@example.com"], "bob's reminder still goes in the same pass");
  assert.equal(counts.reminded, 1, "the pass counts bob's reminder");
  assert.equal(counts.failed, 1, "the pass counts ann's checkout as failed, never as 0");
  assert.ok(!logged.includes("reading a store's checkouts failed"), `the store's pass did not end on ann's checkout: ${logged.join(" | ")}`);
});
