/**
 * The words of a welcome offer with a deadline of each person's own
 * (lib/welcome-offer.ts): the box on the page a free copy is picked up from,
 * and the one reminder email, in each language a store can speak.
 *
 * Dates and amounts arrive already written; a sentence here only places them.
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Notice = { title: string; body: string };

export type WelcomeWords = {
  label: string;
  offer: (percent: number, title: string) => string;
  until: (when: string) => string;
  left: string;
  /** The button that stops the countdown changing, and the one that starts it again (WCAG 2.2.2). */
  pause: string;
  resume: string;
  button: (percent: number) => string;
  note: string;
  ended: (when: string) => string;
  endedNote: string;
  see: string;
  notices: Record<"expired" | "unavailable" | "limited" | "refused", Notice>;
  remindSubject: (percent: number, title: string, hours: number) => string;
  remindIntro: (store: string, percent: number, title: string, when: string) => string;
  remindLink: string;
  remindAfter: string;
};

const en: WelcomeWords = {
  label: "A welcome offer, for you",
  offer: (percent, title) => `${percent}% off ${title}`,
  until: (when) => `Yours until ${when}.`,
  left: "Ends in",
  pause: "Pause countdown",
  resume: "Resume countdown",
  button: (percent) => `Get ${percent}% off`,
  note: "Stripe takes the discount off at checkout, for the address you used here, on the first payment. When the time is up, the offer ends and is not made again.",
  ended: (when) => `Your welcome offer ended on ${when}.`,
  endedNote: "The product is at its usual price now, as it is for everyone.",
  see: "See it",
  notices: {
    expired: { title: "This offer has ended", body: "Its time is up, so the discount can no longer be opened." },
    unavailable: { title: "This product is not on sale right now", body: "Nothing was charged. Try again later, or ask the creator." },
    limited: { title: "That was a lot of tries", body: "Wait a few minutes, then press the button again." },
    refused: { title: "The checkout could not be opened", body: "Nothing was charged. Try again in a moment." },
  },
  remindSubject: (percent, title, hours) => `${percent}% off ${title}: ${hours} ${hours === 1 ? "hour" : "hours"} left`,
  remindIntro: (store, percent, title, when) => `When you asked ${store} for a free copy, you were offered ${percent}% off ${title}, until ${when}.`,
  remindLink: "It is still yours. Open your page here and press the button:",
  remindAfter: "After that, the offer ends and it is not made again.",
};

const es: WelcomeWords = {
  label: "Una oferta de bienvenida, para ti",
  offer: (percent, title) => `${percent}\u00a0% de descuento en ${title}`,
  until: (when) => `Es tuya hasta el ${when}.`,
  left: "Termina en",
  pause: "Pausar la cuenta atrás",
  resume: "Reanudar la cuenta atrás",
  button: (percent) => `Obtener un ${percent}\u00a0% de descuento`,
  note: "Stripe aplica el descuento en el pago, para la dirección que usaste aquí, en el primer cobro. Cuando se acaba el tiempo, la oferta termina y no se vuelve a hacer.",
  ended: (when) => `Tu oferta de bienvenida terminó el ${when}.`,
  endedNote: "El producto tiene ahora su precio habitual, como para todos.",
  see: "Verlo",
  notices: {
    expired: { title: "Esta oferta ha terminado", body: "Se acabó su tiempo, así que el descuento ya no se puede abrir." },
    unavailable: { title: "Este producto no está a la venta ahora", body: "No se ha cobrado nada. Inténtalo más tarde o pregunta al creador." },
    limited: { title: "Demasiados intentos", body: "Espera unos minutos y vuelve a pulsar el botón." },
    refused: { title: "No se pudo abrir el pago", body: "No se ha cobrado nada. Inténtalo de nuevo en un momento." },
  },
  remindSubject: (percent, title, hours) => `${percent}\u00a0% de descuento en ${title}: quedan ${hours} ${hours === 1 ? "hora" : "horas"}`,
  remindIntro: (store, percent, title, when) => `Cuando pediste a ${store} una copia gratis, se te ofreció un ${percent}\u00a0% de descuento en ${title}, hasta el ${when}.`,
  remindLink: "Sigue siendo tuya. Abre tu página aquí y pulsa el botón:",
  remindAfter: "Después, la oferta termina y no se vuelve a hacer.",
};

