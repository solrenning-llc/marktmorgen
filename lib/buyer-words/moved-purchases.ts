/**
 * The one email a past buyer gets when a creator brings their buyers over
 * from another platform and ticks "Email each buyer once" (lib/imports.ts
 * movedEmail), in the store's language (lib/store-language.ts).
 *
 * Every language says all English says, nothing added and nothing softened.
 * `orders` is the store's orders page, `email` the buyer's address.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

/** A non-breaking space, before French : ? ! ; */
const S = " ";

const en = {
  subjectOne: (title: string, store: string) => `${title} has moved to ${store}`,
  subjectMany: (store: string) => `What you bought from ${store} has moved`,
  moved: (store: string) =>
    `${store} has moved to a new store, and what you bought before comes with you. Nothing was charged, and you do not need to buy it again.`,
  yours: "Yours there:",
  courseLine: (title: string, url: string) => `- ${title}: ${url}`,
  openOne: (orders: string, email: string) =>
    `To open it, go to ${orders} and type ${email}. A link to everything you have there arrives within a minute. There is no password to make.`,
  openMany: (orders: string, email: string) =>
    `To open any of it, go to ${orders} and type ${email}. A link to everything you have there arrives within a minute. There is no password to make.`,
  why: (store: string) => `You are getting this one email because ${store} moved your purchases. Nothing more is sent because of it.`,
  sentBy: (store: string) => `Sent by Marktmorgen on behalf of ${store}.`,
};

export type MovedPurchaseWords = typeof en;

const es: MovedPurchaseWords = {
  subjectOne: (title, store) => `${title} se ha trasladado a ${store}`,
  subjectMany: (store) => `Lo que compraste a ${store} se ha trasladado`,
  moved: (store) => `${store} se ha trasladado a una tienda nueva, y lo que compraste antes viene contigo. No se cobró nada y no tienes que volver a comprarlo.`,
  yours: "Lo que tienes allí:",
  courseLine: (title, url) => `- ${title}: ${url}`,
  openOne: (orders, email) =>
    `Para abrirlo, ve a ${orders} y escribe ${email}. En menos de un minuto llega un enlace a todo lo que tienes allí. No hay contraseña que crear.`,
  openMany: (orders, email) =>
    `Para abrir cualquiera de ellos, ve a ${orders} y escribe ${email}. En menos de un minuto llega un enlace a todo lo que tienes allí. No hay contraseña que crear.`,
  why: (store) => `Recibes este único email porque ${store} trasladó tus compras. No se envía nada más por este motivo.`,
  sentBy: (store) => `Enviado por Marktmorgen en nombre de ${store}.`,
};

const fr: MovedPurchaseWords = {
  subjectOne: (title, store) => `${title} est maintenant chez ${store}`,
  subjectMany: (store) => `Vos achats chez ${store} ont été transférés`,
  moved: (store) =>
    `${store} a déménagé dans une nouvelle boutique, et ce que vous avez acheté auparavant vous suit. Rien n'a été débité, et vous n'avez pas besoin de l'acheter à nouveau.`,
  yours: `Ce qui vous appartient là-bas${S}:`,
  courseLine: (title, url) => `- ${title}${S}: ${url}`,
  openOne: (orders, email) =>
    `Pour l'ouvrir, rendez-vous sur ${orders} et saisissez ${email}. Un lien vers tout ce que vous avez là-bas arrive en moins d'une minute. Aucun mot de passe à créer.`,
  openMany: (orders, email) =>
    `Pour ouvrir l'un d'eux, rendez-vous sur ${orders} et saisissez ${email}. Un lien vers tout ce que vous avez là-bas arrive en moins d'une minute. Aucun mot de passe à créer.`,
  why: (store) => `Vous recevez ce seul e-mail parce que ${store} a transféré vos achats. Rien d'autre n'est envoyé pour cette raison.`,
  sentBy: (store) => `Envoyé par Marktmorgen pour le compte de ${store}.`,
};

