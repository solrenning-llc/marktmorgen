import { GUIDE_WORDS, guideWords } from "@/lib/buyer-words/guide";
import { WHY_NOT_WORDS, whyNotWords } from "@/lib/buyer-words/why-not";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { done, is, part } from "./check";

part("French prompts keep their punctuation with the preceding phrase");
const prompts = [
  ["guide.title", guideWords("fr").title, "Vous ne savez pas lequel choisir\u00a0?"],
  ["guide.label", guideWords("fr").label, "Que cherchez-vous\u00a0?"],
  ["guide.placeholder", guideWords("fr").placeholder, "Par exemple\u00a0: dîners rapides en famille"],
  ["why-not.question", whyNotWords("fr").question, "Avant de partir\u00a0: quelque chose vous retient-il d’acheter\u00a0?"],
] as const;
for (const [key, actual, expected] of prompts) {
  is(`${key}: exact French phrase with nonbreaking punctuation`, actual, expected);
  is(`${key}: no breakable or missing space before punctuation`, /[^\u00a0\u202f][:?!;](?=\s|$)/.test(actual), false);
  is(`${key}: wording is unchanged`, actual.replace(/\u00a0/g, " "), expected.replace(/\u00a0/g, " "));
}
is("the guide retains all seven languages", Object.keys(GUIDE_WORDS).sort(), [...LANGUAGE_CODES].sort());
is("the exit question retains all seven languages", Object.keys(WHY_NOT_WORDS).sort(), [...LANGUAGE_CODES].sort());
is("the guide's unknown locale still uses English", guideWords("unknown"), GUIDE_WORDS.en);
is("the exit question's unknown locale still uses English", whyNotWords("unknown"), WHY_NOT_WORDS.en);
done();
