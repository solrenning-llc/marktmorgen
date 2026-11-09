/**
 * Pre-review of claude5/paypal-capture-account (MEDIUM): the refund watch's last looks (lib/paypal-sales.ts,
 * watchPayPal, askLater) treated every failed read of a capture alike. Once PayPal's 180-day refund window had closed
 * and thirty grace days had passed, the order left the watch and the purchase stayed, even when the creator had refunded
 * in full inside the window and the read failed only because of a fault on PayPal's side or ours: a 503, a timeout or
 * a network error, or the partner's own token being refused.
 *
 * Now only the account's own refusal ends the watch after the grace days: PayPal answering 403 NOT_AUTHORIZED /
 * PERMISSION_DENIED (the account withdrew the platform's grant) or 404 INVALID_RESOURCE_ID (the account has no such
 * capture) to the capture read itself. Any other failure is asked again once a day for the thirty days, then once a
 * week until the paid record ends (400 days), so a refund made inside the window is still seen once PayPal answers
 * again, and the cost stays bounded (at most 58 reads an order after day 180, PAYPAL_WATCH_LOOKS in
 * tests/plan-cost-registry.ts, held by tests/paypal-watch-looks-cost.test.ts).
 *
 * Synthetic only: a stand-in for PayPal's API, the Redis stub, the real return route and the real sweep.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { PAYPAL_WATCH_LOOKS } from "./plan-cost-registry";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const ACCOUNT_A = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;
const captureOf = (order: string) => `3C679366HH9087${order.slice(-2)}`;
/** Which account took each capture: PayPal shows a capture only to that account. */
const takenBy = new Map<string, string>();
/** Captures PayPal answers as refunded in full. */
const refunded = new Set<string>();
/** Captures whose reads PayPal answers 503 (a PayPal-side outage). */
const unavailable = new Set<string>();
/** Captures whose reads never get an answer (a timeout or a network error: the request rejects). */
const unreachable = new Set<string>();
/** Captures the account answers 404 INVALID_RESOURCE_ID about: the account's own refusal. */
const notFound = new Set<string>();
/** The partner's own token refused: "401" as PayPal answers bad client credentials, "403" as a refused permission. */
let tokenRefused: "" | "401" | "403" = "";
/** Every capture read, with the account it was asked as and the test clock's offset when it was made. */
const captureReads: { capture: string; as: string; at: number }[] = [];
let buyerFor = "a@example.com";

