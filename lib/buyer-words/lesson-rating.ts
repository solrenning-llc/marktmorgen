/**
 * The words of a lesson's quick rating (296 [SQ7], lib/lesson-rating-rules.ts):
 * what a student sees at the end of a lesson, and what the store's owner sees
 * on the same page, in each language a store can speak.
 *
 * Every language says all English says, nothing added and nothing softened.
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type RatingNotice = "saved" | "removed" | "score" | "slow" | "full" | "noroom" | "unknown";

export type LessonRatingWords = {
  title: string;
  note: string;
  legend: string;
  /** The names of 1 to 5, in order. */
  scores: [string, string, string, string, string];
  noteLabel: string;
  noteHint: (max: number) => string;
  save: string;
  remove: string;
  yours: (score: number) => string;
  notices: Record<RatingNotice, string>;
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

const en: LessonRatingWords = {
  title: "Rate this lesson",
  note: "Optional. Only the creator sees your rating and comment, without your name or email address. You can change or remove it here while this lesson is open to you. If you ask the store to delete your data, it is removed too.",
  legend: "How useful was this lesson?",
  scores: ["1 – Not useful", "2 – A little useful", "3 – Useful", "4 – Very useful", "5 – Extremely useful"],
  noteLabel: "Comment (optional)",
  noteHint: (max) => `Up to ${max} characters.`,
  save: "Save my rating",
  remove: "Remove my rating",
  yours: (score) => `Your rating: ${score} out of 5.`,
  notices: {
    saved: "Your rating is saved.",
    removed: "Your rating is removed.",
    score: "Choose a number from 1 to 5.",
    slow: "Too many ratings at once. Wait a minute, then try again.",
    full: "This lesson cannot take more ratings right now.",
    noroom: "The store has no room to keep this right now. Try again later.",
    unknown: "We could not confirm that this went through. Look again in a moment.",
  },
  ownerTitle: "Ratings of this lesson",
  ownerNote: "Only you see these, without students' names. Students never see each other's ratings.",
  ownerShow: "Show ratings",
  ownerNone: "No ratings yet.",
  average: (average, count) => `Average ${average} out of 5, from ${count} ${count === 1 ? "rating" : "ratings"}.`,
  countOf: (score, count) => `${score} out of 5: ${count}`,
  ownerNotes: "Comments",
  noteScore: (score) => `${score} out of 5`,
  ownerUsed: "This month's studio requests are used up, so the ratings cannot be shown. They are still kept.",
  ownerChanged: "New ratings came in while they were loading. Try again.",
  ownerFailed: "The ratings could not be read. Try again.",
  ownerNewest: (shown) => `Showing the newest ${shown} comments.`,
};

const es: LessonRatingWords = {
  title: "Valora esta lección",
  note: "Es opcional. Solo el creador ve tu valoración y tu comentario, sin tu nombre ni tu email. Puedes cambiarla o quitarla aquí mientras esta lección esté abierta para ti. Si pides a la tienda que borre tus datos, también se quita.",
  legend: "¿Qué tan útil fue esta lección?",
  scores: ["1 – Nada útil", "2 – Poco útil", "3 – Útil", "4 – Muy útil", "5 – Extremadamente útil"],
  noteLabel: "Comentario (opcional)",
  noteHint: (max) => `Hasta ${max} caracteres.`,
  save: "Guardar mi valoración",
  remove: "Quitar mi valoración",
  yours: (score) => `Tu valoración: ${score} de 5.`,
  notices: {
    saved: "Tu valoración está guardada.",
    removed: "Tu valoración se ha quitado.",
    score: "Elige un número del 1 al 5.",
    slow: "Demasiadas valoraciones a la vez. Espera un minuto y vuelve a intentarlo.",
    full: "Esta lección no puede recibir más valoraciones por ahora.",
    noroom: "La tienda no tiene espacio para guardarlo ahora. Inténtalo más tarde.",
    unknown: "No pudimos confirmar que se guardara. Vuelve a mirar en un momento.",
  },
  ownerTitle: "Valoraciones de esta lección",
  ownerNote: "Solo tú las ves, sin los nombres de los alumnos. Los alumnos nunca ven las valoraciones de otros.",
  ownerShow: "Ver valoraciones",
  ownerNone: "Todavía no hay valoraciones.",
  average: (average, count) => `Media de ${average} de 5, con ${count} ${count === 1 ? "valoración" : "valoraciones"}.`,
  countOf: (score, count) => `${score} de 5: ${count}`,
  ownerNotes: "Comentarios",
  noteScore: (score) => `${score} de 5`,
  ownerUsed: "Las solicitudes del estudio de este mes se han agotado, así que no se pueden mostrar las valoraciones. Siguen guardadas.",
  ownerChanged: "Llegaron valoraciones nuevas mientras se cargaban. Vuelve a intentarlo.",
  ownerFailed: "No se pudieron leer las valoraciones. Vuelve a intentarlo.",
  ownerNewest: (shown) => `Se muestran los ${shown} comentarios más recientes.`,
};

