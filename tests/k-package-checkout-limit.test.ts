/**
 * "Buy 5 sessions" (app/api/store/package) opens a Checkout Session on the creator's Stripe account and holds one
 * of the store's order places (lib/call-packages.ts packageCheckout, lib/order-admission.ts) for every request.
 * Every sibling that opens a checkout is limited per connection and store first (checkout and cart:
 * withinLimit("checkout", ip|store, 20, 600); book: 15; PayPal: the same as checkout), so a script cannot fill the
 * store's orders or spend its Stripe calls. This one was not (audit of the API routes, Claude 3 cloud K,
 * 11 November 2026). Providers and Redis are synthetic; the real route runs.
 */
import { NextRequest } from "next/server";
import { POST as buyPackage } from "@/app/api/store/package/route";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setCallPackage,
  setProductCall,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  type Store,
} from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const pipeline = redis.pipeline.bind(redis);
const originalFetch = globalThis.fetch;
const stripeBodies: URLSearchParams[] = [];

process.env.STRIPE_SECRET_KEY = "sk_test_preorder_read_boundary";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    stripeBodies.push(new URLSearchParams(String(init.body)));
    return Response.json({ id: "cs_test_preorderBoundary0001", url: "https://checkout.stripe.com/c/pay/cs_test_preorderBoundary0001" });
  }
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const weekly: CallSetup = {
  kind: "weekly",
  minutes: 60,
  tz: "America/New_York",
  weekly: [[], [[540, 1020]], [], [], [], [], []],
  noticeHours: 12,
  horizonDays: 30,
  bufferMinutes: 0,
  room: "https://example.test/room",
  video: false,
  meet: null,
  seats: 1,
  sessions: [],
} as unknown as CallSetup;

async function callShop(handle: string): Promise<{ store: Store; product: string }> {
  const owner = `${handle}@example.test`;
  const claimed = await claimHandle(owner, handle, "Boundary calls", "");
  if (!claimed.ok) throw new Error("fixture could not claim call store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestPreorder1", true);
  await setSubscription(owner, {
    customerId: `cus_${handle}00001`,
    subscriptionId: `sub_${handle}00001`,
    active: true,
    tier: "creator",
    period: paidPeriod(),
  });
  const made = await addProduct(owner, "Boundary call", "A synthetic call", "120", null);
  if (!made.ok) throw new Error("fixture could not add call");
  if (!(await setProductCall(owner, made.product.id, weekly)).ok) throw new Error("fixture could not set call");
  if (!(await setCallPackage(owner, made.product.id, { sessions: 5, priceCents: 50_000, days: 90 })).ok) throw new Error("fixture could not set package");
  const store = await storeForEmail(owner);
  if (!store) throw new Error("fixture call store not found");
  return { store, product: made.product.id };
}

async function buy(store: Store, product: string, ip: string) {
  const form = new URLSearchParams({ handle: store.handle, product });
  const response = await buyPackage(new NextRequest("https://marktmorgen.test/api/store/package", {
    method: "POST",
    headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip },
    body: form.toString(),
  }));
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

async function main() {
  redis.clear();
  redis.pipeline = pipeline;
  const fixture = await callShop("kpackagelimit");

  part("One connection, many package checkouts in a few minutes");
  stripeBodies.length = 0;
  const answers = [];
  for (let i = 0; i < 25; i++) answers.push(await buy(fixture.store, fixture.product, "203.0.113.7"));
  is("the first ones go to Stripe", answers.slice(0, 20).every((a) => a.location.startsWith("https://checkout.stripe.com/")), true);
  is("never more than 20 checkouts from one connection and store in ten minutes, as the checkout route", stripeBodies.length, 20);
  is("past that, back to the booking page saying it was a lot of tries, nothing opened", answers.slice(20).every((a) => a.status === 303 && a.location.includes(`/@${fixture.store.handle}/book/${fixture.product}?status=slow`)), true);

  part("Control: another connection is not held by the first one");
  const other = await buy(fixture.store, fixture.product, "198.51.100.4");
  is("another connection still gets its checkout", [other.location.startsWith("https://checkout.stripe.com/"), stripeBodies.length], [true, 21]);
  globalThis.fetch = originalFetch;
  done();
}

void main();
