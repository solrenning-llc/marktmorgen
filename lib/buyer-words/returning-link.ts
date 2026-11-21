/**
 * The email that confirms a code only for people who already bought from
 * this store (554 [DS1], unit 2; lib/returning-code.ts): sent only to an
 * address that bought here before, with a link that works once, for half an
 * hour, on the product it was asked from. In each language a store can speak.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type ReturningLinkWords = {
  from: (store: string) => string;
  subject: (store: string) => string;
  /** What the link does, with the code and the product. */
  intro: (store: string, code: string, product: string) => string;
  /** How long it works and how often. */
  note: string;
  /** For someone who did not ask. */
  ignore: string;
};

const en: ReturningLinkWords = {
  from: (store) => `${store} via Marktmorgen`,
  subject: (store) => `Your returning-buyer code at ${store}`,
  intro: (store, code, product) => `Someone asked to use the code ${code} for returning buyers on ${product}, from ${store}, with this email. Open this link to buy it with the code; the checkout opens with this email:`,
  note: "The link works once, for 30 minutes.",
  ignore: "If you did not ask for this, ignore this email; nothing happens unless the link is opened.",
};

const es: ReturningLinkWords = {
  from: (store) => `${store} vía Marktmorgen`,
  subject: (store) => `Tu código para clientes que vuelven en ${store}`,
  intro: (store, code, product) => `Alguien pidió usar el código ${code} para clientes que vuelven en ${product}, de ${store}, con este email. Abre este enlace para comprarlo con el código; el pago se abre con este email:`,
  note: "El enlace funciona una sola vez, durante 30 minutos.",
  ignore: "Si no lo pediste, ignora este email; no pasa nada a menos que se abra el enlace.",
};

const fr: ReturningLinkWords = {
  from: (store) => `${store} via Marktmorgen`,
  subject: (store) => `Votre code client fidèle chez ${store}`,
  intro: (store, code, product) => `Quelqu’un a demandé à utiliser le code ${code} réservé aux clients qui ont déjà acheté, sur ${product}, de ${store}, avec cet e-mail. Ouvrez ce lien pour l’acheter avec le code ; le paiement s’ouvre avec cet e-mail :`,
  note: "Le lien fonctionne une seule fois, pendant 30 minutes.",
  ignore: "Si vous n’avez rien demandé, ignorez cet e-mail ; rien ne se passe tant que le lien n’est pas ouvert.",
};

const de: ReturningLinkWords = {
  from: (store) => `${store} über Marktmorgen`,
  subject: (store) => `Dein Code für Stammkunden bei ${store}`,
  intro: (store, code, product) => `Jemand hat mit dieser E-Mail angefragt, den Code ${code} für Stammkunden bei ${product} von ${store} zu nutzen. Öffne diesen Link, um es mit dem Code zu kaufen; die Kasse öffnet sich mit dieser E-Mail:`,
  note: "Der Link funktioniert einmal, 30 Minuten lang.",
  ignore: "Wenn du das nicht angefragt hast, ignoriere diese E-Mail; es passiert nichts, solange der Link nicht geöffnet wird.",
};

const it: ReturningLinkWords = {
  from: (store) => `${store} tramite Marktmorgen`,
  subject: (store) => `Il tuo codice per chi ha già comprato da ${store}`,
  intro: (store, code, product) => `Qualcuno ha chiesto di usare il codice ${code} per chi ha già comprato su ${product}, di ${store}, con questa email. Apri questo link per comprarlo con il codice; il pagamento si apre con questa email:`,
  note: "Il link funziona una sola volta, per 30 minuti.",
  ignore: "Se non l’hai chiesto tu, ignora questa email; non succede nulla finché il link non viene aperto.",
};

const nl: ReturningLinkWords = {
  from: (store) => `${store} via Marktmorgen`,
  subject: (store) => `Je code voor terugkerende kopers bij ${store}`,
  intro: (store, code, product) => `Iemand vroeg met dit e-mailadres om de code ${code} voor terugkerende kopers te gebruiken op ${product}, van ${store}. Open deze link om het met de code te kopen; het afrekenen opent met dit e-mailadres:`,
  note: "De link werkt één keer, 30 minuten lang.",
  ignore: "Heb je hier niet om gevraagd, negeer deze e-mail dan; er gebeurt niets zolang de link niet wordt geopend.",
};

const pt: ReturningLinkWords = {
  from: (store) => `${store} via Marktmorgen`,
  subject: (store) => `O seu código para clientes que voltam em ${store}`,
  intro: (store, code, product) => `Alguém pediu para usar o código ${code} para quem já comprou em ${product}, de ${store}, com este email. Abra este link para o comprar com o código; o pagamento abre com este email:`,
  note: "O link funciona uma única vez, durante 30 minutos.",
  ignore: "Se não pediu isto, ignore este email; nada acontece a menos que o link seja aberto.",
};

export const RETURNING_LINK_WORDS: Record<LanguageCode, ReturningLinkWords> = { en, es, fr, de, it, nl, pt };

export function returningLinkWords(language: unknown): ReturningLinkWords {
  return RETURNING_LINK_WORDS[parseLanguage(language)];
}
