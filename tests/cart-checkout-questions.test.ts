/**
 * #4350 (Codex X5, MEDIUM, lost sales): a product with a question the buyer answers at checkout cannot go through the
 * cart's checkout (POST /api/store/cart refuses it and sends the buyer back with cart=changed), yet the product page
 * offered "Add to cart" and the cart's GET listed it as payable, in the total: nothing in the cart could be bought until
 * the buyer found and removed that line. The listing, which has no questions of its own, now says that the product
 * asks something (`asks`), so every place that offers the cart (cartable) and the cart's GET use the same rule as its
 * POST: such a product is bought from its own page, and the other lines stay payable. Synthetic store and Stripe.
 */
import { NextRequest } from "next/server";
import { GET as readCart } from "@/app/api/store/cart/route";
import { addProduct, claimHandle, ensureStatsId, setProductFields, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListings, readProducts } from "@/lib/catalog";
import { cartable } from "@/lib/cart-rules";
import { paidPeriod } from "./billing-period-fixture";
import "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_cart_questions";
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

async function main() {
  const owner = "cartquestions@example.test";
  if (!(await claimHandle(owner, "cartquestions", "Cart questions shop", "")).ok) throw new Error("fixture could not claim store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestCartAsks1", true);
  await setSubscription(owner, { customerId: "cus_cartasks00001", subscriptionId: "sub_cartasks00001", active: true, tier: "creator", period: paidPeriod() });
  const ids: string[] = [];
  for (const title of ["Custom guide", "Plain guide"]) {
    const made = await addProduct(owner, title, "A synthetic guide", "19", null);
    if (!made.ok) throw new Error("fixture could not add product");
    await setProductLink(owner, made.product.id, "https://example.test/guide");
    ids.push(made.product.id);
  }
  const [custom, plain] = ids;
  const saved = await setProductFields(owner, custom, [{ label: "Name for the guide", type: "text", optional: false, options: [] }]);
  is("the question was saved", saved.ok, true);
  const store = (await storeForEmail(owner))!;

  part("Every place that offers the cart reads the listing: it says the product asks something");
  const listings = await readListings(store, [custom, plain]);
  is("a product with a checkout question is not offered in the cart", listings.map((p) => [p.id === custom ? "custom" : "plain", cartable(p)]), [["custom", false], ["plain", true]]);
  const full = await readProducts(store, [custom]);
  is("nor is it read in full", cartable(full[0]), false);

  part("The cart, as it is opened, does not count it as payable; the other line still is");
  const response = await readCart(new NextRequest(`https://marktmorgen.test/api/store/cart?handle=${store.handle}&ids=${custom},${plain}`, { headers: { host: "marktmorgen.test" } }));
  const json = (await response.json()) as { items?: { id: string; ok: boolean; cents: number }[]; total?: number };
  is("the line with the question is not payable, the plain one is", (json.items ?? []).map(({ id, ok }) => [id === custom ? "custom" : "plain", ok]), [["custom", false], ["plain", true]]);

  part("A question removed makes it cartable again");
  await setProductFields(owner, custom, []);
  const again = await readListings((await storeForEmail(owner))!, [custom]);
  is("cartable once it asks nothing", cartable(again[0]), true);
  done();
}

void main().catch((error) => { console.error(error); process.exitCode = 2; });
