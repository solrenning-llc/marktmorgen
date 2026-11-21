/**
 * A paid call package is written down whole (audit of the checkout, HIGH): recordPackage wrote the package (SET NX),
 * the store's list (SADD) and the token (SET) in three separate requests. When a later one failed once, every later
 * call found the record and returned it at once, so the token was never written and the email with the booking link
 * never went: a paid package that could book nothing. Synthetic store, Stripe and email.
 *
 *   - a token write that failed once is made by the next call, which sends the email with the link, once;
 *   - a call after that writes nothing and sends nothing again;
 *   - a package bought cleanly writes its list and token with its record, and sends one email.
 */
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { boughtByToken, prepareSession, readBought, recordPackage } from "@/lib/call-packages";
import { confirmPurchase } from "@/lib/purchase-email";
import { admitOrders } from "@/lib/order-admission";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PAID = `cs_test_${"q".repeat(24)}`;
const emails: { to: string[]; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "e" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  if (path.startsWith("/checkout/sessions/")) {
    return new Response(JSON.stringify({ id: PAID, status: "complete", payment_status: "paid", payment_intent: { latest_charge: { refunded: false, amount: 50000, amount_refunded: 0 } } }));
  }
  if (path === "/coupons") return new Response(JSON.stringify({ id: "co_Session1" }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${path}` } }), { status: 404 });
}) as typeof fetch;

const weekly = {
  kind: "weekly", minutes: 60, tz: "America/New_York", weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [],
} as unknown as CallSetup;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_packages_only";
  process.env.RESEND_API_KEY = "re_test_packages_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const call = await addProduct("owner@example.com", "Coaching Call", "", "120", null);
  if (!call.ok) throw new Error("no product");
  await setProductCall("owner@example.com", call.product.id, weekly);
  await setCallPackage("owner@example.com", call.product.id, { sessions: 5, priceCents: 50000, days: 90 });
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, call.product.id))!;
  const session = { id: PAID, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 50000, currency: "usd", metadata: { store: "harbor", product: product.id, kind: "package", sessions: "5", days: "90" }, customer_details: { email: "dana@example.com" } };
  // Each package was an order admitted when its checkout opened (lib/call-packages.ts packageCheckout): its emails are the order's.
  is("two orders admitted", (await admitOrders(store, 2)).ok, true);
  const input = { store, session, product, base: "https://marktmorgen.com/@harbor", from: '"Harbor Kitchen" <hello@marktmorgen.com>' };

  part("The thanks page records the paid package; the request that writes its token fails once");
  const original = redis.pipeline.bind(redis);
  let failed = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (failed === 0 && JSON.stringify(commands).includes("nl:pkg:t:")) {
      failed += 1;
      throw new Error("synthetic: Upstash request failed");
    }
    return original(commands);
  }) as typeof redis.pipeline;
  const first = await recordPackage(input).then(() => "recorded", (error: Error) => `threw: ${error.message}`);
  is("the first call throws on the token write", first, "threw: synthetic: Upstash request failed");
  is("the package record itself was written", (await readBought(PAID)) !== null, true);

  part("Every later call (reload of the thanks page, the five-minute sweep)");
  const again = await recordPackage(input);
  is("a later call returns the stored package at once", again?.token === (await readBought(PAID))?.token, true);
  const outcome = await confirmPurchase(store, PAID, session as Parameters<typeof confirmPurchase>[2]);
  is("the sweep then counts it as confirmed", outcome, "sent");
  is("the token the page links to finds the package", (await boughtByToken(again!.token))?.checkout ?? null, PAID);
  const prepared = await prepareSession(store, again!.token, "https://marktmorgen.com");
  is("the buyer can book one of the five sessions they paid for", prepared.ok ? "ok" : prepared.reason, "ok");
  is("the buyer got the email with the booking link", emails.filter((m) => m.text.includes("?pkg=")).length, 1);

  part("A later call again: nothing more is written or sent");
  const third = await recordPackage(input);
  is("the same package", third?.token, again!.token);
  is("still one email with the link", emails.filter((m) => m.text.includes("?pkg=")).length, 1);
  redis.pipeline = original;

  part("A package bought cleanly: its list and token with its record, one email");
  const CLEAN = `cs_test_${"r".repeat(24)}`;
  const clean = await recordPackage({ ...input, session: { ...session, id: CLEAN } });
  is("recorded", clean !== null, true);
  is("its token finds it", (await boughtByToken(clean!.token))?.checkout ?? null, CLEAN);
  is("the store's list has it", redis.run(["SISMEMBER", `nl:pkg:s:${store.statsId}`, CLEAN]), 1);
  is("one email with its link", emails.filter((m) => m.text.includes(`?pkg=${clean!.token}`)).length, 1);
  await recordPackage({ ...input, session: { ...session, id: CLEAN } });
  is("and no second one when called again", emails.filter((m) => m.text.includes(`?pkg=${clean!.token}`)).length, 1);
  done();
}

void main();
