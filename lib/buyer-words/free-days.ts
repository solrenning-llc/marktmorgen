/**
 * The email a member gets when the creator gives them free days on their
 * membership (641 [WG1], lib/member-free-days.ts), in each language a store
 * can speak. Dates arrive already written in the store's language
 * (lib/buyer-words/index.ts, speech); a sentence here only places them.
 *
 * Plain and honest: what changed, the date that was due and the date due now,
 * and that nothing else changes. No urgency, no figure, no offer.
 *
 * Browser-safe: plain data, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type FreeDaysWords = {
  /** The subject line, with the store's name. */
  subject: (store: string) => string;
  /** "1 free day", "14 free days". */
  days: (n: number) => string;
  /** The body: who gave them, on what, and the two dates. */
  body: (store: string, title: string, days: string, from: string, to: string) => string;
  /** The line before the link to the member's own page. */
  manage: string;
};

const en: FreeDaysWords = {
  subject: (store) => `${store} gave you free days on your membership`,
  days: (n) => (n === 1 ? "1 free day" : `${n} free days`),
  body: (store, title, days, from, to) =>
    `${store} has given you ${days} on your ${title} membership.\n\nYour next payment was due on ${from}. It is now due on ${to}. Nothing is charged before then, and everything your membership includes stays open to you.\n\nNothing else changes: the same price, the same card.`,
  manage: "To see your membership, change your card or cancel, open it here:",
};

const es: FreeDaysWords = {
  subject: (store) => `${store} te ha dado días gratis en tu membresía`,
  days: (n) => (n === 1 ? "1 día gratis" : `${n} días gratis`),
  body: (store, title, days, from, to) =>
    `${store} te ha dado ${days} en tu membresía ${title}.\n\nTu próximo pago vencía el ${from}. Ahora vence el ${to}. No se cobra nada antes, y todo lo que incluye tu membresía sigue abierto para ti.\n\nNada más cambia: el mismo precio y la misma tarjeta.`,
  manage: "Para ver tu membresía, cambiar tu tarjeta o cancelarla, ábrela aquí:",
};

const fr: FreeDaysWords = {
  subject: (store) => `${store} vous offre des jours gratuits sur votre abonnement`,
  days: (n) => (n === 1 ? "1 jour gratuit" : `${n} jours gratuits`),
  body: (store, title, days, from, to) =>
    `${store} vous offre ${days} sur votre abonnement ${title}.\n\nVotre prochain paiement était prévu le ${from}. Il est maintenant prévu le ${to}. Rien n’est prélevé d’ici là, et tout ce que comprend votre abonnement vous reste ouvert.\n\nRien d’autre ne change : le même prix, la même carte.`,
  manage: "Pour voir votre abonnement, changer de carte ou le résilier, ouvrez-le ici :",
};

const de: FreeDaysWords = {
  subject: (store) => `${store} schenkt dir freie Tage für deine Mitgliedschaft`,
  days: (n) => (n === 1 ? "1 freien Tag" : `${n} freie Tage`),
  body: (store, title, days, from, to) =>
    `${store} schenkt dir ${days} für deine Mitgliedschaft ${title}.\n\nDeine nächste Zahlung war am ${from} fällig. Jetzt ist sie am ${to} fällig. Bis dahin wird nichts abgebucht, und alles, was deine Mitgliedschaft umfasst, bleibt für dich offen.\n\nSonst ändert sich nichts: derselbe Preis, dieselbe Karte.`,
  manage: "Um deine Mitgliedschaft zu sehen, deine Karte zu ändern oder zu kündigen, öffne sie hier:",
};

const it: FreeDaysWords = {
  subject: (store) => `${store} ti ha regalato giorni gratuiti sulla tua iscrizione`,
  days: (n) => (n === 1 ? "1 giorno gratuito" : `${n} giorni gratuiti`),
  body: (store, title, days, from, to) =>
    `${store} ti ha regalato ${days} sulla tua iscrizione ${title}.\n\nIl tuo prossimo pagamento era previsto per il ${from}. Ora è previsto per il ${to}. Fino ad allora non viene addebitato nulla, e tutto ciò che la tua iscrizione comprende resta aperto per te.\n\nNient'altro cambia: lo stesso prezzo, la stessa carta.`,
  manage: "Per vedere la tua iscrizione, cambiare carta o annullarla, aprila qui:",
};

const nl: FreeDaysWords = {
  subject: (store) => `${store} heeft je gratis dagen op je lidmaatschap gegeven`,
  days: (n) => (n === 1 ? "1 gratis dag" : `${n} gratis dagen`),
  body: (store, title, days, from, to) =>
    `${store} heeft je ${days} gegeven op je lidmaatschap ${title}.\n\nJe volgende betaling stond gepland op ${from}. Die staat nu gepland op ${to}. Tot dan wordt er niets afgeschreven, en alles wat je lidmaatschap omvat blijft voor je open.\n\nVerder verandert er niets: dezelfde prijs, dezelfde kaart.`,
  manage: "Om je lidmaatschap te bekijken, je kaart te wijzigen of op te zeggen, open je het hier:",
};

const pt: FreeDaysWords = {
  subject: (store) => `${store} deu-lhe dias grátis na sua subscrição`,
  days: (n) => (n === 1 ? "1 dia grátis" : `${n} dias grátis`),
  body: (store, title, days, from, to) =>
    `${store} deu-lhe ${days} na sua subscrição ${title}.\n\nO seu próximo pagamento estava previsto para ${from}. Agora está previsto para ${to}. Nada é cobrado até lá, e tudo o que a sua subscrição inclui continua aberto para si.\n\nNada mais muda: o mesmo preço, o mesmo cartão.`,
  manage: "Para ver a sua subscrição, mudar o cartão ou cancelá-la, abra-a aqui:",
};

export const FREE_DAYS_WORDS: Record<LanguageCode, FreeDaysWords> = { en, es, fr, de, it, nl, pt };

/** A store's words for this email, in its language; English for anything else. */
export function freeDaysWords(language: unknown): FreeDaysWords {
  return FREE_DAYS_WORDS[parseLanguage(language)];
}
