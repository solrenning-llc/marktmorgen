/**
 * The store's words in Dutch (lib/buyer-words/en.ts says what each is for).
 * "Je", as Dutch-language shops address their buyers.
 */
import type { BuyerWords } from "./index";

type Interval = "day" | "week" | "month" | "year";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const S = " ";

const every = (interval: Interval) => ({ day: "per dag", week: "per week", month: "per maand", year: "per jaar" })[interval];
/** How long an introductory price lasts (lib/intro-price.ts). */
const introFirst = (count: number, interval: Interval) => (count > 1 ? `${every("month")} de eerste ${count} maanden` : ({ day: "de eerste dag", week: "de eerste week", month: "de eerste maand", year: "het eerste jaar" })[interval]);

export const nl: BuyerWords = {
  free: "Gratis",
  fromPrice: (price) => `vanaf ${price}`,
  was: "Eerst ",
  now: "nu ",
  every,
  membershipPrice: (trialDays, payments, interval, price) => {
    const trial = trialDays > 0 ? `${trialDays} ${plural(trialDays, "dag", "dagen")} gratis proberen, daarna ` : "";
    if (payments > 0) {
      const adjective = { day: "dagelijkse", week: "wekelijkse", month: "maandelijkse", year: "jaarlijkse" }[interval];
      return payments === 1 ? `${trial}1 betaling van ${price}` : `${trial}${payments} ${adjective} betalingen van ${price}`;
    }
    return `${trial}${price} ${every(interval)}`;
  },
  introFirst,
  introThen: (intro, count, interval, then) => `${intro} ${introFirst(count, interval)}, daarna ${then}`,
  planWords: (payments, interval, amount) =>
    `${payments} ${interval === "week" ? "wekelijkse" : "maandelijkse"} termijnen van ${amount}`,
  planCount: (payments, interval) => `${payments} ${interval === "week" ? "wekelijkse" : "maandelijkse"} termijnen`,
  endsIn: (unit, n) =>
    unit === "day" ? `Eindigt over ${n} dagen` : unit === "hour" ? `Eindigt over ${n} uur` : `Eindigt over ${n} ${plural(n, "minuut", "minuten")}`,

  fairHead: (country, percent) => `Eerlijke prijs voor jouw land (${country}): ${percent}${S}% korting`,
  fairNote: (store, plan) =>
    `${store} verlaagt de prijzen waar geld minder waard is. De korting gaat eraf op de betaalpagina, zonder code${plan ? "; de lagere prijs geldt bij betaling in één keer" : ""}.`,
  saleHead: (name, percent, ends) => `${name ? `${name}: ` : ""}${percent}${S}% korting · ${ends}`,
  saleNote: (until, plan) =>
    `Tot ${until}. De korting gaat eraf op de betaalpagina, zonder code${plan ? "; de actieprijs geldt bij betaling in één keer" : ""}.`,
  saleBanner: (name, percent, ends) =>
    `${name ? `${name}: ` : ""}${percent}${S}% korting op de producten met de oude prijs doorgestreept · ${ends}`,
  saleBannerNote: "De prijzen hieronder zijn al verlaagd; je hebt geen code nodig.",

  callLiveNone: "Livesessie, online, geen data gepland",
  callLive: (dates) => `Livesessie, online, ${dates} ${plural(dates, "datum", "data")} gepland`,
  callGroup: (minutes, seats) => `Groepsgesprek, ${minutes} minuten, tot ${seats} personen, online`,
  callOne: (minutes) => `Gesprek van ${minutes} minuten, online`,
  inPersonLive: (dates) => `Livesessie, ter plaatse, ${dates} ${plural(dates, "datum", "data")} gepland`,
  inPersonGroup: (minutes, seats) => `${minutes} minuten, tot ${seats} personen, ter plaatse`,
  inPersonOne: (minutes) => `${minutes} minuten, ter plaatse`,
  inPersonLiveNone: "Livesessie, ter plaatse, geen data gepland",
  bundleOf: (count, worth) => `Bundel van ${count} producten${worth ? ` · ${worth}` : ""}`,
  worth: (worth, price) => `${worth} aan producten voor ${price}`,
  podcast: (episodes) => `Privépodcast, ${episodes} ${plural(episodes, "aflevering", "afleveringen")}, in je eigen podcastapp`,
  fromCapital: "Vanaf ",
  pwywFact: (least, suggested) => `Betaal wat je wilt, vanaf ${least}. Voorgesteld: ${suggested}`,
  includes: (titles, more) => `Bevat ${titles}${more > 0 ? ` en nog ${more}` : ""}`,
  course: (lessons) => `Cursus · ${lessons} ${plural(lessons, "les", "lessen")}`,
  seeInside: "Bekijk wat erin zit",
  readMore: "Lees meer",
  soldOut: "Uitverkocht",
  left: (_count, written) => `Nog ${written} beschikbaar`,
  bought: (count) => `${count} keer gekocht`,
  orPlan: (plan) => `of ${plan}`,

  buySessions: (sessions, price) => `Koop ${sessions} sessies — ${price}`,
  packageNote: (saving, sessions, limit) =>
    `${saving ? `${saving} minder dan ${sessions} los geboekte sessies. ` : ""}Eén keer betaald, elke sessie geboekt wanneer je wilt. ${limit}.`,
  packageLimit: (days) => (days ? `Te gebruiken binnen ${days} dagen` : "Geen tijdslimiet om ze te gebruiken"),

  whichOne: "Welke",
  perPerson: " per persoon",
  giftSummary: "Koop het als cadeau",
  theirEmail: "Diens e-mailadres",
  yourNameShown: "Je naam, zoals de ontvanger die ziet",
  messageOptional: "Een bericht (optioneel)",
  buyAsGift: "Koop als cadeau",
  buyAsGiftFor: (price) => `Koop als cadeau — ${price}`,
  giftNote: (store) =>
    `Je betaalt op de pagina van Stripe. Direct daarna krijgt de ontvanger één e-mail van ${store} met je naam, je bericht en een link om het op het eigen adres te openen. Jij krijgt de bon, geen kopie.`,
  giftProblems: {
    email: "Dat lijkt geen e-mailadres. Controleer het adres van de ontvanger en probeer het opnieuw.",
    option: "Kies wat je wilt geven en probeer het opnieuw. Er is niets afgeschreven.",
    product: "Dit kan niet meer als cadeau worden gekocht.",
    unavailable: "Cadeaus zijn nu niet beschikbaar. Er is niets afgeschreven.",
  },
  teamSummary: "Koop het voor een team",
  howManyPeople: "Hoeveel personen",
  buyForTeam: "Koop voor je team",
  buyForTeamEach: (each) => `Koop voor je team — ${each} per persoon`,
  teamNote:
    "Je betaalt één keer op de pagina van Stripe, waar je het totaal ziet voordat je betaalt. Direct daarna krijg je één link om door te sturen: iedereen opent hem, vult het eigen e-mailadres in en heeft het op het eigen adres. Jij neemt je plek op dezelfde manier.",
  teamProblems: (least, most) => ({
    people: `Vul in hoeveel personen, van ${least} tot ${most}. Er is niets afgeschreven.`,
    option: "Kies wat je voor iedereen wilt kopen en probeer het opnieuw. Er is niets afgeschreven.",
    amount: "Zoveel personen tegen deze prijs is meer dan één betaling aankan. Probeer het met minder personen, of koop in twee keer. Er is niets afgeschreven.",
    product: "Dit kan niet meer voor meerdere personen worden gekocht.",
    unavailable: "Kopen voor meerdere personen is nu niet beschikbaar. Er is niets afgeschreven.",
  }),

  leaveEmpty: "Laat dit leeg",
  comingSoon: "Binnenkort beschikbaar",
  yourEmail: "Je e-mailadres",
  emailPlaceholder: "jij@voorbeeld.nl",
  friendPlaceholder: "vriend@voorbeeld.nl",
  namePlaceholder: "Dana",
  alsoOtherEmails: (store) => `Stuur me ook andere e-mails van ${store}. Ik kan me altijd afmelden.`,
  alsoEmails: (store) => `Stuur me ook e-mails van ${store}. Ik kan me altijd afmelden.`,
  alsoClicks: (store) => `Laat ${store} zien welke links in de e-mails ik gebruik, zodat ik krijg wat bij me past. Ik kan dit in elke e-mail stoppen.`,
  tellMe: "Laat het me weten als het uit is",
  waitlistNote: (store) =>
    `Je bevestigt vanuit je inbox en krijgt één e-mail zodra het te koop is, verder niets. Je adres gaat alleen naar ${store} als je het vakje hebt aangevinkt.`,
  emailItToMe: "Mail het naar mij",
  freeNote: (store) =>
    `Je krijgt een link per e-mail. Zodra je die gebruikt, krijgt ${store} je adres, met de vermelding of je het vakje hebt aangevinkt. Marktmorgen gebruikt het nergens anders voor.`,
  notAvailable: "Nu niet beschikbaar.",
  noDates: "Er zijn nu geen data te koop.",
  notOnSale: "Nog niet te koop.",
  soldOutStop: "Uitverkocht.",
  cannotTakePayments: "Deze winkel kan nog geen betalingen ontvangen.",
  joinWaitlist: "Op de wachtlijst",
  getItFree: "Gratis ontvangen",

  pickSession: "Kies een sessie",
  pickTime: "Kies een tijd",
  priced: (label, price) => `${label} — ${price}`,
  /** The store's blog (lib/store-blog.ts; app/[handle]/blog). */
  blog: "Blog",
  blogOf: (store) => `Blog van ${store}`,
  blogEmpty: "Hier staat nog niets.",
  blogMinutes: (n) => `${n} min lezen`,
  blogNewer: "Nieuwere berichten",
  blogOlder: "Oudere berichten",
  blogAll: "Alle berichten",
  blogPublished: (date) => `Gepubliceerd op ${date}`,
  blogFrom: (store) => `Van ${store}`,
  blogFeed: "Volgen via RSS",
  /** What one unit costs within an option, when its name gives how many (lib/option-units.ts): "$7.80 per week". */
  perUnit: (price, unit) => `${price} voor één ${unit}`,
  /** How much less each unit costs than in the option of one. */
  unitSaving: (percent) => `je bespaart ${percent}%`,
  chooseOptionFor: (title) => `Kies een optie voor ${title}`,
  recommended: "Aanbevolen",
  recommendedAfter: " (aanbevolen)",
  howToPayFor: (title) => `Hoe je ${title} betaalt`,
  payInFull: "In één keer betalen",
  today: (amount) => `${amount} vandaag`,
  addFor: (title, price) => `Voeg ${title} toe voor ${price}`,
  bundleBox: (count) => `Een bundel van ${count} producten, die je allemaal direct na betaling kunt openen.`,
  onItsOwn: (price) => `${price} los`,
  chooseYourPrice: "Kies je prijs",
  startTrial: (days) => `Start de gratis proefperiode van ${days} ${plural(days, "dag", "dagen")}`,
  subscribe: "Abonneren",
  continueOption: "Doorgaan met deze optie",
  subscribeFor: (price, every) => `Abonneren — ${price} ${every}`,
  buyFor: (price) => `Koop voor ${price}`,
  startPlanToday: (amount) => `Start de betaling in termijnen: ${amount} vandaag`,
  startPlanWith: (named, amount) => `Start de betaling in termijnen met ${named}: ${amount} vandaag`,
  nAdded: (count) => `${count} extra producten`,
  buyItWith: (named) => `Koop samen met ${named}`,
  buyAllFor: (boxes, price) => `${["Koop", "Koop beide", "Koop alle drie", "Koop alle vier"][boxes]} voor ${price}`,
  pwywNote: (least, suggested) => `Je vult het bedrag in op de betaalpagina: ${least} of meer, ${suggested} voorgesteld.`,
  trialNote: (days, after, untilCancel) =>
    `Je voert nu je kaart in, en ${days} ${plural(days, "dag", "dagen")} lang wordt er niets afgeschreven. Daarna ${after}${untilCancel ? " tot je opzegt" : ""}. Zeg je op voordat de proefperiode eindigt, dan betaal je niets.`,
  switchPlansNote: "Je kunt later overstappen naar een ander abonnement van deze winkel, hoger of lager, en ziet het precieze bedrag voordat er iets wordt afgeschreven.",
  payPal: (alone, price) => `${alone ? "Koop" : "Of betaal"} met PayPal — ${price}`,
  payPalNote: (store) => `Betaald aan de eigen PayPal-rekening van ${store}. Wat je koopt, wordt naar het e-mailadres van je PayPal-rekening gestuurd.`,
  chooseAndBuy: "Kies en koop",
  memberManage: "Al lid? Beheren of opzeggen",
  memberSwitch: "Al lid? Abonnement wijzigen, beheren of opzeggen",

  takenBy: (stripe, paypal) => (stripe && paypal ? "Stripe of PayPal" : paypal ? "PayPal" : "Stripe"),
  testModeTitle: "Deze kassa draait in de testmodus van Stripe.",
  testModeBody: "Er gaat geen echt geld doorheen en er wordt geen echte kaart belast, dus vul geen eigen kaart in.",
  testModeLater: (store) =>
    `Zodra hij live is, wordt de betaling door Stripe geïnd op de eigen rekening van ${store}: Marktmorgen houdt het geld nooit vast en neemt er niets van.`,
  paidBy: (takers, store) =>
    `De betaling wordt door ${takers} geïnd op de eigen rekening van ${store}. Marktmorgen houdt het geld nooit vast en neemt er niets van.`,
  noPaymentsTitle: "Deze winkel kan nog geen betalingen ontvangen.",
  noPaymentsBody: (store) => `De prijzen hierboven zijn echt, maar hier kan nog geen kaart worden belast. Wil je kopen, schrijf dan rechtstreeks naar ${store}.`,
  noPaymentsBodyOne: (store) => `De prijs hierboven is echt, maar hier kan nog geen kaart worden belast. Wil je kopen, schrijf dan rechtstreeks naar ${store}.`,

  notices: {
    soldout: { title: "Die is net uitverkocht", body: "De laatste ging vlak voordat je op kopen drukte. Er is niets afgeschreven." },
    busy: { title: "Iemand anders koopt dit op dit moment", body: "Er is niets afgeschreven. Druk zo meteen opnieuw op kopen." },
    slow: { title: "Veel pogingen in een paar minuten", body: "Er is niets afgeschreven. Wacht een paar minuten en druk dan opnieuw op kopen." },
    error: { title: "De betaalpagina kon niet worden geopend", body: "Er is niets afgeschreven. Probeer het zo meteen opnieuw." },
    paused: { title: "Deze winkel neemt nu geen nieuwe bestellingen aan", body: "Er is niets afgeschreven. Nieuwe bestellingen kunnen weer begin volgende maand, of eerder." },
    "paypal-declined": {
      title: "PayPal heeft de betaling niet aangenomen",
      body: "Er is niets afgeschreven. Probeer het opnieuw met een andere kaart of rekening in PayPal, of betaal hier met een kaart.",
    },
    "paypal-error": {
      title: "Die PayPal-betaling kon niet aan deze winkel worden gekoppeld",
      body: "Er is daarvoor niets geleverd. Laat PayPal een afschrijving zien, schrijf de winkel dan door op de bon van PayPal te antwoorden.",
    },
  },
  storeDescription: (store) => `De winkel van ${store} op Marktmorgen.`,
  nothingYet: "Nog niets te zien",
  nothingYetBody: (store) => `Deze pagina is open maar nog leeg. Zodra ${store} iets toevoegt, verschijnt het hier.`,
  continued: " (vervolg)",
  pagesOfProducts: "Pagina's met producten",
  previous: "Vorige",
  next: "Volgende",
  pageOf: (page, pages) => `Pagina ${page} van ${pages}`,
  products: (count, written) => `${written} ${plural(count, "product", "producten")}`,
  communityTitle: "Community voor leden",
  communityBody: "Voor wie een van de producten heeft die toegang geven. Kom binnen met het e-mailadres waarmee je het kreeg.",
  getAgain: "Hier iets gekocht? Haal het opnieuw op",
  affiliateProgram: (store) => `Verdien door ${store} te delen: het partnerprogramma`,
  madeWith: "Gemaakt met Marktmorgen",

  productDescription: (title, store) => `${title}, uit de winkel van ${store}.`,
  insideTitle: (count) => `Wat erin zit: ${count} producten`,
  insideCourse: (lessons) => `Cursus, ${lessons} ${plural(lessons, "les", "lessen")} · `,
  insideNote: "Elk product is direct na betaling van jou, alsof je het los had gekocht.",
  payInFullOr: (plan) => `Betaal in één keer of in ${plan}`,
  youChoose: (least) => `Jij kiest de prijs: ${least} of meer.`,
  readFirst: (pages) => `Lees ${pages === 1 ? "de eerste pagina" : `de eerste ${pages} pagina's`} gratis (pdf)`,
  everythingFrom: (store) => `Alles van ${store}`,
  getTitle: (title) => `Ontvang ${title}`,
  moreFrom: (store) => `Meer van ${store}`,
  pairedWith: (title) => `Past goed bij ${title}`,
  pickedBy: (store) => `Gekozen door ${store}`,
  collections: "Collecties",
  inCollections: "Hoort bij",
  productCount: (n) => `${n} ${n === 1 ? "product" : "producten"}`,
  alsoBought: (title) => `Kopers van ${title} kochten ook`,
  boughtBoth: (n) => `${n} kopers kochten allebei`,
  billMonthly: "Maandelijks",
  billYearly: "Jaarlijks",
  yearSave: (amount) => `Je bespaart ${amount}`,
  yearlyFact: (price, save) => `Of ${price} ${every("year")}, je bespaart ${save}`,

  reviews: "Beoordelingen",
  verifiedReviews: (count, written) => `${written} ${plural(count, "geverifieerde beoordeling", "geverifieerde beoordelingen")}`,
  ratedFrom: (average, reviews) => `Beoordeeld met ${average} van 5 op basis van ${reviews}`,
  ratedOutOf5: (average) => `Beoordeeld met ${average} van 5`,
  starsOutOf5: (stars) => `${stars} van 5 sterren`,
  verifiedBuyer: "Geverifieerde koper",
  verifiedPurchase: "Geverifieerde aankoop",
  pickedByCreator: "Gekozen door de maker",
  refundedNotCounted: "Terugbetaald, telt niet mee",
  edited: (date) => ` · bewerkt op ${date}`,
  replyFrom: (store) => `Reactie van ${store}`,
  starsSpread: "Hoe de sterren verdeeld zijn",
  starLabel: (stars) => `${stars} ${plural(stars, "ster", "sterren")}`,
  reviewCount: (count) => `${count} ${plural(count, "beoordeling", "beoordelingen")}`,
  reviewRules: (title, store) =>
    `Alleen wie ${title} hier heeft gekocht, kan het beoordelen, en elke beoordeling wordt gecontroleerd aan de hand van de bestelling. ${store} kan reageren en een beoordeling verbergen, maar niet wijzigen; verborgen beoordelingen tellen nog steeds mee in het gemiddelde.`,
  hiddenByCreator: (count) => `${count} ${plural(count, "beoordeling", "beoordelingen")} verborgen door de maker`,
  refundedOrders: (count) => `${count} van ${plural(count, "een terugbetaalde bestelling", "terugbetaalde bestellingen")}, telt niet mee`,
  noReviewsYet: "Beoordelingen van kopers verschijnen hier zodra iemand die betaald heeft er een schrijft.",
  seeAllReviews: (written) => `Alle ${written} beoordelingen bekijken`,

  askAria: "Stel een vraag over dit product",
  askLabel: "Een vraag voordat je koopt?",
  askPlaceholder: "Is het een pdf? Hoelang heb ik toegang?",
  askBusy: "Aan het lezen…",
  ask: "Vragen",
  askClosed: (store) => `Vragen zijn nu gesloten. Vraag het ${store} voordat je koopt.`,
  askTypeFirst: "Typ eerst je vraag.",
  askSlow: "Te veel vragen op dit moment. Probeer het over een paar minuten opnieuw.",
  askFailed: "Dat kon nu niet worden beantwoord. Probeer het zo meteen opnieuw.",
  askNote: (store) =>
    `Automatisch beantwoord, alleen op basis van wat deze pagina zegt. Je vraag kan aan ${store} worden getoond, zonder iets over wie je bent, dus laat persoonlijke gegevens weg.`,

  close: "Sluiten",
  beforeYouGo: "Voordat je gaat — gratis",

  aboutStore: (store) => `Over ${store}`,
  guarantee: "Garantie",
  fullSize: (alt) => `${alt}, op volledige grootte`,
  openFullSize: "Open deze afbeelding op volledige grootte",
  countdownUnits: { days: "dagen", hours: "uur", min: "min", sec: "sec" },
  until: (when) => `Tot ${when}`,

  restingTitle: "Deze pagina rust even",
  restingBody: (store) =>
    `Hij is begin volgende maand weer open, of eerder. Alles wat je al van ${store} hebt, blijft van jou en blijft beschikbaar.`,
  restingBuyerBody: (store) =>
    `Je toegang blijft: je verliest niets van wat je van ${store} hebt. Deze pagina is begin volgende maand weer open, of eerder.`,
  restingOwner: "Is dit jouw winkel? Je studio legt uit waarom, en hoe je hem weer opent",

  reviewsOf: (title) => `Beoordelingen van ${title}`,
  backTo: (title) => `Terug naar ${title}`,
  missingTitle: "Deze pagina is er niet",
  missingBody: (store) => `Misschien is ze verplaatst of weggehaald. Alles wat ${store} aanbiedt, staat op de voorpagina van de winkel.`,
  noReviewsToShow: "Er zijn geen beoordelingen om te tonen.",
  pagesOfReviews: "Pagina's met beoordelingen",
  newer: "Nieuwer",
  older: "Ouder",
  askUnknown: (store) => `Dat staat niet op deze pagina. Vraag het ${store} voordat je koopt.`,

  noLongerOnSale: "Dit product is niet meer te koop.",
  seeStore: (store) => `Bekijk ${store}`,
  cardTestMode: "Testmodus: er wordt geen echte kaart belast.",
  cardCheckout: "Veilig betalen via Stripe, in een nieuw tabblad.",
  cardOpens: (store) => `Opent in de winkel van ${store}, in een nieuw tabblad.`,

  // ---- Email cards (lib/mail-product-price.ts)
  orMore: (price) => `${price} of meer`,
  plusTax: "+ belasting, indien van toepassing",
  salePriceUntil: (price, when) => `Actieprijs: ${price}, tot ${when}`,
};
