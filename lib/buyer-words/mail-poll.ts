/**
 * The words around a poll in a store's email and on the page where a reader
 * confirms an answer (lib/mail-poll.ts, app/poll), in each language a store
 * can speak. The question and the answers are the creator's own words.
 *
 * Browser-safe: plain data, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import { POLL_MIN_SHOWN } from "@/lib/mail-poll";

export type PollWords = {
  /** Under the answers in the email: how it works and who sees what. */
  emailNote: (name: string) => string;
  /** The page's title. */
  title: string;
  /** "Your answer: X", before it is sent. */
  picked: (answer: string) => string;
  send: string;
  /** Before the other answers, as links to pick another one instead. */
  others: string;
  once: string;
  /** Who sees what, on every page: only what the code keeps (lib/mail-poll-votes.ts, pollResults). */
  privacy: (name: string) => string;
  thanksTitle: string;
  thanks: (answer: string) => string;
  alreadyTitle: string;
  already: (answer: string) => string;
  withdraw: string;
  withdrawnTitle: string;
  withdrawn: string;
  closedTitle: string;
  closed: string;
  unknownTitle: string;
  unknown: string;
  failedTitle: string;
  failed: string;
  /** Past the presses a connection may make in an hour (app/api/mail/poll): says how many. */
  limitedTitle: string;
  limited: (presses: number) => string;
  /** A press from the store's owner or team: not counted (app/api/mail/poll, "team"). */
  teamTitle: string;
  team: string;
  previewTitle: string;
  preview: string;
};

const en: PollWords = {
  emailNote: (name) => `Pick one answer. A page opens where you confirm it. ${name} sees only totals, after the poll closes and only if at least ${POLL_MIN_SHOWN} readers answered, never with names.`,
  title: "Your answer",
  picked: (answer) => `Your answer: ${answer}`,
  send: "Send my answer",
  others: "Or pick another answer:",
  once: "Each person answers once. You can take your answer back later.",
  privacy: (name) => `${name} sees only totals, after the poll closes and only if at least ${POLL_MIN_SHOWN} readers answered, never with names.`,
  thanksTitle: "Thank you. Your answer is recorded.",
  thanks: (answer) => `You answered: ${answer}.`,
  alreadyTitle: "You already answered this poll",
  already: (answer) => `Your answer: ${answer}. Each person answers once.`,
  withdraw: "Take my answer back",
  withdrawnTitle: "Your answer was taken back",
  withdrawn: "Nothing of it is kept. You can answer again from the email while the poll is open.",
  closedTitle: "This poll is closed",
  closed: "It no longer takes answers. Nothing was recorded.",
  unknownTitle: "This link does not work",
  unknown: "It may have been copied only in part. Nothing was recorded. Use the link in the email itself.",
  failedTitle: "Your answer could not be recorded just now",
  failed: "Nothing was saved. Try the link in the email again later.",
  limitedTitle: "Too many answers came from this connection",
  limited: (n) => `At most ${n} answers an hour can come from one connection. Nothing was saved. Try the link in the email again in an hour.`,
  teamTitle: "Your store's own poll",
  team: "Answers from the store's owner and team are not counted, so the totals are readers' only. Nothing was recorded.",
  previewTitle: "This is a preview",
  preview: "Answers are recorded only from the email a reader gets. Nothing was recorded.",
};

const es: PollWords = {
  emailNote: (name) => `Elige una respuesta. Se abre una página donde la confirmas. ${name} solo ve totales, después de que la encuesta cierre y solo si respondieron al menos ${POLL_MIN_SHOWN} lectores, nunca con nombres.`,
  title: "Tu respuesta",
  picked: (answer) => `Tu respuesta: ${answer}`,
  send: "Enviar mi respuesta",
  others: "O elige otra respuesta:",
  once: "Cada persona responde una vez. Puedes retirar tu respuesta más tarde.",
  privacy: (name) => `${name} solo ve totales, después de que la encuesta cierre y solo si respondieron al menos ${POLL_MIN_SHOWN} lectores, nunca con nombres.`,
  thanksTitle: "Gracias. Tu respuesta quedó registrada.",
  thanks: (answer) => `Respondiste: ${answer}.`,
  alreadyTitle: "Ya respondiste esta encuesta",
  already: (answer) => `Tu respuesta: ${answer}. Cada persona responde una vez.`,
  withdraw: "Retirar mi respuesta",
  withdrawnTitle: "Tu respuesta fue retirada",
  withdrawn: "No se guarda nada de ella. Puedes volver a responder desde el correo mientras la encuesta esté abierta.",
  closedTitle: "Esta encuesta está cerrada",
  closed: "Ya no acepta respuestas. No se registró nada.",
  unknownTitle: "Este enlace no funciona",
  unknown: "Puede que se haya copiado solo en parte. No se registró nada. Usa el enlace del propio correo.",
  failedTitle: "No se pudo registrar tu respuesta ahora",
  failed: "No se guardó nada. Vuelve a probar el enlace del correo más tarde.",
  limitedTitle: "Llegaron demasiadas respuestas desde esta conexión",
  limited: (n) => `Desde una conexión pueden llegar como mucho ${n} respuestas por hora. No se guardó nada. Vuelve a probar el enlace del correo dentro de una hora.`,
  teamTitle: "La encuesta de tu propia tienda",
  team: "Las respuestas del dueño y del equipo de la tienda no se cuentan, así los totales son solo de lectores. No se registró nada.",
  previewTitle: "Esto es una vista previa",
  preview: "Las respuestas solo se registran desde el correo que recibe cada lector. No se registró nada.",
};

