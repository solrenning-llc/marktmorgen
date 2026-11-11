/**
 * The words of "Email me when it's back" (623 [SZ7], lib/stock-alerts.ts) in
 * each language a store can speak: its page (the buttons that confirm or
 * remove an address, and what happened after each) and its two emails (the
 * confirmation, and the one email when the product is back in stock).
 *
 * No urgency, scarcity or invented number: the product page already shows
 * the real number left (lib/stock.ts).
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type StockAlertNotice = { title: string; body: string };

/** What the page says after the form or a link, by its `status`. */
export type StockAlertStatus = "email" | "limited" | "full" | "closed" | "unsent" | "error" | "expired";

export type StockAlertWords = {
  /** The page's name, and the small label above its heading. */
  label: string;
  sentTitle: string;
  /** `title` is empty when the product is gone. */
  sentBody: (title: string, store: string) => string;
  confirmTitle: string;
  confirmBody: (store: string, title: string) => string;
  confirmButton: string;
  confirmedTitle: (title: string) => string;
  confirmedBody: string;
  removeTitle: string;
  removeBody: (title: string) => string;
  removeButton: string;
  removedTitle: string;
  notOnListTitle: string;
  notOnListBody: string;
  notices: Record<StockAlertStatus, StockAlertNotice>;
  /** The confirmation email. */
  askSubject: (title: string) => string;
  askLead: (store: string, title: string) => string;
  askOpen: string;
  askWorks: string;
  askIgnore: string;
  askWhy: (store: string, title: string) => string;
  /** The one email when it is back. `price` is empty for a product with no price to say. */
  backSubject: (title: string) => string;
  backLead: (store: string, title: string, price: string) => string;
  backAfter: string;
  backWhy: (title: string) => string;
  /** The way out at the foot of both emails. */
  doorLabel: string;
  doorAfter: string;
  doorLine: (link: string) => string;
};

const it_ = (title: string, fallback: string) => title || fallback;

const en: StockAlertWords = {
  label: "Back in stock",
  sentTitle: "Check your inbox",
  sentBody: (title, store) =>
    `We emailed you a button to confirm. Once you press it, ${store} emails you once, when ${it_(title, "it")} is back in stock. If the email is not there, look in spam.`,
  confirmTitle: "Confirm your address",
  confirmBody: (store, title) => `Press the button and ${store} emails you once, when ${it_(title, "it")} is back in stock.`,
  confirmButton: "Confirm my address",
  confirmedTitle: (title) => `We will email you when ${it_(title, "it")} is back`,
  confirmedBody: "One email, when it is back in stock. Then your address is deleted from this list.",
  removeTitle: "Remove your address?",
  removeBody: (title) => `You will not be told when ${it_(title, "it")} is back in stock.`,
  removeButton: "Remove my address",
  removedTitle: "Your address is removed",
  notOnListTitle: "Your address is not on this list",
  notOnListBody: "It was removed already, or the product came back in stock and the list was deleted.",
  notices: {
    email: { title: "That does not look like an email address", body: "Check it and try again. The confirmation goes to the address you type, so it has to be one you can open." },
    limited: { title: "Too many requests for now", body: "To keep this form from being used to flood somebody's inbox, it takes a limited number an hour. Try again in an hour." },
    full: { title: "This list is full", body: "It holds as many people as it can. Nothing was kept." },
    closed: { title: "This is not sold out", body: "It may be back in stock already, or this store does not send these emails. Nothing was kept." },
    unsent: {
      title: "We could not send the confirmation email",
      body: "The store may have used its emails for now, or the email service did not answer. Nothing is sent to you unless you confirm. Try again later.",
    },
    error: { title: "Something went wrong", body: "Nothing was sent. Try again in a moment." },
    expired: { title: "This link has expired", body: "A confirmation link works for 7 days. Ask again from the product's page; it takes a few seconds." },
  },
  askSubject: (title) => `Confirm: email me when ${title} is back`,
  askLead: (store, title) => `You asked ${store} to email you when ${title} is back in stock.`,
  askOpen: "Open this link and press the button to confirm it was you:",
  askWorks: "It works for 7 days. When it is back, you get one email, and that is the only email this list sends. Then your address is deleted.",
  askIgnore: "If you did not ask for this, ignore this email. Nothing is sent unless the button is pressed.",
  askWhy: (store, title) => `You are getting this because this address was typed on ${store}'s page for ${title}.`,
  backSubject: (title) => `${title} is back in stock`,
  backLead: (store, title, price) => `You asked ${store} to email you when ${title} was back in stock. It is back now${price ? `, at ${price}` : ""}:`,
  backAfter: "This is the only email this list sends, and your address is deleted from it after this email.",
  backWhy: (title) => `You are getting this because you asked to be told when ${title} is back in stock and confirmed your address.`,
  doorLabel: "Remove my address",
  doorAfter: "from this list.",
  doorLine: (link) => `Remove my address: ${link}`,
};

