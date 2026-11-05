import { readFileSync } from "node:fs";
import { givingWords } from "@/lib/buyer-words/giving";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const DEADLINE: Record<LanguageCode, RegExp> = {
  en: /\b(?:second|minute|hour)s?\b/i,
  es: /\b(?:segundo|minuto|hora)s?\b/i,
  fr: /\b(?:seconde|minute|heure)s?\b/i,
  de: /\b(?:Sekunde|Minute|Stunde)n?\b/i,
  it: /\b(?:secondo|minuto|ora|ore)\b/i,
  nl: /\b(?:seconde|minuut|uur)\b/i,
  pt: /\b(?:segundo|minuto|hora)s?\b/i,
};

const page = readFileSync("app/[handle]/free/page.tsx", "utf8");

part("The accepted-request page uses the corrected status in every buyer language");
is(
  "the sent branch renders the shared store-and-spam status",
  /status === ["']sent["'][\s\S]*g\.comesFrom\(store\.name\)/.test(page),
  true,
);

for (const code of LANGUAGE_CODES) {
  const text = `${givingWords(code).emailedLink} ${givingWords(code).comesFrom("Harbor & Pine")}`;
  is(`${code}: preserves the actual store identity`, text.includes("Harbor & Pine"), true);
  is(`${code}: preserves the spam guidance`, /spam/i.test(text), true);
  is(`${code}: makes no inbox-arrival deadline`, DEADLINE[code].test(text), false);
}

done();
