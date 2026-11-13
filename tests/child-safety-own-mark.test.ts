/**
 * Claude 4's residual MEDIUM on #3471 (6797910626), confirmed by Claude 1: a
 * product kept for a child-safety report whose hide did not go in (the keep
 * mark written, setProductHidden failed or unknown) is still listed. The
 * readers that offered it read a hold only for hidden products, so in that
 * state a checkout box (offerableTargets), a bundle's items (offeredItems) and
 * an offer after paying (offerableAfterPaying) still named it, and the call
 * and call-package doors never read its own mark. Each now reads the mark of
 * every product it offers, hidden or not; a hold that cannot be read leaves
 * it out. Synthetic store and products with placeholder titles, in-memory
 * Redis; nothing reported is opened.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureStatsId, setProductBundle, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { keepKey, offerableTargets } from "@/lib/child-safety-holds";
import { offerableAfterPaying, offeredItems } from "@/lib/bundles";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "own.mark@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "ownmark", "Own Mark Store", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1OwnMarkStore01", true);
  await setSubscription(OWNER, { customerId: "cus_OwnMark01", subscriptionId: "sub_OwnMark01", active: true, period: paidPeriod() });
  const made = async (title: string, link = true) => {
    const one = await addProduct(OWNER, title, "", "19", null);
    if (!one.ok) throw new Error("fixture product failed");
    if (link) await setProductLink(OWNER, one.product.id, "https://example.com/placeholder");
    return one.product.id;
  };
  const held = await made("Item A");
  const other = await made("Item B");
  const third = await made("Item C");
  const bundleId = await made("Set", false);
  const bundled = await setProductBundle(OWNER, bundleId, [held, other, third]);
  if (!bundled.ok) throw new Error(`fixture bundle failed: ${bundled.reason}`);
  let store = (await storeForEmail(OWNER))!;
  // The state the residual MEDIUM is about: the keep mark written, the product not hidden.
  await redis.pipeline([["SET", keepKey(store, held), "1"]]);
  store = (await storeForEmail(OWNER))!;
  const heldListing = (await readListing(store, held))!;
  const otherListing = (await readListing(store, other))!;
  const bundle = (await readListing(store, bundleId))!;
  is("control: the held product is not hidden", Boolean(heldListing.hidden), false);

  part("A checkout box never offers a held product, hidden or not");
  is("offerableTargets leaves it out", (await offerableTargets(store, [heldListing, otherListing])).map((p) => p.id), [other]);

  part("A bundle's items never include a held product, hidden or not");
  // A bundle holding a held product hands over nothing at all (deliverableItems), never the rest of it.
  const items = (await offeredItems(store, [bundle])).get(bundleId)?.map((p) => p.id) ?? null;
  is("offeredItems offers nothing of a bundle holding it", items, []);

  part("An offer after paying never names a held product, hidden or not");
  is("offerableAfterPaying leaves the product out", (await offerableAfterPaying(store, [heldListing, otherListing])).map((p) => p.id), [other]);

  part("The call and call-package doors read the product's own mark");
  for (const route of ["app/api/store/book/route.ts", "app/api/store/package/route.ts"]) {
    is(`${route} reads the product's own keep mark`, readFileSync(route, "utf8").includes("isHeldForReport(store, product.id)"), true);
  }
  done();
}

void main();
