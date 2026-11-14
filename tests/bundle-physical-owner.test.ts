/**
 * A shipped product can never be made a bundle (C7 shipping hunt, 14 November 2026). Every other door keeps a shipped
 * product from becoming something else (a call, a course, a plan, a file or a link), but bundleOwnerProblem did not
 * look at shipping, so setProductBundle (and the studio's convert page, app/studio/bundles, which asks the same rule)
 * turned a printed book with $6 shipping into a bundle. From then on shipProblem says "delivery", activeShipping is
 * null, and every checkout opened with no shipping line and no address asked, while the studio still showed the
 * shipping the creator set: the buyer was charged less than the page promised and nothing could be sent.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setProductShipping, setStripeAccount, setSubscription, setProductBundle, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { bundleOwnerProblem } from "@/lib/bundle-rules";
import { activeShipping, parseShipping } from "@/lib/shipping";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "no stand-in" } }), { status: 404 })) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "bundle-ship@example.com";
  await claimHandle(OWNER, "bundleship", "Bundle Ship", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestBundleShip", true);
  await setSubscription(OWNER, { customerId: "cus_BundleShip01", subscriptionId: "sub_BundleShip01", active: true, period: paidPeriod() });
  const book = await addProduct(OWNER, "The Supper Book", "Printed, 120 pages.", "35", null);
  const a = await addProduct(OWNER, "Recipe PDF", "", "12", null);
  const b = await addProduct(OWNER, "Video class", "", "15", null);
  if (!book.ok || !a.ok || !b.ok) throw new Error("no product");
  await setProductLink(OWNER, a.product.id, "https://example.com/a");
  await setProductLink(OWNER, b.product.id, "https://example.com/b");
  const shipping = parseShipping({ cents: 600, region: "na" })!;
  const saved = await setProductShipping(OWNER, book.product.id, shipping);
  if (!saved.ok) throw new Error("shipping fixture");

  part("A shipped product is never made a bundle");
  const shipped = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("the rule says why", bundleOwnerProblem(shipped), "shipped");
  const made = await setProductBundle(OWNER, book.product.id, [a.product.id, b.product.id]);
  is("and the store refuses it", made.ok ? "bundle" : made.reason, "shipped");
  const after = (await readProduct((await storeForEmail(OWNER))!, book.product.id))!;
  is("so it stays a shipped product, with its shipping charged", [after.bundle, activeShipping(after)?.cents], [null, 600]);

  part("A product with nothing of its own still becomes one");
  const box = await addProduct(OWNER, "Starter box", "", "25", null);
  if (!box.ok) throw new Error("no product");
  is("made a bundle", (await setProductBundle(OWNER, box.product.id, [a.product.id, b.product.id])).ok, true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
