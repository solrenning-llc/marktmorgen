/**
 * The words of the two consent requests on a store's pages, in each language
 * a store can speak: remembering an affiliate's link in a cookie
 * (components/affiliate-click.tsx) and the creator's ad measurement
 * (components/store-pixels.tsx), with the Global Privacy Control note and
 * the link to change the choice later.
 *
 * Each language says exactly what the English says: what is kept or loaded,
 * what is told to whom, that the price and the page are the same either way,
 * and the two answers. Nothing is added and nothing is softened, so a yes in
 * any language is a yes to the same thing. German speaks to the buyer as
 * "Sie" and Portuguese in the third person ("a sua", "si"), as the store's
 * other words in those languages do; "Global Privacy Control" is the
 * signal's own name and is kept in every language.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

export type TrackingConsentWords = {
  /** The affiliate request's name for a screen reader. */
  affiliateLabel: string;
  affiliateTitle: (store: string) => string;
  /** What the cookie holds and for how long a purchase is credited. */
  affiliateBody: (days: number) => string;
  /** The ad request's name for a screen reader. */
  adsLabel: string;
  adsTitle: (store: string) => string;
  /** `names` is the pixels' names joined with `and` below ("Meta and Google"). */
  adsBody: (names: string, store: string) => string;
  /** Joins the last two pixel names (lib/pixels.ts, pixelNames). */
  and: string;
  more: string;
  allow: string;
  noThanks: string;
  /** Shown instead of the request when the browser sends Global Privacy Control. */
  gpc: string;
  /** The link at the foot of the page while ad measurement is on. */
  turnOff: string;
  /** The same link while it is off. */
  settings: string;
};

const en: TrackingConsentWords = {
  affiliateLabel: "Affiliate link",
  affiliateTitle: (store) => `An affiliate of ${store} sent you here`,
  affiliateBody: (days) =>
    `With your permission, this store keeps a cookie with that affiliate's code and the time you arrived, so they are credited if you buy within ${days} ${days === 1 ? "day" : "days"}. It holds nothing else about you, and the price is the same either way.`,
  adsLabel: "Ad measurement",
  adsTitle: (store) => `${store} measures its ads`,
  adsBody: (names, store) =>
    `With your permission, this page loads ad measurement from ${names}, which sets cookies, and ${store} tells them about your sign-ups and purchases, so it can tell which of its ads bring people here. If you say no, nothing loads, nothing is sent, and the page works just the same.`,
  and: "and",
  more: "More about this",
  allow: "Allow",
  noThanks: "No thanks",
  gpc: "Your browser’s Global Privacy Control keeps ad measurement off. Manage this signal in your browser settings.",
  turnOff: "Turn off ad measurement",
  settings: "Ad measurement settings",
};

const es: TrackingConsentWords = {
  affiliateLabel: "Enlace de afiliado",
  affiliateTitle: (store) => `Un afiliado de ${store} te ha enviado aquí`,
  affiliateBody: (days) =>
    `Con tu permiso, esta tienda guarda una cookie con el código de ese afiliado y la hora a la que llegaste, para que se le atribuya la venta si compras en un plazo de ${days} ${days === 1 ? "día" : "días"}. La cookie no contiene nada más sobre ti, y el precio es el mismo en cualquier caso.`,
  adsLabel: "Medición de anuncios",
  adsTitle: (store) => `${store} mide sus anuncios`,
  adsBody: (names, store) =>
    `Con tu permiso, esta página carga la medición de anuncios de ${names}, que instala cookies, y ${store} les informa de tus registros y tus compras, para saber cuáles de sus anuncios traen gente aquí. Si dices que no, no se carga nada, no se envía nada y la página funciona igual.`,
  and: "y",
  more: "Más información",
  allow: "Permitir",
  noThanks: "No, gracias",
  gpc: "El Global Privacy Control de tu navegador mantiene desactivada la medición de anuncios. Puedes gestionar esta señal en los ajustes de tu navegador.",
  turnOff: "Desactivar la medición de anuncios",
  settings: "Ajustes de la medición de anuncios",
};

