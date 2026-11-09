/**
 * The page a buyer lands on after paying with PayPal (app/[handle]/thanks/page.tsx, PayPalThanks) says only what it
 * has read (PF1):
 *
 * - When the paid record or the pending mark cannot be read (Redis failing, or, with lib/paypal-sales.ts reading
 *   exactly, a reply in another shape), the page says it could not check the payment just now. It never says "We
 *   could not find this order" for a payment it could not look at, and it never falls into the error page.
 * - When the payment is recorded but nothing proves it was handed over, the page says the payment was received and is
 *   being handed over: no link to the purchase and no purchase event for the creator's pixels yet. The proof is this
 *   very order's grant (`paypal:<order>` in the buyer's record, written by lib/paypal-sales.ts deliverPayPal), not the
 *   pending mark: settle() clears that mark BEFORE anything is handed over (Claude 5's MEDIUM on #2911), so it says
 *   nothing about delivery. A grant that cannot be read means the page could not check.
 * - When the payment is recorded and this order's grant is there, the page is as before: the purchase, its link and
 *   the event. The same when the address already held the product (a repeat purchase, a gift: grantImported keeps the
 *   first grant) and this order stands behind it in `nl:ppsell:own:` (the Claude 4 team's re-review of #2911). A product that cannot be read then never sends the buyer to the error page or to "not found".
 * - Claude 5's proof on #2911, kept: the real openOrder -> captureOrder -> watchPayPal/settle against the PayPal stand-in
 *   of tests/paypal-sales.test.ts, the page drawn while the sweep hands over and after a hand-over that failed.
 *
 * Real page and real lib/paypal-sales.ts over the in-memory store of the tests; a failing read is a Redis pipeline
 * that throws for that one key, as an outage does. next/headers reads the request each call answers.
 */
import { renderToReadableStream } from "react-dom/server";
import ThanksPage from "@/app/[handle]/thanks/page";
import { StoreTracking } from "@/components/store-tracking";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setPayPalSeller, setProductHidden, setProductLink, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { type Paid, captureOrder, openOrder, readPaid, stillPending, watchPayPal } from "@/lib/paypal-sales";
import { handOverPayPal } from "@/lib/paypal-delivery";
import { readListing } from "@/lib/catalog";
import { grantImported, importedKey } from "@/lib/imported-purchases";
import { TEST_CONSENT } from "./digital-consent-fixture";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

const OWNER = "kiln@example.com";
const BUYER = "buyer@example.com";
const ORDER = "5O190127TN364715T";
const BASE = "https://marktmorgen.com";

const COULD_NOT_CHECK = "We could not check this payment just now";
const HANDING_OVER = "Payment received, we&#x27;re handing it over";
const NOT_FOUND_LINE = "If PayPal shows a payment to Kiln Works";

// The PayPal stand-in of tests/paypal-sales.test.ts, cut to what an order, its capture and its read need.
const PARTNER_CLIENT = "AZpartnerClientId0123456789";
const PARTNER_SECRET = "EPpartnerSecret0123456789";
const PARTNER = "PARTNERMERCH01";
const SELLER = "7KNGBPH2U58GQ";
const orders = new Map<string, Record<string, unknown>>();
let captureWith: (order: string) => { status: number; body: Record<string, unknown> } = () => ({ status: 500, body: {} });
let made = 0;
/** Captures PayPal answers as refunded in full (the Claude 4 team's second money review of #2911). */
const refundedCaptures = new Set<string>();
const orderId = (n: number) => `8P190127TN36471${String(n).padStart(2, "0")}`;

