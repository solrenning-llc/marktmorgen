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
import { CONFIRM_WITHIN_SECONDS } from "@/lib/purchase-email";
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

  // Claude 4 cloud X on #4413 (6900357653, MEDIUM, cost; Codex G, 6907732373): a store that keeps buyers passes every
  // paid checkout with an address to noteSession, which reads the buyer's bond before its HSETNX writes nothing, and
  // the walk reads the day's checkouts again every five minutes: 100 bond reads a page, every run. A session whose
  // affiliate step ended with a known answer is not passed on again.
  const many = Array.from({ length: 100 }, (_, i) => ({
    id: `cs_test_sweepbondMany${String(i).padStart(5, "0")}`, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: NOW - 120 - i, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd", total_details: { amount_tax: 0 },
    payment_intent: `pi_sweepbondMany${String(i).padStart(5, "0")}`, customer_details: { email: `buyer${i}@example.com` },
    metadata: { store: "sweepbond", product: course.product.id, title: "Bread Course" },
    discounts: [],
  }));
  sessions = many;
  await sweepCheckouts(Date.now() + 20_000);
  const real = redis.pipeline.bind(redis);
  let bondReads = 0;
  redis.pipeline = (async (batch: (string | number)[][]) => {
    for (const c of batch) if (c[0] === "HGET" && String(c[1]) === `nl:aff:${statsId}:bond`) bondReads += 1;
    return real(batch);
  }) as typeof redis.pipeline;
  const again = await sweepCheckouts(Date.now() + 20_000);
  redis.pipeline = real as typeof redis.pipeline;
  is("the next pass reads no buyer's bond again for sessions already settled", bondReads, 0);
  is("and nothing failed", again.failed, 0);

  // Codex X4 on #4413 (X4-20261116-2218, MEDIUM): the settled mark and its expiry were three commands of one pipeline
  // (ZADD, ZREMRANGEBYSCORE, EXPIRE), which Redis does not run as one. A write that stops after the ZADD left the
  // sessions marked with no expiry: the next pass found them settled and never wrote again, so the key kept them for
  // good. The mark and its expiry are one write now: all of it, or nothing and the next pass marks them again.
  const [settledKey] = redis.keys().filter((k) => k.startsWith("nl:sweep:aff:"));
  is("control: the store's settled mark exists", typeof settledKey, "string");
  await redis.pipeline([["DEL", settledKey]]);
  sessions = many.slice(0, 10).map((row, i) => ({ ...row, id: `cs_test_sweepbondPart${String(i).padStart(5, "0")}`, payment_intent: `pi_sweepbondPart${String(i).padStart(5, "0")}` }));
  redis.pipeline = (async (batch: (string | number)[][]) => {
    const marks = batch.some((c) => String(c[0]) !== "ZMSCORE" && c.some((a) => String(a) === settledKey));
    if (!marks) return real(batch);
    // The first command of the write runs; the connection is lost before the rest.
    await real(batch.slice(0, 1));
    throw new Error("the connection was lost after the first command (test)");
  }) as typeof redis.pipeline;
  await sweepCheckouts(Date.now() + 20_000);
  redis.pipeline = real as typeof redis.pipeline;
  await sweepCheckouts(Date.now() + 20_000);
  const [ttl] = await redis.pipeline([["TTL", settledKey]]);
  is("a write cut after its first command never leaves the mark without its expiry", Number(ttl) > 0 && Number(ttl) <= CONFIRM_WITHIN_SECONDS, true);
  done();
}

void main();