const es: StockAlertWords = {
  label: "De nuevo disponible",
  sentTitle: "Revisa tu bandeja de entrada",
  sentBody: (title, store) =>
    `Te enviamos un botón para confirmar. Cuando lo pulses, ${store} te escribirá una sola vez, cuando ${it_(title, "el producto")} vuelva a estar disponible. Si el correo no está, mira en spam.`,
  confirmTitle: "Confirma tu dirección",
  confirmBody: (store, title) => `Pulsa el botón y ${store} te escribirá una sola vez, cuando ${it_(title, "el producto")} vuelva a estar disponible.`,
  confirmButton: "Confirmar mi dirección",
  confirmedTitle: (title) => `Te escribiremos cuando ${it_(title, "el producto")} vuelva`,
  confirmedBody: "Un solo correo, cuando vuelva a estar disponible. Después tu dirección se borra de esta lista.",
  removeTitle: "¿Quitar tu dirección?",
  removeBody: (title) => `No se te avisará cuando ${it_(title, "el producto")} vuelva a estar disponible.`,
  removeButton: "Quitar mi dirección",
  removedTitle: "Tu dirección se ha quitado",
  notOnListTitle: "Tu dirección no está en esta lista",
  notOnListBody: "Ya se quitó, o el producto volvió a estar disponible y la lista se borró.",
  notices: {
    email: { title: "Eso no parece una dirección de correo", body: "Revísala e inténtalo de nuevo. La confirmación va a la dirección que escribas, así que tiene que ser una que puedas abrir." },
    limited: { title: "Demasiadas solicitudes por ahora", body: "Para que este formulario no se use para llenar el correo de alguien, acepta un número limitado por hora. Inténtalo dentro de una hora." },
    full: { title: "Esta lista está llena", body: "Tiene tantas personas como puede. No se guardó nada." },
    closed: { title: "No está agotado", body: "Puede que ya esté disponible, o esta tienda no envía estos correos. No se guardó nada." },
    unsent: {
      title: "No pudimos enviar el correo de confirmación",
      body: "Puede que la tienda haya usado sus correos por ahora, o que el servicio de correo no respondiera. No se te enviará nada si no confirmas. Inténtalo más tarde.",
    },
    error: { title: "Algo salió mal", body: "No se envió nada. Inténtalo de nuevo en un momento." },
    expired: { title: "Este enlace ha caducado", body: "Un enlace de confirmación funciona 7 días. Pídelo de nuevo desde la página del producto; tarda unos segundos." },
  },
  askSubject: (title) => `Confirma: avísame cuando ${title} vuelva`,
  askLead: (store, title) => `Pediste a ${store} que te escribiera cuando ${title} volviera a estar disponible.`,
  askOpen: "Abre este enlace y pulsa el botón para confirmar que fuiste tú:",
  askWorks: "Funciona 7 días. Cuando vuelva, recibirás un correo, y es el único que envía esta lista. Después tu dirección se borra.",
  askIgnore: "Si no lo pediste, ignora este correo. No se envía nada si no se pulsa el botón.",
  askWhy: (store, title) => `Recibes esto porque esta dirección se escribió en la página de ${title} de ${store}.`,
  backSubject: (title) => `${title} vuelve a estar disponible`,
  backLead: (store, title, price) => `Pediste a ${store} que te escribiera cuando ${title} volviera a estar disponible. Ya está disponible${price ? `, por ${price}` : ""}:`,
  backAfter: "Es el único correo que envía esta lista, y tu dirección se borra de ella después de este envío.",
  backWhy: (title) => `Recibes esto porque pediste que te avisaran cuando ${title} volviera y confirmaste tu dirección.`,
  doorLabel: "Quitar mi dirección",
  doorAfter: "de esta lista.",
  doorLine: (link) => `Quitar mi dirección: ${link}`,
};

