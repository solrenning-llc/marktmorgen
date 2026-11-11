/**
 * The words of the store page's guide (lib/store-guide.ts): a visitor says
 * what they want, and is shown which of the creator's products fit, and why.
 * Browser-safe: plain data and small functions.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const en = {
  title: "Not sure which one is for you?",
  lead: (store: string) => `Say what you want to get done, and see which of ${store}'s products fit, and why.`,
  label: "What are you looking for?",
  placeholder: "For example: quick family dinners",
  button: "Help me choose",
  busy: "Looking…",
  picks: "These fit best",
  none: (store: string) => `From what its pages say, nothing ${store} sells fits that yet. ${store} is told what was looked for, never who asked.`,
  see: (title: string) => `See ${title}`,
  slow: "Too many questions for now. Try again in a few minutes.",
  closed: "This help is not available right now. Every product's page is still here to read.",
  failed: "That did not work just now. Try again in a moment.",
  short: "Say a few more words about what you want.",
  note: "Picked by AI, only from what this store's pages say. Read the product's page before you buy.",
};

export type GuideWords = typeof en;

const es: GuideWords = {
  title: "¿No sabes cuál es para ti?",
  lead: (store) => `Cuenta lo que quieres conseguir y descubre qué productos de ${store} encajan, y por qué.`,
  label: "¿Qué estás buscando?",
  placeholder: "Por ejemplo: cenas rápidas en familia",
  button: "Ayúdame a elegir",
  busy: "Buscando…",
  picks: "Estos encajan mejor",
  none: (store) => `Según lo que dicen sus páginas, nada de lo que vende ${store} encaja con eso todavía. ${store} sabrá lo que se buscó, nunca quién lo preguntó.`,
  see: (title) => `Ver ${title}`,
  slow: "Demasiadas preguntas por ahora. Inténtalo dentro de unos minutos.",
  closed: "Esta ayuda no está disponible ahora mismo. La página de cada producto sigue aquí para leerla.",
  failed: "No ha funcionado ahora. Inténtalo de nuevo en un momento.",
  short: "Cuenta un poco más sobre lo que quieres.",
  note: "Elegido por IA, solo a partir de lo que dicen las páginas de esta tienda. Lee la página del producto antes de comprar.",
};

const fr: GuideWords = {
  title: "Vous ne savez pas lequel choisir ?",
  lead: (store) => `Dites ce que vous voulez accomplir, et voyez quels produits de ${store} vous conviennent, et pourquoi.`,
  label: "Que cherchez-vous ?",
  placeholder: "Par exemple : dîners rapides en famille",
  button: "Aidez-moi à choisir",
  busy: "Recherche…",
  picks: "Ceux qui conviennent le mieux",
  none: (store) => `D'après ses pages, rien de ce que vend ${store} ne correspond encore à cela. ${store} saura ce qui a été cherché, jamais qui l'a demandé.`,
  see: (title) => `Voir ${title}`,
  slow: "Trop de questions pour le moment. Réessayez dans quelques minutes.",
  closed: "Cette aide n'est pas disponible pour l'instant. La page de chaque produit reste là pour être lue.",
  failed: "Cela n'a pas fonctionné. Réessayez dans un instant.",
  short: "Dites-en un peu plus sur ce que vous voulez.",
  note: "Choisi par une IA, uniquement d'après ce que disent les pages de cette boutique. Lisez la page du produit avant d'acheter.",
};

const de: GuideWords = {
  title: "Nicht sicher, was zu dir passt?",
  lead: (store) => `Sag, was du erreichen willst, und sieh, welche Produkte von ${store} passen, und warum.`,
  label: "Wonach suchst du?",
  placeholder: "Zum Beispiel: schnelles Familienessen",
  button: "Hilf mir bei der Wahl",
  busy: "Suche…",
  picks: "Das passt am besten",
  none: (store) => `Nach dem, was die Seiten sagen, passt dazu noch nichts, was ${store} verkauft. ${store} erfährt, wonach gesucht wurde, nie, wer gefragt hat.`,
  see: (title) => `${title} ansehen`,
  slow: "Gerade zu viele Fragen. Versuche es in ein paar Minuten wieder.",
  closed: "Diese Hilfe ist gerade nicht verfügbar. Die Seite jedes Produkts ist weiterhin da.",
  failed: "Das hat gerade nicht geklappt. Versuche es gleich noch einmal.",
  short: "Erzähl etwas mehr darüber, was du suchst.",
  note: "Von einer KI ausgewählt, nur nach dem, was die Seiten dieses Shops sagen. Lies vor dem Kauf die Seite des Produkts.",
};

const it: GuideWords = {
  title: "Non sai quale fa per te?",
  lead: (store) => `Di' cosa vuoi ottenere e scopri quali prodotti di ${store} fanno al caso tuo, e perché.`,
  label: "Cosa stai cercando?",
  placeholder: "Per esempio: cene veloci in famiglia",
  button: "Aiutami a scegliere",
  busy: "Cerco…",
  picks: "Questi sono i più adatti",
  none: (store) => `Da quello che dicono le sue pagine, niente di ciò che vende ${store} corrisponde ancora. ${store} saprà cosa è stato cercato, mai chi l'ha chiesto.`,
  see: (title) => `Vedi ${title}`,
  slow: "Troppe domande per ora. Riprova tra qualche minuto.",
  closed: "Questo aiuto non è disponibile ora. La pagina di ogni prodotto è sempre qui da leggere.",
  failed: "Non ha funzionato. Riprova tra un momento.",
  short: "Dicci qualcosa in più su ciò che vuoi.",
  note: "Scelto da un'IA, solo in base a ciò che dicono le pagine di questo negozio. Leggi la pagina del prodotto prima di comprare.",
};

const nl: GuideWords = {
  title: "Weet je niet welke bij je past?",
  lead: (store) => `Zeg wat je wilt bereiken en zie welke producten van ${store} passen, en waarom.`,
  label: "Waar ben je naar op zoek?",
  placeholder: "Bijvoorbeeld: snelle gezinsmaaltijden",
  button: "Help me kiezen",
  busy: "Zoeken…",
  picks: "Deze passen het best",
  none: (store) => `Volgens de pagina's past nog niets wat ${store} verkoopt daarbij. ${store} hoort waar naar gezocht is, nooit wie het vroeg.`,
  see: (title) => `Bekijk ${title}`,
  slow: "Even te veel vragen. Probeer het over een paar minuten opnieuw.",
  closed: "Deze hulp is nu niet beschikbaar. De pagina van elk product staat er nog om te lezen.",
  failed: "Dat lukte nu niet. Probeer het zo opnieuw.",
  short: "Vertel iets meer over wat je wilt.",
  note: "Gekozen door AI, alleen op basis van wat de pagina's van deze winkel zeggen. Lees de pagina van het product voordat je koopt.",
};

// European Portuguese: the courteous third person, as in lib/buyer-words/giving.ts.
const pt: GuideWords = {
  title: "Não sabe qual é para si?",
  lead: (store) => `Diga o que quer alcançar e veja que produtos de ${store} lhe servem, e porquê.`,
  label: "O que procura?",
  placeholder: "Por exemplo: jantares rápidos em família",
  button: "Ajude-me a escolher",
  busy: "A procurar…",
  picks: "Estes servem melhor",
  none: (store) => `Pelo que as páginas dizem, nada do que ${store} vende corresponde ainda a isso. ${store} fica a saber o que foi procurado, nunca quem perguntou.`,
  see: (title) => `Ver ${title}`,
  slow: "Demasiadas perguntas por agora. Tente novamente dentro de alguns minutos.",
  closed: "Esta ajuda não está disponível neste momento. A página de cada produto continua aqui para ler.",
  failed: "Não funcionou agora. Tente novamente daqui a pouco.",
  short: "Diga um pouco mais sobre o que procura.",
  note: "Escolhido por IA, apenas a partir do que as páginas desta loja dizem. Leia a página do produto antes de comprar.",
};

export const GUIDE_WORDS: Record<LanguageCode, GuideWords> = { en, es, fr, de, it, nl, pt };

/** The guide's words in the store's language; English for anything unknown. */
export function guideWords(language: unknown): GuideWords {
  return GUIDE_WORDS[parseLanguage(language)];
}
