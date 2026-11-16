/**
 * The words a community live event carries outside its pages, in the store's
 * language (lib/store-language.ts): the member's calendar file and the feed
 * post that announces it (lib/community-events.ts, eventIcs and
 * announcementText). Same vocabulary as the event's pages and reminder emails
 * (lib/buyer-words/community.ts), and the same conventions: "tú" in Spanish,
 * "vous" in French with its non-breaking spaces, "Sie" in German, "tu" in
 * Italian, "je" in Dutch, and the courteous third person of Portugal in
 * Portuguese.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

/** A non-breaking space, before the signs French spaces from the word before them. */
const S = " ";

export type EventFileWords = {
  /** The calendar file's description: where to join from. */
  joinFrom: (page: string) => string;
  /** The calendar file's description: when the way in shows. */
  wayIn: (minutes: number) => string;
  /** The calendar's alarm, that many minutes before the start. */
  alarm: (title: string, minutes: number) => string;
  /** The feed post's title. */
  liveTitle: (title: string) => string;
  /** The feed post's last sentence, with the event page. */
  rsvpJoin: (page: string) => string;
};

const en: EventFileWords = {
  joinFrom: (page) => `Join from the event page: ${page}`,
  wayIn: (minutes) => `The way in shows there ${minutes} minutes before the start.`,
  alarm: (title, minutes) => `${title} in ${minutes} minutes`,
  liveTitle: (title) => `Live: ${title}`,
  rsvpJoin: (page) => `RSVP, add it to your calendar and join here: ${page}`,
};

const es: EventFileWords = {
  joinFrom: (page) => `Únete desde la página del evento: ${page}`,
  wayIn: (minutes) => `El acceso aparece allí ${minutes} minutos antes del comienzo.`,
  alarm: (title, minutes) => `${title} empieza en ${minutes} minutos`,
  liveTitle: (title) => `En vivo: ${title}`,
  rsvpJoin: (page) => `Confirma tu asistencia, añádelo a tu calendario y únete aquí: ${page}`,
};

const fr: EventFileWords = {
  joinFrom: (page) => `Rejoignez-le depuis la page de l'événement${S}: ${page}`,
  wayIn: (minutes) => `L'accès y apparaît ${minutes}${S}minutes avant le début.`,
  alarm: (title, minutes) => `${title} commence dans ${minutes}${S}minutes`,
  liveTitle: (title) => `En direct${S}: ${title}`,
  rsvpJoin: (page) => `Inscrivez-vous, ajoutez-le à votre calendrier et rejoignez-le ici${S}: ${page}`,
};

const de: EventFileWords = {
  joinFrom: (page) => `Treten Sie über die Event-Seite bei: ${page}`,
  wayIn: (minutes) => `Der Zugang erscheint dort ${minutes} Minuten vor Beginn.`,
  alarm: (title, minutes) => `${title} beginnt in ${minutes} Minuten`,
  liveTitle: (title) => `Live-Event: ${title}`,
  rsvpJoin: (page) => `Sagen Sie zu, tragen Sie es in Ihren Kalender ein und nehmen Sie hier teil: ${page}`,
};

const it: EventFileWords = {
  joinFrom: (page) => `Partecipa dalla pagina dell'evento: ${page}`,
  wayIn: (minutes) => `L'accesso compare lì ${minutes} minuti prima dell'inizio.`,
  alarm: (title, minutes) => `${title} inizia tra ${minutes} minuti`,
  liveTitle: (title) => `In diretta: ${title}`,
  rsvpJoin: (page) => `Conferma la partecipazione, aggiungilo al calendario e partecipa da qui: ${page}`,
};

const nl: EventFileWords = {
  joinFrom: (page) => `Doe mee via de eventpagina: ${page}`,
  wayIn: (minutes) => `De toegang verschijnt daar ${minutes} minuten voor de start.`,
  alarm: (title, minutes) => `${title} begint over ${minutes} minuten`,
  liveTitle: (title) => `Live-event: ${title}`,
  rsvpJoin: (page) => `Meld je aan, zet het in je agenda en doe hier mee: ${page}`,
};

const pt: EventFileWords = {
  joinFrom: (page) => `Entre a partir da página do evento: ${page}`,
  wayIn: (minutes) => `O acesso aparece lá ${minutes} minutos antes do início.`,
  alarm: (title, minutes) => `${title} começa daqui a ${minutes} minutos`,
  liveTitle: (title) => `Em direto: ${title}`,
  rsvpJoin: (page) => `Confirme a presença, adicione-o ao calendário e entre aqui: ${page}`,
};

export const EVENT_FILE_WORDS: Record<LanguageCode, EventFileWords> = { en, es, fr, de, it, nl, pt };

export function eventFileWords(language: unknown): EventFileWords {
  return EVENT_FILE_WORDS[parseLanguage(language)];
}
