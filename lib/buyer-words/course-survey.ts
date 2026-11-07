/**
 * The words of the survey when a student finishes a course (285 [SX1],
 * lib/course-survey-rules.ts): what a student sees on the course page once
 * they finish it, and what the store's owner sees on the same page, in each
 * language a store can speak. English asks SURVEY_QUESTION word for word.
 *
 * Every language says all English says, nothing added and nothing softened.
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type SurveyNotice = "saved" | "removed" | "score" | "slow" | "full" | "noroom" | "unknown" | "unfinished";

export type CourseSurveyWords = {
  title: string;
  /** The one question, asked over the scores. */
  question: string;
  note: string;
  /** What 0 and 10 mean, shown beside the scores. */
  low: string;
  high: string;
  noteLabel: string;
  noteHint: (max: number) => string;
  save: string;
  remove: string;
  /** Beside a kept answer the form is not shown for: why, and that removing it is still open. */
  removeOnly: string;
  /** The question before a removal, and its two answers. */
  confirm: string;
  confirmYes: string;
  keep: string;
  yours: (score: number) => string;
  notices: Record<SurveyNotice, string>;
  ownerTitle: string;
  ownerNote: string;
  ownerShow: string;
  ownerNone: string;
  average: (average: string, count: number) => string;
  countOf: (score: number, count: number) => string;
  ownerNotes: string;
  noteScore: (score: number) => string;
  ownerUsed: string;
  ownerChanged: string;
  ownerFailed: string;
  ownerNewest: (shown: number) => string;
};

const en: CourseSurveyWords = {
  title: "You finished the course",
  question: "How likely are you to recommend this course to a friend?",
  note: "Optional, one question. Only the creator sees your answer and comment, without your name or email address. It is never shown to other students or on the store. You can remove it at any time, and change it while you have access to the course and have finished it.",
  low: "0 means not at all likely.",
  high: "10 means extremely likely.",
  noteLabel: "Comment (optional)",
  noteHint: (max) => `Up to ${max} characters.`,
  save: "Send my answer",
  remove: "Remove my answer",
  removeOnly: "You can change this answer only while you have access to the course and have finished every lesson. You can always remove it.",
  confirm: "Remove your answer? This cannot be undone.",
  confirmYes: "Yes, remove my answer",
  keep: "Keep my answer",
  yours: (score) => `Your answer: ${score} out of 10.`,
  notices: {
    saved: "Your answer is saved. Thank you.",
    removed: "Your answer is removed.",
    score: "Choose a number from 0 to 10.",
    slow: "Too many answers at once. Wait a minute, then try again.",
    full: "This course cannot take more answers right now.",
    noroom: "The store has no room to keep this right now. Try again later.",
    unknown: "We could not confirm that this went through. Look again in a moment.",
    unfinished: "You can answer once you finish every lesson of the course.",
  },
  ownerTitle: "What students said when they finished",
  ownerNote: "Students who finish this course are asked: “How likely are you to recommend this course to a friend?” Only you see the answers, without students' names. Students never see each other's answers.",
  ownerShow: "Show answers",
  ownerNone: "No answers yet.",
  average: (average, count) => `Average ${average} out of 10, from ${count} ${count === 1 ? "answer" : "answers"}.`,
  countOf: (score, count) => `${score} out of 10: ${count}`,
  ownerNotes: "Comments",
  noteScore: (score) => `${score} out of 10`,
  ownerUsed: "This month's studio requests are used up, so the answers cannot be shown. They are still kept.",
  ownerChanged: "New answers came in while they were loading. Try again.",
  ownerFailed: "The answers could not be read. Try again.",
  ownerNewest: (shown) => `Showing the newest ${shown} comments.`,
};

