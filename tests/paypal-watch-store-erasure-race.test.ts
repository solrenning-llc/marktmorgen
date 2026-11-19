/**
 * Codex G (G-20261119-1144, MEDIUM, money and store erasure): the PayPal refund watch put an order back on the store's
 * watch list (a plain ZADD) after async work. A store erasure that began in between, deleting the list and the store's
 * id key, saw the list made again, with no expiry, for a store already erased. Each write that puts an order back now
 * runs in one EVAL with the fence of C5-20261119-1210-defeitos18: the store's id key still there and the store not
 * being erased, or nothing is written. Synthetic PayPal, clock and Redis only; fetch answers only the stand-ins here.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, storeIdCommand, storeRef, ERASING_KEY, erasingField } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const START = Math.floor(Date.now() / 1000);
let clock = START;
const realNow = Date.now.bind(Date);
Date.now = () => clock * 1000;

const captureStatus = "COMPLETED";
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  if (url.pathname.startsWith("/v1/customer/partners/")) return json({ merchant_id: SELLER, tracking_id: url.searchParams.get("tracking_id") });
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = `5O190127TN36472${String(made).padStart(2, "0")}`;
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    return json(
      {
        id: capture,
        status: "COMPLETED",
        payer: { email_address: "buyer@example.com", payer_id: "QYR5Z8XDVJNXQ" },
        purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9088${capture.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
      },
      201,
    );
  }
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    return json({ id: cap, status: captureStatus });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_probe_c";
  delete process.env.PAYPAL_ENV;
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
  const store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, added.product.id))!;
  const watchKey = `nl:ppsell:watch:${store.statsId}`;
  const on = { handOver: async () => {}, dropStart: async () => {} };
  const sale = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!sale.ok) throw new Error("no order");
  const paid = await captureOrder(store, sale.order);
  if (!paid.ok) throw new Error("not paid");
  await handOverPayPal(store, paid.paid);
  const due = (await redis.pipeline([["ZSCORE", watchKey, sale.order]]))[0];
  is("control: the paid order is on the store's refund watch", due !== null, true);
  clock = Math.max(clock, Number(due));

  part("The store's erasure begins while the watch reads the paid record: the list is never made again");
  const storeIdKey = storeIdCommand(store.sid)[1];
  const field = await erasingField(storeRef(store));
  const real = redis.pipeline.bind(redis);
  let erased = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!erased && commands.length === 1 && commands[0]?.[0] === "GET" && String(commands[0]?.[1]) === `nl:ppsell:paid:${sale.order}`) {
      erased = true;
      await real([["HSET", ERASING_KEY, field, String(clock)], ["DEL", storeIdKey], ["DEL", watchKey]]);
      return [42];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  await watchPayPal(store, Date.now() + 10_000, on);
  redis.pipeline = real;
  is("the erasure began during the paid record's read", erased, true);
  is("the erased store's watch list is not made again", (await real([["EXISTS", watchKey]]))[0], 0);

  // Claude 6 on #4892 (LOW): the store's erasure marks it as being erased first and deletes its id key only at its
  // end, so between the two only the erasing half of the fence refuses the write. With the id key still in place.
  part("The erasure has begun but the store's id key is still there: the list is never made again");
  await real([["HDEL", ERASING_KEY, field], ["SET", storeIdKey, "owner@example.com"], ["ZADD", watchKey, String(clock), sale.order]]);
  let marked = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (!marked && commands.length === 1 && commands[0]?.[0] === "GET" && String(commands[0]?.[1]) === `nl:ppsell:paid:${sale.order}`) {
      marked = true;
      await real([["HSET", ERASING_KEY, field, String(clock)], ["DEL", watchKey]]);
      return [42];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  await watchPayPal(store, Date.now() + 10_000, on);
  redis.pipeline = real;
  is("the erasure was marked during the paid record's read, the store's id key kept", [marked, (await real([["EXISTS", storeIdKey]]))[0]], [true, 1]);
  is("the store being erased does not get its watch list made again", (await real([["EXISTS", watchKey]]))[0], 0);
  Date.now = realNow;
  done();
}

void main().catch((error) => { console.error(error); process.exit(1); });