const fr: PollWords = {
  emailNote: (name) => `Choisissez une réponse. Une page s'ouvre pour la confirmer. ${name} ne voit que des totaux, après la clôture du sondage et seulement si au moins ${POLL_MIN_SHOWN} lecteurs ont répondu, jamais avec des noms.`,
  title: "Votre réponse",
  picked: (answer) => `Votre réponse : ${answer}`,
  send: "Envoyer ma réponse",
  others: "Ou choisissez une autre réponse :",
  once: "Chaque personne répond une fois. Vous pourrez retirer votre réponse plus tard.",
  privacy: (name) => `${name} ne voit que des totaux, après la clôture du sondage et seulement si au moins ${POLL_MIN_SHOWN} lecteurs ont répondu, jamais avec des noms.`,
  thanksTitle: "Merci. Votre réponse est enregistrée.",
  thanks: (answer) => `Vous avez répondu : ${answer}.`,
  alreadyTitle: "Vous avez déjà répondu à ce sondage",
  already: (answer) => `Votre réponse : ${answer}. Chaque personne répond une fois.`,
  withdraw: "Retirer ma réponse",
  withdrawnTitle: "Votre réponse a été retirée",
  withdrawn: "Rien n'en est gardé. Vous pouvez répondre à nouveau depuis l'e-mail tant que le sondage est ouvert.",
  closedTitle: "Ce sondage est fermé",
  closed: "Il n'accepte plus de réponses. Rien n'a été enregistré.",
  unknownTitle: "Ce lien ne fonctionne pas",
  unknown: "Il a peut-être été copié en partie seulement. Rien n'a été enregistré. Utilisez le lien de l'e-mail lui-même.",
  failedTitle: "Votre réponse n'a pas pu être enregistrée pour l'instant",
  failed: "Rien n'a été gardé. Réessayez le lien de l'e-mail plus tard.",
  limitedTitle: "Trop de réponses sont venues de cette connexion",
  limited: (n) => `Une connexion peut envoyer au plus ${n} réponses par heure. Rien n'a été gardé. Réessayez le lien de l'e-mail dans une heure.`,
  teamTitle: "Le sondage de votre propre boutique",
  team: "Les réponses du propriétaire et de l'équipe de la boutique ne sont pas comptées : les totaux ne viennent que des lecteurs. Rien n'a été enregistré.",
  previewTitle: "Ceci est un aperçu",
  preview: "Les réponses ne sont enregistrées que depuis l'e-mail reçu par chaque lecteur. Rien n'a été enregistré.",
};

