/**
 * A bundle is sold only while every product it would hand over could be sold
 * on its own (lib/bundle-available.ts; Claude 3's ruling, 13 November 2026):
 * none coming soon, none out of license keys, and none whose state cannot be
 * read (CX-123 rule 24). Every way of buying a bundle asks before anything is
 * charged, and each is held here through its real route or writer:
 *
 *   - the single checkout (POST /api/store/checkout) and PayPal (POST
 *     /api/store/paypal/checkout): back to the store page with the
 *     "bundleunready" notice, no checkout or order opened;
 *   - the cart (POST /api/store/cart): the same notice, no checkout opened;
 *   - a box checked at checkout: left off the checkout, the product itself sold;
 *   - an offer after paying (POST /api/store/upsell): answered as unavailable,
 *     nothing charged and nothing written.
 *
 * A bundle whose products are all ready sells on each path as before. Before
 * this, each path sold the bundle: a product not out yet was handed over
 * early, and a key that did not exist was charged for.
 *
 * Real routes and writers, Redis on tests/redis-stub.ts, Stripe and PayPal
 * stand-ins. Synthetic data only; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { POST as paySingle } from "@/app/api/store/checkout/route";
import { POST as payPayPal } from "@/app/api/store/paypal/checkout/route";
import { POST as payCart } from "@/app/api/store/cart/route";
import { POST as upsellRoute } from "@/app/api/store/upsell/route";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setPayPalSeller,
  setProductBundle,
  setProductExtras,
  setProductFunnel,
  setProductKeys,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  type Store,
} from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { setSoon } from "@/lib/waitlist";
import { UPSELL_COOKIE, newUpsellKey, offerRef, readUpsell } from "@/lib/upsell";
import { CONSENT_FIELD, CONSENT_VERSION_FIELD } from "@/lib/digital-consent";
import { TEST_CONSENT, withConsent } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_bundle_unavailable_paths";
process.env.RESEND_API_KEY = "re_test_bundle_unavailable_paths";
process.env.PAYPAL_PARTNER_CLIENT_ID = "partner_client_test";
process.env.PAYPAL_PARTNER_SECRET = "partner_secret_test";
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNER00001";
process.env.PAYPAL_BN_CODE = "marktmorgen_test_bn";

const OWNER = "bundler@example.test";
const HANDLE = "bundlery";
const ACCOUNT = "acct_1TestBundleRdy";
const NOW = Math.floor(Date.now() / 1000);
const pipeline = redis.pipeline.bind(redis);

const opened: URLSearchParams[] = [];
const charges: URLSearchParams[] = [];
const sessions: Record<string, Record<string, unknown>> = {};
let paypalOrders = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  if (url.hostname === "api.stripe.com") {
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/checkout/sessions" && method === "POST") {
      opened.push(new URLSearchParams(String(init?.body)));
      const id = `cs_test_bundleOpen${String(opened.length).padStart(6, "0")}`;
      return answer({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    const one = /^\/checkout\/sessions\/(cs_test_[A-Za-z0-9]+)$/.exec(path);
    if (one && method === "GET") return sessions[one[1]] ? answer(sessions[one[1]]) : answer({ error: { message: "no such checkout" } }, 404);
    if (path === "/payment_intents" && method === "POST") {
      const body = new URLSearchParams(String(init?.body));
      charges.push(body);
      return answer({
        id: `pi_test_${String(charges.length).padStart(10, "0")}`,
        object: "payment_intent",
        amount: Number(body.get("amount")),
        currency: body.get("currency"),
        status: "succeeded",
        created: NOW,
        metadata: Object.fromEntries([...body].filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v])),
      });
    }
    return answer({ object: "list", data: [], has_more: false });
  }
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v1/oauth2/token") return answer({ access_token: "synthetic_paypal_token", expires_in: 3_600 });
  if (url.hostname === "api-m.paypal.com" && url.pathname === "/v2/checkout/orders" && method === "POST") {
    paypalOrders += 1;
    const id = `ORDER${String(paypalOrders).padStart(6, "0")}`;
    return answer({ id, links: [{ rel: "approve", href: `https://www.paypal.com/checkoutnow?token=${id}` }] });
  }
  return answer({}, 404);
}) as typeof fetch;

type Shop = { store: () => Promise<Store>; ready: string; soon: string; keyless: string; plain: string; front: string };

async function shop(): Promise<Shop> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Bundlery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Owner00031", subscriptionId: "sub_Owner00031", active: true, tier: "creator", period: paidPeriod() });
  await setPayPalSeller(OWNER, "SELLER000031");
  const add = async (title: string, price: string) => {
    const made = await addProduct(OWNER, title, "A synthetic product", price, null);
    if (!made.ok) throw new Error(`no product ${title}`);
    await setProductLink(OWNER, made.product.id, `https://example.test/${made.product.id}`);
    return made.product.id;
  };
  const guide = await add("Glaze Guide", "19");
  const workbook = await add("Kiln Workbook", "15");
  const notYet = await add("Firing Masterclass", "39");
  const app = await add("Firing App", "29");
  await setProductKeys(OWNER, app, { source: "pool", prefix: "", groups: 4, groupLength: 4, lowAt: 0 });
  const front = await add("Wheel Basics", "25");
  const bundle = async (title: string, items: string[]) => {
    const made = await addProduct(OWNER, title, "A synthetic bundle", "49", null);
    if (!made.ok) throw new Error(`no product ${title}`);
    const id = made.product.id;
    const set = await setProductBundle(OWNER, id, items);
    if (!set.ok) throw new Error(`no bundle ${title}: ${JSON.stringify(set)}`);
    return id;
  };
  const ready = await bundle("Studio Set", [guide, workbook]);
  const soon = await bundle("Early Set", [guide, notYet]);
  const keyless = await bundle("App Set", [guide, app]);
  const store = () => storeForEmail(OWNER).then((s) => s!);
  await setSoon(await store(), notYet, true);
  return { store, ready, soon, keyless, plain: guide, front };
}

const post = (path: string, form: URLSearchParams, cookie = "") =>
  new NextRequest(`https://marktmorgen.test${path}`, {
    method: "POST",
    headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: form.toString(),
  });

/** What a press did: where it went, and how many checkouts or orders it opened. */
async function press(run: () => Promise<Response>, count: () => number): Promise<{ status: number; notice: boolean; opened: number }> {
  const before = count();
  const response = await run();
  const location = response.headers.get("location") ?? "";
  return { status: response.status, notice: location.includes("status=bundleunready"), opened: count() - before };
}

