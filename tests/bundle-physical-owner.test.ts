/**
 * A shipped product can never be made a bundle (C7 shipping hunt, 14 November 2026). Every other door keeps a shipped
 * product from becoming something else (a call, a course, a plan, a file or a link), but bundleOwnerProblem did not
 * look at shipping, so setProductBundle (and the studio's convert page, app/studio/bundles, which asks the same rule)
 * turned a printed book with $6 shipping into a bundle. From then on shipProblem says "delivery", activeShipping is
 * null, and every checkout opened with no shipping line and no address asked, while the studio still showed the
 * shipping the creator set: the buyer was charged less than the page promised and nothing could be sent.
 */
import { addProduct, claimHandle, ensureStatsId, setProductExtras, setProductLink, setProductShipping, setStripeAccount, setSubscription, setProductBundle, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { handsOver } from "@/lib/product-option";
import { sellsWithPayPal } from "@/lib/paypal-sales";
import { bumpState, bumpTargetPause, canBeBumped } from "@/lib/product-extras";
import { readFileSync } from "node:fs";
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
  part("A bundle saved with shipping before this rule is never sold without it");
  // As one made before the rule: a bundle whose record also holds shipping, written as the store keeps it.
  const legacy = await addProduct(OWNER, "Old gift box", "", "40", null);
  if (!legacy.ok) throw new Error("no product");
  if (!(await setProductBundle(OWNER, legacy.product.id, [a.product.id, b.product.id])).ok) throw new Error("bundle fixture");
  const catalog = (await storeForEmail(OWNER))!.catalog.id!;
  const key = `nl:catalog:${catalog}:l:${legacy.product.id}`;
  const [raw] = (await redis.pipeline([["GET", key]])) as string[];
  await redis.pipeline([["SET", key, JSON.stringify({ ...JSON.parse(raw), shipping })]]);
  const now = (await storeForEmail(OWNER))!;
  const old = (await readProduct(now, legacy.product.id))!;
  is("the record holds both, as one saved before the rule", [Boolean(old.bundle), old.shipping?.cents], [true, 600]);
  is("it hands over nothing it can charge for, so Stripe's checkout, the cart and the page do not sell it (canSellProduct)", handsOver(old), false);
  is("while a bundle with no shipping still does", handsOver((await readProduct(now, box.product.id))!), true);
  is("nor through PayPal", sellsWithPayPal(old), false);
  is("and a shipped product is never sold through PayPal, which asks for no address", sellsWithPayPal(after), false);

  part("Nor as a box on another product's checkout, nor as an offer after paying (review of #4538)");
  is("a bundle saved with shipping is never a box or an offer (canBeBumped)", canBeBumped(old), false);
  is("its box reason", bumpTargetPause(old), "targetEmpty");
  const host = await addProduct(OWNER, "Host guide", "", "20", null);
  if (!host.ok) throw new Error("no product");
  await setProductLink(OWNER, host.product.id, "https://example.com/host");
  const boxed = await setProductExtras(OWNER, host.product.id, { bump: { productId: legacy.product.id, priceCents: 3000, pitch: "Add the box" }, slot: 0 });
  is("a box offering it is not saved", boxed.ok ? "saved" : boxed.reason, "target");
  // A box saved before the rule: the checkout reads bumpState, which pauses it, so it is never charged.
  const later = (await storeForEmail(OWNER))!;
  const hostNow = (await readProduct(later, host.product.id))!;
  const state = bumpState([hostNow, old], hostNow, { productId: old.id, priceCents: 3000, pitch: "Add the box" });
  is("a box saved before is paused at the checkout", "paused" in state ? state.paused : "live", "targetEmpty");
  is("a bundle with no shipping can still be a box", canBeBumped((await readProduct(later, box.product.id))!), true);

  const editor = readFileSync("components/shipping-editor.tsx", "utf8");
  is("the studio says why, beside the shipping it shows", editor.includes("This bundle is not on sale while it has shipping"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
