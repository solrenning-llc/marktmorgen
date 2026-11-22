/**
 * Review of #4535 (Claude 1 cloud R, MEDIUM): searchWords deletes an apostrophe inside a word, so an elided article or
 * preposition (French l'/d'/qu', Italian dell'/l', English rock'n'roll) is glued to the next word. The word after the
 * apostrophe must still be found on its own, as on main. Pure; no store is read.
 */
import { matchesSearch } from "@/lib/catalog";
import { done, is, part } from "./check";

async function main(): Promise<void> {
  part("A word after an elided apostrophe is still found by itself");
  is("French, Italian and English elisions", [
    matchesSearch({ title: "L'Atelier du pain", summary: "" }, "atelier"),
    matchesSearch({ title: "Cours d’aquarelle", summary: "" }, "aquarelle"),
    matchesSearch({ title: "Corso dell'arte", summary: "" }, "arte"),
    matchesSearch({ title: "Rock'n'roll guitar", summary: "" }, "roll"),
  ], [true, true, true, true]);
  part("Control: what the PR added still holds");
  is("typed without the apostrophe", matchesSearch({ title: "Beginner’s Guide", summary: "" }, "beginners"), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
