/**
 * Packages of calls: sold once, booked one session at a time.
 *
 * Measured before it was built (30 September 2026): Stan's coaching call is
 * one session per purchase (help.stan.store, article 15). What is checked:
 *
 *   - only a weekly call offers a package, and what it saves is said right;
 *   - its checkout is one payment marked as a package;
 *   - once paid, it is written down once, with a booking link emailed once;
 *   - a session counts from the moment its time is held, comes back if the
 *     hold runs out unpaid, and stays spent once booked;
 *   - no session is booked from a package used up, past its date or refunded,
 *     and each session's checkout carries a single-use coupon for all of it.
 */
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { packageLimitWords, packageSaving, parseCallPackage } from "@/lib/call-package-rules";
import { boughtByToken, holdSession, packageCheckout, packageState, prepareSession, readBought, recordPackage } from "@/lib/call-packages";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const emails: { to: string[]; text: string }[] = [];
const posts: { path: string; body: URLSearchParams; headers: Headers }[] = [];
let refunded = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "e" }));
  }
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (method === "POST") {
    posts.push({ path, body: new URLSearchParams(String(init?.body)), headers: new Headers(init?.headers) });
    if (path === "/checkout/sessions") return new Response(JSON.stringify({ id: `cs_test_${"p".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/pkg" }));
    if (path === "/coupons") return new Response(JSON.stringify({ id: `co_Session${posts.length}` }));
  }
  if (path.startsWith("/checkout/sessions/")) {
    return new Response(JSON.stringify({ id: PAID, status: "complete", payment_status: "paid", payment_intent: { latest_charge: { refunded, amount: 50000, amount_refunded: refunded ? 50000 : 0 } } }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const PAID = `cs_test_${"q".repeat(24)}`;
const weekly: CallSetup = {
  kind: "weekly",
  minutes: 60,
  tz: "America/New_York",
  weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.com/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_packages_only";
  process.env.RESEND_API_KEY = "re_test_packages_only";

  part("The offer");
  is("2 to 20 sessions, a price, a limit that is offered; unknown validity never becomes unlimited", [parseCallPackage({ sessions: 5, priceCents: 50000, days: 90 }), parseCallPackage({ sessions: 1, priceCents: 1, days: 0 }), parseCallPackage({ sessions: 5, priceCents: 5, days: 45 })], [{ sessions: 5, priceCents: 50000, days: 90 }, null, null]);
  is("what it saves", [packageSaving({ sessions: 5, priceCents: 50000, days: 0 }, 12000), packageSaving({ sessions: 5, priceCents: 70000, days: 0 }, 12000)], [10000, 0]);
  is("its limit said", [packageLimitWords({ sessions: 5, priceCents: 1, days: 90 }), packageLimitWords({ sessions: 5, priceCents: 1, days: 0 })], ["Use them within 90 days", "No time limit to use them"]);

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const call = await addProduct("owner@example.com", "Coaching Call", "", "120", null);
  const other = await addProduct("owner@example.com", "Guide", "", "20", null);
  if (!call.ok || !other.ok) throw new Error("no products");
  const made = await setProductCall("owner@example.com", call.product.id, weekly);
  is("a weekly call", made.ok, true);
  const refusedPlain = await setCallPackage("owner@example.com", other.product.id, { sessions: 5, priceCents: 50000, days: 90 });
  is("not on something that is not a weekly call", refusedPlain.ok ? "set" : refusedPlain.reason, "call");
  is("on a weekly call", (await setCallPackage("owner@example.com", call.product.id, { sessions: 5, priceCents: 50000, days: 90 })).ok, true);
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, call.product.id))!;
  is("kept with the product", product.callPackage, { sessions: 5, priceCents: 50000, days: 90 });

  part("Its checkout");
  await packageCheckout(store, product, product.callPackage!, "https://marktmorgen.com");
  const body = posts[0].body;
  is("the package charge belongs to this creator's connected account", posts[0].headers.get("Stripe-Account"), store.stripeAccountId);
  is("the platform test credential acts on the connected account", posts[0].headers.get("Authorization"), "Bearer sk_test_packages_only");
  is("the package is not a platform charge routed by destination or transfer", [...body.keys()].filter((key) => /transfer_data|on_behalf_of|destination/.test(key)), []);
  is("one payment for all of it, marked as a package", [body.get("mode"), body.get("line_items[0][price_data][unit_amount]"), body.get("metadata[kind]"), body.get("metadata[sessions]"), body.get("metadata[days]")], ["payment", "50000", "package", "5", "90"]);

  part("Once paid");
  const created = Math.floor(Date.now() / 1000);
  const session = { id: PAID, status: "complete", payment_status: "paid", created, amount_total: 50000, currency: "usd", metadata: { store: "harbor", product: product.id, kind: "package", sessions: "5", days: "90" }, customer_details: { email: "Dana@Example.com" } };
  const input = { store, session, product, base: "https://marktmorgen.com/@harbor", from: '"Harbor Kitchen" <hello@marktmorgen.com>' };
  const bought = await recordPackage(input);
  if (!bought) throw new Error("not recorded");
  is("written down: who, how many, until when", [bought.e, bought.total, bought.until - bought.at], ["dana@example.com", 5, 90 * 86_400]);
  is("written once", (await recordPackage(input))?.token, bought.token);
  is("one email, with the booking link", [emails.length, emails[0].text.includes(`/book/${product.id}?pkg=${bought.token}`)], [1, true]);
  is("the link finds it", (await boughtByToken(bought.token))?.checkout, PAID);
  is("five left", (await packageState(bought)).left, 5);

  part("Spending sessions");
  const prepared = await prepareSession(store, bought.token, "https://marktmorgen.com");
  is("a session's checkout gets a single-use coupon for all of it", prepared.ok && [prepared.fromPackage.coupon.startsWith("co_Session"), prepared.fromPackage.email], [true, "dana@example.com"]);
  const coupon = posts.find((p) => p.path === "/coupons")!.body;
  is("the coupon", [coupon.get("percent_off"), coupon.get("max_redemptions"), coupon.get("duration")], ["100", "1", "once"]);
  const soon = Math.floor(Date.now() / 1000) + 1_800;
  for (let i = 0; i < 4; i += 1) await holdSession(store, PAID, `cs_test_hold${i}${"x".repeat(20)}`, soon);
  is("held sessions count", (await packageState((await readBought(PAID))!)).left, 1);
  await holdSession(store, PAID, `cs_test_expired${"x".repeat(20)}`, Math.floor(Date.now() / 1000) - 3_600);
  is("a hold that ran out unpaid comes back", (await packageState((await readBought(PAID))!)).left, 1);
  redis.run(["SET", `nl:call:confirmed:cs_test_expired${"x".repeat(20)}`, "1"]);
  is("unless it was booked after all", (await packageState((await readBought(PAID))!)).left, 0);
  is("a sixth is refused", await holdSession(store, PAID, `cs_test_late${"x".repeat(20)}`, soon), false);
  const usedUp = await prepareSession(store, bought.token, "https://marktmorgen.com");
  is("and so is its checkout", usedUp.ok ? "prepared" : usedUp.reason, "used");

  part("Past its date, or refunded");
  const other2 = await recordPackage({ ...input, session: { ...session, id: `cs_test_${"r".repeat(24)}`, created: created - 100 * 86_400 } });
  const late = await prepareSession(store, other2!.token, "https://marktmorgen.com");
  is("past its date", late.ok ? "prepared" : late.reason, "expired");
  const fresh = await recordPackage({ ...input, session: { ...session, id: `cs_test_${"s".repeat(24)}` } });
  refunded = true;
  const back = await prepareSession(store, fresh!.token, "https://marktmorgen.com");
  is("refunded in full", back.ok ? "prepared" : back.reason, "refunded");

  done();
}

void main();
