/**
 * The routes that read an order for its buyer count it the way the thanks page does (09/11/2026, rule 30 after
 * tests/order-lookup-reserve.test.ts): "Join the Discord", "Start the course" and "Add it to your podcast app".
 *
 * Before: each took the buyers' side of the store's window (or its reserve) before the order was read, with any id, so
 * made-up order numbers spent the 5% kept for what buyers already have. Now (lib/order-lookup.ts, readOrderAdmitted):
 * an id that is not of an order's form counts nothing and asks nobody; the lookup counts on the public side (refused
 * there once the public pages rest); only a paid order takes one buyers' request.
 *
 * Synthetic store, Stripe and Discord are stand-ins, Redis is the memory stand-in; nothing real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { saveServer } from "@/lib/discord-store";
import { storeKey } from "@/lib/learn";
import { takePublicRequest } from "@/lib/traffic";
import { publicVisitLimit, requestLimitFor } from "@/lib/traffic-rules";
import { POST as joinDiscord } from "@/app/api/store/discord/join/route";
import { POST as startCourse } from "@/app/api/store/course/start/route";
import { POST as openPodcast } from "@/app/api/store/podcast/open/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.DISCORD_CLIENT_ID = "400000000000000001";
process.env.DISCORD_CLIENT_SECRET = "secret";
process.env.DISCORD_BOT_TOKEN = "bot";

const PAID = `cs_test_${"p".repeat(24)}`;
let productId = "";
let lookups = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  if (path.startsWith("/checkout/sessions/")) {
    lookups += 1;
    if (path.endsWith(PAID)) {
      return new Response(JSON.stringify({ id: PAID, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: Math.floor(Date.now() / 1000), currency: "usd", amount_total: 4900, metadata: { store: "harbor", product: productId }, customer_details: { email: "ann@example.com" }, payment_intent: { id: "pi_Paid00001", latest_charge: { refunded: false, amount: 4900, amount_refunded: 0 } } }));
    }
    return new Response(JSON.stringify({ error: { message: "No such checkout.session", type: "invalid_request_error" } }), { status: 404 });
  }
  return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
}) as typeof fetch;

const ROUTES = [
  ["discord join", joinDiscord, "/api/store/discord/join"],
  ["course start", startCourse, "/api/store/course/start"],
  ["podcast open", openPodcast, "/api/store/podcast/open"],
] as const;

async function post(route: (typeof ROUTES)[number][1], path: string, ip: string, sessionId: string): Promise<number> {
  const body = new URLSearchParams({ handle: "harbor", session_id: sessionId });
  const response = await route(new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: body.toString() }));
  return response.status;
}

async function buyersLeft(store: NonNullable<Awaited<ReturnType<typeof storeForEmail>>>, now: number): Promise<number> {
  let n = 0;
  while (await takePublicRequest(store, "buyer", now)) n += 1;
  return n;
}

async function build() {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_order_lookup_only";
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await ensureStoreId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  await setSubscription("owner@example.com", { customerId: "cus_Owner00001", subscriptionId: "sub_Owner00001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@example.com", "Bread Course", "", "49", null);
  if (!made.ok) throw new Error("no product");
  productId = made.product.id;
  await setProductLink("owner@example.com", productId, "https://example.com/bread");
  const store = (await storeForEmail("owner@example.com"))!;
  await saveServer(storeKey(store), { id: "100000000000000001", name: "The Club", at: 1, kick: false });
  return store;
}

async function main(): Promise<void> {
  for (const [label, route, path] of ROUTES) {
    const store = await build();
    const now = Date.now();
    const total = requestLimitFor(store, now / 1000);
    const reserve = total - publicVisitLimit(total);

    part(`${label}: made-up order numbers from many addresses`);
    await takePublicRequest(store, "public", now, publicVisitLimit(total));
    const before = lookups;
    for (let ip = 1; ip <= 40; ip += 1) {
      for (let n = 0; n < 5; n += 1) {
        await post(route, path, `203.0.113.${ip}`, `made-up-${ip}-${n}`);
        await post(route, path, `203.0.113.${ip}`, `cs_test_${String(ip).padStart(3, "0")}${String(n).padStart(3, "0")}${"x".repeat(18)}`);
      }
    }
    is(`${label}: none of the 400 reached Stripe`, lookups - before, 0);
    is(`${label}: the buyers' reserve is whole`, await buyersLeft(store, now), reserve);

    part(`${label}: a real paid order counts its lookup on the public side and takes exactly one buyers' request`);
    const fresh = await build();
    const at = Date.now();
    const freshTotal = requestLimitFor(fresh, at / 1000);
    const freshReserve = freshTotal - publicVisitLimit(freshTotal);
    // One public request of room: the lookup takes it, the paid order then takes one of the buyers' reserve.
    await takePublicRequest(fresh, "public", at, publicVisitLimit(freshTotal) - 1);
    const asked = lookups;
    await post(route, path, "192.0.2.1", PAID);
    is(`${label}: Stripe was asked once`, lookups - asked, 1);
    is(`${label}: the buyers' reserve gave one request less than it holds`, await buyersLeft(fresh, at), freshReserve - 1);
  }
  done();
}

void main();
