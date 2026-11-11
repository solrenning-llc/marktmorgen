/**
 * The buyer's words for "Report a problem with this order" (567 [GD1] (a),
 * unit 1), in the store's language (lib/store-language.ts). Its own topic
 * file, like lib/buyer-words/reviews.ts, so the long orders file is not
 * touched. Plain words: every language says what English says.
 *
 * The page and the route that use them are later units; the rules they
 * follow are in lib/order-problem-rules.ts. Browser-safe.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import { ORDER_PROBLEM_REPLY_DAYS, type OrderProblemReason } from "@/lib/order-problem-rules";

export type OrderProblemWords = {
  /** The button on each order. */
  button: string;
  /** The heading of the form it opens. */
  heading: string;
  /** One sentence on what happens with the report. */
  intro: string;
  /** The question over the four reasons. */
  reasonLegend: string;
  reasons: Record<OrderProblemReason, string>;
  /** The label of the buyer's own words. */
  noteLabel: string;
  /** Under the box: optional for the first three reasons. */
  noteHint: string;
  /** Under the box when "Something else" is chosen. */
  noteHintOther: string;
  send: string;
  /** What the buyer reads once it was sent, with the store's name. */
  sent: (store: string) => string;
  errorReason: string;
  errorNote: string;
  errorOrder: string;
  errorLimited: string;
  errorUnavailable: string;
  /** The page's title, and the link to it under the list of purchases (unit 3). */
  title: string;
  /** Over the list of orders, when none is chosen yet. */
  chooseLead: string;
  /** When the link finds no orders. */
  none: string;
  productLabel: string;
  orderLabel: string;
  backToList: string;
  /** This order already has an open report. */
  alreadyOpen: string;
  /** A report of this order is being sent right now, or the store is busy. */
  busyNow: string;
  /** The store has no room to take it. */
  storeFull: string;
};

/** The sentences each language must have (the reasons and the sent line are checked on their own). */
export const ORDER_PROBLEM_KEYS = [
  "button",
  "heading",
  "intro",
  "reasonLegend",
  "noteLabel",
  "noteHint",
  "noteHintOther",
  "send",
  "errorReason",
  "errorNote",
  "errorOrder",
  "errorLimited",
  "errorUnavailable",
  "title",
  "chooseLead",
  "none",
  "productLabel",
  "orderLabel",
  "backToList",
  "alreadyOpen",
  "busyNow",
  "storeFull",
] as const satisfies readonly (keyof OrderProblemWords)[];

const D = ORDER_PROBLEM_REPLY_DAYS;

