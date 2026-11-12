/**
 * A pre-sale read is a payment boundary. Unknown Redis evidence must never
 * become "not coming soon" and open an ordinary Stripe or PayPal checkout.
 * Providers and Redis are synthetic; the real readers, routes and writers run.
 */
import { NextRequest } from "next/server";
import { POST as paySingle } from "@/app/api/store/checkout/route";
import { POST as payPayPal } from "@/app/api/store/paypal/checkout/route";
import { POST as bookCall } from "@/app/api/store/book/route";
import { POST as buyPackage } from "@/app/api/store/package/route";
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
  await setStripeAccount(owner, "acct_TestPreorder1", true);
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

function intercept(store: Store, mode: Mode): () => void {
  redis.pipeline = async (commands: (string | number)[][]) => {
    const command = commands[0]?.[0];
    const key = commands[0]?.[1];
    if ((command === "SISMEMBER" || command === "SMEMBERS") && key === `nl:wl:${store.statsId}:soon`) {
      if (mode === "throw") throw new Error("synthetic pre-sale read outage");
      if (mode === "null") return commands.length === 1 ? [null] : [null, null];
      if (mode === "short") return [];
      if (mode === "invalid") return commands.length === 1 ? [2] : [2, null];
    }
    return pipeline(commands);
  };
  return () => {
    redis.pipeline = pipeline;
  };
}

async function stripe(mode: Mode) {
  redis.clear();
  redis.pipeline = pipeline;
  stripeBodies.length = 0;
  const fixture = await shop(`c2stripe${mode}`);
  if (mode !== "empty") await setSoon(fixture.store, fixture.product, true);
  const restore = intercept(fixture.store, mode);
  try {
    const form = withConsent(new URLSearchParams({ handle: fixture.store.handle, product: fixture.product }));
    try {
      const response = await paySingle(new NextRequest("https://marktmorgen.test/api/store/checkout", {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }));
      return { status: response.status, location: response.headers.get("location"), opened: stripeBodies.length };
    } catch {
      return { status: -1, location: null, opened: stripeBodies.length };
    }
  } finally {
    restore();
  }
}

async function paypal(mode: Mode) {
  redis.clear();
  redis.pipeline = pipeline;
  paypalOrders = 0;
  const fixture = await shop(`c2paypal${mode}`);
  if (mode !== "empty") await setSoon(fixture.store, fixture.product, true);
  const restore = intercept(fixture.store, mode);
  try {
    const form = withConsent(new URLSearchParams({ handle: fixture.store.handle, product: fixture.product }));
    try {
      const response = await payPayPal(new NextRequest("https://marktmorgen.test/api/store/paypal/checkout", {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }));
      return { status: response.status, location: response.headers.get("location"), opened: paypalOrders };
    } catch {
      return { status: -1, location: null, opened: paypalOrders };
    }
  } finally {
    restore();
  }
}

async function booking(mode: Mode) {
  redis.clear();
  redis.pipeline = pipeline;
  stripeBodies.length = 0;
  const fixture = await callShop(`c2book${mode}`);
  if (mode !== "empty") await setSoon(fixture.store, fixture.product, true);
  const restore = intercept(fixture.store, mode);
  try {
    const form = new URLSearchParams({ handle: fixture.store.handle, product: fixture.product, start: "invalid" });
    const response = await bookCall(new NextRequest("https://marktmorgen.test/api/store/book", {
      method: "POST",
      headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }));
    return { status: response.status, opened: stripeBodies.length, location: response.headers.get("location") };
  } finally {
    restore();
  }
}

async function callPackage(mode: Mode) {
  redis.clear();
  redis.pipeline = pipeline;
  stripeBodies.length = 0;
  const fixture = await callShop(`c2package${mode}`);
  if (mode !== "empty") await setSoon(fixture.store, fixture.product, true);
  const restore = intercept(fixture.store, mode);
  try {
    const form = new URLSearchParams({ handle: fixture.store.handle, product: fixture.product });
    try {
      const response = await buyPackage(new NextRequest("https://marktmorgen.test/api/store/package", {
        method: "POST",
        headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }));
      return { status: response.status, opened: stripeBodies.length, location: response.headers.get("location") };
    } catch {
      return { status: -1, opened: stripeBodies.length, location: null };
    }
  } finally {
    restore();
  }
}

async function main() {
  part("Stripe checkout");
  const stripeComing = await stripe("coming");
  is("confirmed coming-soon opens no Stripe checkout", [stripeComing.status, stripeComing.opened, stripeComing.location?.includes("#waitlist")], [303, 0, true]);
  for (const mode of ["throw", "null", "short", "invalid"] as const) {
    const result = await stripe(mode);
    is(`Stripe ${mode}: unknown pre-sale evidence returns to the explained error before checkout`, [result.status, result.opened, result.location?.includes("status=error")], [303, 0, true]);
  }

  part("PayPal checkout");
  const paypalComing = await paypal("coming");
  is("confirmed coming-soon opens no PayPal order", [paypalComing.status, paypalComing.opened, paypalComing.location?.includes("#waitlist")], [303, 0, true]);
  for (const mode of ["throw", "null", "short", "invalid"] as const) {
    const result = await paypal(mode);
    is(`PayPal ${mode}: unknown pre-sale evidence returns to the explained error before order`, [result.status, result.opened, result.location?.includes("status=error")], [303, 0, true]);
  }

  part("Call booking");
  const bookingComing = await booking("coming");
  is("confirmed coming-soon call stays unavailable", [bookingComing.status, bookingComing.opened], [303, 0]);
  for (const mode of ["throw", "null", "short", "invalid"] as const) {
    const result = await booking(mode);
    is(`booking ${mode}: unknown pre-sale evidence returns to the booking error`, [result.status, result.opened, result.location?.includes("/book/") && result.location.includes("status=error")], [303, 0, true]);
  }

  part("Call package");
  const packageComing = await callPackage("coming");
  is("confirmed coming-soon package stays unavailable", [packageComing.status, packageComing.opened], [303, 0]);
  for (const mode of ["throw", "null", "short", "invalid"] as const) {
    const result = await callPackage(mode);
    is(`package ${mode}: unknown pre-sale evidence returns to the booking error before checkout`, [result.status, result.opened, result.location?.includes("/book/") && result.location.includes("status=error")], [303, 0, true]);
  }
}

void main()
  .then(() => {
    redis.pipeline = pipeline;
    globalThis.fetch = originalFetch;
    done();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
