/**
 * The words of the contact form on a store page (lib/store-contact.ts) and the
 * page after it. The creator may write the form's heading and line in their
 * own words; these are what shows when they did not. Also the words around
 * the creator's business card on the same page (lib/creator-card.ts).
 * Browser-safe.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Notice = { title: string; body: string };

const en = {
  heading: "Get in touch",
  line: (store: string) => `Send ${store} a message: a question, a collaboration, anything. It goes to their inbox, and they answer you by email.`,
  name: "Your name",
  email: "Your email",
  message: "Your message",
  button: "Send the message",
  pageTitle: "Message",
  card: { pageTitle: "Contact card", back: "Back to the contact card", save: "Save contact", saveHint: "Adds this card to the contacts on your phone or computer.", email: "Email", phone: "Phone", website: "Website", store: (store: string) => `Visit ${store}` },
  sentTitle: "Your message is on its way",
  sentBody: (store: string) => `${store} has it, and answers you at the address you gave. Nothing else is sent to you.`,
  notices: {
    email: { title: "That does not look like an email address", body: "Check it and send the message again: it is where the answer goes." },
    short: { title: "Say a little more", body: "Write at least a sentence, so there is something to answer." },
    limited: { title: "Too many messages for now", body: "To keep this form from being used to flood anybody's inbox, it takes a few at a time. Try again later." },
    closed: { title: "This store is not taking messages", body: "Nothing was sent." },
    error: { title: "We could not send it just now", body: "Try again in a moment." },
  } as Record<string, Notice>,
};

export type ContactWords = typeof en;

const es: ContactWords = {
  heading: "Escríbeme",
  line: (store) => `Envía un mensaje a ${store}: una pregunta, una colaboración, lo que sea. Llega a su bandeja de entrada y te responde por email.`,
  name: "Tu nombre",
  email: "Tu email",
  message: "Tu mensaje",
  button: "Enviar el mensaje",
  pageTitle: "Mensaje",
  card: { pageTitle: "Tarjeta de contacto", back: "Volver a la tarjeta de contacto", save: "Guardar contacto", saveHint: "Añade esta tarjeta a los contactos de tu teléfono o tu ordenador.", email: "Correo electrónico", phone: "Teléfono", website: "Sitio web", store: (store) => `Visitar ${store}` },
  sentTitle: "Tu mensaje va en camino",
  sentBody: (store) => `${store} lo tiene y te responderá en la dirección que diste. No se te envía nada más.`,
  notices: {
    email: { title: "Eso no parece una dirección de email", body: "Revísala y vuelve a enviar el mensaje: es donde llega la respuesta." },
    short: { title: "Cuenta un poco más", body: "Escribe al menos una frase, para que haya algo que responder." },
    limited: { title: "Demasiados mensajes por ahora", body: "Para que este formulario no se use para llenar el buzón de nadie, acepta unos pocos a la vez. Inténtalo más tarde." },
    closed: { title: "Esta tienda no recibe mensajes", body: "No se envió nada." },
    error: { title: "No pudimos enviarlo ahora", body: "Inténtalo de nuevo en un momento." },
  },
};

const fr: ContactWords = {
  heading: "Me contacter",
  line: (store) => `Envoyez un message à ${store} : une question, une collaboration, ce que vous voulez. Il arrive dans sa boîte de réception, et la réponse vous parvient par e-mail.`,
  name: "Votre nom",
  email: "Votre e-mail",
  message: "Votre message",
  button: "Envoyer le message",
  pageTitle: "Votre message",
  card: { pageTitle: "Carte de contact", back: "Retour à la carte de contact", save: "Enregistrer le contact", saveHint: "Ajoute cette carte aux contacts de votre téléphone ou de votre ordinateur.", email: "E-mail", phone: "Téléphone", website: "Site web", store: (store) => `Visiter ${store}` },
  sentTitle: "Votre message est en route",
  sentBody: (store) => `${store} l'a reçu et vous répondra à l'adresse indiquée. Rien d'autre ne vous est envoyé.`,
  notices: {
    email: { title: "Cela ne ressemble pas à une adresse e-mail", body: "Vérifiez-la et renvoyez le message : c'est là qu'arrive la réponse." },
    short: { title: "Dites-en un peu plus", body: "Écrivez au moins une phrase, pour qu'il y ait quelque chose à répondre." },
    limited: { title: "Trop de messages pour le moment", body: "Pour que ce formulaire ne serve pas à inonder la boîte de quelqu'un, il en accepte peu à la fois. Réessayez plus tard." },
    closed: { title: "Cette boutique ne reçoit pas de messages", body: "Rien n'a été envoyé." },
    error: { title: "Impossible de l'envoyer pour l'instant", body: "Réessayez dans un instant." },
  },
};

const de: ContactWords = {
  heading: "Schreib mir",
  line: (store) => `Schick ${store} eine Nachricht: eine Frage, eine Zusammenarbeit, was du willst. Sie landet im Postfach, und die Antwort kommt per E-Mail.`,
  name: "Dein Name",
  email: "Deine E-Mail",
  message: "Deine Nachricht",
  button: "Nachricht senden",
  pageTitle: "Nachricht",
  card: { pageTitle: "Kontaktkarte", back: "Zurück zur Kontaktkarte", save: "Kontakt speichern", saveHint: "Fügt diese Karte den Kontakten auf deinem Telefon oder Computer hinzu.", email: "E-Mail", phone: "Telefon", website: "Webseite", store: (store) => `${store} besuchen` },
  sentTitle: "Deine Nachricht ist unterwegs",
  sentBody: (store) => `${store} hat sie und antwortet dir an die angegebene Adresse. Sonst wird dir nichts geschickt.`,
  notices: {
    email: { title: "Das sieht nicht nach einer E-Mail-Adresse aus", body: "Prüfe sie und sende die Nachricht noch einmal: Dorthin kommt die Antwort." },
    short: { title: "Schreib etwas mehr", body: "Mindestens einen Satz, damit es etwas zu beantworten gibt." },
    limited: { title: "Gerade zu viele Nachrichten", body: "Damit niemand mit diesem Formular ein Postfach flutet, nimmt es nur wenige auf einmal an. Versuche es später wieder." },
    closed: { title: "Dieser Shop nimmt keine Nachrichten an", body: "Es wurde nichts gesendet." },
    error: { title: "Wir konnten sie gerade nicht senden", body: "Versuche es gleich noch einmal." },
  },
};

const it: ContactWords = {
  heading: "Scrivimi",
  line: (store) => `Manda un messaggio a ${store}: una domanda, una collaborazione, quello che vuoi. Arriva nella sua casella e la risposta ti arriva via email.`,
  name: "Il tuo nome",
  email: "La tua email",
  message: "Il tuo messaggio",
  button: "Invia il messaggio",
  pageTitle: "Messaggio",
  card: { pageTitle: "Biglietto da visita", back: "Torna al biglietto da visita", save: "Salva il contatto", saveHint: "Aggiunge questo biglietto ai contatti del tuo telefono o computer.", email: "Indirizzo email", phone: "Telefono", website: "Sito web", store: (store) => `Visita ${store}` },
  sentTitle: "Il tuo messaggio è in viaggio",
  sentBody: (store) => `${store} l'ha ricevuto e ti risponderà all'indirizzo che hai dato. Non ti viene inviato nient'altro.`,
  notices: {
    email: { title: "Non sembra un indirizzo email", body: "Controllalo e invia di nuovo il messaggio: è lì che arriva la risposta." },
    short: { title: "Scrivi qualcosa in più", body: "Almeno una frase, così c'è qualcosa a cui rispondere." },
    limited: { title: "Troppi messaggi per ora", body: "Perché questo modulo non serva a riempire la casella di qualcuno, ne accetta pochi alla volta. Riprova più tardi." },
    closed: { title: "Questo negozio non riceve messaggi", body: "Non è stato inviato nulla." },
    error: { title: "Non siamo riusciti a inviarlo adesso", body: "Riprova tra un momento." },
  },
};

const nl: ContactWords = {
  heading: "Neem contact op",
  line: (store) => `Stuur ${store} een bericht: een vraag, een samenwerking, wat je maar wilt. Het komt in de inbox terecht, en je krijgt per e-mail antwoord.`,
  name: "Je naam",
  email: "Je e-mailadres",
  message: "Je bericht",
  button: "Bericht versturen",
  pageTitle: "Bericht",
  card: { pageTitle: "Contactkaart", back: "Terug naar de contactkaart", save: "Contact opslaan", saveHint: "Voegt deze kaart toe aan de contacten op je telefoon of computer.", email: "E-mail", phone: "Telefoon", website: "Internetsite", store: (store) => `Bezoek ${store}` },
  sentTitle: "Je bericht is onderweg",
  sentBody: (store) => `${store} heeft het en antwoordt op het adres dat je gaf. Verder wordt je niets gestuurd.`,
  notices: {
    email: { title: "Dat lijkt geen e-mailadres", body: "Controleer het en verstuur het bericht opnieuw: daar komt het antwoord." },
    short: { title: "Schrijf iets meer", body: "Minstens één zin, zodat er iets te beantwoorden valt." },
    limited: { title: "Even te veel berichten", body: "Zodat dit formulier niet gebruikt wordt om iemands inbox te overspoelen, neemt het er maar een paar tegelijk aan. Probeer het later opnieuw." },
    closed: { title: "Deze winkel neemt geen berichten aan", body: "Er is niets verstuurd." },
    error: { title: "We konden het nu niet versturen", body: "Probeer het zo opnieuw." },
  },
};

// European Portuguese: the courteous third person, as in lib/buyer-words/giving.ts.
const pt: ContactWords = {
  heading: "Contacte-me",
  line: (store) => `Envie uma mensagem a ${store}: uma pergunta, uma colaboração, o que quiser. Chega à caixa de entrada, e a resposta segue por email.`,
  name: "O seu nome",
  email: "O seu email",
  message: "A sua mensagem",
  button: "Enviar a mensagem",
  pageTitle: "Mensagem",
  card: { pageTitle: "Cartão de contacto", back: "Voltar ao cartão de contacto", save: "Guardar o contacto", saveHint: "Adiciona este cartão aos contactos do seu telemóvel ou computador.", email: "Endereço de email", phone: "Telefone", website: "Site", store: (store) => `Visitar ${store}` },
  sentTitle: "A sua mensagem está a caminho",
  sentBody: (store) => `${store} recebeu-a e responde-lhe no endereço que indicou. Não lhe é enviado mais nada.`,
  notices: {
    email: { title: "Isso não parece um endereço de email", body: "Verifique-o e envie a mensagem novamente: é para lá que vai a resposta." },
    short: { title: "Diga um pouco mais", body: "Escreva pelo menos uma frase, para que haja algo a responder." },
    limited: { title: "Demasiadas mensagens por agora", body: "Para que este formulário não seja usado para inundar a caixa de alguém, aceita poucas de cada vez. Tente novamente mais tarde." },
    closed: { title: "Esta loja não está a receber mensagens", body: "Nada foi enviado." },
    error: { title: "Não foi possível enviar agora", body: "Tente novamente daqui a pouco." },
  },
};

export const CONTACT_WORDS: Record<LanguageCode, ContactWords> = { en, es, fr, de, it, nl, pt };

export function contactWords(language: unknown): ContactWords {
  return CONTACT_WORDS[parseLanguage(language)];
}