const fr: StockAlertWords = {
  label: "De retour en stock",
  sentTitle: "Regardez votre boîte de réception",
  sentBody: (title, store) =>
    `Nous vous avons envoyé un bouton pour confirmer. Une fois que vous l’aurez utilisé, ${store} vous écrira une seule fois, quand ${it_(title, "le produit")} sera de retour en stock. Si l’e-mail n’est pas là, regardez dans les spams.`,
  confirmTitle: "Confirmez votre adresse",
  confirmBody: (store, title) => `Appuyez sur le bouton et ${store} vous écrira une seule fois, quand ${it_(title, "le produit")} sera de retour en stock.`,
  confirmButton: "Confirmer mon adresse",
  confirmedTitle: (title) => `Nous vous écrirons quand ${it_(title, "le produit")} sera de retour`,
  confirmedBody: "Un seul e-mail, quand il sera de retour en stock. Ensuite, votre adresse est supprimée de cette liste.",
  removeTitle: "Retirer votre adresse ?",
  removeBody: (title) => `Vous ne serez pas prévenu quand ${it_(title, "le produit")} sera de retour en stock.`,
  removeButton: "Retirer mon adresse",
  removedTitle: "Votre adresse est retirée",
  notOnListTitle: "Votre adresse n’est pas sur cette liste",
  notOnListBody: "Elle a déjà été retirée, ou le produit est revenu en stock et la liste a été supprimée.",
  notices: {
    email: { title: "Cela ne ressemble pas à une adresse e-mail", body: "Vérifiez-la et réessayez. La confirmation part à l’adresse saisie, qui doit donc être une adresse que vous pouvez ouvrir." },
    limited: { title: "Trop de demandes pour l’instant", body: "Pour que ce formulaire ne serve pas à remplir la boîte de quelqu’un, il en accepte un nombre limité par heure. Réessayez dans une heure." },
    full: { title: "Cette liste est complète", body: "Elle contient autant de personnes que possible. Rien n’a été gardé." },
    closed: { title: "Ce produit n’est pas épuisé", body: "Il est peut-être déjà de retour, ou cette boutique n’envoie pas ces e-mails. Rien n’a été gardé." },
    unsent: {
      title: "Nous n’avons pas pu envoyer l’e-mail de confirmation",
      body: "La boutique a peut-être utilisé ses e-mails pour le moment, ou le service d’e-mail n’a pas répondu. Rien ne vous est envoyé sans confirmation. Réessayez plus tard.",
    },
    error: { title: "Un problème est survenu", body: "Rien n’a été envoyé. Réessayez dans un instant." },
    expired: { title: "Ce lien a expiré", body: "Un lien de confirmation fonctionne 7 jours. Redemandez-le depuis la page du produit ; cela prend quelques secondes." },
  },
  askSubject: (title) => `Confirmez : prévenez-moi quand ${title} sera de retour`,
  askLead: (store, title) => `Vous avez demandé à ${store} de vous écrire quand ${title} sera de retour en stock.`,
  askOpen: "Ouvrez ce lien et appuyez sur le bouton pour confirmer que c’était bien vous :",
  askWorks: "Il fonctionne 7 jours. Quand il sera de retour, vous recevrez un e-mail, le seul que cette liste envoie. Ensuite, votre adresse est supprimée.",
  askIgnore: "Si vous n’avez rien demandé, ignorez cet e-mail. Rien n’est envoyé sans que le bouton soit utilisé.",
  askWhy: (store, title) => `Vous recevez ceci parce que cette adresse a été saisie sur la page de ${title} de ${store}.`,
  backSubject: (title) => `${title} est de retour en stock`,
  backLead: (store, title, price) => `Vous avez demandé à ${store} de vous écrire quand ${title} serait de retour en stock. Il est de retour${price ? `, à ${price}` : ""} :`,
  backAfter: "C’est le seul e-mail que cette liste envoie, et votre adresse en est supprimée après cet envoi.",
  backWhy: (title) => `Vous recevez ceci parce que vous avez demandé à être prévenu du retour de ${title} et confirmé votre adresse.`,
  doorLabel: "Retirer mon adresse",
  doorAfter: "de cette liste.",
  doorLine: (link) => `Retirer mon adresse : ${link}`,
};