const fr: TrackingConsentWords = {
  affiliateLabel: "Lien d'affilié",
  affiliateTitle: (store) => `Un affilié de ${store} vous a envoyé ici`,
  affiliateBody: (days) =>
    `Avec votre accord, cette boutique conserve un cookie contenant le code de cet affilié et l'heure de votre arrivée, afin que l'achat lui soit attribué si vous achetez dans un délai de ${days} ${days === 1 ? "jour" : "jours"}. Il ne contient rien d'autre sur vous, et le prix est le même dans tous les cas.`,
  adsLabel: "Mesure des publicités",
  adsTitle: (store) => `${store} mesure ses publicités`,
  adsBody: (names, store) =>
    `Avec votre accord, cette page charge la mesure des publicités de ${names}, qui dépose des cookies, et ${store} leur signale vos inscriptions et vos achats, afin de savoir lesquelles de ses publicités amènent des visiteurs ici. Si vous refusez, rien n'est chargé, rien n'est envoyé, et la page fonctionne tout aussi bien.`,
  and: "et",
  more: "En savoir plus",
  allow: "Autoriser",
  noThanks: "Non merci",
  gpc: "Le Global Privacy Control de votre navigateur maintient la mesure des publicités désactivée. Vous pouvez gérer ce signal dans les réglages de votre navigateur.",
  turnOff: "Désactiver la mesure des publicités",
  settings: "Réglages de la mesure des publicités",
};

const de: TrackingConsentWords = {
  affiliateLabel: "Affiliate-Link",
  affiliateTitle: (store) => `Ein Affiliate von ${store} hat Sie hierher geschickt`,
  affiliateBody: (days) =>
    `Mit Ihrer Erlaubnis speichert dieser Shop ein Cookie mit dem Code dieses Affiliates und dem Zeitpunkt Ihrer Ankunft, damit ihm ein Kauf innerhalb von ${days} ${days === 1 ? "Tag" : "Tagen"} gutgeschrieben wird. Es enthält sonst nichts über Sie, und der Preis ist in beiden Fällen derselbe.`,
  adsLabel: "Anzeigenmessung",
  adsTitle: (store) => `${store} misst den Erfolg der eigenen Anzeigen`,
  adsBody: (names, store) =>
    `Mit Ihrer Erlaubnis lädt diese Seite die Anzeigenmessung von ${names}, die Cookies setzt, und ${store} teilt ihnen Ihre Anmeldungen und Käufe mit, um zu erkennen, welche der eigenen Anzeigen Menschen hierher bringen. Wenn Sie ablehnen, wird nichts geladen und nichts gesendet, und die Seite funktioniert genauso.`,
  and: "und",
  more: "Mehr dazu",
  allow: "Erlauben",
  noThanks: "Nein danke",
  gpc: "Die Global Privacy Control Ihres Browsers hält die Anzeigenmessung ausgeschaltet. Dieses Signal verwalten Sie in den Einstellungen Ihres Browsers.",
  turnOff: "Anzeigenmessung ausschalten",
  settings: "Einstellungen zur Anzeigenmessung",
};

