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
  line: (store: string) => `Send ${store} a message: a question, a collaboration, anything. We try to deliver it to their email. If they reply, their answer goes to yours.`,
  name: "Your name",
  email: "Your email",
  message: "Your message",
  button: "Send the message",
  pageTitle: "Message",
  card: { pageTitle: "Contact card", save: "Save contact", saveHint: "Adds this card to the contacts on your phone or computer.", email: "Email", phone: "Phone", website: "Website", store: (store: string) => `Visit ${store}` },
  sentTitle: "Your message was accepted for sending",
  sentBody: (store: string) => `The message was accepted for sending to ${store}'s email. If ${store} replies, the answer goes to the address you gave. Nothing else is sent to you.`,
  notices: {
    email: { title: "That does not look like an email address", body: "Check it and send the message again: it is where the answer goes." },
    short: { title: "Say a little more", body: "Write at least a sentence, so there is something to answer." },
    limited: { title: "Too many messages for now", body: "To keep this form from being used to flood anybody's inbox, it takes a few at a time. Try again later." },
    closed: { title: "This store is not taking messages", body: "Nothing was sent." },
    error: { title: "We could not send it just now", body: "Try again in a moment." },
    kept: { title: "Your message was received", body: "We kept your message in the store's inbox on Marktmorgen. Our email service did not confirm whether the email about it went out. Please do not send it again: the store could get it twice. If they reply, the answer goes to the address you gave." },
    unsure: { title: "We could not confirm your message was sent", body: "Our email service did not confirm whether it went out, and we could not keep a copy in the store's inbox. It may still arrive. If you send it again, the store could get it twice." },
  } as Record<string, Notice>,
};

export type ContactWords = typeof en;

const es: ContactWords = {
  heading: "Escríbeme",
  line: (store) => `Envía un mensaje a ${store}: una pregunta, una colaboración, lo que sea. Intentamos entregarlo en su email. Si responde, la respuesta llega al tuyo.`,
  name: "Tu nombre",
  email: "Tu email",
  message: "Tu mensaje",
  button: "Enviar el mensaje",
  pageTitle: "Mensaje",
  card: { pageTitle: "Tarjeta de contacto", save: "Guardar contacto", saveHint: "Añade esta tarjeta a los contactos de tu teléfono o tu ordenador.", email: "Correo electrónico", phone: "Teléfono", website: "Sitio web", store: (store) => `Visitar ${store}` },
  sentTitle: "Tu mensaje fue aceptado para el envío",
  sentBody: (store) => `El mensaje fue aceptado para enviarlo al email de ${store}. Si ${store} responde, la respuesta llega a la dirección que diste. No se te envía nada más.`,
  notices: {
    email: { title: "Eso no parece una dirección de email", body: "Revísala y vuelve a enviar el mensaje: es donde llega la respuesta." },
    short: { title: "Cuenta un poco más", body: "Escribe al menos una frase, para que haya algo que responder." },
    limited: { title: "Demasiados mensajes por ahora", body: "Para que este formulario no se use para llenar el buzón de nadie, acepta unos pocos a la vez. Inténtalo más tarde." },
    closed: { title: "Esta tienda no recibe mensajes", body: "No se envió nada." },
    error: { title: "No pudimos enviarlo ahora", body: "Inténtalo de nuevo en un momento." },
    kept: { title: "Recibimos tu mensaje", body: "Guardamos tu mensaje en la bandeja de entrada de la tienda en Marktmorgen. Nuestro servicio de email no confirmó si salió el email sobre él. Por favor, no lo envíes de nuevo: la tienda podría recibirlo dos veces. Si responde, la respuesta llega a la dirección que diste." },
    unsure: { title: "No pudimos confirmar que tu mensaje se envió", body: "Nuestro servicio de email no confirmó si salió, y no pudimos guardar una copia en la bandeja de entrada de la tienda. Puede que llegue igualmente. Si lo envías de nuevo, la tienda podría recibirlo dos veces." },
  },
};

