/**
 * Issue #4140 (privacy): a PayPal sale whose receipt was refused stays on the hand-over list, and the sweep hands it
 * over again. A buyer deleted from the store in between had their purchase grant written back by that retry
 * (grantImported, HSETNX), before the receipt's own deletion check (KEEP_RECEIPT) refused the receipt. A retry now
 * reads the person's deletion print first: deleted at or after the payment, the order leaves the list and nothing
 * about them is written. Someone deleted before they paid again is still handed what they paid for.
 *
 * Synthetic: the harness of tests/paypal-receipt-retry.test.ts (PayPal and Resend stand-ins, the Redis stub, the
 * real return route and the real sweep).
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
import { erasePerson } from "@/lib/person-erasure";

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

  const grants = async () => (await importedFor(await fresh(), BUYER)).filter((p) => p.productId === product.id).length;

  part("Refused receipt, then the buyer is deleted, then the sweep");
  mail = "422";
  const order = await pay(1);
  mail = "up";
  is("control: paid and granted on the return, the order kept for its receipt", [Boolean(await readPaid(order)), await grants(), (await listed()).includes(order)], [true, 1, true]);
  const erased = await erasePerson(await fresh(), BUYER, { kind: "person" });
  is("control: the deletion went through and took the grant", [erased.ok, await grants()], [true, 0]);
  await sweep();
  is("the sweep writes nothing back about them: no grant", await grants(), 0);
  is("no receipt is sent", toBuyer(order).length, 0);
  is("and the order leaves the hand-over list", (await listed()).includes(order), false);
  await sweep();
  is("a later sweep still writes nothing", await grants(), 0);

  part("The deletion print read in another shape: unknown, so kept and nothing written (rule 24)");
  mail = "422";
  const odd = await pay(3);
  mail = "up";
  const grantedBefore = await grants();
  type Pipe = (commands: (string | number)[][]) => Promise<unknown[]>;
  const real: Pipe = redis.pipeline.bind(redis);
  (redis as unknown as { pipeline: Pipe }).pipeline = async (commands) =>
    commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).startsWith("nl:erased:") ? ["not seconds"] : real(commands);
  const receiptsBefore = toBuyer(odd).length;
  await sweep();
  (redis as unknown as { pipeline: Pipe }).pipeline = real;
  is("the order stays on the list", (await listed()).includes(odd), true);
  is("and nothing more is sent or granted on that sweep", [toBuyer(odd).length, await grants()], [receiptsBefore, grantedBefore]);
  await sweep();
  is("read again in its shape, it is handed over at the next sweep", [toBuyer(odd).length, (await listed()).includes(odd)], [receiptsBefore + 1, false]);

  part("The deletion lands between the retry's check and its hand-over (Codex G on #4163): nothing stays written");
  mail = "422";
  const raced = await pay(4);
  mail = "up";
  is("control: granted on the return and kept for its receipt", [await grants(), (await listed()).includes(raced)], [1, true]);
  const realRace: Pipe = redis.pipeline.bind(redis);
  let erasedMidway = false;
  (redis as unknown as { pipeline: Pipe }).pipeline = async (commands) => {
    const answer = await realRace(commands);
    // Right after the retry has read the person's deletion print (none yet), the person is deleted from the store.
    if (!erasedMidway && commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).startsWith("nl:erased:")) {
      erasedMidway = true;
      (redis as unknown as { pipeline: Pipe }).pipeline = realRace;
      await erasePerson(await fresh(), BUYER, { kind: "person" });
    }
    return answer;
  };
  const receiptsBeforeRace = toBuyer(raced).length;
  await sweep();
  (redis as unknown as { pipeline: Pipe }).pipeline = realRace;
  is("control: the deletion did land between the check and the hand-over", erasedMidway, true);
  is("no grant is left written about them", await grants(), 0);
  is("no receipt is sent", toBuyer(raced).length, receiptsBeforeRace);
  is("and the order leaves the list", (await listed()).includes(raced), false);

  part("The deletion again after a raced hand-over fails once (Claude 7 on #4163): the next sweep still deletes the grant");
  ahead += 120_000;
  mail = "422";
  const failedOnce = await pay(5);
  mail = "up";
  is("control: granted on the return and kept for its receipt", [await grants(), (await listed()).includes(failedOnce)], [1, true]);
  const realFail: Pipe = redis.pipeline.bind(redis);
  let hgets = 0;
  let broken = false;
  (redis as unknown as { pipeline: Pipe }).pipeline = async (commands) => {
    if (broken) throw new Error("synthetic: Redis down for the rest of this sweep");
    const answer = await realFail(commands);
    if (commands.length === 1 && commands[0][0] === "HGET" && String(commands[0][1]).startsWith("nl:erased:")) {
      hgets += 1;
      // After the first read (none yet) the person is deleted; after the second, Redis fails, so the deletion again fails.
      if (hgets === 1) {
        (redis as unknown as { pipeline: Pipe }).pipeline = realFail;
        await erasePerson(await fresh(), BUYER, { kind: "person" });
        (redis as unknown as { pipeline: Pipe }).pipeline = async (c) => {
          if (broken) throw new Error("synthetic: Redis down for the rest of this sweep");
          const a = await realFail(c);
          if (c.length === 1 && c[0][0] === "HGET" && String(c[0][1]).startsWith("nl:erased:")) broken = true;
          return a;
        };
      }
    }
    return answer;
  };
  await sweep().catch(() => 0);
  (redis as unknown as { pipeline: Pipe }).pipeline = realFail;
  is("control: the deletion again did fail on that sweep", broken, true);
  await sweep();
  is("the next sweep deletes what the raced hand-over wrote: no grant", await grants(), 0);
  is("and only then the order leaves the list", (await listed()).includes(failedOnce), false);

  part("Control: deleted before paying again, the new purchase is handed over");
  // A payment made after the deletion, at a later second than it.
  ahead += 120_000;
  const before = await grants();
  const again = await pay(2);
  is("granted and receipted on the return", [(await grants()) >= before, toBuyer(again).length, (await listed()).includes(again)], [true, 1, false]);

  done();
}

void main();
