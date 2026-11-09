/**
 * The words a form on a store's page adds (lib/forms.ts), in every language a
 * store sells in. The questions themselves are the creator's own. Browser-safe.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

/** French spaces its colon with a space that never breaks. */
const S = "\u00a0";

const en = {
  keepLabel: "Keep my answers on this device until I send them",
  keepHelp: "They stay in this browser only and are sent nowhere before you press the button. Leave this off on a shared computer.",
  keepBack: "Your answers kept on this device are back. Check them before you send.",
  notYet: (when: string) => `This form opens on ${when}.`,
  ended: "This form is closed and is not taking answers anymore.",
  send: "Send",
  required: "Required",
  choose: "Choose one",
  /** The box to hear from the creator: empty until checked. */
  hearFrom: (store: string) => `Email me news from ${store}. I can unsubscribe at any time.`,
  doneHeading: "Thank you",
  doneBody: (store: string) => `Your answers were sent to ${store}.`,
  confirmSent: "One more step: we emailed you a button to confirm you want to hear from them.",
  /** The box was checked, but the form's email questions did not show one address as theirs (lib/form-respondent.ts): nobody was asked to join. */
  listUnknown: "We could not tell which email address is yours, so you were not added to the list.",
  result: "Your result",
  /** A scored quiz: the total, and "of" the most possible when that is known. */
  yourScore: "Your score",
  points: (n: number, of: number | null) => `${n} ${n === 1 ? "point" : "points"}${of === null ? "" : ` of ${of}`}`,
  covers: (min: number, max: number) => `This result is for a score from ${min} to ${max}.`,
  seeProduct: "Take a look",
  backTo: (store: string) => `Back to ${store}`,
  errors: {
    required: "Please answer every question marked required.",
    email: "That does not look like an email address.",
    invalid: "One of the answers was not one of the choices. Please try again.",
    limited: "Too many tries for now. Please try again in an hour.",
    closed: "This form is not taking answers right now.",
    noroom: "This store has no room for more answers right now, so yours was not kept. Please try again later.",
    error: "Something went wrong, and nothing was sent. Please try again.",
  },
};

export type FormWords = typeof en;

const es: FormWords = {
  keepLabel: "Guardar mis respuestas en este dispositivo hasta que las envíe",
  keepHelp: "Se quedan solo en este navegador y no se envían a ningún sitio antes de pulsar el botón. No lo actives en un ordenador compartido.",
  keepBack: "Tus respuestas guardadas en este dispositivo han vuelto. Revísalas antes de enviar.",
  notYet: (when: string) => `Este formulario se abre el ${when}.`,
  ended: "Este formulario está cerrado y ya no recibe respuestas.",
  send: "Enviar",
  required: "Obligatorio",
  choose: "Elige una opción",
  hearFrom: (store) => `Quiero recibir novedades de ${store} por email. Puedo darme de baja cuando quiera.`,
  doneHeading: "Gracias",
  doneBody: (store) => `Tus respuestas se enviaron a ${store}.`,
  confirmSent: "Un paso más: te enviamos un email con un botón para confirmar que quieres recibir sus novedades.",
  listUnknown: "No pudimos saber cuál es tu dirección de email, así que no te añadimos a la lista.",
  result: "Tu resultado",
  yourScore: "Tu puntuación",
  points: (n, of) => `${n} ${n === 1 ? "punto" : "puntos"}${of === null ? "" : ` de ${of}`}`,
  covers: (min, max) => `Este resultado corresponde a una puntuación de ${min} a ${max}.`,
  seeProduct: "Echar un vistazo",
  backTo: (store) => `Volver a ${store}`,
  errors: {
    required: "Responde todas las preguntas marcadas como obligatorias.",
    email: "Eso no parece una dirección de email.",
    invalid: "Una de las respuestas no estaba entre las opciones. Inténtalo de nuevo.",
    limited: "Demasiados intentos por ahora. Inténtalo de nuevo en una hora.",
    closed: "Este formulario no acepta respuestas en este momento.",
    noroom: "Esta tienda no tiene espacio para más respuestas ahora mismo, así que la tuya no se guardó. Inténtalo de nuevo más tarde.",
    error: "Algo salió mal y no se envió nada. Inténtalo de nuevo.",
  },
};

