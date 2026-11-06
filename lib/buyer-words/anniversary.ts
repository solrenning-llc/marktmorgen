/**
 * The words of the email on the anniversary of a purchase (lib/anniversary-rules.ts),
 * in each language a store can speak. The date arrives already written in the
 * store's language. No urgency, scarcity, countdown or discount: it says when
 * they bought, what, and where the store is now.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type AnniversaryWords = {
  subject: (title: string) => string;
  lead: (title: string, store: string, on: string) => string;
  visit: string;
  reply: (store: string) => string;
};

const en: AnniversaryWords = {
  subject: (title) => `A year since you bought ${title}`,
  lead: (title, store, on) => `A year ago, on ${on}, you bought ${title} from ${store}. Thank you for being here.`,
  visit: "See what is in the store now:",
  reply: (store) => `Reply to this email and it reaches ${store}.`,
};

const es: AnniversaryWords = {
  subject: (title) => `Un año desde que compraste ${title}`,
  lead: (title, store, on) => `Hace un año, el ${on}, compraste ${title} en ${store}. Gracias por estar aquí.`,
  visit: "Mira lo que hay ahora en la tienda:",
  reply: (store) => `Responde a este correo y le llegará a ${store}.`,
};

const fr: AnniversaryWords = {
  subject: (title) => `Un an depuis votre achat de ${title}`,
  lead: (title, store, on) => `Il y a un an, le ${on}, vous avez acheté ${title} chez ${store}. Merci d’être là.`,
  visit: "Voici ce que la boutique propose aujourd’hui :",
  reply: (store) => `Répondez à cet e-mail et ${store} le recevra.`,
};

const de: AnniversaryWords = {
  subject: (title) => `Ein Jahr seit Ihrem Kauf von ${title}`,
  lead: (title, store, on) => `Vor einem Jahr, am ${on}, haben Sie ${title} bei ${store} gekauft. Danke, dass Sie dabei sind.`,
  visit: "Das gibt es jetzt im Shop:",
  reply: (store) => `Antworten Sie auf diese E-Mail, und sie erreicht ${store}.`,
};

const it: AnniversaryWords = {
  subject: (title) => `Un anno dal tuo acquisto di ${title}`,
  lead: (title, store, on) => `Un anno fa, il ${on}, hai acquistato ${title} da ${store}. Grazie di esserci.`,
  visit: "Ecco cosa c’è ora nel negozio:",
  reply: (store) => `Rispondi a questa email e arriverà a ${store}.`,
};

const nl: AnniversaryWords = {
  subject: (title) => `Een jaar sinds je ${title} kocht`,
  lead: (title, store, on) => `Een jaar geleden, op ${on}, kocht je ${title} bij ${store}. Bedankt dat je erbij bent.`,
  visit: "Dit is er nu in de winkel:",
  reply: (store) => `Beantwoord deze e-mail en hij komt bij ${store} aan.`,
};

const pt: AnniversaryWords = {
  subject: (title) => `Um ano desde que comprou ${title}`,
  lead: (title, store, on) => `Há um ano, a ${on}, comprou ${title} na loja ${store}. Obrigado por estar connosco.`,
  visit: "Veja o que há agora na loja:",
  reply: (store) => `Responda a este e-mail e a mensagem chega a ${store}.`,
};

export const ANNIVERSARY_WORDS: Record<LanguageCode, AnniversaryWords> = { en, es, fr, de, it, nl, pt };

export function anniversaryWords(language: unknown): AnniversaryWords {
  return ANNIVERSARY_WORDS[parseLanguage(language)];
}