const fr: ContactWords = {
  heading: "Me contacter",
  line: (store) => `Envoyez un message à ${store} : une question, une collaboration, ce que vous voulez. Nous essayons de le remettre à son adresse e-mail. Si ${store} répond, sa réponse arrive à la vôtre.`,
  name: "Votre nom",
  email: "Votre e-mail",
  message: "Votre message",
  button: "Envoyer le message",
  pageTitle: "Votre message",
  card: { pageTitle: "Carte de contact", save: "Enregistrer le contact", saveHint: "Ajoute cette carte aux contacts de votre téléphone ou de votre ordinateur.", email: "E-mail", phone: "Téléphone", website: "Site web", store: (store) => `Visiter ${store}` },
  sentTitle: "Votre message a été accepté pour envoi",
  sentBody: (store) => `Le message a été accepté pour être envoyé à l'adresse e-mail de ${store}. Si ${store} répond, la réponse arrive à l'adresse indiquée. Rien d'autre ne vous est envoyé.`,
  notices: {
    email: { title: "Cela ne ressemble pas à une adresse e-mail", body: "Vérifiez-la et renvoyez le message : c'est là qu'arrive la réponse." },
    short: { title: "Dites-en un peu plus", body: "Écrivez au moins une phrase, pour qu'il y ait quelque chose à répondre." },
    limited: { title: "Trop de messages pour le moment", body: "Pour que ce formulaire ne serve pas à inonder la boîte de quelqu'un, il en accepte peu à la fois. Réessayez plus tard." },
    closed: { title: "Cette boutique ne reçoit pas de messages", body: "Rien n'a été envoyé." },
    error: { title: "Impossible de l'envoyer pour l'instant", body: "Réessayez dans un instant." },
    kept: { title: "Nous avons reçu votre message", body: "Nous avons gardé votre message dans la boîte de réception de la boutique sur Marktmorgen. Notre service d'e-mail n'a pas confirmé l'envoi de l'e-mail qui le signale. Merci de ne pas le renvoyer : la boutique pourrait le recevoir deux fois. Si elle répond, la réponse arrive à l'adresse que vous avez donnée." },
    unsure: { title: "Nous n'avons pas pu confirmer l'envoi de votre message", body: "Notre service d'e-mail n'a pas confirmé son envoi, et nous n'avons pas pu en garder une copie dans la boîte de réception de la boutique. Il peut encore arriver. Si vous le renvoyez, la boutique pourrait le recevoir deux fois." },
  },
};

const de: ContactWords = {
  heading: "Schreib mir",
  line: (store) => `Schick ${store} eine Nachricht: eine Frage, eine Zusammenarbeit, was du willst. Wir versuchen, sie an die E-Mail-Adresse des Shops zu senden. Wenn ${store} antwortet, kommt die Antwort an deine.`,
  name: "Dein Name",
  email: "Deine E-Mail",
  message: "Deine Nachricht",
  button: "Nachricht senden",
  pageTitle: "Nachricht",
  card: { pageTitle: "Kontaktkarte", save: "Kontakt speichern", saveHint: "Fügt diese Karte den Kontakten auf deinem Telefon oder Computer hinzu.", email: "E-Mail", phone: "Telefon", website: "Webseite", store: (store) => `${store} besuchen` },
  sentTitle: "Deine Nachricht wurde zum Senden angenommen",
  sentBody: (store) => `Die Nachricht wurde zum Senden an die E-Mail-Adresse von ${store} angenommen. Wenn ${store} antwortet, geht die Antwort an die von dir angegebene Adresse. Sonst wird dir nichts geschickt.`,
  notices: {
    email: { title: "Das sieht nicht nach einer E-Mail-Adresse aus", body: "Prüfe sie und sende die Nachricht noch einmal: Dorthin kommt die Antwort." },
    short: { title: "Schreib etwas mehr", body: "Mindestens einen Satz, damit es etwas zu beantworten gibt." },
    limited: { title: "Gerade zu viele Nachrichten", body: "Damit niemand mit diesem Formular ein Postfach flutet, nimmt es nur wenige auf einmal an. Versuche es später wieder." },
    closed: { title: "Dieser Shop nimmt keine Nachrichten an", body: "Es wurde nichts gesendet." },
    error: { title: "Wir konnten sie gerade nicht senden", body: "Versuche es gleich noch einmal." },
    kept: { title: "Wir haben deine Nachricht erhalten", body: "Wir haben deine Nachricht im Posteingang des Shops auf Marktmorgen gespeichert. Unser E-Mail-Dienst hat nicht bestätigt, ob die E-Mail dazu versendet wurde. Bitte sende sie nicht noch einmal: Der Shop könnte sie sonst zweimal bekommen. Wenn er antwortet, geht die Antwort an die Adresse, die du angegeben hast." },
    unsure: { title: "Wir konnten nicht bestätigen, dass deine Nachricht gesendet wurde", body: "Unser E-Mail-Dienst hat nicht bestätigt, ob sie versendet wurde, und wir konnten keine Kopie im Posteingang des Shops speichern. Sie kann trotzdem ankommen. Wenn du sie noch einmal sendest, könnte der Shop sie zweimal bekommen." },
  },
};

