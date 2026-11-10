/**
 * Claude 5's proof (claude5/f-buyer-profile-listing 307c31ba4, rated ALTO), kept as the RED of Claude 4's
 * claude4/catalog-read-exact, unchanged but for this line.
 *
 * Proof (CX-123 rules 24 and 30): a PayPal payment is taken and written down
 * (lib/paypal-sales.ts settle, `SET … NX`), then lib/paypal-delivery.ts
 * handOverPayPal reads the product with lib/catalog.ts readListing. readListings
 * turns a stored record that is not JSON, or a Redis reply in another shape,
 * into "the store has no such product": handOverPayPal answers false ("the
 * product is gone") and hands nothing over. The paid record is already
 * written, so a reload of the return page (captureOrder answers fresh: false)
 * and the sweep (it only clears pending orders) never hand it over again:
 * the buyer's money is taken and nothing is delivered, and no receipt goes out.
 *
 * The product sits past the store's first page (the catalog head only holds
 * the first STORE_PAGE_SIZE visible products), so it is read from its record,
 * as for any store with more than a page of products.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing, STORE_PAGE_SIZE } from "@/lib/catalog";
import { openOrder, readPaid, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal, sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9087${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

let buyerFor = "a@example.com";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    const body = completed(capture, "49.00", buyerFor);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const returnFor = (store: Store, order: string) =>
  paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }));

/** One PayPal purchase through the real return route, with the product's read answered by `answer`. */
async function buy(store: Store, productId: string, buyer: string, answer: "healthy" | "malformed" | "wrong shape"): Promise<{ delivered: number; again: number; sweptLater: number }> {
  const product = (await readListing(store, productId))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  buyerFor = buyer;
  const key = `nl:catalog:${store.catalog.id}:l:${productId}`;
  const [kept] = await redis.pipeline([["GET", key]]);
  const pipeline = redis.pipeline.bind(redis);
  if (answer === "malformed") await redis.pipeline([["SET", key, "{\"id\":\"" + productId + "\", not json"]]);
  if (answer === "wrong shape") {
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await pipeline(commands);
      return commands.map((command, i) => (command[0] === "GET" && command[1] === key ? { result: replies[i] } : replies[i]));
    }) as typeof redis.pipeline;
  }
  await returnFor(store, opened.order);
  const delivered = (await importedFor((await storeForEmail("owner@example.com"))!, buyer)).length;
  // The read heals: the record is back, the reply in its own shape.
  redis.pipeline = pipeline;
  await redis.pipeline([["SET", key, String(kept)]]);
  // A reload of the return page, then the sweep: does the buyer get it now?
  await returnFor(store, opened.order);
  const again = (await importedFor((await storeForEmail("owner@example.com"))!, buyer)).length;
  await sweepPayPal((await storeForEmail("owner@example.com"))!, Date.now() + 10_000);
  await watchPayPal((await storeForEmail("owner@example.com"))!, Date.now() + 10_000, { handOver: (p) => handOverPayPal(store, p).then(() => undefined), dropStart: async () => {} });
  const sweptLater = (await importedFor((await storeForEmail("owner@example.com"))!, buyer)).length;
  const paidWritten = Boolean(await readPaid(opened.order));
  console.log(`        ${answer}: ${JSON.stringify({ paidWritten, delivered, again, sweptLater })}`);
  return { delivered, again, sweptLater };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_f_paypal_listing";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  // More than a page of products before it: the guide is past the store's first page, so not in the head.
  for (let i = 0; i < STORE_PAGE_SIZE + 1; i += 1) {
    const more = await addProduct("owner@example.com", `Recipe ${i}`, "", "9", null);
    if (!more.ok) throw new Error(`no product ${i}: ${JSON.stringify(more)}`);
  }
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store = (await storeForEmail("owner@example.com"))!;
  const id = added.product.id;

  part("Setting");
  is("the guide is read from its own record, not from the head", [Boolean(store.catalog.id), store.catalog.head.some((l) => l.id === id)], [true, false]);

  part("Healthy control: paid and handed over");
  is("a healthy read hands it over", await buy(store, id, "healthy@example.com", "healthy"), { delivered: 1, again: 1, sweptLater: 1 });

  part("A product record that is not JSON (RED: money taken, nothing handed over, ever)");
  is("an unknown product read is never answered as 'the product is gone': the buyer gets what they paid for once the read heals", (await buy(store, id, "malformed@example.com", "malformed")).sweptLater, 1);

  part("A Redis reply in another shape (RED: same)");
  is("an unknown product read is never answered as 'the product is gone': the buyer gets what they paid for once the read heals", (await buy(store, id, "shape@example.com", "wrong shape")).sweptLater, 1);

  part("handOverPayPal itself");
  const key = `nl:catalog:${store.catalog.id}:l:${id}`;
  const [kept] = await redis.pipeline([["GET", key]]);
  await redis.pipeline([["SET", key, "not json"]]);
  const said = await handOverPayPal(store, { store: store.statsId!, order: "5O190127TN3647199", capture: "3C679366HH908799", email: "direct@example.com", product: id, cents: 4900, currency: "usd", at: Math.floor(Date.now() / 1000), handle: store.handle }).then(
    (v) => (v ? "handed over" : "false: product gone"),
    (e: Error) => `threw ${e.name}`,
  );
  await redis.pipeline([["SET", key, String(kept)]]);
  is("an unknown read throws (fails closed), never answers 'product gone'", said, "threw UnknownReplyError");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
