/**
 * Codex G (G-20261120-1631, MEDIUM, money and store erasure): the PayPal refund watch waits for PayPal's answer about a
 * paid capture, and on REFUNDED, REVERSED, FAILED or DECLINED wrote the store's taken-back marks (nl:ppsell:reversed:,
 * nl:ppsell:refunded:) and the lasting record the affiliate book reads (nl:ppsell:back:, through orderWrite, which also
 * charges the store's data room) with plain writes. A store erasure that began and ended while PayPal was answering
 * saw those erased families, and the store's room, made again for a store already erased, and the buyer could still be
 * told. Each of those writes now runs in one step with the store's fence (its id key still there and the store not
 * being erased, the fence the watch's own ZADD already uses, PAYPAL_WATCH_IF_LIVE); refused, nothing is marked, put
 * back on the watch or told. Synthetic PayPal, clock and Redis only; fetch answers only the stand-ins here.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, storeIdCommand, storeRef, ERASING_KEY, erasingField } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { backKey, captureOrder, openOrder, refundedKey, reversedKey, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const SELLER = "7KNGBPH2U58GQ";
const START = Math.floor(Date.now() / 1000);
let clock = START;
const realNow = Date.now.bind(Date);
Date.now = () => clock * 1000;

let captureStatus = "COMPLETED";
/** Run once while PayPal is answering about a capture: the store's erasure, in the middle of the watch's wait. */
let whileCaptureAnswers: (() => Promise<void>) | null = null;
let made = 0;
let mails = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    mails += 1;
    return json({ id: "e" });
  }
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
    const step = whileCaptureAnswers;
    whileCaptureAnswers = null;
    if (step) await step();
    return json({ id: cap, status: captureStatus });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

async function seller(owner: string, handle: string) {
  await claimHandle(owner, handle, `${handle} shop`, "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: `cus_${handle.slice(0, 8)}0001`, subscriptionId: `sub_${handle.slice(0, 8)}0001`, active: true, period: paidPeriod() });
  const added = await addProduct(owner, "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink(owner, added.product.id, "https://example.com/guide");
  await setPayPalSeller(owner, SELLER);
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, added.product.id))!;
  const sale = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!sale.ok) throw new Error("no order");
  const paid = await captureOrder(store, sale.order);
  if (!paid.ok) throw new Error("not paid");
  await handOverPayPal(store, paid.paid);
  const watch = `nl:ppsell:watch:${store.statsId}`;
  const due = (await redis.pipeline([["ZSCORE", watch, sale.order]]))[0];
  if (due === null) throw new Error("not on the watch");
  clock = Math.max(clock, Number(due));
  return { store, watch, order: sale.order };
}

const on = { handOver: async () => {}, dropStart: async () => {} };

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_probe_c";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = "AZpartnerClientId0123456789";
  process.env.PAYPAL_PARTNER_SECRET = "EPpartnerSecret0123456789";
  process.env.PAYPAL_PARTNER_MERCHANT_ID = "PARTNERMERCH01";
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";

  for (const status of ["REFUNDED", "REVERSED"] as const) {
    part(`PayPal answers ${status} after the store's erasure ran during the wait: nothing of the store is made again`);
    const { store, watch } = await seller(`owner-${status.toLowerCase()}@example.com`, `harbor${status.toLowerCase()}`);
    const statsId = store.statsId as string;
    const room = dataKey(store);
    const erased = [watch, refundedKey(statsId), reversedKey(statsId), backKey(statsId), ...(room ? [room] : [])];
    captureStatus = status;
    let ran = false;
    whileCaptureAnswers = async () => {
      ran = true;
      // The whole erasure, begun and ended while PayPal answers: its mark, its id key and its families gone.
      await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(clock)], ["DEL", storeIdCommand(store.sid)[1]], ...erased.map((key) => ["DEL", key])]);
    };
    const before = mails;
    await watchPayPal(store, Date.now() + 10_000, on);
    is("the erasure ran while PayPal was answering", ran, true);
    for (const key of erased) is(`${key.replace(statsId, "<store>")} is not made again`, (await redis.pipeline([["EXISTS", key]]))[0], 0);
    is("nobody is told of a taken-back payment for a store already erased", mails - before, 0);
  }

  part("The erasure has begun but the store's id key is still there: still nothing marked");
  {
    const { store, watch } = await seller("owner-marked@example.com", "harbormarked");
    const statsId = store.statsId as string;
    captureStatus = "REFUNDED";
    whileCaptureAnswers = async () => {
      await redis.pipeline([["HSET", ERASING_KEY, await erasingField(storeRef(store)), String(clock)], ["DEL", watch]]);
    };
    await watchPayPal(store, Date.now() + 10_000, on);
    is("the store keeps its id key while being erased", (await redis.pipeline([["EXISTS", storeIdCommand(store.sid)[1]]]))[0], 1);
    is("no refund mark for a store being erased", (await redis.pipeline([["EXISTS", refundedKey(statsId)]]))[0], 0);
    is("no lasting record either", (await redis.pipeline([["EXISTS", backKey(statsId)]]))[0], 0);
  }

  part("Control: a live store's refund is marked, kept for good and taken off the watch, as before");
  {
    const { store, watch, order } = await seller("owner-live@example.com", "harborlive");
    const statsId = store.statsId as string;
    captureStatus = "REFUNDED";
    await watchPayPal(store, Date.now() + 10_000, on);
    is("the refund is marked", (await redis.pipeline([["ZSCORE", refundedKey(statsId), order]]))[0] !== null, true);
    is("and kept for good for the affiliate book", (await redis.pipeline([["HLEN", backKey(statsId)]]))[0], 1);
    is("and the order leaves the watch", (await redis.pipeline([["ZSCORE", watch, order]]))[0], null);
  }

  part("Control: a reversed payment on a live store gets its own mark too");
  {
    const { store, order } = await seller("owner-rev@example.com", "harborrev");
    const statsId = store.statsId as string;
    captureStatus = "REVERSED";
    await watchPayPal(store, Date.now() + 10_000, on);
    is("the reversed mark", (await redis.pipeline([["ZSCORE", reversedKey(statsId), order]]))[0] !== null, true);
    is("and the refund mark beside it", (await redis.pipeline([["ZSCORE", refundedKey(statsId), order]]))[0] !== null, true);
  }

  Date.now = realNow;
  done();
}

void main().catch((error) => { console.error(error); process.exit(1); });