function completed(order: string, value: string, status: string, email: string): Record<string, unknown> {
  return {
    id: order,
    status: "COMPLETED",
    payer: { email_address: email, payer_id: "QYR5Z8XDVJNXQ" },
    purchase_units: [{ reference_id: "x", payee: { merchant_id: SELLER }, payments: { captures: [{ id: `3C679366HH9087${order.slice(-2)}${status === "PENDING" ? "P" : ""}`, status, amount: { currency_code: "USD", value } }] } }],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  if (url.hostname === "api.resend.com") return json({ id: "e" });
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
    const answer = captureWith(capture);
    if (answer.status < 300) orders.set(capture, answer.body);
    return json(answer.body, answer.status);
  }
  const read = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (read && method === "GET") return orders.has(read) ? json(orders.get(read)) : json({ name: "RESOURCE_NOT_FOUND" }, 404);
  const cap = /^\/v2\/payments\/captures\/([A-Z0-9]+)$/.exec(url.pathname)?.[1];
  if (cap && method === "GET") return json({ id: cap, status: refundedCaptures.has(cap) ? "REFUNDED" : "COMPLETED" });
  return json({ name: "RESOURCE_NOT_FOUND" }, 404);
}) as typeof fetch;

type Node = { type?: unknown; props?: Record<string, unknown> } | Node[] | string | number | null | undefined | boolean;

/** Every element of a drawn tree, depth first. */
function walk(node: Node, seen: { type?: unknown; props?: Record<string, unknown> }[] = []): typeof seen {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, seen);
    return seen;
  }
  if (!node || typeof node !== "object") return seen;
  seen.push(node);
  walk((node.props?.children as Node) ?? null, seen);
  return seen;
}

