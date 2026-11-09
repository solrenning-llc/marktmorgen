/**
 * A PayPal purchase's receipt is retried until the sender accepts it (audit R48, finding 4, PayPal part).
 *
 * Synthetic: PayPal and Resend stand-ins, the Redis stub, the real return route and the real sweep (sweepPayPal).
 * The receipt carries the buyer's confirmation, on a durable medium, of the yes to start access at once
 * (consentEmailLines), so a receipt the sender did not take must not be dropped:
 *
 *   - healthy: one receipt, and the order leaves the hand-over list at once (unchanged);
 *   - the sender refuses it (422) on the return: the order stays on the list, and the next sweep with the service
 *     back sends the receipt once, under the same idempotency key, and then the order leaves the list;
 *   - the sender's answer is unknown (the request throws): it may have been taken, so the same email under the same
 *     key is never sent again (money review of #3387; tests/paypal-receipt-once.test.ts has the other senders' side),
 *     and the order leaves the list at its window's end;
 *   - sent once, never twice: more sweeps send nothing more, the buyer's grant is written once;
 *   - bounded: past RECEIPT_RETRY_SECONDS (22 hours) after its first try, inside the providers' one-day idempotency window, an
 *     order whose receipt is still refused leaves the list, so it is never retried forever nor sent twice.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { type Listing, readListing } from "@/lib/catalog";
import { openOrder, readPaid } from "@/lib/paypal-sales";
import * as delivery from "@/lib/paypal-delivery";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const BUYER = "buyer@example.com";
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
const orderId = (n: number) => `5O190127TN36471${String(n).padStart(2, "0")}`;
let mail: "up" | "422" | "503" | "throws" = "up";
const receipts: { to: string[]; text: string; key: string | null }[] = [];
/** Every POST to the sender, accepted or not, by idempotency key. */
const tries: string[] = [];

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9087${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

function idempotencyKeyOf(init?: RequestInit): string | null {
  const headers = new Headers(init?.headers);
  return headers.get("idempotency-key");
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") {
    if (url.pathname === "/emails") tries.push(idempotencyKeyOf(init) ?? "");
    if (mail === "422") return json({ name: "validation_error", message: "synthetic refusal" }, 422);
    if (mail === "503") return json({ name: "service_unavailable", message: "synthetic outage" }, 503);
    if (mail === "throws") throw new TypeError("synthetic: fetch failed");
    receipts.push({ ...JSON.parse(String(init?.body)), key: idempotencyKeyOf(init) });
    return json({ id: `e_${receipts.length}` });
  }
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
    const body = completed(capture, "49.00", BUYER);
    orders.set(capture, body);
    return json(body, 201);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
const handOverKey = (statsId: string) => `nl:ppsell:handover:${statsId}`;

async function main(): Promise<void> {
  redis.clear();
  console.error = () => {};
  process.env.RESEND_API_KEY = "re_test_paypal_sales";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
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
  const store: Store = (await storeForEmail("owner@example.com"))!;
  const statsId = store.statsId!;
  const product: Listing = (await readListing(store, added.product.id))!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const listed = async () => (await redis.pipeline([["ZRANGEBYSCORE", handOverKey(statsId), "-inf", "+inf"]]))[0] as string[];
  const sweep = async (hours = 1): Promise<number> => {
    ahead += hours * 3_600_000;
    return (await delivery.sweepPayPal(await fresh(), Date.now() + 10_000)).cleared;
  };
  const pay = async (n: number): Promise<string> => {
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(opened.reason);
    await paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${opened.order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${n}` } }));
    return opened.order;
  };
  const toBuyer = (order: string) => receipts.filter((r) => r.to[0] === BUYER && r.key === `nimbus-paypal:${order}`);

  part("Healthy: one receipt, and the order leaves the hand-over list at once");
  const first = await pay(1);
  is("one receipt sent, under the order's idempotency key", toBuyer(first).length, 1);
  is("it carries the consent confirmation", (toBuyer(first)[0]?.text ?? "").includes(TEST_CONSENT.version), true);
  is("the order is no longer owed a hand-over", (await listed()).includes(first), false);
  await sweep();
  is("a later sweep sends nothing more", toBuyer(first).length, 1);

  part("The sender refuses it (422) on the return: kept, then sent once at the next sweep");
  mail = "422";
  const second = await pay(2);
  mail = "up";
  is("paid and granted on the return", [Boolean(await readPaid(second)), (await importedFor(await fresh(), BUYER)).length >= 1], [true, true]);
  is("no receipt accepted yet", toBuyer(second).length, 0);
  is("the order stays on the hand-over list", (await listed()).includes(second), true);
  await sweep();
  is("the next sweep with the service back sends the receipt", toBuyer(second).length, 1);
  is("then the order leaves the list", (await listed()).includes(second), false);
  await sweep();
  await sweep();
  is("never sent twice", toBuyer(second).length, 1);

  part("The sender's answer is unknown (the request throws): kept, and the same email is never sent again");
  mail = "throws";
  const third = await pay(3);
  is("no receipt accepted", toBuyer(third).length, 0);
  is("the order stays on the list", (await listed()).includes(third), true);
  const stillOwed = await sweep();
  is("still unknown at the first sweep: still kept", (await listed()).includes(third), true);
  is("and not counted as handed over by that sweep", stillOwed, 0);
  mail = "up";
  await sweep();
  is("with the service back, no second request under its key: the first may have been taken", tries.filter((key) => key === `nimbus-paypal:${third}`).length, 1);
  await sweep(22);
  is("past its window it leaves the list", (await listed()).includes(third), false);
  is("never a second request", tries.filter((key) => key === `nimbus-paypal:${third}`).length, 1);
  is("the buyer's grant is written once for the product", (await importedFor(await fresh(), BUYER)).filter((p) => p.productId === product.id).length, 1);

  // Read through the module so the file runs before the window exists (RED); 22 hours is what it must be.
  const WINDOW = 22 * 3600;
  part("Bounded: past the retry window the order leaves the list, never retried forever");
  mail = "503";
  const fourth = await pay(4);
  is("kept at first", (await listed()).includes(fourth), true);
  await sweep();
  is("still kept inside the window", (await listed()).includes(fourth), true);
  await sweep(WINDOW / 3600 + 1);
  is("past the window it leaves the list", (await listed()).includes(fourth), false);
  is("the window is 22 hours, inside the providers' one-day idempotency window", (delivery as Record<string, unknown>).RECEIPT_RETRY_SECONDS, WINDOW);
  mail = "up";
  await sweep();
  is("nothing is sent for it afterward", toBuyer(fourth).length, 0);

  part("Paced: a refusal that lasts the whole window is tried about a dozen times, not every five-minute run");
  mail = "422";
  const fifth = await pay(5);
  const fifthPaidAt = (await readPaid(fifth))!.at;
  let lastTry = 0;
  for (let run = 0; run < (26 * 3600) / 300; run += 1) {
    const before = tries.length;
    await sweep(300 / 3600);
    if (tries.slice(before).includes(`nimbus-paypal:${fifth}`)) lastTry = Math.floor(Date.now() / 1000);
  }
  const fifthTries = tries.filter((key) => key === `nimbus-paypal:${fifth}`).length;
  is("tried more than once, and at most 16 times in 26 hours of five-minute runs", fifthTries > 1 && fifthTries <= 16 ? "bounded" : fifthTries, "bounded");
  is("the last try is inside a day of the payment, under the same idempotency key", lastTry - fifthPaidAt < 86_400 - 3600, true);
  console.log(`        tries: ${fifthTries}`);
  is("then off the list", (await listed()).includes(fifth), false);
  mail = "up";

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
