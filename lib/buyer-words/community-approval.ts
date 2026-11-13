/**
 * The words a member reads about what waits for the creator's approval
 * (543 [CM2], lib/community-approval.ts), in each language a store can
 * speak, with the conventions of lib/buyer-words/community.ts: "tú" in
 * Spanish, "vous" in French with its non-breaking spaces, "Sie" in German,
 * "tu" in Italian, "je" in Dutch, and the courteous third person of Portugal
 * in Portuguese. Every sentence says only what the code does: only the
 * author and the creator see what waits, and after HELD_DAYS without an
 * answer it is not published.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { parseLanguage } from "@/lib/store-language";
import { HELD_DAYS } from "@/lib/community-approval-rules";

/** A non-breaking space, before the signs French spaces from the word before them. */
const S = " ";

export type ApprovalWords = {
  /** The state of an item, said in text. */
  waiting: string;
  waitingNote: string;
  notPublished: string;
  /** The heading over a member's own posts, and over their own comments under a post. */
  minePosts: string;
  mineComments: string;
  removed: (why: string) => string;
  expired: string;
  postGone: string;
  takeBack: string;
  /** Asked before taking back, since it cannot be undone. */
  takeBackSure: string;
  dismiss: string;
  unreadable: string;
  /** What happened after a button (?n=...). */
  notices: { held: string; heldcomment: string; heldfull: string; heldmine: string; withdrawn: string };
};

const en: ApprovalWords = {
  waiting: "Waiting for approval",
  waitingNote: "Only you and the creator can see this until the creator approves it.",
  notPublished: "Not published",
  minePosts: "Your posts waiting for approval",
  mineComments: "Your comments waiting for approval",
  removed: (why) => (why ? `The creator did not publish this. They said: “${why}”` : "The creator did not publish this."),
  expired: `It waited ${HELD_DAYS} days without an answer, so it was not published.`,
  postGone: "The post it answered was deleted, so it was not published.",
  takeBack: "Take it back",
  takeBackSure: "Take it back? It will not be published, and this cannot be undone.",
  dismiss: "Dismiss",
  unreadable: "What you sent for approval could not be loaded. Reload the page to try again.",
  notices: {
    held: "Sent. Your post is waiting for the creator's approval. Until then, only you and the creator can see it.",
    heldcomment: "Sent. Your comment is waiting for the creator's approval. Until then, only you and the creator can see it.",
    heldfull: "Too many posts are waiting for approval in this community right now. Try again later.",
    heldmine: "You already have as many posts waiting as can wait. Wait for the creator's answer, or take one back.",
    withdrawn: "Taken back. It was not published.",
  },
};

const es: ApprovalWords = {
  waiting: "Pendiente de aprobación",
  waitingNote: "Solo tú y el creador pueden verlo hasta que el creador lo apruebe.",
  notPublished: "No publicado",
  minePosts: "Tus publicaciones pendientes de aprobación",
  mineComments: "Tus comentarios pendientes de aprobación",
  removed: (why) => (why ? `El creador no lo publicó. Dijo: «${why}»` : "El creador no lo publicó."),
  expired: `Esperó ${HELD_DAYS} días sin respuesta, así que no se publicó.`,
  postGone: "La publicación a la que respondía se eliminó, así que no se publicó.",
  takeBack: "Retirarlo",
  takeBackSure: "¿Retirarlo? No se publicará, y no se puede deshacer.",
  dismiss: "Cerrar",
  unreadable: "No se pudo cargar lo que enviaste para aprobar. Vuelve a cargar la página para intentarlo de nuevo.",
  notices: {
    held: "Enviado. Tu publicación está pendiente de la aprobación del creador. Hasta entonces, solo tú y el creador pueden verla.",
    heldcomment: "Enviado. Tu comentario está pendiente de la aprobación del creador. Hasta entonces, solo tú y el creador pueden verlo.",
    heldfull: "Ahora mismo hay demasiadas publicaciones pendientes de aprobación en esta comunidad. Inténtalo más tarde.",
    heldmine: "Ya tienes tantas publicaciones pendientes como pueden esperar. Espera la respuesta del creador o retira una.",
    withdrawn: "Retirado. No se publicó.",
  },
};