async function main(): Promise<void> {
  const s = await shop();
  const stripeCount = () => opened.length;

  part("Single checkout");
  const single = (id: string) => () => paySingle(post("/api/store/checkout", withConsent(new URLSearchParams({ handle: HANDLE, product: id }))));
  is("coming soon inside: the notice, no checkout opened", await press(single(s.soon), stripeCount), { status: 303, notice: true, opened: 0 });
  is("out of keys inside: the notice, no checkout opened", await press(single(s.keyless), stripeCount), { status: 303, notice: true, opened: 0 });
  is("control: a ready bundle opens its checkout", await press(single(s.ready), stripeCount), { status: 303, notice: false, opened: 1 });

  part("Single checkout, the coming-soon list cannot be read");
  redis.pipeline = async (commands) => {
    if (commands.length === 1 && commands[0][0] === "SMEMBERS" && String(commands[0][1]).endsWith(":soon")) return [null];
    return pipeline(commands);
  };
  try {
    is("unknown is never ready: the notice, no checkout opened", await press(single(s.ready), stripeCount), { status: 303, notice: true, opened: 0 });
  } finally {
    redis.pipeline = pipeline;
  }

  part("PayPal");
  const paypal = (id: string) => () => payPayPal(post("/api/store/paypal/checkout", withConsent(new URLSearchParams({ handle: HANDLE, product: id }))));
  const paypalCount = () => paypalOrders;
  is("coming soon inside: the notice, no order made", await press(paypal(s.soon), paypalCount), { status: 303, notice: true, opened: 0 });
  is("out of keys inside: the notice, no order made", await press(paypal(s.keyless), paypalCount), { status: 303, notice: true, opened: 0 });
  is("control: a ready bundle makes its order", await press(paypal(s.ready), paypalCount), { status: 303, notice: false, opened: 1 });

  part("Cart");
  const cart = (id: string) => () => {
    const form = withConsent(new URLSearchParams({ handle: HANDLE }));
    form.append("id", id);
    form.append("id", s.plain);
    return payCart(post("/api/store/cart", form));
  };
  is("coming soon inside: the notice, no checkout opened", await press(cart(s.soon), stripeCount), { status: 303, notice: true, opened: 0 });
  is("out of keys inside: the notice, no checkout opened", await press(cart(s.keyless), stripeCount), { status: 303, notice: true, opened: 0 });
  is("control: a ready bundle in a cart opens its checkout", await press(cart(s.ready), stripeCount), { status: 303, notice: false, opened: 1 });

  part("A box checked at checkout");
  const box = async (target: string) => {
    const set = await setProductExtras(OWNER, s.front, { bump: { productId: target, priceCents: 1_000, pitch: "Add the set" }, slot: 0 });
    if (!set.ok) throw new Error(`no box: ${JSON.stringify(set)}`);
    const form = withConsent(new URLSearchParams({ handle: HANDLE, product: s.front }));
    form.append("bump", target);
    const before = opened.length;
    const response = await paySingle(post("/api/store/checkout", form));
    const body = opened[before];
    return { status: response.status, opened: opened.length - before, boxed: body ? body.get("metadata[bump]") : "none" };
  };
  is("coming soon inside: the product is sold, the box left off", await box(s.soon), { status: 303, opened: 1, boxed: null });
  is("out of keys inside: the box left off", await box(s.keyless), { status: 303, opened: 1, boxed: null });
  is("control: a ready bundle's box goes on the checkout", await box(s.ready), { status: 303, opened: 1, boxed: s.ready });

  part("An offer after paying");
  const browser = newUpsellKey();
  let n = 0;
  const offer = async (target: string) => {
    const saved = await setProductFunnel(OWNER, s.front, { steps: [{ id: "set1", productId: target, priceCents: 1_900, headline: "", text: "", imageFrom: null, yes: null, no: null }] });
    if (!saved.ok) throw new Error(`no funnel: ${JSON.stringify(saved)}`);
    n += 1;
    const session = `cs_test_bundleOffer${String(n).padStart(6, "0")}`;
    sessions[session] = {
      id: session,
      status: "complete",
      payment_status: "paid",
      created: NOW - 60,
      customer: "cus_TestBuyer31",
      currency: "usd",
      metadata: { store: HANDLE, product: s.front, upsell_key: browser.fingerprint },
      customer_details: { email: "buyer@example.test" },
      payment_intent: { id: `pi_test_front${String(n).padStart(6, "0")}`, payment_method: { id: "pm_test_card0031", type: "card", customer: "cus_TestBuyer31" } },
    };
    const current = await s.store();
    const step = (await readProduct(current, s.front))!.funnel!.steps[0];
    const form = new FormData();
    form.set("handle", HANDLE);
    form.set("session_id", session);
    form.set("step", offerRef(current, step, (await readListing(current, target))!));
    form.set("answer", "yes");
    form.set(CONSENT_FIELD, "yes");
    form.set(CONSENT_VERSION_FIELD, TEST_CONSENT.version);
    const before = charges.length;
    const response = await upsellRoute(new NextRequest("https://marktmorgen.test/api/store/upsell", { method: "POST", body: form, headers: { host: "marktmorgen.test", cookie: `${UPSELL_COOKIE}=${browser.secret}` } }));
    const said = new URL(response.headers.get("location") ?? "https://x.invalid/").searchParams.get("upsell");
    return { said, charges: charges.length - before, written: (await readUpsell(session))?.state ?? null };
  };
  is("coming soon inside: unavailable, nothing charged or written", await offer(s.soon), { said: "unavailable", charges: 0, written: null });
  is("out of keys inside: unavailable, nothing charged or written", await offer(s.keyless), { said: "unavailable", charges: 0, written: null });
  is("control: a ready bundle offered is charged once", await offer(s.ready), { said: "done", charges: 1, written: "paid" });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
