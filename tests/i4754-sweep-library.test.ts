/**
 * Issue #4754 (erasure, MEDIUM): the checkout sweep (lib/checkout-sweep.ts)
 * put a completed checkout's buyer back in the store's purchase library after
 * the person was erased, so the library listed the store again. Transcribed
 * from Claude 2's reproduction on main @8a47273d8e: sweep, erase, sweep the
 * same checkout again. A checkout that predates the erasure leaves the
 * library erased; one paid after it is still noted.
 */
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { storesBoughtFrom } from "@/lib/buyer-library";
import { erasePerson } from "@/lib/person-erasure";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

type Session = Record<string, unknown> & { id: string; created: number; status: string };
let sessions: Session[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") {
      const since = Number(url.searchParams.get("created[gte]") ?? 0);
      return new Response(JSON.stringify({ object: "list", data: sessions.filter((s) => s.created >= since), has_more: false }));
    }
    if (url.pathname === "/v1/account") return new Response(JSON.stringify({ id: "acct_1TestO1Swp1", country: "US" }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_o1_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_o1_only_a_stand_in";
  const OWNER = "o1-sweep@example.com", HANDLE = "o1sweep";
  redis.clear(); mail.configure(); await mail.setReady(true, { max24: 50_000, rate: 100 });
  await claimHandle(OWNER, HANDLE, "Harbor Kitchen", "");
  await ensureStatsId(OWNER); await ensureListId(OWNER); await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestO1Swp1", true);
  await setSubscription(OWNER, { customerId: "cus_O1Sweep1", subscriptionId: "sub_O1Sweep1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Kitchen", address: "1 Main St, Portland, OR 97201" });
  const course = await addProduct(OWNER, "Weeknight Course", "Thirty dinners.", "49", null);
  if (!course.ok) throw new Error("no product");
  const product = course.product.id;
  await setProductLink(OWNER, product, "https://example.com/course");
  const shop = (await storeForEmail(OWNER))!;
  const email = "erased-buyer@example.com";
  const created = Math.floor(Date.now() / 1000) - 3600;
  sessions = [{ id: "cs_test_o1000000000001", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created, amount_total: 4900, currency: "usd", customer_details: { email }, metadata: { store: HANDLE, product } }];
  part("sweep, erase, sweep again");
  await sweepCheckouts(Date.now() + 20_000);
  is("the store is in the library after the first sweep", (await storesBoughtFrom(email)).length, 1);
  const erased = await erasePerson(shop, email, { kind: "person" });
  is("erasure ok", erased.ok, true);
  is("library empty after erasure", (await storesBoughtFrom(email)).length, 0);
  await sweepCheckouts(Date.now() + 20_000);
  is("library still empty after the next sweep of the same checkout", (await storesBoughtFrom(email)).length, 0);

  part("an erasure between the sweep's check and its write still takes effect");
  const racer = "racing-buyer@example.com";
  sessions = [{ id: "cs_test_o1000000000002", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created, amount_total: 4900, currency: "usd", customer_details: { email: racer }, metadata: { store: HANDLE, product } }];
  const real = redis.pipeline.bind(redis);
  let raced = false;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    if (!raced && batch.some((c) => c.some((arg) => typeof arg === "string" && arg.startsWith("nl:lib:")) && c.some((arg) => arg === "SADD" || String(arg).includes("SADD")))) {
      raced = true;
      redis.pipeline = real;
      const r = await erasePerson((await storeForEmail(OWNER))!, racer, { kind: "person" });
      if (!r.ok) throw new Error("racing erasure not ok");
    }
    return real(batch);
  }) as typeof redis.pipeline;
  try {
    await sweepCheckouts(Date.now() + 20_000);
  } finally {
    redis.pipeline = real;
  }
  is("the erasure ran between them", raced, true);
  is("the racing buyer's library stays empty", (await storesBoughtFrom(racer)).length, 0);

  part("a purchase paid after the erasure is noted, as any purchase");
  sessions = [{ id: "cs_test_o1000000000003", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: Math.floor(Date.now() / 1000) + 5, amount_total: 4900, currency: "usd", customer_details: { email }, metadata: { store: HANDLE, product } }];
  await sweepCheckouts(Date.now() + 20_000);
  is("the store is in their library again, for the new purchase", (await storesBoughtFrom(email)).length, 1);
  done();
}
main().catch((e) => { console.error(e); process.exit(1); });
