/**
 * A closing store never takes another store's plan for its own (307 [EC1],
 * complement C1-20261105-1919-C4-1, gap (3) of the final review of #1292).
 *
 * One creator, one Stripe customer, two stores. When the first one closes,
 * the closing reads the customer's plans by customer (plansByCustomer, then
 * liveByCustomer and refuseLatePlans in lib/plan-closing.ts). A plan whose
 * metadata names the second store must be left out of that list: taken for
 * the first store's, it would keep a closing store alive on a plan it does
 * not have, or be refused and canceled though it pays for a store that is
 * not closing.
 *
 * Two checks keep it out today: the list's own filter on metadata.store and
 * ownedBy (lib/billing.ts), which already requires the same handles. Either
 * one alone is enough, so removing only one is an equivalent change no test
 * can catch; removing both, before this file, failed no test. Stripe is
 * simulated; nothing real is read or written.
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { liveByCustomer, plansByCustomer } from "@/lib/closing-plan-guard";

const CUSTOMER = "cus_TwoStoresOne01";
const asked: string[] = [];
let rows: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  asked.push(`${method} ${url.pathname}`);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (url.hostname !== "api.stripe.com") return new Response(null, { status: 404 });
  if (method === "GET" && url.pathname === "/v1/subscriptions" && url.searchParams.get("customer") === CUSTOMER) {
    return json({ object: "list", data: rows, has_more: false, url: "/v1/subscriptions" });
  }
  return json({ error: { message: `not simulated: ${method} ${url.pathname}` } }, 400);
}) as typeof fetch;

const plan = (id: string, handle: string, status: string, created: number) => ({
  id,
  object: "subscription",
  status,
  created,
  customer: { id: CUSTOMER, email: "two@example.com" },
  metadata: { store: handle, tier: "creator", cycle: "month" },
  cancel_at_period_end: false,
  cancel_at: null,
  current_period_start: created,
  current_period_end: created + 30 * 86_400,
  items: { data: [{ quantity: 1, price: { id: "price_creator_month", unit_amount: 6_900, currency: "usd", recurring: { interval: "month", interval_count: 1 }, lookup_key: "creator_month" } }] },
});

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_notARealKeyOnlyForTheseChecks";
  redis.clear();
  const first = await claimHandle("two@example.com", "first-shop", "First Shop", "");
  if (!first.ok) throw new Error("no first store");
  await setSubscription("two@example.com", { active: true, customerId: CUSTOMER, subscriptionId: "sub_FirstShopOld01", tier: "creator", cycle: "month", trialEnds: 0 });
  const store = (await storeForEmail("two@example.com"))!;
  is("the first store pays as the shared customer", store.stripeCustomerId, CUSTOMER);
  const now = Math.floor(Date.now() / 1000);

  part("The customer's only live plan is the second store's");
  rows = [plan("sub_FirstShopOld01", "first-shop", "canceled", now - 90 * 86_400), plan("sub_SecondShopLive1", "second-shop", "active", now - 5 * 86_400)];
  const listed = await plansByCustomer(store);
  is("the customer's plans were read from Stripe", asked.some((a) => a === "GET /v1/subscriptions"), true);
  is("only the first store's own plan is listed", listed.map((row) => row.id), ["sub_FirstShopOld01"]);
  is("so the closing store has no live plan by customer", await liveByCustomer(store), null);

  part("A plan with no store named, or a near name, is not the first store's either");
  rows = [plan("sub_NoStoreNamed01", "", "active", now - 3 * 86_400), plan("sub_NearNameShop01", "first-shop-2", "active", now - 2 * 86_400)];
  is("neither is listed", (await plansByCustomer(store)).map((row) => row.id), []);
  is("neither keeps it alive", await liveByCustomer(store), null);

  part("Its own live plan is still found");
  rows = [plan("sub_SecondShopLive1", "second-shop", "active", now - 5 * 86_400), plan("sub_FirstShopLive01", "first-shop", "active", now - 1 * 86_400)];
  is("listed alone", (await plansByCustomer(store)).map((row) => row.id), ["sub_FirstShopLive01"]);
  is("and taken as live", (await liveByCustomer(store))?.subscriptionId, "sub_FirstShopLive01");

  is("nothing was written to Stripe", asked.filter((a) => !a.startsWith("GET ")), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
