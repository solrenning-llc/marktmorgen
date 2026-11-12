/**
 * A creator disconnects PayPal while PayPal still holds some of the store's orders (found by Claude 7 on 12 November
 * 2026; decision C1-20261112-1102-C7-146, item 2): the buyer is never left without an answer.
 *
 *   (a) a payment PayPal completes after the disconnection is still handed over, and one refunded after it still
 *       takes the purchase back and is marked refunded, which is what takes the affiliate's commission back
 *       (lib/affiliates.ts reads the mark through readPayPalRefundsWithCoverage);
 *   (b) a payment PayPal has not confirmed PENDING_GIVE_UP_SECONDS after its order was opened is cancelled: nothing
 *       is handed over, the order's record is let go, and the buyer and the creator are each told, in an email with
 *       a text and an HTML part, that Marktmorgen holds no money and what happens if PayPal completes it later;
 *   (c) an answer from PayPal that cannot be read, or that fails, is never taken for "paid" nor for "not paid":
 *       nothing is handed over and nothing is cancelled, and the order is asked about again.
 *
 * Everything runs through the real five-minute job (lib/checkout-sweep.ts, sweepCheckouts) and the real disconnect
 * (lib/store.ts, disconnectPayPalSeller, which app/api/store/paypal/disconnect calls). Synthetic only: a stand-in for
 * PayPal's API, a stand-in for Resend and the Redis stub.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, disconnectPayPalSeller, ensureStatsId, setPayPalSeller, setProductLink, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPaid, refundSeen, stillPending } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
const captures = new Map<string, string>();
const failing = new Set<string>();
const emails: { to: string[]; subject: string; text: string; html?: string }[] = [];
let captureWith: (order: string) => Record<string, unknown> = () => ({});
let made = 0;
let paypalCalls = 0;

const orderId = (n: number) => `9D190127TN36471${String(n).padStart(2, "0")}`;

function withCapture(order: string, status: string | undefined, email: string): Record<string, unknown> {
  const cap = `4C679366HH9087${order.slice(-2)}`;
  if (status) captures.set(cap, status);
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email },
    purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, ...(status ? { status } : {}), amount: { currency_code: "USD", value: "49.00" } }] } }],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    emails.push(JSON.parse(String(init?.body)));
    return json({ id: `e${emails.length}` });
  }
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  paypalCalls += 1;
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = captureWith(capture);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") {
    if (failing.has(read)) return json({ name: "INTERNAL_SERVER_ERROR" }, 500);
    return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

/** Moves an order's opening back in time, as if it had been opened `days` ago. */
async function openedDaysAgo(order: string, days: number): Promise<void> {
  const key = `nl:ppsell:o:${order}`;
  const [raw] = await redis.pipeline([["GET", key]]);
  const opened = JSON.parse(String(raw)) as { at: number };
  opened.at = Math.floor(Date.now() / 1000) - days * 86_400;
  await redis.pipeline([["SET", key, JSON.stringify(opened), "EX", 86_400]]);
}

