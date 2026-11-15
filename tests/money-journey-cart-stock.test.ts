/**
 * Money journey, end to end: a cart of several products, two of them
 * limited, with the store's deal for buying more (C2-159 item 4, part 2).
 * The other tests check each step on its own (tests/cart-stock.test.ts,
 * tests/cart-offers.test.ts, tests/purchase-email-paid-line.test.ts); this
 * one walks a buyer through all of them in order, with the real code at every
 * step and only Stripe and the email sender simulated:
 *
 *   1. the creator's store: three products at $20, one limited to a single
 *      unit and one to five, and 10% off a cart of three;
 *   2. the buyer pays for the cart through the real route
 *      (POST /api/store/cart): one checkout on the creator's own account,
 *      three lines at $18 each, the deal written on the order, one unit of
 *      each limited product held;
 *   3. a second buyer with the same cart is sent back to it (sold out), and no
 *      checkout is opened for them;
 *   4. Stripe says the first checkout is paid: readOrder hands over the
 *      three products (the first as the order's own, the other two as its
 *      added lines), for the $54 charged;
 *   5. the thanks page's own steps turn the held units into sales, and the
 *      units stay sold after the hold's time has run out;
 *   6. a third buyer who pays but never comes back to the thanks page: the
 *      units are still never handed back once the hold has run out, because
 *      Stripe says the checkout was paid;
 *   7. the buyer's confirmation is sent once, for the $54 paid, and the order
 *      is counted once; a second try sends nothing more.
 *
 * Each step reads what the previous one wrote, so a break anywhere fails the
 * journey. Synthetic data only: no real Stripe, email or Redis.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as payCart } from "@/app/api/store/cart/route";
import { readListing } from "@/lib/catalog";
import { readOrder } from "@/lib/store-checkout";
import { confirmCartStock, confirmStock, stockLeft } from "@/lib/stock";
import { confirmPurchase } from "@/lib/purchase-email";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setCartDeal,
  setProductExtras,
  setProductLink,
  setStripeAccount,
  setSubscription,
  storeForEmail,
} from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { TEST_CONSENT } from "./digital-consent-fixture";

const OWNER = "kiln@example.com";
const HANDLE = "kilnhouse";
const ACCOUNT = "acct_1TestKiln00001";

/** Every checkout Stripe was asked to open, with the account it was opened on. */
const opened: { id: string; body: URLSearchParams; account: string | null }[] = [];
/** What Stripe answers about each checkout: open until the buyer pays. */
const sessions = new Map<string, Record<string, unknown>>();
const emails: { to: string[]; subject: string; text: string }[] = [];
/** As Stripe answers: the payment is only its id unless the request expanded it. */
const asAsked = (session: Record<string, unknown>, url: URL) => {
  const pi = session.payment_intent as { id?: string } | string | undefined;
  const expanded = url.searchParams.getAll("expand[]").some((field) => field.startsWith("payment_intent"));
  return pi && typeof pi === "object" && !expanded ? { ...session, payment_intent: pi.id } : session;
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: `email_${emails.length}` }));
  }
  if (url.hostname !== "api.stripe.com") return new Response("{}", { status: 404 });
  if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
    const id = `cs_test_journeycart${String(opened.length + 1).padStart(6, "0")}`;
    opened.push({ id, body: new URLSearchParams(String(init?.body)), account: new Headers(init?.headers).get("Stripe-Account") });
    sessions.set(id, { id, object: "checkout.session", status: "open", payment_status: "unpaid" });
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }));
  }
  const expire = /^\/v1\/checkout\/sessions\/([^/]+)\/expire$/.exec(url.pathname);
  if (expire && method === "POST") {
    const now = sessions.get(expire[1]);
    if (now?.status === "complete") return new Response(JSON.stringify({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }), { status: 400 });
    sessions.set(expire[1], { ...(now ?? { id: expire[1] }), status: "expired" });
    return new Response(JSON.stringify(sessions.get(expire[1])));
  }
  const one = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
  if (one && method === "GET") {
    const found = sessions.get(decodeURIComponent(one[1]));
    if (!found) return new Response(JSON.stringify({ error: { message: "No such checkout.session" } }), { status: 404 });
    return new Response(JSON.stringify(asAsked(found, url)));
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

/** What was sent as `metadata[...]` on a checkout, as Stripe hands it back. */
function metadataOf(body: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of body) {
    const name = /^metadata\[([^\]]+)\]$/.exec(key);
    if (name) out[name[1]] = value;
  }
  return out;
}

/** Each line of a checkout: its unit amount, quantity and currency. */
function linesOf(body: URLSearchParams): { cents: number; quantity: number; currency: string; name: string }[] {
  const out: { cents: number; quantity: number; currency: string; name: string }[] = [];
  for (let i = 0; body.has(`line_items[${i}][quantity]`); i += 1) {
    out.push({
      cents: Number(body.get(`line_items[${i}][price_data][unit_amount]`)),
      quantity: Number(body.get(`line_items[${i}][quantity]`)),
      currency: body.get(`line_items[${i}][price_data][currency]`) ?? "",
      name: body.get(`line_items[${i}][price_data][product_data][name]`) ?? "",
    });
  }
  return out;
}

