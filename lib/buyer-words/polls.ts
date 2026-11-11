/**
 * The words of the page a poll link in a store's email opens (125
 * [F2-EMAIL-POLLS], unit 5; app/poll/page.tsx), in every language a store
 * sells in. Only the press of Confirm counts an answer, and the page says so.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const en = {
  title: "Answer a poll",
  from: (who: string) => `A poll from ${who}`,
  pick: "Your answer",
  confirm: "Confirm my answer",
  takeBack: "Take back my answer",
  openedNothing: "Opening this page counted nothing. Your answer is counted only when you press Confirm.",
  until: (date: string) => `You can change or take back your answer until ${date}.`,
  totalsOnly: "The sender sees only the totals, never who answered what.",
  recorded: "Your answer is counted. You can change it or take it back here while the poll is open.",
  withdrawn: "Your answer is taken back. Nothing of yours is counted in this poll.",
  closedTitle: "This poll has closed",
  closed: "Answers can no longer be given, changed or taken back.",
  unknownLinkTitle: "We do not know this poll link",
  unknownLink: "It may have been copied only in part. Nothing was counted.",
  resting: "This store cannot take answers just now. Nothing was counted.",
  notSaved: "We could not save that just now. Nothing was counted. Please try again in a minute.",
  unreadTitle: "This poll could not be opened just now",
  unread: "Nothing was counted. Please try again in a minute.",
};

export type PollWords = typeof en;

const es: PollWords = {
  title: "Responder una encuesta",
  from: (who) => `Una encuesta de ${who}`,
  pick: "Tu respuesta",
  confirm: "Confirmar mi respuesta",
  takeBack: "Retirar mi respuesta",
  openedNothing: "Abrir esta página no contó nada. Tu respuesta solo cuenta cuando pulsas Confirmar.",
  until: (date) => `Puedes cambiar o retirar tu respuesta hasta el ${date}.`,
  totalsOnly: "Quien la envió solo ve los totales, nunca quién respondió qué.",
  recorded: "Tu respuesta se ha contado. Puedes cambiarla o retirarla aquí mientras la encuesta esté abierta.",
  withdrawn: "Tu respuesta se ha retirado. No se cuenta nada tuyo en esta encuesta.",
  closedTitle: "Esta encuesta ha cerrado",
  closed: "Ya no se pueden dar, cambiar ni retirar respuestas.",
  unknownLinkTitle: "No conocemos este enlace de encuesta",
  unknownLink: "Puede que se haya copiado solo en parte. No se contó nada.",
  resting: "Esta tienda no puede recibir respuestas ahora. No se contó nada.",
  notSaved: "No pudimos guardarlo ahora. No se contó nada. Inténtalo de nuevo en un minuto.",
  unreadTitle: "No se pudo abrir esta encuesta ahora",
  unread: "No se contó nada. Inténtalo de nuevo en un minuto.",
};

const fr: PollWords = {
  title: "Répondre à un sondage",
  from: (who) => `Un sondage de ${who}`,
  pick: "Votre réponse",
  confirm: "Confirmer ma réponse",
  takeBack: "Retirer ma réponse",
  openedNothing: "Ouvrir cette page n'a rien compté. Votre réponse n'est comptée que lorsque vous appuyez sur Confirmer.",
  until: (date) => `Vous pouvez modifier ou retirer votre réponse jusqu'au ${date}.`,
  totalsOnly: "L'expéditeur ne voit que les totaux, jamais qui a répondu quoi.",
  recorded: "Votre réponse est comptée. Vous pouvez la modifier ou la retirer ici tant que le sondage est ouvert.",
  withdrawn: "Votre réponse est retirée. Rien de vous n'est compté dans ce sondage.",
  closedTitle: "Ce sondage est fermé",
  closed: "Les réponses ne peuvent plus être données, modifiées ni retirées.",
  unknownLinkTitle: "Nous ne connaissons pas ce lien de sondage",
  unknownLink: "Il a peut-être été copié en partie seulement. Rien n'a été compté.",
  resting: "Cette boutique ne peut pas recevoir de réponses pour l'instant. Rien n'a été compté.",
  notSaved: "Nous n'avons pas pu l'enregistrer pour l'instant. Rien n'a été compté. Réessayez dans une minute.",
  unreadTitle: "Ce sondage n'a pas pu être ouvert pour l'instant",
  unread: "Rien n'a été compté. Réessayez dans une minute.",
};

const de: PollWords = {
  title: "Eine Umfrage beantworten",
  from: (who) => `Eine Umfrage von ${who}`,
  pick: "Ihre Antwort",
  confirm: "Meine Antwort bestätigen",
  takeBack: "Meine Antwort zurückziehen",
  openedNothing: "Das Öffnen dieser Seite hat nichts gezählt. Ihre Antwort zählt erst, wenn Sie auf Bestätigen drücken.",
  until: (date) => `Sie können Ihre Antwort bis zum ${date} ändern oder zurückziehen.`,
  totalsOnly: "Der Absender sieht nur die Summen, nie, wer was geantwortet hat.",
  recorded: "Ihre Antwort wurde gezählt. Solange die Umfrage offen ist, können Sie sie hier ändern oder zurückziehen.",
  withdrawn: "Ihre Antwort wurde zurückgezogen. Von Ihnen wird in dieser Umfrage nichts gezählt.",
  closedTitle: "Diese Umfrage ist beendet",
  closed: "Antworten können nicht mehr abgegeben, geändert oder zurückgezogen werden.",
  unknownLinkTitle: "Diesen Umfrage-Link kennen wir nicht",
  unknownLink: "Er wurde vielleicht nur teilweise kopiert. Es wurde nichts gezählt.",
  resting: "Dieser Shop kann gerade keine Antworten annehmen. Es wurde nichts gezählt.",
  notSaved: "Das konnten wir gerade nicht speichern. Es wurde nichts gezählt. Bitte versuchen Sie es in einer Minute erneut.",
  unreadTitle: "Diese Umfrage konnte gerade nicht geöffnet werden",
  unread: "Es wurde nichts gezählt. Bitte versuchen Sie es in einer Minute erneut.",
};

const it: PollWords = {
  title: "Rispondi a un sondaggio",
  from: (who) => `Un sondaggio di ${who}`,
  pick: "La tua risposta",
  confirm: "Conferma la mia risposta",
  takeBack: "Ritira la mia risposta",
  openedNothing: "Aprire questa pagina non ha contato nulla. La tua risposta conta solo quando premi Conferma.",
  until: (date) => `Puoi cambiare o ritirare la tua risposta fino al ${date}.`,
  totalsOnly: "Chi l'ha inviato vede solo i totali, mai chi ha risposto cosa.",
  recorded: "La tua risposta è stata contata. Puoi cambiarla o ritirarla qui finché il sondaggio è aperto.",
  withdrawn: "La tua risposta è stata ritirata. In questo sondaggio non si conta nulla di tuo.",
  closedTitle: "Questo sondaggio è chiuso",
  closed: "Non si possono più dare, cambiare o ritirare risposte.",
  unknownLinkTitle: "Non conosciamo questo link del sondaggio",
  unknownLink: "Forse è stato copiato solo in parte. Non è stato contato nulla.",
  resting: "Questo negozio non può ricevere risposte in questo momento. Non è stato contato nulla.",
  notSaved: "Non siamo riusciti a salvarlo ora. Non è stato contato nulla. Riprova tra un minuto.",
  unreadTitle: "Questo sondaggio non si è potuto aprire ora",
  unread: "Non è stato contato nulla. Riprova tra un minuto.",
};

const nl: PollWords = {
  title: "Een peiling beantwoorden",
  from: (who) => `Een peiling van ${who}`,
  pick: "Je antwoord",
  confirm: "Mijn antwoord bevestigen",
  takeBack: "Mijn antwoord intrekken",
  openedNothing: "Het openen van deze pagina telde niets. Je antwoord telt pas als je op Bevestigen drukt.",
  until: (date) => `Je kunt je antwoord tot ${date} wijzigen of intrekken.`,
  totalsOnly: "De afzender ziet alleen de totalen, nooit wie wat heeft geantwoord.",
  recorded: "Je antwoord is geteld. Zolang de peiling open is, kun je het hier wijzigen of intrekken.",
  withdrawn: "Je antwoord is ingetrokken. Er telt niets van jou mee in deze peiling.",
  closedTitle: "Deze peiling is gesloten",
  closed: "Antwoorden kunnen niet meer worden gegeven, gewijzigd of ingetrokken.",
  unknownLinkTitle: "Deze peilingslink kennen we niet",
  unknownLink: "Misschien is hij maar half gekopieerd. Er is niets geteld.",
  resting: "Deze winkel kan nu geen antwoorden aannemen. Er is niets geteld.",
  notSaved: "We konden het nu niet opslaan. Er is niets geteld. Probeer het over een minuut opnieuw.",
  unreadTitle: "Deze peiling kon nu niet worden geopend",
  unread: "Er is niets geteld. Probeer het over een minuut opnieuw.",
};

const pt: PollWords = {
  title: "Responder a uma sondagem",
  from: (who) => `Uma sondagem de ${who}`,
  pick: "A sua resposta",
  confirm: "Confirmar a minha resposta",
  takeBack: "Retirar a minha resposta",
  openedNothing: "Abrir esta página não contou nada. A sua resposta só conta quando carregar em Confirmar.",
  until: (date) => `Pode alterar ou retirar a sua resposta até ${date}.`,
  totalsOnly: "Quem a enviou só vê os totais, nunca quem respondeu o quê.",
  recorded: "A sua resposta foi contada. Pode alterá-la ou retirá-la aqui enquanto a sondagem estiver aberta.",
  withdrawn: "A sua resposta foi retirada. Nada seu é contado nesta sondagem.",
  closedTitle: "Esta sondagem terminou",
  closed: "Já não é possível dar, alterar ou retirar respostas.",
  unknownLinkTitle: "Não conhecemos esta ligação de sondagem",
  unknownLink: "Talvez tenha sido copiada só em parte. Nada foi contado.",
  resting: "Esta loja não pode receber respostas agora. Nada foi contado.",
  notSaved: "Não foi possível guardar agora. Nada foi contado. Tente novamente dentro de um minuto.",
  unreadTitle: "Não foi possível abrir esta sondagem agora",
  unread: "Nada foi contado. Tente novamente dentro de um minuto.",
};

const POLL_WORDS: Record<LanguageCode, PollWords> = { en, es, fr, de, it, nl, pt };

/** The poll page's words in a store's language; English for one not known. */
export function pollWords(language: unknown): PollWords {
  return POLL_WORDS[parseLanguage(language)];
}