const de: StockAlertWords = {
  label: "Wieder verfügbar",
  sentTitle: "Sieh in dein Postfach",
  sentBody: (title, store) =>
    `Wir haben dir einen Button zum Bestätigen geschickt. Sobald du ihn drückst, schreibt dir ${store} ein einziges Mal, wenn ${it_(title, "das Produkt")} wieder verfügbar ist. Wenn die E-Mail nicht da ist, sieh im Spam nach.`,
  confirmTitle: "Bestätige deine Adresse",
  confirmBody: (store, title) => `Drück den Button und ${store} schreibt dir ein einziges Mal, wenn ${it_(title, "das Produkt")} wieder verfügbar ist.`,
  confirmButton: "Meine Adresse bestätigen",
  confirmedTitle: (title) => `Wir schreiben dir, wenn ${it_(title, "das Produkt")} wieder da ist`,
  confirmedBody: "Eine E-Mail, wenn es wieder verfügbar ist. Danach wird deine Adresse aus dieser Liste gelöscht.",
  removeTitle: "Deine Adresse entfernen?",
  removeBody: (title) => `Du erfährst dann nicht, wenn ${it_(title, "das Produkt")} wieder verfügbar ist.`,
  removeButton: "Meine Adresse entfernen",
  removedTitle: "Deine Adresse ist entfernt",
  notOnListTitle: "Deine Adresse steht nicht auf dieser Liste",
  notOnListBody: "Sie wurde schon entfernt, oder das Produkt war wieder verfügbar und die Liste wurde gelöscht.",
  notices: {
    email: { title: "Das sieht nicht nach einer E-Mail-Adresse aus", body: "Prüf sie und versuch es noch einmal. Die Bestätigung geht an die Adresse, die du eingibst, also muss es eine sein, die du öffnen kannst." },
    limited: { title: "Gerade zu viele Anfragen", body: "Damit dieses Formular nicht benutzt wird, um jemandes Postfach zu füllen, nimmt es nur eine begrenzte Zahl pro Stunde an. Versuch es in einer Stunde wieder." },
    full: { title: "Diese Liste ist voll", body: "Sie fasst so viele Personen, wie sie kann. Es wurde nichts gespeichert." },
    closed: { title: "Das ist nicht ausverkauft", body: "Vielleicht ist es schon wieder verfügbar, oder dieser Shop verschickt diese E-Mails nicht. Es wurde nichts gespeichert." },
    unsent: {
      title: "Wir konnten die Bestätigungs-E-Mail nicht senden",
      body: "Vielleicht hat der Shop seine E-Mails vorerst aufgebraucht, oder der E-Mail-Dienst hat nicht geantwortet. Ohne Bestätigung wird dir nichts geschickt. Versuch es später noch einmal.",
    },
    error: { title: "Etwas ist schiefgegangen", body: "Es wurde nichts gesendet. Versuch es gleich noch einmal." },
    expired: { title: "Dieser Link ist abgelaufen", body: "Ein Bestätigungslink gilt 7 Tage. Frag auf der Produktseite noch einmal; das dauert ein paar Sekunden." },
  },
  askSubject: (title) => `Bestätigen: Schreib mir, wenn ${title} wieder da ist`,
  askLead: (store, title) => `Du hast ${store} gebeten, dir zu schreiben, wenn ${title} wieder verfügbar ist.`,
  askOpen: "Öffne diesen Link und drück den Button, um zu bestätigen, dass du es warst:",
  askWorks: "Er gilt 7 Tage. Wenn es wieder da ist, bekommst du eine E-Mail, die einzige, die diese Liste verschickt. Danach wird deine Adresse gelöscht.",
  askIgnore: "Wenn du das nicht angefordert hast, ignorier diese E-Mail. Ohne den Button wird nichts gesendet.",
  askWhy: (store, title) => `Du bekommst das, weil diese Adresse auf der Seite von ${title} bei ${store} eingegeben wurde.`,
  backSubject: (title) => `${title} ist wieder verfügbar`,
  backLead: (store, title, price) => `Du hast ${store} gebeten, dir zu schreiben, wenn ${title} wieder verfügbar ist. Es ist jetzt wieder da${price ? `, für ${price}` : ""}:`,
  backAfter: "Das ist die einzige E-Mail, die diese Liste verschickt, und deine Adresse wird danach daraus gelöscht.",
  backWhy: (title) => `Du bekommst das, weil du benachrichtigt werden wolltest, wenn ${title} wieder verfügbar ist, und deine Adresse bestätigt hast.`,
  doorLabel: "Meine Adresse entfernen",
  doorAfter: "von dieser Liste.",
  doorLine: (link) => `Meine Adresse entfernen: ${link}`,
};

