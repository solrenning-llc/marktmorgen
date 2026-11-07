/**
 * 487 [IT4], the creator's "Recommended" price (decision C1-20261106-0100-TODOS-1):
 * it is marked and listed first, but never chosen for the buyer, who picks
 * (no misleading default). Checked:
 *
 *   - the order: the recommended option first, the others in the creator's
 *     order; with none recommended, the creator's order unchanged;
 *   - the product page's three pickers (the cards, the list past a handful,
 *     and "which one" when buying for someone else) open with nothing chosen
 *     and ask for a choice before the form is sent: no radio checked, the
 *     lists starting on an empty "Choose one" line, every one required; the
 *     server already refuses an order with no option (lib/store-checkout.ts);
 *   - the words: the studio, the help and the feature page no longer say the
 *     recommended price "opens chosen"; the new "Choose one" is in every buyer
 *     language.
 */
import { readFileSync } from "node:fs";
import { optionsInPickOrder } from "@/lib/product-option";
import type { ProductOption } from "@/lib/product-option";
import { wordsIn } from "@/lib/buyer-words";
import { done, is, part } from "./check";

const option = (id: string, best = false) => ({ id, label: id, priceCents: 1000, details: [], best }) as unknown as ProductOption;

part("The order: the recommended first, the others as the creator set them");
is("recommended moves to the front", optionsInPickOrder([option("a"), option("b"), option("c", true), option("d")]).map((o) => o.id), ["c", "a", "b", "d"]);
is("already first stays first", optionsInPickOrder([option("a", true), option("b")]).map((o) => o.id), ["a", "b"]);
is("none recommended: the creator's order", optionsInPickOrder([option("b"), option("a")]).map((o) => o.id), ["b", "a"]);
is("an empty list stays empty", optionsInPickOrder([]), []);
const input = [option("a"), option("b", true)];
optionsInPickOrder(input);
is("the creator's own list is not reordered in place", input.map((o) => o.id), ["a", "b"]);

part("The product page: nothing chosen for the buyer, a choice asked for");
const page = readFileSync("components/store-product.tsx", "utf8");
is("no picker opens on a starting option", /startingOption/.test(page), false);
is("no radio is checked when the page opens", /defaultChecked=\{option\.id ===/.test(page), false);
is("the cards are required", /type="radio"\s+name="option"\s+value=\{option\.id\}\s+required/.test(page), true);
const lists = page.match(/<select[^>]*name="option"[^>]*>/g) ?? [];
is("both lists start empty and are required", lists.length === 2 && lists.every((tag) => /defaultValue=""/.test(tag) && /\brequired\b/.test(tag)), true);
is("each list starts on an empty, unpickable 'Choose one' line", (page.match(/<option value="" disabled>\s*\{w\.chooseOne\}\s*<\/option>/g) ?? []).length, 2);
is("the options are shown in the pick order", (page.match(/optionsInPickOrder\(/g) ?? []).length >= 2, true);

part("The words");
const editor = readFileSync("components/product-editor.tsx", "utf8");
const help = readFileSync("lib/help-content.ts", "utf8");
const features = readFileSync("lib/feature-pages.ts", "utf8");
for (const [name, text] of [["the studio", editor], ["the help", help], ["the feature page", features]] as const) {
  is(`${name} no longer says the recommended price opens chosen`, /opens chosen|Chosen when the page opens/.test(text), false);
}
is("the studio says what it does: marked and listed first, the buyer picks", editor.includes("Marked “Recommended” and listed first. Buyers still pick it themselves: nothing is chosen for them."), true);
for (const language of ["en", "es", "fr", "de", "it", "nl", "pt"] as const) {
  const w = wordsIn(language) as unknown as { chooseOne?: unknown };
  is(`${language}: "Choose one" is there`, typeof w.chooseOne === "string" && (w.chooseOne as string).length > 0, true);
}

done();
