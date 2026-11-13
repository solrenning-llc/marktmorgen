/**
 * PayPal sales end to end (money hunt, 12 November 2026): one synthetic order driven through the real code path,
 * from the order opened (openOrder) through the real return route (capture), the real sweep (pending payments, the
 * refund watch, the hand-over retry), the buyer's receipt and access, and the creator's numbers (lib/stats.ts
 * readPaidSales, readPayPalRefundsWithCoverage).
 *
 * Invariants held at every step:
 *  1. amounts reconcile: the receipt names what was captured; the store's sales sum = paid orders; a refund in full
 *     is read as the sale's whole amount, once;
 *  2. access follows payment: paid gives it, a refund in full takes it back, a partial refund keeps it (the rule
 *     lib/earnings-by-month.ts PARTLY_READ documents: PayPal's partial refunds are never recorded);
 *  3. replays move nothing: the return twice, the return and the sweep, two returns at once, a refund read twice;
 *  4. a capture PENDING, without a status, for another amount, currency or payee never becomes paid, and a refund
 *     reply without a status never becomes "not refunded".
 *
 * Synthetic only: a stand-in for PayPal's API and Resend, the in-memory Redis.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { handOverKey, openOrder, readPaid, readPayPalRefundsWithCoverage } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { paypalHandedOver } from "@/lib/paypal-handed";
import { importedFor } from "@/lib/imported-purchases";
import { readPaidSales } from "@/lib/stats";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const SELLER = "7KNGBPH2U58GQ";
const OTHER_SELLER = "9XQWERTY12345";
const orderId = (n: number) => `8E190127TN36472${String(n).padStart(2, "0")}`;
const captureOf = (order: string) => `4D679366HH9088${order.slice(-2)}`;

/** What PayPal answers for each order: the capture's reply (or a thrown answer), and the capture's later status. */
type CaptureShape = { status?: string; value?: string; currency?: string; payee?: string; email?: string } | "lost";
const captureShape = new Map<string, CaptureShape>();
const orderBodies = new Map<string, Record<string, unknown>>();
/** The capture's status as /v2/payments/captures/{id} answers it later ("" = no status; "throw" = no answer). */
const captureStatus = new Map<string, string>();
const captures = new Map<string, number>();
const receiptBodies: string[] = [];
let made = 0;