const it: StockAlertWords = {
  label: "Di nuovo disponibile",
  sentTitle: "Controlla la tua casella di posta",
  sentBody: (title, store) =>
    `Ti abbiamo inviato un pulsante per confermare. Quando lo premi, ${store} ti scriverà una sola volta, quando ${it_(title, "il prodotto")} sarà di nuovo disponibile. Se l’email non c’è, guarda nello spam.`,
  confirmTitle: "Conferma il tuo indirizzo",
  confirmBody: (store, title) => `Premi il pulsante e ${store} ti scriverà una sola volta, quando ${it_(title, "il prodotto")} sarà di nuovo disponibile.`,
  confirmButton: "Conferma il mio indirizzo",
  confirmedTitle: (title) => `Ti scriveremo quando ${it_(title, "il prodotto")} tornerà`,
  confirmedBody: "Una sola email, quando sarà di nuovo disponibile. Poi il tuo indirizzo viene cancellato da questa lista.",
  removeTitle: "Togliere il tuo indirizzo?",
  removeBody: (title) => `Non ti avviseremo quando ${it_(title, "il prodotto")} sarà di nuovo disponibile.`,
  removeButton: "Togli il mio indirizzo",
  removedTitle: "Il tuo indirizzo è stato tolto",
  notOnListTitle: "Il tuo indirizzo non è in questa lista",
  notOnListBody: "È già stato tolto, oppure il prodotto è tornato disponibile e la lista è stata cancellata.",
  notices: {
    email: { title: "Non sembra un indirizzo email", body: "Controllalo e riprova. La conferma va all’indirizzo che scrivi, quindi deve essere uno che puoi aprire." },
    limited: { title: "Troppe richieste per ora", body: "Perché questo modulo non venga usato per riempire la casella di qualcuno, ne accetta un numero limitato all’ora. Riprova tra un’ora." },
    full: { title: "Questa lista è piena", body: "Contiene tutte le persone che può. Non è stato salvato nulla." },
    closed: { title: "Non è esaurito", body: "Forse è già di nuovo disponibile, oppure questo negozio non invia queste email. Non è stato salvato nulla." },
    unsent: {
      title: "Non siamo riusciti a inviare l’email di conferma",
      body: "Forse il negozio ha usato le sue email per ora, oppure il servizio email non ha risposto. Senza conferma non ti viene inviato nulla. Riprova più tardi.",
    },
    error: { title: "Qualcosa è andato storto", body: "Non è stato inviato nulla. Riprova tra un momento." },
    expired: { title: "Questo link è scaduto", body: "Un link di conferma vale 7 giorni. Chiedilo di nuovo dalla pagina del prodotto; servono pochi secondi." },
  },
  askSubject: (title) => `Conferma: avvisami quando ${title} torna`,
  askLead: (store, title) => `Hai chiesto a ${store} di scriverti quando ${title} sarà di nuovo disponibile.`,
  askOpen: "Apri questo link e premi il pulsante per confermare che eri tu:",
  askWorks: "Vale 7 giorni. Quando tornerà, riceverai un’email, l’unica che questa lista invia. Poi il tuo indirizzo viene cancellato.",
  askIgnore: "Se non l’hai chiesto, ignora questa email. Non viene inviato nulla se il pulsante non viene premuto.",
  askWhy: (store, title) => `Ricevi questo perché questo indirizzo è stato scritto nella pagina di ${title} di ${store}.`,
  backSubject: (title) => `${title} è di nuovo disponibile`,
  backLead: (store, title, price) => `Hai chiesto a ${store} di scriverti quando ${title} sarebbe stato di nuovo disponibile. Ora lo è${price ? `, a ${price}` : ""}:`,
  backAfter: "È l’unica email che questa lista invia, e il tuo indirizzo viene cancellato dopo questo invio.",
  backWhy: (title) => `Ricevi questo perché hai chiesto di essere avvisato quando ${title} sarebbe tornato e hai confermato il tuo indirizzo.`,
  doorLabel: "Togli il mio indirizzo",
  doorAfter: "da questa lista.",
  doorLine: (link) => `Togli il mio indirizzo: ${link}`,
};

