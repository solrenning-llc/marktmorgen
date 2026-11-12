import { thanksWords } from "@/lib/buyer-words/thanks";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const ADDRESS = "buyer@example.test";
const CONDITIONAL: Record<LanguageCode, RegExp> = {
  en: /\b(if|may|might|can)\b/i,
  es: /\b(si|puede|podría)\b/i,
  fr: /\b(si|peut|pourrait)\b/i,
  de: /\b(falls|wenn|kann|könnte)\b/i,
  it: /\b(se|può|potrebbe)\b/i,
  nl: /\b(als|kan|mogelijk)\b/i,
  pt: /\b(se|pode|poderá)\b/i,
};

part("The group page does not promise email arrival without delivery evidence");
for (const code of LANGUAGE_CODES) {
  const words = thanksWords(code);
  const receipt = words.groupReceipt(ADDRESS);
  is(`${code}: keeps the receipt address`, receipt.includes(ADDRESS), true);
  is(`${code}: makes receipt arrival conditional`, CONDITIONAL[code].test(receipt), true);
  is(`${code}: keeps the missing-link explanation`, words.noGroupLink.length > 20, true);
  is(`${code}: makes missing-link email arrival conditional`, CONDITIONAL[code].test(words.noGroupLink), true);
}
done();