const fr: LessonRatingWords = {
  title: "Notez cette leçon",
  note: "Facultatif. Seul le créateur voit votre note et votre commentaire, sans votre nom ni votre adresse e-mail. Vous pouvez les modifier ou les retirer ici tant que cette leçon vous est ouverte. Si vous demandez à la boutique de supprimer vos données, ils sont retirés aussi.",
  legend: "Cette leçon vous a-t-elle été utile ?",
  scores: ["1 – Pas utile", "2 – Un peu utile", "3 – Utile", "4 – Très utile", "5 – Extrêmement utile"],
  noteLabel: "Commentaire (facultatif)",
  noteHint: (max) => `Jusqu’à ${max} caractères.`,
  save: "Enregistrer ma note",
  remove: "Retirer ma note",
  yours: (score) => `Votre note : ${score} sur 5.`,
  notices: {
    saved: "Votre note est enregistrée.",
    removed: "Votre note est retirée.",
    score: "Choisissez un nombre de 1 à 5.",
    slow: "Trop de notes à la fois. Attendez une minute, puis réessayez.",
    full: "Cette leçon ne peut pas recevoir plus de notes pour le moment.",
    noroom: "La boutique n’a plus de place pour l’enregistrer pour le moment. Réessayez plus tard.",
    unknown: "Nous n’avons pas pu confirmer l’envoi. Revenez voir dans un instant.",
  },
  ownerTitle: "Notes de cette leçon",
  ownerNote: "Vous seul les voyez, sans le nom des élèves. Les élèves ne voient jamais les notes des autres.",
  ownerShow: "Afficher les notes",
  ownerNone: "Aucune note pour l’instant.",
  average: (average, count) => `Moyenne de ${average} sur 5, sur ${count} ${count === 1 ? "note" : "notes"}.`,
  countOf: (score, count) => `${score} sur 5 : ${count}`,
  ownerNotes: "Commentaires",
  noteScore: (score) => `${score} sur 5`,
  ownerUsed: "Les requêtes du studio de ce mois sont épuisées : les notes ne peuvent pas être affichées. Elles restent enregistrées.",
  ownerChanged: "De nouvelles notes sont arrivées pendant le chargement. Réessayez.",
  ownerFailed: "Les notes n’ont pas pu être lues. Réessayez.",
  ownerNewest: (shown) => `Affichage des ${shown} commentaires les plus récents.`,
};

const de: LessonRatingWords = {
  title: "Diese Lektion bewerten",
  note: "Freiwillig. Nur die Person, die den Kurs anbietet, sieht Ihre Bewertung und Ihren Kommentar, ohne Ihren Namen und Ihre E-Mail-Adresse. Sie können sie hier ändern oder entfernen, solange diese Lektion für Sie offen ist. Wenn Sie den Shop bitten, Ihre Daten zu löschen, wird sie ebenfalls entfernt.",
  legend: "Wie hilfreich war diese Lektion?",
  scores: ["1 – Nicht hilfreich", "2 – Etwas hilfreich", "3 – Hilfreich", "4 – Sehr hilfreich", "5 – Äußerst hilfreich"],
  noteLabel: "Kommentar (freiwillig)",
  noteHint: (max) => `Bis zu ${max} Zeichen.`,
  save: "Meine Bewertung speichern",
  remove: "Meine Bewertung entfernen",
  yours: (score) => `Ihre Bewertung: ${score} von 5.`,
  notices: {
    saved: "Ihre Bewertung ist gespeichert.",
    removed: "Ihre Bewertung ist entfernt.",
    score: "Wählen Sie eine Zahl von 1 bis 5.",
    slow: "Zu viele Bewertungen auf einmal. Warten Sie eine Minute und versuchen Sie es dann erneut.",
    full: "Diese Lektion kann gerade keine weiteren Bewertungen aufnehmen.",
    noroom: "Der Shop hat gerade keinen Platz, um das zu speichern. Versuchen Sie es später erneut.",
    unknown: "Wir konnten nicht bestätigen, dass es geklappt hat. Sehen Sie gleich noch einmal nach.",
  },
  ownerTitle: "Bewertungen dieser Lektion",
  ownerNote: "Nur Sie sehen sie, ohne die Namen der Teilnehmenden. Teilnehmende sehen nie die Bewertungen anderer.",
  ownerShow: "Bewertungen anzeigen",
  ownerNone: "Noch keine Bewertungen.",
  average: (average, count) => `Durchschnitt ${average} von 5, aus ${count} ${count === 1 ? "Bewertung" : "Bewertungen"}.`,
  countOf: (score, count) => `${score} von 5: ${count}`,
  ownerNotes: "Kommentare",
  noteScore: (score) => `${score} von 5`,
  ownerUsed: "Die Studio-Anfragen dieses Monats sind aufgebraucht, daher können die Bewertungen nicht angezeigt werden. Sie bleiben gespeichert.",
  ownerChanged: "Während des Ladens sind neue Bewertungen eingegangen. Versuchen Sie es erneut.",
  ownerFailed: "Die Bewertungen konnten nicht gelesen werden. Versuchen Sie es erneut.",
  ownerNewest: (shown) => `Angezeigt werden die ${shown} neuesten Kommentare.`,
};