/** Stripe takes the payment for an opened checkout: it reads back as complete and paid, for what its lines add up to. */
function stripePays(id: string, email: string): number {
  const made = opened.find((entry) => entry.id === id);
  if (!made) throw new Error(`no checkout ${id}`);
  const total = linesOf(made.body).reduce((sum, line) => sum + line.cents * line.quantity, 0);
  sessions.set(id, {
    id,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: made.body.get("mode"),
    currency: made.body.get("line_items[0][price_data][currency]"),
    amount_subtotal: total,
    amount_total: total,
    total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
    created: Math.floor(Date.now() / 1000),
    customer_details: { email },
    metadata: metadataOf(made.body),
    payment_intent: {
      id: `pi_test_journeycart${id.slice(-6)}`,
      object: "payment_intent",
      status: "succeeded",
      latest_charge: { id: `ch_test_journeycart${id.slice(-6)}`, object: "charge", amount: total, amount_refunded: 0, refunded: false, disputed: false },
      payment_method: { type: "card" },
    },
  });
  return total;
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_journey_cart_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

  part("1. The creator's store");
  await claimHandle(OWNER, HANDLE, "Kiln House", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_Kiln000001", subscriptionId: "sub_Kiln000001", active: true, period: paidPeriod() });
  const ids: Record<string, string> = {};
  for (const title of ["Glaze Guide", "Mug Print", "Bowl Print"]) {
    const added = await addProduct(OWNER, title, "", "20", null);
    if (!added.ok) throw new Error(`no ${title}`);
    ids[title] = added.product.id;
    await setProductLink(OWNER, added.product.id, `https://example.com/${added.product.id}`);
  }
  for (const [title, stock] of [["Mug Print", 1], ["Bowl Print", 5]] as const) {
    const set = await setProductExtras(OWNER, ids[title], { stock });
    if (!set.ok) throw new Error(`no stock on ${title}`);
  }
  await setCartDeal(OWNER, { on: true, min: 3, percent: 10 });
  const store = async () => (await storeForEmail(OWNER))!;
  const listing = async (title: string) => (await readListing(await store(), ids[title]))!;
  is("the deal is on for a cart of three", (await store()).cartDeal, { on: true, min: 3, percent: 10 });
  is("both limited products start with every unit", [await stockLeft(await store(), await listing("Mug Print")), await stockLeft(await store(), await listing("Bowl Print"))], [1, 5]);

  const cart = [ids["Glaze Guide"], ids["Mug Print"], ids["Bowl Print"]];
  const pay = async (products: string[]) => {
    const form = new URLSearchParams({ handle: HANDLE, dc: "yes", dc_v: TEST_CONSENT.version });
    for (const id of products) form.append("id", id);
    const before = opened.length;
    const answer = await payCart(
      new NextRequest("https://marktmorgen.com/api/store/cart", {
        method: "POST",
        headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
    );
    const where = new URL(answer.headers.get("location") ?? "https://nowhere.invalid/");
    return { status: answer.status, stripe: where.hostname === "checkout.stripe.com", back: where.search, made: opened.slice(before) };
  };

  part("2. The buyer pays for the cart through the real route");
  const first = await pay(cart);
  is("sent to Stripe, with exactly one checkout opened", [first.stripe, first.made.length], [true, 1]);
  const checkout = first.made[0];
  is("on the creator's own connected account", checkout.account, ACCOUNT);
  is("a one-time payment, never routed through the platform", [checkout.body.get("mode"), [...checkout.body.keys()].filter((key) => /transfer_data|on_behalf_of|application_fee/.test(key))], ["payment", []]);
  is(
    "three lines, each $20 less the 10% deal, in the store's currency",
    linesOf(checkout.body).map((line) => [line.name, line.cents, line.quantity, line.currency]),
    [["Glaze Guide", 1800, 1, "usd"], ["Mug Print", 1800, 1, "usd"], ["Bowl Print", 1800, 1, "usd"]],
  );
  const meta = metadataOf(checkout.body);
  is("the order names the store, the cart, its deal and every product", [meta.store, meta.cart, meta.cart_deal, meta.product, meta.bump, meta.bump2], [HANDLE, "yes", "10", ids["Glaze Guide"], ids["Mug Print"], ids["Bowl Print"]]);
  is("each added line carries what it was charged", [meta.bump_cents, meta.bump2_cents], ["1800", "1800"]);
  is("one code at a time: no code box once the deal took something off", [checkout.body.get("allow_promotion_codes"), checkout.body.get("discounts[0][promotion_code]")], [null, null]);
  is("the checkout closes before the held units run out", Number(checkout.body.get("expires_at")) > Math.floor(Date.now() / 1000), true);
  is("one unit of each limited product is held for it", [await stockLeft(await store(), await listing("Mug Print")), await stockLeft(await store(), await listing("Bowl Print"))], [0, 4]);

  part("3. A second buyer with the same cart");
  const second = await pay(cart);
  is("sent back to the cart, which says it changed; no checkout opened", [second.stripe, second.back, second.made.length], [false, "?cart=changed", 0]);
  is("and nothing more is held", await stockLeft(await store(), await listing("Bowl Print")), 4);

  part("4. Stripe says the first checkout is paid");
  const charged = stripePays(checkout.id, "potter@example.com");
  is("Stripe charged the three lines: $54", charged, 5400);
  const order = await readOrder(await store(), checkout.id);
  if (order.state !== "paid") throw new Error(`the paid cart reads as ${order.state}`);
  is("the order is paid, for $54, to the buyer's address", [order.amount, order.currency, order.email], [5400, "usd", "potter@example.com"]);
  is("the first product is the order's own, the other two its added lines", [order.product.id, order.bumps.map((added) => [added.key, added.product.id])], [ids["Glaze Guide"], [["bump", ids["Mug Print"]], ["bump2", ids["Bowl Print"]]]]);
  is("every product hands over its link", [order.link, ...order.bumps.map((added) => added.link)], cart.map((id) => `https://example.com/${id}`));
  is("a checkout of another store's handle opens nothing here", await readOrder({ ...(await store()), handle: "elsewhere", previousHandles: [] } as Awaited<ReturnType<typeof store>>, checkout.id).then((o) => o.state), "invalid");

  part("5. The thanks page turns the held units into sales");
  // The thanks page's own two calls (app/[handle]/thanks/page.tsx), checked in its source below.
  const thanks = readFileSync("app/[handle]/thanks/page.tsx", "utf8");
  is("the thanks page confirms the order's own limited product", /order\.state === "paid" && sessionId && order\.product\.stock !== null\)\s*\{\s*await confirmStock\(store, order\.product, sessionId\)/.test(thanks), true);
  is("and each limited product among the cart's added lines", /await confirmCartStock\(store, order\.bumps\.map\(\(added\) => added\.product\), sessionId\)/.test(thanks), true);
  if (order.product.stock !== null) await confirmStock(await store(), order.product, checkout.id);
  if (order.bumps.some((added) => added.product.stock !== null)) await confirmCartStock(await store(), order.bumps.map((added) => added.product), checkout.id);
  const statsId = (await store()).statsId as string;
  const held = async (title: string) => (await redis.pipeline([["HGET", `nl:stock:${statsId}:${ids[title]}`, checkout.id]]))[0];
  is(
    "each limited unit is written down as sold to this checkout at once, without waiting for its hold to run out",
    [await held("Mug Print"), await held("Bowl Print")],
    [JSON.stringify({ until: 0, paid: true }), JSON.stringify({ until: 0, paid: true })],
  );
  const later = Date.now() + 3 * 60 * 60 * 1000;
  is("sold: the units stay taken after the hold's time is over", [await stockLeft(await store(), await listing("Mug Print"), later), await stockLeft(await store(), await listing("Bowl Print"), later)], [0, 4]);

  part("6. A buyer who pays but never comes back");
  const third = await pay([ids["Glaze Guide"], ids["Bowl Print"]]);
  is("a cart of two opens, without the deal for three", [third.stripe, linesOf(third.made[0].body).map((line) => line.cents)], [true, [2000, 2000]]);
  is("one more unit held", await stockLeft(await store(), await listing("Bowl Print")), 3);
  stripePays(third.made[0].id, "glazer@example.com");
  is(
    "paid at Stripe but never confirmed here: the unit is not handed back once the hold has run out",
    await stockLeft(await store(), await listing("Bowl Print"), later),
    3,
  );
  const fourth = await pay([ids["Glaze Guide"], ids["Bowl Print"]]);
  is("a fourth buyer can still take one of the units really left", [fourth.stripe, await stockLeft(await store(), await listing("Bowl Print"))], [true, 2]);
  // Its time is up and the buyer never paid: Stripe has closed it.
  sessions.set(fourth.made[0].id, { ...sessions.get(fourth.made[0].id), status: "expired" });
  is("an unpaid checkout's unit does come back once its hold has run out and Stripe closed it", await stockLeft(await store(), await listing("Bowl Print"), later), 3);

  part("7. The buyer's confirmation, once");
  const sent = await confirmPurchase(await store(), checkout.id);
  is("sent", sent, "sent");
  const mine = emails.filter((email) => email.to.includes("potter@example.com"));
  is("one email, to the buyer", mine.length, 1);
  const text = mine[0]?.text ?? "";
  is("it names every product bought", ["Glaze Guide", "Mug Print", "Bowl Print"].every((title) => text.includes(title)), true);
  is("and says what was paid: $54", text.split("\n").find((line) => line.startsWith("Paid:")) ?? "", "Paid: $54");
  is("a second try sends nothing more", [await confirmPurchase(await store(), checkout.id), emails.filter((email) => email.to.includes("potter@example.com")).length], ["already", 1]);

  done();
}

void main();
