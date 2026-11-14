/**
 * A store-wide sale or a fair price never takes a product below the currency's smallest charge (DISC-S-1).
 *
 * lib/money.ts holds, for each currency, the smallest price a store may set (minPrice) and the smallest amount Stripe
 * charges (minCharge). A sale (lib/store-sale.ts, saleOff) or a fair price by country (lib/fair-price.ts, fairOff)
 * had no floor: a $1.00 product under a 70% sale showed $0.30, and its checkout asked Stripe for 30 cents, below the
 * 50 it charges, so the buyer met a price the till cannot take. In Canadian dollars minPrice equals minCharge, so any
 * sale on a CA$1.00 product did the same. Every other price (bumps, plans, offers, deposits, a currency change)
 * already keeps the floor.
 *
 * Now a product whose discounted price would fall below its store's smallest charge is not discounted, the same on
 * the page, in the checkout and in the cart, so what is shown is what is charged; every other product keeps its
 * discount.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setCurrency, setFair, setProductLink, setStoreSale, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { createCartCheckout } from "@/lib/cart-checkout";
import { GET as readCart } from "@/app/api/store/cart/route";
import { saleOff, salePrice } from "@/lib/store-sale";
import { fairCouponId, fairOff } from "@/lib/fair-price";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_sale_floor_stand_in";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const OWNER = "floor-usd@example.com";
const HANDLE = "floorshop";
const ACCOUNT = "acct_1TestFloorShop01";
const OWNER_CAD = "floor-cad@example.com";
const HANDLE_CAD = "floorshopca";
const ACCOUNT_CAD = "acct_1TestFloorShopC1";
const ORIGIN = "https://marktmorgen.com";
const SALE_COUPON = "sale_bf_15";
const DAY = 86_400;

// The clock every module reads (Date.now): moved forward only.
const realNow = Date.now;
let clockMs = realNow();
Date.now = () => clockMs;
const at = (seconds: number) => {
  clockMs = seconds * 1000;
};
const nowSec = () => Math.floor(clockMs / 1000);

// ---------------------------------------------------------------------------
// A synthetic Stripe and Resend, routed by path, answering in their real shapes.
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>;
const list = (data: unknown[], hasMore = false): Json => ({ object: "list", data, has_more: hasMore });
const checkouts: URLSearchParams[] = [];
const emails: { to: string; subject: string; text: string }[] = [];
/** The percent each coupon on the creator's account takes off, as Stripe holds it. */
const couponPercent: Record<string, number> = { [SALE_COUPON]: 15 };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    emails.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return answer({ id: `email_${emails.length}` });
  }
  if (url.origin !== "https://api.stripe.com") throw new Error(`no network in this test: ${url}`);
  const path = url.pathname.replace(/^\/v1/, "");
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return answer({ id: `cs_test_${"s".repeat(24)}`, object: "checkout.session", url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/coupons" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    const id = body.get("id") ?? `coupon_${Object.keys(couponPercent).length}`;
    couponPercent[id] = Number(body.get("percent_off"));
    return answer({ id, object: "coupon", percent_off: Number(body.get("percent_off")), duration: body.get("duration"), valid: true });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    return answer(list([]));
  }
  if (method === "GET") return answer(list([]));
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

/** The lines of a checkout as sent: what each costs and how many. */
const linesOf = (body: URLSearchParams) => {
  const out: number[] = [];
  for (let i = 0; body.get(`line_items[${i}][quantity]`) !== null; i += 1) {
    out.push(Number(body.get(`line_items[${i}][price_data][unit_amount]`)) * Number(body.get(`line_items[${i}][quantity]`)));
  }
  return out;
};
/**
 * What Stripe charges for the goods of a checkout as sent: each line less the
 * coupon's percentage, rounded to the smallest unit (the cases used here have
 * no half-unit ties, so the rounding rule for ties does not enter).
 */
const stripeCharges = (body: URLSearchParams) => {
  const coupon = body.get("discounts[0][coupon]");
  const percent = coupon ? couponPercent[coupon] : 0;
  if (coupon && percent === undefined) return null;
  return linesOf(body).reduce((sum, line) => sum + line - Math.round((line * (percent ?? 0)) / 100), 0);
};

async function main(): Promise<void> {
  redis.clear();
  const realError = console.error;
  console.error = () => {};
  const open = async (owner: string, handle: string, account: string, name: string) => {
    await claimHandle(owner, handle, name, "");
    await ensureStatsId(owner);
    await setStripeAccount(owner, account, true);
    await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, period: paidPeriod() });
  };
  const made = async (owner: string, title: string, price: string) => {
    const added = await addProduct(owner, title, "", price, null);
    if (!added.ok) throw new Error(`no ${title}`);
    await setProductLink(owner, added.product.id, `https://example.com/${added.product.id}`);
    return added.product.id;
  };
  await open(OWNER, HANDLE, ACCOUNT, "Floor Shop");
  const guide = await made(OWNER, "Sourdough Guide", "19.99");
  const sticker = await made(OWNER, "Tiny Sticker", "1");
  await open(OWNER_CAD, HANDLE_CAD, ACCOUNT_CAD, "Floor Shop CA");
  is("the Canadian store took its currency before any product", (await setCurrency(OWNER_CAD, "cad")).ok, true);
  const badge = await made(OWNER_CAD, "Badge", "1");
  const zine = await made(OWNER_CAD, "Zine", "5");
  const load = async (owner = OWNER) => (await storeForEmail(owner)) as Store;
  const item = async (id: string, owner = OWNER) => {
    const product = await readProduct(await load(owner), id);
    if (!product) throw new Error(`no product ${id}`);
    return product;
  };
  const checkoutOf = async (id: string, owner = OWNER, country = "") => {
    checkouts.length = 0;
    await createCheckout(await load(owner), await item(id, owner), ORIGIN, "", { digitalConsent: TEST_CONSENT, country });
    return checkouts[0];
  };
  const cartOf = async (ids: string[], owner = OWNER) => {
    checkouts.length = 0;
    const store = await load(owner);
    await createCartCheckout(store, await Promise.all(ids.map((id) => item(id, owner))), ORIGIN, { digitalConsent: TEST_CONSENT });
    return checkouts[0];
  };
  /** The price the product page says now (components/store-product.tsx: salePrice(price, max(sale, fair))). */
  const pagePrice = async (id: string, owner = OWNER, country = "") => {
    const store = await load(owner);
    const product = await item(id, owner);
    return salePrice(product.priceCents, Math.max(saleOff(store.sale, product, nowSec()), fairOff(store.fair, product, country)));
  };
  const cartShows = async (handle: string, ids: string[]) => {
    const response = await readCart(new NextRequest(`${ORIGIN}/api/store/cart?handle=${handle}&ids=${ids.join(",")}`));
    return (await response.json()) as { ok: boolean; items: { id: string; cents: number }[] };
  };

  part("RED: DISC-S-1: a 70% sale never takes a $1.00 product below Stripe's 50 cents");
  const S = nowSec() + 1;
  couponPercent.sale_deep_70 = 70;
  is("the sale is saved", (await setStoreSale(OWNER, { name: "Clearance", percent: 70, starts: S, ends: S + DAY, all: true, products: [], coupon: "sale_deep_70" })).ok, true);
  at(S + 10);
  is("RED: DISC-S-1: the page shows the sticker at its own $1.00", await pagePrice(sticker), 100);
  const one = await checkoutOf(sticker);
  is("RED: DISC-S-1: its checkout carries no sale coupon, so Stripe charges $1.00", [one.get("discounts[0][coupon]"), stripeCharges(one)], [null, 100]);
  is("RED: DISC-S-1: a cart line of the sticker is $1.00", linesOf(await cartOf([sticker])), [100]);
  is("RED: DISC-S-1: the open cart says $1.00 for it", (await cartShows(HANDLE, [sticker])).items.find((i) => i.id === sticker)?.cents, 100);
  is("the guide keeps its sale, $6.00 shown and charged", [await pagePrice(guide), stripeCharges(await checkoutOf(guide))], [600, 600]);
  is("RED: DISC-S-1: a cart of both: the guide at its sale price, the sticker at its own", linesOf(await cartOf([guide, sticker])), [600, 100]);

  part("RED: DISC-S-1: in Canadian dollars the smallest price is the smallest charge");
  couponPercent.sale_ca_10 = 10;
  const C = nowSec() + 1;
  is("a 10% sale is saved", (await setStoreSale(OWNER_CAD, { name: "Spring", percent: 10, starts: C, ends: C + DAY, all: true, products: [], coupon: "sale_ca_10" })).ok, true);
  at(C + 10);
  is("RED: DISC-S-1: a CA$1.00 badge is not taken to CA$0.90", [await pagePrice(badge, OWNER_CAD), stripeCharges(await checkoutOf(badge, OWNER_CAD))], [100, 100]);
  is("a CA$5.00 zine is: CA$4.50", [await pagePrice(zine, OWNER_CAD), stripeCharges(await checkoutOf(zine, OWNER_CAD))], [450, 450]);

  part("RED: DISC-S-1: the same floor for a fair price by country");
  await setStoreSale(OWNER, { name: "", percent: 0, starts: 0, ends: 0, all: true, products: [], coupon: "" });
  await setFair(OWNER, { on: true, auto: false, maxOff: 70, levels: { IN: 60 }, all: true, products: [] });
  couponPercent[fairCouponId(60)] = 60;
  is("RED: DISC-S-1: a buyer in India sees the sticker at $1.00, not $0.40", await pagePrice(sticker, OWNER, "IN"), 100);
  const india = await checkoutOf(sticker, OWNER, "IN");
  is("RED: DISC-S-1: and its checkout carries no fair coupon", [india.get("discounts[0][coupon]"), stripeCharges(india)], [null, 100]);
  is("the guide keeps the fair price there: $8.00", await pagePrice(guide, OWNER, "IN"), 800);

  console.error = realError;
  done();
}

void main();
