import { readFileSync } from "node:fs";
import { ordersWords } from "@/lib/buyer-words/orders";
import { LANGUAGE_CODES, type LanguageCode } from "@/lib/store-language";
import { done, is, part } from "./check";

const EXPECTED: Record<LanguageCode, string> = {
  en: "If that address bought something from Harbor Kitchen, we try to email a link to all of it. Any link sent works for 24 hours. We say the same thing whether or not it did, so nobody can use this page to find out who bought what.",
  es: "Si esa dirección le compró algo a Harbor Kitchen, intentamos enviarle por email un enlace a todo ello. Cualquier enlace enviado funciona durante 24 horas. Decimos lo mismo tanto si compró como si no, para que nadie pueda usar esta página para averiguar quién compró qué.",
  fr: "Si cette adresse a acheté quelque chose chez Harbor Kitchen, nous essayons de lui envoyer par e-mail un lien vers tous ses achats. Tout lien envoyé reste valable 24 heures. Nous affichons le même message dans tous les cas, pour que personne ne puisse se servir de cette page pour savoir qui a acheté quoi.",
  de: "Wenn mit dieser Adresse etwas bei Harbor Kitchen gekauft wurde, versuchen wir, per E-Mail einen Link zu allem zu senden. Jeder gesendete Link gilt 24 Stunden. Wir sagen dasselbe, ob das der Fall ist oder nicht, damit niemand über diese Seite herausfinden kann, wer was gekauft hat.",
  it: "Se quell'indirizzo ha acquistato qualcosa da Harbor Kitchen, proviamo a inviare via email un link a tutto. Ogni link inviato è valido per 24 ore. Diciamo la stessa cosa in ogni caso, così nessuno può usare questa pagina per scoprire chi ha comprato cosa.",
  nl: "Als met dat adres iets is gekocht bij Harbor Kitchen, proberen we per e-mail een link naar alles te sturen. Elke verstuurde link werkt 24 uur. We zeggen hetzelfde, of dat nu zo is of niet, zodat niemand via deze pagina kan uitzoeken wie wat heeft gekocht.",
  pt: "Se esse endereço comprou algo a Harbor Kitchen, tentamos enviar-lhe por email uma ligação para tudo. Qualquer ligação enviada funciona durante 24 horas. Dizemos o mesmo quer tenha comprado quer não, para que ninguém possa usar esta página para descobrir quem comprou o quê.",
};

part("An orders-link request does not promise inbox delivery time");
is("all seven buyer languages remain present", LANGUAGE_CODES.length, 7);
for (const code of LANGUAGE_CODES) {
  const text = ordersWords(code).formNote("Harbor Kitchen");
  is(`${code}: renders the complete request note`, text, EXPECTED[code]);
  is(`${code}: keeps the store and link lifetime`, [text.includes("Harbor Kitchen"), /24/.test(text)], [true, true]);
  is(`${code}: keeps the enumeration-safe explanation`, /nobody|nadie|personne|niemand|nessuno|ninguém/i.test(text), true);
  is(`${code}: has no inbox deadline`, /minut|minuut/i.test(text), false);
  is(`${code}: has no unresolved interpolation`, /undefined|NaN|\$\{|\[object/.test(text), false);
}

const source = readFileSync("lib/buyer-orders.ts", "utf8");
is("the route answers before the deferred purchase read and send", source.includes('afterAnswer(() => sendLink(store, raw, email, origin));\n  return "sent";'), true);
is("sender refusal is only logged after that answer", source.includes('if (!sent) console.error("a purchases link could not be emailed")'), true);
done();
