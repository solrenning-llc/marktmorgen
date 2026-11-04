/**
 * The words of the chat on a store's pages (lib/inbox.ts) and of the email
 * that carries the store's answer, in each language a store can speak.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type ChatWords = {
  launcher: string;
  title: (store: string) => string;
  intro: (store: string) => string;
  email: string;
  name: string;
  message: string;
  send: string;
  close: string;
  you: string;
  sent: string;
  closedNote: string;
  privacy: string;
  newChat: string;
  notices: Record<"email" | "short" | "limited" | "closed" | "error" | "gone", string>;
  replySubject: (store: string) => string;
  replyIntro: (store: string) => string;
  replyLink: string;
  replyByEmail: string;
  /** The creator writing first to one of their affiliates (630 [HN6](5), lib/inbox.ts writeToAffiliate). */
  affiliateSubject: (store: string) => string;
  affiliateIntro: (store: string) => string;
};

const en: ChatWords = {
  launcher: "Chat",
  title: (store) => `Write to ${store}`,
  intro: (store) => `${store} answers here while this page is open, and by email when you have gone.`,
  email: "Your email",
  name: "Your name (optional)",
  message: "Your message",
  send: "Send",
  close: "Close",
  you: "You",
  sent: "Sent. The answer shows here, and goes to your email too.",
  closedNote: "This conversation was closed. Write again to open it.",
  privacy: "Your address is used only to answer you.",
  newChat: "Start a new conversation",
  notices: {
    email: "That does not look like an email address. It is where the answer goes.",
    short: "Write a little more, so there is something to answer.",
    limited: "That was a lot of messages. Wait a few minutes, then send it again.",
    closed: "This store is not taking messages here right now.",
    error: "It could not be sent just now. Try again in a moment.",
    gone: "This conversation is no longer kept. Start a new one.",
  },
  replySubject: (store) => `${store} answered your message`,
  replyIntro: (store) => `${store} answered you:`,
  replyLink: "Read the whole conversation and write back here:",
  replyByEmail: "Answer this email to write back.",
  affiliateSubject: (store) => `A message from ${store} to its affiliates`,
  affiliateIntro: (store) => `You are one of ${store}'s affiliates, and ${store} wrote to you:`,
};

const es: ChatWords = {
  launcher: "Chat",
  title: (store) => `Escribe a ${store}`,
  intro: (store) => `${store} responde aquí mientras esta página está abierta, y por email cuando ya te hayas ido.`,
  email: "Tu email",
  name: "Tu nombre (opcional)",
  message: "Tu mensaje",
  send: "Enviar",
  close: "Cerrar",
  you: "Tú",
  sent: "Enviado. La respuesta aparece aquí y también llega a tu email.",
  closedNote: "Esta conversación se cerró. Escribe de nuevo para abrirla.",
  privacy: "Tu dirección solo se usa para responderte.",
  newChat: "Empezar una conversación nueva",
  notices: {
    email: "Eso no parece una dirección de email. Es donde llega la respuesta.",
    short: "Escribe un poco más, para que haya algo que responder.",
    limited: "Han sido muchos mensajes. Espera unos minutos y envíalo de nuevo.",
    closed: "Esta tienda no recibe mensajes aquí ahora mismo.",
    error: "No se pudo enviar ahora. Inténtalo de nuevo en un momento.",
    gone: "Esta conversación ya no se guarda. Empieza una nueva.",
  },
  replySubject: (store) => `${store} respondió a tu mensaje`,
  replyIntro: (store) => `${store} te respondió:`,
  replyLink: "Lee toda la conversación y responde aquí:",
  replyByEmail: "Responde a este email para contestar.",
  affiliateSubject: (store) => `Un mensaje de ${store} para sus afiliados`,
  affiliateIntro: (store) => `Eres afiliado de ${store}, y ${store} te ha escrito:`,
};

