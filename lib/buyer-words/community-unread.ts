/**
 * What the community says when who asked for announcement emails could not be
 * read (lib/community.ts memberPage, rule 24), in each language a store can
 * speak: the owner's composer turns its email box off and says why, and a post
 * sent while the list did not read is said as up without its email, never as
 * "nothing was changed" and never as sent to part of the members.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type CommunityUnreadWords = {
  /** The composer's email box, off because the count could not be read. */
  reachUnknown: string;
  /** After posting: the post is up, and the email was not sent, because the list could not be read. */
  notEmailed: string;
};

/** A non-breaking space, before the signs French spaces from the word before them. */
const S = " ";

const en: CommunityUnreadWords = {
  reachUnknown: "We couldn't read who asked for announcement emails just now, so this post can't be emailed. Reload the page to try again.",
  notEmailed: "Posted. It was not emailed: who asked for announcement emails could not be read just now, so nothing was sent.",
};

const es: CommunityUnreadWords = {
  reachUnknown:
    "Ahora mismo no pudimos leer quién pidió los anuncios por email, así que esta publicación no se puede enviar por email. Recarga la página para intentarlo de nuevo.",
  notEmailed: "Publicado. No se envió por email: ahora mismo no pudimos leer quién pidió los anuncios por email, así que no se envió nada.",
};

const fr: CommunityUnreadWords = {
  reachUnknown:
    "Nous n'avons pas pu lire pour l'instant qui a demandé les annonces par e-mail, donc cette publication ne peut pas être envoyée par e-mail. Rechargez la page pour réessayer.",
  notEmailed: `Publié. Il n'a pas été envoyé par e-mail${S}: nous n'avons pas pu lire pour l'instant qui a demandé les annonces par e-mail, donc rien n'a été envoyé.`,
};

const de: CommunityUnreadWords = {
  reachUnknown:
    "Wir konnten gerade nicht lesen, wer Ankündigungen per E-Mail möchte, daher kann dieser Beitrag nicht per E-Mail versendet werden. Laden Sie die Seite neu, um es erneut zu versuchen.",
  notEmailed:
    "Veröffentlicht. Es wurde nicht per E-Mail versendet: Wer Ankündigungen per E-Mail möchte, konnte gerade nicht gelesen werden, daher wurde nichts versendet.",
};

const it: CommunityUnreadWords = {
  reachUnknown:
    "Al momento non siamo riusciti a leggere chi ha chiesto gli annunci via email, quindi questo post non può essere inviato via email. Ricarica la pagina per riprovare.",
  notEmailed:
    "Pubblicato. Non è stato inviato via email: al momento non siamo riusciti a leggere chi ha chiesto gli annunci via email, quindi non è stato inviato nulla.",
};

const nl: CommunityUnreadWords = {
  reachUnknown:
    "We konden nu niet lezen wie om aankondigingen per e-mail heeft gevraagd, dus dit bericht kan niet per e-mail worden verstuurd. Laad de pagina opnieuw om het nog eens te proberen.",
  notEmailed: "Geplaatst. Het is niet gemaild: we konden nu niet lezen wie om aankondigingen per e-mail heeft gevraagd, dus er is niets verstuurd.",
};

const pt: CommunityUnreadWords = {
  reachUnknown:
    "Agora não foi possível ler quem pediu os anúncios por email, por isso esta publicação não pode ser enviada por email. Recarregue a página para tentar de novo.",
  notEmailed: "Publicado. Não foi enviado por email: agora não foi possível ler quem pediu os anúncios por email, por isso não foi enviado nada.",
};

export const COMMUNITY_UNREAD_WORDS: Record<LanguageCode, CommunityUnreadWords> = { en, es, fr, de, it, nl, pt };

export function communityUnreadWords(language: unknown): CommunityUnreadWords {
  return COMMUNITY_UNREAD_WORDS[parseLanguage(language)];
}
