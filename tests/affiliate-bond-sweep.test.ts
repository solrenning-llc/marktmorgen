/**
 * The checkout sweep credits a returning buyer's bonded affiliate even when the
 * buyer never comes back to the thanks page.
 *
 * A store that keeps buyers with the affiliate who first brought them
 * (lib/affiliate-bond.ts, "on any device, with no cookie involved at all")
 * credits the later purchase inside noteSession. The sweep (lib/checkout-sweep.ts)
 * only called noteSession for an order with a link, a code or a partner, so a
 * bonded buyer who paid and closed the tab earned their affiliate nothing, for
 * good. Real sweep on the in-memory Redis; Stripe's list stubbed; synthetic only.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { rememberBuyer } from "@/lib/affiliate-bond";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let sessions: unknown[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

const OWNER = "sweep-bond@example.com";
const ANA = "aaaaaaaaaaa1";
const NOW = Math.floor(Date.now() / 1000);

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";

  await claimHandle(OWNER, "sweepbond", "Harbor Bakery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSwpBond01", true);
  await setSubscription(OWNER, { customerId: "cus_SwpBond01", subscriptionId: "sub_SwpBond01", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Bakery", address: "1 Main St, Portland, OR 97201" });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, lifetime: true }));
  const course = await addProduct(OWNER, "Bread Course", "Twelve loaves.", "50", null);
  if (!course.ok) throw new Error("no product");
  await setProductLink(OWNER, course.product.id, "https://example.com/bread");
  const store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, JSON.stringify({ id: ANA, email: "ana@example.com", code: "ana", status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" })],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
  ]);
  await rememberBuyer(store, "lee@example.com", ANA, store.affiliates.rule);

  const BACK = "cs_test_sweepbondBack00001";
  sessions = [{
    id: BACK, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: NOW - 60, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd", total_details: { amount_tax: 0 },
    payment_intent: `pi_${BACK}`, customer_details: { email: "lee@example.com" },
    metadata: { store: "sweepbond", product: course.product.id, title: "Bread Course" },
    discounts: [],
  }];
  const counts = await sweepCheckouts(Date.now() + 20_000);
  const line = (await readBook(store)).lines.find((l) => l.ref === BACK);
  is("the bonded buyer's later purchase is Ana's, from the sweep alone", [line?.aff, line?.how], [ANA, "buyer"]);
  is("nothing failed", counts.failed, 0);
  await sweepCheckouts(Date.now() + 20_000);
  is("another pass writes no second line", (await readBook(store)).lines.filter((l) => l.ref === BACK).length, 1);
  done();
}

void main();
