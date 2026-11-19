/**
 * "Ideas that mention prices or earnings are left out" (lib/product-ideas-rules.ts IDEAS_COPY.note) is what the studio
 * box promises, so an idea naming a price or a fortune is never shown (Codex X6, LOW on #3441 @067a5c1963): "Make a
 * fortune with bread" and "Starter pricing guide" were still shown while the sentence said otherwise. What fails here:
 *   - an idea with a price, pricing, cost, fee or fortune word, in any language a store sells in, is shown;
 *   - an honest product name that only looks close (a costume, "precise", "prized") is refused.
 * Synthetic only: no model, no store.
 */
import { keptIdeas } from "@/lib/product-ideas";
import { done, is, part } from "./check";

const facts = "Ann's Bread. Sourdough lessons for home bakers. A pack of 40 recipes.";
const idea = (title: string) => ({ title, who: "Home bakers who want a calm first loaf.", why: "The store already teaches sourdough to home bakers." });
const shown = (title: string) => keptIdeas(JSON.stringify({ ideas: [idea(title)] }), facts, []).length;

part("An idea that mentions prices or a fortune is never shown");
const refused = [
  "Make a fortune with bread",
  "Starter pricing guide",
  "Bread at a fair price",
  "Low-cost sourdough kit",
  "Priced right sourdough pack",
  "Cut your bakery costs",
  "No fees bread club",
  "Fortunes from your starter",
  "Precios del pan de masa madre",
  "Guía de precios para panaderos",
  "Guia de preços para padeiros",
  "Le prix du pain",
  "Preise für Sauerteigbrot",
  "Prezzi del pane",
  "Prijzen voor brood",
  "Una fortuna con el pan",
  "Ein Vermögen mit Brot",
];
is("each is left out", refused.map(shown), refused.map(() => 0));

part("Honest product names that only look close are still shown");
const fine = ["Costume baking party", "Precise starter feeding plan", "Prized family recipes", "Sourdough starter guide", "Feeding chart for your starter"];
is("each is shown", fine.map(shown), fine.map(() => 1));

done();
