/**
 * The words around a poll in a store's email and on the page where a reader
 * confirms an answer (lib/mail-poll.ts, app/poll), in each language a store
 * can speak. The question and the answers are the creator's own words.
 *
 * Browser-safe: plain data, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

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
  /** Who sees what, on every page. */
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
  previewTitle: string;
  preview: string;
};

const en: PollWords = {
  emailNote: (name) => `Pick one answer. A page opens where you confirm it. ${name} sees only how many people picked each answer, never who picked what.`,
  title: "Your answer",
  picked: (answer) => `Your answer: ${answer}`,
  send: "Send my answer",
  others: "Or pick another answer:",
  once: "Each person answers once. You can take your answer back later.",
  privacy: (name) => `${name} sees only how many people picked each answer, never who picked what.`,
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
  previewTitle: "This is a preview",
  preview: "Answers are recorded only from the email a reader gets. Nothing was recorded.",
};

const es: PollWords = {
  emailNote: (name) => `Elige una respuesta. Se abre una página donde la confirmas. ${name} solo ve cuántas personas eligieron cada respuesta, nunca quién eligió qué.`,
  title: "Tu respuesta",
  picked: (answer) => `Tu respuesta: ${answer}`,
  send: "Enviar mi respuesta",
  others: "O elige otra respuesta:",
  once: "Cada persona responde una vez. Puedes retirar tu respuesta más tarde.",
  privacy: (name) => `${name} solo ve cuántas personas eligieron cada respuesta, nunca quién eligió qué.`,
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
  previewTitle: "Esto es una vista previa",
  preview: "Las respuestas solo se registran desde el correo que recibe cada lector. No se registró nada.",
};

const fr: PollWords = {
  emailNote: (name) => `Choisissez une réponse. Une page s'ouvre pour la confirmer. ${name} voit seulement combien de personnes ont choisi chaque réponse, jamais qui a choisi quoi.`,
  title: "Votre réponse",
  picked: (answer) => `Votre réponse : ${answer}`,
  send: "Envoyer ma réponse",
  others: "Ou choisissez une autre réponse :",
  once: "Chaque personne répond une fois. Vous pourrez retirer votre réponse plus tard.",
  privacy: (name) => `${name} voit seulement combien de personnes ont choisi chaque réponse, jamais qui a choisi quoi.`,
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
  previewTitle: "Ceci est un aperçu",
  preview: "Les réponses ne sont enregistrées que depuis l'e-mail reçu par chaque lecteur. Rien n'a été enregistré.",
};

const de: PollWords = {
  emailNote: (name) => `Wähle eine Antwort. Es öffnet sich eine Seite, auf der du sie bestätigst. ${name} sieht nur, wie viele Personen welche Antwort gewählt haben, nie, wer was gewählt hat.`,
  title: "Deine Antwort",
  picked: (answer) => `Deine Antwort: ${answer}`,
  send: "Meine Antwort senden",
  others: "Oder wähle eine andere Antwort:",
  once: "Jede Person antwortet einmal. Du kannst deine Antwort später zurücknehmen.",
  privacy: (name) => `${name} sieht nur, wie viele Personen welche Antwort gewählt haben, nie, wer was gewählt hat.`,
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
  previewTitle: "Das ist eine Vorschau",
  preview: "Antworten werden nur über die E-Mail gespeichert, die eine Leserin oder ein Leser bekommt. Nichts wurde gespeichert.",
};

const it: PollWords = {
  emailNote: (name) => `Scegli una risposta. Si apre una pagina dove la confermi. ${name} vede solo quante persone hanno scelto ogni risposta, mai chi ha scelto cosa.`,
  title: "La tua risposta",
  picked: (answer) => `La tua risposta: ${answer}`,
  send: "Invia la mia risposta",
  others: "Oppure scegli un'altra risposta:",
  once: "Ogni persona risponde una volta. Puoi ritirare la tua risposta più tardi.",
  privacy: (name) => `${name} vede solo quante persone hanno scelto ogni risposta, mai chi ha scelto cosa.`,
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
  previewTitle: "Questa è un'anteprima",
  preview: "Le risposte si registrano solo dall'email che riceve chi legge. Non è stato registrato nulla.",
};

const nl: PollWords = {
  emailNote: (name) => `Kies één antwoord. Er opent een pagina waar je het bevestigt. ${name} ziet alleen hoeveel mensen elk antwoord kozen, nooit wie wat koos.`,
  title: "Je antwoord",
  picked: (answer) => `Je antwoord: ${answer}`,
  send: "Mijn antwoord versturen",
  others: "Of kies een ander antwoord:",
  once: "Iedereen antwoordt één keer. Je kunt je antwoord later intrekken.",
  privacy: (name) => `${name} ziet alleen hoeveel mensen elk antwoord kozen, nooit wie wat koos.`,
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
  previewTitle: "Dit is een voorbeeld",
  preview: "Antwoorden worden alleen vastgelegd vanuit de e-mail die een lezer krijgt. Er is niets vastgelegd.",
};

const pt: PollWords = {
  emailNote: (name) => `Escolha uma resposta. Abre-se uma página onde a confirma. ${name} só vê quantas pessoas escolheram cada resposta, nunca quem escolheu o quê.`,
  title: "A sua resposta",
  picked: (answer) => `A sua resposta: ${answer}`,
  send: "Enviar a minha resposta",
  others: "Ou escolha outra resposta:",
  once: "Cada pessoa responde uma vez. Pode retirar a sua resposta mais tarde.",
  privacy: (name) => `${name} só vê quantas pessoas escolheram cada resposta, nunca quem escolheu o quê.`,
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
  previewTitle: "Isto é uma pré-visualização",
  preview: "As respostas só são registadas a partir do e-mail que cada leitor recebe. Nada foi registado.",
};

export const POLL_WORDS: Record<LanguageCode, PollWords> = { en, es, fr, de, it, nl, pt };

export function pollWords(language: unknown): PollWords {
  return POLL_WORDS[parseLanguage(language)];
}