const it: LessonRatingWords = {
  title: "Valuta questa lezione",
  note: "Facoltativo. Solo il creatore vede la tua valutazione e il tuo commento, senza il tuo nome né il tuo indirizzo email. Puoi cambiarla o rimuoverla qui finché questa lezione è aperta per te. Se chiedi al negozio di cancellare i tuoi dati, viene rimossa anch’essa.",
  legend: "Quanto ti è stata utile questa lezione?",
  scores: ["1 – Per niente utile", "2 – Poco utile", "3 – Utile", "4 – Molto utile", "5 – Estremamente utile"],
  noteLabel: "Commento (facoltativo)",
  noteHint: (max) => `Fino a ${max} caratteri.`,
  save: "Salva la mia valutazione",
  remove: "Rimuovi la mia valutazione",
  yours: (score) => `La tua valutazione: ${score} su 5.`,
  notices: {
    saved: "La tua valutazione è salvata.",
    removed: "La tua valutazione è stata rimossa.",
    score: "Scegli un numero da 1 a 5.",
    slow: "Troppe valutazioni in una volta. Aspetta un minuto, poi riprova.",
    full: "Questa lezione non può ricevere altre valutazioni per ora.",
    noroom: "Il negozio non ha spazio per salvarla ora. Riprova più tardi.",
    unknown: "Non siamo riusciti a confermare l’invio. Controlla di nuovo tra poco.",
  },
  ownerTitle: "Valutazioni di questa lezione",
  ownerNote: "Le vedi solo tu, senza i nomi degli studenti. Gli studenti non vedono mai le valutazioni degli altri.",
  ownerShow: "Mostra le valutazioni",
  ownerNone: "Ancora nessuna valutazione.",
  average: (average, count) => `Media di ${average} su 5, da ${count} ${count === 1 ? "valutazione" : "valutazioni"}.`,
  countOf: (score, count) => `${score} su 5: ${count}`,
  ownerNotes: "Commenti",
  noteScore: (score) => `${score} su 5`,
  ownerUsed: "Le richieste dello studio di questo mese sono esaurite, quindi le valutazioni non si possono mostrare. Restano salvate.",
  ownerChanged: "Sono arrivate nuove valutazioni durante il caricamento. Riprova.",
  ownerFailed: "Non è stato possibile leggere le valutazioni. Riprova.",
  ownerNewest: (shown) => `Sono mostrati i ${shown} commenti più recenti.`,
};

