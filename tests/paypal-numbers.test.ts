/**
 * PayPal sales counted like Stripe's, and buyers brought over counted as
 * history (lib/paypal-sales.ts, lib/stats.ts readPaidSales, lib/affiliates.ts
 * creditPayPalSale, lib/paypal-delivery.ts, lib/segments.ts; added 13 October
 * 2026). Checked:
 *
 *   - an order keeps the channel and the affiliate its visit carried, and the
 *     store sale it was paid at;
 *   - once paid, it is in "Your numbers", the sales file and the store's
 *     revenue, with its channel, on a store with PayPal and no Stripe too;
 *   - the affiliate who sent the buyer is credited, and a refund in full on
 *     PayPal takes it back in the book and counts as a refund in the numbers;
 *   - the webhooks are told, once;
 *   - a buyer brought over from another platform is in the list's groups as
 *     history: nothing spent, no purchase date here, "imported".
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, readPayPalSales, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { readSales, salesCsv } from "@/lib/stats";
import { readBook } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { addEndpoint, setSendHooksForTests } from "@/lib/webhooks";
import { grantImported } from "@/lib/imported-purchases";
import { buyerLedger } from "@/lib/segments";
import { channelName } from "@/lib/channel-names";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const SELLER = "7KNGBPH2U58GQ";
process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
process.env.RESEND_API_KEY = "re_test_paypal_numbers";
delete process.env.PAYPAL_ENV;

const AFF = "0123456789ab";
let made = 0;
const captures = new Map<string, string>();
const orderId = (n: number) => `5O190127TN36472${String(n).padStart(2, "0")}`;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ object: "list", data: [], has_more: false });
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture) {
    const cap = `3C679366HH9088${capture.slice(-2)}`;
    captures.set(cap, "COMPLETED");
    return json({
      id: capture,
      status: "COMPLETED",
      payer: { email_address: "buyer@example.com" },
      purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, status: "COMPLETED", amount: { currency_code: "USD", value: "39.20" } }] } }],
    }, 201);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap) return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  // Deliveries are tried at once; here they fail fast, without the network, and stay queued.
  setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, percent: 30 });
  let store = (await storeForEmail("owner@example.com"))!;
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })]]);
  await addEndpoint(store, "https://hooks.example.com/marktmorgen", ["sale.completed", "refund.issued"]);
  const product = (await readListing(store, added.product.id))!;

  part("The order keeps what the visit carried");
  const now = Math.floor(Date.now() / 1000);
  const onSale = { ...store, sale: { ...store.sale, percent: 20, starts: now - 60, ends: now + 3600, all: true, products: [], coupon: "c_sale" } } as typeof store;
  const opened = await openOrder(onSale, product, "https://marktmorgen.com", { meta: { channel: "instagram", channel_first: "tiktok", bad_KEY: "x" }, via: { aff: AFF, rate: 30 }, digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error("no order");
  const paid = await captureOrder(onSale, opened.order);
  if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
  is("the channel, the affiliate, the sale and the yes to start access at once, on the payment", [paid.paid.meta, paid.paid.via, paid.paid.off, paid.paid.sale, paid.paid.handle], [{ dc: `yes:${TEST_CONSENT.version}:d:${TEST_CONSENT.at}`, channel: "instagram", channel_first: "tiktok" }, { aff: AFF, rate: 30 }, 980, 20, "harbor"]);
  await handOverPayPal(store, paid.paid);
  await handOverPayPal(store, paid.paid);

  part("In the store's numbers, like a Stripe sale");
  is("written down once", (await readPayPalSales(store.statsId, 0, 10)).sales.map((p) => p.order), [opened.order]);
  const sales = (await readSales(store))!;
  is("in the totals, by product and by channel, on a store with no Stripe", [sales.totals.d7, sales.byProduct[product.id]?.d7, sales.bySource.find((r) => r.source === "instagram")?.cents], [{ sales: 1, cents: 3920 }, { sales: 1, cents: 3920 }, 3920]);
  is("its store sale in the discounts beside full price", sales.discounts?.rows?.map((r) => [r.kind, r.sales, r.off]), [["sale", 1, 980]]);
  const csv = await salesCsv(store, 0);
  is("in the sales file, said to be paid with PayPal", [csv.rows, csv.csv.split("\r\n")[0].endsWith(',"paid_with"'), csv.csv.split("\r\n")[1].includes(`paypal:${opened.order}`), csv.csv.split("\r\n")[1].endsWith(',"paypal"')], [1, true, true, true]);

  part("Credited to the affiliate who sent the buyer");
  let book = await readBook(store);
  const line = book.lines.find((l) => l.aff === AFF);
  is("at the share the buyer paid at, once", [book.lines.filter((l) => l.aff === AFF).length, line?.commission], [1, Math.round(3920 * 0.3)]);

  part("Told to the webhooks, once");
  const [log] = await redis.pipeline([["LRANGE", `nl:hooks:log:${store.statsId}`, 0, -1]]);
  const bodies = await Promise.all((log as string[]).map(async (id) => JSON.parse(String((await redis.pipeline([["GET", `nl:hooks:d:${id}`]]))[0])) as { type: string; body: string }));
  const sale = bodies.filter((d) => d.type === "sale.completed").map((d) => JSON.parse(d.body).data);
  is("sale.completed, paid with PayPal, with the amount and the channel", sale.map((d) => [d.paid_with, d.amount_cents, d.discount_cents, d.channel, d.paypal_order]), [["paypal", 3920, 980, "instagram", opened.order]]);

  part("A refund in full on PayPal");
  captures.set(paid.paid.capture, "REFUNDED");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", opened.order]]);
  await watchPayPal(store, Date.now() + 10_000, { handOver: async () => {}, dropStart: async () => {}, refunded: async () => {} });
  const after = (await readSales(store))!;
  is("counted as a refund in the numbers", after.refundsIn?.d7.reduce((n, r) => n + r.cents, 0), 3920);
  book = await readBook(store);
  is("and takes the commission back", [book.lines.find((l) => l.aff === AFF)?.commission, book.lines.find((l) => l.aff === AFF)?.status], [0, "refunded"]);

  part("Buyers brought over: history, never a sale");
  store = (await storeForEmail("owner@example.com"))!;
  await grantImported(store.statsId!, "0123456789abcdef01234567", [{ email: "Old.Buyer@example.com", productId: product.id, items: null }], now - 86_400, store.sid);
  await grantImported(store.statsId!, `gift:${"a".repeat(16)}`, [{ email: "gifted@example.com", productId: product.id, items: null }], now, store.sid);
  await redis.pipeline([["DEL", `nl:seg:ledger:${store.statsId}`]]);
  const ledger = await buyerLedger({ ...store, pastBuyers: true });
  is("in the list's groups, with nothing spent and no purchase here", ledger.buyers.get("old.buyer@example.com"), { cents: 0, last: 0, channel: "imported", orders: 0 });
  is("a gift is not an import", ledger.buyers.has("gifted@example.com"), false);
  is("named for what it is", channelName("imported"), "Brought over from another platform");
  // Refunded in full on PayPal just above: a purchase given back is not a purchase (270 [GR1], unit 2).
  is("the PayPal buyer refunded in full is not a buyer in the list's groups", ledger.buyers.get("buyer@example.com"), undefined);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
