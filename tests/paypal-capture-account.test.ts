/**
 * Claude 6's MEDIUM 3 in audit 18 (main d8941c907a), taken by Claude 5: the PayPal refund watch read each capture as
 * the PayPal account the store has connected TODAY (lib/paypal-sales.ts, watchPayPal), not as the account that took
 * the payment. After a creator moves from account A to account B, PayPal does not show B a capture A took, so a full
 * refund made in A never took the purchase back, and the failed read put the order back on the watch an hour later,
 * every hour, for ever.
 *
 * Now each PayPal sale keeps the account that captured it (Paid.merchant, from the order's own payee) and the watch
 * asks PayPal as that account, which the partner credentials can do while that account keeps its grant to the
 * platform. A read that fails is asked again on the watch's own schedule (nextLook), never more often; once PayPal's
 * 180-day refund window has closed it is asked once a day for thirty more days, and then the order leaves the watch:
 * the purchase is kept (nothing is taken back without PayPal's word) and it is never marked refunded, so it is neither
 * "refunded" nor "paid for sure" without proof.
 *
 * Synthetic only: a stand-in for PayPal's API that shows each capture only to the account that took it, the Redis
 * stub, the real return route and the real sweep.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { MAX_PAID_BYTES, openOrder, paypalOrdersOf, readPaid } from "@/lib/paypal-sales";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const ACCOUNT_A = "7KNGBPH2U58GQ";
const ACCOUNT_B = "9QZXWV3RT62LM";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;
const captureOf = (order: string) => `3C679366HH9087${order.slice(-2)}`;
/** Which account took each capture: PayPal shows a capture only to that account. */
const takenBy = new Map<string, string>();
/** Captures PayPal answers as refunded in full. */
const refunded = new Set<string>();
/** Accounts that withdrew their grant to the platform: PayPal answers 403 to anything asked as them. */
const withdrawn = new Set<string>();
/** Every capture read, with the account it was asked as. */
const captureReads: { capture: string; as: string }[] = [];
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
  if (url.pathname === "/v1/oauth2/token") return json({ access_token: "A21AApartner", token_type: "Bearer", expires_in: 32400 });
  const as = assertedAccount(headers);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9-]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") captureReads.push({ capture: cap, as });
  if (withdrawn.has(as)) return json({ name: "NOT_AUTHORIZED", details: [{ issue: "PERMISSION_DENIED" }] }, 403);
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
    // Another account's capture is not found, as PayPal answers it.
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
  process.env.RESEND_API_KEY = "re_test_capture_account";
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
  const id = added.product.id;
  await setPayPalSeller("owner@example.com", ACCOUNT_A);
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const statsId = (await fresh()).statsId!;
  const owned = async (buyer: string) => (await importedFor(await fresh(), buyer)).length;
  const watched = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:watch:${statsId}`, order]]))[0];
  const refundMark = async (order: string) => (await redis.pipeline([["ZSCORE", `nl:ppsell:refunded:${statsId}`, order]]))[0];
  const sweep = async () => sweepPayPal(await fresh(), Date.now() + 10_000);
  const readsOf = (order: string) => captureReads.filter((r) => r.capture === captureOf(order));

  part("Two sales taken by account A, then the creator connects account B and sells once more");
  const refundedInA = await buy(await fresh(), id, "refunded-in-a@example.com");
  const keptInA = await buy(await fresh(), id, "kept-in-a@example.com");
  await setPayPalSeller("owner@example.com", ACCOUNT_B);
  const takenInB = await buy(await fresh(), id, "taken-in-b@example.com");
  is("all three handed over", [await owned("refunded-in-a@example.com"), await owned("kept-in-a@example.com"), await owned("taken-in-b@example.com")], [1, 1, 1]);
  is("each sale keeps the account that took it", [(await readPaid(refundedInA))?.merchant, (await readPaid(keptInA))?.merchant, (await readPaid(takenInB))?.merchant], [ACCOUNT_A, ACCOUNT_A, ACCOUNT_B]);

  part("A full refund made in account A, after the move to B, takes the purchase back");
  refunded.add(captureOf(refundedInA));
  refunded.add(captureOf(takenInB));
  ahead = 2 * HOUR;
  const first = await sweep();
  is("the capture is asked about as the account that took it", readsOf(refundedInA).map((r) => r.as), [ACCOUNT_A]);
  is("both refunds seen and both purchases taken back (A's and, as a control, B's)", [first.revoked, await owned("refunded-in-a@example.com"), await owned("taken-in-b@example.com")], [2, 0, 0]);
  is("A's refunded order is marked refunded and leaves the watch", [(await refundMark(refundedInA)) !== null, await watched(refundedInA)], [true, null]);
  is("the sale A took and nobody refunded keeps its purchase, watched on the normal schedule", [await owned("kept-in-a@example.com"), (await refundMark(keptInA)) === null, readsOf(keptInA).map((r) => r.as)], [1, true, [ACCOUNT_A]]);

  part("Account A withdraws its grant to the platform: never asked more often than the watch's schedule");
  withdrawn.add(ACCOUNT_A);
  ahead = 10 * DAY;
  const before = readsOf(keptInA).length;
  await sweep();
  const nowSeconds = Math.floor(Date.now() / 1000);
  is("one read, refused", readsOf(keptInA).length - before, 1);
  // At ten days the watch looks every six hours (nextLook); a read that fails is not asked about any sooner.
  is("asked again on the watch's own schedule (six hours at ten days), not every hour", Number(await watched(keptInA)) - nowSeconds, 6 * 3600);
  is("nothing taken back, nothing marked refunded", [await owned("kept-in-a@example.com"), (await refundMark(keptInA)) === null], [1, true]);

  part("PayPal's 180-day refund window closes: asked once a day for thirty more days, then the order leaves the watch");
  ahead = 181 * DAY;
  await sweep();
  // A passing fault at the last look must not miss a refund made inside the window (tests/paypal-sales-shape.test.ts).
  is("still watched, asked again in a day, not an hour", Number(await watched(keptInA)) - Math.floor(Date.now() / 1000), 86_400);
  ahead = 211 * DAY;
  await sweep();
  is("no longer watched", await watched(keptInA), null);
  is("the purchase is kept and never marked refunded (no proof either way)", [await owned("kept-in-a@example.com"), (await refundMark(keptInA)) === null], [1, true]);
  const after = readsOf(keptInA).length;
  ahead = 230 * DAY;
  await sweep();
  is("and it is never asked about again", readsOf(keptInA).length - after, 0);

  part("A paid record whose account is not an account id is unknown: asked about as nobody, looked at again in an hour");
  const odd = "6O190127TN3647199";
  const oddAt = Math.floor(Date.now() / 1000) - 3600;
  await redis.pipeline([
    ["SET", `nl:ppsell:paid:${odd}`, JSON.stringify({ store: statsId, order: odd, capture: "3C679366HH908799", email: "odd@example.com", product: id, cents: 4900, currency: "usd", at: oddAt, merchant: "not an account" })],
    ["ZADD", `nl:ppsell:watch:${statsId}`, String(oddAt), odd],
  ]);
  const oddBefore = captureReads.length;
  await sweep();
  is("PayPal is not asked", captureReads.length - oddBefore, 0);
  is("kept on the watch, an hour later", Number(await watched(odd)) - Math.floor(Date.now() / 1000), 3600);
  await redis.pipeline([["ZREM", `nl:ppsell:watch:${statsId}`, odd], ["DEL", `nl:ppsell:paid:${odd}`]]);

  part("The account is the creator's, not the buyer's: it stays out of the buyer's copy of their data");
  const copy = await paypalOrdersOf(statsId, [id], "kept-in-a@example.com");
  is("one order, without the creator's account", [copy.length, copy.every((paid) => !("merchant" in paid))], [1, true]);

  part("The record still weighs no more than MAX_PAID_BYTES at its heaviest");
  const meta: Record<string, string> = {};
  for (let i = 0; i < 20; i += 1) meta[`${String.fromCharCode(97 + i)}${"k".repeat(39)}`] = "\u0001".repeat(200);
  const heaviest = {
    store: "s".repeat(64),
    order: "A".repeat(36),
    capture: "C".repeat(64),
    email: `${"e".repeat(64)}@${"d".repeat(185)}.com`,
    product: "p".repeat(64),
    cents: Number.MAX_SAFE_INTEGER,
    currency: "usd",
    at: Number.MAX_SAFE_INTEGER,
    merchant: "M".repeat(20),
    handle: "h".repeat(64),
    meta,
    via: { aff: "a".repeat(12), rate: 100 },
    off: Number.MAX_SAFE_INTEGER,
    sale: 100,
  };
  is("a full record with its account fits", Buffer.byteLength(JSON.stringify(heaviest)) <= MAX_PAID_BYTES, true);

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
