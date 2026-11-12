/**
 * Hunt C (claude7): a checkout box (order bump) on a bundle that offers a
 * product the same bundle already hands over. Ticked, the buyer pays the
 * bundle and that product again (lib/store-checkout.ts adds the box's line
 * from activeBumps), for one copy of it. The offers after paying already pass
 * over a bundle's products (lib/upsell.ts, deliveredIds), the box does not.
 * Pure rule check on synthetic listings.
 */
import { activeBumps, bumpPauseWords, bumpStates } from "@/lib/product-extras";
import { activeCallAddOns, chosenCallAddOns } from "@/lib/call-addons";
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

part("Two boxes on one product: a product and a bundle that holds it");
// Reviews of #4021: each box was compared with the host only, so Loaf could offer Bread and Set (Bread + Starter) side
// by side; both ticked, the checkout added a Bread line and a Set line, and the buyer paid twice for one Bread.
const plain = item("loaf", 1900, { bumps: [{ productId: "bread", priceCents: 1500, pitch: "" }, { productId: "set", priceCents: 2000, pitch: "" }] });
const both = [plain, bread, starter, set2b()] as Listing[];
function set2b(): Product {
  return item("set", 2500, { file: null, bundle: ["bread", "starter"] });
}
is("only the first of the two is shown", activeBumps(both, plain as Listing).map((offer) => offer.target.id), ["bread"]);
is("the later box is paused, and the studio is told why", bumpStates(both, plain as Listing).map((state) => ("paused" in state ? state.paused : "shown")), ["shown", "inBundle"]);
const reversed = item("loaf", 1900, { bumps: [{ productId: "set", priceCents: 2000, pitch: "" }, { productId: "bread", priceCents: 1500, pitch: "" }] });
is("the other way round: the bundle first, the product it holds paused", bumpStates([reversed, bread, starter, set2b()] as Listing[], reversed as Listing).map((state) => ("paused" in state ? state.paused : "shown")), ["shown", "inBundle"]);
const apart = item("loaf", 1900, { bumps: [{ productId: "jam", priceCents: 500, pitch: "" }, { productId: "set", priceCents: 2000, pitch: "" }] });
is("two boxes that do not overlap are both shown", activeBumps([apart, bread, starter, jam, set2b()] as Listing[], apart as Listing).map((offer) => offer.target.id), ["jam", "set"]);

part("Two add-ons on one call: a product and a bundle that holds it");
const call = item("call", 9000, { file: null, call: { minutes: 30 } as unknown as Product["call"], bumps: [{ productId: "bread", priceCents: 1500, pitch: "" }, { productId: "set", priceCents: 2000, pitch: "" }] });
const open = { fromPackage: false, deposit: false, series: false, move: false };
const addOns = activeCallAddOns([call, bread, starter, set2b()] as Listing[], call as Listing, open);
is("only the first of the two add-ons is offered", addOns.map((offer) => offer.target.id), ["bread"]);
is("both ticked: one copy of Bread is charged, never two", chosenCallAddOns(addOns, ["bread", "set"]).map((line) => line.productId), ["bread"]);

part("The studio's sentence for it reads as a sentence, named or not");
const words = [bumpPauseWords("inBundle", "Bread"), bumpPauseWords("inBundle", "")];
is("it starts with a capital letter and names the offer when it has a name", words.map((w) => [/^[A-Z]/.test(w), w.includes("Bread")]), [[true, true], [true, false]]);
done();
