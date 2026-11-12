/**
 * A mixed-alphabet urgency word is read through variation selectors too
 * (lib/ad-creative-check.ts mixedScriptWord, Codex G on #2581): U+FE0E,
 * U+FE0F and U+E0100 between the letters never hide "Lаst chance" with a
 * Cyrillic а. Emoji with their own selector and text in one alphabet still
 * pass. Codex G's tests/g-2581-variation-selector.proof.ts, ported to a test
 * the suite runs, with the same assertions. Synthetic only.
 */
import { type AdContext, checkAdText } from "@/lib/ad-creative-check";
import { done, is, part } from "./check";

const context: AdContext = { priceCents: 4900, currency: "usd", ownHosts: ["marktmorgen.com"], realDeadline: false, realStockLimit: false, verifiedReviews: [] };
const check = (headline: string) => checkAdText({ headline, text: "", description: "", button: "" }, context);

part("A variation selector never disguises a mixed-alphabet urgency word");
for (const selector of ["︎", "️", "\u{E0100}"]) {
  const headline = `L${selector}а${selector}st chance`;
  is(`variation selector U+${selector.codePointAt(0)!.toString(16).toUpperCase()} cannot disguise mixed-script urgency`, check(headline).sendable, false);
}

part("Controls");
is("ordinary urgency refused", check("Last chance").sendable, false);
is("legitimate emoji selector preserved", check("Love ❤️ baking course").sendable, true);
is("legitimate Cyrillic text preserved", check("Хлеб дома").sendable, true);
done();
