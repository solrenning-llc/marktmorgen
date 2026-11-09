/**
 * A partner's share is "X% of what a buyer pays before tax on every sale of <their products>"
 * (lib/buyer-words/affiliates.ts, partnerShare). Shipping is not a product: on an order of several lines (a
 * product added at checkout, or a cart), the shipping is one flat amount for the order (lib/store-checkout.ts,
 * lib/cart-shipping.ts) that no line's partner earns on. Each partner on some lines earns on their lines' part of
 * what was paid before tax and before shipping (`total_details.amount_shipping`, read exactly). A shipping amount
 * that does not read writes no partner's share for the order, never a guessed one, and the order waits for the
 * sweep's next run. A partner on every line, and an order of one product, keep the base as before. Synthetic
 * records, mocked Stripe only.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setProductShipping, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { parseShipping } from "@/lib/shipping";
import { createCheckout } from "@/lib/store-checkout";
import { noteSession, readBook } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner-partner-shipping@example.com";
const ACCOUNT = "acct_1TestPtShip001";
const checkouts: URLSearchParams[] = [];
const refunds: { id: string; object: "refund"; status: string; payment_intent: string; amount: number; created: number }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"q".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  if (path === "/refunds" && method === "GET") return new Response(JSON.stringify({ object: "list", data: refunds, has_more: false }));
  if (method === "GET") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const meta = (sent: URLSearchParams) => {
  const out: Record<string, string> = {};
  for (const [k, v] of sent) {
    const m = /^metadata\[(.+)\]$/.exec(k);
    if (m) out[m[1]] = v;
  }
  return out;
};

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_partner_shipping_only";
  await claimHandle(OWNER, "harborpost", "Harbor Post", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_OwnerShip0001", subscriptionId: "sub_OwnerShip0001", active: true, period: paidPeriod() });
  // A printed Course the creator ships ($30 an order) and a Workbook handed over online, added at checkout.
  const course = await addProduct(OWNER, "Course", "Printed.", "49", null);
  const workbook = await addProduct(OWNER, "Workbook", "", "29", null);
  if (!course.ok || !workbook.ok) throw new Error("no product");
  await setProductLink(OWNER, workbook.product.id, "https://example.com/workbook");
  const shipped = await setProductShipping(OWNER, course.product.id, parseShipping({ cents: 3000, region: "na", note: "Ships within 3 business days" })!);
  if (!shipped.ok) throw new Error(`no shipping: ${shipped.reason}`);
  await setProductExtras(OWNER, course.product.id, { bump: { productId: workbook.product.id, priceCents: 2900, pitch: "" }, slot: 0 });
  const store = (await storeForEmail(OWNER))!;
  const ids = { Course: course.product.id, Workbook: workbook.product.id };

  const partner = (id: string, products: string[]) => ({ id, email: `${id}@example.com`, code: id, status: "approved", appliedAt: 1, decidedAt: 2, note: "", share: { percent: 50, products } });
  const onCourse = partner("dddddddddddd", [ids.Course]);
  const onWorkbook = partner("eeeeeeeeeeee", [ids.Workbook]);
  const onBoth = partner("ffffffffffff", [ids.Course, ids.Workbook]);
  const partners = [onCourse, onWorkbook, onBoth] as never;

  const earned = async (ref: string, aff: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${store.statsId}:shares`, `${ref}:${aff}`]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { base: number; whole?: number }) : null;
  };
  const baseOf = async (ref: string, aff: string) => (await earned(ref, aff))?.base ?? null;
  let n = 0;
  const paid = (metadata: Record<string, string>, money: { subtotal: number; total: number; tax?: number; shipping?: unknown }) => ({
    id: `cs_test_${String(++n).padStart(24, "h")}`, mode: "payment", status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000),
    amount_total: money.total, amount_subtotal: money.subtotal, currency: "usd",
    total_details: { amount_tax: money.tax ?? 0, amount_shipping: "shipping" in money ? money.shipping : 0 }, payment_intent: `pi_test_partnership${n}`,
    metadata, customer_details: { email: "buyer@example.com" },
  });

  checkouts.length = 0;
  await createCheckout(store, (await readProduct(store, ids.Course))!, "https://marktmorgen.com", "", { bumps: [ids.Workbook], digitalConsent: TEST_CONSENT, country: "US" });
  const shipMeta = meta(checkouts[0]);
  is("the order is a shipped one with the Workbook added", [shipMeta.ship, Object.values(shipMeta).includes(ids.Workbook)], ["yes", true]);
  is("the shipping is one flat amount for the order", checkouts[0].get("shipping_options[0][shipping_rate_data][fixed_amount][amount]"), "3000");

  part("Course $49 shipped + Workbook $29 added at checkout, $30 shipping, no tax");
  const order = paid(shipMeta, { subtotal: 7800, total: 10800, shipping: 3000 });
  await noteSession(store, order, new Map(), partners);
  is("the Workbook partner earns on the Workbook's $29, never on the Course's postage", await baseOf(order.id, onWorkbook.id), 2900);
  is("the Course partner earns on the Course's $49; the shipping is no product", await baseOf(order.id, onCourse.id), 4900);
  is("a partner on every line keeps what the buyer paid before tax, as before", await baseOf(order.id, onBoth.id), 10800);
  is("a share of some lines keeps the whole order for refunds", (await earned(order.id, onWorkbook.id))?.whole ?? null, 10800);

  part("A code took 10% off the products, and the tax is added on top");
  const coded = paid(shipMeta, { subtotal: 7800, total: 7020 + 3000 + 562, tax: 562, shipping: 3000 });
  await noteSession(store, coded, new Map(), partners);
  is("the Course partner earns on the Course's part of the products paid before tax", await baseOf(coded.id, onCourse.id), 4410);
  is("the Workbook partner earns on the Workbook's part", await baseOf(coded.id, onWorkbook.id), 2610);
  is("a partner on every line keeps what was paid before tax, as before", await baseOf(coded.id, onBoth.id), 10020);

  part("A shipping amount that does not read: no partner's share is written for that order");
  for (const [label, value] of [["missing", undefined], ["null", null], ["text", "3000"], ["negative", -1], ["not whole cents", 30.5], ["more than was paid before tax", 10801]] as const) {
    const odd = paid(shipMeta, { subtotal: 7800, total: 10800, shipping: value });
    if (value === undefined) delete (odd.total_details as Record<string, unknown>).amount_shipping;
    const outcome = await noteSession(store, odd, new Map(), partners).then(() => "resolved", (error: Error) => error.name);
    is(`${label}: the order is left for the sweep's next run, not dropped`, outcome, "UnknownReplyError");
    is(`${label}: nothing for the Workbook partner`, await baseOf(odd.id, onWorkbook.id), null);
    is(`${label}: nothing for the Course partner`, await baseOf(odd.id, onCourse.id), null);
    is(`${label}: nothing for the partner in both`, await baseOf(odd.id, onBoth.id), null);
  }
  const noDetails = paid(shipMeta, { subtotal: 7800, total: 10800, shipping: 3000 }) as Record<string, unknown>;
  delete noDetails.total_details;
  const noDetailsOutcome = await noteSession(store, noDetails as never, new Map(), partners).then(() => "resolved", (error: Error) => error.name);
  is("no total details at all: the order is left for the sweep's next run", noDetailsOutcome, "UnknownReplyError");
  is("no total details at all: nothing for the Workbook partner", await baseOf(noDetails.id as string, onWorkbook.id), null);

  part("Controls");
  checkouts.length = 0;
  await createCheckout(store, (await readProduct(store, ids.Course))!, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT, country: "US" });
  const solo = paid(meta(checkouts[0]), { subtotal: 4900, total: 7900, shipping: 3000 });
  await noteSession(store, solo, new Map(), partners);
  is("an order of one product is unchanged: what the buyer paid before tax", await baseOf(solo.id, onCourse.id), 7900);
  const noShip = paid(shipMeta, { subtotal: 7800, total: 7800, shipping: 0 });
  await noteSession(store, noShip, new Map(), partners);
  is("no shipping charged: the Workbook partner earns on the Workbook's $29", await baseOf(noShip.id, onWorkbook.id), 2900);
  is("no shipping charged: the Course partner earns on the Course's $49", await baseOf(noShip.id, onCourse.id), 4900);
  const unshippedMeta = { ...shipMeta };
  delete unshippedMeta.ship;
  const unshipped = paid(unshippedMeta, { subtotal: 7800, total: 7800, shipping: null });
  await noteSession(store, unshipped, new Map(), partners);
  is("Stripe's null on an order no shipping was asked for is no shipping: the Workbook's $29", await baseOf(unshipped.id, onWorkbook.id), 2900);
  is("and the Course partner earns on the Course's $49", await baseOf(unshipped.id, onCourse.id), 4900);
  const unshippedMissing = paid(unshippedMeta, { subtotal: 7800, total: 7800 });
  delete (unshippedMissing.total_details as Record<string, unknown>).amount_shipping;
  const unshippedMissingOutcome = await noteSession(store, unshippedMissing, new Map(), partners).then(() => "resolved", (error: Error) => error.name);
  is("a shipping amount missing on an order no shipping was asked for is still not known", unshippedMissingOutcome, "UnknownReplyError");
  is("and nothing is written for the Workbook partner", await baseOf(unshippedMissing.id, onWorkbook.id), null);

  part("A refund names no line: the $29 Workbook given back on the shipped order");
  const commission = async (ref: string, aff: string) => (await readBook(store)).lines.find((l) => l.ref === `${ref}:${aff}`)?.commission ?? null;
  is("before any refund, the Workbook partner earns half of $29", await commission(order.id, onWorkbook.id), 1450);
  is("before any refund, the Course partner earns half of $49", await commission(order.id, onCourse.id), 2450);
  refunds.push({ id: "re_partnership1", object: "refund", status: "succeeded", payment_intent: order.payment_intent, amount: 2900, created: Math.floor(Date.now() / 1000) });
  is("the Workbook partner is not paid on what may be the refunded line", await commission(order.id, onWorkbook.id), 0);
  is("the Course partner keeps half of what no reading of the refund can take ($49 - $29)", await commission(order.id, onCourse.id), 1000);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
