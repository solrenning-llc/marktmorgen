/**
 * A PayPal sale refunded IN PART never pays its affiliate the commission on the whole price (Claude 1 cloud's money
 * audit in #3869, 12 November 2026: "a PayPal sale refunded in part still earns the affiliate commission on the full
 * amount"). PayPal's capture then reads PARTIALLY_REFUNDED, and nothing here receives PayPal's webhooks, so how much
 * was given back is not known: what is owed on that line is unknown, and unknown is never paid (rule 24). A capture
 * still COMPLETED keeps paying in full, as before. Synthetic records, PayPal and Redis stood in for.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, setAffiliateSetting, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { readBook } from "@/lib/affiliates";
import { NO_AFFILIATES } from "@/lib/affiliate-setting";
import { setSendHooksForTests } from "@/lib/webhooks";
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
process.env.RESEND_API_KEY = "re_test_paypal_partial";
delete process.env.PAYPAL_ENV;

const AFF = "0123456789ab";
const PARTNER = "ba9876543210";
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
      purchase_units: [{ payee: { merchant_id: SELLER }, payments: { captures: [{ id: cap, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    }, 201);
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap) return json({ id: cap, status: captures.get(cap) ?? "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  await setAffiliateSetting("owner@example.com", { ...NO_AFFILIATES, enabled: true, percent: 30 });
  const store = (await storeForEmail("owner@example.com"))!;
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:people`, AFF, JSON.stringify({ id: AFF, email: "sara@example.com", code: "sara", status: "approved", appliedAt: 1, decidedAt: 1, note: "" })]]);
  const product = (await readListing(store, added.product.id))!;

  const sell = async () => {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { meta: {}, via: { aff: AFF, rate: 30 }, digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error("no order");
    const paid = await captureOrder(store, opened.order);
    if (!paid.ok) throw new Error(`not paid: ${paid.reason}`);
    await handOverPayPal(store, paid.paid);
    return { order: opened.order, capture: paid.paid.capture };
  };
  const full = Math.round(4900 * 0.3);
  const payableOf = async () => (await readBook(store)).rows.find((r) => r.affiliate.id === AFF)?.payable;

  part("Paid, then refunded in part on PayPal");
  const sold = await sell();
  is("before any refund the commission on the whole price is payable", await payableOf(), full);
  captures.set(sold.capture, "PARTIALLY_REFUNDED");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", sold.order]]);
  await watchPayPal(store, Date.now() + 10_000, { handOver: async () => {}, dropStart: async () => {}, refunded: async () => {} });
  const book = await readBook(store);
  const row = book.rows.find((r) => r.affiliate.id === AFF);
  is("the commission on the whole price is no longer payable: how much was kept is not known", row?.payable, 0);
  is("and no payout file pays it", book.rows.filter((r) => r.payable > 0).length, 0);

  const line = book.lines.find((l) => l.aff === AFF && l.ref === `paypal:${sold.order}`);
  is("its line says partly refunded and earns nothing", [line?.status, line?.commission], ["partly refunded", 0]);
  is("the mark names the capture, kept as long as the sales", [(await redis.pipeline([["ZSCORE", `nl:ppsell:partref:${store.statsId}`, sold.capture]]))[0] !== null, Number((await redis.pipeline([["TTL", `nl:ppsell:partref:${store.statsId}`]]))[0]) > 399 * 86_400], [true, true]);
  is("the order stays watched for a refund in full", (await redis.pipeline([["ZSCORE", `nl:ppsell:watch:${store.statsId}`, sold.order]]))[0] !== null, true);

  part("Another sale, still completed, keeps paying in full");
  await sell();
  is("only the completed sale's commission is payable", await payableOf(), full);

  part("A partner's share of a sale refunded in part earns nothing either");
  await redis.pipeline([["HSET", `nl:aff:${store.statsId}:people`, PARTNER, JSON.stringify({ id: PARTNER, email: "pat@example.com", code: "pat", status: "approved", appliedAt: 1, decidedAt: 1, note: "", share: { percent: 20, products: [product.id] } })]]);
  const shared = await sell();
  const shareOf = async () => (await readBook(store)).lines.find((l) => l.aff === PARTNER && l.ref.startsWith(`paypal:${shared.order}`));
  is("before the refund the partner's share is earned", [(await shareOf())?.status, (await shareOf())?.commission], ["earned", Math.round(4900 * 0.2)]);
  captures.set(shared.capture, "PARTIALLY_REFUNDED");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", shared.order]]);
  await watchPayPal(store, Date.now() + 10_000, { handOver: async () => {}, dropStart: async () => {}, refunded: async () => {} });
  is("after it, the share is partly refunded and earns nothing", [(await shareOf())?.status, (await shareOf())?.commission], ["partly refunded", 0]);

  part("A mark Redis does not confirm leaves the order watched, never marked");
  const unsure = await sell();
  captures.set(unsure.capture, "PARTIALLY_REFUNDED");
  await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "0", unsure.order]]);
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 2 && commands[0][0] === "ZADD" && String(commands[0][1]).startsWith("nl:ppsell:partref:") ? ["OK", 1] : pipeline(commands)) as typeof redis.pipeline;
  await watchPayPal(store, Date.now() + 10_000, { handOver: async () => {}, dropStart: async () => {}, refunded: async () => {} });
  redis.pipeline = pipeline;
  const lookAgain = Number((await redis.pipeline([["ZSCORE", `nl:ppsell:watch:${store.statsId}`, unsure.order]]))[0]);
  is("looked at again in about an hour", lookAgain >= Math.floor(Date.now() / 1000) + 3000, true);

  part("A reading of the marks in another shape is unknown: no payout is made on the book");
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.length === 1 && commands[0][0] === "ZRANGEBYSCORE" && String(commands[0][1]).startsWith("nl:ppsell:partref:") ? [["not-a-capture!", "1"]] : pipeline(commands)) as typeof redis.pipeline;
  const blind = await readBook(store);
  redis.pipeline = pipeline;
  is("refunds not checked, so nothing is paid on what is owed", blind.refundsChecked, false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