const de: PollWords = {
  emailNote: (name) => `Wähle eine Antwort. Es öffnet sich eine Seite, auf der du sie bestätigst. ${name} sieht nur Summen, nach dem Ende der Umfrage und nur, wenn mindestens ${POLL_MIN_SHOWN} Leser geantwortet haben, nie mit Namen.`,
  title: "Deine Antwort",
  picked: (answer) => `Deine Antwort: ${answer}`,
  send: "Meine Antwort senden",
  others: "Oder wähle eine andere Antwort:",
  once: "Jede Person antwortet einmal. Du kannst deine Antwort später zurücknehmen.",
  privacy: (name) => `${name} sieht nur Summen, nach dem Ende der Umfrage und nur, wenn mindestens ${POLL_MIN_SHOWN} Leser geantwortet haben, nie mit Namen.`,
  thanksTitle: "Danke. Deine Antwort ist gespeichert.",
  thanks: (answer) => `Du hast geantwortet: ${answer}.`,
  alreadyTitle: "Du hast diese Umfrage schon beantwortet",
  already: (answer) => `Deine Antwort: ${answer}. Jede Person antwortet einmal.`,
  withdraw: "Meine Antwort zurücknehmen",
  withdrawnTitle: "Deine Antwort wurde zurückgenommen",
  withdrawn: "Nichts davon wird behalten. Du kannst über die E-Mail erneut antworten, solange die Umfrage offen ist.",
  closedTitle: "Diese Umfrage ist geschlossen",
  closed: "Sie nimmt keine Antworten mehr an. Nichts wurde gespeichert.",
  unknownTitle: "Dieser Link funktioniert nicht",
  unknown: "Er wurde vielleicht nur zum Teil kopiert. Nichts wurde gespeichert. Nutze den Link in der E-Mail selbst.",
  failedTitle: "Deine Antwort konnte gerade nicht gespeichert werden",
  failed: "Nichts wurde gespeichert. Versuche den Link in der E-Mail später noch einmal.",
  limitedTitle: "Zu viele Antworten von dieser Verbindung",
  limited: (n) => `Von einer Verbindung können höchstens ${n} Antworten pro Stunde kommen. Nichts wurde gespeichert. Versuche den Link in der E-Mail in einer Stunde noch einmal.`,
  teamTitle: "Die Umfrage deines eigenen Shops",
  team: "Antworten von Inhaber und Team des Shops werden nicht gezählt, damit die Summen nur von Lesern stammen. Nichts wurde gespeichert.",
  previewTitle: "Das ist eine Vorschau",
  preview: "Antworten werden nur über die E-Mail gespeichert, die eine Leserin oder ein Leser bekommt. Nichts wurde gespeichert.",
};

const it: PollWords = {
  emailNote: (name) => `Scegli una risposta. Si apre una pagina dove la confermi. ${name} vede solo i totali, dopo la chiusura del sondaggio e solo se hanno risposto almeno ${POLL_MIN_SHOWN} lettori, mai con i nomi.`,
  title: "La tua risposta",
  picked: (answer) => `La tua risposta: ${answer}`,
  send: "Invia la mia risposta",
  others: "Oppure scegli un'altra risposta:",
  once: "Ogni persona risponde una volta. Puoi ritirare la tua risposta più tardi.",
  privacy: (name) => `${name} vede solo i totali, dopo la chiusura del sondaggio e solo se hanno risposto almeno ${POLL_MIN_SHOWN} lettori, mai con i nomi.`,
  thanksTitle: "Grazie. La tua risposta è registrata.",
  thanks: (answer) => `Hai risposto: ${answer}.`,
  alreadyTitle: "Hai già risposto a questo sondaggio",
  already: (answer) => `La tua risposta: ${answer}. Ogni persona risponde una volta.`,
  withdraw: "Ritira la mia risposta",
  withdrawnTitle: "La tua risposta è stata ritirata",
  withdrawn: "Non ne resta nulla. Puoi rispondere di nuovo dall'email finché il sondaggio è aperto.",
  closedTitle: "Questo sondaggio è chiuso",
  closed: "Non accetta più risposte. Non è stato registrato nulla.",
  unknownTitle: "Questo link non funziona",
  unknown: "Forse è stato copiato solo in parte. Non è stato registrato nulla. Usa il link nell'email stessa.",
  failedTitle: "Non è stato possibile registrare la tua risposta ora",
  failed: "Non è stato salvato nulla. Riprova il link nell'email più tardi.",
  limitedTitle: "Troppe risposte da questa connessione",
  limited: (n) => `Da una connessione possono arrivare al massimo ${n} risposte all'ora. Non è stato salvato nulla. Riprova il link nell'email tra un'ora.`,
  teamTitle: "Il sondaggio del tuo negozio",
  team: "Le risposte del titolare e del team del negozio non vengono contate, così i totali sono solo dei lettori. Non è stato registrato nulla.",
  previewTitle: "Questa è un'anteprima",
  preview: "Le risposte si registrano solo dall'email che riceve chi legge. Non è stato registrato nulla.",
};