function orderReply(order: string, shape: Exclude<CaptureShape, "lost">): Record<string, unknown> {
  const row: Record<string, unknown> = { id: captureOf(order), amount: { currency_code: shape.currency ?? "USD", value: shape.value ?? "49.00" } };
  // No status key: COMPLETED; a status key set to undefined: the reply carries no status at all.
  const status = "status" in shape ? shape.status : "COMPLETED";
  if (status !== undefined) row.status = status;
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: shape.email ?? "", payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: shape.payee ?? SELLER }, payments: { captures: [row] } }],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const method = init?.method ?? "GET";
  if (url.hostname === "api.resend.com") {
    receiptBodies.push(String(init?.body ?? ""));
    return json({ id: `e${receiptBodies.length}` });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orderBodies.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    captures.set(capture, (captures.get(capture) ?? 0) + 1);
    const shape = captureShape.get(capture) ?? {};
    if (shape === "lost") throw new Error("Synthetic: the capture's answer never came back");
    const body = orderReply(capture, shape);
    orderBodies.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orderBodies.has(read) ? json(orderBodies.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    const status = captureStatus.get(cap) ?? "COMPLETED";
    if (status === "throw") return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    return json(status ? { id: cap, status } : { id: cap });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;

async function returnFor(store: Store, order: string): Promise<string> {
  const response = await paypalReturn(
    new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, {
      headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${(made % 200) + 1}` },
    }),
  );
  return response.headers.get("location") ?? "";
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  delete process.env.PAYPAL_API_BASE;
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "loafworks", "Loaf Works", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00002", subscriptionId: "sub_Owner00002", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Rye Handbook", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/rye");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const productId = added.product.id;
  const statsId = store.statsId!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const members = async (key: string) => (await redis.pipeline([["ZRANGEBYSCORE", key, "-inf", "+inf"]]))[0] as string[];
  const receiptsTo = (buyer: string) => receiptBodies.filter((body) => body.includes(buyer));
  const sweep = async (hours = 1) => {
    ahead += hours * 3_600_000;
    return sweepPayPal(await fresh(), Date.now() + 10_000);
  };
  const open = async (buyer: string, shape: CaptureShape = {}): Promise<string> => {
    const product = (await readListing(store, productId))!;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    captureShape.set(opened.order, shape === "lost" ? shape : { email: buyer, ...shape });
    return opened.order;
  };
  /** Where one order stands: paid, the buyer's access, receipts, the store's sales list, pending, owed a hand-over, captured. */
  const state = async (order: string, buyer: string) => ({
    paid: Boolean(await readPaid(order)),
    owned: (await importedFor(await fresh(), buyer)).length,
    receipts: receiptsTo(buyer).length,
    sales: (await members(`nl:ppsell:sales:${statsId}`)).filter((m) => m === order).length,
    pending: (await members(`nl:ppsell:pending:${statsId}`)).includes(order),
    owed: (await members(handOverKey(statsId))).includes(order),
    captured: captures.get(order) ?? 0,
  });
  /** The store's numbers: PayPal sales as lib/stats.ts reads them, and the PayPal refunds in full. */
  const numbers = async () => {
    const read = await readPaidSales(await fresh(), 0, 1);
    const refunds = await readPayPalRefundsWithCoverage(statsId, 0);
    return {
      sales: read.sales.length,
      cents: read.sales.reduce((sum, sale) => sum + sale.cents, 0),
      partial: read.partial,
      refunds: refunds.rows.length,
      refunded: refunds.rows.reduce((sum, row) => sum + row.cents, 0),
      refundsPartial: refunds.partial,
    };
  };

  // ── 1. Paid, then confirmed again by every door ───────────────────────────────────────────────────────────────
  part("Paid once: the return, the return again, the sweep — one record, one receipt, one sale, one access");
  const a = await open("ana@example.com");
  is("the buyer is sent to the thanks page", (await returnFor(store, a)).includes("/thanks?paypal="), true);
  const paidA = await readPaid(a);
  is("written down at the captured amount, currency and capture", [paidA?.cents, paidA?.currency, paidA?.capture], [4900, "usd", captureOf(a)]);
  is("paid, handed over, one receipt, one sale, off pending, not owed, captured once", await state(a, "ana@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });
  const receipt = receiptsTo("ana@example.com")[0] ?? "";
  // formatMoney writes a whole amount without cents: "$49" is the 4900 captured.
  is("the receipt names the amount captured ($49) and the capture", [receipt.includes("Paid with PayPal: $49"), receipt.includes(captureOf(a))], [true, true]);
  is("the thanks page reads it as handed over", await paypalHandedOver(paidA!), true);
  is("the return again: the thanks page, nothing captured or sent again", (await returnFor(store, a)).includes("/thanks?paypal="), true);
  await sweep();
  await sweep();
  is("after the return twice and two sweeps, nothing moved", await state(a, "ana@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });
  is("the store's numbers: one sale of 4900, no refund", await numbers(), { sales: 1, cents: 4900, partial: false, refunds: 0, refunded: 0, refundsPartial: false });

  part("Two returns at once (a double click, a reload): one capture written down, one receipt, one sale");
  const twin = await open("twin@example.com");
  const [first, second] = await Promise.all([returnFor(store, twin), returnFor(store, twin)]);
  is("both are sent to the thanks page", [first.includes("/thanks?paypal="), second.includes("/thanks?paypal=")], [true, true]);
  const twinState = await state(twin, "twin@example.com");
  is("one record, one access, one receipt, one sale (PayPal asked once or twice, under one request id)", { ...twinState, captured: twinState.captured <= 2 }, {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: true,
  });
  is("the store's numbers: two sales, 9800", await numbers(), { sales: 2, cents: 9800, partial: false, refunds: 0, refunded: 0, refundsPartial: false });

  // ── 2. Never paid on an answer that does not say paid ─────────────────────────────────────────────────────────
  part("A capture PayPal holds as PENDING: nothing paid until PayPal completes it, then handed over once");
  const p = await open("pia@example.com", { status: "PENDING" });
  is("the thanks page (it says the payment is not settled)", (await returnFor(store, p)).includes("/thanks?paypal="), true);
  is("not paid, no access, no receipt, no sale, kept pending", await state(p, "pia@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: true, owed: false, captured: 1,
  });
  await sweep();
  is("a sweep while still PENDING hands nothing over", await state(p, "pia@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: true, owed: false, captured: 1,
  });
  orderBodies.set(p, orderReply(p, { status: "COMPLETED", email: "pia@example.com" }));
  const cleared = (await sweep()).cleared;
  await returnFor(store, p);
  await sweep();
  is("completed: handed over once by the sweep, the return after it sends nothing again", [cleared, await state(p, "pia@example.com")], [1, {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  }]);

  part("A capture that FAILED, or whose answer was lost: never paid");
  const f = await open("fay@example.com", { status: "FAILED" });
  is("FAILED: the buyer is told PayPal did not take it", (await returnFor(store, f)).includes("status=paypal-declined"), true);
  await sweep();
  is("FAILED: nothing paid, and the sweep lets it go", await state(f, "fay@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: false, owed: false, captured: 1,
  });
  const l = await open("leo@example.com", "lost");
  is("lost answer, no order read either: the thanks page (not settled)", (await returnFor(store, l)).includes("/thanks?paypal="), true);
  is("lost answer: nothing paid, kept pending for the sweep", await state(l, "leo@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: true, owed: false, captured: 1,
  });

  part("A capture whose status is missing: never paid, kept for the sweep, handed over once PayPal says COMPLETED");
  const n = await open("noa@example.com", { status: undefined });
  await returnFor(store, n);
  is("no status: nothing paid, no access, kept pending", await state(n, "noa@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: true, owed: false, captured: 1,
  });
  await sweep();
  is("a sweep keeps it while the status is missing", (await state(n, "noa@example.com")).pending, true);
  orderBodies.set(n, orderReply(n, { status: "COMPLETED", email: "noa@example.com" }));
  await sweep();
  is("then PayPal says COMPLETED: handed over once", await state(n, "noa@example.com"), {
    paid: true, owned: 1, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });

  part("A capture for another amount, another currency or another payee: never accepted");
  for (const [label, buyer, shape] of [
    ["one cent less", "less@example.com", { status: "COMPLETED", value: "48.99" }],
    ["one cent more", "more@example.com", { status: "COMPLETED", value: "49.01" }],
    ["euros, same figure", "eur@example.com", { status: "COMPLETED", currency: "EUR" }],
    ["paid to another PayPal account", "payee@example.com", { status: "COMPLETED", payee: OTHER_SELLER }],
  ] as const) {
    const order = await open(buyer, shape);
    is(`${label}: the buyer is told it went wrong`, (await returnFor(store, order)).includes("status=paypal-error"), true);
    await sweep();
    is(`${label}: never paid, no access, no receipt, no sale`, await state(order, buyer), {
      paid: false, owned: 0, receipts: 0, sales: 0, pending: false, owed: false, captured: 1,
    });
  }
  is("the store's numbers count only the three real sales", await numbers(), { sales: 4, cents: 19600, partial: false, refunds: 0, refunded: 0, refundsPartial: false });

  // ── 3. Refunds, read from PayPal by the watch ────────────────────────────────────────────────────────────────
  part("A partial refund on PayPal: access kept, nothing recorded (PARTLY_READ: partial refunds are never written down)");
  captureStatus.set(captureOf(a), "PARTIALLY_REFUNDED");
  await sweep();
  is("partial: Ana keeps access, no refund mark", [(await state(a, "ana@example.com")).owned, await paypalHandedOver(paidA!)], [1, true]);
  is("partial: the refunds in full stay none", (await numbers()).refunds, 0);

  part("A refund reply without a status, or no reply: never read as \"not refunded\", never as refunded");
  captureStatus.set(captureOf(a), "");
  await sweep(25);
  captureStatus.set(captureOf(a), "throw");
  await sweep(25);
  is("access kept, no refund mark, still watched", [
    (await state(a, "ana@example.com")).owned,
    (await numbers()).refunds,
    (await members(`nl:ppsell:watch:${statsId}`)).includes(a),
  ], [1, 0, true]);

  part("A refund in full: access taken back, counted once as 4900, read twice moves nothing");
  captureStatus.set(captureOf(a), "REFUNDED");
  const revoked = (await sweep(25)).revoked;
  is("taken back once", revoked, 1);
  is("Ana: still written down as paid, no access, still one sale", await state(a, "ana@example.com"), {
    paid: true, owned: 0, receipts: 1, sales: 1, pending: false, owed: false, captured: 1,
  });
  is("the thanks page reads it as refunded", await paypalHandedOver(paidA!), "refunded");
  const afterRefund = await numbers();
  is("numbers: one refund in full of the sale's whole 4900; sales - refunds = the four kept less Ana's", [afterRefund.refunds, afterRefund.refunded, afterRefund.cents - afterRefund.refunded], [1, 4900, 14700]);
  const again = (await sweep(25)).revoked + (await sweep(25)).revoked;
  is("two sweeps more: nothing taken back again, still one refund", [again, (await numbers()).refunds, receiptsTo("ana@example.com").length], [0, 1, 1]);
  is("Ana's return page again: no second capture, no second receipt, no access given back", await (async () => {
    await returnFor(store, a);
    return state(a, "ana@example.com");
  })(), { paid: true, owned: 0, receipts: 1, sales: 1, pending: false, owed: false, captured: 1 });

  part("Refunded before it was ever confirmed: PENDING at the return, REFUNDED when the sweep reads it");
  const r = await open("rex@example.com", { status: "PENDING" });
  await returnFor(store, r);
  orderBodies.set(r, orderReply(r, { status: "REFUNDED", email: "rex@example.com" }));
  await sweep();
  is("never written down, never handed over, never a sale", await state(r, "rex@example.com"), {
    paid: false, owned: 0, receipts: 0, sales: 0, pending: false, owed: false, captured: 1,
  });

  part("Two purchases of the same product by one address, one refunded in full: the other keeps the access");
  const b1 = await open("bo@example.com");
  await returnFor(store, b1);
  const b2 = await open("bo@example.com");
  await returnFor(store, b2);
  is("two sales, one access, receipts for each", [(await state(b2, "bo@example.com")).owned, receiptsTo("bo@example.com").length], [1, 2]);
  captureStatus.set(captureOf(b1), "REFUNDED");
  await sweep();
  await sweep();
  is("the first refunded: Bo keeps the product through the second", (await state(b2, "bo@example.com")).owned, 1);
  captureStatus.set(captureOf(b2), "REFUNDED");
  await sweep();
  await sweep();
  is("both refunded: the access is gone", (await state(b2, "bo@example.com")).owned, 0);
  const end = await numbers();
  is("numbers: six sales, three refunds in full, the refunded cents match the refunded sales", [end.sales, end.refunds, end.refunded], [6, 3, 14700]);

  // Not asserted here, because open pull requests already fix them on their own branches (12/11/2026):
  // a capture with no status answered "declined" at the return, a REVERSED capture keeping the access and a
  // PENDING capture completed then partly refunded before the sweep (#3392); a paid record that does not read
  // left out of the numbers as a complete reading (#4001, #2854). Their own tests prove those fixes.

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