const it: TrackingConsentWords = {
  affiliateLabel: "Link di affiliazione",
  affiliateTitle: (store) => `Ti ha mandato qui un affiliato di ${store}`,
  affiliateBody: (days) =>
    `Con il tuo permesso, questo negozio conserva un cookie con il codice di quell'affiliato e l'ora del tuo arrivo, così l'acquisto gli viene attribuito se compri entro ${days} ${days === 1 ? "giorno" : "giorni"}. Il cookie non contiene nient'altro su di te, e il prezzo è lo stesso in ogni caso.`,
  adsLabel: "Misurazione degli annunci",
  adsTitle: (store) => `${store} misura i propri annunci`,
  adsBody: (names, store) =>
    `Con il tuo permesso, questa pagina carica la misurazione degli annunci di ${names}, che imposta dei cookie, e ${store} comunica loro le tue iscrizioni e i tuoi acquisti, per capire quali dei propri annunci portano qui le persone. Se dici di no, non viene caricato nulla, non viene inviato nulla, e la pagina funziona allo stesso modo.`,
  and: "e",
  more: "Maggiori informazioni",
  allow: "Consenti",
  noThanks: "No, grazie",
  gpc: "Il Global Privacy Control del tuo browser tiene disattivata la misurazione degli annunci. Puoi gestire questo segnale nelle impostazioni del browser.",
  turnOff: "Disattiva la misurazione degli annunci",
  settings: "Impostazioni della misurazione degli annunci",
};

const nl: TrackingConsentWords = {
  affiliateLabel: "Affiliatelink",
  affiliateTitle: (store) => `Een affiliate van ${store} heeft je hierheen gestuurd`,
  affiliateBody: (days) =>
    `Met je toestemming bewaart deze winkel een cookie met de code van die affiliate en het tijdstip waarop je aankwam, zodat de aankoop aan die affiliate wordt toegekend als je binnen ${days} ${days === 1 ? "dag" : "dagen"} koopt. De cookie bevat verder niets over jou, en de prijs is in beide gevallen hetzelfde.`,
  adsLabel: "Advertentiemeting",
  adsTitle: (store) => `${store} meet het effect van de eigen advertenties`,
  adsBody: (names, store) =>
    `Met je toestemming laadt deze pagina advertentiemeting van ${names}, die cookies plaatst, en geeft ${store} je aanmeldingen en aankopen aan hen door, om te zien welke van de eigen advertenties mensen hierheen brengen. Als je nee zegt, wordt er niets geladen en niets verstuurd, en werkt de pagina precies hetzelfde.`,
  and: "en",
  more: "Meer hierover",
  allow: "Toestaan",
  noThanks: "Nee, bedankt",
  gpc: "De Global Privacy Control van je browser houdt advertentiemeting uit. Je beheert dit signaal in de instellingen van je browser.",
  turnOff: "Advertentiemeting uitzetten",
  settings: "Instellingen voor advertentiemeting",
};

const pt: TrackingConsentWords = {
  affiliateLabel: "Ligação de afiliado",
  affiliateTitle: (store) => `Chegou aqui através de um afiliado de ${store}`,
  affiliateBody: (days) =>
    `Com a sua autorização, esta loja guarda um cookie com o código desse afiliado e a hora da sua chegada, para que a compra seja atribuída a esse afiliado se comprar no prazo de ${days} ${days === 1 ? "dia" : "dias"}. O cookie não contém mais nada sobre si, e o preço é o mesmo em qualquer caso.`,
  adsLabel: "Medição de anúncios",
  adsTitle: (store) => `${store} mede os resultados dos próprios anúncios`,
  adsBody: (names, store) =>
    `Com a sua autorização, esta página carrega a medição de anúncios de ${names}, que instala cookies, e ${store} informa-os dos seus registos e compras, para saber quais dos próprios anúncios trazem pessoas até aqui. Se recusar, nada é carregado, nada é enviado e a página funciona exatamente da mesma forma.`,
  and: "e",
  more: "Saber mais",
  allow: "Permitir",
  noThanks: "Não, obrigado",
  gpc: "O Global Privacy Control do seu navegador mantém a medição de anúncios desativada. Pode gerir este sinal nas definições do seu navegador.",
  turnOff: "Desativar a medição de anúncios",
  settings: "Definições da medição de anúncios",
};

export const TRACKING_CONSENT_WORDS: Record<LanguageCode, TrackingConsentWords> = { en, es, fr, de, it, nl, pt };

export function trackingConsentWords(language: unknown): TrackingConsentWords {
  return TRACKING_CONSENT_WORDS[parseLanguage(language)] ?? en;
}
