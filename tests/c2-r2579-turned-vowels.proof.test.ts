/**
 * Proof for Claude 2's focal return on #2579 (rule 30, a class next to the
 * one the PR closes): Latin vowels that are turned, reversed or open have no
 * "WITH" in their names, are not in confusables.txt's Latin targets, and so
 * hide a deal word, on main as on the PR's head. Fails at 1036e8fd.
 */
import { heldToFacts } from "@/lib/store-assistant-rules";
import { done, is, part } from "./check";

const facts = "Pottery course.";
part("Controls: the plain words are refused, honest text is shown");
is("voucher, discount and coupon in plain letters are refused", [heldToFacts("A voucher.", facts), heldToFacts("A discount.", facts), heldToFacts("A coupon.", facts)], [false, false, false]);
is("the PR's own case stays refused (barred o)", heldToFacts("A discɵunt.", facts), false);
part("Turned, reversed and open vowels hide the word");
for (const [name, ch] of [["U+0258 reversed e", "ɘ"], ["U+0259 schwa", "ə"], ["U+01DD turned e", "ǝ"], ["U+025B open e", "ɛ"], ["U+018F capital schwa", "Ə"]] as const) {
  is(`"vouch${ch}r" (${name}) is refused like "voucher"`, heldToFacts(`A vouch${ch}r.`, facts), false);
}
is('"discɔunt" (U+0254 open o) is refused like "discount"', heldToFacts("A discɔunt.", facts), false);
done();