const fr: FormWords = {
  keepLabel: "Garder mes réponses sur cet appareil jusqu’à ce que je les envoie",
  keepHelp: "Elles restent dans ce navigateur seulement et ne sont envoyées nulle part avant que vous appuyiez sur le bouton. Laissez cette case vide sur un ordinateur partagé.",
  keepBack: "Vos réponses gardées sur cet appareil sont revenues. Vérifiez-les avant d’envoyer.",
  notYet: (when: string) => `Ce formulaire ouvre le ${when}.`,
  ended: "Ce formulaire est fermé et ne reçoit plus de réponses.",
  send: "Envoyer",
  required: "Obligatoire",
  choose: "Choisissez une option",
  hearFrom: (store) => `Je veux recevoir les nouvelles de ${store} par email. Je peux me désinscrire à tout moment.`,
  doneHeading: "Merci",
  doneBody: (store) => `Vos réponses ont été envoyées à ${store}.`,
  confirmSent: `Encore une étape${S}: nous vous avons envoyé un email avec un bouton pour confirmer que vous voulez recevoir leurs nouvelles.`,
  listUnknown: "Nous n’avons pas pu savoir quelle adresse email est la vôtre, donc l’inscription à la liste n’a pas été faite.",
  result: "Votre résultat",
  yourScore: "Votre score",
  points: (n, of) => `${n} ${n <= 1 ? "point" : "points"}${of === null ? "" : ` sur ${of}`}`,
  covers: (min, max) => `Ce résultat correspond à un score de ${min} à ${max}.`,
  seeProduct: "Découvrir",
  backTo: (store) => `Retour à ${store}`,
  errors: {
    required: "Répondez à toutes les questions marquées comme obligatoires.",
    email: "Cela ne ressemble pas à une adresse email.",
    invalid: "L'une des réponses ne faisait pas partie des choix. Réessayez.",
    limited: "Trop de tentatives pour le moment. Réessayez dans une heure.",
    closed: "Ce formulaire n'accepte pas de réponses pour le moment.",
    noroom: "Cette boutique n'a pas de place pour d'autres réponses en ce moment, donc la vôtre n'a pas été enregistrée. Réessayez plus tard.",
    error: "Une erreur s'est produite et rien n'a été envoyé. Réessayez.",
  },
};

const de: FormWords = {
  keepLabel: "Meine Antworten auf diesem Gerät behalten, bis ich sie sende",
  keepHelp: "Sie bleiben nur in diesem Browser und werden nirgendwohin gesendet, bevor Sie auf die Schaltfläche drücken. Auf einem gemeinsam genutzten Computer nicht aktivieren.",
  keepBack: "Ihre auf diesem Gerät behaltenen Antworten sind wieder da. Prüfen Sie sie vor dem Senden.",
  notYet: (when: string) => `Dieses Formular öffnet am ${when}.`,
  ended: "Dieses Formular ist geschlossen und nimmt keine Antworten mehr an.",
  send: "Senden",
  required: "Pflichtfeld",
  choose: "Bitte wählen",
  hearFrom: (store) => `Ich möchte Neuigkeiten von ${store} per E-Mail erhalten. Ich kann mich jederzeit abmelden.`,
  doneHeading: "Vielen Dank",
  doneBody: (store) => `Ihre Antworten wurden an ${store} gesendet.`,
  confirmSent: "Noch ein Schritt: Wir haben Ihnen eine E-Mail mit einer Schaltfläche geschickt, mit der Sie bestätigen, dass Sie Neuigkeiten erhalten möchten.",
  listUnknown: "Wir konnten nicht erkennen, welche E-Mail-Adresse Ihre ist, deshalb wurden Sie nicht in die Liste aufgenommen.",
  result: "Ihr Ergebnis",
  yourScore: "Ihre Punktzahl",
  points: (n, of) => `${n} ${n === 1 ? "Punkt" : "Punkte"}${of === null ? "" : ` von ${of}`}`,
  covers: (min, max) => `Dieses Ergebnis gilt für eine Punktzahl von ${min} bis ${max}.`,
  seeProduct: "Ansehen",
  backTo: (store) => `Zurück zu ${store}`,
  errors: {
    required: "Bitte beantworten Sie alle als Pflichtfeld markierten Fragen.",
    email: "Das sieht nicht nach einer E-Mail-Adresse aus.",
    invalid: "Eine der Antworten war keine der Auswahlmöglichkeiten. Bitte versuchen Sie es erneut.",
    limited: "Zu viele Versuche für den Moment. Bitte versuchen Sie es in einer Stunde erneut.",
    closed: "Dieses Formular nimmt im Moment keine Antworten an.",
    noroom: "Dieser Shop hat gerade keinen Platz für weitere Antworten, deshalb wurde Ihre nicht gespeichert. Bitte versuchen Sie es später erneut.",
    error: "Etwas ist schiefgegangen, und es wurde nichts gesendet. Bitte versuchen Sie es erneut.",
  },
};