const es: CourseSurveyWords = {
  title: "Has terminado el curso",
  question: "¿Qué probabilidad hay de que recomiendes este curso a un amigo?",
  note: "Es opcional, una sola pregunta. Solo el creador ve tu respuesta y tu comentario, sin tu nombre ni tu email. Nunca se muestra a otros alumnos ni en la tienda. Puedes quitarla cuando quieras y cambiarla mientras tengas acceso al curso y lo hayas terminado.",
  low: "0 significa nada probable.",
  high: "10 significa muy probable.",
  noteLabel: "Comentario (opcional)",
  noteHint: (max) => `Hasta ${max} caracteres.`,
  save: "Enviar mi respuesta",
  remove: "Quitar mi respuesta",
  removeOnly: "Solo puedes cambiar esta respuesta mientras tengas acceso al curso y hayas terminado todas las lecciones. Siempre puedes quitarla.",
  confirm: "¿Quitar tu respuesta? No se puede deshacer.",
  confirmYes: "Sí, quitar mi respuesta",
  keep: "Mantener mi respuesta",
  yours: (score) => `Tu respuesta: ${score} de 10.`,
  notices: {
    saved: "Tu respuesta está guardada. Gracias.",
    removed: "Tu respuesta se ha quitado.",
    score: "Elige un número del 0 al 10.",
    slow: "Demasiadas respuestas a la vez. Espera un minuto y vuelve a intentarlo.",
    full: "Este curso no puede recibir más respuestas por ahora.",
    noroom: "La tienda no tiene espacio para guardarlo ahora. Inténtalo más tarde.",
    unknown: "No pudimos confirmar que se guardara. Vuelve a mirar en un momento.",
    unfinished: "Podrás responder cuando termines todas las lecciones del curso.",
  },
  ownerTitle: "Lo que dijeron los alumnos al terminar",
  ownerNote: "A quien termina este curso se le pregunta: «¿Qué probabilidad hay de que recomiendes este curso a un amigo?». Solo tú ves las respuestas, sin el nombre de los alumnos. Los alumnos nunca ven las respuestas de los demás.",
  ownerShow: "Mostrar respuestas",
  ownerNone: "Todavía no hay respuestas.",
  average: (average, count) => `Media de ${average} sobre 10, de ${count} ${count === 1 ? "respuesta" : "respuestas"}.`,
  countOf: (score, count) => `${score} de 10: ${count}`,
  ownerNotes: "Comentarios",
  noteScore: (score) => `${score} de 10`,
  ownerUsed: "Las solicitudes del estudio de este mes se han agotado, así que las respuestas no se pueden mostrar. Siguen guardadas.",
  ownerChanged: "Llegaron respuestas nuevas mientras se cargaban. Vuelve a intentarlo.",
  ownerFailed: "No se pudieron leer las respuestas. Vuelve a intentarlo.",
  ownerNewest: (shown) => `Se muestran los ${shown} comentarios más recientes.`,
};

const fr: CourseSurveyWords = {
  title: "Vous avez terminé le cours",
  question: "Quelle est la probabilité que vous recommandiez ce cours à un ami ?",
  note: "Facultatif, une seule question. Seul le créateur voit votre réponse et votre commentaire, sans votre nom ni votre adresse e-mail. Elle n’est jamais montrée aux autres élèves ni sur la boutique. Vous pouvez la retirer à tout moment, et la modifier tant que vous avez accès au cours et l’avez terminé.",
  low: "0 signifie pas du tout probable.",
  high: "10 signifie extrêmement probable.",
  noteLabel: "Commentaire (facultatif)",
  noteHint: (max) => `Jusqu’à ${max} caractères.`,
  save: "Envoyer ma réponse",
  remove: "Retirer ma réponse",
  removeOnly: "Vous ne pouvez modifier cette réponse que tant que vous avez accès au cours et avez terminé toutes les leçons. Vous pouvez toujours la retirer.",
  confirm: "Retirer votre réponse ? Cette action est définitive.",
  confirmYes: "Oui, retirer ma réponse",
  keep: "Garder ma réponse",
  yours: (score) => `Votre réponse : ${score} sur 10.`,
  notices: {
    saved: "Votre réponse est enregistrée. Merci.",
    removed: "Votre réponse est retirée.",
    score: "Choisissez un nombre de 0 à 10.",
    slow: "Trop de réponses à la fois. Attendez une minute, puis réessayez.",
    full: "Ce cours ne peut pas recevoir plus de réponses pour le moment.",
    noroom: "La boutique n’a plus de place pour l’enregistrer pour le moment. Réessayez plus tard.",
    unknown: "Nous n’avons pas pu confirmer l’envoi. Revenez voir dans un instant.",
    unfinished: "Vous pourrez répondre quand vous aurez terminé toutes les leçons du cours.",
  },
  ownerTitle: "Ce que les élèves ont dit en terminant",
  ownerNote: "Les élèves qui terminent ce cours reçoivent la question : « Quelle est la probabilité que vous recommandiez ce cours à un ami ? ». Vous seul voyez les réponses, sans le nom des élèves. Les élèves ne voient jamais les réponses des autres.",
  ownerShow: "Afficher les réponses",
  ownerNone: "Aucune réponse pour l’instant.",
  average: (average, count) => `Moyenne de ${average} sur 10, sur ${count} ${count === 1 ? "réponse" : "réponses"}.`,
  countOf: (score, count) => `${score} sur 10 : ${count}`,
  ownerNotes: "Commentaires",
  noteScore: (score) => `${score} sur 10`,
  ownerUsed: "Les requêtes du studio de ce mois sont épuisées : les réponses ne peuvent pas être affichées. Elles restent enregistrées.",
  ownerChanged: "De nouvelles réponses sont arrivées pendant le chargement. Réessayez.",
  ownerFailed: "Les réponses n’ont pas pu être lues. Réessayez.",
  ownerNewest: (shown) => `Affichage des ${shown} commentaires les plus récents.`,
};