const nl: LessonRatingWords = {
  title: "Beoordeel deze les",
  note: "Vrijblijvend. Alleen de maker ziet je beoordeling en opmerking, zonder je naam of e-mailadres. Je kunt hem hier wijzigen of verwijderen zolang deze les voor je open is. Als je de winkel vraagt je gegevens te verwijderen, verdwijnt hij ook.",
  legend: "Hoe nuttig was deze les?",
  scores: ["1 – Niet nuttig", "2 – Een beetje nuttig", "3 – Nuttig", "4 – Erg nuttig", "5 – Heel erg nuttig"],
  noteLabel: "Opmerking (vrijblijvend)",
  noteHint: (max) => `Maximaal ${max} tekens.`,
  save: "Mijn beoordeling opslaan",
  remove: "Mijn beoordeling verwijderen",
  yours: (score) => `Jouw beoordeling: ${score} van de 5.`,
  notices: {
    saved: "Je beoordeling is opgeslagen.",
    removed: "Je beoordeling is verwijderd.",
    score: "Kies een getal van 1 tot 5.",
    slow: "Te veel beoordelingen tegelijk. Wacht een minuut en probeer het dan opnieuw.",
    full: "Deze les kan op dit moment geen beoordelingen meer aannemen.",
    noroom: "De winkel heeft nu geen ruimte om dit te bewaren. Probeer het later opnieuw.",
    unknown: "We konden niet bevestigen dat het gelukt is. Kijk zo nog eens.",
  },
  ownerTitle: "Beoordelingen van deze les",
  ownerNote: "Alleen jij ziet ze, zonder de namen van de deelnemers. Deelnemers zien nooit elkaars beoordelingen.",
  ownerShow: "Beoordelingen tonen",
  ownerNone: "Nog geen beoordelingen.",
  average: (average, count) => `Gemiddeld ${average} van de 5, uit ${count} ${count === 1 ? "beoordeling" : "beoordelingen"}.`,
  countOf: (score, count) => `${score} van de 5: ${count}`,
  ownerNotes: "Opmerkingen",
  noteScore: (score) => `${score} van de 5`,
  ownerUsed: "De studioverzoeken van deze maand zijn op, dus de beoordelingen kunnen niet worden getoond. Ze blijven bewaard.",
  ownerChanged: "Er kwamen nieuwe beoordelingen binnen tijdens het laden. Probeer het opnieuw.",
  ownerFailed: "De beoordelingen konden niet worden gelezen. Probeer het opnieuw.",
  ownerNewest: (shown) => `De ${shown} nieuwste opmerkingen worden getoond.`,
};

const pt: LessonRatingWords = {
  title: "Avalie esta aula",
  note: "Opcional. Só o criador vê a sua avaliação e o seu comentário, sem o seu nome nem o seu e-mail. Pode alterá-la ou retirá-la aqui enquanto esta aula estiver aberta para si. Se pedir à loja que apague os seus dados, ela também é retirada.",
  legend: "Quão útil foi esta aula?",
  scores: ["1 – Nada útil", "2 – Pouco útil", "3 – Útil", "4 – Muito útil", "5 – Extremamente útil"],
  noteLabel: "Comentário (opcional)",
  noteHint: (max) => `Até ${max} caracteres.`,
  save: "Guardar a minha avaliação",
  remove: "Retirar a minha avaliação",
  yours: (score) => `A sua avaliação: ${score} de 5.`,
  notices: {
    saved: "A sua avaliação está guardada.",
    removed: "A sua avaliação foi retirada.",
    score: "Escolha um número de 1 a 5.",
    slow: "Demasiadas avaliações de uma vez. Espere um minuto e tente de novo.",
    full: "Esta aula não pode receber mais avaliações de momento.",
    noroom: "A loja não tem espaço para guardar isto agora. Tente mais tarde.",
    unknown: "Não foi possível confirmar o envio. Volte a ver daqui a pouco.",
  },
  ownerTitle: "Avaliações desta aula",
  ownerNote: "Só são visíveis para si, sem os nomes dos alunos. Os alunos nunca veem as avaliações dos outros.",
  ownerShow: "Mostrar avaliações",
  ownerNone: "Ainda não há avaliações.",
  average: (average, count) => `Média de ${average} em 5, de ${count} ${count === 1 ? "avaliação" : "avaliações"}.`,
  countOf: (score, count) => `${score} de 5: ${count}`,
  ownerNotes: "Comentários",
  noteScore: (score) => `${score} de 5`,
  ownerUsed: "Os pedidos do estúdio deste mês esgotaram-se, por isso as avaliações não podem ser mostradas. Continuam guardadas.",
  ownerChanged: "Chegaram avaliações novas durante o carregamento. Tente de novo.",
  ownerFailed: "Não foi possível ler as avaliações. Tente de novo.",
  ownerNewest: (shown) => `A mostrar os ${shown} comentários mais recentes.`,
};

export const LESSON_RATING_WORDS: Record<LanguageCode, LessonRatingWords> = { en, es, fr, de, it, nl, pt };

export function lessonRatingWords(language: unknown): LessonRatingWords {
  return LESSON_RATING_WORDS[parseLanguage(language)] ?? en;
}
