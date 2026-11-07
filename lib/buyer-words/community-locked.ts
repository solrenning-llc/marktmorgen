/**
 * The words of a community's locked spaces (542 [CM1]; components/community-locked.tsx),
 * in each language a store can speak. Every sentence is said in plain words,
 * with no count, no deadline and no pressure (CM1 (e)).
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type LockedWords = {
  heading: string;
  intro: string;
  locked: string;
  unlockWith: (product: string) => string;
  /** Said to a screen reader after the link, so it names the space it opens. */
  forSpace: (space: string) => string;
  notYet: string;
  unknown: string;
  /** A space whose products past the read cap were never read: reloading would read the same ones, so the member asks the creator. */
  capped: string;
  /** Kept spaces whose answer for this member could not be read just now: no lock and no way in, since they may hold the product. */
  uncheckedHeading: string;
  unchecked: string;
};

const en: LockedWords = {
  heading: "Locked spaces",
  intro: "These spaces open for members who have the product they are kept for.",
  locked: "Locked",
  unlockWith: (product) => `Unlock with ${product}`,
  forSpace: (space) => `, to open ${space}`,
  notYet: "Access isn't available yet.",
  unknown: "We couldn't load how to get in. Reload the page to try again.",
  capped: "Ask the creator how to get in.",
  uncheckedHeading: "Spaces we couldn't check",
  unchecked: "We couldn't check your access to these spaces just now. Reload the page to try again.",
};

const es: LockedWords = {
  heading: "Espacios cerrados",
  intro: "Estos espacios se abren para los miembros que tienen el producto al que están reservados.",
  locked: "Cerrado",
  unlockWith: (product) => `Desbloquear con ${product}`,
  forSpace: (space) => `, para abrir ${space}`,
  notYet: "El acceso aún no está disponible.",
  unknown: "No hemos podido cargar cómo entrar. Vuelve a cargar la página para intentarlo de nuevo.",
  capped: "Pregunta al creador cómo entrar.",
  uncheckedHeading: "Espacios que no pudimos comprobar",
  unchecked: "No hemos podido comprobar tu acceso a estos espacios en este momento. Vuelve a cargar la página para intentarlo de nuevo.",
};

const fr: LockedWords = {
  heading: "Espaces verrouillés",
  intro: "Ces espaces s’ouvrent aux membres qui ont le produit auquel ils sont réservés.",
  locked: "Verrouillé",
  unlockWith: (product) => `Déverrouiller avec ${product}`,
  forSpace: (space) => `, pour ouvrir ${space}`,
  notYet: "L’accès n’est pas encore disponible.",
  unknown: "Nous n’avons pas pu charger comment entrer. Rechargez la page pour réessayer.",
  capped: "Demandez au créateur comment entrer.",
  uncheckedHeading: "Espaces que nous n’avons pas pu vérifier",
  unchecked: "Nous n’avons pas pu vérifier votre accès à ces espaces pour le moment. Rechargez la page pour réessayer.",
};

const de: LockedWords = {
  heading: "Gesperrte Bereiche",
  intro: "Diese Bereiche öffnen sich für Mitglieder, die das Produkt haben, für das sie reserviert sind.",
  locked: "Gesperrt",
  unlockWith: (product) => `Mit ${product} freischalten`,
  forSpace: (space) => `, um ${space} zu öffnen`,
  notYet: "Der Zugang ist noch nicht verfügbar.",
  unknown: "Wir konnten nicht laden, wie man hineinkommt. Lade die Seite neu, um es noch einmal zu versuchen.",
  capped: "Frag den Ersteller, wie du hineinkommst.",
  uncheckedHeading: "Bereiche, die wir nicht prüfen konnten",
  unchecked: "Wir konnten deinen Zugang zu diesen Bereichen gerade nicht prüfen. Lade die Seite neu, um es noch einmal zu versuchen.",
};

const it: LockedWords = {
  heading: "Spazi bloccati",
  intro: "Questi spazi si aprono per i membri che hanno il prodotto a cui sono riservati.",
  locked: "Bloccato",
  unlockWith: (product) => `Sblocca con ${product}`,
  forSpace: (space) => `, per aprire ${space}`,
  notYet: "L’accesso non è ancora disponibile.",
  unknown: "Non siamo riusciti a caricare come entrare. Ricarica la pagina per riprovare.",
  capped: "Chiedi al creatore come entrare.",
  uncheckedHeading: "Spazi che non siamo riusciti a controllare",
  unchecked: "Non siamo riusciti a controllare il tuo accesso a questi spazi in questo momento. Ricarica la pagina per riprovare.",
};

const nl: LockedWords = {
  heading: "Vergrendelde ruimtes",
  intro: "Deze ruimtes gaan open voor leden die het product hebben waarvoor ze bewaard worden.",
  locked: "Vergrendeld",
  unlockWith: (product) => `Ontgrendelen met ${product}`,
  forSpace: (space) => `, om ${space} te openen`,
  notYet: "Toegang is nog niet beschikbaar.",
  unknown: "We konden niet laden hoe je binnenkomt. Laad de pagina opnieuw om het nog eens te proberen.",
  capped: "Vraag de maker hoe je binnenkomt.",
  uncheckedHeading: "Ruimtes die we niet konden controleren",
  unchecked: "We konden je toegang tot deze ruimtes nu niet controleren. Laad de pagina opnieuw om het nog eens te proberen.",
};

const pt: LockedWords = {
  heading: "Espaços trancados",
  intro: "Estes espaços abrem-se aos membros que têm o produto a que estão reservados.",
  locked: "Trancado",
  unlockWith: (product) => `Desbloquear com ${product}`,
  forSpace: (space) => `, para abrir ${space}`,
  notYet: "O acesso ainda não está disponível.",
  unknown: "Não conseguimos carregar como entrar. Recarregue a página para tentar de novo.",
  capped: "Pergunte ao criador como entrar.",
  uncheckedHeading: "Espaços que não conseguimos verificar",
  unchecked: "Não conseguimos verificar o seu acesso a estes espaços agora. Recarregue a página para tentar de novo.",
};

const WORDS: Record<LanguageCode, LockedWords> = { en, es, fr, de, it, nl, pt };

export function lockedWords(language: unknown): LockedWords {
  return WORDS[parseLanguage(language)] ?? en;
}
