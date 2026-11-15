/**
 * The PayPal refund watch's looks at one order, counted (Claude 7, 14 November 2026; Claude 2 on #4536, LEVE of
 * cost; synthetic only). A capture in a status the watch does not read (lib/paypal-sales.ts, watchPayPal) is never
 * dropped from the watch, but it was asked about again every hour until its paid record ended (400 days): about
 * 9,600 capture reads for one order, outside what the watch of a readable order costs. Now it is asked on the watch's
 * own schedule (nextLook) while the watch's days last and every PAYPAL_WATCH_LOOKS.lateLookSeconds after them, so one
 * order costs at most the looks of an order watched to its end plus PAYPAL_WATCH_LOOKS.lateLooksPerOrder
 * (tests/plan-cost-registry.ts). Each sweep below runs at the moment the order is next due, the most often it can be.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { captureOrder, openOrder, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import * as registry from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const DAY = 86_400;
const START = Math.floor(Date.now() / 1000);
let clock = START;
const realNow = Date.now.bind(Date);
Date.now = () => clock * 1000;

let captureStatus = "COMPLETED";
let captureReads = 0;
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
    captureReads += 1;
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

  /** One sale, then a sweep at each moment it is next due, until it leaves the watch or its paid record has ended. */
  async function looksAt(status: string): Promise<{ looks: number; leftAfterDays: number | null }> {
    // Each sale is made at the same moment, inside the store's paid period.
    clock = START;
    captureStatus = "COMPLETED";
    const sale = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!sale.ok) throw new Error("no order");
    const paid = await captureOrder(store, sale.order);
    if (!paid.ok) throw new Error("not paid");
    await handOverPayPal(store, paid.paid);
    captureStatus = status;
    const start = paid.paid.at;
    const before = captureReads;
    for (let guard = 0; guard < 20_000; guard += 1) {
      const score = (await redis.pipeline([["ZSCORE", watchKey, sale.order]]))[0];
      if (score === null) return { looks: captureReads - before, leftAfterDays: (clock - start) / DAY };
      clock = Math.max(clock, Number(score));
      if (clock >= start + 400 * DAY) break;
      await watchPayPal(store, Date.now() + 10_000, on);
    }
    await redis.pipeline([["ZREM", watchKey, sale.order]]);
    return { looks: captureReads - before, leftAfterDays: null };
  }

  const stated = (registry as unknown as Record<string, unknown>).PAYPAL_WATCH_LOOKS as
    | { looksPerOrderWatched?: number; lateLookSeconds?: number; lateLooksPerOrder?: number }
    | undefined;

  part("An order whose capture stays COMPLETED: the watch's own schedule, to its end");
  const standing = await looksAt("COMPLETED");
  is("it leaves the watch at the end of the watch's 180 days", standing.leftAfterDays !== null && Math.round(standing.leftAfterDays) === 180, true);
  is("the registry states its looks (PAYPAL_WATCH_LOOKS.looksPerOrderWatched)", stated?.looksPerOrderWatched, standing.looks);

  part("An order whose capture is in a status the watch does not read: never dropped, never asked hourly for 400 days");
  // A status PayPal does not publish for a capture (REVERSED is taken back since main's C4-13, not unknown).
  const unread = await looksAt("SOMETHING_NEW");
  is("it is still watched while its paid record lasts", unread.leftAfterDays, null);
  const late = stated?.lateLooksPerOrder;
  is("the registry states the looks after the watch's days", typeof late === "number" && late > 0 && stated?.lateLookSeconds === 30 * DAY && late === Math.ceil((400 - 180) / 30), true);
  is(
    `its capture reads stay within an order watched to its end plus the late looks (${unread.looks} read)`,
    typeof late === "number" && unread.looks <= standing.looks + late,
    true,
  );
  Date.now = realNow;
  done();
}
void main();
