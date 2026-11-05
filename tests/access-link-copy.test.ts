import { ACCESS_WORDS, accessWords } from "@/lib/buyer-words/access";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const PASSWORD: Record<LanguageCode, string> = {
  en: "There is no password to make.",
  es: "No hay contraseña que crear.",
  fr: "Aucun mot de passe à créer.",
  de: "Sie müssen kein Passwort anlegen.",
  it: "Non c'è nessuna password da creare.",
  nl: "Je hoeft geen wachtwoord te maken.",
  pt: "Não há palavra-passe para criar.",
};

const EXPECTED: Record<LanguageCode, string> = {
  en: "To open it on any device, go to https://example.com/harbor/orders and enter buyer@example.com to request an email link to everything you have from Harbor Kitchen. There is no password to make.",
  es: "Para abrirlo en cualquier dispositivo, ve a https://example.com/harbor/orders y escribe buyer@example.com para pedir por email un enlace a todo lo que tienes de Harbor Kitchen. No hay contraseña que crear.",
  fr: "Pour l'ouvrir sur n'importe quel appareil, rendez-vous sur https://example.com/harbor/orders et saisissez buyer@example.com pour demander par e-mail un lien vers tout ce que vous avez chez Harbor Kitchen. Aucun mot de passe à créer.",
  de: "Um es auf einem beliebigen Gerät zu öffnen, gehen Sie zu https://example.com/harbor/orders und geben Sie buyer@example.com ein, um per E-Mail einen Link zu allem anzufordern, was Sie von Harbor Kitchen haben. Sie müssen kein Passwort anlegen.",
  it: "Per aprirlo su qualsiasi dispositivo, vai su https://example.com/harbor/orders e scrivi buyer@example.com per richiedere via email un link a tutto ciò che hai da Harbor Kitchen. Non c'è nessuna password da creare.",
  nl: "Om het op elk apparaat te openen: ga naar https://example.com/harbor/orders en typ buyer@example.com om per e-mail een link aan te vragen naar alles wat je van Harbor Kitchen hebt. Je hoeft geen wachtwoord te maken.",
  pt: "Para o abrir em qualquer dispositivo, aceda a https://example.com/harbor/orders e escreva buyer@example.com para pedir por email uma ligação para tudo o que tem de Harbor Kitchen. Não há palavra-passe para criar.",
};

part("Offered-product access: request a link without an inbox deadline");
is("all seven existing languages remain present", Object.keys(ACCESS_WORDS).sort(), [...LANGUAGE_CODES].sort());
for (const code of LANGUAGE_CODES) {
  const words = accessWords(code);
  const text = words.openOrders("https://example.com/harbor/orders", "buyer@example.com", "Harbor Kitchen");
  is(`${code}: keeps the buyer's address exactly once`, text.split("buyer@example.com").length - 1, 1);
  is(`${code}: renders the complete instruction exactly`, text, EXPECTED[code]);
  is(`${code}: keeps the store's name`, text.includes("Harbor Kitchen"), true);
  is(`${code}: preserves password-free access`, text.endsWith(PASSWORD[code]), true);
  is(`${code}: no minute-based delivery promise`, /minut|minute|minuut/i.test(text), false);
  is(`${code}: no unresolved interpolation`, /undefined|NaN|\$\{|\[object/.test(text), false);
}
is("unknown language still uses English", accessWords("xx"), ACCESS_WORDS.en);
done();