const de: CourseSurveyWords = {
  title: "Sie haben den Kurs abgeschlossen",
  question: "Wie wahrscheinlich ist es, dass Sie diesen Kurs einem Freund empfehlen?",
  note: "Freiwillig, eine einzige Frage. Nur die Person, die den Kurs anbietet, sieht Ihre Antwort und Ihren Kommentar, ohne Ihren Namen und Ihre E-Mail-Adresse. Sie wird nie anderen Teilnehmenden oder im Shop gezeigt. Sie können sie jederzeit entfernen und ändern, solange Sie Zugang zum Kurs haben und ihn abgeschlossen haben.",
  low: "0 bedeutet überhaupt nicht wahrscheinlich.",
  high: "10 bedeutet äußerst wahrscheinlich.",
  noteLabel: "Kommentar (freiwillig)",
  noteHint: (max) => `Bis zu ${max} Zeichen.`,
  save: "Meine Antwort senden",
  remove: "Meine Antwort entfernen",
  removeOnly: "Sie können diese Antwort nur ändern, solange Sie Zugang zum Kurs haben und alle Lektionen abgeschlossen haben. Entfernen können Sie sie immer.",
  confirm: "Ihre Antwort entfernen? Das lässt sich nicht rückgängig machen.",
  confirmYes: "Ja, meine Antwort entfernen",
  keep: "Meine Antwort behalten",
  yours: (score) => `Ihre Antwort: ${score} von 10.`,
  notices: {
    saved: "Ihre Antwort ist gespeichert. Danke.",
    removed: "Ihre Antwort ist entfernt.",
    score: "Wählen Sie eine Zahl von 0 bis 10.",
    slow: "Zu viele Antworten auf einmal. Warten Sie eine Minute und versuchen Sie es dann erneut.",
    full: "Dieser Kurs kann gerade keine weiteren Antworten aufnehmen.",
    noroom: "Der Shop hat gerade keinen Platz, um das zu speichern. Versuchen Sie es später erneut.",
    unknown: "Wir konnten nicht bestätigen, dass es geklappt hat. Sehen Sie gleich noch einmal nach.",
    unfinished: "Sie können antworten, sobald Sie alle Lektionen des Kurses abgeschlossen haben.",
  },
  ownerTitle: "Was Teilnehmende beim Abschluss sagten",
  ownerNote: "Wer diesen Kurs abschließt, wird gefragt: „Wie wahrscheinlich ist es, dass Sie diesen Kurs einem Freund empfehlen?“ Nur Sie sehen die Antworten, ohne die Namen der Teilnehmenden. Teilnehmende sehen nie die Antworten anderer.",
  ownerShow: "Antworten anzeigen",
  ownerNone: "Noch keine Antworten.",
  average: (average, count) => `Durchschnitt ${average} von 10, aus ${count} ${count === 1 ? "Antwort" : "Antworten"}.`,
  countOf: (score, count) => `${score} von 10: ${count}`,
  ownerNotes: "Kommentare",
  noteScore: (score) => `${score} von 10`,
  ownerUsed: "Die Studio-Anfragen dieses Monats sind aufgebraucht, daher können die Antworten nicht angezeigt werden. Sie bleiben gespeichert.",
  ownerChanged: "Während des Ladens sind neue Antworten eingegangen. Versuchen Sie es erneut.",
  ownerFailed: "Die Antworten konnten nicht gelesen werden. Versuchen Sie es erneut.",
  ownerNewest: (shown) => `Angezeigt werden die ${shown} neuesten Kommentare.`,
};