const it: FormWords = {
  keepLabel: "Conserva le mie risposte su questo dispositivo finché non le invio",
  keepHelp: "Restano solo in questo browser e non vengono inviate da nessuna parte prima che tu prema il pulsante. Lascialo spento su un computer condiviso.",
  keepBack: "Le risposte conservate su questo dispositivo sono tornate. Controllale prima di inviare.",
  notYet: (when: string) => `Questo modulo apre il ${when}.`,
  ended: "Questo modulo è chiuso e non accetta più risposte.",
  send: "Invia",
  required: "Obbligatorio",
  choose: "Scegli un'opzione",
  hearFrom: (store) => `Voglio ricevere novità da ${store} via email. Posso disiscrivermi quando voglio.`,
  doneHeading: "Grazie",
  doneBody: (store) => `Le tue risposte sono state inviate a ${store}.`,
  confirmSent: "Ancora un passo: ti abbiamo inviato un'email con un pulsante per confermare che vuoi ricevere le sue novità.",
  listUnknown: "Non siamo riusciti a capire quale indirizzo email è il tuo, quindi l'iscrizione alla lista non è stata fatta.",
  result: "Il tuo risultato",
  yourScore: "Il tuo punteggio",
  points: (n, of) => `${n} ${n === 1 ? "punto" : "punti"}${of === null ? "" : ` su ${of}`}`,
  covers: (min, max) => `Questo risultato corrisponde a un punteggio da ${min} a ${max}.`,
  seeProduct: "Dai un'occhiata",
  backTo: (store) => `Torna a ${store}`,
  errors: {
    required: "Rispondi a tutte le domande segnate come obbligatorie.",
    email: "Non sembra un indirizzo email.",
    invalid: "Una delle risposte non era tra le opzioni. Riprova.",
    limited: "Troppi tentativi per ora. Riprova tra un'ora.",
    closed: "Questo modulo al momento non accetta risposte.",
    noroom: "Questo negozio non ha spazio per altre risposte in questo momento, quindi la tua non è stata salvata. Riprova più tardi.",
    error: "Qualcosa è andato storto e non è stato inviato nulla. Riprova.",
  },
};

