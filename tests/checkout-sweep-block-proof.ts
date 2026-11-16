/**
 * P3. lib/checkout-sweep.ts confirm loop (~:475-487) and buyer-list loop (~:506-528). confirmPurchase is awaited with
 * no per-order catch: one order whose confirmation throws ends the store's pass (sweepCheckouts catches per store,
 * ~:590). Every order after it on the page (older ones: Stripe lists newest first), every later page, the buyer
 * library and the buyer list are left for that run. While the throw lasts (a record that does not read, once the
 * readers throw: #2872 gifts, #2909 listings), the orders behind it are never confirmed, and leave the 24-hour
 * window (CONFIRM_WITHIN_SECONDS) unconfirmed. Not counted as failed either (counts.failed stays 0).
 * Real MemoryRedis and the real sweep; Stripe's list stubbed; one command throws for order A only.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureListId, ensureStatsId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "@/tests/redis-stub";
import { paidPeriod } from "@/tests/billing-period-fixture";
import { installSesMailFixture } from "@/tests/ses-mail-fixture";

let sessions: unknown[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

async function main() {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_proof_only";
  const OWNER = "sweep-block@example.com";
  await claimHandle(OWNER, "sweepblock", "Harbor Kitchen", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSwpBlk1", true);
  await setSubscription(OWNER, { customerId: "cus_SwpBlk1", subscriptionId: "sub_SwpBlk1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const p = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!p.ok) throw new Error("no product");
  await setProductLink(OWNER, p.product.id, "https://example.com/course");
  await storeForEmail(OWNER);
  const paid = (id: string, email: string, age: number) => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: Math.floor(Date.now() / 1000) - age, amount_total: 4900, currency: "usd",
    customer_details: { email }, metadata: { store: "sweepblock", product: p.product.id },
  });
  const A = "cs_test_sweepblockA0000001", B = "cs_test_sweepblockB0000001";
  sessions = [paid(A, "ann@example.com", 60), paid(B, "bob@example.com", 600)];
  const sent = (to: string) => mail.ses.filter((m) => m.to.includes(to)).length;

  const real = redis.pipeline.bind(redis);
  // Order A's confirmation throws (here: its claim; in life, a record that does not read).
  redis.pipeline = (async (c: (string | number)[][]) => {
    if (c[0]?.[0] === "SET" && c[0]?.[1] === `nl:confirm:${A}` && c[0]?.includes("NX")) throw new Error("a record that does not read");
    return real(c);
  }) as typeof redis.pipeline;
  const errors = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => void logged.push(String(a[0]));
  for (let run = 1; run <= 3; run += 1) {
    const counts = await sweepCheckouts(Date.now() + 20_000);
    console.log(`run ${run}: A sent=${sent("ann@example.com")} B sent=${sent("bob@example.com")} counts.confirmed=${counts.confirmed} counts.failed=${counts.failed} logged="${logged.at(-1)}"`);
  }
  redis.pipeline = real;
  const counts = await sweepCheckouts(Date.now() + 20_000);
  console.error = errors;
  console.log(`control, A's throw gone: A sent=${sent("ann@example.com")} B sent=${sent("bob@example.com")} confirmed=${counts.confirmed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
