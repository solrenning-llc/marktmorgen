/**
 * Claude 2's focal return on #2579 (head 161273b6, LEVE): the turned a, the
 * turned alpha and the turned i have no "WITH" in their names and no Latin
 * target in confusables.txt, so "on sɐle" or "dᴉscount" were still shown.
 */
import { heldToFacts } from "@/lib/store-assistant-rules";
import { done, is, part } from "./check";

const facts = "Pottery course.";
part("Controls: the plain words are refused, honest text is shown");
is("on sale and discount in plain letters are refused", [heldToFacts("Now on sale.", facts), heldToFacts("A discount.", facts)], [false, false]);
is("a plain sentence about the course is shown", heldToFacts("A pottery course.", facts), true);
part("Turned a, turned alpha and turned i hide the word");
for (const [name, text] of [["U+0250 turned a", "Now on sɐle."], ["U+0252 turned alpha", "Now on sɒle."], ["U+1D09 turned i", "A dᴉscount."]] as const) {
  is(`${JSON.stringify(text)} (${name}) is refused like the plain word`, heldToFacts(text, facts), false);
}
done();