const nl: FormWords = {
  keepLabel: "Mijn antwoorden op dit apparaat bewaren tot ik ze verstuur",
  keepHelp: "Ze blijven alleen in deze browser en worden nergens heen gestuurd voordat je op de knop drukt. Zet dit niet aan op een gedeelde computer.",
  keepBack: "Je antwoorden die op dit apparaat bewaard waren, zijn terug. Controleer ze voordat je verstuurt.",
  notYet: (when: string) => `Dit formulier gaat open op ${when}.`,
  ended: "Dit formulier is gesloten en neemt geen antwoorden meer aan.",
  send: "Versturen",
  required: "Verplicht",
  choose: "Kies er één",
  hearFrom: (store) => `Ik wil nieuws van ${store} per e-mail ontvangen. Ik kan me altijd afmelden.`,
  doneHeading: "Bedankt",
  doneBody: (store) => `Je antwoorden zijn naar ${store} gestuurd.`,
  confirmSent: "Nog één stap: we hebben je een e-mail gestuurd met een knop om te bevestigen dat je hun nieuws wilt ontvangen.",
  listUnknown: "We konden niet zien welk e-mailadres van jou is, dus je bent niet aan de lijst toegevoegd.",
  result: "Jouw resultaat",
  yourScore: "Jouw score",
  points: (n, of) => `${n} ${n === 1 ? "punt" : "punten"}${of === null ? "" : ` van ${of}`}`,
  covers: (min, max) => `Dit resultaat hoort bij een score van ${min} tot ${max}.`,
  seeProduct: "Bekijken",
  backTo: (store) => `Terug naar ${store}`,
  errors: {
    required: "Beantwoord alle vragen die als verplicht zijn gemarkeerd.",
    email: "Dat lijkt geen e-mailadres.",
    invalid: "Een van de antwoorden was geen van de keuzes. Probeer het opnieuw.",
    limited: "Te veel pogingen voor nu. Probeer het over een uur opnieuw.",
    closed: "Dit formulier neemt op dit moment geen antwoorden aan.",
    noroom: "Deze winkel heeft nu geen ruimte voor meer antwoorden, dus het jouwe is niet bewaard. Probeer het later opnieuw.",
    error: "Er ging iets mis en er is niets verstuurd. Probeer het opnieuw.",
  },
};

const pt: FormWords = {
  keepLabel: "Guardar minhas respostas neste aparelho até eu enviá-las",
  keepHelp: "Elas ficam só neste navegador e não são enviadas a lugar nenhum antes de você apertar o botão. Deixe desligado num computador compartilhado.",
  keepBack: "Suas respostas guardadas neste aparelho voltaram. Confira antes de enviar.",
  notYet: (when: string) => `Este formulário abre em ${when}.`,
  ended: "Este formulário está fechado e não recebe mais respostas.",
  send: "Enviar",
  required: "Obrigatório",
  choose: "Escolha uma opção",
  hearFrom: (store) => `Quero receber novidades de ${store} por email. Posso cancelar a qualquer momento.`,
  doneHeading: "Obrigado",
  doneBody: (store) => `As suas respostas foram enviadas a ${store}.`,
  confirmSent: "Só mais um passo: enviámos-lhe um email com um botão para confirmar que quer receber as novidades.",
  listUnknown: "Não conseguimos saber qual é o seu endereço de email, por isso a inscrição na lista não foi feita.",
  result: "O seu resultado",
  yourScore: "A sua pontuação",
  points: (n, of) => `${n} ${n === 1 ? "ponto" : "pontos"}${of === null ? "" : ` de ${of}`}`,
  covers: (min, max) => `Este resultado corresponde a uma pontuação de ${min} a ${max}.`,
  seeProduct: "Ver",
  backTo: (store) => `Voltar a ${store}`,
  errors: {
    required: "Responda a todas as perguntas marcadas como obrigatórias.",
    email: "Isso não parece um endereço de email.",
    invalid: "Uma das respostas não estava entre as opções. Tente novamente.",
    limited: "Demasiadas tentativas por agora. Tente novamente daqui a uma hora.",
    closed: "Este formulário não está a aceitar respostas neste momento.",
    noroom: "Esta loja não tem espaço para mais respostas neste momento, por isso a sua não foi guardada. Tente novamente mais tarde.",
    error: "Algo correu mal e nada foi enviado. Tente novamente.",
  },
};

export const FORM_WORDS: Record<LanguageCode, FormWords> = { en, es, fr, de, it, nl, pt };

export function formWords(language: unknown): FormWords {
  return FORM_WORDS[parseLanguage(language)];
}