const fr: WelcomeWords = {
  label: "Une offre de bienvenue, pour vous",
  offer: (percent, title) => `${percent}\u00a0% de réduction sur ${title}`,
  until: (when) => `À vous jusqu’au ${when}.`,
  left: "Se termine dans",
  pause: "Mettre le compte à rebours en pause",
  resume: "Reprendre le compte à rebours",
  button: (percent) => `Profiter de ${percent}\u00a0% de réduction`,
  note: "Stripe déduit la réduction au paiement, pour l’adresse utilisée ici, sur le premier paiement. Une fois le temps écoulé, l’offre prend fin et n’est pas refaite.",
  ended: (when) => `Votre offre de bienvenue a pris fin le ${when}.`,
  endedNote: "Le produit est maintenant à son prix habituel, comme pour tout le monde.",
  see: "Le voir",
  notices: {
    expired: { title: "Cette offre a pris fin", body: "Son temps est écoulé, la réduction ne peut donc plus être ouverte." },
    unavailable: { title: "Ce produit n’est pas en vente pour le moment", body: "Rien n’a été prélevé. Réessayez plus tard, ou demandez au créateur." },
    limited: { title: "Beaucoup d’essais", body: "Attendez quelques minutes, puis appuyez de nouveau sur le bouton." },
    refused: { title: "Le paiement n’a pas pu s’ouvrir", body: "Rien n’a été prélevé. Réessayez dans un instant." },
  },
  remindSubject: (percent, title, hours) => `${percent}\u00a0% de réduction sur ${title} : encore ${hours} ${hours < 2 ? "heure" : "heures"}`,
  remindIntro: (store, percent, title, when) => `Quand vous avez demandé un exemplaire gratuit à ${store}, on vous a offert ${percent}\u00a0% de réduction sur ${title}, jusqu’au ${when}.`,
  remindLink: "Elle est toujours à vous. Ouvrez votre page ici et appuyez sur le bouton :",
  remindAfter: "Ensuite, l’offre prend fin et n’est pas refaite.",
};

const de: WelcomeWords = {
  label: "Ein Willkommensangebot für Sie",
  offer: (percent, title) => `${percent}\u00a0% Rabatt auf ${title}`,
  until: (when) => `Für Sie bis ${when}.`,
  left: "Endet in",
  pause: "Countdown anhalten",
  resume: "Countdown fortsetzen",
  button: (percent) => `${percent}\u00a0% Rabatt sichern`,
  note: "Stripe zieht den Rabatt an der Kasse ab, für die hier verwendete Adresse, bei der ersten Zahlung. Wenn die Zeit um ist, endet das Angebot und wird nicht erneut gemacht.",
  ended: (when) => `Ihr Willkommensangebot endete am ${when}.`,
  endedNote: "Das Produkt hat jetzt wieder seinen üblichen Preis, wie für alle.",
  see: "Ansehen",
  notices: {
    expired: { title: "Dieses Angebot ist beendet", body: "Die Zeit ist abgelaufen, der Rabatt lässt sich nicht mehr öffnen." },
    unavailable: { title: "Dieses Produkt ist gerade nicht erhältlich", body: "Es wurde nichts berechnet. Versuchen Sie es später oder fragen Sie den Anbieter." },
    limited: { title: "Viele Versuche", body: "Warten Sie ein paar Minuten und drücken Sie dann erneut auf den Knopf." },
    refused: { title: "Die Kasse ließ sich nicht öffnen", body: "Es wurde nichts berechnet. Versuchen Sie es gleich noch einmal." },
  },
  remindSubject: (percent, title, hours) => `${percent}\u00a0% Rabatt auf ${title}: noch ${hours} ${hours === 1 ? "Stunde" : "Stunden"}`,
  remindIntro: (store, percent, title, when) => `Als Sie ${store} um ein kostenloses Exemplar gebeten haben, wurden Ihnen ${percent}\u00a0% Rabatt auf ${title} angeboten, bis ${when}.`,
  remindLink: "Es gilt noch für Sie. Öffnen Sie hier Ihre Seite und drücken Sie auf den Knopf:",
  remindAfter: "Danach endet das Angebot und wird nicht erneut gemacht.",
};

const it: WelcomeWords = {
  label: "Un’offerta di benvenuto, per te",
  offer: (percent, title) => `${percent}% di sconto su ${title}`,
  until: (when) => `È tua fino al ${when}.`,
  left: "Termina tra",
  pause: "Metti in pausa il conto alla rovescia",
  resume: "Riprendi il conto alla rovescia",
  button: (percent) => `Ottieni il ${percent}% di sconto`,
  note: "Stripe applica lo sconto al pagamento, per l’indirizzo usato qui, sul primo pagamento. Quando il tempo finisce, l’offerta termina e non viene ripetuta.",
  ended: (when) => `La tua offerta di benvenuto è terminata il ${when}.`,
  endedNote: "Il prodotto ora ha il suo prezzo abituale, come per tutti.",
  see: "Vedilo",
  notices: {
    expired: { title: "Questa offerta è terminata", body: "Il suo tempo è finito, quindi lo sconto non si può più aprire." },
    unavailable: { title: "Questo prodotto non è in vendita ora", body: "Non è stato addebitato nulla. Riprova più tardi o chiedi al creatore." },
    limited: { title: "Troppi tentativi", body: "Aspetta qualche minuto, poi premi di nuovo il pulsante." },
    refused: { title: "Non è stato possibile aprire il pagamento", body: "Non è stato addebitato nulla. Riprova tra un momento." },
  },
  remindSubject: (percent, title, hours) => `${percent}% di sconto su ${title}: ${hours === 1 ? "manca 1 ora" : `mancano ${hours} ore`}`,
  remindIntro: (store, percent, title, when) => `Quando hai chiesto a ${store} una copia gratuita, ti è stato offerto il ${percent}% di sconto su ${title}, fino al ${when}.`,
  remindLink: "È ancora tua. Apri la tua pagina qui e premi il pulsante:",
  remindAfter: "Dopo, l’offerta termina e non viene ripetuta.",
};

