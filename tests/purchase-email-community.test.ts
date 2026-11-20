// A purchase that opens the creator's members' community says so in its confirmation email, with the way in, as the
// page after paying does. Found walking the buyer path (Claude 1, 12/11/2026): the page after paying said "Also yours:
// Harbor Kitchen Local Community ... Go to the community", and the confirmation email, the record a buyer keeps after
// closing that page, said nothing about it. Synthetic store and checkout, the in-memory database, no email sent.
import { addProduct, claimHandle, setCommunity, setStripeAccount, storeForEmail } from "@/lib/store";
import { freshConfig, readConfig, saveConfig } from "@/lib/community";
import { readListing } from "@/lib/catalog";
import { communityFor, confirmationFor } from "@/lib/purchase-email";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "owner@example.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "harbor", "Harbor Kitchen", "");
  await setStripeAccount(OWNER, "acct_1TestHarbor0001", true);
  const planner = await addProduct(OWNER, "Meal Planner", "", "27", null);
  const pantry = await addProduct(OWNER, "Pantry Checklist", "", "9", null);
  if (!planner.ok || !pantry.ok) throw new Error("no products");
  const on = await setCommunity(OWNER, true);
  if (!on?.community) throw new Error("no community");
  await saveConfig(on.community.id, { ...freshConfig("Harbor Kitchen"), name: "Harbor Kitchen Community", access: [planner.product.id] });
  is("the community lets in buyers of the planner", (await readConfig(on.community.id))?.access, [planner.product.id]);
  const store = (await storeForEmail(OWNER))!;
  const listings = [(await readListing(store, planner.product.id))!, (await readListing(store, pantry.product.id))!];

  const session = (product: string, extra: Record<string, string> = {}) => ({
    id: `cs_test_community${product.slice(0, 6)}${Object.keys(extra).length}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    amount_total: 2700,
    currency: "usd",
    created: Math.floor(Date.now() / 1000),
    customer_details: { email: "buyer@example.com" },
    metadata: { store: "harbor", product, ...extra },
  });
  const letter = async (product: string, extra: Record<string, string> = {}) => {
    const s = session(product, extra);
    return confirmationFor(store, s as never, Date.now() / 1000, [], listings, null, null, await communityFor(store, s as never))?.text ?? "";
  };

  part("The email of a purchase that opens the community says so, with the way in");
  const opens = await letter(planner.product.id);
  is("its name", opens.includes("Also yours: Harbor Kitchen Community"), true);
  is("how to come in, in the words of the page after paying", opens.includes("This purchase opens Harbor Kitchen's members' community. Come in with buyer@example.com: a link is sent there, and there is no password to make."), true);
  is("and where", opens.includes("Go to the community: https://marktmorgen.com/@harbor/community"), true);

  part("Only for what lets buyers in");
  const other = await letter(pantry.product.id);
  is("a product the community does not let in says nothing of it", [other.includes("Also yours"), other.includes("members' community"), other.includes("/community")], [false, false, false]);
  await setCommunity(OWNER, false);
  const off = (await storeForEmail(OWNER))!;
  const s = session(planner.product.id);
  is("a community switched off is not offered", await communityFor(off, s as never), null);
  is("a gift opens nothing for whoever paid for it", await communityFor(store, session(planner.product.id, { gift: "1" }) as never), null);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
