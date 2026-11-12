/**
 * Hunt C (claude7): a checkout box (order bump) on a bundle that offers a
 * product the same bundle already hands over. Ticked, the buyer pays the
 * bundle and that product again (lib/store-checkout.ts adds the box's line
 * from activeBumps), for one copy of it. The offers after paying already pass
 * over a bundle's products (lib/upsell.ts, deliveredIds), the box does not.
 * Pure rule check on synthetic listings.
 */
import { activeBumps, bumpPauseWords, bumpStates } from "@/lib/product-extras";
import type { Listing, Product } from "@/lib/store";
import { done, is, part } from "./check";

function item(id: string, priceCents: number, over: Partial<Product> = {}): Product {
  return {
    id,
    title: id,
    summary: "",
    priceCents,
    recurring: null,
    call: null,
    course: null,
    options: [],
    pwyw: null,
    stock: null,
    bundle: null,
    pick: null,
    file: { pathname: `${id}.pdf`, name: `${id}.pdf`, size: 1, url: "" },
    link: null,
    bumps: [],
    plan: null,
    funnel: null,
    fields: [],
    image: null,
    hidden: false,
    about: false,
    page: false,
    keys: null,
    ...over,
  } as unknown as Product;
}

part("A box on a bundle, offering what the bundle already holds");
const bread = item("bread", 1900);
const starter = item("starter", 900);
const set = item("set", 2500, { file: null, bundle: ["bread", "starter"], bumps: [{ productId: "bread", priceCents: 1500, pitch: "" }] });
const shown = activeBumps([bread, starter, set] as Listing[], set as Listing);
is("the box is never shown for a product the bundle already hands over", shown.map((offer) => offer.target.id), []);
is("the studio is told why", bumpStates([bread, starter, set] as Listing[], set as Listing).map((state) => ("paused" in state ? state.paused : "shown")), ["inBundle"]);

part("A box offering a bundle that already holds the product bought");
const loaf = item("loaf", 1900, { bumps: [{ productId: "set", priceCents: 2000, pitch: "" }] });
const set2 = item("set", 2500, { file: null, bundle: ["loaf", "starter"] });
is("the box is never shown for a bundle that holds the product itself", activeBumps([loaf, starter, set2] as Listing[], loaf as Listing).map((offer) => offer.target.id), []);

part("A box on a bundle offering a product it does not hold");
const jam = item("jam", 700);
const set3 = item("set", 2500, { file: null, bundle: ["bread", "starter"], bumps: [{ productId: "jam", priceCents: 500, pitch: "" }] });
is("still shown", activeBumps([bread, starter, jam, set3] as Listing[], set3 as Listing).map((offer) => offer.target.id), ["jam"]);

part("The studio's sentence for it reads as a sentence, named or not");
const words = [bumpPauseWords("inBundle", "Bread"), bumpPauseWords("inBundle", "")];
is("it starts with a capital letter and names the offer when it has a name", words.map((w) => [/^[A-Z]/.test(w), w.includes("Bread")]), [[true, true], [true, false]]);
done();