const de: MovedPurchaseWords = {
  subjectOne: (title, store) => `${title} ist zu ${store} umgezogen`,
  subjectMany: (store) => `Was Sie bei ${store} gekauft haben, ist umgezogen`,
  moved: (store) =>
    `${store} ist in einen neuen Shop umgezogen, und was Sie zuvor gekauft haben, kommt mit. Es wurde nichts berechnet, und Sie müssen es nicht noch einmal kaufen.`,
  yours: "Was Ihnen dort gehört:",
  courseLine: (title, url) => `- ${title}: ${url}`,
  openOne: (orders, email) =>
    `Um es zu öffnen, gehen Sie zu ${orders} und geben Sie ${email} ein. Innerhalb einer Minute kommt ein Link zu allem, was Sie dort haben. Sie müssen kein Passwort anlegen.`,
  openMany: (orders, email) =>
    `Um etwas davon zu öffnen, gehen Sie zu ${orders} und geben Sie ${email} ein. Innerhalb einer Minute kommt ein Link zu allem, was Sie dort haben. Sie müssen kein Passwort anlegen.`,
  why: (store) => `Sie erhalten diese eine E-Mail, weil ${store} Ihre Käufe übertragen hat. Deswegen wird sonst nichts gesendet.`,
  sentBy: (store) => `Gesendet von Marktmorgen im Auftrag von ${store}.`,
};

const it: MovedPurchaseWords = {
  subjectOne: (title, store) => `${title} ora si trova da ${store}`,
  subjectMany: (store) => `I tuoi acquisti da ${store} sono stati trasferiti`,
  moved: (store) =>
    `${store} ha traslocato in un nuovo negozio, e ciò che hai acquistato in precedenza viene con te. Non è stato addebitato nulla e non devi acquistarlo di nuovo.`,
  yours: "Quello che hai lì:",
  courseLine: (title, url) => `- ${title}: ${url}`,
  openOne: (orders, email) =>
    `Per aprirlo, vai su ${orders} e scrivi ${email}. Entro un minuto arriva un link a tutto ciò che hai lì. Non c'è nessuna password da creare.`,
  openMany: (orders, email) =>
    `Per aprirne uno qualsiasi, vai su ${orders} e scrivi ${email}. Entro un minuto arriva un link a tutto ciò che hai lì. Non c'è nessuna password da creare.`,
  why: (store) => `Ricevi questa sola email perché ${store} ha trasferito i tuoi acquisti. Non viene inviato nient'altro per questo motivo.`,
  sentBy: (store) => `Inviato da Marktmorgen per conto di ${store}.`,
};

const nl: MovedPurchaseWords = {
  subjectOne: (title, store) => `${title} is verhuisd naar ${store}`,
  subjectMany: (store) => `Wat je bij ${store} hebt gekocht, is verhuisd`,
  moved: (store) =>
    `${store} is verhuisd naar een nieuwe winkel, en wat je eerder hebt gekocht, gaat met je mee. Er is niets afgeschreven en je hoeft het niet opnieuw te kopen.`,
  yours: "Wat je daar hebt:",
  courseLine: (title, url) => `- ${title}: ${url}`,
  openOne: (orders, email) =>
    `Om het te openen: ga naar ${orders} en typ ${email}. Binnen een minuut komt er een link naar alles wat je daar hebt. Je hoeft geen wachtwoord te maken.`,
  openMany: (orders, email) =>
    `Om er iets van te openen: ga naar ${orders} en typ ${email}. Binnen een minuut komt er een link naar alles wat je daar hebt. Je hoeft geen wachtwoord te maken.`,
  why: (store) => `Je krijgt deze ene e-mail omdat ${store} je aankopen heeft overgezet. Daarom wordt er verder niets gestuurd.`,
  sentBy: (store) => `Verstuurd door Marktmorgen namens ${store}.`,
};

const pt: MovedPurchaseWords = {
  subjectOne: (title, store) => `${title} passou para ${store}`,
  subjectMany: (store) => `As suas compras de ${store} foram transferidas`,
  moved: (store) =>
    `${store} mudou-se para uma nova loja, e o que comprou antes vem consigo. Não foi cobrado nada e não precisa de o comprar outra vez.`,
  yours: "O que tem lá:",
  courseLine: (title, url) => `- ${title}: ${url}`,
  openOne: (orders, email) =>
    `Para o abrir, aceda a ${orders} e escreva ${email}. Em menos de um minuto chega uma ligação para tudo o que tem lá. Não há palavra-passe para criar.`,
  openMany: (orders, email) =>
    `Para abrir qualquer um deles, aceda a ${orders} e escreva ${email}. Em menos de um minuto chega uma ligação para tudo o que tem lá. Não há palavra-passe para criar.`,
  why: (store) => `Recebe este único email porque ${store} transferiu as suas compras. Não é enviado mais nada por esse motivo.`,
  sentBy: (store) => `Enviado pela Marktmorgen em nome de ${store}.`,
};

export const MOVED_PURCHASE_WORDS: Record<LanguageCode, MovedPurchaseWords> = { en, es, fr, de, it, nl, pt };

export function movedPurchaseWords(language: unknown): MovedPurchaseWords {
  return MOVED_PURCHASE_WORDS[parseLanguage(language)];
}