const it: ContactWords = {
  heading: "Scrivimi",
  line: (store) => `Manda un messaggio a ${store}: una domanda, una collaborazione, quello che vuoi. Cerchiamo di consegnarlo alla sua email. Se ${store} risponde, la risposta arriva alla tua.`,
  name: "Il tuo nome",
  email: "La tua email",
  message: "Il tuo messaggio",
  button: "Invia il messaggio",
  pageTitle: "Messaggio",
  card: { pageTitle: "Biglietto da visita", save: "Salva il contatto", saveHint: "Aggiunge questo biglietto ai contatti del tuo telefono o computer.", email: "Indirizzo email", phone: "Telefono", website: "Sito web", store: (store) => `Visita ${store}` },
  sentTitle: "Il tuo messaggio è stato accettato per l'invio",
  sentBody: (store) => `Il messaggio è stato accettato per essere inviato all'email di ${store}. Se ${store} risponde, la risposta arriva all'indirizzo che hai dato. Non ti viene inviato nient'altro.`,
  notices: {
    email: { title: "Non sembra un indirizzo email", body: "Controllalo e invia di nuovo il messaggio: è lì che arriva la risposta." },
    short: { title: "Scrivi qualcosa in più", body: "Almeno una frase, così c'è qualcosa a cui rispondere." },
    limited: { title: "Troppi messaggi per ora", body: "Perché questo modulo non serva a riempire la casella di qualcuno, ne accetta pochi alla volta. Riprova più tardi." },
    closed: { title: "Questo negozio non riceve messaggi", body: "Non è stato inviato nulla." },
    error: { title: "Non siamo riusciti a inviarlo adesso", body: "Riprova tra un momento." },
    kept: { title: "Abbiamo ricevuto il tuo messaggio", body: "Abbiamo salvato il tuo messaggio nella casella del negozio su Marktmorgen. Il nostro servizio email non ha confermato se l'email che lo segnala è partita. Per favore non inviarlo di nuovo: il negozio potrebbe riceverlo due volte. Se risponde, la risposta arriva all'indirizzo che hai indicato." },
    unsure: { title: "Non siamo riusciti a confermare l'invio del tuo messaggio", body: "Il nostro servizio email non ha confermato se è partito, e non siamo riusciti a salvarne una copia nella casella del negozio. Potrebbe comunque arrivare. Se lo invii di nuovo, il negozio potrebbe riceverlo due volte." },
  },
};

