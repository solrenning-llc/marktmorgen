/**
 * C7 (API bug hunt): GET /api/v1/sales takes API_SALES_UNITS of the store's API requests, the request itself one of
 * them (the door's 1, then API_SALES_UNITS - 1 more, app/api/v1/sales/route.ts). When the listings its titles need
 * are then refused for want of requests, lib/api-sales.ts asked the route's charge (lib/api-guard.ts takeMoreApi)
 * with `taken` = API_SALES_UNITS, but takeMoreApi's `taken` is what the reading took BEYOND the door, as every other
 * caller passes it (lib/api-numbers.ts, app/api/mcp/route.ts). So the refusal told the creator one request more than
 * the call took and needs: "the 11 it already took stay counted" where 10 were taken.
 *
 * Checked with the route's own charge, on a store whose sold product's listing is kept outside the store record
 * (so its title must be read), with exactly the call's units taken and none left. Synthetic Stripe answer only.
 */
import { makeKey } from "@/lib/api-keys";
import { takeMoreApi } from "@/lib/api-guard";
import { sales } from "@/lib/api-sales";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { API_SALES_UNITS, allowanceFor } from "@/lib/store-allowance-rules";
import { addProduct, claimHandle, ensureStatsId, setStripeAccount, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "c7-api-sales-taken@example.com";
const HANDLE = "c7-api-sales-taken";
const ACCOUNT = "acct_C7SalesTaken01";
process.env.STRIPE_SECRET_KEY = "sk_test_c7_sales_stand_in";

let productId = "";
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.stripe.com" || url.pathname !== "/v1/checkout/sessions") throw new Error(`unexpected synthetic operation ${url}`);
  return Response.json({
    object: "list",
    has_more: false,
    data: [{
      id: "cs_test_c7one", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: 1_790_000_000,
      payment_intent: { id: "pi_c7", object: "payment_intent", latest_charge: { id: "ch_c7", object: "charge", created: 1_790_000_060, amount_refunded: 0, disputed: false } },
      amount_total: 4900, currency: "usd", total_details: { amount_discount: 0 },
      customer_details: { email: "dana@example.com", name: "Dana" },
      // No title written on the checkout: the product's listing is read for it.
      metadata: { store: HANDLE, product: productId },
    }],
  });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, HANDLE, "C7 Sales Taken", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_c7salestaken", subscriptionId: "sub_c7salestaken", active: true, tier: "pro", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, ACCOUNT, false);
  const made = await addProduct(OWNER, "The Guide", "", "10", null);
  if (!made.ok) throw new Error("setup: product");
  productId = made.product.id;
  const base = (await storeForEmail(OWNER))!;
  if (!(await makeKey(base.sid, "Synthetic reader")).ok) throw new Error("setup: key");
  // The product's listing kept outside the store record, as a large catalog keeps it: its title is read, and paid for.
  const item = base.catalog.items.find((x) => x.id === productId)!;
  const store = { ...base, catalog: { id: "c7catalog", items: [item], head: [], inline: null } } as Store;

  part("A page whose titles cannot be paid for: the refusal counts what the call really took");
  // Everything but the call's own units used, then the call's units taken as the route takes them (door + the rest).
  const limit = allowanceFor(store, "api");
  const fill = await takeAllowance(store, "api", limit - (await allowanceUsed(store, "api")) - API_SALES_UNITS);
  const door = await takeAllowance(store, "api");
  const rest = await takeMoreApi(store, API_SALES_UNITS - 1);
  if (!fill.ok || !door.ok || rest) throw new Error("setup: the call's units");
  const before = await allowanceUsed(store, "api");
  const page = await sales(store, null, (more, taken) => takeMoreApi(store, more, taken));
  if (!(page instanceof Response)) throw new Error("the titles were not refused");
  const words = ((await page.json()) as { message: string }).message;
  is("refused as the month used", page.status, 429);
  is("nothing more taken", (await allowanceUsed(store, "api")) - before, 0);
  const said = words.match(/the ([\d,]+) it already took/);
  is(`it says the ${API_SALES_UNITS} the call took stay counted`, said?.[1], String(API_SALES_UNITS));
  const needs = Number(words.match(/needs ([\d,]+) of/)?.[1]);
  is("and a whole it needs of the call's units plus the titles' (no request counted twice)", needs > API_SALES_UNITS && needs - API_SALES_UNITS < API_SALES_UNITS, true);
  is("the whole is one more than the call's units only when the titles take one", String(needs - API_SALES_UNITS), "1");

  done();
}

void main();