const fr: ChatWords = {
  launcher: "Discuter",
  title: (store) => `Écrire à ${store}`,
  intro: (store) => `${store} répond ici tant que cette page est ouverte, et par e-mail une fois que vous êtes parti.`,
  email: "Votre e-mail",
  name: "Votre nom (facultatif)",
  message: "Votre message",
  send: "Envoyer",
  close: "Fermer",
  you: "Vous",
  sent: "Envoyé. La réponse s’affiche ici et arrive aussi dans votre boîte e-mail.",
  closedNote: "Cette conversation a été close. Écrivez à nouveau pour la rouvrir.",
  privacy: "Votre adresse sert uniquement à vous répondre.",
  newChat: "Commencer une nouvelle conversation",
  notices: {
    email: "Cela ne ressemble pas à une adresse e-mail. C’est là que la réponse arrive.",
    short: "Écrivez-en un peu plus, pour qu’il y ait quelque chose à répondre.",
    limited: "Cela fait beaucoup de messages. Attendez quelques minutes, puis renvoyez-le.",
    closed: "Cette boutique ne reçoit pas de messages ici pour le moment.",
    error: "Le message n’a pas pu être envoyé. Réessayez dans un instant.",
    gone: "Cette conversation n’est plus conservée. Commencez-en une nouvelle.",
  },
  replySubject: (store) => `${store} a répondu à votre message`,
  replyIntro: (store) => `${store} vous a répondu :`,
  replyLink: "Lisez toute la conversation et répondez ici :",
  replyByEmail: "Répondez à cet e-mail pour écrire en retour.",
  affiliateSubject: (store) => `Un message de ${store} pour ses affiliés`,
  affiliateIntro: (store) => `Vous êtes affilié de ${store}, et ${store} vous a écrit :`,
};

const de: ChatWords = {
  launcher: "Chat",
  title: (store) => `An ${store} schreiben`,
  intro: (store) => `${store} antwortet hier, solange diese Seite offen ist, und per E-Mail, wenn Sie schon weg sind.`,
  email: "Ihre E-Mail",
  name: "Ihr Name (freiwillig)",
  message: "Ihre Nachricht",
  send: "Senden",
  close: "Schließen",
  you: "Sie",
  sent: "Gesendet. Die Antwort erscheint hier und kommt auch per E-Mail.",
  closedNote: "Dieses Gespräch wurde geschlossen. Schreiben Sie erneut, um es wieder zu öffnen.",
  privacy: "Ihre Adresse wird nur verwendet, um Ihnen zu antworten.",
  newChat: "Ein neues Gespräch beginnen",
  notices: {
    email: "Das sieht nicht wie eine E-Mail-Adresse aus. Dorthin geht die Antwort.",
    short: "Schreiben Sie etwas mehr, damit es etwas zu beantworten gibt.",
    limited: "Das waren viele Nachrichten. Warten Sie ein paar Minuten und senden Sie sie erneut.",
    closed: "Dieser Shop nimmt hier gerade keine Nachrichten an.",
    error: "Sie konnte gerade nicht gesendet werden. Versuchen Sie es gleich noch einmal.",
    gone: "Dieses Gespräch wird nicht mehr aufbewahrt. Beginnen Sie ein neues.",
  },
  replySubject: (store) => `${store} hat auf Ihre Nachricht geantwortet`,
  replyIntro: (store) => `${store} hat Ihnen geantwortet:`,
  replyLink: "Lesen Sie das ganze Gespräch und antworten Sie hier:",
  replyByEmail: "Antworten Sie auf diese E-Mail, um zurückzuschreiben.",
  affiliateSubject: (store) => `Eine Nachricht von ${store} an die Affiliates`,
  affiliateIntro: (store) => `Sie sind Affiliate von ${store}, und ${store} hat Ihnen geschrieben:`,
};

const it: ChatWords = {
  launcher: "Chat",
  title: (store) => `Scrivi a ${store}`,
  intro: (store) => `${store} risponde qui finché questa pagina è aperta, e via email quando te ne sei andato.`,
  email: "La tua email",
  name: "Il tuo nome (facoltativo)",
  message: "Il tuo messaggio",
  send: "Invia",
  close: "Chiudi",
  you: "Tu",
  sent: "Inviato. La risposta compare qui e arriva anche alla tua email.",
  closedNote: "Questa conversazione è stata chiusa. Scrivi di nuovo per riaprirla.",
  privacy: "Il tuo indirizzo serve solo a risponderti.",
  newChat: "Inizia una nuova conversazione",
  notices: {
    email: "Non sembra un indirizzo email. È lì che arriva la risposta.",
    short: "Scrivi qualcosa in più, così c'è qualcosa a cui rispondere.",
    limited: "Sono tanti messaggi. Aspetta qualche minuto, poi invialo di nuovo.",
    closed: "Questo negozio non riceve messaggi qui in questo momento.",
    error: "Non è stato possibile inviarlo ora. Riprova tra un momento.",
    gone: "Questa conversazione non è più conservata. Iniziane una nuova.",
  },
  replySubject: (store) => `${store} ha risposto al tuo messaggio`,
  replyIntro: (store) => `${store} ti ha risposto:`,
  replyLink: "Leggi tutta la conversazione e rispondi qui:",
  replyByEmail: "Rispondi a questa email per scrivere di nuovo.",
  affiliateSubject: (store) => `Un messaggio di ${store} per i suoi affiliati`,
  affiliateIntro: (store) => `Sei tra gli affiliati di ${store}, e ${store} ti ha scritto:`,
};