const it: CourseSurveyWords = {
  title: "Hai finito il corso",
  question: "Quanto è probabile che consiglieresti questo corso a un amico?",
  note: "Facoltativo, una sola domanda. Solo il creatore vede la tua risposta e il tuo commento, senza il tuo nome né il tuo indirizzo email. Non viene mai mostrata ad altri studenti né nel negozio. Puoi rimuoverla quando vuoi e cambiarla finché hai accesso al corso e l’hai finito.",
  low: "0 significa per niente probabile.",
  high: "10 significa estremamente probabile.",
  noteLabel: "Commento (facoltativo)",
  noteHint: (max) => `Fino a ${max} caratteri.`,
  save: "Invia la mia risposta",
  remove: "Rimuovi la mia risposta",
  removeOnly: "Puoi cambiare questa risposta solo finché hai accesso al corso e hai finito tutte le lezioni. Puoi sempre rimuoverla.",
  confirm: "Rimuovere la tua risposta? Non si può annullare.",
  confirmYes: "Sì, rimuovi la mia risposta",
  keep: "Tieni la mia risposta",
  yours: (score) => `La tua risposta: ${score} su 10.`,
  notices: {
    saved: "La tua risposta è salvata. Grazie.",
    removed: "La tua risposta è stata rimossa.",
    score: "Scegli un numero da 0 a 10.",
    slow: "Troppe risposte in una volta. Aspetta un minuto, poi riprova.",
    full: "Questo corso non può ricevere altre risposte per ora.",
    noroom: "Il negozio non ha spazio per salvarla ora. Riprova più tardi.",
    unknown: "Non siamo riusciti a confermare l’invio. Controlla di nuovo tra poco.",
    unfinished: "Potrai rispondere quando avrai finito tutte le lezioni del corso.",
  },
  ownerTitle: "Cosa hanno detto gli studenti alla fine",
  ownerNote: "A chi finisce questo corso viene chiesto: «Quanto è probabile che consiglieresti questo corso a un amico?». Solo tu vedi le risposte, senza i nomi degli studenti. Gli studenti non vedono mai le risposte degli altri.",
  ownerShow: "Mostra le risposte",
  ownerNone: "Ancora nessuna risposta.",
  average: (average, count) => `Media di ${average} su 10, da ${count} ${count === 1 ? "risposta" : "risposte"}.`,
  countOf: (score, count) => `${score} su 10: ${count}`,
  ownerNotes: "Commenti",
  noteScore: (score) => `${score} su 10`,
  ownerUsed: "Le richieste dello studio di questo mese sono esaurite, quindi le risposte non si possono mostrare. Restano salvate.",
  ownerChanged: "Sono arrivate nuove risposte durante il caricamento. Riprova.",
  ownerFailed: "Non è stato possibile leggere le risposte. Riprova.",
  ownerNewest: (shown) => `Sono mostrati i ${shown} commenti più recenti.`,
};

const nl: CourseSurveyWords = {
  title: "Je hebt de cursus afgerond",
  question: "Hoe waarschijnlijk is het dat je deze cursus aan een vriend aanraadt?",
  note: "Vrijblijvend, één vraag. Alleen de maker ziet je antwoord en opmerking, zonder je naam of e-mailadres. Het wordt nooit aan andere deelnemers of in de winkel getoond. Je kunt het altijd verwijderen, en wijzigen zolang je toegang tot de cursus hebt en hem hebt afgerond.",
  low: "0 betekent helemaal niet waarschijnlijk.",
  high: "10 betekent heel erg waarschijnlijk.",
  noteLabel: "Opmerking (vrijblijvend)",
  noteHint: (max) => `Maximaal ${max} tekens.`,
  save: "Mijn antwoord versturen",
  remove: "Mijn antwoord verwijderen",
  removeOnly: "Je kunt dit antwoord alleen wijzigen zolang je toegang tot de cursus hebt en alle lessen hebt afgerond. Verwijderen kan altijd.",
  confirm: "Je antwoord verwijderen? Dit kan niet ongedaan worden gemaakt.",
  confirmYes: "Ja, mijn antwoord verwijderen",
  keep: "Mijn antwoord houden",
  yours: (score) => `Jouw antwoord: ${score} van de 10.`,
  notices: {
    saved: "Je antwoord is opgeslagen. Dank je.",
    removed: "Je antwoord is verwijderd.",
    score: "Kies een getal van 0 tot 10.",
    slow: "Te veel antwoorden tegelijk. Wacht een minuut en probeer het dan opnieuw.",
    full: "Deze cursus kan op dit moment geen antwoorden meer aannemen.",
    noroom: "De winkel heeft nu geen ruimte om dit te bewaren. Probeer het later opnieuw.",
    unknown: "We konden niet bevestigen dat het gelukt is. Kijk zo nog eens.",
    unfinished: "Je kunt antwoorden zodra je alle lessen van de cursus hebt afgerond.",
  },
  ownerTitle: "Wat deelnemers zeiden toen ze klaar waren",
  ownerNote: "Wie deze cursus afrondt, krijgt de vraag: ‘Hoe waarschijnlijk is het dat je deze cursus aan een vriend aanraadt?’ Alleen jij ziet de antwoorden, zonder de namen van de deelnemers. Deelnemers zien nooit elkaars antwoorden.",
  ownerShow: "Antwoorden tonen",
  ownerNone: "Nog geen antwoorden.",
  average: (average, count) => `Gemiddeld ${average} van de 10, uit ${count} ${count === 1 ? "antwoord" : "antwoorden"}.`,
  countOf: (score, count) => `${score} van de 10: ${count}`,
  ownerNotes: "Opmerkingen",
  noteScore: (score) => `${score} van de 10`,
  ownerUsed: "De studioverzoeken van deze maand zijn op, dus de antwoorden kunnen niet worden getoond. Ze blijven bewaard.",
  ownerChanged: "Er kwamen nieuwe antwoorden binnen tijdens het laden. Probeer het opnieuw.",
  ownerFailed: "De antwoorden konden niet worden gelezen. Probeer het opnieuw.",
  ownerNewest: (shown) => `De ${shown} nieuwste opmerkingen worden getoond.`,
};