/** The PayPal page for the order: its tree (PayPalThanks resolved) and its HTML, or "crashed" when it threw. */
async function open(order = ORDER): Promise<{ html: string; purchaseEvent: boolean } | "crashed"> {
  answering(new Request(`${BASE}/@kilnworks/thanks?paypal=${order}`, { headers: { "x-forwarded-for": "203.0.113.7" } }));
  try {
    const outer = (await ThanksPage({ params: Promise.resolve({ handle: "@kilnworks" }), searchParams: Promise.resolve({ paypal: order }) })) as { type: (p: unknown) => Promise<unknown>; props: unknown };
    const tree = (await outer.type(outer.props)) as Node;
    const purchaseEvent = walk(tree).some((el) => el.type === StoreTracking && (el.props?.event as { type?: string } | null)?.type === "purchase");
    const stream = await renderToReadableStream(tree as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return { html: await new Response(stream).text(), purchaseEvent };
  } catch {
    return "crashed";
  }
}

/** Makes every pipeline that touches `key` (or a key it matches) throw, as a Redis outage does; returns the undo. */
function failReadsOf(key: string | RegExp): () => void {
  const real = redis.pipeline.bind(redis);
  const hit = (part: string | number) => (typeof key === "string" ? String(part) === key : key.test(String(part)));
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c.some(hit))) throw new Error("redis unavailable");
    return real(commands);
  }) as typeof redis.pipeline;
  return () => {
    redis.pipeline = real;
  };
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00001", subscriptionId: "sub_kiln00001", active: true, tier: "creator", period: paidPeriod() });
  process.env.RESEND_API_KEY = "re_test_pf1_paypal_thanks";
  delete process.env.PAYPAL_ENV;
  process.env.PAYPAL_PARTNER_CLIENT_ID = PARTNER_CLIENT;
  process.env.PAYPAL_PARTNER_SECRET = PARTNER_SECRET;
  process.env.PAYPAL_PARTNER_MERCHANT_ID = PARTNER;
  process.env.PAYPAL_BN_CODE = "NimbusLabs_SP";
  const made = await addProduct(OWNER, "Glazing guide", "", "29", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/glazing");
  await setPayPalSeller(OWNER, SELLER);
  let store = (await storeForEmail(OWNER)) as Store;
  if (!store.statsId) throw new Error("no stats id");
  const paidKey = `nl:ppsell:paid:${ORDER}`;
  const pendingKey = `nl:ppsell:pending:${store.statsId}`;
  const paid = { store: store.statsId, order: ORDER, capture: "3C679366HH908993F", email: BUYER, product: made.product.id, cents: 2900, currency: "usd", at: Math.floor(Date.now() / 1000), handle: "kilnworks" };

  part("The paid record cannot be read: could not check, never 'not found', never the error page");
  {
    const undo = failReadsOf(paidKey);
    const page = await open();
    undo();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it says it could not check the payment just now", html.includes(COULD_NOT_CHECK), true);
    is("it does not say the order was not found", html.includes(NOT_FOUND_LINE), false);
    is("it tells the buyer to refresh in a minute", html.includes("refresh in a minute"), true);
  }

  part("No paid record, and the pending mark cannot be read: could not check");
  {
    const undo = failReadsOf(pendingKey);
    const page = await open();
    undo();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it says it could not check the payment just now", html.includes(COULD_NOT_CHECK), true);
    is("it does not say the order was not found", html.includes(NOT_FOUND_LINE), false);
  }

  part("Nothing recorded and nothing pending: not found, as before");
  {
    const page = await open();
    const html = page === "crashed" ? "" : page.html;
    is("it says the order was not found", html.includes(NOT_FOUND_LINE), true);
    is("it does not say it could not check", html.includes(COULD_NOT_CHECK), false);
  }

  part("Paid and still being handed over: received, no link, no purchase event");
  {
    await redis.pipeline([
      ["SET", paidKey, JSON.stringify(paid)],
      ["ZADD", pendingKey, String(paid.at), ORDER],
    ]);
    const page = await open();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it says the payment was received and is being handed over", html.includes(HANDING_OVER), true);
    is("it still says it was paid with PayPal", html.includes("Paid with PayPal"), true);
    is("it names the address the receipt goes to", html.includes(BUYER), true);
    is("no link to the purchase or the list of purchases", [html.includes("Open what you bought"), html.includes("Open your purchases"), html.includes("/@kilnworks/orders")], [false, false, false]);
    is("no purchase event for the creator's pixels", page === "crashed" ? null : page.purchaseEvent, false);
  }

  part("Paid, and the pending mark cannot be read: counted as still being handed over");
  {
    const undo = failReadsOf(pendingKey);
    const page = await open();
    undo();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it says the payment was received and is being handed over", html.includes(HANDING_OVER), true);
    is("no link to the list of purchases", html.includes("/@kilnworks/orders"), false);
    is("no purchase event", page === "crashed" ? null : page.purchaseEvent, false);
  }

  // Changed on purpose (Claude 5's MEDIUM on #2911): this part used to clear the pending mark by hand and expect the
  // purchase, its link and the event. A cleared mark is exactly what settle() leaves BEFORE anything is handed over, so
  // it now expects "handing over"; the purchase, link and event are expected only after a real hand-over, below.
  part("Paid, the pending mark already cleared (as settle() does before handing over), nothing handed over: handing over");
  {
    await redis.pipeline([["ZREM", pendingKey, ORDER]]);
    const page = await open();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it says the payment was received and is being handed over", html.includes(HANDING_OVER), true);
    is("no link to the purchase or the list of purchases", [html.includes("Open what you bought"), html.includes("Open your purchases"), html.includes("/@kilnworks/orders")], [false, false, false]);
    is("no purchase event for the creator's pixels", page === "crashed" ? null : page.purchaseEvent, false);
  }

  part("Paid and handed over by the real hand-over: the purchase, its link and the event");
  {
    await handOverPayPal(store, paid as Paid);
    const page = await open();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it thanks the buyer for the purchase", html.includes("Glazing guide"), true);
    is("it links to the purchase", html.includes("Open what you bought") || html.includes("Open your purchases"), true);
    is("it does not say it is being handed over", html.includes(HANDING_OVER), false);
    is("the purchase event is sent", page === "crashed" ? null : page.purchaseEvent, true);
  }

  const grantKey = importedKey(store.statsId, BUYER);
  part("Paid, and the hand-over record cannot be read: could not check, never delivered");
  {
    const undo = failReadsOf(grantKey);
    const page = await open();
    undo();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it says it could not check the payment just now", html.includes(COULD_NOT_CHECK), true);
    is("no link and no purchase event", [html.includes("/@kilnworks/orders"), page === "crashed" ? null : page.purchaseEvent], [false, false]);
    is("it does not say the order was not found", html.includes(NOT_FOUND_LINE), false);
  }

  part("Paid, and the hand-over record is not in its shape: could not check, never delivered");
  {
    const [kept] = await redis.pipeline([["HGET", grantKey, made.product.id]]);
    await redis.pipeline([["HSET", grantKey, made.product.id, "{not json"]]);
    const page = await open();
    await redis.pipeline([["HSET", grantKey, made.product.id, String(kept)]]);
    const html = page === "crashed" ? "" : page.html;
    is("it says it could not check the payment just now", html.includes(COULD_NOT_CHECK), true);
    is("no link and no purchase event", [html.includes("/@kilnworks/orders"), page === "crashed" ? null : page.purchaseEvent], [false, false]);
  }

  part("Paid, and what the buyer holds was given by another payment: this order is not proven handed over");
  {
    const [kept] = await redis.pipeline([["HGET", grantKey, made.product.id]]);
    await redis.pipeline([["HSET", grantKey, made.product.id, JSON.stringify({ at: paid.at, job: "paypal:9X000000000000000", items: null })]]);
    const page = await open();
    await redis.pipeline([["HSET", grantKey, made.product.id, String(kept)]]);
    const html = page === "crashed" ? "" : page.html;
    is("it says the payment was received and is being handed over", html.includes(HANDING_OVER), true);
    is("no purchase event", page === "crashed" ? null : page.purchaseEvent, false);
  }

  part("Claude 5's proof on #2911, sweep path: drawn while watchPayPal hands over a payment PayPal has just completed");
  {
    const opened = await openOrder(store, (await readListing(store, made.product.id))!, BASE, { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    captureWith = (o) => ({ status: 201, body: completed(o, "29.00", "PENDING", "sweep@example.com") });
    is("control: a pending payment is not taken yet", (await captureOrder(store, opened.order)).ok, false);
    orders.set(opened.order, completed(opened.order, "29.00", "COMPLETED", "sweep@example.com"));
    let during: Awaited<ReturnType<typeof open>> = "crashed";
    let marks: unknown[] = [];
    await watchPayPal(store, Date.now() + 10_000, {
      handOver: async (p) => {
        marks = [Boolean(await readPaid(p.order)), await stillPending(store, p.order)];
        during = await open(p.order);
        await handOverPayPal(store, p);
      },
      dropStart: async () => undefined,
    });
    is("control (A): at the hand-over the payment is recorded and the pending mark is already gone", marks, [true, false]);
    const html = during === "crashed" ? "" : (during as { html: string }).html;
    is("while it is handed over, the page says it is being handed over", html.includes(HANDING_OVER), true);
    is("while it is handed over, no link to the purchase", html.includes("/@kilnworks/orders") || html.includes("Open what you bought"), false);
    is("while it is handed over, no purchase event", during === "crashed" ? null : (during as { purchaseEvent: boolean }).purchaseEvent, false);
    const after = await open(opened.order);
    is("once handed over: the link and the purchase event", [after !== "crashed" && (after.html.includes("Open what you bought") || after.html.includes("Open your purchases")), after === "crashed" ? null : after.purchaseEvent], [true, true]);
  }

  part("Claude 5's proof on #2911, return path: paid at once, and the hand-over failed");
  {
    const opened = await openOrder(store, (await readListing(store, made.product.id))!, BASE, { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    captureWith = (o) => ({ status: 201, body: completed(o, "29.00", "COMPLETED", "return@example.com") });
    const taken = await captureOrder(store, opened.order);
    if (!taken.ok) throw new Error(`not paid: ${taken.reason}`);
    // As app/api/store/paypal/return/route.ts does: the hand-over throws (its grant write fails) and is caught.
    const undo = failReadsOf(importedKey(store.statsId, "return@example.com"));
    await handOverPayPal(store, taken.paid).catch(() => undefined);
    undo();
    is("control (B): no pending mark is left, and nothing is granted", [await stillPending(store, opened.order), (await redis.pipeline([["HLEN", importedKey(store.statsId, "return@example.com")]]))[0]], [false, 0]);
    const page = await open(opened.order);
    const html = page === "crashed" ? "" : page.html;
    is("the page says the payment was received and is being handed over", html.includes(HANDING_OVER), true);
    is("no link to the purchase", html.includes("/@kilnworks/orders") || html.includes("Open what you bought"), false);
    is("no purchase event", page === "crashed" ? null : page.purchaseEvent, false);
  }

  // The Claude 4 team's regression on #2911 (re-review at 3f5256ed): grantImported writes with HSETNX, so the buyer's
  // record keeps the FIRST grant's job. A second PayPal purchase of the same product by the same address, or one after
  // a gift or an import gave it, never finds its own "paypal:<order>" there, and the page said "handing over" forever,
  // with no link and no purchase event, although the hand-over had run and the buyer holds the product. Real path:
  // openOrder -> captureOrder -> handOverPayPal, twice.
  part("A second PayPal purchase of the same product by the same address, handed over: the purchase, its link and the event");
  {
    const again = "again@example.com";
    const buy = async (): Promise<string> => {
      const opened = await openOrder(store, (await readListing(store, made.product.id))!, BASE, { digitalConsent: TEST_CONSENT });
      if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
      captureWith = (o) => ({ status: 201, body: completed(o, "29.00", "COMPLETED", again) });
      const taken = await captureOrder(store, opened.order);
      if (!taken.ok) throw new Error(`not paid: ${taken.reason}`);
      is(`control: ${opened.order} is handed over by the real hand-over`, await handOverPayPal(store, taken.paid), true);
      return opened.order;
    };
    const first = await buy();
    const second = await buy();
    const [held] = await redis.pipeline([["HGET", importedKey(store.statsId, again), made.product.id]]);
    is("control: the buyer's record keeps the first order's grant (HSETNX)", (JSON.parse(String(held)) as { job: string }).job, `paypal:${first}`);
    const one = await open(first);
    is("control: the first order shows the purchase and the event", [one !== "crashed" && one.html.includes("Open what you bought"), one === "crashed" ? null : one.purchaseEvent], [true, true]);
    const two = await open(second);
    const html = two === "crashed" ? "" : two.html;
    is("the second order does not say it is being handed over", html.includes(HANDING_OVER), false);
    is("the second order shows the purchase and its link", html.includes("Glazing guide") && html.includes("Open what you bought"), true);
    is("the second order sends the purchase event", two === "crashed" ? null : two.purchaseEvent, true);
    // Claude 5's LOW on #2911 @ f7a1d797: standing behind the product proves the payment and that the buyer holds it,
    // not that this order's own hand-over (its receipt among it) ran, so no receipt is promised for it.
    const receipt = THANKS_WORDS.en.ppReceipt(again);
    is("control: the first order, handed over by its own grant, promises its receipt", one === "crashed" ? null : one.html.includes(receipt), true);
    is("the second order does not promise a receipt its own hand-over has not proven", html.includes(receipt), false);

    part("Claude 5's LOW on #2911: a repeat purchase whose own hand-over has not run promises no receipt");
    {
      const opened = await openOrder(store, (await readListing(store, made.product.id))!, BASE, { digitalConsent: TEST_CONSENT });
      if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
      captureWith = (o) => ({ status: 201, body: completed(o, "29.00", "COMPLETED", again) });
      const taken = await captureOrder(store, opened.order);
      if (!taken.ok) throw new Error(`not paid: ${taken.reason}`);
      // No handOverPayPal: the hand-over is still to run, or it failed.
      const three = await open(opened.order);
      const page = three === "crashed" ? "" : three.html;
      is("control: the buyer still holds the product (the first grant), so its link is there", page.includes("Open what you bought"), true);
      is("it promises no receipt for this order", page.includes(receipt), false);
    }
  }

  let giftedOrder = "";
  part("A PayPal purchase of a product the address was given first (a gift), handed over: the purchase, its link and the event");
  {
    const gifted = "gifted@example.com";
    await grantImported(store.statsId, "gift:g1", [{ email: gifted, productId: made.product.id, items: null }], Math.floor(Date.now() / 1000), store.sid);
    const opened = await openOrder(store, (await readListing(store, made.product.id))!, BASE, { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    captureWith = (o) => ({ status: 201, body: completed(o, "29.00", "COMPLETED", gifted) });
    const taken = await captureOrder(store, opened.order);
    if (!taken.ok) throw new Error(`not paid: ${taken.reason}`);
    is("control: handed over by the real hand-over", await handOverPayPal(store, taken.paid), true);
    giftedOrder = opened.order;
    const page = await open(opened.order);
    const html = page === "crashed" ? "" : page.html;
    is("it does not say it is being handed over", html.includes(HANDING_OVER), false);
    is("it shows the purchase and its link", html.includes("Open what you bought"), true);
    is("it sends the purchase event", page === "crashed" ? null : page.purchaseEvent, true);
    is("it does not promise a receipt its own hand-over has not proven", html.includes(THANKS_WORDS.en.ppReceipt(gifted)), false);
  }

  part("Another grant holds the product and this order's standing mark cannot be read: could not check, never delivered");
  {
    const undo = failReadsOf(/^nl:ppsell:own:/);
    const page = await open(giftedOrder);
    undo();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it says it could not check the payment just now", html.includes(COULD_NOT_CHECK), true);
    is("no link and no purchase event", [html.includes("Open what you bought"), page === "crashed" ? null : page.purchaseEvent], [false, false]);
  }

  part("Another grant holds the product and this order's standing mark answers in another shape: could not check, never delivered");
  {
    const real = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) => {
      const replies = await real(commands);
      // "1" as text, not the integer SISMEMBER answers: not its shape, so unknown.
      return commands.map((c, i) => (c[0] === "SISMEMBER" && String(c[1]).startsWith("nl:ppsell:own:") ? String(replies[i]) : replies[i]));
    }) as typeof redis.pipeline;
    const page = await open(giftedOrder);
    redis.pipeline = real;
    const html = page === "crashed" ? "" : page.html;
    is("it says it could not check the payment just now", html.includes(COULD_NOT_CHECK), true);
    is("no link and no purchase event", [html.includes("Open what you bought"), page === "crashed" ? null : page.purchaseEvent], [false, false]);
  }

  part("Handed over, and the product cannot be read: never the error page, never 'not found' for a paid order");
  {
    await setProductHidden(OWNER, made.product.id, true);
    store = (await storeForEmail(OWNER)) as Store;
    const undo = failReadsOf(new RegExp(`^nl:catalog:[^:]+:l:${made.product.id}$`));
    const page = await open();
    undo();
    await setProductHidden(OWNER, made.product.id, false);
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it still says it was paid with PayPal", html.includes("Paid with PayPal"), true);
    is("it does not say the order was not found", html.includes(NOT_FOUND_LINE), false);
    is("it links to the list of purchases, where the handed-over purchase is", html.includes("Open your purchases") || html.includes("Open what you bought"), true);
  }

  part("The Claude 4 team's LEVE on #2911: refunded in full and taken back by the real watch: never 'handing it over'");
  {
    const back = "refund@example.com";
    const opened = await openOrder(store, (await readListing(store, made.product.id))!, BASE, { digitalConsent: TEST_CONSENT });
    if (!opened.ok) throw new Error(`no order: ${opened.reason}`);
    captureWith = (o) => ({ status: 201, body: completed(o, "29.00", "COMPLETED", back) });
    const taken = await captureOrder(store, opened.order);
    if (!taken.ok) throw new Error(`not paid: ${taken.reason}`);
    is("control: handed over by the real hand-over", await handOverPayPal(store, taken.paid), true);
    const before = await open(opened.order);
    is("control: before the refund the page shows the purchase", before !== "crashed" && before.html.includes("Open what you bought"), true);
    refundedCaptures.add(taken.paid.capture);
    await redis.pipeline([["ZADD", `nl:ppsell:watch:${store.statsId}`, "1", opened.order]]);
    const watched = await watchPayPal(store, Date.now() + 10_000, { handOver: async () => {}, dropStart: async () => {} });
    is("control: the real watch took the purchase back", watched.revoked, 1);
    const after = await open(opened.order);
    const html = after === "crashed" ? "" : after.html;
    is("the page is drawn", after === "crashed" ? "crashed" : "drawn", "drawn");
    is("it does not say it is being handed over", html.includes(HANDING_OVER), false);
    is("it does not promise a receipt or ask to refresh", [html.includes("Refresh in a minute"), html.includes(THANKS_WORDS.en.ppReceipt(back))], [false, false]);
    is("it says the payment was refunded", html.includes(THANKS_WORDS.en.ppRefunded), true);
    is("no link to the purchase and no purchase event", [html.includes("Open what you bought"), after === "crashed" ? null : after.purchaseEvent], [false, false]);
    // The refund mark that cannot be read is unknown: could not check, never "handing it over" and never "refunded".
    const undo = failReadsOf(`nl:ppsell:refunded:${store.statsId}`);
    const blind = await open(opened.order);
    undo();
    const blindHtml = blind === "crashed" ? "" : blind.html;
    is("the refund mark unread: could not check, never handing over, never refunded", [blindHtml.includes(COULD_NOT_CHECK), blindHtml.includes(HANDING_OVER), blindHtml.includes(THANKS_WORDS.en.ppRefunded)], [true, false, false]);
  }

  part("The new words exist in every buyer language");
  {
    const en = THANKS_WORDS.en as unknown as Record<string, unknown>;
    is("English: could not check", en.ppCouldNotCheck, "We could not check this payment just now");
    is("English: handing over", en.ppHandingOver, "Payment received, we're handing it over");
    for (const [code, words] of Object.entries(THANKS_WORDS)) {
      const w = words as unknown as Record<string, unknown>;
      const body = typeof w.ppCouldNotCheckBody === "string" ? w.ppCouldNotCheckBody : "";
      const handing = typeof w.ppHandingOverBody === "function" ? String((w.ppHandingOverBody as (e: string) => string)(BUYER)) : "";
      is(`${code}: every new line is written`, [typeof w.ppCouldNotCheck === "string" && (w.ppCouldNotCheck as string).length > 10, body.length > 20, typeof w.ppHandingOver === "string" && (w.ppHandingOver as string).length > 10, handing.includes(BUYER), typeof w.ppRefunded === "string" && (w.ppRefunded as string).length > 10, typeof w.ppRefundedBody === "string" && (w.ppRefundedBody as string).length > 20], [true, true, true, true, true, true]);
      if (code !== "en") is(`${code}: written in its own language, not English`, [w.ppCouldNotCheck === en.ppCouldNotCheck, w.ppHandingOver === en.ppHandingOver, body === en.ppCouldNotCheckBody, w.ppRefunded === en.ppRefunded, w.ppRefundedBody === en.ppRefundedBody], [false, false, false, false, false]);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