const nl: WelcomeWords = {
  label: "Een welkomstaanbod, voor jou",
  offer: (percent, title) => `${percent}% korting op ${title}`,
  until: (when) => `Voor jou tot ${when}.`,
  left: "Eindigt over",
  pause: "Aftellen pauzeren",
  resume: "Aftellen hervatten",
  button: (percent) => `Neem ${percent}% korting`,
  note: "Stripe trekt de korting af bij het afrekenen, voor het adres dat je hier gebruikte, op de eerste betaling. Als de tijd om is, eindigt het aanbod en komt het niet terug.",
  ended: (when) => `Je welkomstaanbod eindigde op ${when}.`,
  endedNote: "Het product heeft nu weer zijn gewone prijs, zoals voor iedereen.",
  see: "Bekijken",
  notices: {
    expired: { title: "Dit aanbod is afgelopen", body: "De tijd is om, dus de korting kan niet meer worden geopend." },
    unavailable: { title: "Dit product is nu niet te koop", body: "Er is niets afgeschreven. Probeer het later, of vraag het de maker." },
    limited: { title: "Veel pogingen", body: "Wacht een paar minuten en druk dan opnieuw op de knop." },
    refused: { title: "Het afrekenen kon niet worden geopend", body: "Er is niets afgeschreven. Probeer het zo meteen opnieuw." },
  },
  remindSubject: (percent, title, hours) => `${percent}% korting op ${title}: nog ${hours} ${hours === 1 ? "uur" : "uur"}`,
  remindIntro: (store, percent, title, when) => `Toen je ${store} om een gratis exemplaar vroeg, kreeg je ${percent}% korting op ${title} aangeboden, tot ${when}.`,
  remindLink: "Het is nog steeds van jou. Open hier je pagina en druk op de knop:",
  remindAfter: "Daarna eindigt het aanbod en komt het niet terug.",
};

const pt: WelcomeWords = {
  label: "Uma oferta de boas-vindas, para si",
  offer: (percent, title) => `${percent}% de desconto em ${title}`,
  until: (when) => `É sua até ${when}.`,
  left: "Termina em",
  pause: "Pausar a contagem decrescente",
  resume: "Retomar a contagem decrescente",
  button: (percent) => `Obter ${percent}% de desconto`,
  note: "A Stripe aplica o desconto no pagamento, para o endereço que usou aqui, no primeiro pagamento. Quando o tempo acaba, a oferta termina e não volta a ser feita.",
  ended: (when) => `A sua oferta de boas-vindas terminou a ${when}.`,
  endedNote: "O produto tem agora o seu preço habitual, como para todos.",
  see: "Ver",
  notices: {
    expired: { title: "Esta oferta terminou", body: "O tempo acabou, por isso o desconto já não pode ser aberto." },
    unavailable: { title: "Este produto não está à venda agora", body: "Nada foi cobrado. Tente mais tarde ou pergunte ao criador." },
    limited: { title: "Muitas tentativas", body: "Espere alguns minutos e carregue de novo no botão." },
    refused: { title: "Não foi possível abrir o pagamento", body: "Nada foi cobrado. Tente de novo dentro de momentos." },
  },
  remindSubject: (percent, title, hours) => `${percent}% de desconto em ${title}: ${hours === 1 ? "falta 1 hora" : `faltam ${hours} horas`}`,
  remindIntro: (store, percent, title, when) => `Quando pediu a ${store} uma cópia gratuita, foi-lhe oferecido ${percent}% de desconto em ${title}, até ${when}.`,
  remindLink: "Continua a ser sua. Abra a sua página aqui e carregue no botão:",
  remindAfter: "Depois disso, a oferta termina e não volta a ser feita.",
};

export const WELCOME_WORDS: Record<LanguageCode, WelcomeWords> = { en, es, fr, de, it, nl, pt };

export function welcomeWords(language: unknown): WelcomeWords {
  return WELCOME_WORDS[parseLanguage(language)];
}