/** The account a request is made as, from PayPal's unsigned PayPal-Auth-Assertion. */
function assertedAccount(headers: Headers): string {
  const part = (headers.get("paypal-auth-assertion") ?? "").split(".")[1] ?? "";
  try {
    return String((JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { payer_id?: unknown }).payer_id ?? "");
  } catch {
    return "";
  }
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
  if (url.hostname !== "api-m.paypal.com") return json({ error: "unexpected" }, 404);
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  if (url.pathname === "/v1/oauth2/token") {
    if (tokenRefused === "401") return json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401);
    if (tokenRefused === "403") return json({ name: "NOT_AUTHORIZED", details: [{ issue: "PERMISSION_DENIED" }] }, 403);
    return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  }
  const as = assertedAccount(headers);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9-]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") {
    captureReads.push({ capture: cap, as, at: ahead });
    if (unreachable.has(cap)) throw new TypeError("fetch failed");
    if (unavailable.has(cap)) return json({ name: "SERVICE_UNAVAILABLE" }, 503);
    if (notFound.has(cap)) return json({ name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] }, 404);
  }
  if (url.pathname === "/v2/checkout/orders" && method === "POST") {
    made += 1;
    const id = orderId(made);
    orders.set(id, { id, status: "PAYER_ACTION_REQUIRED" });
    return json({ id, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" }] });
  }
  const capture = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname)?.[1];
  if (capture && method === "POST") {
    takenBy.set(captureOf(capture), as);
    const body = {
      id: capture,
      status: "COMPLETED",
      payer: { email_address: buyerFor, payer_id: "QYR5Z8XDVJNXQ" },
      purchase_units: [{ reference_id: "x", payee: { merchant_id: as }, payments: { captures: [{ id: captureOf(capture), status: "COMPLETED", amount: { currency_code: "USD", value: "49.00" } }] } }],
    };
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  if (cap && method === "GET") {
    if (takenBy.get(cap) !== as) return json({ name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] }, 404);
    return json({ id: cap, status: refunded.has(cap) ? "REFUNDED" : "COMPLETED" });
  }
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function buy(store: Store, productId: string, buyer: string): Promise<string> {
  const product = (await readListing(store, productId))!;
  const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
  if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
  buyerFor = buyer;
  await paypalReturn(
    new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=${store.handle}&token=${opened.order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${made}` } }),
  );
  return opened.order;
}

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_capture_outage";
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
  await setPayPalSeller("owner@example.com", ACCOUNT_A);
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const statsId = (await fresh()).statsId!;
  const owned = async (buyer: string) => (await importedFor(await fresh(), buyer)).length;
  const watched = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:watch:${statsId}`, order]]))[0];
  const refundMark = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:refunded:${statsId}`, order]]))[0];
  const sweep = async () => sweepPayPal(await fresh(), Date.now() + 10_000);
  const readsOf = (order: string, from = 0, to = Infinity) => captureReads.filter((r) => r.capture === captureOf(order) && r.at >= from && r.at < to);
  /** The sweep once a day, from day `from` to day `to` (inclusive), counted from `base`. */
  const daily = async (base: number, from: number, to: number, each?: (day: number) => void) => {
    for (let d = from; d <= to; d += 1) {
      ahead = base + d * DAY + 1000;
      each?.(d);
      await sweep();
    }
  };

  const outage = await buy(await fresh(), added.product.id, "outage@example.com");
  const timeout = await buy(await fresh(), added.product.id, "timeout@example.com");
  const refusedSale = await buy(await fresh(), added.product.id, "refused@example.com");
  is("three sales handed over", [await owned("outage@example.com"), await owned("timeout@example.com"), await owned("refused@example.com")], [1, 1, 1]);

  part("PayPal's capture reads answer 503 from day 175 to day 215; the creator refunds in full on day 178");
  unreachable.add(captureOf(timeout));
  notFound.add(captureOf(refusedSale));
  await daily(0, 175, 214, (d) => {
    if (d === 175) unavailable.add(captureOf(outage));
    if (d === 178) refunded.add(captureOf(outage));
  });
  unavailable.delete(captureOf(outage));
  await daily(0, 216, 217);
  is("a refund made inside the window during a PayPal outage takes the purchase back once PayPal answers again", (await owned("outage@example.com")), 0);
  is("and it is marked refunded and leaves the watch", [(await refundMark(outage)) !== null, await watched(outage)], [true, null]);

  part("The account's own refusal (404 INVALID_RESOURCE_ID) still ends the watch after the thirty grace days");
  is("no longer watched", await watched(refusedSale), null);
  is("the purchase is kept and never marked refunded", [await owned("refused@example.com"), (await refundMark(refusedSale)) === null], [1, true]);
  is("never asked about after day 210", readsOf(refusedSale, 211 * DAY).length, 0);

  part("Reads that never get an answer (a timeout, a network error): asked once a week from day 210 until the paid record ends at 400 days");
  // Altered 2026-11-09 (rule 23): a read failing past the thirty daily days is asked once a week, not once a day, until
  // the record ends (lib/paypal-sales.ts, lookAfterFailure; the cost of each look is in PAYPAL_WATCH_LOOKS).
  is("still watched on day 217, asked again in a week", Number(await watched(timeout)) - Math.floor(Date.now() / 1000), 7 * 86_400);
  await daily(0, 218, 398);
  is("still watched on day 398", (await watched(timeout)) !== null, true);
  is("the purchase is kept and never marked refunded meanwhile", [await owned("timeout@example.com"), (await refundMark(timeout)) === null], [1, true]);
  // Altered 2026-11-09 (rule 23): at most once a day to day 210 and once a week after it, not once a day to the end.
  is("asked once a day to day 210, then once a week (days 180 to 398)", readsOf(timeout, 180 * DAY, 399 * DAY).length <= 30 + 28, true);
  await daily(0, 399, 402);
  is("once the paid record has ended, no longer watched", await watched(timeout), null);
  const after = readsOf(timeout).length;
  await daily(0, 403, 405);
  is("and never asked about again", readsOf(timeout).length - after, 0);
  // Altered 2026-11-09 (rule 23): bounded by the registry's looks a sale (PAYPAL_WATCH_LOOKS: 410 inside the window, 58
  // after it), not by a daily look to 400 days; this test sweeps once a day, so it makes fewer.
  is("every read of it in its whole life stays bounded (the registry's looks a sale)", readsOf(timeout).length <= PAYPAL_WATCH_LOOKS.inWindowPerSaleMost + PAYPAL_WATCH_LOOKS.pastWindowPerSaleMost, true);

  part("The partner's own token refused (401, or 403 PERMISSION_DENIED) from day 175 to day 215; refund on day 178");
  const base = 410 * DAY;
  ahead = base;
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const tokenSale = await buy(await fresh(), added.product.id, "token@example.com");
  is("handed over", await owned("token@example.com"), 1);
  // Alternates so that both a 401 and a 403 PERMISSION_DENIED from the token request fall past day 210: neither is
  // the account's refusal of the capture, so neither may end the watch.
  await daily(base, 175, 214, (d) => {
    tokenRefused = d % 2 === 0 ? "403" : "401";
    if (d === 178) refunded.add(captureOf(tokenSale));
  });
  tokenRefused = "";
  await daily(base, 216, 217);
  is("a refund made inside the window while the partner's token was refused takes the purchase back", await owned("token@example.com"), 0);
  is("and it is marked refunded", (await refundMark(tokenSale)) !== null, true);
  done();
}
main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
