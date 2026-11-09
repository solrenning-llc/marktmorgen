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
  /** The member's own access to the space could not be checked just now (lib/community-access.ts spaceAnswer "unknown"). */
  unchecked: string;
  /** The same, when asking again will not tell either (more purchases than are read, Holdings `lasting`): write to the creator. */
  uncheckedLasting: string;
};

const en: LockedWords = {
  heading: "Locked spaces",
  intro: "These spaces open for members who have the product they are kept for.",
  locked: "Locked",
  unlockWith: (product) => `Unlock with ${product}`,
  forSpace: (space) => `, to open ${space}`,
  notYet: "Access isn't available yet.",
  unknown: "We couldn't load how to get in. Reload the page to try again.",
  unchecked: "We couldn't check your access to this space just now. Reload the page to try again.",
  uncheckedLasting: "We cannot check your access to this space here: your purchases are more than we can check on our own. Write to the creator and ask them to check it.",
};

const es: LockedWords = {
  heading: "Espacios cerrados",
  intro: "Estos espacios se abren para los miembros que tienen el producto al que están reservados.",
  locked: "Cerrado",
  unlockWith: (product) => `Desbloquear con ${product}`,
  forSpace: (space) => `, para abrir ${space}`,
  notYet: "El acceso aún no está disponible.",
  unknown: "No hemos podido cargar cómo entrar. Vuelve a cargar la página para intentarlo de nuevo.",
  unchecked: "No hemos podido comprobar tu acceso a este espacio ahora mismo. Vuelve a cargar la página para intentarlo de nuevo.",
  uncheckedLasting: "No podemos comprobar aquí tu acceso a este espacio: tus compras son más de las que podemos comprobar por nuestra cuenta. Escribe al creador y pídele que lo compruebe.",
};

const fr: LockedWords = {
  heading: "Espaces verrouillés",
  intro: "Ces espaces s’ouvrent aux membres qui ont le produit auquel ils sont réservés.",
  locked: "Verrouillé",
  unlockWith: (product) => `Déverrouiller avec ${product}`,
  forSpace: (space) => `, pour ouvrir ${space}`,
  notYet: "L’accès n’est pas encore disponible.",
  unknown: "Nous n’avons pas pu charger comment entrer. Rechargez la page pour réessayer.",
  unchecked: "Nous n’avons pas pu vérifier votre accès à cet espace pour le moment. Rechargez la page pour réessayer.",
  uncheckedLasting: "Nous ne pouvons pas vérifier ici votre accès à cet espace : vos achats sont plus nombreux que ce que nous pouvons vérifier nous-mêmes. Écrivez au créateur pour lui demander de le vérifier.",
};

const de: LockedWords = {
  heading: "Gesperrte Bereiche",
  intro: "Diese Bereiche öffnen sich für Mitglieder, die das Produkt haben, für das sie reserviert sind.",
  locked: "Gesperrt",
  unlockWith: (product) => `Mit ${product} freischalten`,
  forSpace: (space) => `, um ${space} zu öffnen`,
  notYet: "Der Zugang ist noch nicht verfügbar.",
  unknown: "Wir konnten nicht laden, wie man hineinkommt. Laden Sie die Seite neu, um es noch einmal zu versuchen.",
  unchecked: "Wir konnten Ihren Zugang zu diesem Bereich gerade nicht prüfen. Laden Sie die Seite neu, um es noch einmal zu versuchen.",
  uncheckedLasting: "Wir können Ihren Zugang zu diesem Bereich hier nicht prüfen: Ihre Käufe sind mehr, als wir selbst prüfen können. Schreiben Sie dem Ersteller und bitten Sie ihn, ihn zu prüfen.",
};

const it: LockedWords = {
  heading: "Spazi bloccati",
  intro: "Questi spazi si aprono per i membri che hanno il prodotto a cui sono riservati.",
  locked: "Bloccato",
  unlockWith: (product) => `Sblocca con ${product}`,
  forSpace: (space) => `, per aprire ${space}`,
  notYet: "L’accesso non è ancora disponibile.",
  unknown: "Non siamo riusciti a caricare come entrare. Ricarica la pagina per riprovare.",
  unchecked: "Non siamo riusciti a verificare il tuo accesso a questo spazio in questo momento. Ricarica la pagina per riprovare.",
  uncheckedLasting: "Non possiamo verificare qui il tuo accesso a questo spazio: i tuoi acquisti sono più di quanti possiamo verificare da soli. Scrivi al creatore e chiedigli di verificarlo.",
};

const nl: LockedWords = {
  heading: "Vergrendelde ruimtes",
  intro: "Deze ruimtes gaan open voor leden die het product hebben waarvoor ze bewaard worden.",
  locked: "Vergrendeld",
  unlockWith: (product) => `Ontgrendelen met ${product}`,
  forSpace: (space) => `, om ${space} te openen`,
  notYet: "Toegang is nog niet beschikbaar.",
  unknown: "We konden niet laden hoe je binnenkomt. Laad de pagina opnieuw om het nog eens te proberen.",
  unchecked: "We konden je toegang tot deze ruimte nu niet controleren. Laad de pagina opnieuw om het nog eens te proberen.",
  uncheckedLasting: "We kunnen je toegang tot deze ruimte hier niet controleren: je aankopen zijn meer dan we zelf kunnen controleren. Schrijf de maker en vraag of die het controleert.",
};

const pt: LockedWords = {
  heading: "Espaços trancados",
  intro: "Estes espaços abrem-se aos membros que têm o produto a que estão reservados.",
  locked: "Trancado",
  unlockWith: (product) => `Desbloquear com ${product}`,
  forSpace: (space) => `, para abrir ${space}`,
  notYet: "O acesso ainda não está disponível.",
  unknown: "Não conseguimos carregar como entrar. Recarregue a página para tentar de novo.",
  unchecked: "Não conseguimos verificar o seu acesso a este espaço agora. Recarregue a página para tentar de novo.",
  uncheckedLasting: "Não conseguimos verificar aqui o seu acesso a este espaço: as suas compras são mais do que conseguimos verificar sozinhos. Escreva ao criador e peça que o verifique.",
};

const WORDS: Record<LanguageCode, LockedWords> = { en, es, fr, de, it, nl, pt };

export function lockedWords(language: unknown): LockedWords {
  return WORDS[parseLanguage(language)] ?? en;
}
