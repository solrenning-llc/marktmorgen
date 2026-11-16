/**
 * The webhook event shipment.created (378 [TB4] complement WG (a)): sent when
 * a shipped order is first marked as shipped in the studio (the route
 * app/api/store/shipped/route.ts, lib/shipments.ts markShipped). What is
 * checked, through the real route with a synthetic store, session and Stripe:
 *
 *   - marked with a tracking link: one message with the order, the product,
 *     the link, when it was marked and the buyer's address as Stripe has it;
 *   - marked with no link: tracking_url is null;
 *   - pressed again, with another link: nothing more is sent, and the first
 *     link stays;
 *   - an order that is not this store's, or not paid, or a link that is not
 *     one, sends nothing;
 *   - it is an event a store can listen for, listed in the studio.
 *
 * There is no shipment.updated: a shipment mark cannot be changed once kept.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { POST as shippedRoute } from "@/app/api/store/shipped/route";
import { WEBHOOK_EVENTS, addEndpoint, recentMessages, setSendHooksForTests } from "@/lib/webhooks";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const HANDLE = "shiphook";
const orders = new Map<string, Record<string, unknown>>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const found = path.startsWith("/checkout/sessions/") && (init?.method ?? "GET") === "GET" ? orders.get(decodeURIComponent(path.slice("/checkout/sessions/".length))) : undefined;
  if (found) return Response.json(found);
  return new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });
console.error = () => {};

const order = (id: string, extra: Record<string, unknown> = {}) => {
  const row = { id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 4100, currency: "usd", customer_details: { email: "ana@example.com" }, metadata: { store: HANDLE, product: "p_book", ship: "yes", title: "The Supper Book" }, ...extra };
  orders.set(id, row);
  return id;
};
type Shipment = { checkout_session: string; product: { id: string | null; title: string | null }; tracking_url: string | null; shipped_at: string; buyer: { email: string | null } };

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_shipment_hook_only";
  const owner = "ship-hook@example.com";
  await claimHandle(owner, HANDLE, "Ship Hook", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setStripeAccount(owner, "acct_1ShipHookxxxxxxx", true);
  await setSubscription(owner, { customerId: "cus_shiphook", subscriptionId: "sub_shiphook", active: true, tier: "pro", trialEnds: 0, period: paidPeriod() });
  let store = (await storeForEmail(owner))!;
  if (!(await addEndpoint(store, "https://hooks.example.com/shipments", ["shipment.created"])).ok) throw new Error("no endpoint");
  const session = await openSession(owner);
  const send = async (body: Record<string, unknown>) => {
    const response = await shippedRoute(new NextRequest("https://marktmorgen.com/api/store/shipped", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string; shipped?: { tracking: string } } };
  };
  const messages = async () => {
    store = (await storeForEmail(owner))!;
    return (await recentMessages(store, "shipment.created", 10)).map((m) => m.data as unknown as Shipment);
  };

  part("An event a store can listen for, in the studio's list");
  is("shipment.created is one of the events", (WEBHOOK_EVENTS as readonly string[]).includes("shipment.created"), true);
  is("the studio lists it", readFileSync("components/webhook-editor.tsx", "utf8").includes('key: "shipment.created", label: "Order shipped"'), true);
  is("there is no shipment.updated", (WEBHOOK_EVENTS as readonly string[]).includes("shipment.updated"), false);

  part("Marked as shipped, with a tracking link and with none");
  const first = order("cs_test_shiphook000000001");
  const marked = await send({ session: first, tracking: "https://tools.usps.com/go?x=1" });
  is("marked", [marked.status, marked.body.ok], [200, true]);
  let sent = await messages();
  is("one message: the order, the product, the link and the buyer's address", [sent.length, sent[0]?.checkout_session, sent[0]?.product, sent[0]?.tracking_url, sent[0]?.buyer], [1, first, { id: "p_book", title: "The Supper Book" }, "https://tools.usps.com/go?x=1", { email: "ana@example.com" }]);
  is("when it was marked", Math.abs(Date.parse(sent[0]?.shipped_at ?? "") - Date.now()) < 60_000, true);
  const second = order("cs_test_shiphook000000002");
  await send({ session: second, tracking: "" });
  sent = await messages();
  is("with no link: tracking_url is null", [sent.length, sent[0]?.checkout_session, sent[0]?.tracking_url], [2, second, null]);

  part("Pressed again, nothing more; and nothing for what is not marked");
  const again = await send({ session: first, tracking: "https://example.test/another" });
  is("the first link stays", [again.status, again.body.shipped?.tracking], [200, "https://tools.usps.com/go?x=1"]);
  is("nothing more sent", (await messages()).length, 2);
  await send({ session: order("cs_test_shiphook000000003", { metadata: { store: "someone-else", product: "p_x", ship: "yes" } }) });
  await send({ session: order("cs_test_shiphook000000004", { payment_status: "unpaid" }) });
  const refused = await send({ session: order("cs_test_shiphook000000005"), tracking: "javascript:alert(1)" });
  is("a link that is not one is refused", [refused.status, refused.body.error], [400, "tracking"]);
  is("another store's order, an unpaid one, a refused link: nothing sent", (await messages()).length, 2);

  done();
}

void main();
