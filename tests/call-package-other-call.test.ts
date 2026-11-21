/**
 * MM-SA-32 (docs/security-audit-2026-10-28.md): a call package pays only for sessions of the
 * call it was bought for.
 *
 * app/api/store/book takes `pkg` (the package's token) and `product` from the same form, and
 * lib/call-packages.ts prepareSession checks only that the package belongs to the store
 * (`found.bought.s === store.statsId`), never that it was bought for this product
 * (`found.bought.p`). A buyer of the store's cheapest package can then book any other paid
 * call of the store, at any price, for nothing: the checkout carries a 100% coupon.
 *
 * Asserts the correct behavior: a package bought for call A opens no checkout for call B.
 * Synthetic data, Redis stand-in, Stripe stand-in; no network.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/book/route";
import { addProduct, claimHandle, ensureStatsId, setCallPackage, setProductCall, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { recordPackage } from "@/lib/call-packages";
import type { CallListing } from "@/lib/calls";
import type { CallSetup } from "@/lib/call-setup";
import { store as redis } from "./redis-stub";
import { done, is } from "./check";
import { weekdayAt } from "./weekday";
import { paidPeriod } from "./billing-period-fixture";

const NY = "America/New_York";
const PAID = `cs_test_${"p".repeat(24)}`;
const weekly = { kind: "weekly", minutes: 60, tz: NY, weekly: [[], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], [[540, 1020]], []], noticeHours: 1, horizonDays: 30, bufferMinutes: 0, room: "https://example.com/room", video: false, meet: null, seats: 1, sessions: [] } as unknown as CallSetup;

const opened: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "e" });
  const path = url.pathname.replace(/^\/v1/, "");
  if (method === "POST" && path === "/coupons") return answer({ id: "co_Session1" });
  if (method === "POST" && path === "/checkout/sessions") {
    opened.push(new URLSearchParams(String(init?.body)));
    const id = `cs_test_opened${String(opened.length).padStart(12, "0")}`;
    return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  if (method === "GET" && path === `/checkout/sessions/${PAID}`) {
    return answer({ id: PAID, status: "complete", payment_status: "paid", payment_intent: { latest_charge: { refunded: false, amount: 3000, amount_refunded: 0 } } });
  }
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.RESEND_API_KEY = "re_test_synthetic_only";
  redis.clear();
  const owner = "owner@example.com";
  const handle = "pkgproof";
  await claimHandle(owner, handle, "Synthetic Coaching", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestPkgProof01", true);
  await setSubscription(owner, { customerId: "cus_PkgProof0001", subscriptionId: "sub_PkgProof0001", active: true, tier: "creator", period: paidPeriod() });

  // Call A: a cheap call with a package of 3 sessions for $30.
  const a = await addProduct(owner, "Quick Question Call", "", "15", null);
  if (!a.ok) throw new Error("no product A");
  await setProductCall(owner, a.product.id, weekly);
  await setCallPackage(owner, a.product.id, { sessions: 3, priceCents: 3000, days: 90 });
  // Call B: an expensive call, no package at all.
  const b = await addProduct(owner, "Full Strategy Day", "", "900", null);
  if (!b.ok) throw new Error("no product B");
  await setProductCall(owner, b.product.id, weekly);

  const store = (await storeForEmail(owner))!;
  const listingA = (await readListing(store, a.product.id)) as CallListing;
  const bought = await recordPackage({
    store,
    session: { id: PAID, status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000), amount_total: 3000, currency: "usd", metadata: { store: handle, product: listingA.id, kind: "package", sessions: "3", days: "90" }, customer_details: { email: "buyer@example.com" } },
    product: listingA,
    base: `https://marktmorgen.com/@${handle}`,
    from: '"Synthetic Coaching" <hello@marktmorgen.com>',
  } as never);
  if (!bought) throw new Error("package not recorded");

  // The package of call A, sent with call B's id.
  const form = new URLSearchParams({ handle, product: b.product.id, start: String(weekdayAt(3, 600)), tz: NY, pkg: bought.token });
  // The route's `after(countHit)` runs only once the checkout was opened; outside Next it throws, which is itself that sign.
  let location = "";
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/book", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }));
    location = response.headers.get("location") ?? "";
  } catch (error) {
    if (!/outside a request scope/.test(String(error))) throw error;
    location = "https://checkout.stripe.com/(reached after(), so a checkout was handed out)";
  }
  const free = opened.find((body) => body.get("metadata[product]") === b.product.id && body.get("discounts[0][coupon]"));
  is("a package bought for call A opens no free checkout for call B", { checkoutForB: Boolean(free), toStripe: location.startsWith("https://checkout.stripe.com/") }, { checkoutForB: false, toStripe: false });
  is("refused as a package this call does not have", location.includes(`/book/${b.product.id}?status=pkg-gone`), true);

  // The same package, sent with call A's id: its free session still opens.
  const own = new URLSearchParams({ handle, product: a.product.id, start: String(weekdayAt(3, 600)), tz: NY, pkg: bought.token });
  let ownLocation = "";
  try {
    const response = await POST(new NextRequest("https://marktmorgen.com/api/store/book", { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" }, body: own.toString() }));
    ownLocation = response.headers.get("location") ?? "";
  } catch (error) {
    if (!/outside a request scope/.test(String(error))) throw error;
    ownLocation = "https://checkout.stripe.com/(reached after())";
  }
  const freeA = opened.find((body) => body.get("metadata[product]") === a.product.id && body.get("discounts[0][coupon]") === "co_Session1");
  is("the package still pays for a session of its own call", { checkoutForA: Boolean(freeA), toStripe: ownLocation.startsWith("https://checkout.stripe.com/") }, { checkoutForA: true, toStripe: true });
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
