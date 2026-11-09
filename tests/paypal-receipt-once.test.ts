/**
 * A PayPal receipt tried again is the same email, through the same sender, and never after its keys could have
 * expired (money review of #3387, probes A, B, C and the list's re-add).
 *
 * Synthetic: the SES and Resend stand-ins (tests/ses-mail-fixture.ts, with the guarded Resend transport's synthetic
 * account), a PayPal stand-in, the Redis stub, the real return route and the real sweep (sweepPayPal). Every request
 * a sender received for the buyer is counted as a copy that may have reached them: an accepted one, and one whose
 * answer was lost or was a 503.
 *
 *   A:  Amazon's answer is lost, then Amazon is not ready: the next tries never go to Resend;
 *   A2: Resend answers 503, then Amazon is ready again: the next tries never go to Amazon;
 *   B:  Amazon's answer is lost, then no job runs for 25 hours: the late sweep sends nothing more;
 *   C:  Resend alone answers 503 for 26 hours of five-minute runs: one request, one body;
 *   D:  an order a concurrent run took off the list while its receipt was being tried is not put back;
 *   E:  Amazon refuses it for the whole window: tried at most RECEIPT_TRIES_AT_MOST times, each try's Redis commands
 *       at most the registry's (PAYPAL_HAND_OVER_RETRY in tests/plan-cost-registry.ts; the Resend side is held by
 *       tests/paypal-handover-cost.test.ts).
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { claimHandle, ensureStatsId, addProduct, setProductLink, setSubscription, setPayPalSeller, storeForEmail, type Store } from "@/lib/store";
import { type Listing, readListing } from "@/lib/catalog";
import { openOrder } from "@/lib/paypal-sales";
import * as delivery from "@/lib/paypal-delivery";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { PAYPAL_HAND_OVER_RETRY } from "./plan-cost-registry";
import { installSesMailFixture } from "./ses-mail-fixture";
import { NextRequest } from "next/server";
import { GET as paypalReturn } from "@/app/api/store/paypal/return/route";

const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const SELLER = "7KNGBPH2U58GQ";
const DAY_MS = 86_400_000;
const orders = new Map<string, Record<string, unknown>>();
let made = 0;
let buyerFor = "buyer@example.com";
const orderId = (n: number) => `6P290127TN36471${String(n).padStart(2, "0")}`;
/** What Resend answers: accepted, or a 503 (its answer not known to be a refusal). */
let resendMode: "up" | "503" = "up";
/** Called on each Resend request before it is answered (probe D). */
let onResendPost: (() => void) | null = null;
/** Every Resend request: its idempotency key and body text. */
const resendPosts: { key: string; to: string; text: string }[] = [];

function completed(order: string, value: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `4D679366HH9087${order.slice(-2)}`, status: "COMPLETED", amount: { currency_code: "USD", value } }] } }],
  };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
async function paypal(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
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
}

const mail = installSesMailFixture({
  fallback: paypal,
  onResend: (messages, _input, init) => {
    const key = new Headers(init?.headers).get("idempotency-key") ?? "";
    for (const m of messages) resendPosts.push({ key, to: m.to[0] ?? "", text: m.text });
    onResendPost?.();
    return resendMode === "503" ? json({ name: "service_unavailable", message: "synthetic outage" }, 503) : undefined;
  },
});

