/**
 * The words of an email telling buyers that something they bought was
 * updated (lib/product-updates.ts), and of the page that stops those emails,
 * in every language a store sells in.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const S = " ";

const en = {
  subject: (title: string) => `${title} has been updated`,
  lead: (title: string, store: string) => `There is a new version of ${title}, which you bought from ${store}.`,
  here: "Get the latest version from your orders, with the address you paid with:",
  why: (title: string, store: string) => `You are getting this because you bought ${title} from ${store}.`,
  stopLabel: "Stop update emails",
  stopAfter: (store: string) => `from ${store}. Open the link, then confirm on the page.`,
  stopLine: (page: string) => `Stop update emails: ${page}`,
  // The page the link opens.
  ask: (who: string) => `Stop update emails from ${who || "this store"}?`,
  forEmail: (email: string) => `For ${email}. One press stops them for good. What you bought stays yours.`,
  doneTitle: "No more update emails",
  done: (email: string, who: string) => `${email} will not get update emails from ${who || "this store"} again. What you bought stays yours.`,
  button: "Stop update emails",
};

export type UpdatesWords = typeof en;

const es: UpdatesWords = {
  subject: (title) => `${title} se ha actualizado`,
  lead: (title, store) => `Hay una nueva versión de ${title}, que compraste en ${store}.`,
  here: "Consigue la última versión en tus pedidos, con el correo con el que pagaste:",
  why: (title, store) => `Te llega porque compraste ${title} en ${store}.`,
  stopLabel: "Dejar de recibir avisos de actualización",
  stopAfter: (store) => `de ${store}. Abre el enlace y confirma en la página.`,
  stopLine: (page) => `Dejar de recibir avisos de actualización: ${page}`,
  ask: (who) => `¿Dejar de recibir avisos de actualización de ${who || "esta tienda"}?`,
  forEmail: (email) => `Para ${email}. Un clic los detiene para siempre. Lo que compraste sigue siendo tuyo.`,
  doneTitle: "No más avisos de actualización",
  done: (email, who) => `${email} no volverá a recibir avisos de actualización de ${who || "esta tienda"}. Lo que compraste sigue siendo tuyo.`,
  button: "Dejar de recibir avisos",
};

const fr: UpdatesWords = {
  subject: (title) => `${title} a été mis à jour`,
  lead: (title, store) => `Une nouvelle version de ${title}, que vous avez acheté chez ${store}, est disponible.`,
  here: `Obtenez la dernière version depuis vos commandes, avec l'adresse utilisée pour payer${S}:`,
  why: (title, store) => `Vous recevez ce message parce que vous avez acheté ${title} chez ${store}.`,
  stopLabel: "Ne plus recevoir les avis de mise à jour",
  stopAfter: (store) => `de ${store}. Ouvrez le lien, puis confirmez sur la page.`,
  stopLine: (page) => `Ne plus recevoir les avis de mise à jour${S}: ${page}`,
  ask: (who) => `Ne plus recevoir les avis de mise à jour de ${who || "cette boutique"}${S}?`,
  forEmail: (email) => `Pour ${email}. Un clic les arrête pour de bon. Ce que vous avez acheté reste à vous.`,
  doneTitle: "Plus d'avis de mise à jour",
  done: (email, who) => `${email} ne recevra plus d'avis de mise à jour de ${who || "cette boutique"}. Ce que vous avez acheté reste à vous.`,
  button: "Ne plus recevoir ces avis",
};

const de: UpdatesWords = {
  subject: (title) => `${title} wurde aktualisiert`,
  lead: (title, store) => `Es gibt eine neue Version von ${title}, das Sie bei ${store} gekauft haben.`,
  here: "Die neueste Version finden Sie in Ihren Bestellungen, mit der Adresse, mit der Sie bezahlt haben:",
  why: (title, store) => `Sie erhalten diese E-Mail, weil Sie ${title} bei ${store} gekauft haben.`,
  stopLabel: "Keine Update-E-Mails mehr",
  stopAfter: (store) => `von ${store}. Öffnen Sie den Link und bestätigen Sie auf der Seite.`,
  stopLine: (page) => `Keine Update-E-Mails mehr: ${page}`,
  ask: (who) => `Keine Update-E-Mails mehr von ${who || "diesem Shop"}?`,
  forEmail: (email) => `Für ${email}. Ein Klick beendet sie dauerhaft. Was Sie gekauft haben, gehört weiter Ihnen.`,
  doneTitle: "Keine Update-E-Mails mehr",
  done: (email, who) => `${email} erhält keine Update-E-Mails mehr von ${who || "diesem Shop"}. Was Sie gekauft haben, gehört weiter Ihnen.`,
  button: "Keine Update-E-Mails mehr",
};

const it: UpdatesWords = {
  subject: (title) => `${title} è stato aggiornato`,
  lead: (title, store) => `C'è una nuova versione di ${title}, che hai acquistato da ${store}.`,
  here: "Scarica l'ultima versione dai tuoi ordini, con l'indirizzo con cui hai pagato:",
  why: (title, store) => `Ricevi questa email perché hai acquistato ${title} da ${store}.`,
  stopLabel: "Non ricevere più avvisi di aggiornamento",
  stopAfter: (store) => `da ${store}. Apri il link e conferma nella pagina.`,
  stopLine: (page) => `Non ricevere più avvisi di aggiornamento: ${page}`,
  ask: (who) => `Non ricevere più avvisi di aggiornamento da ${who || "questo negozio"}?`,
  forEmail: (email) => `Per ${email}. Un clic li ferma per sempre. Ciò che hai acquistato resta tuo.`,
  doneTitle: "Niente più avvisi di aggiornamento",
  done: (email, who) => `${email} non riceverà più avvisi di aggiornamento da ${who || "questo negozio"}. Ciò che hai acquistato resta tuo.`,
  button: "Non ricevere più avvisi",
};

const nl: UpdatesWords = {
  subject: (title) => `${title} is bijgewerkt`,
  lead: (title, store) => `Er is een nieuwe versie van ${title}, dat je bij ${store} hebt gekocht.`,
  here: "Haal de nieuwste versie op bij je bestellingen, met het adres waarmee je betaalde:",
  why: (title, store) => `Je krijgt dit omdat je ${title} bij ${store} hebt gekocht.`,
  stopLabel: "Geen updatemails meer",
  stopAfter: (store) => `van ${store}. Open de link en bevestig op de pagina.`,
  stopLine: (page) => `Geen updatemails meer: ${page}`,
  ask: (who) => `Geen updatemails meer van ${who || "deze winkel"}?`,
  forEmail: (email) => `Voor ${email}. Eén klik stopt ze voorgoed. Wat je hebt gekocht, blijft van jou.`,
  doneTitle: "Geen updatemails meer",
  done: (email, who) => `${email} krijgt geen updatemails meer van ${who || "deze winkel"}. Wat je hebt gekocht, blijft van jou.`,
  button: "Geen updatemails meer",
};

const pt: UpdatesWords = {
  subject: (title) => `${title} foi atualizado`,
  lead: (title, store) => `Há uma nova versão de ${title}, que comprou a ${store}.`,
  here: "Obtenha a versão mais recente nas suas encomendas, com o endereço com que pagou:",
  why: (title, store) => `Recebe esta mensagem porque comprou ${title} a ${store}.`,
  stopLabel: "Deixar de receber avisos de atualização",
  stopAfter: (store) => `de ${store}. Abra a ligação e confirme na página.`,
  stopLine: (page) => `Deixar de receber avisos de atualização: ${page}`,
  ask: (who) => `Deixar de receber avisos de atualização de ${who || "esta loja"}?`,
  forEmail: (email) => `Para ${email}. Um clique para-os de vez. O que comprou continua a ser seu.`,
  doneTitle: "Sem mais avisos de atualização",
  done: (email, who) => `${email} não voltará a receber avisos de atualização de ${who || "esta loja"}. O que comprou continua a ser seu.`,
  button: "Deixar de receber avisos",
};

export const UPDATES_WORDS: Record<LanguageCode, UpdatesWords> = { en, es, fr, de, it, nl, pt };

export function updatesWords(language: unknown): UpdatesWords {
  return UPDATES_WORDS[parseLanguage(language)];
}
