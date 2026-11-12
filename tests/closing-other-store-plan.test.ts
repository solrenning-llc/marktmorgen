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
 * Two checks keep it out today: the list's own filter on metadata.store
 * (saleHandles: the handle, previous handles and released ones) and ownedBy
 * (lib/billing.ts). ownedBy only accepts a name among those same handles, so
 * removing only the metadata filter is an equivalent change no test can
 * catch. Removing only ownedBy is not (Claude 3 on #3684, LEVE): a plan under
 * an address the store let go of, or under its own name, paid by another
 * customer with another email, passes the handle filter and only ownedBy
 * keeps it out; the last part below catches that. Removing both, before this
 * file, failed no test. Stripe is simulated; nothing real is read or written.
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

const SAME = { id: CUSTOMER, email: "two@example.com" };
const plan = (id: string, handle: string, status: string, created: number, customer: { id: string; email: string } = SAME) => ({
  id,
  object: "subscription",
  status,
  created,
  customer,
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

  part("Another customer's plan under an address it let go of, or under its own name, is not its own (Claude 3 on #3684, LEVE)");
  // An address the store released may be another store's now: only its own customer makes such a plan its own (ownedBy).
  const released = { ...store, releasedHandles: ["old-shop"] };
  const SOMEONE_ELSE = { id: "cus_SomeoneElse01", email: "else@example.com" };
  rows = [plan("sub_OldShopElse001", "old-shop", "active", now - 4 * 86_400, SOMEONE_ELSE), plan("sub_OldShopOwn0001", "old-shop", "active", now - 6 * 86_400)];
  is("under the released address, only the plan it pays as its own customer is listed", (await plansByCustomer(released)).map((row) => row.id), ["sub_OldShopOwn0001"]);
  rows = [plan("sub_OldShopElse001", "old-shop", "active", now - 4 * 86_400, SOMEONE_ELSE)];
  is("another customer's plan there is never listed", (await plansByCustomer(released)).map((row) => row.id), []);
  is("and never keeps it alive", await liveByCustomer(released), null);
  rows = [plan("sub_FirstShopElse1", "first-shop", "active", now - 4 * 86_400, SOMEONE_ELSE)];
  is("under its own name, a plan another customer pays with another email is not listed", (await plansByCustomer(store)).map((row) => row.id), []);

  is("nothing was written to Stripe", asked.filter((a) => !a.startsWith("GET ")), []);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