const realNow = Date.now.bind(Date);
let ahead = 0;
Date.now = () => realNow() + ahead;
/** Moves the clock to a minute after the next UTC midnight, so a probe's day of tries stays inside one synthetic Resend account day. */
const startOfNextDay = () => {
  const now = Date.now();
  ahead += Math.ceil(now / DAY_MS) * DAY_MS + 60_000 - now;
};
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
  startOfNextDay();

  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod(Date.now(), { behind: 10, ahead: 40 }) });
  const added = await addProduct("owner@example.com", "Sourdough Guide", "", "49", null);
  if (!added.ok) throw new Error("no product");
  await setProductLink("owner@example.com", added.product.id, "https://example.com/guide");
  await setPayPalSeller("owner@example.com", SELLER);
  const store: Store = (await storeForEmail("owner@example.com"))!;
  const statsId = store.statsId!;
  const product: Listing = (await readListing(store, added.product.id))!;
  const fresh = async () => (await storeForEmail("owner@example.com"))!;
  const listed = async () => (await redis.pipeline([["ZRANGEBYSCORE", handOverKey(statsId), "-inf", "+inf"]]))[0] as string[];
  const sweep = async (hours = 1): Promise<void> => {
    ahead += hours * 3_600_000;
    await delivery.sweepPayPal(await fresh(), Date.now() + 10_000);
  };
  const sweeps = async (count: number, hours = 1) => {
    for (let i = 0; i < count; i += 1) await sweep(hours);
  };
  const pay = async (n: number, buyer: string): Promise<string> => {
    buyerFor = buyer;
    const opened = await openOrder(store, product, "https://marktmorgen.com", { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(opened.reason);
    await paypalReturn(new NextRequest(`https://marktmorgen.com/api/store/paypal/return?store=harbor&token=${opened.order}`, { headers: { host: "marktmorgen.com", "x-forwarded-for": `198.51.100.${n}` } }));
    return opened.order;
  };
  /** Every request either sender received for this buyer: each one may have reached them. */
  const copies = (buyer: string) => mail.attempts.filter((m) => m.to.includes(buyer));
  const sesTo = (buyer: string) => mail.sesAttempts.filter((m) => m.to.includes(buyer)).length;
  const resendTo = (buyer: string) => mail.resendAttempts.filter((m) => m.to.includes(buyer)).length;

  part("A: Amazon's answer is lost, then Amazon is not ready: the receipt never goes through Resend");
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome(["lost"]);
  const buyerA = "lost-ses@example.com";
  const a = await pay(1, buyerA);
  is("one request to Amazon, its answer lost", [sesTo(buyerA), resendTo(buyerA)], [1, 0]);
  is("the order is still owed its receipt", (await listed()).includes(a), true);
  await mail.setReady(false);
  await sweeps(4);
  is("Amazon not ready: no request to Resend for this receipt", resendTo(buyerA), 0);
  await mail.setReady(true);
  await sweeps(4);
  is("Amazon ready again: no second request to Amazon either", sesTo(buyerA), 1);
  is("at most one copy may have reached the buyer", copies(buyerA).length, 1);
  await sweeps(20);
  is("past its window the order leaves the list", (await listed()).includes(a), false);
  is("still one copy at most", copies(buyerA).length, 1);

  part("A2: Resend answers 503, then Amazon is ready: the receipt never goes through Amazon");
  startOfNextDay();
  mail.setSesOutcome("ok");
  await mail.setReady(false);
  resendMode = "503";
  const buyerA2 = "lost-resend@example.com";
  const a2 = await pay(2, buyerA2);
  is("one request to Resend, answered 503", [sesTo(buyerA2), resendTo(buyerA2)], [0, 1]);
  is("the order is still owed its receipt", (await listed()).includes(a2), true);
  resendMode = "up";
  await mail.setReady(true);
  await sweeps(4);
  is("Amazon ready: no request to Amazon for this receipt", sesTo(buyerA2), 0);
  is("at most one copy may have reached the buyer", copies(buyerA2).length, 1);
  await sweeps(20);
  is("past its window the order leaves the list", (await listed()).includes(a2), false);
  is("still one copy at most", copies(buyerA2).length, 1);

  part("B: Amazon's answer is lost, then no job runs for 25 hours: the late sweep sends nothing more");
  startOfNextDay();
  await mail.setReady(true);
  mail.setSesOutcome(["lost"]);
  const buyerB = "late-sweep@example.com";
  const b = await pay(3, buyerB);
  is("one request to Amazon, its answer lost", copies(buyerB).length, 1);
  await sweep(25);
  is("the sweep 25 hours later sends no second copy", copies(buyerB).length, 1);
  is("and the order leaves the list", (await listed()).includes(b), false);

  part("C: Resend alone answers 503 for 26 hours: one request and one body, not one a try");
  startOfNextDay();
  mail.disableSes();
  resendMode = "503";
  const buyerC = "resend-outage@example.com";
  const c = await pay(4, buyerC);
  for (let run = 0; run < (26 * 3600) / 300; run += 1) await sweep(300 / 3600);
  const toC = resendPosts.filter((p) => p.to === buyerC);
  is("one request to Resend in 26 hours", toC.length, 1);
  is("every request carries the same body", new Set(toC.map((p) => p.text)).size, 1);
  is("under the order's idempotency key", toC.map((p) => p.key), [`nimbus-paypal:${c}`]);
  is("then off the list", (await listed()).includes(c), false);
  resendMode = "up";

  part("D: an order taken off the list while its receipt was tried is not put back");
  startOfNextDay();
  const buyerD = "taken-off@example.com";
  resendMode = "503";
  let paidD = "";
  onResendPost = () => {
    // Another run took it off the list (handed over, or its paid record gone) while this one was sending.
    if (paidD) redis.run(["ZREM", handOverKey(statsId), paidD]);
  };
  paidD = orderId(made + 1);
  const d = await pay(5, buyerD);
  onResendPost = null;
  resendMode = "up";
  is("the order paid is the one watched", d, paidD);
  is("the receipt was tried once", resendTo(buyerD), 1);
  is("not put back on the list", (await listed()).includes(d), false);

  part("E: Amazon refuses it for the whole window: bounded tries, each try's commands as the registry states");
  startOfNextDay();
  mail.configure();
  await mail.setReady(true);
  mail.setSesOutcome("refused");
  const buyerE = "ses-refused@example.com";
  const e = await pay(6, buyerE);
  const paidKey = `nl:ppsell:paid:${e}`;
  let mostATry = 0;
  for (let run = 0; run < (26 * 3600) / 300; run += 1) {
    ahead += 300_000;
    const sent: (string | number)[][] = [];
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      sent.push(...commands);
      return pipeline(commands);
    }) as typeof redis.pipeline;
    try {
      await delivery.sweepPayPal(await fresh(), Date.now() + 10_000);
    } finally {
      redis.pipeline = pipeline;
    }
    const from = sent.findIndex((c) => c[0] === "GET" && c[1] === paidKey);
    if (from < 0) continue;
    const to = sent.findLastIndex((c) => c[1] === handOverKey(statsId) && c[c.length - 1] === e);
    mostATry = Math.max(mostATry, to - from + 1);
  }
  mail.setSesOutcome("ok");
  console.log(`        tries: ${sesTo(buyerE)}, most commands a try: ${mostATry}`);
  is("only Amazon was asked", resendTo(buyerE), 0);
  is("tried more than once and at most RECEIPT_TRIES_AT_MOST times", sesTo(buyerE) > 1 && sesTo(buyerE) <= delivery.RECEIPT_TRIES_AT_MOST, true);
  is("one try's Redis commands at most as the registry states", mostATry > 0 && mostATry <= Number((PAYPAL_HAND_OVER_RETRY as Record<string, number>).commandsPerReceiptTry), true);
  is("then off the list", (await listed()).includes(e), false);

  done();
}

main().catch((error) => {
  console.log(String(error?.stack ?? error));
  process.exit(1);
});
