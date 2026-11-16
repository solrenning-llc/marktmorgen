/**
 * The order of the parts of a store page (lib/store-order.ts; added 9 October
 * 2026). Checked: an order is always whole, each part once; a part missing
 * from a kept order goes back where it falls in the usual one; a search puts
 * the products first; the order is kept on the store.
 */
import { claimHandle, setOrder, storeForEmail } from "@/lib/store";
import { USUAL_ORDER, drawnOrder, isUsualOrder, parseOrder } from "@/lib/store-order";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  redis.clear();

  part("An order, made whole");
  is("nothing kept is the usual order", parseOrder(undefined), USUAL_ORDER);
  // The welcome video joined the parts on 16 November 2026, right after the products (496 [ME1], unit 3; tests/store-intro-part.test.ts).
  is("the usual order is the page as it always was, with the welcome video after the products", USUAL_ORDER, ["products", "intro", "quotes", "links", "tips", "signup", "faq", "contact", "community"]);
  is("each part once, and names that are not parts dropped", parseOrder(["community", "community", "banner", 4, ...USUAL_ORDER]), ["community", ...USUAL_ORDER.filter((p) => p !== "community")]);
  is("a part missing goes right after the one before it in the usual order", parseOrder(["links", "products", "tips", "signup", "faq", "contact", "community"]), ["links", "products", "intro", "quotes", "tips", "signup", "faq", "contact", "community"]);
  const chosen = ["signup", "links", "tips", "products", "intro", "quotes", "faq", "contact", "community"];
  is("a whole order is kept as it is", parseOrder(chosen), chosen);
  is("a part added after an order was chosen goes in after the part it follows in the usual order", parseOrder(["signup", "links", "tips", "products", "intro", "faq", "contact", "community"]), chosen);
  is("whatever was sent, every part is there", parseOrder(["community", "faq"]).slice().sort(), USUAL_ORDER.slice().sort());
  is("a store that chose its order before Support my work existed finds it under its links", parseOrder(["links", "products", "intro", "quotes", "signup", "faq", "contact", "community"]), ["links", "tips", "products", "intro", "quotes", "signup", "faq", "contact", "community"]);
  is("the usual order is known as such", [isUsualOrder(USUAL_ORDER), isUsualOrder(parseOrder(chosen))], [true, false]);

  part("A search");
  is("puts the products first, whatever the order", drawnOrder(parseOrder(chosen), true).slice(0, 3), ["products", "signup", "links"]);
  is("and otherwise the creator's order stands", drawnOrder(parseOrder(chosen), false), chosen);

  part("Kept on the store");
  const owner = "order@example.com";
  await claimHandle(owner, "ordershop", "Order Shop", "");
  is("a new store has the usual order", (await storeForEmail(owner))?.order, USUAL_ORDER);
  await setOrder(owner, chosen);
  is("a chosen one is kept", (await storeForEmail(owner))?.order, chosen);
  await setOrder(owner, [...chosen.slice(0, 3), "nonsense", ...chosen.slice(3)]);
  is("and a name that is not a part is never kept", (await storeForEmail(owner))?.order, chosen);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