const pt: CourseSurveyWords = {
  title: "Concluiu o curso",
  question: "Qual é a probabilidade de recomendar este curso a um amigo?",
  note: "Opcional, uma só pergunta. Só o criador vê a sua resposta e o seu comentário, sem o seu nome nem o seu e-mail. Nunca é mostrada a outros alunos nem na loja. Pode retirá-la a qualquer momento e alterá-la enquanto tiver acesso ao curso e o tiver concluído.",
  low: "0 significa nada provável.",
  high: "10 significa extremamente provável.",
  noteLabel: "Comentário (opcional)",
  noteHint: (max) => `Até ${max} caracteres.`,
  save: "Enviar a minha resposta",
  remove: "Retirar a minha resposta",
  removeOnly: "Só pode alterar esta resposta enquanto tiver acesso ao curso e tiver concluído todas as aulas. Pode sempre retirá-la.",
  confirm: "Retirar a sua resposta? Não é possível desfazer.",
  confirmYes: "Sim, retirar a minha resposta",
  keep: "Manter a minha resposta",
  yours: (score) => `A sua resposta: ${score} de 10.`,
  notices: {
    saved: "A sua resposta está guardada. Obrigado.",
    removed: "A sua resposta foi retirada.",
    score: "Escolha um número de 0 a 10.",
    slow: "Demasiadas respostas de uma vez. Espere um minuto e tente de novo.",
    full: "Este curso não pode receber mais respostas de momento.",
    noroom: "A loja não tem espaço para guardar isto agora. Tente mais tarde.",
    unknown: "Não foi possível confirmar o envio. Volte a ver daqui a pouco.",
    unfinished: "Poderá responder quando concluir todas as aulas do curso.",
  },
  ownerTitle: "O que os alunos disseram ao concluir",
  ownerNote: "Quem conclui este curso recebe a pergunta: «Qual é a probabilidade de recomendar este curso a um amigo?». As respostas só são visíveis para si, sem os nomes dos alunos. Os alunos nunca veem as respostas dos outros.",
  ownerShow: "Mostrar respostas",
  ownerNone: "Ainda não há respostas.",
  average: (average, count) => `Média de ${average} em 10, de ${count} ${count === 1 ? "resposta" : "respostas"}.`,
  countOf: (score, count) => `${score} de 10: ${count}`,
  ownerNotes: "Comentários",
  noteScore: (score) => `${score} de 10`,
  ownerUsed: "Os pedidos do estúdio deste mês esgotaram-se, por isso as respostas não podem ser mostradas. Continuam guardadas.",
  ownerChanged: "Chegaram respostas novas durante o carregamento. Tente de novo.",
  ownerFailed: "Não foi possível ler as respostas. Tente de novo.",
  ownerNewest: (shown) => `A mostrar os ${shown} comentários mais recentes.`,
};

export const COURSE_SURVEY_WORDS: Record<LanguageCode, CourseSurveyWords> = { en, es, fr, de, it, nl, pt };

export function courseSurveyWords(language: unknown): CourseSurveyWords {
  return COURSE_SURVEY_WORDS[parseLanguage(language)] ?? en;
}
