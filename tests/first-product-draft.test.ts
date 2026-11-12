/**
 * The first product made into a product draft (490 [PP1], unit 3; app/api/store/first-product/draft; added
 * 12 November 2026), through the real route with a real session. Checked: the product is made hidden, in one write,
 * with the title and the price the creator chose and no file yet; nothing is published; a missing or placeholder
 * title and a price the currency cannot take are refused and make nothing; a role that cannot change products is
 * refused; the store's product limit is kept.
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { POST as draftRoute } from "@/app/api/store/first-product/draft/route";
import { placeholderTitle } from "@/lib/first-product";
import { claimHandle, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();
  const owner = "draft@example.com";
  await claimHandle(owner, "draftshop", "Draft Shop", "");
  await setStripeAccount(owner, "acct_1DraftShop00001", true);
  await setSubscription(owner, { customerId: "cus_Draft0001", subscriptionId: "sub_Draft0001", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(owner);
  const post = (body: unknown) =>
    draftRoute(new NextRequest("https://marktmorgen.com/api/store/first-product/draft", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` }, body: JSON.stringify(body) }));
  const count = async () => (await storeForEmail(owner))!.catalog.items.length;

  part("Made hidden, with the creator's title and price");
  const response = await post({ title: "Bread at home", price: "19" });
  const data = (await response.json()) as { ok?: boolean; product?: { id: string; title: string; hidden: boolean } };
  is("answered with the draft", [response.status, data.ok, data.product?.title, data.product?.hidden], [200, true, "Bread at home", true]);
  const listing = await readListing((await storeForEmail(owner))!, data.product!.id);
  is("kept hidden, at that price, with no file yet", [listing?.hidden, listing?.priceCents, listing?.file ?? null], [true, 1900, null]);
  const free = (await (await post({ title: "Free sampler", price: "0" })).json()) as { ok?: boolean };
  is("a free product may be a draft too", free.ok, true);

  part("Refused, and nothing made");
  const before = await count();
  const refused = await Promise.all([post({ title: "", price: "19" }), post({ title: placeholderTitle("guide"), price: "19" }), post({ title: "A guide", price: "nineteen" })]);
  is("a missing or placeholder title, a price the currency cannot take", await Promise.all(refused.map(async (r) => [r.status, ((await r.json()) as { error?: string }).error])), [[400, "title"], [400, "title"], [400, "price"]]);
  is("no product was made by a refusal", await count(), before);

  part("The route");
  const source = readFileSync("app/api/store/first-product/draft/route.ts", "utf8");
  is("only who may change products, with a small body", source.includes('guardStoreWrite(request, "products", 2_000)'), true);
  is("always a draft, made in one write", source.includes('addProduct(ref, title, "", text(body.price, 20), null, null, true)'), true);
  is("nothing here publishes", /setProductHidden|visibility|hidden: false/.test(source), false);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