const WORDS: Record<LanguageCode, OrderProblemWords> = {
  en: {
    button: "Report a problem with this order",
    heading: "What is wrong with this order?",
    intro: `Your message goes to the creator. They have ${D} days to answer you by email.`,
    reasonLegend: "Pick the reason",
    reasons: { not_received: "I did not get it", not_as_described: "It is not what was described", cannot_access: "I cannot open it", other: "Something else" },
    noteLabel: "Tell the creator more",
    noteHint: "Optional. Up to 1,000 characters.",
    noteHintOther: "Say what is wrong in a few words. Up to 1,000 characters.",
    send: "Send to the creator",
    sent: (store) => `Sent to ${store}. They have ${D} days to answer you by email.`,
    errorReason: "Pick one of the reasons.",
    errorNote: "Say what is wrong in a few words, up to 1,000 characters.",
    errorOrder: "We could not find this order. Open your purchases again from the link in your email.",
    errorLimited: "Too many reports for now. Try again tomorrow.",
    errorUnavailable: "This could not be sent just now. Nothing was sent. Try again in a minute.",
    title: "Report a problem with an order",
    chooseLead: "Which order is it about?",
    none: "We found no orders for this link.",
    productLabel: "Product",
    orderLabel: "Order",
    backToList: "Back to your purchases",
    alreadyOpen: `This order already has an open report. The creator has ${D} days to answer it.`,
    busyNow: "This is busy right now. Nothing was sent. Try again in a minute.",
    storeFull: "The store cannot take messages right now. Nothing was sent. Try again later or use the store's contact page.",
  },
  es: {
    button: "Informar de un problema con este pedido",
    heading: "¿Qué pasa con este pedido?",
    intro: `Tu mensaje llega al creador. Tiene ${D} días para responderte por correo electrónico.`,
    reasonLegend: "Elige el motivo",
    reasons: { not_received: "No lo recibí", not_as_described: "No es lo que se describía", cannot_access: "No puedo abrirlo", other: "Otra cosa" },
    noteLabel: "Cuéntale más al creador",
    noteHint: "Opcional. Hasta 1000 caracteres.",
    noteHintOther: "Di qué pasa en pocas palabras. Hasta 1000 caracteres.",
    send: "Enviar al creador",
    sent: (store) => `Enviado a ${store}. Tiene ${D} días para responderte por correo electrónico.`,
    errorReason: "Elige uno de los motivos.",
    errorNote: "Di qué pasa en pocas palabras, hasta 1000 caracteres.",
    errorOrder: "No encontramos este pedido. Vuelve a abrir tus compras desde el enlace de tu correo.",
    errorLimited: "Demasiados avisos por ahora. Inténtalo de nuevo mañana.",
    errorUnavailable: "No se pudo enviar ahora. No se envió nada. Inténtalo de nuevo en un minuto.",
    title: "Informar de un problema con un pedido",
    chooseLead: "¿De qué pedido se trata?",
    none: "No encontramos pedidos para este enlace.",
    productLabel: "Producto",
    orderLabel: "Pedido",
    backToList: "Volver a tus compras",
    alreadyOpen: `Este pedido ya tiene un aviso abierto. El creador tiene ${D} días para responderlo.`,
    busyNow: "Ahora mismo está ocupado. No se envió nada. Inténtalo de nuevo en un minuto.",
    storeFull: "La tienda no puede recibir mensajes ahora. No se envió nada. Inténtalo más tarde o usa la página de contacto de la tienda.",
  },
  fr: {
    button: "Signaler un problème avec cette commande",
    heading: "Quel est le problème avec cette commande ?",
    intro: `Votre message est envoyé au créateur. Il a ${D} jours pour vous répondre par e-mail.`,
    reasonLegend: "Choisissez le motif",
    reasons: { not_received: "Je ne l'ai pas reçu", not_as_described: "Ce n'est pas ce qui était décrit", cannot_access: "Je n'arrive pas à l'ouvrir", other: "Autre chose" },
    noteLabel: "Dites-en plus au créateur",
    noteHint: "Facultatif. Jusqu'à 1 000 caractères.",
    noteHintOther: "Dites en quelques mots ce qui ne va pas. Jusqu'à 1 000 caractères.",
    send: "Envoyer au créateur",
    sent: (store) => `Envoyé à ${store}. Il a ${D} jours pour vous répondre par e-mail.`,
    errorReason: "Choisissez un des motifs.",
    errorNote: "Dites en quelques mots ce qui ne va pas, jusqu'à 1 000 caractères.",
    errorOrder: "Nous n'avons pas trouvé cette commande. Rouvrez vos achats depuis le lien de votre e-mail.",
    errorLimited: "Trop de signalements pour le moment. Réessayez demain.",
    errorUnavailable: "L'envoi n'a pas pu se faire pour l'instant. Rien n'a été envoyé. Réessayez dans une minute.",
    title: "Signaler un problème avec une commande",
    chooseLead: "De quelle commande s'agit-il ?",
    none: "Nous n'avons trouvé aucune commande pour ce lien.",
    productLabel: "Produit",
    orderLabel: "Commande",
    backToList: "Retour à vos achats",
    alreadyOpen: `Cette commande a déjà un signalement ouvert. Le créateur a ${D} jours pour y répondre.`,
    busyNow: "C'est occupé pour le moment. Rien n'a été envoyé. Réessayez dans une minute.",
    storeFull: "La boutique ne peut pas recevoir de messages pour le moment. Rien n'a été envoyé. Réessayez plus tard ou utilisez la page de contact de la boutique.",
  },
  de: {
    button: "Ein Problem mit dieser Bestellung melden",
    heading: "Was stimmt mit dieser Bestellung nicht?",
    intro: `Ihre Nachricht geht an den Creator. Er hat ${D} Tage Zeit, Ihnen per E-Mail zu antworten.`,
    reasonLegend: "Wählen Sie den Grund",
    reasons: { not_received: "Ich habe es nicht bekommen", not_as_described: "Es ist nicht wie beschrieben", cannot_access: "Ich kann es nicht öffnen", other: "Etwas anderes" },
    noteLabel: "Schreiben Sie dem Creator mehr",
    noteHint: "Freiwillig. Bis zu 1.000 Zeichen.",
    noteHintOther: "Sagen Sie in wenigen Worten, was nicht stimmt. Bis zu 1.000 Zeichen.",
    send: "An den Creator senden",
    sent: (store) => `An ${store} gesendet. Er hat ${D} Tage Zeit, Ihnen per E-Mail zu antworten.`,
    errorReason: "Wählen Sie einen der Gründe.",
    errorNote: "Sagen Sie in wenigen Worten, was nicht stimmt, bis zu 1.000 Zeichen.",
    errorOrder: "Wir haben diese Bestellung nicht gefunden. Öffnen Sie Ihre Käufe erneut über den Link in Ihrer E-Mail.",
    errorLimited: "Gerade zu viele Meldungen. Versuchen Sie es morgen noch einmal.",
    errorUnavailable: "Das konnte gerade nicht gesendet werden. Es wurde nichts gesendet. Versuchen Sie es in einer Minute noch einmal.",
    title: "Ein Problem mit einer Bestellung melden",
    chooseLead: "Um welche Bestellung geht es?",
    none: "Wir haben für diesen Link keine Bestellungen gefunden.",
    productLabel: "Produkt",
    orderLabel: "Bestellung",
    backToList: "Zurück zu Ihren Käufen",
    alreadyOpen: `Für diese Bestellung gibt es schon eine offene Meldung. Der Creator hat ${D} Tage Zeit, darauf zu antworten.`,
    busyNow: "Gerade ist es belegt. Es wurde nichts gesendet. Versuchen Sie es in einer Minute noch einmal.",
    storeFull: "Der Shop kann gerade keine Nachrichten annehmen. Es wurde nichts gesendet. Versuchen Sie es später noch einmal oder nutzen Sie die Kontaktseite des Shops.",
  },
  it: {
    button: "Segnala un problema con questo ordine",
    heading: "Che cosa non va con questo ordine?",
    intro: `Il tuo messaggio va al creatore. Ha ${D} giorni per risponderti via email.`,
    reasonLegend: "Scegli il motivo",
    reasons: { not_received: "Non l'ho ricevuto", not_as_described: "Non è quello che era descritto", cannot_access: "Non riesco ad aprirlo", other: "Altro" },
    noteLabel: "Spiega di più al creatore",
    noteHint: "Facoltativo. Fino a 1.000 caratteri.",
    noteHintOther: "Di' in poche parole che cosa non va. Fino a 1.000 caratteri.",
    send: "Invia al creatore",
    sent: (store) => `Inviato a ${store}. Ha ${D} giorni per risponderti via email.`,
    errorReason: "Scegli uno dei motivi.",
    errorNote: "Di' in poche parole che cosa non va, fino a 1.000 caratteri.",
    errorOrder: "Non abbiamo trovato questo ordine. Riapri i tuoi acquisti dal link nella tua email.",
    errorLimited: "Troppe segnalazioni per ora. Riprova domani.",
    errorUnavailable: "Non è stato possibile inviarlo adesso. Non è stato inviato nulla. Riprova tra un minuto.",
    title: "Segnala un problema con un ordine",
    chooseLead: "Di quale ordine si tratta?",
    none: "Non abbiamo trovato ordini per questo link.",
    productLabel: "Prodotto",
    orderLabel: "Ordine",
    backToList: "Torna ai tuoi acquisti",
    alreadyOpen: `Questo ordine ha già una segnalazione aperta. Il creatore ha ${D} giorni per rispondere.`,
    busyNow: "Al momento è occupato. Non è stato inviato nulla. Riprova tra un minuto.",
    storeFull: "Il negozio non può ricevere messaggi in questo momento. Non è stato inviato nulla. Riprova più tardi o usa la pagina dei contatti del negozio.",
  },
  nl: {
    button: "Een probleem met deze bestelling melden",
    heading: "Wat is er mis met deze bestelling?",
    intro: `Je bericht gaat naar de maker. Die heeft ${D} dagen om je per e-mail te antwoorden.`,
    reasonLegend: "Kies de reden",
    reasons: { not_received: "Ik heb het niet gekregen", not_as_described: "Het is niet wat er beschreven stond", cannot_access: "Ik kan het niet openen", other: "Iets anders" },
    noteLabel: "Vertel de maker meer",
    noteHint: "Niet verplicht. Tot 1.000 tekens.",
    noteHintOther: "Zeg in een paar woorden wat er mis is. Tot 1.000 tekens.",
    send: "Naar de maker sturen",
    sent: (store) => `Gestuurd naar ${store}. Die heeft ${D} dagen om je per e-mail te antwoorden.`,
    errorReason: "Kies een van de redenen.",
    errorNote: "Zeg in een paar woorden wat er mis is, tot 1.000 tekens.",
    errorOrder: "We konden deze bestelling niet vinden. Open je aankopen opnieuw via de link in je e-mail.",
    errorLimited: "Te veel meldingen op dit moment. Probeer het morgen opnieuw.",
    errorUnavailable: "Dit kon nu niet worden verstuurd. Er is niets verstuurd. Probeer het over een minuut opnieuw.",
    title: "Een probleem met een bestelling melden",
    chooseLead: "Over welke bestelling gaat het?",
    none: "We hebben geen bestellingen gevonden voor deze link.",
    productLabel: "Product",
    orderLabel: "Bestelling",
    backToList: "Terug naar je aankopen",
    alreadyOpen: `Voor deze bestelling is al een melding open. De maker heeft ${D} dagen om die te beantwoorden.`,
    busyNow: "Het is nu even druk. Er is niets verstuurd. Probeer het over een minuut opnieuw.",
    storeFull: "De winkel kan nu geen berichten ontvangen. Er is niets verstuurd. Probeer het later opnieuw of gebruik de contactpagina van de winkel.",
  },
  pt: {
    button: "Informar um problema com este pedido",
    heading: "O que há de errado com este pedido?",
    intro: `Sua mensagem vai para o criador. Ele tem ${D} dias para responder a você por e-mail.`,
    reasonLegend: "Escolha o motivo",
    reasons: { not_received: "Não recebi", not_as_described: "Não é o que foi descrito", cannot_access: "Não consigo abrir", other: "Outra coisa" },
    noteLabel: "Conte mais ao criador",
    noteHint: "Opcional. Até 1.000 caracteres.",
    noteHintOther: "Diga em poucas palavras o que está errado. Até 1.000 caracteres.",
    send: "Enviar ao criador",
    sent: (store) => `Enviado a ${store}. Ele tem ${D} dias para responder a você por e-mail.`,
    errorReason: "Escolha um dos motivos.",
    errorNote: "Diga em poucas palavras o que está errado, até 1.000 caracteres.",
    errorOrder: "Não encontramos este pedido. Abra suas compras de novo pelo link do seu e-mail.",
    errorLimited: "Muitos avisos por enquanto. Tente de novo amanhã.",
    errorUnavailable: "Não foi possível enviar agora. Nada foi enviado. Tente de novo em um minuto.",
    title: "Informar um problema com um pedido",
    chooseLead: "De qual pedido se trata?",
    none: "Não encontramos pedidos para este link.",
    productLabel: "Produto",
    orderLabel: "Pedido",
    backToList: "Voltar às suas compras",
    alreadyOpen: `Este pedido já tem um aviso aberto. O criador tem ${D} dias para responder.`,
    busyNow: "Está ocupado agora. Nada foi enviado. Tente de novo em um minuto.",
    storeFull: "A loja não pode receber mensagens agora. Nada foi enviado. Tente mais tarde ou use a página de contato da loja.",
  },
};

/** The words in the store's language; an unknown language gets English. */
export function orderProblemWords(language: unknown): OrderProblemWords {
  return WORDS[parseLanguage(language)];
}