const to = (address: string) => emails.filter((e) => e.to.includes(address));

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  delete process.env.PAYPAL_ENV;
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  process.env.STRIPE_SECRET_KEY = "sk_test_synthetic_only";
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const open = async (): Promise<string> => {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    return opened.order;
  };

  // Before the disconnection: one payment PayPal holds as pending (late), one paid and handed over (refunded later),
  // and three pending ones that PayPal never confirms (cancelled, read failing, read unreadable).
  const late = await open();
  const refunded = await open();
  const never = await open();
  const unreadable = await open();
  const unanswered = await open();
  captureWith = (o) => withCapture(o, "PENDING", o === late ? "late@example.com" : o === never ? "never@example.com" : o === unreadable ? "unreadable@example.com" : "unanswered@example.com");
  for (const order of [late, never, unreadable, unanswered]) await captureOrder(store, order);
  captureWith = (o) => withCapture(o, "COMPLETED", "buyer@example.com");
  const paid = await captureOrder(store, refunded);
  if (!paid.ok) throw new Error("not paid");
  await handOverPayPal(store, paid.paid);
  store = (await storeForEmail("owner@example.com"))!;
  is("control: four payments wait on PayPal", await Promise.all([late, never, unreadable, unanswered].map((o) => stillPending(store, o))), [true, true, true, true]);
  is("control: the paid one is the buyer's", (await importedFor(store, "buyer@example.com")).length, 1);

  part("The creator disconnects PayPal");
  const route = readFileSync(join(process.cwd(), "app/api/store/paypal/disconnect/route.ts"), "utf8");
  is("the studio's disconnect keeps the account for the orders it took", route.includes("disconnectPayPalSeller(ref)"), true);
  await disconnectPayPalSeller("owner@example.com");
  store = (await storeForEmail("owner@example.com"))!;
  is("buyers can no longer pay with PayPal", store.paypalSeller, null);

  part("(a) A pending payment PayPal completes after the disconnection is handed over");
  orders.set(late, withCapture(late, "COMPLETED", "late@example.com"));
  const sentBefore = emails.length;
  await sweepCheckouts(Date.now() + 20_000);
  store = (await storeForEmail("owner@example.com"))!;
  is("written down as paid", (await readPaid(late))?.email, "late@example.com");
  is("theirs on the store", (await importedFor(store, "late@example.com")).map((p) => p.job), [`paypal:${late}`]);
  is("with its receipt", to("late@example.com").length, 1);
  is("no longer waited on", await stillPending(store, late), false);
  is("and no one else was emailed by that run", emails.length - sentBefore, 1);

  part("(a) A refund after the disconnection takes the purchase back and is counted as a refund");
  captures.set(paid.paid.capture, "REFUNDED");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", refunded]]);
  await sweepCheckouts(Date.now() + 20_000);
  is("taken back from the buyer", (await importedFor(store, "buyer@example.com")).length, 0);
  is("marked refunded, which the affiliate book and the numbers read", await refundSeen(store.statsId!, refunded), true);

  part("(c) Before the deadline nothing is cancelled");
  await sweepCheckouts(Date.now() + 20_000);
  is("still waited on", await Promise.all([never, unreadable, unanswered].map((o) => stillPending(store, o))), [true, true, true]);
  is("nobody told anything", [to("never@example.com").length, to("owner@example.com").filter((e) => e.subject.includes("cancelled")).length], [0, 0]);

  part("(b) Past the deadline, still not confirmed by PayPal: cancelled, buyer and creator told");
  for (const order of [never, unreadable, unanswered]) await openedDaysAgo(order, 30);
  orders.set(unreadable, withCapture(unreadable, undefined, "unreadable@example.com"));
  failing.add(unanswered);
  await sweepCheckouts(Date.now() + 20_000);
  is("no longer waited on", await stillPending(store, never), false);
  is("nothing handed over", [await readPaid(never), (await importedFor(store, "never@example.com")).length], [null, 0]);
  const [record] = await redis.pipeline([["GET", `nl:ppsell:o:${never}`]]);
  is("the order's record is let go, so a late return cannot capture it", [record, (await captureOrder(store, never)).ok], [null, false]);
  const buyer = to("never@example.com");
  is("the buyer is told once", buyer.length, 1);
  is("in plain words, with a text and an HTML part", [buyer[0]?.subject.includes("cancelled"), typeof buyer[0]?.html === "string" && buyer[0].html.includes("<h1"), buyer[0]?.text.includes("Sourdough Guide")], [true, true, true]);
  is("saying Marktmorgen holds no money and what happens if PayPal completes it", [buyer[0]?.text.includes("Marktmorgen never holds"), buyer[0]?.text.includes("refund")], [true, true]);
  const creator = to("owner@example.com").filter((e) => e.text.includes(never));
  is("the creator is told once, with the order's PayPal id", creator.length, 1);
  is("and asked to reconnect or refund", [creator[0]?.text.includes("refund"), typeof creator[0]?.html === "string"], [true, true]);

  part("(c) An answer that cannot be read, or that fails, is neither paid nor not paid");
  is("both still waited on", [await stillPending(store, unreadable), await stillPending(store, unanswered)], [true, true]);
  is("neither handed over", [await readPaid(unreadable), await readPaid(unanswered)], [null, null]);
  is("neither buyer told anything", [to("unreadable@example.com").length, to("unanswered@example.com").length], [0, 0]);

  part("A cancelled order is told once, however many runs follow");
  const after = emails.length;
  await sweepCheckouts(Date.now() + 20_000);
  is("no second notice", emails.filter((e, i) => i >= after && (e.to.includes("never@example.com") || e.text.includes(never))).length, 0);
  is("PayPal was asked along the way", paypalCalls > 0, true);
  done();
}

main().catch((error) => {
  console.log("✗ crashed:", error);
  process.exit(1);
});
