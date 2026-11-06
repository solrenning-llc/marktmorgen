/**
 * Claude 2 review proof for #2846 (not part of the PR). A pre-sale read is a payment boundary. Unknown Redis evidence must never
 * become "not coming soon" and open an ordinary Stripe or PayPal checkout.
 * Providers and Redis are synthetic; the real readers, routes and writers run.
 */
import { NextRequest } from "next/server";
import { POST as paySingle } from "@/app/api/store/checkout/route";
import { POST as payPayPal } from "@/app/api/store/paypal/checkout/route";
import { POST as bookCall } from "@/app/api/store/book/route";
import { POST as buyPackage } from "@/app/api/store/package/route";
import { POST as payCart } from "@/app/api/store/cart/route";
import { soonState, soonOne, isComingSoon } from "@/lib/preorders";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setCallPackage,
  setPayPalSeller,
  setProductCall,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  type Store,
} from "@/lib/store";
import type { CallSetup } from "@/lib/call-setup";
import { setSoon } from "@/lib/waitlist";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Mode = "empty" | "coming" | "throw" | "null" | "short" | "invalid";

const pipeline = redis.pipeline.bind(redis);
const originalFetch = globalThis.fetch;
const stripeBodies: URLSearchParams[] = [];
let paypalOrders = 0;

process.env.STRIPE_SECRET_KEY = "sk_test_preorder_read_boundary";
process.env.PAYPAL_PARTNER_CLIENT_ID = "partner_client_test";
process.env.PAYPAL_PARTNER_SECRET = "partner_secret_test";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNER00001";
process.env.PAYPAL_BN_CODE = "marktmorgen_test_bn";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    stripeBodies.push(new URLSearchParams(String(init.body)));
    return Response.json({ id: "cs_test_preorderBoundary0001", url: "https://checkout.stripe.com/c/pay/cs_test_preorderBoundary0001" });
  }
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v1/oauth2/token") {
    return Response.json({ access_token: "synthetic_paypal_token", expires_in: 3_600 });
  }
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v2/checkout/orders" && init?.method === "POST") {
    paypalOrders += 1;
    return Response.json({
      id: `ORDER${String(paypalOrders).padStart(6, "0")}`,
      links: [{ rel: "approve", href: `https://www.paypal.com/checkoutnow?token=ORDER${String(paypalOrders).padStart(6, "0")}` }],
    });
  }
  return Response.json({}, { status: 404 });
}) as typeof fetch;

async function shop(handle: string): Promise<{ store: Store; product: string }> {
  const owner = `${handle}@example.test`;
  const claimed = await claimHandle(owner, handle, "Boundary shop", "");
  if (!claimed.ok) throw new Error("fixture could not claim store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_PreorderBoundary01", true);
  await setSubscription(owner, {
    customerId: `cus_${handle}00001`,
    subscriptionId: `sub_${handle}00001`,
    active: true,
    tier: "creator",
    period: paidPeriod(),
  });
  await setPayPalSeller(owner, "SELLER000001");
  const made = await addProduct(owner, "Boundary guide", "A synthetic guide", "19", null);
  if (!made.ok) throw new Error("fixture could not add product");
  await setProductLink(owner, made.product.id, "https://example.test/guide");
  const store = await storeForEmail(owner);
  if (!store) throw new Error("fixture store not found");
  return { store, product: made.product.id };
}

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
  await setStripeAccount(owner, "acct_PreorderBoundary01", true);
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


type Shape = "good" | "daysOdd" | "daysObject" | "daysNumber" | "membersMixed";
function shaped(store: Store, product: string, shape: Shape): () => void {
  redis.pipeline = async (commands: (string | number)[][]) => {
    if (commands[0]?.[0] === "SMEMBERS" && commands[0]?.[1] === `nl:wl:${store.statsId}:soon`) {
      const real = await pipeline(commands);
      if (shape === "daysOdd") return [real[0], [product]];
      if (shape === "daysObject") return [real[0], { [product]: "2027-01-01" }];
      if (shape === "daysNumber") return [real[0], [product, 5]];
      if (shape === "membersMixed") return [[product, 5], real[1]];
      return real;
    }
    return pipeline(commands);
  };
  return () => { redis.pipeline = pipeline; };
}

async function cart(shape: Shape) {
  redis.clear();
  redis.pipeline = pipeline;
  stripeBodies.length = 0;
  const fixture = await shop(`c2cart${shape.toLowerCase()}`);
  await setSoon(fixture.store, fixture.product, true);
  const restore = shaped(fixture.store, fixture.product, shape);
  try {
    const form = withConsent(new URLSearchParams({ handle: fixture.store.handle, id: fixture.product }));
    let threw = "no";
    const state = await soonState(fixture.store).then((s) => (s.soon.has(fixture.product) ? "soon" : "not-soon")).catch(() => (threw = "threw"));
    try {
      const response = await payCart(new NextRequest("https://marktmorgen.test/api/store/cart", {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }));
      return { state, threw, status: response.status, location: response.headers.get("location"), opened: stripeBodies.length };
    } catch {
      return { state, threw, status: -1, location: null, opened: stripeBodies.length };
    }
  } finally {
    restore();
  }
}

async function readers() {
  redis.clear();
  redis.pipeline = pipeline;
  const fixture = await shop("c2readers");
  await setSoon(fixture.store, fixture.product, true);
  const results: Record<string, string> = {};
  const replies: [string, unknown[]][] = [["1.0", [1.0]], ["true", [true]], ["'01'", ["01"]], ["[1]", [[1]]], ["undefined", [undefined]], ["two", [1, 1]]];
  for (const [label, reply] of replies) {
    redis.pipeline = async (commands) => (commands[0]?.[0] === "SISMEMBER" ? reply : pipeline(commands));
    results[label] = await isComingSoon(fixture.store, fixture.product).then(String).catch(() => "threw");
  }
  redis.pipeline = async (commands) => (commands[0]?.[0] === "SISMEMBER" ? [1, 7] : pipeline(commands));
  results["soonOne day=7"] = await soonOne(fixture.store, fixture.product).then((r) => JSON.stringify(r)).catch(() => "threw");
  redis.pipeline = pipeline;
  return results;
}

async function main() {
  part("Exact reader edge shapes");
  const r = await readers();
  is("isComingSoon: 1.0 is the number 1 (JSON has no separate float), known true", r["1.0"], "true");
  for (const k of ["true", "'01'", "[1]", "undefined", "two"]) is(`isComingSoon ${k}: unknown, throws`, r[k], "threw");
  is("soonOne non-string day: unknown, throws", r["soonOne day=7"], "threw");

  part("Cart POST (untouched consumer) with SMEMBERS correct and the product coming soon");
  const good = await cart("good");
  is("control: exact replies -> soon, cart refuses, no Stripe session", [good.state, good.opened], ["soon", 0]);
  for (const shape of ["daysOdd", "daysObject", "daysNumber", "membersMixed"] as const) {
    const res = await cart(shape);
    console.log(shape, JSON.stringify(res));
    is(`${shape}: coming-soon product must not open a Stripe cart checkout`, res.opened, 0);
  }
}

void main()
  .then(() => { redis.pipeline = pipeline; globalThis.fetch = originalFetch; done(); })
  .catch((error) => { console.error(error); process.exitCode = 2; });
