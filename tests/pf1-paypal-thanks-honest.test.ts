/**
 * The page a buyer lands on after paying with PayPal (app/[handle]/thanks/page.tsx, PayPalThanks) says only what it
 * has read (PF1):
 *
 * - When the paid record or the pending mark cannot be read (Redis failing, or, with lib/paypal-sales.ts reading
 *   exactly, a reply in another shape), the page says it could not check the payment just now. It never says "We
 *   could not find this order" for a payment it could not look at, and it never falls into the error page.
 * - When the payment is recorded but the order is still marked as being handed over, the page says the payment was
 *   received and is being handed over: no link to the purchase and no purchase event for the creator's pixels yet,
 *   because nothing has been handed over. An unknown pending mark counts as still being handed over.
 * - When the payment is recorded and handed over, the page is as before: the purchase, its link and the event.
 *
 * Real page and real lib/paypal-sales.ts over the in-memory store of the tests; a failing read is a Redis pipeline
 * that throws for that one key, as an outage does. next/headers reads the request each call answers.
 */
import { renderToReadableStream } from "react-dom/server";
import ThanksPage from "@/app/[handle]/thanks/page";
import { StoreTracking } from "@/components/store-tracking";
import { THANKS_WORDS } from "@/lib/buyer-words/thanks";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
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
async function open(): Promise<{ html: string; purchaseEvent: boolean } | "crashed"> {
  answering(new Request(`${BASE}/@kilnworks/thanks?paypal=${ORDER}`, { headers: { "x-forwarded-for": "203.0.113.7" } }));
  try {
    const outer = (await ThanksPage({ params: Promise.resolve({ handle: "@kilnworks" }), searchParams: Promise.resolve({ paypal: ORDER }) })) as { type: (p: unknown) => Promise<unknown>; props: unknown };
    const tree = (await outer.type(outer.props)) as Node;
    const purchaseEvent = walk(tree).some((el) => el.type === StoreTracking && (el.props?.event as { type?: string } | null)?.type === "purchase");
    const stream = await renderToReadableStream(tree as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return { html: await new Response(stream).text(), purchaseEvent };
  } catch {
    return "crashed";
  }
}

/** Makes every pipeline that touches `key` throw, as a Redis outage does; returns the undo. */
function failReadsOf(key: string): () => void {
  const real = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    if (commands.some((c) => c.some((part) => String(part) === key))) throw new Error("redis unavailable");
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
  const made = await addProduct(OWNER, "Glazing guide", "", "29", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER)) as Store;
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

  part("Paid and handed over: the purchase, its link and the event, as before");
  {
    await redis.pipeline([["ZREM", pendingKey, ORDER]]);
    const page = await open();
    is("the page is drawn", page === "crashed" ? "crashed" : "drawn", "drawn");
    const html = page === "crashed" ? "" : page.html;
    is("it thanks the buyer for the purchase", html.includes("Glazing guide"), true);
    is("it links to the purchase", html.includes("Open what you bought") || html.includes("Open your purchases"), true);
    is("it does not say it is being handed over", html.includes(HANDING_OVER), false);
    is("the purchase event is sent", page === "crashed" ? null : page.purchaseEvent, true);
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
      is(`${code}: every new line is written`, [typeof w.ppCouldNotCheck === "string" && (w.ppCouldNotCheck as string).length > 10, body.length > 20, typeof w.ppHandingOver === "string" && (w.ppHandingOver as string).length > 10, handing.includes(BUYER)], [true, true, true, true]);
      if (code !== "en") is(`${code}: written in its own language, not English`, [w.ppCouldNotCheck === en.ppCouldNotCheck, w.ppHandingOver === en.ppHandingOver, body === en.ppCouldNotCheckBody], [false, false, false]);
    }
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