const nl: PollWords = {
  emailNote: (name) => `Kies één antwoord. Er opent een pagina waar je het bevestigt. ${name} ziet alleen totalen, nadat de peiling sluit en alleen als minstens ${POLL_MIN_SHOWN} lezers hebben geantwoord, nooit met namen.`,
  title: "Je antwoord",
  picked: (answer) => `Je antwoord: ${answer}`,
  send: "Mijn antwoord versturen",
  others: "Of kies een ander antwoord:",
  once: "Iedereen antwoordt één keer. Je kunt je antwoord later intrekken.",
  privacy: (name) => `${name} ziet alleen totalen, nadat de peiling sluit en alleen als minstens ${POLL_MIN_SHOWN} lezers hebben geantwoord, nooit met namen.`,
  thanksTitle: "Dank je. Je antwoord is vastgelegd.",
  thanks: (answer) => `Je antwoordde: ${answer}.`,
  alreadyTitle: "Je hebt deze peiling al beantwoord",
  already: (answer) => `Je antwoord: ${answer}. Iedereen antwoordt één keer.`,
  withdraw: "Mijn antwoord intrekken",
  withdrawnTitle: "Je antwoord is ingetrokken",
  withdrawn: "Er wordt niets van bewaard. Je kunt opnieuw antwoorden vanuit de e-mail zolang de peiling open is.",
  closedTitle: "Deze peiling is gesloten",
  closed: "Er worden geen antwoorden meer aangenomen. Er is niets vastgelegd.",
  unknownTitle: "Deze link werkt niet",
  unknown: "Misschien is hij maar half gekopieerd. Er is niets vastgelegd. Gebruik de link in de e-mail zelf.",
  failedTitle: "Je antwoord kon nu niet worden vastgelegd",
  failed: "Er is niets bewaard. Probeer de link in de e-mail later opnieuw.",
  limitedTitle: "Te veel antwoorden via deze verbinding",
  limited: (n) => `Via één verbinding kunnen hoogstens ${n} antwoorden per uur komen. Er is niets bewaard. Probeer de link in de e-mail over een uur opnieuw.`,
  teamTitle: "De peiling van je eigen winkel",
  team: "Antwoorden van de eigenaar en het team van de winkel tellen niet mee, zodat de totalen alleen van lezers zijn. Er is niets vastgelegd.",
  previewTitle: "Dit is een voorbeeld",
  preview: "Antwoorden worden alleen vastgelegd vanuit de e-mail die een lezer krijgt. Er is niets vastgelegd.",
};

const pt: PollWords = {
  emailNote: (name) => `Escolha uma resposta. Abre-se uma página onde a confirma. ${name} só vê totais, depois de a sondagem fechar e só se pelo menos ${POLL_MIN_SHOWN} leitores tiverem respondido, nunca com nomes.`,
  title: "A sua resposta",
  picked: (answer) => `A sua resposta: ${answer}`,
  send: "Enviar a minha resposta",
  others: "Ou escolha outra resposta:",
  once: "Cada pessoa responde uma vez. Pode retirar a sua resposta mais tarde.",
  privacy: (name) => `${name} só vê totais, depois de a sondagem fechar e só se pelo menos ${POLL_MIN_SHOWN} leitores tiverem respondido, nunca com nomes.`,
  thanksTitle: "Obrigado. A sua resposta ficou registada.",
  thanks: (answer) => `Respondeu: ${answer}.`,
  alreadyTitle: "Já respondeu a este inquérito",
  already: (answer) => `A sua resposta: ${answer}. Cada pessoa responde uma vez.`,
  withdraw: "Retirar a minha resposta",
  withdrawnTitle: "A sua resposta foi retirada",
  withdrawn: "Nada dela é guardado. Pode voltar a responder a partir do e-mail enquanto o inquérito estiver aberto.",
  closedTitle: "Este inquérito está fechado",
  closed: "Já não aceita respostas. Nada foi registado.",
  unknownTitle: "Esta ligação não funciona",
  unknown: "Pode ter sido copiada só em parte. Nada foi registado. Use a ligação do próprio e-mail.",
  failedTitle: "Não foi possível registar a sua resposta agora",
  failed: "Nada foi guardado. Volte a tentar a ligação do e-mail mais tarde.",
  limitedTitle: "Chegaram demasiadas respostas desta ligação",
  limited: (n) => `De uma ligação podem chegar no máximo ${n} respostas por hora. Nada foi guardado. Volte a tentar a ligação do e-mail dentro de uma hora.`,
  teamTitle: "A sondagem da sua própria loja",
  team: "As respostas do dono e da equipa da loja não contam, para que os totais sejam só de leitores. Nada foi registado.",
  previewTitle: "Isto é uma pré-visualização",
  preview: "As respostas só são registadas a partir do e-mail que cada leitor recebe. Nada foi registado.",
};

export const POLL_WORDS: Record<LanguageCode, PollWords> = { en, es, fr, de, it, nl, pt };

export function pollWords(language: unknown): PollWords {
  return POLL_WORDS[parseLanguage(language)];
}
