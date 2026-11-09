/**
 * A buyer's list of purchases reads the address's checkouts from the creator's
 * Stripe account (lib/buyer-orders.ts, checkoutsOf). It read one page of a
 * hundred and never looked at `has_more` (Claude 5's LEVE 2 on #3366): a buyer
 * whose purchase sat past the first hundred checkouts of that address (others
 * from another store on the same account, unpaid ones, gifts) was told there
 * was nothing, or was missing that purchase, without a word.
 *
 * Now every page is read, from the last row read, up to a declared ceiling of
 * pages for each spelling of the address. Past it, the list is shown when the
 * newest purchases the page shows were all among the checkouts read; when they
 * could not be, the read fails and the page says it could not be read, never
 * that the address bought nothing.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { MAX_LISTED, purchasesFor } from "@/lib/buyer-orders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "owner-pages@example.com";
const HANDLE = "pagesproof";
const NOW = Math.floor(Date.now() / 1000);
/** The ceiling the fix declares (ORDERS_CHECKOUT_PAGES in lib/buyer-orders-rules.ts), held to it below once it exists. */
const CEILING = 5;

/** Every page of checkouts, in order; `starting_after` names the last row of the page before. */
let pages: Record<string, unknown>[][] = [];
let asked: (string | null)[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  if (path === "/checkout/sessions" && method === "GET") {
    const after = url.searchParams.get("starting_after");
    asked.push(after);
    const at = after ? pages.findIndex((page) => page[page.length - 1]?.id === after) + 1 : 0;
    if (at < 0 || at >= pages.length) return answer({ object: "list", data: [], has_more: false });
    return answer({ object: "list", data: pages[at], has_more: at < pages.length - 1 });
  }
  if (method === "GET") return answer({ object: "list", data: [], has_more: false });
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

let serial = 0;
function checkout(store: string, product: string): Record<string, unknown> {
  serial += 1;
  return {
    id: `cs_test_${String(serial).padStart(24, "0")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    // Newest first, as Stripe lists them.
    created: NOW - serial * 60,
    amount_total: 1900,
    currency: "usd",
    customer: null,
    metadata: { store, product },
    customer_details: { email: "buyer@example.com" },
    payment_intent: { id: `pi_Pages${String(serial).padStart(10, "0")}`, status: "succeeded", latest_charge: { refunded: false, amount_refunded: 0 } },
  };
}
const elsewhere = (n: number) => Array.from({ length: n }, () => checkout("anotherstore", "prod_elsewhere"));

async function outcome(): Promise<string | string[]> {
  try {
    return (await purchasesFor((await storeForEmail(OWNER))!, "buyer@example.com")).map((p) => p.reference);
  } catch {
    return "not read";
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_buyer_pages_only_a_stand_in";
  await claimHandle(OWNER, HANDLE, "Pages proof", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestPages00001", true);
  await setSubscription(OWNER, { customerId: "cus_Owner00004", subscriptionId: "sub_Owner00004", active: true, period: paidPeriod() });
  const guide = await addProduct(OWNER, "Guide", "", "19", null);
  if (!guide.ok) throw new Error("no product");
  await setProductLink(OWNER, guide.product.id, "https://example.com/guide");

  part("A purchase on the second page of checkouts is on the list");
  // A hundred newer checkouts from another store on the same account, then ours, older: on the second page, as Stripe lists it.
  const newer = elsewhere(100);
  const ours = checkout(HANDLE, guide.product.id);
  pages = [newer, [ours]];
  asked = [];
  is("the purchase past the first hundred is listed", await outcome(), [ours.id]);
  is("the second page is asked from the last row of the first", asked, [null, (pages[0][99] as { id: string }).id]);

  part("Past the ceiling, before the newest purchases are all read: not read, never 'bought nothing'");
  pages = Array.from({ length: CEILING + 3 }, () => elsewhere(100));
  asked = [];
  is("the list is said not read", await outcome(), "not read");
  is(`no more than ${CEILING} pages are asked`, asked.length <= CEILING, true);

  part("Past the ceiling, the newest purchases all read: the list is shown");
  pages = Array.from({ length: CEILING + 3 }, () => Array.from({ length: 100 }, () => checkout(HANDLE, guide.product.id)));
  asked = [];
  const shown = await outcome();
  is(`the newest ${MAX_LISTED} are shown`, Array.isArray(shown) ? shown.length : shown, MAX_LISTED);
  is("they are the newest", Array.isArray(shown) && shown[0] === pages[0][0].id, true);

  done();
}

void main();
