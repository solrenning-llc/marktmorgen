/**
 * The words of "Your sessions" in the buyer area (34 [F3], unit 2;
 * app/[handle]/orders/sessions/page.tsx, components/client-sessions.tsx), in
 * each language a store can speak. Plain words, short sentences.
 * Browser-safe: plain data and small functions.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Notice = { title: string; body: string };

const en = {
  pageTitle: "Your sessions",
  intro: (store: string) => `Your sessions with ${store}: the ones coming up and the ones you had.`,
  upcoming: (n: number) => (n === 1 ? "Coming up: 1 session" : `Coming up: ${n} sessions`),
  past: (n: number) => (n === 1 ? "Past: 1 session" : `Past: ${n} sessions`),
  length: (zone: string, minutes: number) => `${minutes} minutes · times in ${zone}`,
  untitled: "Session",
  addToCalendar: "Add it to your calendar",
  joinOnOrders: "The link to join and the way to move a session are on your purchases page.",
  backToList: "Back to your purchases",
  getNewLink: "Get a new link",
  noneYet: (store: string) => `You have no sessions with ${store} from recent months.`,
  recentOnly: "This page lists your sessions from recent months.",
  partial: "Some older sessions could not be read, so this list may not show all of them.",
  more: (n: number) => (n === 1 ? "1 more session is not shown." : `${n} more sessions are not shown.`),
  notesTitle: (store: string) => `Notes from ${store}`,
  tasksTitle: "Your tasks",
  taskDone: "Done",
  taskOpen: "To do",
  due: (date: string) => `Due ${date}`,
  notices: {
    expired: { title: "This link has expired", body: "Ask for a new link on your purchases page. It comes to the email you paid with." },
    busy: { title: "The store is busy", body: "Your sessions were not loaded. Try again in a few minutes." },
    unreadable: { title: "Your sessions could not be loaded", body: "Something went wrong on our side. Try again in a moment." },
  } as Record<"expired" | "busy" | "unreadable", Notice>,
};

export type SessionsWords = typeof en;

const es: SessionsWords = {
  pageTitle: "Tus sesiones",
  intro: (store) => `Tus sesiones con ${store}: las próximas y las que ya tuviste.`,
  upcoming: (n) => (n === 1 ? "Próximamente: 1 sesión" : `Próximamente: ${n} sesiones`),
  past: (n) => (n === 1 ? "Anteriores: 1 sesión" : `Anteriores: ${n} sesiones`),
  length: (zone, minutes) => `${minutes} minutos · horas en ${zone}`,
  untitled: "Sesión",
  addToCalendar: "Añádela a tu calendario",
  joinOnOrders: "El enlace para entrar y la forma de cambiar una sesión están en la página de tus compras.",
  backToList: "Volver a tus compras",
  getNewLink: "Pedir un enlace nuevo",
  noneYet: (store) => `No tienes sesiones con ${store} de los últimos meses.`,
  recentOnly: "Esta página muestra tus sesiones de los últimos meses.",
  partial: "No se pudieron leer algunas sesiones más antiguas, así que puede que esta lista no las muestre todas.",
  more: (n) => (n === 1 ? "No se muestra 1 sesión más." : `No se muestran ${n} sesiones más.`),
  notesTitle: (store) => `Notas de ${store}`,
  tasksTitle: "Tus tareas",
  taskDone: "Hecha",
  taskOpen: "Pendiente",
  due: (date) => `Para el ${date}`,
  notices: {
    expired: { title: "Este enlace ha caducado", body: "Pide un enlace nuevo en la página de tus compras. Llega al email con el que pagaste." },
    busy: { title: "La tienda está ocupada", body: "No se cargaron tus sesiones. Vuelve a intentarlo en unos minutos." },
    unreadable: { title: "No se pudieron cargar tus sesiones", body: "Algo salió mal de nuestro lado. Vuelve a intentarlo en un momento." },
  },
};

const fr: SessionsWords = {
  pageTitle: "Vos séances",
  intro: (store) => `Vos séances avec ${store} : celles à venir et celles que vous avez eues.`,
  upcoming: (n) => (n === 1 ? "À venir : 1 séance" : `À venir : ${n} séances`),
  past: (n) => (n === 1 ? "Passées : 1 séance" : `Passées : ${n} séances`),
  length: (zone, minutes) => `${minutes} minutes · heures en ${zone}`,
  untitled: "Séance",
  addToCalendar: "L’ajouter à votre agenda",
  joinOnOrders: "Le lien pour rejoindre et la façon de déplacer une séance se trouvent sur la page de vos achats.",
  backToList: "Retour à vos achats",
  getNewLink: "Demander un nouveau lien",
  noneYet: (store) => `Vous n’avez aucune séance avec ${store} ces derniers mois.`,
  recentOnly: "Cette page montre vos séances des derniers mois.",
  partial: "Certaines séances plus anciennes n’ont pas pu être lues : cette liste ne les montre peut-être pas toutes.",
  more: (n) => (n === 1 ? "1 autre séance n’est pas affichée." : `${n} autres séances ne sont pas affichées.`),
  notesTitle: (store) => `Notes de ${store}`,
  tasksTitle: "Vos tâches",
  taskDone: "Faite",
  taskOpen: "À faire",
  due: (date) => `Pour le ${date}`,
  notices: {
    expired: { title: "Ce lien a expiré", body: "Demandez un nouveau lien sur la page de vos achats. Il arrive à l’e-mail avec lequel vous avez payé." },
    busy: { title: "La boutique est occupée", body: "Vos séances n’ont pas été chargées. Réessayez dans quelques minutes." },
    unreadable: { title: "Vos séances n’ont pas pu être chargées", body: "Un problème est survenu de notre côté. Réessayez dans un instant." },
  },
};

const de: SessionsWords = {
  pageTitle: "Ihre Termine",
  intro: (store) => `Ihre Termine bei ${store}: die kommenden und die vergangenen.`,
  upcoming: (n) => (n === 1 ? "Demnächst: 1 Termin" : `Demnächst: ${n} Termine`),
  past: (n) => (n === 1 ? "Vergangen: 1 Termin" : `Vergangen: ${n} Termine`),
  length: (zone, minutes) => `${minutes} Minuten · Zeiten in ${zone}`,
  untitled: "Termin",
  addToCalendar: "Zum Kalender hinzufügen",
  joinOnOrders: "Den Link zum Teilnehmen und die Möglichkeit, einen Termin zu verschieben, finden Sie auf der Seite mit Ihren Käufen.",
  backToList: "Zurück zu Ihren Käufen",
  getNewLink: "Neuen Link anfordern",
  noneYet: (store) => `Sie haben in den letzten Monaten keine Termine bei ${store}.`,
  recentOnly: "Diese Seite zeigt Ihre Termine der letzten Monate.",
  partial: "Einige ältere Termine konnten nicht gelesen werden. Diese Liste zeigt daher vielleicht nicht alle.",
  more: (n) => (n === 1 ? "1 weiterer Termin wird nicht angezeigt." : `${n} weitere Termine werden nicht angezeigt.`),
  notesTitle: (store) => `Notizen von ${store}`,
  tasksTitle: "Ihre Aufgaben",
  taskDone: "Erledigt",
  taskOpen: "Offen",
  due: (date) => `Fällig am ${date}`,
  notices: {
    expired: { title: "Dieser Link ist abgelaufen", body: "Fordern Sie auf der Seite mit Ihren Käufen einen neuen Link an. Er kommt an die E-Mail-Adresse, mit der Sie bezahlt haben." },
    busy: { title: "Der Shop ist gerade ausgelastet", body: "Ihre Termine wurden nicht geladen. Versuchen Sie es in ein paar Minuten noch einmal." },
    unreadable: { title: "Ihre Termine konnten nicht geladen werden", body: "Bei uns ist etwas schiefgelaufen. Versuchen Sie es gleich noch einmal." },
  },
};

const it: SessionsWords = {
  pageTitle: "Le tue sessioni",
  intro: (store) => `Le tue sessioni con ${store}: quelle in arrivo e quelle già fatte.`,
  upcoming: (n) => (n === 1 ? "In arrivo: 1 sessione" : `In arrivo: ${n} sessioni`),
  past: (n) => (n === 1 ? "Passate: 1 sessione" : `Passate: ${n} sessioni`),
  length: (zone, minutes) => `${minutes} minuti · orari in ${zone}`,
  untitled: "Sessione",
  addToCalendar: "Aggiungila al tuo calendario",
  joinOnOrders: "Il link per partecipare e il modo per spostare una sessione sono nella pagina dei tuoi acquisti.",
  backToList: "Torna ai tuoi acquisti",
  getNewLink: "Chiedi un nuovo link",
  noneYet: (store) => `Non hai sessioni con ${store} negli ultimi mesi.`,
  recentOnly: "Questa pagina mostra le tue sessioni degli ultimi mesi.",
  partial: "Alcune sessioni più vecchie non si sono potute leggere, quindi questo elenco potrebbe non mostrarle tutte.",
  more: (n) => (n === 1 ? "1 altra sessione non è mostrata." : `Altre ${n} sessioni non sono mostrate.`),
  notesTitle: (store) => `Note di ${store}`,
  tasksTitle: "Le tue attività",
  taskDone: "Fatta",
  taskOpen: "Da fare",
  due: (date) => `Entro il ${date}`,
  notices: {
    expired: { title: "Questo link è scaduto", body: "Chiedi un nuovo link nella pagina dei tuoi acquisti. Arriva all’email con cui hai pagato." },
    busy: { title: "Il negozio è occupato", body: "Le tue sessioni non sono state caricate. Riprova tra qualche minuto." },
    unreadable: { title: "Non è stato possibile caricare le tue sessioni", body: "Qualcosa è andato storto da parte nostra. Riprova tra un momento." },
  },
};

const nl: SessionsWords = {
  pageTitle: "Je sessies",
  intro: (store) => `Je sessies met ${store}: de komende en de sessies die je al had.`,
  upcoming: (n) => (n === 1 ? "Binnenkort: 1 sessie" : `Binnenkort: ${n} sessies`),
  past: (n) => (n === 1 ? "Eerder: 1 sessie" : `Eerder: ${n} sessies`),
  length: (zone, minutes) => `${minutes} minuten · tijden in ${zone}`,
  untitled: "Sessie",
  addToCalendar: "Zet hem in je agenda",
  joinOnOrders: "De link om mee te doen en de manier om een sessie te verzetten staan op de pagina met je aankopen.",
  backToList: "Terug naar je aankopen",
  getNewLink: "Vraag een nieuwe link aan",
  noneYet: (store) => `Je hebt de afgelopen maanden geen sessies met ${store}.`,
  recentOnly: "Deze pagina toont je sessies van de afgelopen maanden.",
  partial: "Sommige oudere sessies konden niet worden gelezen, dus deze lijst toont ze misschien niet allemaal.",
  more: (n) => (n === 1 ? "Nog 1 sessie wordt niet getoond." : `Nog ${n} sessies worden niet getoond.`),
  notesTitle: (store) => `Notities van ${store}`,
  tasksTitle: "Je taken",
  taskDone: "Klaar",
  taskOpen: "Te doen",
  due: (date) => `Uiterlijk ${date}`,
  notices: {
    expired: { title: "Deze link is verlopen", body: "Vraag een nieuwe link aan op de pagina met je aankopen. Die komt naar het e-mailadres waarmee je betaalde." },
    busy: { title: "De winkel heeft het druk", body: "Je sessies zijn niet geladen. Probeer het over een paar minuten opnieuw." },
    unreadable: { title: "Je sessies konden niet worden geladen", body: "Er ging bij ons iets mis. Probeer het zo opnieuw." },
  },
};

const pt: SessionsWords = {
  pageTitle: "As suas sessões",
  intro: (store) => `As suas sessões com ${store}: as que aí vêm e as que já teve.`,
  upcoming: (n) => (n === 1 ? "A seguir: 1 sessão" : `A seguir: ${n} sessões`),
  past: (n) => (n === 1 ? "Anteriores: 1 sessão" : `Anteriores: ${n} sessões`),
  length: (zone, minutes) => `${minutes} minutos · horas em ${zone}`,
  untitled: "Sessão",
  addToCalendar: "Adicionar ao seu calendário",
  joinOnOrders: "O link para entrar e a forma de mudar uma sessão estão na página das suas compras.",
  backToList: "Voltar às suas compras",
  getNewLink: "Pedir um link novo",
  noneYet: (store) => `Não tem sessões com ${store} nos últimos meses.`,
  recentOnly: "Esta página mostra as suas sessões dos últimos meses.",
  partial: "Não foi possível ler algumas sessões mais antigas, por isso esta lista pode não as mostrar todas.",
  more: (n) => (n === 1 ? "Mais 1 sessão não é mostrada." : `Mais ${n} sessões não são mostradas.`),
  notesTitle: (store) => `Notas de ${store}`,
  tasksTitle: "As suas tarefas",
  taskDone: "Feita",
  taskOpen: "Por fazer",
  due: (date) => `Até ${date}`,
  notices: {
    expired: { title: "Este link expirou", body: "Peça um link novo na página das suas compras. Chega ao email com que pagou." },
    busy: { title: "A loja está ocupada", body: "As suas sessões não foram carregadas. Tente de novo dentro de alguns minutos." },
    unreadable: { title: "Não foi possível carregar as suas sessões", body: "Algo correu mal do nosso lado. Tente de novo dentro de momentos." },
  },
};

export const SESSIONS_WORDS: Record<LanguageCode, SessionsWords> = { en, es, fr, de, it, nl, pt };

/** The words of "Your sessions" in the store's language; English for anything unknown. */
export function sessionsWords(language: unknown): SessionsWords {
  return SESSIONS_WORDS[parseLanguage(language)];
}