const fr: ApprovalWords = {
  waiting: "En attente d'approbation",
  waitingNote: "Seuls vous et le créateur pouvez le voir tant que le créateur ne l'a pas approuvé.",
  notPublished: "Non publié",
  minePosts: "Vos publications en attente d'approbation",
  mineComments: "Vos commentaires en attente d'approbation",
  removed: (why) => (why ? `Le créateur ne l'a pas publié. Il a écrit${S}: «${S}${why}${S}»` : "Le créateur ne l'a pas publié."),
  expired: `Il a attendu ${HELD_DAYS}${S}jours sans réponse, il n'a donc pas été publié.`,
  postGone: "La publication à laquelle il répondait a été supprimée, il n'a donc pas été publié.",
  takeBack: "Le retirer",
  takeBackSure: `Le retirer${S}? Il ne sera pas publié, et cela ne peut pas être annulé.`,
  dismiss: "Fermer",
  unreadable: "Ce que vous avez envoyé pour approbation n'a pas pu être chargé. Rechargez la page pour réessayer.",
  notices: {
    held: "Envoyé. Votre publication attend l'approbation du créateur. D'ici là, seuls vous et le créateur pouvez la voir.",
    heldcomment: "Envoyé. Votre commentaire attend l'approbation du créateur. D'ici là, seuls vous et le créateur pouvez le voir.",
    heldfull: "Trop de publications attendent une approbation dans cette communauté en ce moment. Réessayez plus tard.",
    heldmine: "Vous avez déjà autant de publications en attente que possible. Attendez la réponse du créateur, ou retirez-en une.",
    withdrawn: "Retiré. Il n'a pas été publié.",
  },
};

const de: ApprovalWords = {
  waiting: "Wartet auf Freigabe",
  waitingNote: "Bis der Ersteller es freigibt, sehen es nur Sie und der Ersteller.",
  notPublished: "Nicht veröffentlicht",
  minePosts: "Ihre Beiträge, die auf Freigabe warten",
  mineComments: "Ihre Kommentare, die auf Freigabe warten",
  removed: (why) => (why ? `Der Ersteller hat es nicht veröffentlicht. Er schrieb: „${why}“` : "Der Ersteller hat es nicht veröffentlicht."),
  expired: `Es hat ${HELD_DAYS} Tage ohne Antwort gewartet und wurde daher nicht veröffentlicht.`,
  postGone: "Der Beitrag, auf den es antwortete, wurde gelöscht, daher wurde es nicht veröffentlicht.",
  takeBack: "Zurückziehen",
  takeBackSure: "Zurückziehen? Es wird nicht veröffentlicht, und das lässt sich nicht rückgängig machen.",
  dismiss: "Schließen",
  unreadable: "Was Sie zur Freigabe gesendet haben, konnte nicht geladen werden. Laden Sie die Seite neu, um es erneut zu versuchen.",
  notices: {
    held: "Gesendet. Ihr Beitrag wartet auf die Freigabe des Erstellers. Bis dahin sehen ihn nur Sie und der Ersteller.",
    heldcomment: "Gesendet. Ihr Kommentar wartet auf die Freigabe des Erstellers. Bis dahin sehen ihn nur Sie und der Ersteller.",
    heldfull: "In dieser Community warten gerade zu viele Beiträge auf Freigabe. Versuchen Sie es später erneut.",
    heldmine: "Sie haben schon so viele Beiträge in der Warteschlange, wie warten können. Warten Sie auf die Antwort des Erstellers oder ziehen Sie einen zurück.",
    withdrawn: "Zurückgezogen. Es wurde nicht veröffentlicht.",
  },
};

