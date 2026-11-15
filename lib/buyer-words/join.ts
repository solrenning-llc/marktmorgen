/**
 * The words of the sign-up box on a store page and what follows it
 * (lib/store-join.ts): the box, the "check your inbox" page, the button that
 * confirms, and the email that carries it. The creator may write the box's
 * heading and line in their own words; these are what shows when they did
 * not. Browser-safe: plain data and small functions.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Notice = { title: string; body: string };

const en = {
  heading: "Get new things by email",
  line: (store: string) => `Hear from ${store} when something new is out. You confirm by email first, and every email has a link to stop.`,
  label: "Your email",
  button: "Join",
  pageTitle: "Email list",
  almost: "Almost there",
  sentTitle: "Check your inbox",
  sentBody: (store: string) =>
    `We emailed you a button to confirm you want emails from ${store}. It usually arrives within a minute; if it is not there, look in spam.`,
  sentNote: "You join the email list only after you confirm with the button.",
  confirmTitle: (store: string) => `Get emails from ${store}?`,
  confirmBody: (store: string) => `Press the button to join ${store}'s email list. Every email has a link to leave it.`,
  confirmButton: "Yes, join the list",
  doneBadge: "You are on the list",
  doneTitle: (store: string) => `Welcome to ${store}'s list`,
  doneBody: "You will hear when there is something new. To stop, use the link at the bottom of any email.",
  notices: {
    email: { title: "That does not look like an email address", body: "Check it and try again. The confirmation goes to the address you type, so it has to be one you can open." },
    limited: { title: "Too many sign-ups for now", body: "To keep this form from being used to flood somebody's inbox, it takes a limited number an hour. Try again in an hour." },
    closed: { title: "This list is not taking sign-ups", body: "Nothing was kept." },
    full: { title: "This list is full", body: "It holds as many people as it can. Nothing was kept." },
    error: { title: "We could not send it just now", body: "Try again in a moment." },
    expired: { title: "This link has expired", body: "A confirmation link works for 7 days. Sign up again from the store's page; it takes a few seconds." },
  } as Record<string, Notice>,
  mailSubject: (store: string) => `Confirm: emails from ${store}`,
  mailAsked: (store: string) => `You asked to get emails from ${store}.`,
  mailOpen: "Open this link and press the button to confirm it was you:",
  mailWorks: "It works for 7 days.",
  mailIgnore: "If you did not ask for this, ignore this email. Nothing happens unless the button is pressed, and you will not hear from us again.",
};

export type JoinWords = typeof en;

const es: JoinWords = {
  heading: "Recibe las novedades por email",
  line: (store) => `Entérate cuando ${store} publique algo nuevo. Primero lo confirmas por email, y cada email trae un enlace para darte de baja.`,
  label: "Tu email",
  button: "Unirme",
  pageTitle: "Lista de email",
  almost: "Ya casi está",
  sentTitle: "Revisa tu bandeja de entrada",
  sentBody: (store) =>
    `Te enviamos un botón para confirmar que quieres recibir emails de ${store}. Suele llegar en menos de un minuto; si no está, mira en spam.`,
  sentNote: "Solo te unes a la lista de email después de confirmar con el botón.",
  confirmTitle: (store) => `¿Recibir emails de ${store}?`,
  confirmBody: (store) => `Pulsa el botón para unirte a la lista de ${store}. Cada email trae un enlace para salir de ella.`,
  confirmButton: "Sí, unirme a la lista",
  doneBadge: "Ya estás en la lista",
  doneTitle: (store) => `Bienvenido a la lista de ${store}`,
  doneBody: "Te enterarás cuando haya algo nuevo. Para dejar de recibirlos, usa el enlace al final de cualquier email.",
  notices: {
    email: { title: "Eso no parece una dirección de email", body: "Revísala y vuelve a intentarlo. La confirmación va a la dirección que escribas, así que tiene que ser una que puedas abrir." },
    limited: { title: "Demasiadas inscripciones por ahora", body: "Para que este formulario no se use para llenar el buzón de nadie, acepta un número limitado por hora. Inténtalo dentro de una hora." },
    closed: { title: "Esta lista no acepta inscripciones", body: "No se guardó nada." },
    full: { title: "Esta lista está llena", body: "Tiene tantas personas como puede guardar. No se guardó nada." },
    error: { title: "No pudimos enviarlo ahora", body: "Inténtalo de nuevo en un momento." },
    expired: { title: "Este enlace ha caducado", body: "Un enlace de confirmación funciona 7 días. Vuelve a inscribirte desde la página de la tienda; son unos segundos." },
  },
  mailSubject: (store) => `Confirma: emails de ${store}`,
  mailAsked: (store) => `Pediste recibir emails de ${store}.`,
  mailOpen: "Abre este enlace y pulsa el botón para confirmar que fuiste tú:",
  mailWorks: "Funciona durante 7 días.",
  mailIgnore: "Si no lo pediste, ignora este email. No pasa nada si no se pulsa el botón, y no volverás a saber de nosotros.",
};

const fr: JoinWords = {
  heading: "Les nouveautés par e-mail",
  line: (store) => `Soyez prévenu quand ${store} publie quelque chose de nouveau. Vous confirmez d'abord par e-mail, et chaque e-mail contient un lien pour vous désinscrire.`,
  label: "Votre e-mail",
  button: "S'inscrire",
  pageTitle: "Liste e-mail",
  almost: "Presque fini",
  sentTitle: "Regardez votre boîte de réception",
  sentBody: (store) =>
    `Nous vous avons envoyé un bouton pour confirmer que vous voulez recevoir les e-mails de ${store}. Il arrive en général en moins d'une minute ; sinon, regardez dans les spams.`,
  sentNote: "Vous rejoignez la liste d'e-mails uniquement après avoir confirmé avec le bouton.",
  confirmTitle: (store) => `Recevoir les e-mails de ${store} ?`,
  confirmBody: (store) => `Appuyez sur le bouton pour rejoindre la liste de ${store}. Chaque e-mail contient un lien pour la quitter.`,
  confirmButton: "Oui, m'inscrire",
  doneBadge: "Vous êtes inscrit",
  doneTitle: (store) => `Bienvenue sur la liste de ${store}`,
  doneBody: "Vous serez prévenu quand il y aura du nouveau. Pour arrêter, utilisez le lien en bas de n'importe quel e-mail.",
  notices: {
    email: { title: "Cela ne ressemble pas à une adresse e-mail", body: "Vérifiez-la et réessayez. La confirmation part à l'adresse tapée : il faut donc pouvoir l'ouvrir." },
    limited: { title: "Trop d'inscriptions pour le moment", body: "Pour que ce formulaire ne serve pas à inonder la boîte de quelqu'un, il en accepte un nombre limité par heure. Réessayez dans une heure." },
    closed: { title: "Cette liste ne prend pas d'inscriptions", body: "Rien n'a été gardé." },
    full: { title: "Cette liste est complète", body: "Elle contient autant de personnes que possible. Rien n'a été gardé." },
    error: { title: "Impossible de l'envoyer pour l'instant", body: "Réessayez dans un instant." },
    expired: { title: "Ce lien a expiré", body: "Un lien de confirmation fonctionne 7 jours. Réinscrivez-vous depuis la page de la boutique ; cela prend quelques secondes." },
  },
  mailSubject: (store) => `Confirmez : les e-mails de ${store}`,
  mailAsked: (store) => `Vous avez demandé à recevoir les e-mails de ${store}.`,
  mailOpen: "Ouvrez ce lien et appuyez sur le bouton pour confirmer que c'était vous :",
  mailWorks: "Il fonctionne pendant 7 jours.",
  mailIgnore: "Si vous n'avez rien demandé, ignorez cet e-mail. Rien ne se passe tant que le bouton n'est pas pressé, et vous n'aurez plus de nouvelles de nous.",
};

const de: JoinWords = {
  heading: "Neues per E-Mail erhalten",
  line: (store) => `Erfahre, wenn ${store} etwas Neues veröffentlicht. Du bestätigst zuerst per E-Mail, und jede E-Mail enthält einen Link zum Abmelden.`,
  label: "Deine E-Mail",
  button: "Eintragen",
  pageTitle: "E-Mail-Liste",
  almost: "Fast geschafft",
  sentTitle: "Schau in dein Postfach",
  sentBody: (store) =>
    `Wir haben dir einen Button geschickt, mit dem du bestätigst, dass du E-Mails von ${store} möchtest. Er kommt meist innerhalb einer Minute an; falls nicht, sieh im Spam nach.`,
  sentNote: "Du wirst erst in die E-Mail-Liste aufgenommen, wenn du mit dem Button bestätigst.",
  confirmTitle: (store) => `E-Mails von ${store} erhalten?`,
  confirmBody: (store) => `Drück den Button, um dich in die Liste von ${store} einzutragen. Jede E-Mail enthält einen Link zum Austragen.`,
  confirmButton: "Ja, eintragen",
  doneBadge: "Du stehst auf der Liste",
  doneTitle: (store) => `Willkommen auf der Liste von ${store}`,
  doneBody: "Du erfährst es, wenn es etwas Neues gibt. Zum Abmelden nutze den Link unten in jeder E-Mail.",
  notices: {
    email: { title: "Das sieht nicht nach einer E-Mail-Adresse aus", body: "Prüfe sie und versuche es noch einmal. Die Bestätigung geht an die eingegebene Adresse, du musst sie also öffnen können." },
    limited: { title: "Gerade zu viele Anmeldungen", body: "Damit niemand mit diesem Formular ein fremdes Postfach flutet, nimmt es pro Stunde nur eine begrenzte Zahl an. Versuche es in einer Stunde wieder." },
    closed: { title: "Diese Liste nimmt keine Anmeldungen an", body: "Es wurde nichts gespeichert." },
    full: { title: "Diese Liste ist voll", body: "Sie fasst so viele Menschen, wie sie kann. Es wurde nichts gespeichert." },
    error: { title: "Wir konnten es gerade nicht senden", body: "Versuche es gleich noch einmal." },
    expired: { title: "Dieser Link ist abgelaufen", body: "Ein Bestätigungslink gilt 7 Tage. Trag dich auf der Seite des Shops erneut ein; das dauert nur Sekunden." },
  },
  mailSubject: (store) => `Bestätigen: E-Mails von ${store}`,
  mailAsked: (store) => `Du wolltest E-Mails von ${store} erhalten.`,
  mailOpen: "Öffne diesen Link und drück den Button, um zu bestätigen, dass du es warst:",
  mailWorks: "Er gilt 7 Tage lang.",
  mailIgnore: "Wenn du das nicht angefordert hast, ignoriere diese E-Mail. Ohne Klick auf den Button passiert nichts, und du hörst nichts mehr von uns.",
};

const it: JoinWords = {
  heading: "Ricevi le novità via email",
  line: (store) => `Sappi quando ${store} pubblica qualcosa di nuovo. Prima confermi via email, e ogni email ha un link per disiscriverti.`,
  label: "La tua email",
  button: "Iscriviti",
  pageTitle: "Lista email",
  almost: "Ci sei quasi",
  sentTitle: "Controlla la tua casella",
  sentBody: (store) =>
    `Ti abbiamo inviato un pulsante per confermare che vuoi ricevere le email di ${store}. Di solito arriva entro un minuto; se non c'è, guarda nello spam.`,
  sentNote: "Entri nella lista email solo dopo aver confermato con il pulsante.",
  confirmTitle: (store) => `Ricevere le email di ${store}?`,
  confirmBody: (store) => `Premi il pulsante per entrare nella lista di ${store}. Ogni email ha un link per uscirne.`,
  confirmButton: "Sì, iscrivimi",
  doneBadge: "Sei nella lista",
  doneTitle: (store) => `Benvenuto nella lista di ${store}`,
  doneBody: "Saprai quando c'è qualcosa di nuovo. Per smettere, usa il link in fondo a qualsiasi email.",
  notices: {
    email: { title: "Non sembra un indirizzo email", body: "Controllalo e riprova. La conferma va all'indirizzo che scrivi, quindi deve essere uno che puoi aprire." },
    limited: { title: "Troppe iscrizioni per ora", body: "Perché questo modulo non serva a riempire la casella di qualcuno, ne accetta un numero limitato all'ora. Riprova tra un'ora." },
    closed: { title: "Questa lista non accetta iscrizioni", body: "Non è stato salvato nulla." },
    full: { title: "Questa lista è piena", body: "Contiene tutte le persone che può. Non è stato salvato nulla." },
    error: { title: "Non siamo riusciti a inviarlo adesso", body: "Riprova tra un momento." },
    expired: { title: "Questo link è scaduto", body: "Un link di conferma funziona per 7 giorni. Iscriviti di nuovo dalla pagina del negozio; bastano pochi secondi." },
  },
  mailSubject: (store) => `Conferma: le email di ${store}`,
  mailAsked: (store) => `Hai chiesto di ricevere le email di ${store}.`,
  mailOpen: "Apri questo link e premi il pulsante per confermare che eri tu:",
  mailWorks: "Funziona per 7 giorni.",
  mailIgnore: "Se non l'hai chiesto tu, ignora questa email. Non succede nulla se il pulsante non viene premuto, e non avrai più nostre notizie.",
};

const nl: JoinWords = {
  heading: "Nieuwe dingen per e-mail",
  line: (store) => `Hoor het wanneer ${store} iets nieuws uitbrengt. Je bevestigt eerst per e-mail, en elke e-mail heeft een link om af te melden.`,
  label: "Je e-mailadres",
  button: "Aanmelden",
  pageTitle: "E-maillijst",
  almost: "Bijna klaar",
  sentTitle: "Kijk in je inbox",
  sentBody: (store) =>
    `We hebben je een knop gestuurd om te bevestigen dat je e-mails van ${store} wilt. Die komt meestal binnen een minuut; staat hij er niet, kijk dan bij spam.`,
  sentNote: "Je komt pas op de e-maillijst nadat je met de knop hebt bevestigd.",
  confirmTitle: (store) => `E-mails van ${store} ontvangen?`,
  confirmBody: (store) => `Druk op de knop om je aan te melden voor de lijst van ${store}. Elke e-mail heeft een link om je af te melden.`,
  confirmButton: "Ja, meld me aan",
  doneBadge: "Je staat op de lijst",
  doneTitle: (store) => `Welkom op de lijst van ${store}`,
  doneBody: "Je hoort het wanneer er iets nieuws is. Stoppen kan via de link onderaan elke e-mail.",
  notices: {
    email: { title: "Dat lijkt geen e-mailadres", body: "Controleer het en probeer het opnieuw. De bevestiging gaat naar het adres dat je typt, dus het moet er een zijn dat je kunt openen." },
    limited: { title: "Even te veel aanmeldingen", body: "Zodat dit formulier niet gebruikt wordt om iemands inbox te overspoelen, neemt het er per uur maar een beperkt aantal aan. Probeer het over een uur opnieuw." },
    closed: { title: "Deze lijst neemt geen aanmeldingen aan", body: "Er is niets bewaard." },
    full: { title: "Deze lijst is vol", body: "Er staan zoveel mensen op als er passen. Er is niets bewaard." },
    error: { title: "We konden het nu niet versturen", body: "Probeer het zo opnieuw." },
    expired: { title: "Deze link is verlopen", body: "Een bevestigingslink werkt 7 dagen. Meld je opnieuw aan via de pagina van de winkel; dat duurt een paar seconden." },
  },
  mailSubject: (store) => `Bevestig: e-mails van ${store}`,
  mailAsked: (store) => `Je hebt gevraagd om e-mails van ${store}.`,
  mailOpen: "Open deze link en druk op de knop om te bevestigen dat jij het was:",
  mailWorks: "Hij werkt 7 dagen.",
  mailIgnore: "Heb je hier niet om gevraagd, negeer deze e-mail dan. Er gebeurt niets zolang de knop niet is ingedrukt, en je hoort niets meer van ons.",
};

// European Portuguese: the courteous third person ("o seu", "introduza"), as in lib/buyer-words/giving.ts.
const pt: JoinWords = {
  heading: "Receba as novidades por email",
  line: (store) => `Saiba quando ${store} lançar algo novo. Primeiro confirma por email, e cada email tem uma ligação para sair.`,
  label: "O seu email",
  button: "Inscrever-me",
  pageTitle: "Lista de email",
  almost: "Quase lá",
  sentTitle: "Verifique a sua caixa de entrada",
  sentBody: (store) =>
    `Enviámos-lhe um botão para confirmar que quer receber emails de ${store}. Costuma chegar em menos de um minuto; se não estiver lá, veja no spam.`,
  sentNote: "Só entra na lista de emails depois de confirmar com o botão.",
  confirmTitle: (store) => `Receber emails de ${store}?`,
  confirmBody: (store) => `Prima o botão para entrar na lista de ${store}. Cada email tem uma ligação para sair dela.`,
  confirmButton: "Sim, inscrever-me",
  doneBadge: "Está na lista",
  doneTitle: (store) => `Bem-vindo à lista de ${store}`,
  doneBody: "Vai saber quando houver algo novo. Para deixar de receber, use a ligação no fim de qualquer email.",
  notices: {
    email: { title: "Isso não parece um endereço de email", body: "Verifique-o e tente novamente. A confirmação é enviada para o endereço que introduzir, por isso tem de ser um a que tenha acesso." },
    limited: { title: "Demasiadas inscrições por agora", body: "Para que este formulário não seja usado para inundar a caixa de entrada de alguém, aceita um número limitado por hora. Tente novamente dentro de uma hora." },
    closed: { title: "Esta lista não está a aceitar inscrições", body: "Nada foi guardado." },
    full: { title: "Esta lista está cheia", body: "Já tem tantas pessoas quantas consegue guardar. Nada foi guardado." },
    error: { title: "Não foi possível enviar agora", body: "Tente novamente daqui a pouco." },
    expired: { title: "Esta ligação expirou", body: "Uma ligação de confirmação funciona durante 7 dias. Inscreva-se novamente na página da loja; demora poucos segundos." },
  },
  mailSubject: (store) => `Confirme: emails de ${store}`,
  mailAsked: (store) => `Pediu para receber emails de ${store}.`,
  mailOpen: "Abra esta ligação e prima o botão para confirmar que foi o próprio:",
  mailWorks: "Funciona durante 7 dias.",
  mailIgnore: "Se não pediu isto, ignore este email. Nada acontece se o botão não for premido, e não voltará a ter notícias nossas.",
};

export const JOIN_WORDS: Record<LanguageCode, JoinWords> = { en, es, fr, de, it, nl, pt };

/** The sign-up box's words in the store's language; English for anything unknown. */
export function joinWords(language: unknown): JoinWords {
  return JOIN_WORDS[parseLanguage(language)];
}
