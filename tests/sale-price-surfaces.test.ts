/**
 * While a store-wide sale covers a product, the product page, its structured data and the checkout all take the sale
 * off; the picture a shared link unfolds into (app/[handle]/p/[product]/opengraph-image.tsx) and the store guide's picks
 * (app/api/store/guide/route.ts) said the full price, through pricePill (claude7/catalog-hunt-2, 13 November 2026).
 * They now say salePill: the price the checkout charges at this moment, the sale taken off, never a fair price for a
 * country (a shared card is the same for everybody). No price changes. The model is a stand-in for `fetch`.
 */
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { POST as guide } from "@/app/api/store/guide/route";
import { pricePill, salePill } from "@/components/store-product";
import { readListing } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, setAnswers, setStoreSale, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.anthropic.com") {
    return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ picks: [{ n: 1, why: "It fits." }] }) }] }));
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-only-a-stand-in-0123456789";
  process.env.STRIPE_SECRET_KEY = "sk_test_sale_surfaces_stand_in";
  const owner = "sale-surfaces@example.test";
  await claimHandle(owner, "salesurfaces", "Sale Surfaces", "");
  await ensureStatsId(owner);
  await setSubscription(owner, { customerId: "cus_SaleSurf0001", subscriptionId: "sub_SaleSurf0001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(owner, "acct_1SaleSurfaces01", true);
  await setAnswers(owner, { on: true, facts: "" });
  const course = await addProduct(owner, "Bread Course", "Bake bread at home.", "100", null);
  const other = await addProduct(owner, "Pastry Course", "Bake pastry at home.", "50", null);
  if (!course.ok || !other.ok) throw new Error("product fixture");
  const now = Math.floor(Date.now() / 1000);
  const sold = await setStoreSale(owner, { name: "Bake week", percent: 30, starts: now - 60, ends: now + 86_400, all: true, products: [], coupon: "SALE30BAKE" });
  if (!sold.ok) throw new Error("sale fixture");
  const store = (await storeForEmail(owner))!;
  const listing = (await readListing(store, course.product.id))!;

  part("The price a sale leaves");
  is("control: the plain pill says the full price", pricePill(store, listing), "$100");
  is("salePill says what the checkout charges now", salePill(store, listing), "$70");
  is("with no sale it is the plain pill", salePill({ ...store, sale: { ...store.sale, percent: 0 } }, listing), "$100");

  part("The store guide's picks");
  const answer = await guide(new NextRequest("https://marktmorgen.com/api/store/guide", {
    method: "POST",
    headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/json" },
    body: JSON.stringify({ handle: "salesurfaces", goal: "learn to bake bread" }),
  }));
  const body = (await answer.json()) as { ok: boolean; picks?: { title: string; price: string }[] };
  is("the pick says the sale price", [body.ok, body.picks?.map((p) => [p.title, p.price])], [true, [["Bread Course", "$70"]]]);

  part("The shared card");
  const card = readFileSync("app/[handle]/p/[product]/opengraph-image.tsx", "utf8");
  is("draws salePill, never the plain pill", [card.includes("salePill(store, product)"), card.includes("pricePill(")], [true, false]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
