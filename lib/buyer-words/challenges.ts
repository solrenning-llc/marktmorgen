/**
 * What a member reads about the community's challenges
 * (lib/community-challenges.ts), in each language a store can speak. Every
 * date is said with its time zone: a challenge's days run midnight to
 * midnight UTC.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type ChallengeNotice = "joined" | "already" | "checked" | "checkedalready" | "notyet" | "ended" | "gone" | "slow" | "noroom" | "error" | "host" | "notmember";

export type ChallengeWords = {
  tab: string;
  title: string;
  intro: string;
  nothing: string;
  nothingOwner: string;
  nothingMember: string;
  startInStudio: string;
  on: string;
  startsOn: (date: string) => string;
  over: string;
  dates: (from: string, to: string) => string;
  eachDay: string;
  join: string;
  checkIn: string;
  checkedToday: string;
  notJoined: string;
  opensOn: (date: string) => string;
  progress: (done: number, days: number) => string;
  streak: (days: number) => string;
  yourDays: string;
  dayDone: (date: string) => string;
  dayMissed: (date: string) => string;
  host: string;
  counts: (joined: number, checkIns: number) => string;
  today: (n: number) => string;
  notices: Record<ChallengeNotice, { text: string; tone: "ok" | "warn" }>;
};

const en: ChallengeWords = {
  tab: "Challenges",
  title: "Challenges",
  intro: "Join a challenge and check in once a day. Each day runs from midnight to midnight UTC.",
  nothing: "No challenges right now.",
  nothingOwner: "You can start one in the studio.",
  nothingMember: "When the creator starts one, it shows here.",
  startInStudio: "Start a challenge in the studio",
  on: "On now",
  startsOn: (date) => `Starts ${date}`,
  over: "Over",
  dates: (from, to) => `${from} to ${to}, UTC`,
  eachDay: "Each day",
  join: "Join this challenge",
  checkIn: "Check in for today",
  checkedToday: "You checked in today.",
  notJoined: "You have not joined yet.",
  opensOn: (date) => `Check-ins open on ${date}, UTC.`,
  progress: (done, days) => `You checked in on ${done} of ${days} ${days === 1 ? "day" : "days"}.`,
  streak: (days) => `Streak: ${days} ${days === 1 ? "day" : "days"} in a row.`,
  yourDays: "Your days",
  dayDone: (date) => `${date}: checked in`,
  dayMissed: (date) => `${date}: not checked in`,
  host: "You run this challenge, so you do not check in.",
  counts: (joined, checkIns) => `${joined} joined, ${checkIns} ${checkIns === 1 ? "check-in" : "check-ins"} in all.`,
  today: (n) => `${n} checked in today.`,
  notices: {
    joined: { text: "You joined. Check in once a day while the challenge runs.", tone: "ok" },
    already: { text: "You had already joined.", tone: "ok" },
    checked: { text: "Checked in.", tone: "ok" },
    checkedalready: { text: "You had already checked in today.", tone: "ok" },
    notyet: { text: "This challenge has not started yet.", tone: "warn" },
    ended: { text: "This challenge is over.", tone: "warn" },
    gone: { text: "That challenge is no longer here.", tone: "warn" },
    slow: { text: "That was a lot at once. Please try again in a while.", tone: "warn" },
    noroom: { text: "The store is out of space for this right now. Please tell the creator.", tone: "warn" },
    error: { text: "That did not go through. Please try again.", tone: "warn" },
    host: { text: "You run this challenge, so you do not check in.", tone: "warn" },
    notmember: { text: "Only members can join a challenge.", tone: "warn" },
  },
};

const es: ChallengeWords = {
  tab: "Retos",
  title: "Retos",
  intro: "Únete a un reto y registra tu día una vez al día. Cada día va de medianoche a medianoche UTC.",
  nothing: "Ahora no hay retos.",
  nothingOwner: "Puedes empezar uno en el estudio.",
  nothingMember: "Cuando el creador empiece uno, aparecerá aquí.",
  startInStudio: "Empezar un reto en el estudio",
  on: "En curso",
  startsOn: (date) => `Empieza el ${date}`,
  over: "Terminado",
  dates: (from, to) => `Del ${from} al ${to}, UTC`,
  eachDay: "Cada día",
  join: "Unirme a este reto",
  checkIn: "Registrar el día de hoy",
  checkedToday: "Ya registraste el día de hoy.",
  notJoined: "Aún no te has unido.",
  opensOn: (date) => `Los registros se abren el ${date}, UTC.`,
  progress: (done, days) => `Registraste ${done} de ${days} ${days === 1 ? "día" : "días"}.`,
  streak: (days) => `Racha: ${days} ${days === 1 ? "día seguido" : "días seguidos"}.`,
  yourDays: "Tus días",
  dayDone: (date) => `${date}: registrado`,
  dayMissed: (date) => `${date}: sin registrar`,
  host: "Diriges este reto, así que no registras días.",
  counts: (joined, checkIns) => `${joined} unidos, ${checkIns} ${checkIns === 1 ? "registro" : "registros"} en total.`,
  today: (n) => `${n} registraron hoy.`,
  notices: {
    joined: { text: "Te uniste. Registra tu día una vez al día mientras dure el reto.", tone: "ok" },
    already: { text: "Ya te habías unido.", tone: "ok" },
    checked: { text: "Día registrado.", tone: "ok" },
    checkedalready: { text: "Ya habías registrado el día de hoy.", tone: "ok" },
    notyet: { text: "Este reto aún no ha empezado.", tone: "warn" },
    ended: { text: "Este reto ha terminado.", tone: "warn" },
    gone: { text: "Ese reto ya no está.", tone: "warn" },
    slow: { text: "Demasiado de una vez. Inténtalo de nuevo dentro de un rato.", tone: "warn" },
    noroom: { text: "La tienda no tiene espacio para esto ahora. Avisa al creador, por favor.", tone: "warn" },
    error: { text: "No se ha enviado. Inténtalo de nuevo.", tone: "warn" },
    host: { text: "Diriges este reto, así que no registras días.", tone: "warn" },
    notmember: { text: "Solo los miembros pueden unirse a un reto.", tone: "warn" },
  },
};

const fr: ChallengeWords = {
  tab: "Défis",
  title: "Défis",
  intro: "Rejoignez un défi et pointez une fois par jour. Chaque jour va de minuit à minuit UTC.",
  nothing: "Aucun défi pour l’instant.",
  nothingOwner: "Vous pouvez en lancer un dans le studio.",
  nothingMember: "Quand le créateur en lancera un, il apparaîtra ici.",
  startInStudio: "Lancer un défi dans le studio",
  on: "En cours",
  startsOn: (date) => `Commence le ${date}`,
  over: "Terminé",
  dates: (from, to) => `Du ${from} au ${to}, UTC`,
  eachDay: "Chaque jour",
  join: "Rejoindre ce défi",
  checkIn: "Pointer pour aujourd’hui",
  checkedToday: "Vous avez pointé aujourd’hui.",
  notJoined: "Vous n’avez pas encore rejoint ce défi.",
  opensOn: (date) => `Le pointage ouvre le ${date}, UTC.`,
  progress: (done, days) => `Vous avez pointé ${done} ${days === 1 ? "jour" : "jours"} sur ${days}.`,
  streak: (days) => `Série : ${days} ${days === 1 ? "jour" : "jours"} d’affilée.`,
  yourDays: "Vos jours",
  dayDone: (date) => `${date} : pointé`,
  dayMissed: (date) => `${date} : pas pointé`,
  host: "Vous animez ce défi, vous ne pointez donc pas.",
  counts: (joined, checkIns) => `${joined} inscrits, ${checkIns} ${checkIns === 1 ? "pointage" : "pointages"} au total.`,
  today: (n) => `${n} ont pointé aujourd’hui.`,
  notices: {
    joined: { text: "Vous avez rejoint le défi. Pointez une fois par jour tant qu’il dure.", tone: "ok" },
    already: { text: "Vous aviez déjà rejoint ce défi.", tone: "ok" },
    checked: { text: "C’est pointé.", tone: "ok" },
    checkedalready: { text: "Vous aviez déjà pointé aujourd’hui.", tone: "ok" },
    notyet: { text: "Ce défi n’a pas encore commencé.", tone: "warn" },
    ended: { text: "Ce défi est terminé.", tone: "warn" },
    gone: { text: "Ce défi n’est plus là.", tone: "warn" },
    slow: { text: "Beaucoup d’un coup. Réessayez dans un moment.", tone: "warn" },
    noroom: { text: "La boutique n’a plus de place pour cela pour l’instant. Prévenez le créateur.", tone: "warn" },
    error: { text: "L’envoi n’a pas abouti. Réessayez.", tone: "warn" },
    host: { text: "Vous animez ce défi, vous ne pointez donc pas.", tone: "warn" },
    notmember: { text: "Seuls les membres peuvent rejoindre un défi.", tone: "warn" },
  },
};

const de: ChallengeWords = {
  tab: "Challenges",
  title: "Challenges",
  intro: "Machen Sie bei einer Challenge mit und checken Sie einmal am Tag ein. Jeder Tag geht von Mitternacht bis Mitternacht UTC.",
  nothing: "Gerade gibt es keine Challenges.",
  nothingOwner: "Sie können im Studio eine starten.",
  nothingMember: "Sobald eine Challenge startet, steht sie hier.",
  startInStudio: "Challenge im Studio starten",
  on: "Läuft gerade",
  startsOn: (date) => `Beginnt am ${date}`,
  over: "Vorbei",
  dates: (from, to) => `${from} bis ${to}, UTC`,
  eachDay: "Jeden Tag",
  join: "Bei dieser Challenge mitmachen",
  checkIn: "Für heute einchecken",
  checkedToday: "Sie haben heute eingecheckt.",
  notJoined: "Sie machen noch nicht mit.",
  opensOn: (date) => `Einchecken ist ab ${date} möglich, UTC.`,
  progress: (done, days) => `Sie haben an ${done} von ${days} ${days === 1 ? "Tag" : "Tagen"} eingecheckt.`,
  streak: (days) => `Serie: ${days} ${days === 1 ? "Tag" : "Tage"} am Stück.`,
  yourDays: "Ihre Tage",
  dayDone: (date) => `${date}: eingecheckt`,
  dayMissed: (date) => `${date}: nicht eingecheckt`,
  host: "Sie leiten diese Challenge und checken daher nicht ein.",
  counts: (joined, checkIns) => `${joined} dabei, insgesamt ${checkIns} ${checkIns === 1 ? "Check-in" : "Check-ins"}.`,
  today: (n) => `${n} heute eingecheckt.`,
  notices: {
    joined: { text: "Sie sind dabei. Checken Sie einmal am Tag ein, solange die Challenge läuft.", tone: "ok" },
    already: { text: "Sie waren schon dabei.", tone: "ok" },
    checked: { text: "Eingecheckt.", tone: "ok" },
    checkedalready: { text: "Sie hatten heute schon eingecheckt.", tone: "ok" },
    notyet: { text: "Diese Challenge hat noch nicht begonnen.", tone: "warn" },
    ended: { text: "Diese Challenge ist vorbei.", tone: "warn" },
    gone: { text: "Diese Challenge gibt es nicht mehr.", tone: "warn" },
    slow: { text: "Das war viel auf einmal. Bitte versuchen Sie es gleich noch einmal.", tone: "warn" },
    noroom: { text: "Im Shop ist dafür gerade kein Platz. Bitte sagen Sie es der Person, die ihn betreibt.", tone: "warn" },
    error: { text: "Das hat nicht geklappt. Bitte versuchen Sie es noch einmal.", tone: "warn" },
    host: { text: "Sie leiten diese Challenge und checken daher nicht ein.", tone: "warn" },
    notmember: { text: "Nur Mitglieder können bei einer Challenge mitmachen.", tone: "warn" },
  },
};

const it: ChallengeWords = {
  tab: "Sfide",
  title: "Sfide",
  intro: "Partecipa a una sfida e fai il check-in una volta al giorno. Ogni giorno va da mezzanotte a mezzanotte UTC.",
  nothing: "Al momento non ci sono sfide.",
  nothingOwner: "Puoi avviarne una nello studio.",
  nothingMember: "Quando ne verrà avviata una, la troverai qui.",
  startInStudio: "Avvia una sfida nello studio",
  on: "In corso",
  startsOn: (date) => `Inizia il ${date}`,
  over: "Conclusa",
  dates: (from, to) => `Dal ${from} al ${to}, UTC`,
  eachDay: "Ogni giorno",
  join: "Partecipa a questa sfida",
  checkIn: "Fai il check-in di oggi",
  checkedToday: "Hai fatto il check-in oggi.",
  notJoined: "Non partecipi ancora.",
  opensOn: (date) => `Il check-in apre il ${date}, UTC.`,
  progress: (done, days) => `Hai fatto il check-in in ${done} ${days === 1 ? "giorno" : "giorni"} su ${days}.`,
  streak: (days) => `Serie: ${days} ${days === 1 ? "giorno" : "giorni"} di fila.`,
  yourDays: "I tuoi giorni",
  dayDone: (date) => `${date}: check-in fatto`,
  dayMissed: (date) => `${date}: check-in non fatto`,
  host: "Guidi questa sfida, quindi non fai il check-in.",
  counts: (joined, checkIns) => `${joined} partecipanti, ${checkIns} check-in in tutto.`,
  today: (n) => `${n} hanno fatto il check-in oggi.`,
  notices: {
    joined: { text: "Partecipi. Fai il check-in una volta al giorno finché la sfida è in corso.", tone: "ok" },
    already: { text: "Partecipavi già.", tone: "ok" },
    checked: { text: "Check-in fatto.", tone: "ok" },
    checkedalready: { text: "Avevi già fatto il check-in oggi.", tone: "ok" },
    notyet: { text: "Questa sfida non è ancora iniziata.", tone: "warn" },
    ended: { text: "Questa sfida è conclusa.", tone: "warn" },
    gone: { text: "Quella sfida non c’è più.", tone: "warn" },
    slow: { text: "Troppe richieste insieme. Riprova tra un po’.", tone: "warn" },
    noroom: { text: "Al momento il negozio non ha spazio per questo. Avvisa chi lo gestisce.", tone: "warn" },
    error: { text: "Non è andato a buon fine. Riprova.", tone: "warn" },
    host: { text: "Guidi questa sfida, quindi non fai il check-in.", tone: "warn" },
    notmember: { text: "Solo i membri possono partecipare a una sfida.", tone: "warn" },
  },
};

const nl: ChallengeWords = {
  tab: "Uitdagingen",
  title: "Uitdagingen",
  intro: "Doe mee aan een uitdaging en check één keer per dag in. Elke dag loopt van middernacht tot middernacht UTC.",
  nothing: "Er zijn nu geen uitdagingen.",
  nothingOwner: "Je kunt er een starten in de studio.",
  nothingMember: "Zodra de maker er een start, staat die hier.",
  startInStudio: "Een uitdaging starten in de studio",
  on: "Nu bezig",
  startsOn: (date) => `Begint op ${date}`,
  over: "Afgelopen",
  dates: (from, to) => `${from} tot en met ${to}, UTC`,
  eachDay: "Elke dag",
  join: "Doe mee aan deze uitdaging",
  checkIn: "Check in voor vandaag",
  checkedToday: "Je hebt vandaag ingecheckt.",
  notJoined: "Je doet nog niet mee.",
  opensOn: (date) => `Inchecken kan vanaf ${date}, UTC.`,
  progress: (done, days) => `Je hebt op ${done} van de ${days} ${days === 1 ? "dag" : "dagen"} ingecheckt.`,
  streak: (days) => `Reeks: ${days} ${days === 1 ? "dag" : "dagen"} op rij.`,
  yourDays: "Jouw dagen",
  dayDone: (date) => `${date}: ingecheckt`,
  dayMissed: (date) => `${date}: niet ingecheckt`,
  host: "Jij leidt deze uitdaging, dus je checkt niet in.",
  counts: (joined, checkIns) => `${joined} doen mee, ${checkIns} keer ingecheckt in totaal.`,
  today: (n) => `${n} vandaag ingecheckt.`,
  notices: {
    joined: { text: "Je doet mee. Check één keer per dag in zolang de uitdaging loopt.", tone: "ok" },
    already: { text: "Je deed al mee.", tone: "ok" },
    checked: { text: "Ingecheckt.", tone: "ok" },
    checkedalready: { text: "Je had vandaag al ingecheckt.", tone: "ok" },
    notyet: { text: "Deze uitdaging is nog niet begonnen.", tone: "warn" },
    ended: { text: "Deze uitdaging is afgelopen.", tone: "warn" },
    gone: { text: "Die uitdaging is er niet meer.", tone: "warn" },
    slow: { text: "Dat was veel tegelijk. Probeer het zo nog eens.", tone: "warn" },
    noroom: { text: "De winkel heeft hier nu geen ruimte voor. Laat het de maker weten.", tone: "warn" },
    error: { text: "Dat is niet gelukt. Probeer het nog eens.", tone: "warn" },
    host: { text: "Jij leidt deze uitdaging, dus je checkt niet in.", tone: "warn" },
    notmember: { text: "Alleen leden kunnen meedoen aan een uitdaging.", tone: "warn" },
  },
};

const pt: ChallengeWords = {
  tab: "Desafios",
  title: "Desafios",
  intro: "Participe num desafio e faça o check-in uma vez por dia. Cada dia vai da meia-noite à meia-noite UTC.",
  nothing: "Não há desafios neste momento.",
  nothingOwner: "Pode começar um no estúdio.",
  nothingMember: "Quando o criador começar um, aparece aqui.",
  startInStudio: "Começar um desafio no estúdio",
  on: "A decorrer",
  startsOn: (date) => `Começa a ${date}`,
  over: "Terminado",
  dates: (from, to) => `De ${from} a ${to}, UTC`,
  eachDay: "Cada dia",
  join: "Participar neste desafio",
  checkIn: "Fazer o check-in de hoje",
  checkedToday: "Fez o check-in hoje.",
  notJoined: "Ainda não está a participar.",
  opensOn: (date) => `O check-in abre a ${date}, UTC.`,
  progress: (done, days) => `Fez o check-in em ${done} de ${days} ${days === 1 ? "dia" : "dias"}.`,
  streak: (days) => `Sequência: ${days} ${days === 1 ? "dia seguido" : "dias seguidos"}.`,
  yourDays: "Os seus dias",
  dayDone: (date) => `${date}: check-in feito`,
  dayMissed: (date) => `${date}: sem check-in`,
  host: "Orienta este desafio, por isso não faz check-in.",
  counts: (joined, checkIns) => `${joined} participantes, ${checkIns} check-ins no total.`,
  today: (n) => `${n} fizeram o check-in hoje.`,
  notices: {
    joined: { text: "Está a participar. Faça o check-in uma vez por dia enquanto o desafio durar.", tone: "ok" },
    already: { text: "Já estava a participar.", tone: "ok" },
    checked: { text: "Check-in feito.", tone: "ok" },
    checkedalready: { text: "Já tinha feito o check-in hoje.", tone: "ok" },
    notyet: { text: "Este desafio ainda não começou.", tone: "warn" },
    ended: { text: "Este desafio terminou.", tone: "warn" },
    gone: { text: "Esse desafio já não existe.", tone: "warn" },
    slow: { text: "Foi muito de uma vez. Tente de novo daqui a pouco.", tone: "warn" },
    noroom: { text: "A loja está sem espaço para isto neste momento. Avise o criador, por favor.", tone: "warn" },
    error: { text: "Não foi possível enviar. Tente de novo.", tone: "warn" },
    host: { text: "Orienta este desafio, por isso não faz check-in.", tone: "warn" },
    notmember: { text: "Só os membros podem participar num desafio.", tone: "warn" },
  },
};

export const CHALLENGE_WORDS: Record<LanguageCode, ChallengeWords> = { en, es, fr, de, it, nl, pt };

export function challengeWords(language: unknown): ChallengeWords {
  return CHALLENGE_WORDS[parseLanguage(language)];
}

/** A challenge's day as the store's language writes a date, in UTC: "Dec 1, 2026". */
export function challengeDate(locale: string, ms: number): string {
  return new Date(ms).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