const nl: ContactWords = {
  heading: "Neem contact op",
  line: (store) => `Stuur ${store} een bericht: een vraag, een samenwerking, wat je maar wilt. We proberen het op hun e-mailadres te bezorgen. Als ${store} antwoordt, gaat het antwoord naar jouw adres.`,
  name: "Je naam",
  email: "Je e-mailadres",
  message: "Je bericht",
  button: "Bericht versturen",
  pageTitle: "Bericht",
  card: { pageTitle: "Contactkaart", save: "Contact opslaan", saveHint: "Voegt deze kaart toe aan de contacten op je telefoon of computer.", email: "E-mail", phone: "Telefoon", website: "Internetsite", store: (store) => `Bezoek ${store}` },
  sentTitle: "Je bericht is geaccepteerd voor verzending",
  sentBody: (store) => `Het bericht is geaccepteerd om naar het e-mailadres van ${store} te worden verstuurd. Als ${store} antwoordt, gaat het antwoord naar het adres dat je opgaf. Verder wordt er niets naar je gestuurd.`,
  notices: {
    email: { title: "Dat lijkt geen e-mailadres", body: "Controleer het en verstuur het bericht opnieuw: daar komt het antwoord." },
    short: { title: "Schrijf iets meer", body: "Minstens één zin, zodat er iets te beantwoorden valt." },
    limited: { title: "Even te veel berichten", body: "Zodat dit formulier niet gebruikt wordt om iemands inbox te overspoelen, neemt het er maar een paar tegelijk aan. Probeer het later opnieuw." },
    closed: { title: "Deze winkel neemt geen berichten aan", body: "Er is niets verstuurd." },
    error: { title: "We konden het nu niet versturen", body: "Probeer het zo opnieuw." },
    kept: { title: "We hebben je bericht ontvangen", body: "We hebben je bericht bewaard in de inbox van de winkel op Marktmorgen. Onze e-maildienst heeft niet bevestigd of de e-mail erover is verstuurd. Stuur het alsjeblieft niet opnieuw: de winkel kan het dan twee keer krijgen. Als de winkel antwoordt, gaat het antwoord naar het adres dat je hebt opgegeven." },
    unsure: { title: "We konden niet bevestigen dat je bericht is verstuurd", body: "Onze e-maildienst heeft niet bevestigd of het is verstuurd, en we konden geen kopie bewaren in de inbox van de winkel. Het kan alsnog aankomen. Als je het opnieuw stuurt, kan de winkel het twee keer krijgen." },
  },
};

// European Portuguese: the courteous third person, as in lib/buyer-words/giving.ts.
const pt: ContactWords = {
  heading: "Contacte-me",
  line: (store) => `Envie uma mensagem a ${store}: uma pergunta, uma colaboração, o que quiser. Tentamos entregá-la no email da loja. Se ${store} responder, a resposta segue para o seu.`,
  name: "O seu nome",
  email: "O seu email",
  message: "A sua mensagem",
  button: "Enviar a mensagem",
  pageTitle: "Mensagem",
  card: { pageTitle: "Cartão de contacto", save: "Guardar o contacto", saveHint: "Adiciona este cartão aos contactos do seu telemóvel ou computador.", email: "Endereço de email", phone: "Telefone", website: "Site", store: (store) => `Visitar ${store}` },
  sentTitle: "A sua mensagem foi aceite para envio",
  sentBody: (store) => `A mensagem foi aceite para envio para o endereço de email de ${store}. Se ${store} responder, a resposta segue para o endereço que indicou. Não lhe é enviado mais nada.`,
  notices: {
    email: { title: "Isso não parece um endereço de email", body: "Verifique-o e envie a mensagem novamente: é para lá que vai a resposta." },
    short: { title: "Diga um pouco mais", body: "Escreva pelo menos uma frase, para que haja algo a responder." },
    limited: { title: "Demasiadas mensagens por agora", body: "Para que este formulário não seja usado para inundar a caixa de alguém, aceita poucas de cada vez. Tente novamente mais tarde." },
    closed: { title: "Esta loja não está a receber mensagens", body: "Nada foi enviado." },
    error: { title: "Não foi possível enviar agora", body: "Tente novamente daqui a pouco." },
    kept: { title: "Recebemos a sua mensagem", body: "Guardámos a sua mensagem na caixa de entrada da loja no Marktmorgen. O nosso serviço de email não confirmou se o email sobre ela foi enviado. Por favor, não a envie de novo: a loja poderia recebê-la duas vezes. Se a loja responder, a resposta segue para o endereço que indicou." },
    unsure: { title: "Não foi possível confirmar o envio da sua mensagem", body: "O nosso serviço de email não confirmou se foi enviada, e não foi possível guardar uma cópia na caixa de entrada da loja. Ainda pode chegar. Se a enviar de novo, a loja poderá recebê-la duas vezes." },
  },
};

export const CONTACT_WORDS: Record<LanguageCode, ContactWords> = { en, es, fr, de, it, nl, pt };

export function contactWords(language: unknown): ContactWords {
  return CONTACT_WORDS[parseLanguage(language)];
}
