/**
 * The buyer's list of purchases reads the address's checkouts from the
 * creator's Stripe account (lib/buyer-orders.ts, checkoutsOf). Stripe gives
 * a hundred a page at the most and says has_more when there are more. A list
 * read only to its first page drops every older purchase without a word, so:
 *
 *   - every page is read, each from the last readable id (starting_after), and
 *     an older purchase on the second page is on the list, with and without the
 *     opening's meter, the page past the first taken from its ceiling;
 *   - a list that goes on past what may be read, a list whose ceiling has no
 *     room for its next page, a page that is not one (no has_more) and more
 *     pages after a last row that cannot be read are not known: the list
 *     throws, so the page says the purchases could not be read, never that
 *     the older ones were not bought (rule 24).
 */
import { OrdersMeter, purchasesFor } from "@/lib/buyer-orders";
import { ORDERS_STRIPE_CALLS, ORDERS_STRIPE_LISTS } from "@/lib/buyer-orders-rules";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "pages-owner@example.com";
const HANDLE = "pagedshop";
const BUYER = "pages-buyer@example.com";
const NOW = Math.floor(Date.now() / 1000);

/** The checkouts Stripe holds for the buyer, newest first, and how it answers a list of them. */
let held: Record<string, unknown>[] = [];
let shape: "exact" | "no-has-more" | "last-unreadable" | "endless" = "exact";
const asked: string[] = [];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "GET") {
    const after = url.searchParams.get("starting_after") ?? "";
    asked.push(after);
    const limit = Number(url.searchParams.get("limit") ?? "10");
    if (shape === "endless") return answer({ object: "list", data: [held[0]], has_more: true });
    const from = after ? held.findIndex((row) => row.id === after) + 1 : 0;
    const data = held.slice(from, from + limit);
    const more = from + limit < held.length;
    if (shape === "no-has-more") return answer({ object: "list", data });
    if (shape === "last-unreadable" && more) return answer({ object: "list", data: [...data.slice(0, -1), { object: "checkout.session" }], has_more: true });
    return answer({ object: "list", data, has_more: more });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

const checkout = (id: string, created: number, metadata: Record<string, string>) => ({
  id,
  object: "checkout.session",
  status: "complete",
  payment_status: "paid",
  mode: "payment",
  created,
  amount_total: 1900,
  currency: "usd",
  metadata,
  customer_details: { email: BUYER },
  payment_intent: { id: `pi_${id.slice(-12)}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
});

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_orders_checkout_pages_only";
  await claimHandle(OWNER, HANDLE, "Paged Shop", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPagedShop1", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00009", subscriptionId: "sub_Owner00009", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Sourdough Guide", "", "19", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");
  const store = (await storeForEmail(OWNER))!;

  // 120 newer checkouts that hand nothing over on this list (a call booked, each its own checkout), then the guide.
  const calls = Array.from({ length: 120 }, (_, i) => checkout(`cs_test_call${String(i).padStart(20, "0")}`, NOW - 60 - i, { store: HANDLE, product: "call1", kind: "call" }));
  const bought = checkout(`cs_test_guide${"0".repeat(19)}`, NOW - 86_400 * 400, { store: HANDLE, product: guide.product.id });
  held = [...calls, bought];

  const listed = async (meter?: OrdersMeter) => {
    asked.length = 0;
    try {
      const purchases = await purchasesFor(store, BUYER, meter);
      return { listed: purchases.map((p) => p.reference), pages: asked.length, from: asked.slice(1) };
    } catch (error) {
      return { listed: "not known", pages: asked.length, error: (error as Error).name };
    }
  };

  part("Every page is read: the older purchase on the second page is on the list");
  is("without a meter: listed, two pages, the second from the first's last id", await listed(), { listed: [bought.id], pages: 2, from: [calls[99].id] });
  const meter = new OrdersMeter(store);
  is("with the opening's meter: the same", await listed(meter), { listed: [bought.id], pages: 2, from: [calls[99].id] });
  is("the page past the first was taken from the ceiling: one call fewer left", meter.stripe(ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS), false);

  part("A list that cannot be read to its end is not known, never a shorter list");
  const spent = new OrdersMeter(store);
  spent.stripe(ORDERS_STRIPE_CALLS - ORDERS_STRIPE_LISTS);
  is("no room left in the ceiling for the second page: not known, the page not asked for", await listed(spent), { listed: "not known", pages: 1, error: "StripeListUnreadable" });
  shape = "endless";
  is("a list that goes on past the pages that may be read: not known", await listed(), { listed: "not known", pages: 10, error: "StripeListUnreadable" });
  shape = "no-has-more";
  is("a page that does not say whether there are more: not known", await listed(), { listed: "not known", pages: 1, error: "StripeListUnreadable" });
  shape = "last-unreadable";
  is("more pages after a last row that cannot be read: not known", await listed(), { listed: "not known", pages: 1, error: "StripeListUnreadable" });

  part("Control: a list that fits on one page reads one page, as before");
  shape = "exact";
  held = [bought];
  is("listed, one page", await listed(), { listed: [bought.id], pages: 1, from: [] });

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
