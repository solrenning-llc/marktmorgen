/**
 * What a community page says when who its members are could not be read
 * (lib/community.ts readMembers and memberNames, lib/community-mentions.ts
 * whoIs; rules 24 and 30), in each language a store can speak: names drawn as
 * "A member" in their place, a members list that is not shown, and a members
 * search that could not be made, and a members count that could not be had
 * under a list that did read. Never an empty list or "No match" as if it were
 * true, nor a list said unloaded while it is shown.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import { communityWords } from "@/lib/buyer-words/community";

export type CommunityNamesUnreadWords = {
  /** Names that did not read, shown as "A member" in their place. */
  names: string;
  /** The members page, when its list did not read. */
  membersList: string;
  /** The members page, when its list read but how many are listed did not: the list is shown, only the number is not. */
  membersCount: string;
  /** The members tab of a search, when the members found did not read. */
  membersSearch: string;
};

const en: CommunityNamesUnreadWords = {
  names: "Some names could not be loaded just now. Reload the page to see them.",
  membersList: "The members list could not be loaded just now. Reload the page to try again.",
  membersCount: "We could not count the members just now.",
  membersSearch: "Members could not be searched just now, so we cannot say whether any match. Try again in a moment.",
};

const es: CommunityNamesUnreadWords = {
  names: "Ahora mismo no se pudieron cargar algunos nombres. Recarga la página para verlos.",
  membersList: "Ahora mismo no se pudo cargar la lista de miembros. Recarga la página para intentarlo de nuevo.",
  membersCount: "Ahora mismo no pudimos contar los miembros.",
  membersSearch: "No se pudo buscar entre los miembros ahora mismo, así que no sabemos si hay resultados. Inténtalo de nuevo en un momento.",
};

const fr: CommunityNamesUnreadWords = {
  names: "Certains noms n'ont pas pu être chargés pour l'instant. Rechargez la page pour les voir.",
  membersList: "La liste des membres n'a pas pu être chargée pour l'instant. Rechargez la page pour réessayer.",
  membersCount: "Nous n'avons pas pu compter les membres pour l'instant.",
  membersSearch: "Impossible de chercher parmi les membres pour l'instant, donc nous ne savons pas s'il y a un résultat. Réessayez dans un moment.",
};

const de: CommunityNamesUnreadWords = {
  names: "Einige Namen konnten gerade nicht geladen werden. Laden Sie die Seite neu, um sie zu sehen.",
  membersList: "Die Mitgliederliste konnte gerade nicht geladen werden. Laden Sie die Seite neu, um es erneut zu versuchen.",
  membersCount: "Wir konnten die Mitglieder gerade nicht zählen.",
  membersSearch: "Die Mitglieder konnten gerade nicht durchsucht werden, daher wissen wir nicht, ob es einen Treffer gibt. Versuchen Sie es gleich noch einmal.",
};

const it: CommunityNamesUnreadWords = {
  names: "Al momento non è stato possibile caricare alcuni nomi. Ricarica la pagina per vederli.",
  membersList: "Al momento non è stato possibile caricare l'elenco dei membri. Ricarica la pagina per riprovare.",
  membersCount: "Al momento non siamo riusciti a contare i membri.",
  membersSearch: "Non è stato possibile cercare tra i membri in questo momento, quindi non sappiamo se ci sono risultati. Riprova tra poco.",
};

const nl: CommunityNamesUnreadWords = {
  names: "Sommige namen konden nu niet worden geladen. Laad de pagina opnieuw om ze te zien.",
  membersList: "De ledenlijst kon nu niet worden geladen. Laad de pagina opnieuw om het nog eens te proberen.",
  membersCount: "We konden de leden nu niet tellen.",
  membersSearch: "Er kon nu niet in de leden worden gezocht, dus we weten niet of er een treffer is. Probeer het zo nog eens.",
};

const pt: CommunityNamesUnreadWords = {
  names: "Agora não foi possível carregar alguns nomes. Recarregue a página para os ver.",
  membersList: "Agora não foi possível carregar a lista de membros. Recarregue a página para tentar de novo.",
  membersCount: "Agora não foi possível contar os membros.",
  membersSearch: "Agora não foi possível pesquisar os membros, por isso não sabemos se há resultados. Tente de novo daqui a pouco.",
};

export const COMMUNITY_NAMES_UNREAD_WORDS: Record<LanguageCode, CommunityNamesUnreadWords> = { en, es, fr, de, it, nl, pt };

export function communityNamesUnreadWords(language: unknown): CommunityNamesUnreadWords {
  return COMMUNITY_NAMES_UNREAD_WORDS[parseLanguage(language)];
}

/**
 * The members page's privacy promise on its own ("Only the name each chose is
 * shown; nobody's email address is, ever."), for when the listed count did not
 * read: the promise is true whatever the count, so it is never hidden with it.
 * Taken from the count's own words (listedTotal is "<count>. <promise>" in every
 * language), so the two can never say different things; no new words.
 */
export function listedPrivacy(language: unknown): string {
  const whole = communityWords(language).listedTotal(1);
  const at = whole.indexOf(". ");
  if (at < 0) throw new Error("listedTotal no longer reads as '<count>. <promise>'");
  return whole.slice(at + 2);
}
