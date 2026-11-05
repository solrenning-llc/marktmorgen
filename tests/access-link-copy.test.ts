import { ACCESS_WORDS, accessWords } from "@/lib/buyer-words/access";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

// These are instructions to request a link, not a promise about inbox delivery.
const REQUEST: Record<LanguageCode, string> = {
  en: "and enter buyer@example.com to request an email link",
  es: "y escribe buyer@example.com para pedir por email un enlace",
  fr: "et saisissez buyer@example.com pour demander par e-mail un lien",
  de: "und geben Sie buyer@example.com ein, um per E-Mail einen Link",
  it: "e scrivi buyer@example.com per richiedere via email un link",
  nl: "en typ buyer@example.com om per e-mail een link",
  pt: "e escreva buyer@example.com para pedir por email uma ligação",
};

const PASSWORD: Record<LanguageCode, string> = {
  en: "There is no password to make.",
  es: "No hay contraseña que crear.",
  fr: "Aucun mot de passe à créer.",
  de: "Sie müssen kein Passwort anlegen.",
  it: "Non c'è nessuna password da creare.",
  nl: "Je hoeft geen wachtwoord te maken.",
  pt: "Não há palavra-passe para criar.",
};

part("Offered-product access: request a link without an inbox deadline");
is("all seven existing languages remain present", Object.keys(ACCESS_WORDS).sort(), [...LANGUAGE_CODES].sort());
for (const code of LANGUAGE_CODES) {
  const words = accessWords(code);
  const text = words.openOrders("https://example.com/harbor/orders", "buyer@example.com", "Harbor Kitchen");
  is(`${code}: explains the request with the buyer's address`, text.includes(REQUEST[code]), true);
  is(`${code}: keeps the orders URL`, text.includes("https://example.com/harbor/orders"), true);
  is(`${code}: keeps the store's name`, text.includes("Harbor Kitchen"), true);
  is(`${code}: preserves password-free access`, text.endsWith(PASSWORD[code]), true);
  is(`${code}: no minute-based delivery promise`, /minut|minute|minuut/i.test(text), false);
  is(`${code}: no unresolved interpolation`, /undefined|NaN|\$\{|\[object/.test(text), false);
}
is("unknown language still uses English", accessWords("xx"), ACCESS_WORDS.en);
done();
