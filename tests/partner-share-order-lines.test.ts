/**
 * A partner's share is "X% of what a buyer pays before tax on every sale of <their products>"
 * (lib/buyer-words/affiliates.ts, partnerShare). On an order with more than one line (a product added at
 * checkout, or a cart), each partner's base is the part of the order paid for the lines of the products they
 * share in, each line weighed by what it was charged (`<bump>_cents`, the rest of the subtotal for the order's
 * own product), with what the code took off and the shipping shared the same way and the tax left out.
 * A line whose price does not read writes no partner's share at all for that order, never a guessed base, and
 * the order is left for the sweep's next run (noteSession rejects). A refund names no line, so a partner on some
 * lines of an order keeps only what no reading of the refund can take; a partner on every line, and an order of
 * one product, keep the share in proportion as before. An order whose every line is free gives a partner on some
 * lines nothing. An order of one product is unchanged: the whole amount before tax. Synthetic records, mocked
 * Stripe only.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { createCheckout } from "@/lib/store-checkout";
import { createCartCheckout } from "@/lib/cart-checkout";
import { noteSession, readBook } from "@/lib/affiliates";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner-partner-lines@example.com";
const ACCOUNT = "acct_1TestPartnerLines1";
const checkouts: URLSearchParams[] = [];
const refunds: { id: string; object: "refund"; status: string; payment_intent: string; amount: number; created: number }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    checkouts.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"p".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
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
  process.env.STRIPE_SECRET_KEY = "sk_test_partner_lines_only";
  await claimHandle(OWNER, "harborlines", "Harbor Lines", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, ACCOUNT, true);
  await setSubscription(OWNER, { customerId: "cus_OwnerLines001", subscriptionId: "sub_OwnerLines001", active: true, period: paidPeriod() });
  const ids: Record<string, string> = {};
  for (const [title, price] of [["Course", "49"], ["Workbook", "29"]]) {
    const made = await addProduct(OWNER, title, "", price, null);
    if (!made.ok) throw new Error(`no ${title}`);
    ids[title] = made.product.id;
    await setProductLink(OWNER, made.product.id, `https://example.com/${title.toLowerCase()}`);
  }
  await setProductExtras(OWNER, ids.Course, { bump: { productId: ids.Workbook, priceCents: 2900, pitch: "" }, slot: 0 });
  const store = (await storeForEmail(OWNER))!;
  const course = (await readProduct(store, ids.Course))!;
  const workbook = (await readProduct(store, ids.Workbook))!;

  // Three partners at 50%: one in the Course only, one in the Workbook only, one in both.
  const partner = (id: string, products: string[]) => ({ id, email: `${id}@example.com`, code: id, status: "approved", appliedAt: 1, decidedAt: 2, note: "", share: { percent: 50, products } });
  const onCourse = partner("aaaaaaaaaaaa", [ids.Course]);
  const onWorkbook = partner("bbbbbbbbbbbb", [ids.Workbook]);
  const onBoth = partner("cccccccccccc", [ids.Course, ids.Workbook]);
  const partners = [onCourse, onWorkbook, onBoth] as never;

  const earned = async (ref: string, aff: string) => {
    const [raw] = await redis.pipeline([["HGET", `nl:aff:${store.statsId}:shares`, `${ref}:${aff}`]]);
    return typeof raw === "string" ? (JSON.parse(raw) as { base: number; product: string; total: number }) : null;
  };
  const baseOf = async (ref: string, aff: string) => (await earned(ref, aff))?.base ?? null;
  let n = 0;
  const paid = (metadata: Record<string, string>, money: { subtotal: number; total: number; tax?: number; shipping?: number }) => ({
    id: `cs_test_${String(++n).padStart(24, "s")}`, mode: "payment", status: "complete", payment_status: "paid", created: Math.floor(Date.now() / 1000),
    amount_total: money.total, amount_subtotal: money.subtotal, currency: "usd",
    total_details: { amount_tax: money.tax ?? 0, amount_shipping: money.shipping ?? 0 }, payment_intent: `pi_test_partnerlines${n}`,
    metadata, customer_details: { email: "buyer@example.com" },
  });

  checkouts.length = 0;
  await createCheckout(store, course, "https://marktmorgen.com", "", { bumps: [ids.Workbook], digitalConsent: TEST_CONSENT });
  const bumpMeta = meta(checkouts[0]);
  checkouts.length = 0;
  await createCartCheckout(store, [workbook, course], "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  const cartMeta = meta(checkouts[0]);
  checkouts.length = 0;
  await createCheckout(store, course, "https://marktmorgen.com", "", { digitalConsent: TEST_CONSENT });
  const soloMeta = meta(checkouts[0]);

  part("Course $49 + checkout box Workbook $29, one payment of $78");
  const bumpOrder = paid(bumpMeta, { subtotal: 7800, total: 7800 });
  await noteSession(store, bumpOrder, new Map(), partners);
  is("the Course partner earns on the Course's $49 only", await baseOf(bumpOrder.id, onCourse.id), 4900);
  is("the Workbook partner earns on the Workbook's $29 sold in the box", await baseOf(bumpOrder.id, onWorkbook.id), 2900);
  is("a partner in both earns on the whole $78, in one record", await baseOf(bumpOrder.id, onBoth.id), 7800);
  is("the Workbook partner's record names the Workbook", (await earned(bumpOrder.id, onWorkbook.id))?.product ?? null, ids.Workbook);
  is("the record keeps the order's total, which refunds are weighed by", (await earned(bumpOrder.id, onWorkbook.id))?.total ?? null, 7800);

  part("Cart: Workbook then Course, one payment of $78");
  const cartOrder = paid(cartMeta, { subtotal: 7800, total: 7800 });
  await noteSession(store, cartOrder, new Map(), partners);
  is("the Course partner earns on the Course's $49, though it is the cart's second line", await baseOf(cartOrder.id, onCourse.id), 4900);
  is("the Workbook partner earns on the Workbook's $29 only", await baseOf(cartOrder.id, onWorkbook.id), 2900);
  is("a partner in both earns on the whole $78", await baseOf(cartOrder.id, onBoth.id), 7800);

  part("A code took 10% off, and the tax is added on top");
  const coded = paid(bumpMeta, { subtotal: 7800, total: 7020 + 562, tax: 562 });
  await noteSession(store, coded, new Map(), partners);
  is("the Course partner earns on the Course's part of what was paid before tax", await baseOf(coded.id, onCourse.id), 4410);
  is("the Workbook partner earns on the Workbook's part", await baseOf(coded.id, onWorkbook.id), 2610);
  is("a partner in both earns on everything paid before tax", await baseOf(coded.id, onBoth.id), 7020);

  part("A line whose price does not read: no partner's share is written for that order");
  for (const [label, value] of [["missing", undefined], ["not whole cents", "29.00"], ["negative", "-2900"], ["more than the subtotal", "9900"]] as const) {
    const odd = { ...bumpMeta };
    const key = Object.keys(odd).find((k) => /_cents$/.test(k) && k !== "intro_cents" && k !== "regular_cents")!;
    if (value === undefined) delete odd[key];
    else odd[key] = value;
    const order = paid(odd, { subtotal: 7800, total: 7800 });
    const outcome = await noteSession(store, order, new Map(), partners).then(() => "resolved", (error: Error) => error.name);
    is(`${label}: the order is left for the sweep's next run, not dropped`, outcome, "UnknownReplyError");
    is(`${label}: nothing for the Course partner`, await baseOf(order.id, onCourse.id), null);
    is(`${label}: nothing for the Workbook partner`, await baseOf(order.id, onWorkbook.id), null);
    is(`${label}: nothing for the partner in both`, await baseOf(order.id, onBoth.id), null);
  }
  const noSubtotal = paid(bumpMeta, { subtotal: 7800, total: 7800 }) as Record<string, unknown>;
  delete noSubtotal.amount_subtotal;
  const noSubtotalOutcome = await noteSession(store, noSubtotal as never, new Map(), partners).then(() => "resolved", (error: Error) => error.name);
  is("a subtotal that does not read: the order is left for the sweep's next run", noSubtotalOutcome, "UnknownReplyError");
  is("a subtotal that does not read: nothing for the Course partner", await baseOf(noSubtotal.id as string, onCourse.id), null);

  part("Controls: an order of one product is unchanged");
  const solo = paid(soloMeta, { subtotal: 4900, total: 4900 + 392, tax: 392 });
  await noteSession(store, solo, new Map(), partners);
  is("the Course partner earns on the whole amount before tax", await baseOf(solo.id, onCourse.id), 4900);
  is("the Workbook partner earns nothing on a Course sale", await baseOf(solo.id, onWorkbook.id), null);
  const shipped = paid(soloMeta, { subtotal: 4900, total: 5400, shipping: 500 });
  await noteSession(store, shipped, new Map(), partners);
  is("with shipping, as before: what the buyer paid before tax", await baseOf(shipped.id, onCourse.id), 5400);
  await noteSession(store, { ...bumpOrder, amount_total: 1 }, new Map(), partners);
  is("the same order seen again changes nothing (one record per order per partner)", await baseOf(bumpOrder.id, onWorkbook.id), 2900);

  part("An order whose every line is free, with $5 shipping");
  const freeMeta = { ...bumpMeta };
  freeMeta[Object.keys(freeMeta).find((k) => /_cents$/.test(k) && k !== "intro_cents" && k !== "regular_cents")!] = "0";
  const free = paid(freeMeta, { subtotal: 0, total: 500, shipping: 500 });
  await noteSession(store, free, new Map(), partners);
  is("the Workbook partner earns nothing on a free Workbook", await baseOf(free.id, onWorkbook.id), 0);
  is("the Course partner earns nothing on a free Course", await baseOf(free.id, onCourse.id), 0);
  is("a partner in every line is read as an order of one product, as before", await baseOf(free.id, onBoth.id), 500);

  part("A refund names no line: Course $49 + Workbook $29, the $29 given back");
  const commission = async (ref: string, aff: string) => (await readBook(store)).lines.find((l) => l.ref === `${ref}:${aff}`)?.commission ?? null;
  const refund = (order: { id: string; payment_intent: string }, amount: number) =>
    refunds.push({ id: `re_${order.id.slice(-12)}`, object: "refund", status: "succeeded", payment_intent: order.payment_intent, amount, created: Math.floor(Date.now() / 1000) });
  is("before any refund, the Workbook partner earns half of $29", await commission(bumpOrder.id, onWorkbook.id), 1450);
  is("before any refund, the Course partner earns half of $49", await commission(bumpOrder.id, onCourse.id), 2450);
  refund(bumpOrder, 2900);
  is("the Workbook partner is not paid on what may be the refunded line", await commission(bumpOrder.id, onWorkbook.id), 0);
  is("the Course partner keeps half of what no reading of the refund can take ($49 - $29)", await commission(bumpOrder.id, onCourse.id), 1000);
  is("a partner on every line keeps half of what was kept, as before", await commission(bumpOrder.id, onBoth.id), 2450);
  const book = await readBook(store);
  is("the refunds were read in full", book.refundsChecked, true);

  part("A refund names no line: with a code and tax");
  refund(coded, 2610 + 209);
  is("the Workbook partner is not paid on what may be the refunded line", await commission(coded.id, onWorkbook.id), 0);
  is("the Course partner keeps half of $44.10 less the $26.10 refunded before tax", await commission(coded.id, onCourse.id), 900);
  is("a partner on every line keeps half of what was kept before tax, as before", await commission(coded.id, onBoth.id), 2205);

  part("A refund of the whole order, and an order of one product");
  refund(cartOrder, 7800);
  is("the whole order given back: the Course partner earns nothing", await commission(cartOrder.id, onCourse.id), 0);
  is("the whole order given back: the Workbook partner earns nothing", await commission(cartOrder.id, onWorkbook.id), 0);
  refund(solo, 2646);
  is("one product, half given back: half of what was kept, as before", await commission(solo.id, onCourse.id), 1225);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