const nl: StockAlertWords = {
  label: "Weer op voorraad",
  sentTitle: "Kijk in je inbox",
  sentBody: (title, store) =>
    `We hebben je een knop gemaild om te bevestigen. Zodra je erop drukt, mailt ${store} je één keer, wanneer ${it_(title, "het product")} weer op voorraad is. Staat de e-mail er niet, kijk dan in je spam.`,
  confirmTitle: "Bevestig je adres",
  confirmBody: (store, title) => `Druk op de knop en ${store} mailt je één keer, wanneer ${it_(title, "het product")} weer op voorraad is.`,
  confirmButton: "Mijn adres bevestigen",
  confirmedTitle: (title) => `We mailen je wanneer ${it_(title, "het product")} terug is`,
  confirmedBody: "Eén e-mail, wanneer het weer op voorraad is. Daarna wordt je adres van deze lijst gewist.",
  removeTitle: "Je adres verwijderen?",
  removeBody: (title) => `Je hoort dan niet wanneer ${it_(title, "het product")} weer op voorraad is.`,
  removeButton: "Mijn adres verwijderen",
  removedTitle: "Je adres is verwijderd",
  notOnListTitle: "Je adres staat niet op deze lijst",
  notOnListBody: "Het is al verwijderd, of het product was weer op voorraad en de lijst is gewist.",
  notices: {
    email: { title: "Dat lijkt geen e-mailadres", body: "Controleer het en probeer het opnieuw. De bevestiging gaat naar het adres dat je typt, dus het moet er een zijn dat je kunt openen." },
    limited: { title: "Te veel aanvragen op dit moment", body: "Zodat dit formulier niet gebruikt wordt om iemands inbox te vullen, neemt het een beperkt aantal per uur aan. Probeer het over een uur opnieuw." },
    full: { title: "Deze lijst is vol", body: "Er staan zoveel mensen op als er passen. Er is niets bewaard." },
    closed: { title: "Dit is niet uitverkocht", body: "Misschien is het al weer op voorraad, of deze winkel verstuurt deze e-mails niet. Er is niets bewaard." },
    unsent: {
      title: "We konden de bevestigingsmail niet versturen",
      body: "Misschien heeft de winkel zijn e-mails voorlopig gebruikt, of de e-maildienst antwoordde niet. Zonder bevestiging wordt je niets gestuurd. Probeer het later opnieuw.",
    },
    error: { title: "Er ging iets mis", body: "Er is niets verstuurd. Probeer het zo opnieuw." },
    expired: { title: "Deze link is verlopen", body: "Een bevestigingslink werkt 7 dagen. Vraag het opnieuw via de productpagina; dat duurt een paar seconden." },
  },
  askSubject: (title) => `Bevestig: mail me wanneer ${title} terug is`,
  askLead: (store, title) => `Je vroeg ${store} je te mailen wanneer ${title} weer op voorraad is.`,
  askOpen: "Open deze link en druk op de knop om te bevestigen dat jij het was:",
  askWorks: "Hij werkt 7 dagen. Wanneer het terug is, krijg je één e-mail, de enige die deze lijst verstuurt. Daarna wordt je adres gewist.",
  askIgnore: "Heb je dit niet gevraagd, negeer dan deze e-mail. Er wordt niets verstuurd zolang niemand op de knop drukt.",
  askWhy: (store, title) => `Je krijgt dit omdat dit adres is ingevuld op de pagina van ${title} bij ${store}.`,
  backSubject: (title) => `${title} is weer op voorraad`,
  backLead: (store, title, price) => `Je vroeg ${store} je te mailen wanneer ${title} weer op voorraad was. Het is er nu weer${price ? `, voor ${price}` : ""}:`,
  backAfter: "Dit is de enige e-mail die deze lijst verstuurt, en je adres wordt er daarna uit gewist.",
  backWhy: (title) => `Je krijgt dit omdat je vroeg om bericht wanneer ${title} weer op voorraad is en je adres bevestigde.`,
  doorLabel: "Mijn adres verwijderen",
  doorAfter: "van deze lijst.",
  doorLine: (link) => `Mijn adres verwijderen: ${link}`,
};