const nl: ChatWords = {
  launcher: "Chat",
  title: (store) => `Schrijf naar ${store}`,
  intro: (store) => `${store} antwoordt hier zolang deze pagina open is, en per e-mail als je al weg bent.`,
  email: "Je e-mail",
  name: "Je naam (niet verplicht)",
  message: "Je bericht",
  send: "Versturen",
  close: "Sluiten",
  you: "Jij",
  sent: "Verstuurd. Het antwoord verschijnt hier en komt ook in je e-mail.",
  closedNote: "Dit gesprek is gesloten. Schrijf opnieuw om het te openen.",
  privacy: "Je adres wordt alleen gebruikt om je te antwoorden.",
  newChat: "Een nieuw gesprek beginnen",
  notices: {
    email: "Dat lijkt geen e-mailadres. Daar komt het antwoord naartoe.",
    short: "Schrijf iets meer, zodat er iets te beantwoorden is.",
    limited: "Dat waren veel berichten. Wacht een paar minuten en verstuur het opnieuw.",
    closed: "Deze winkel neemt hier nu geen berichten aan.",
    error: "Het kon nu niet worden verstuurd. Probeer het zo opnieuw.",
    gone: "Dit gesprek wordt niet meer bewaard. Begin een nieuw gesprek.",
  },
  replySubject: (store) => `${store} heeft op je bericht geantwoord`,
  replyIntro: (store) => `${store} heeft je geantwoord:`,
  replyLink: "Lees het hele gesprek en antwoord hier:",
  replyByEmail: "Beantwoord deze e-mail om terug te schrijven.",
  affiliateSubject: (store) => `Een bericht van ${store} aan de affiliates`,
  affiliateIntro: (store) => `Je bent affiliate van ${store}, en ${store} schreef je:`,
};

const pt: ChatWords = {
  launcher: "Conversar",
  title: (store) => `Escreva a ${store}`,
  intro: (store) => `${store} responde aqui enquanto esta página está aberta, e por e-mail quando já tiver saído.`,
  email: "O seu e-mail",
  name: "O seu nome (opcional)",
  message: "A sua mensagem",
  send: "Enviar",
  close: "Fechar",
  you: "Você",
  sent: "Enviada. A resposta aparece aqui e chega também ao seu e-mail.",
  closedNote: "Esta conversa foi fechada. Escreva de novo para a reabrir.",
  privacy: "O seu endereço é usado apenas para lhe responder.",
  newChat: "Começar uma nova conversa",
  notices: {
    email: "Isso não parece um endereço de e-mail. É para lá que vai a resposta.",
    short: "Escreva um pouco mais, para haver algo a responder.",
    limited: "Foram muitas mensagens. Aguarde alguns minutos e envie de novo.",
    closed: "Esta loja não está a receber mensagens aqui neste momento.",
    error: "Não foi possível enviar agora. Tente de novo dentro de um momento.",
    gone: "Esta conversa já não está guardada. Comece uma nova.",
  },
  replySubject: (store) => `${store} respondeu à sua mensagem`,
  replyIntro: (store) => `${store} respondeu-lhe:`,
  replyLink: "Leia toda a conversa e responda aqui:",
  replyByEmail: "Responda a este e-mail para escrever de volta.",
  affiliateSubject: (store) => `Uma mensagem de ${store} para os seus afiliados`,
  affiliateIntro: (store) => `É afiliado de ${store}, e ${store} escreveu-lhe:`,
};

export const CHAT_WORDS: Record<LanguageCode, ChatWords> = { en, es, fr, de, it, nl, pt };

export function chatWords(language: unknown): ChatWords {
  return CHAT_WORDS[parseLanguage(language)];
}
