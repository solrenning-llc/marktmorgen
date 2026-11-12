// The confirmation email's subject names every product the order hands over, as the page after paying and the
// email's own first line do. Found walking the buyer path (Claude 1, 12/11/2026): a cart of "Sunday Baking" and
// "Pantry Checklist" was confirmed as "Your order from Harbor Kitchen: Sunday Baking", so the receipt of the second
// product could not be found by its name in the inbox's list. Synthetic store and checkout, the in-memory database.
import { addProduct, claimHandle, setStripeAccount, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmationFor } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const baking = await addProduct(OWNER, "Sunday Baking", "", "24", null);
  const pantry = await addProduct(OWNER, "Pantry Checklist", "", "9", null);
  const planner = await addProduct(OWNER, "Meal Planner", "", "27", null);
  if (!baking.ok || !pantry.ok || !planner.ok) throw new Error("no products");
  const store = (await storeForEmail(OWNER))!;
  const listings = await Promise.all([baking, pantry, planner].map(async (made) => (await readListing(store, made.ok ? made.product.id : ""))!));
  const session = (metadata: Record<string, string>, cents: number) => ({
    id: `cs_test_cartsubject${Object.keys(metadata).length}${cents}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: cents,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "buyer@example.com" },
    metadata: { store: "harbor", ...metadata },
  });
  const subject = (metadata: Record<string, string>, cents: number) => confirmationFor(store, session(metadata, cents) as never, Date.now() / 1000, [], listings)?.subject;
  const id = (made: typeof baking) => (made.ok ? made.product.id : "");

  part("The subject names what was bought");
  is("one product: its name, as before", subject({ product: id(baking) }, 2400), "Your order from Harbor Kitchen: Sunday Baking");
  is("a cart of two: both", subject({ product: id(baking), cart: "yes", bump: id(pantry), bump_cents: "900" }, 3300), "Your order from Harbor Kitchen: Sunday Baking and Pantry Checklist");
  is("a box ticked at checkout: both", subject({ product: id(baking), bump: id(planner), bump_cents: "1500" }, 3900), "Your order from Harbor Kitchen: Sunday Baking and Meal Planner");
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