const it: ApprovalWords = {
  waiting: "In attesa di approvazione",
  waitingNote: "Finché il creatore non lo approva, lo vedete solo tu e il creatore.",
  notPublished: "Non pubblicato",
  minePosts: "I tuoi post in attesa di approvazione",
  mineComments: "I tuoi commenti in attesa di approvazione",
  removed: (why) => (why ? `Il creatore non l'ha pubblicato. Ha scritto: «${why}»` : "Il creatore non l'ha pubblicato."),
  expired: `Ha atteso ${HELD_DAYS} giorni senza risposta, quindi non è stato pubblicato.`,
  postGone: "Il post a cui rispondeva è stato eliminato, quindi non è stato pubblicato.",
  takeBack: "Ritiralo",
  takeBackSure: "Ritirarlo? Non verrà pubblicato, e non si può annullare.",
  dismiss: "Chiudi",
  unreadable: "Non è stato possibile caricare ciò che hai inviato per l'approvazione. Ricarica la pagina per riprovare.",
  notices: {
    held: "Inviato. Il tuo post è in attesa dell'approvazione del creatore. Fino ad allora, lo vedete solo tu e il creatore.",
    heldcomment: "Inviato. Il tuo commento è in attesa dell'approvazione del creatore. Fino ad allora, lo vedete solo tu e il creatore.",
    heldfull: "In questo momento ci sono troppi post in attesa di approvazione in questa community. Riprova più tardi.",
    heldmine: "Hai già tanti post in attesa quanti ne possono attendere. Aspetta la risposta del creatore o ritirane uno.",
    withdrawn: "Ritirato. Non è stato pubblicato.",
  },
};

const nl: ApprovalWords = {
  waiting: "Wacht op goedkeuring",
  waitingNote: "Tot de maker het goedkeurt, zien alleen jij en de maker dit.",
  notPublished: "Niet geplaatst",
  minePosts: "Je berichten die op goedkeuring wachten",
  mineComments: "Je reacties die op goedkeuring wachten",
  removed: (why) => (why ? `De maker heeft dit niet geplaatst. De maker schreef: ‘${why}’` : "De maker heeft dit niet geplaatst."),
  expired: `Het wachtte ${HELD_DAYS} dagen zonder antwoord, dus het is niet geplaatst.`,
  postGone: "Het bericht waarop het reageerde is verwijderd, dus het is niet geplaatst.",
  takeBack: "Intrekken",
  takeBackSure: "Intrekken? Het wordt niet geplaatst, en dit kan niet ongedaan worden gemaakt.",
  dismiss: "Sluiten",
  unreadable: "Wat je ter goedkeuring stuurde kon niet worden geladen. Laad de pagina opnieuw om het nog eens te proberen.",
  notices: {
    held: "Verstuurd. Je bericht wacht op goedkeuring van de maker. Tot dan zien alleen jij en de maker het.",
    heldcomment: "Verstuurd. Je reactie wacht op goedkeuring van de maker. Tot dan zien alleen jij en de maker het.",
    heldfull: "Er wachten nu te veel berichten op goedkeuring in deze community. Probeer het later opnieuw.",
    heldmine: "Je hebt al zoveel berichten wachten als er kunnen wachten. Wacht op het antwoord van de maker, of trek er een in.",
    withdrawn: "Ingetrokken. Het is niet geplaatst.",
  },
};

const pt: ApprovalWords = {
  waiting: "À espera de aprovação",
  waitingNote: "Até o criador aprovar, só o próprio e o criador podem ver isto.",
  notPublished: "Não publicado",
  minePosts: "As suas publicações à espera de aprovação",
  mineComments: "Os seus comentários à espera de aprovação",
  removed: (why) => (why ? `O criador não o publicou. Escreveu: «${why}»` : "O criador não o publicou."),
  expired: `Esperou ${HELD_DAYS} dias sem resposta, por isso não foi publicado.`,
  postGone: "A publicação a que respondia foi apagada, por isso não foi publicado.",
  takeBack: "Retirar",
  takeBackSure: "Retirar? Não será publicado, e não é possível anular.",
  dismiss: "Fechar",
  unreadable: "Não foi possível carregar o que enviou para aprovação. Recarregue a página para tentar de novo.",
  notices: {
    held: "Enviado. A sua publicação está à espera da aprovação do criador. Até lá, só o próprio e o criador a podem ver.",
    heldcomment: "Enviado. O seu comentário está à espera da aprovação do criador. Até lá, só o próprio e o criador o podem ver.",
    heldfull: "Neste momento há demasiadas publicações à espera de aprovação nesta comunidade. Tente mais tarde.",
    heldmine: "Já tem tantas publicações à espera quantas podem esperar. Aguarde a resposta do criador, ou retire uma.",
    withdrawn: "Retirado. Não foi publicado.",
  },
};

const WORDS = { en, es, fr, de, it, nl, pt };

export function approvalWords(language: unknown): ApprovalWords {
  return WORDS[parseLanguage(language)];
}

/** The notices that warn rather than confirm. */
export const APPROVAL_WARN = new Set(["heldfull", "heldmine"]);
