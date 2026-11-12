/**
 * Hunt C (claude7): a cart that holds a bundle and a product that the same
 * bundle already hands over charges the buyer twice for that product.
 *
 * lib/cart-bundle.ts promises "a buyer is never asked to pay twice for a
 * product the cart already holds", and the offers after paying pass over a
 * bundle's products (lib/cart-offers.ts, deliveredIds). The cart's own
 * checkout (POST /api/store/cart -> lib/cart-checkout.ts) does not: it opens
 * a Stripe checkout with the bundle's line AND the product's own line.
 * Synthetic store, Stripe mocked.
 */
import { NextRequest } from "next/server";
import { GET as readCart, POST as payCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductLink, setStripeAccount, setSubscription } from "@/lib/store";
import { withConsent } from "./digital-consent-fixture";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sessions: URLSearchParams[] = [];
process.env.STRIPE_SECRET_KEY = "sk_test_hunt_c_bundle_twice";

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    sessions.push(new URLSearchParams(String(init.body)));
    return Response.json({ id: "cs_test_huntCBundleTwice0001", url: "https://checkout.stripe.com/c/pay/cs_test_huntCBundleTwice0001" });
  }
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const OWNER = "huntc-bundle@example.test";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "huntcbundle", "Hunt C Bundle", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1HuntCBundle01", true);
  await setSubscription(OWNER, { customerId: "cus_HuntCBundle1", subscriptionId: "sub_HuntCBundle1", active: true, tier: "creator", period: paidPeriod() });
  const ids: Record<string, string> = {};
  for (const [title, price] of [["Bread", "19"], ["Starter", "9"], ["Jam", "7"]]) {
    const added = await addProduct(OWNER, title, "", price, null);
    if (!added.ok) throw new Error(`no ${title}`);
    ids[title] = added.product.id;
    await setProductLink(OWNER, added.product.id, `https://example.test/${title.toLowerCase()}`);
  }
  const set = await addProduct(OWNER, "Baker's set", "", "25", null);
  if (!set.ok) throw new Error("no bundle");
  ids.Set = set.product.id;
  if (!(await setProductBundle(OWNER, ids.Set, [ids.Bread, ids.Starter])).ok) throw new Error("bundle not set");

  part("A bundle and a product it already hands over, in one cart");
  const form = withConsent(new URLSearchParams([["handle", "huntcbundle"], ["id", ids.Set], ["id", ids.Bread]]));
  const response = await payCart(new NextRequest("https://marktmorgen.test/api/store/cart", {
    method: "POST",
    headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }));
  const body = sessions.at(-1);
  // What Stripe was asked to charge, line by line, and which products those lines hand over.
  const charged: string[] = [];
  if (body) {
    for (let i = 0; i < 4; i += 1) if (body.get(`line_items[${i}][price_data][unit_amount]`)) charged.push(body.get(`line_items[${i}][price_data][product_data][name]`) ?? "");
  }
  const bundleHolds = body?.get("metadata[bundle]") ?? "";
  is(
    "Bread is never charged on its own line while the bundle in the same cart already hands it over",
    { opened: sessions.length, breadOwnLine: charged.includes("Bread"), bundleHandsOverBread: bundleHolds.includes(ids.Bread) && charged.includes("Bread") },
    { opened: sessions.length, breadOwnLine: false, bundleHandsOverBread: false },
  );
  is("no checkout is opened at all", sessions.length, 0);
  is("the buyer goes back to the cart, told it changed", { status: response.status, to: response.headers.get("location")?.includes("cart=changed") ?? false }, { status: 303, to: true });

  part("The cart, read: the product the bundle brings is not payable on its own line");
  const read = await readCart(new NextRequest(`https://marktmorgen.test/api/store/cart?handle=huntcbundle&ids=${ids.Set},${ids.Bread}`, { headers: { host: "marktmorgen.test" } }));
  const lines = ((await read.json()) as { items?: { id: string; ok: boolean }[] }).items ?? [];
  is("the bundle is payable, its product is not", lines.map((line) => [line.id === ids.Set ? "set" : "bread", line.ok]), [["set", true], ["bread", false]]);

  part("A bundle and a product it does not hold still check out together");
  const other = withConsent(new URLSearchParams([["handle", "huntcbundle"], ["id", ids.Set], ["id", ids.Jam]]));
  await payCart(new NextRequest("https://marktmorgen.test/api/store/cart", {
    method: "POST",
    headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
    body: other.toString(),
  }));
  is("one checkout opened", sessions.length, 1);
  done();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