const pt: StockAlertWords = {
  label: "De volta ao stock",
  sentTitle: "Veja a sua caixa de entrada",
  sentBody: (title, store) =>
    `Enviámos-lhe um botão para confirmar. Depois de carregar nele, ${store} escreve-lhe uma única vez, quando ${it_(title, "o produto")} voltar ao stock. Se o e-mail não estiver lá, veja na pasta de spam.`,
  confirmTitle: "Confirme o seu endereço",
  confirmBody: (store, title) => `Carregue no botão e ${store} escreve-lhe uma única vez, quando ${it_(title, "o produto")} voltar ao stock.`,
  confirmButton: "Confirmar o meu endereço",
  confirmedTitle: (title) => `Vamos avisar quando ${it_(title, "o produto")} voltar`,
  confirmedBody: "Um único e-mail, quando voltar ao stock. Depois, o seu endereço é apagado desta lista.",
  removeTitle: "Remover o seu endereço?",
  removeBody: (title) => `Não será avisado quando ${it_(title, "o produto")} voltar ao stock.`,
  removeButton: "Remover o meu endereço",
  removedTitle: "O seu endereço foi removido",
  notOnListTitle: "O seu endereço não está nesta lista",
  notOnListBody: "Já foi removido, ou o produto voltou ao stock e a lista foi apagada.",
  notices: {
    email: { title: "Isto não parece um endereço de e-mail", body: "Verifique e tente novamente. A confirmação vai para o endereço escrito, por isso tem de ser um que consiga abrir." },
    limited: { title: "Demasiados pedidos por agora", body: "Para que este formulário não seja usado para encher a caixa de alguém, aceita um número limitado por hora. Tente novamente daqui a uma hora." },
    full: { title: "Esta lista está cheia", body: "Já tem todas as pessoas que cabem. Nada foi guardado." },
    closed: { title: "Isto não está esgotado", body: "Talvez já tenha voltado ao stock, ou esta loja não envia estes e-mails. Nada foi guardado." },
    unsent: {
      title: "Não foi possível enviar o e-mail de confirmação",
      body: "Talvez a loja tenha esgotado os seus e-mails por agora, ou o serviço de e-mail não respondeu. Nada lhe é enviado sem confirmação. Tente novamente mais tarde.",
    },
    error: { title: "Algo correu mal", body: "Nada foi enviado. Tente novamente daqui a pouco." },
    expired: { title: "Esta ligação expirou", body: "Uma ligação de confirmação é válida durante 7 dias. Peça novamente na página do produto; demora alguns segundos." },
  },
  askSubject: (title) => `Confirme: avisem-me quando ${title} voltar`,
  askLead: (store, title) => `Pediu a ${store} que o avisasse quando ${title} voltasse ao stock.`,
  askOpen: "Abra esta ligação e carregue no botão para confirmar que foi o próprio:",
  askWorks: "É válida durante 7 dias. Quando voltar, recebe um e-mail, o único que esta lista envia. Depois, o seu endereço é apagado.",
  askIgnore: "Se não pediu isto, ignore este e-mail. Nada é enviado se ninguém carregar no botão.",
  askWhy: (store, title) => `Recebe isto porque este endereço foi escrito na página de ${title} de ${store}.`,
  backSubject: (title) => `${title} voltou ao stock`,
  backLead: (store, title, price) => `Pediu a ${store} que o avisasse quando ${title} voltasse ao stock. Já voltou${price ? `, por ${price}` : ""}:`,
  backAfter: "Este é o único e-mail que esta lista envia, e o seu endereço é apagado dela depois deste envio.",
  backWhy: (title) => `Recebe isto porque pediu para ser avisado quando ${title} voltasse e confirmou o seu endereço.`,
  doorLabel: "Remover o meu endereço",
  doorAfter: "desta lista.",
  doorLine: (link) => `Remover o meu endereço: ${link}`,
};

export const STOCK_ALERT_WORDS: Record<LanguageCode, StockAlertWords> = { en, es, fr, de, it, nl, pt };

export function stockAlertWords(language: unknown): StockAlertWords {
  return STOCK_ALERT_WORDS[parseLanguage(language)];
}
