/**
 * The store's words in German (lib/buyer-words/en.ts says what each is for).
 * "Sie", as German-language shops address their buyers, and a non-breaking
 * space before "%".
 */
import type { BuyerWords } from "./index";

type Interval = "day" | "week" | "month" | "year";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const S = " ";

const every = (interval: Interval) => ({ day: "pro Tag", week: "pro Woche", month: "pro Monat", year: "pro Jahr" })[interval];
/** How long an introductory price lasts (lib/intro-price.ts). */
const introFirst = (count: number, interval: Interval) => (count > 1 ? `${every("month")} in den ersten ${count} Monaten` : ({ day: "am ersten Tag", week: "in der ersten Woche", month: "im ersten Monat", year: "im ersten Jahr" })[interval]);

export const de: BuyerWords = {
  free: "Kostenlos",
  fromPrice: (price) => `ab ${price}`,
  was: "Vorher ",
  now: "jetzt ",
  every,
  membershipPrice: (trialDays, payments, interval, price) => {
    const trial = trialDays > 0 ? `${trialDays} ${plural(trialDays, "Tag", "Tage")} kostenlos testen, danach ` : "";
    if (payments > 0) {
      const adjective = { day: "tägliche", week: "wöchentliche", month: "monatliche", year: "jährliche" }[interval];
      return payments === 1
        ? `${trial}1 Zahlung von ${price}`
        : `${trial}${payments} ${adjective} Zahlungen von je ${price}`;
    }
    return `${trial}${price} ${every(interval)}`;
  },
  introFirst,
  introThen: (intro, count, interval, then) => `${intro} ${introFirst(count, interval)}, danach ${then}`,
  planWords: (payments, interval, amount) =>
    `${payments} ${interval === "week" ? "wöchentliche" : "monatliche"} Raten von je ${amount}`,
  planCount: (payments, interval) => `${payments} ${interval === "week" ? "wöchentliche" : "monatliche"} Raten`,
  endsIn: (unit, n) =>
    unit === "day" ? `Endet in ${n} Tagen` : unit === "hour" ? `Endet in ${n} ${plural(n, "Stunde", "Stunden")}` : `Endet in ${n} ${plural(n, "Minute", "Minuten")}`,

  fairHead: (country, percent) => `Fairer Preis für Ihr Land (${country}): ${percent}${S}% Rabatt`,
  fairNote: (store, plan) =>
    `${store} senkt die Preise dort, wo Geld weniger wert ist. Dieser Preis wurde automatisch für Sie festgelegt, anhand des Landes Ihrer Internetverbindung. Der Rabatt wird auf der Zahlungsseite abgezogen, ohne Code${plan ? "; der reduzierte Preis gilt bei Zahlung des vollen Betrags" : ""}.`,
  saleHead: (name, percent, ends) => `${name ? `${name}: ` : ""}${percent}${S}% Rabatt · ${ends}`,
  saleNote: (until, plan) =>
    `Bis ${until}. Der Rabatt wird auf der Zahlungsseite abgezogen, ohne Code${plan ? "; der Aktionspreis gilt bei Zahlung des vollen Betrags" : ""}.`,
  saleBanner: (name, percent, ends) =>
    `${name ? `${name}: ` : ""}${percent}${S}% Rabatt auf die Produkte mit durchgestrichenem alten Preis · ${ends}`,
  saleBannerNote: "Die Preise unten sind bereits reduziert; kein Code nötig.",

  callLiveNone: "Live-Session, online, keine Termine geplant",
  callLive: (dates) => `Live-Session, online, ${dates} ${plural(dates, "Termin", "Termine")} geplant`,
  callGroup: (minutes, seats) => `Gruppengespräch, ${minutes} Minuten, bis zu ${seats} Personen, online`,
  callOne: (minutes) => `${minutes}-minütiges Gespräch, online`,
  callLengths: (list) => `Gespräch von ${list} Minuten, online`,
  inPersonLive: (dates) => `Live-Session, vor Ort, ${dates} ${plural(dates, "Termin", "Termine")} geplant`,
  inPersonGroup: (minutes, seats) => `${minutes} Minuten, bis zu ${seats} Personen, vor Ort`,
  inPersonOne: (minutes) => `${minutes} Minuten, vor Ort`,
  inPersonLengths: (list) => `${list} Minuten, vor Ort`,
  inPersonLiveNone: "Live-Session, vor Ort, keine Termine geplant",
  bundleOf: (count, worth) => `Paket mit ${count} Produkten${worth ? ` · ${worth}` : ""}`,
  worth: (worth, price) => `Produkte im Wert von ${worth} für ${price}`,
  podcast: (episodes) => `Privater Podcast, ${episodes} ${plural(episodes, "Folge", "Folgen")}, in Ihrer eigenen Podcast-App`,
  fromCapital: "Ab ",
  pwywFact: (least, suggested) => `Zahlen Sie, was Sie möchten, ab ${least}. Vorschlag: ${suggested}`,
  includes: (titles, more) => `Enthält ${titles}${more > 0 ? ` und ${more} weitere` : ""}`,
  course: (lessons) => `Kurs · ${lessons} ${plural(lessons, "Lektion", "Lektionen")}`,
  seeInside: "Inhalt ansehen",
  readMore: "Mehr lesen",
  soldOut: "Ausverkauft",
  left: (_count, written) => `Noch ${written} verfügbar`,
  bought: (count) => `${count}-mal gekauft`,
  orPlan: (plan) => `oder ${plan}`,

  buySessions: (sessions, price) => `${sessions} Termine kaufen — ${price}`,
  packageNote: (saving, sessions, limit) =>
    `${saving ? `${saving} weniger als ${sessions} einzeln gebuchte Termine. ` : ""}Einmal bezahlt, jeder Termin gebucht, wann Sie möchten. ${limit}.`,
  packageLimit: (days) => (days ? `Innerhalb von ${days} Tagen einzulösen` : "Ohne zeitliche Begrenzung einzulösen"),

  whichOne: "Welche Option",
  perPerson: " pro Person",
  giftSummary: "Als Geschenk kaufen",
  theirEmail: "E-Mail der beschenkten Person",
  yourNameShown: "Ihr Name, wie er angezeigt wird",
  messageOptional: "Eine Nachricht (optional)",
  buyAsGift: "Als Geschenk kaufen",
  buyAsGiftFor: (price) => `Als Geschenk kaufen — ${price}`,
  giftNote: (store) =>
    `Sie bezahlen auf der Seite von Stripe. Nach der Zahlung gehört das Geschenk zu ihrer Adresse. Falls die einzige E-Mail von ${store} sie erreicht, enthält sie Ihren Namen, Ihre Nachricht und einen Link zum Öffnen. Sie erhalten die Quittung, keine Kopie.`,
  giftProblems: {
    email: "Das sieht nicht nach einer E-Mail-Adresse aus. Prüfen Sie die Adresse der beschenkten Person und versuchen Sie es erneut.",
    option: "Wählen Sie, was Sie verschenken möchten, und versuchen Sie es erneut. Es wurde nichts berechnet.",
    product: "Dies kann nicht mehr als Geschenk gekauft werden.",
    unavailable: "Geschenke sind gerade nicht verfügbar. Es wurde nichts berechnet.",
  },
  teamSummary: "Für ein Team kaufen",
  howManyPeople: "Wie viele Personen",
  buyForTeam: "Für Ihr Team kaufen",
  buyForTeamEach: (each) => `Für Ihr Team kaufen — ${each} pro Person`,
  teamNote:
    "Sie bezahlen einmal auf der Seite von Stripe, wo die Gesamtsumme vor der Zahlung angezeigt wird. Direkt danach erhalten Sie einen Link zum Weitergeben: Jede Person öffnet ihn, gibt ihre eigene E-Mail-Adresse ein und hat den Zugang unter ihrer eigenen Adresse. Ihren eigenen Platz nehmen Sie auf dieselbe Weise.",
  teamProblems: (least, most) => ({
    people: `Geben Sie an, wie viele Personen, von ${least} bis ${most}. Es wurde nichts berechnet.`,
    option: "Wählen Sie, was Sie für alle kaufen möchten, und versuchen Sie es erneut. Es wurde nichts berechnet.",
    amount: "So viele Personen zu diesem Preis übersteigen, was eine einzelne Zahlung abdecken kann. Versuchen Sie es mit weniger Personen oder kaufen Sie zweimal. Es wurde nichts berechnet.",
    product: "Dies kann nicht mehr für mehrere Personen gekauft werden.",
    unavailable: "Der Kauf für mehrere Personen ist gerade nicht verfügbar. Es wurde nichts berechnet.",
  }),

  leaveEmpty: "Dieses Feld leer lassen",
  comingSoon: "Demnächst erhältlich",
  yourEmail: "Ihre E-Mail-Adresse",
  emailPlaceholder: "sie@beispiel.de",
  friendPlaceholder: "freund@beispiel.de",
  namePlaceholder: "Dana",
  alsoOtherEmails: (store) => `Senden Sie mir auch andere E-Mails von ${store}. Ich kann mich jederzeit abmelden.`,
  alsoEmails: (store) => `Senden Sie mir auch E-Mails von ${store}. Ich kann mich jederzeit abmelden.`,
  alsoClicks: (store) => `${store} sehen lassen, welche Links in den E-Mails ich nutze, damit ich bekomme, was zu mir passt. Ich kann das in jeder E-Mail beenden.`,
  tellMe: "Benachrichtigen, wenn es erscheint",
  waitlistNote: (store) =>
    `Sie bestätigen in Ihrem Posteingang und erhalten eine einzige E-Mail, wenn es in den Verkauf geht – sonst nichts. Ihre Adresse geht nur an ${store}, wenn Sie das Kästchen angekreuzt haben.`,
  emailItToMe: "Per E-Mail zusenden",
  freeNote: (store) =>
    `Sie erhalten einen Link per E-Mail. Sobald Sie ihn nutzen, erhält ${store} Ihre Adresse, zusammen mit der Angabe, ob Sie das Kästchen angekreuzt haben. Marktmorgen verwendet sie für nichts anderes.`,
  notAvailable: "Derzeit nicht verfügbar.",
  noDates: "Derzeit keine Termine im Verkauf.",
  notOnSale: "Noch nicht im Verkauf.",
  soldOutStop: "Ausverkauft.",
  cannotTakePayments: "Dieser Shop kann noch keine Zahlungen annehmen.",
  joinWaitlist: "Auf die Warteliste",
  getItFree: "Kostenlos erhalten",

  pickSession: "Session wählen",
  pickTime: "Termin wählen",
  priced: (label, price) => `${label} — ${price}`,
  /** The store's blog (lib/store-blog.ts; app/[handle]/blog). */
  blog: "Blog",
  blogOf: (store) => `Blog von ${store}`,
  blogPastEnd: "Keine Beiträge auf dieser Seite",
  blogPastEndBody: "Diese Seite liegt hinter dem letzten Beitrag.",
  blogMinutes: (n) => `${n} Min. Lesezeit`,
  blogNewer: "Neuere Beiträge",
  blogOlder: "Ältere Beiträge",
  blogAll: "Alle Beiträge",
  blogPublished: (date) => `Veröffentlicht am ${date}`,
  blogFrom: (store) => `Von ${store}`,
  blogFeed: "Per RSS folgen",
  /** What one unit costs within an option, when its name gives how many (lib/option-units.ts): "$7.80 per week". */
  perUnit: (price, unit) => `${price} pro ${unit}`,
  /** How much less each unit costs than in the option of one. */
  unitSaving: (percent) => `Sie sparen ${percent}\u00a0%`,
  chooseOptionFor: (title) => `Wählen Sie eine Option für ${title}`,
  chooseOne: "Bitte wählen",
  optionFromLink: (label) => `Sie sind wegen ${label} hier, deshalb ist diese Option unten gewählt. Sie können eine andere wählen.`,
  recommended: "Empfohlen",
  recommendedAfter: " (empfohlen)",
  howToPayFor: (title) => `Zahlungsweise für ${title}`,
  payInFull: "Vollständig bezahlen",
  today: (amount) => `${amount} heute`,
  addFor: (title, price) => `${title} für ${price} hinzufügen`,
  bundleBox: (count) => `Ein Paket mit ${count} Produkten, die Ihnen alle direkt nach der Zahlung zur Verfügung stehen.`,
  onItsOwn: (price) => `${price} einzeln`,
  chooseYourPrice: "Preis selbst wählen",
  startTrial: (days) => `${days} ${plural(days, "Tag", "Tage")} kostenlos testen`,
  subscribe: "Abonnieren",
  continueOption: "Mit dieser Option fortfahren",
  subscribeFor: (price, every) => `Abonnieren — ${price} ${every}`,
  buyFor: (price) => `Für ${price} kaufen`,
  startPlanToday: (amount) => `Ratenzahlung starten: ${amount} heute`,
  startPlanWith: (named, amount) => `Ratenzahlung mit ${named} starten: ${amount} heute`,
  nAdded: (count) => `${count} weiteren Produkten`,
  buyItWith: (named) => `Zusammen mit ${named} kaufen`,
  buyAllFor: (boxes, price) => `${["Für", "Beide für", "Alle drei für", "Alle vier für"][boxes]} ${price} kaufen`,
  pwywNote: (least, suggested) => `Sie geben den Betrag auf der Zahlungsseite ein: ${least} oder mehr, ${suggested} vorgeschlagen.`,
  trialNote: (days, after, untilCancel) =>
    `Sie geben Ihre Karte jetzt ein, und ${days} ${plural(days, "Tag", "Tage")} lang wird nichts berechnet. Danach ${after}${untilCancel ? ", bis Sie kündigen" : ""}. Kündigen Sie vor Ende des Testzeitraums, zahlen Sie nichts.`,
  switchPlansNote: "Sie können später zu einem anderen Tarif dieses Shops wechseln, höher oder niedriger, und sehen den genauen Betrag, bevor etwas berechnet wird.",
  payPal: (alone, price) => `${alone ? "Mit PayPal kaufen" : "Oder mit PayPal bezahlen"} — ${price}`,
  payPalNote: (store) => `Bezahlt an das eigene PayPal-Konto von ${store}. Ihr Kauf wird an die E-Mail-Adresse Ihres PayPal-Kontos gesendet.`,
  chooseAndBuy: "Auswählen und kaufen",
  memberManage: "Schon Mitglied? Verwalten oder kündigen",
  memberSwitch: "Schon Mitglied? Tarif wechseln, verwalten oder kündigen",

  takenBy: (stripe, paypal) => (stripe && paypal ? "Stripe oder PayPal" : paypal ? "PayPal" : "Stripe"),
  testModeTitle: "Diese Kasse läuft im Testmodus von Stripe.",
  testModeBody: "Es fließt kein echtes Geld und keine echte Karte wird belastet – geben Sie also keine eigene Karte ein.",
  testModeLater: (store) =>
    `Sobald sie live ist, wird die Zahlung von Stripe auf dem eigenen Konto von ${store} eingezogen: Marktmorgen hält das Geld nie und behält nichts davon.`,
  paidBy: (takers, store) =>
    `Die Zahlung wird von ${takers} auf dem eigenen Konto von ${store} eingezogen. Marktmorgen hält das Geld nie und behält nichts davon.`,
  whoAnswers: (store) =>
    `${store} ist der Verkäufer und verantwortlich für das, was Sie kaufen, für Erstattungen und für ein etwaiges Widerrufsrecht. Marktmorgen stellt die Seiten des Shops bereit und ist nicht Partei des Kaufvertrags.`,
  noPaymentsTitle: "Dieser Shop kann noch keine Zahlungen annehmen.",
  noPaymentsBody: (store) => `Die Preise oben sind echt, aber hier kann noch keine Karte belastet werden. Um zu kaufen, schreiben Sie direkt an ${store}.`,
  noPaymentsBodyOne: (store) => `Der Preis oben ist echt, aber hier kann noch keine Karte belastet werden. Um zu kaufen, schreiben Sie direkt an ${store}.`,

  notices: {
    soldout: { title: "Das ist gerade ausverkauft", body: "Das letzte Exemplar ging kurz vor Ihrem Klick auf Kaufen weg. Es wurde nichts berechnet." },
    busy: { title: "Jemand anderes kauft das gerade", body: "Es wurde nichts berechnet. Klicken Sie gleich noch einmal auf Kaufen." },
    slow: { title: "Viele Versuche in wenigen Minuten", body: "Es wurde nichts berechnet. Warten Sie ein paar Minuten und klicken Sie dann erneut auf Kaufen." },
    error: { title: "Die Zahlungsseite konnte nicht geöffnet werden", body: "Es wurde nichts berechnet. Versuchen Sie es gleich noch einmal." },
    nocharges: { title: "Dieser Shop kann gerade keine Kartenzahlungen annehmen", body: "Es wurde nichts berechnet. Ein neuer Versuch klappt erst, wenn der Shop das behoben hat." },
    paused: { title: "Dieser Shop nimmt gerade keine neuen Bestellungen an", body: "Es wurde nichts berechnet. Neue Bestellungen sind ab Anfang nächsten Monats wieder möglich, oder früher." },
    "paypal-declined": {
      title: "PayPal hat die Zahlung nicht angenommen",
      body: "Es wurde nichts berechnet. Versuchen Sie es mit einer anderen Karte oder einem anderen Konto in PayPal, oder zahlen Sie hier mit Karte.",
    },
    "paypal-error": {
      title: "Diese PayPal-Zahlung konnte diesem Shop nicht zugeordnet werden",
      body: "Dafür wurde nichts ausgeliefert. Falls PayPal eine Abbuchung zeigt, schreiben Sie dem Shop, indem Sie auf die Quittung von PayPal antworten.",
    },
  },
  storeDescription: (store) => `Der Shop von ${store} auf Marktmorgen.`,
  nothingYet: "Noch nichts hier",
  nothingYetBody: (store) => `Diese Seite ist geöffnet, aber noch leer. Sobald ${store} etwas hinzufügt, erscheint es hier.`,
  continued: " (Fortsetzung)",
  pagesOfProducts: "Seiten mit Produkten",
  previous: "Zurück",
  next: "Weiter",
  pageOf: (page, pages) => `Seite ${page} von ${pages}`,
  products: (count, written) => `${written} ${plural(count, "Produkt", "Produkte")}`,
  communityTitle: "Community für Mitglieder",
  communityBody: "Für alle, die eines der Produkte besitzen, die den Zugang öffnen. Melden Sie sich mit der E-Mail-Adresse an, mit der Sie es erhalten haben.",
  getAgain: "Hier etwas gekauft? Erneut abrufen",
  affiliateProgram: (store) => `Verdienen Sie durch Empfehlen von ${store}: das Partnerprogramm`,
  madeWith: "Erstellt mit Marktmorgen",

  productDescription: (title, store) => `${title}, aus dem Shop von ${store}.`,
  insideTitle: (count) => `Enthalten: ${count} Produkte`,
  insideCourse: (lessons) => `Kurs, ${lessons} ${plural(lessons, "Lektion", "Lektionen")} · `,
  insideNote: "Jedes gehört Ihnen direkt nach der Zahlung, als hätten Sie es einzeln gekauft.",
  payInFullOr: (plan) => `Vollständig bezahlen oder in ${plan}`,
  youChoose: (least) => `Sie wählen den Preis: ${least} oder mehr.`,
  readFirst: (pages) => `${pages === 1 ? "Die erste Seite" : `Die ersten ${pages} Seiten`} kostenlos lesen (PDF)`,
  everythingFrom: (store) => `Alles von ${store}`,
  getTitle: (title) => `${title} erhalten`,
  moreFrom: (store) => `Mehr von ${store}`,
  pairedWith: (title) => `Passt gut zu ${title}`,
  pickedBy: (store) => `Ausgewählt von ${store}`,
  collections: "Kollektionen",
  inCollections: "Gehört zu",
  productCount: (n) => `${n} ${n === 1 ? "Produkt" : "Produkte"}`,
  alsoBought: (title) => `Käufer von ${title} kauften auch`,
  boughtBoth: (n) => `${n} Käufer haben beides gekauft`,
  billMonthly: "Monatlich",
  billYearly: "Jährlich",
  yearSave: (amount) => `Sie sparen ${amount}`,
  yearlyFact: (price, save) => `Oder ${price} ${every("year")}, Sie sparen ${save}`,

  reviews: "Bewertungen",
  verifiedReviews: (count, written) => `${written} ${plural(count, "verifizierte Bewertung", "verifizierte Bewertungen")}`,
  ratedFrom: (average, reviews) => `Mit ${average} von 5 bewertet, aus ${reviews}`,
  ratedOutOf5: (average) => `Mit ${average} von 5 bewertet`,
  starsOutOf5: (stars) => `${stars} von 5 Sternen`,
  verifiedBuyer: "Verifizierter Käufer",
  verifiedPurchase: "Verifizierter Kauf",
  pickedByCreator: "Vom Ersteller ausgewählt",
  refundedNotCounted: "Erstattet, nicht gezählt",
  edited: (date) => ` · bearbeitet am ${date}`,
  replyFrom: (store) => `Antwort von ${store}`,
  starsSpread: "Verteilung der Sterne",
  starLabel: (stars) => `${stars} ${plural(stars, "Stern", "Sterne")}`,
  reviewCount: (count) => `${count} ${plural(count, "Bewertung", "Bewertungen")}`,
  reviewRules: (title, store) =>
    `Nur wer ${title} hier gekauft hat, kann es bewerten, und jede Bewertung wird mit ihrer Bestellung abgeglichen. ${store} kann antworten und eine Bewertung ausblenden, aber keine ändern; ausgeblendete Bewertungen zählen weiterhin zum Durchschnitt.`,
  hiddenByCreator: (count) => `${count} ${plural(count, "Bewertung", "Bewertungen")} vom Ersteller ausgeblendet`,
  refundedOrders: (count) => `${count} aus ${plural(count, "einer erstatteten Bestellung", "erstatteten Bestellungen")}, nicht gezählt`,
  noReviewsYet: "Bewertungen von Käufern erscheinen hier, sobald jemand, der bezahlt hat, eine schreibt.",
  seeAllReviews: (written) => `Alle ${written} Bewertungen ansehen`,

  askAria: "Eine Frage zu diesem Produkt stellen",
  askLabel: "Eine Frage vor dem Kauf?",
  askPlaceholder: "Ist es ein PDF? Wie lange habe ich Zugang?",
  askBusy: "Wird gelesen…",
  ask: "Fragen",
  askClosed: (store) => `Fragen sind gerade geschlossen. Fragen Sie ${store} vor dem Kauf direkt.`,
  askTypeFirst: "Geben Sie zuerst Ihre Frage ein.",
  askSlow: "Gerade zu viele Fragen. Versuchen Sie es in ein paar Minuten erneut.",
  askFailed: "Das konnte gerade nicht beantwortet werden. Versuchen Sie es gleich noch einmal.",
  askNote: (store) =>
    `Automatisch beantwortet, nur aus dem, was auf dieser Seite steht. Ihre Frage kann ${store} angezeigt werden, ohne Angaben dazu, wer Sie sind – lassen Sie persönliche Daten also weg.`,

  close: "Schließen",
  beforeYouGo: "Bevor Sie gehen — kostenlos",

  aboutStore: (store) => `Über ${store}`,
  guarantee: "Garantie",
  fullSize: (alt) => `${alt}, in voller Größe`,
  openFullSize: "Dieses Bild in voller Größe öffnen",
  countdownUnits: { days: "Tage", hours: "Std.", min: "Min.", sec: "Sek." },
  until: (when) => `Bis ${when}`,

  restingTitle: "Diese Seite pausiert vorübergehend",
  restingBody: (store) =>
    `Sie ist ab Anfang nächsten Monats wieder geöffnet, oder früher. Alles, was Sie bereits von ${store} haben, gehört weiterhin Ihnen und bleibt zugänglich.`,
  restingBuyerBody: (store) =>
    `Ihr Zugang bleibt bestehen: Nichts, was Sie von ${store} haben, geht verloren. Diese Seite ist ab Anfang nächsten Monats wieder geöffnet, oder früher.`,
  restingOwner: "Ist das Ihr Shop? Ihr Studio erklärt, warum, und wie Sie ihn wieder öffnen",

  reviewsOf: (title) => `Bewertungen zu ${title}`,
  backTo: (title) => `Zurück zu ${title}`,
  missingTitle: "Diese Seite gibt es hier nicht",
  missingBody: (store) => `Sie wurde vielleicht verschoben oder entfernt. Alles, was ${store} anbietet, finden Sie auf der Startseite des Shops.`,
  noReviewsToShow: "Es gibt keine Bewertungen zum Anzeigen.",
  pagesOfReviews: "Seiten mit Bewertungen",
  newer: "Neuere",
  older: "Ältere",
  askUnknown: (store) => `Das steht nicht auf dieser Seite. Fragen Sie ${store} vor dem Kauf.`,
  askTermsCut: () => "Die vollständigen Bedingungen liegen mir hier nicht vor. Fragen Sie vor dem Kauf beim Ersteller nach.",

  noLongerOnSale: "Dieses Produkt ist nicht mehr im Verkauf.",
  cardUnread: "Dieses Produkt konnte gerade nicht geladen werden. Versuchen Sie es gleich noch einmal.",
  cardBuyUnread: "Kaufen ist gerade nicht möglich. Versuchen Sie es gleich noch einmal.",
  seeStore: (store) => `${store} ansehen`,
  cardTestMode: "Testmodus: Es wird keine echte Karte belastet.",
  cardCheckout: "Sichere Zahlung über Stripe, in einem neuen Tab.",
  cardSoldBy: (store) => `${store} ist der Verkäufer und dafür verantwortlich.`,
  cardOpens: (store) => `Öffnet sich im Shop von ${store}, in einem neuen Tab.`,

  // ---- Email cards (lib/mail-product-price.ts)
  orMore: (price) => `${price} oder mehr`,
  plusTax: "plus anfallende Steuern",
  salePriceUntil: (price, when) => `Aktionspreis: ${price}, bis ${when}`,
};
