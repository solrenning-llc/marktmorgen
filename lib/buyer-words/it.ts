/**
 * The store's words in Italian (lib/buyer-words/en.ts says what each is for).
 * "Tu", as Italian-language shops address their buyers.
 */
import type { BuyerWords } from "./index";

type Interval = "day" | "week" | "month" | "year";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const S = " ";

const every = (interval: Interval) => ({ day: "al giorno", week: "a settimana", month: "al mese", year: "all'anno" })[interval];
/** How long an introductory price lasts (lib/intro-price.ts). */
const introFirst = (count: number, interval: Interval) => (count > 1 ? `${every("month")} per i primi ${count} mesi` : ({ day: "il primo giorno", week: "la prima settimana", month: "il primo mese", year: "il primo anno" })[interval]);

export const it: BuyerWords = {
  free: "Gratis",
  fromPrice: (price) => `da ${price}`,
  was: "Prima ",
  now: "ora ",
  every,
  membershipPrice: (trialDays, payments, interval, price) => {
    const trial = trialDays > 0 ? `${trialDays} ${plural(trialDays, "giorno", "giorni")} di prova gratuita, poi ` : "";
    if (payments > 0) {
      const adjective = { day: plural(payments, "giornaliero", "giornalieri"), week: plural(payments, "settimanale", "settimanali"), month: plural(payments, "mensile", "mensili"), year: plural(payments, "annuale", "annuali") }[interval];
      return `${trial}${payments} ${plural(payments, "pagamento", "pagamenti")} ${adjective} da ${price}`;
    }
    return `${trial}${price} ${every(interval)}`;
  },
  introFirst,
  introThen: (intro, count, interval, then) => `${intro} ${introFirst(count, interval)}, poi ${then}`,
  planWords: (payments, interval, amount) =>
    `${payments} ${plural(payments, "rata", "rate")} ${interval === "week" ? plural(payments, "settimanale", "settimanali") : plural(payments, "mensile", "mensili")} da ${amount}`,
  planCount: (payments, interval) =>
    `${payments} ${plural(payments, "rata", "rate")} ${interval === "week" ? plural(payments, "settimanale", "settimanali") : plural(payments, "mensile", "mensili")}`,
  endsIn: (unit, n) =>
    unit === "day" ? `Termina tra ${n} giorni` : unit === "hour" ? `Termina tra ${n} ${plural(n, "ora", "ore")}` : `Termina tra ${n} ${plural(n, "minuto", "minuti")}`,

  fairHead: (country, percent) => `Prezzo equo per il tuo Paese (${country}): sconto del ${percent}${S}%`,
  fairNote: (store, plan) =>
    `${store} abbassa i prezzi dove il denaro vale meno. Lo sconto si applica nella pagina di pagamento, senza codice${plan ? "; il prezzo ridotto vale per il pagamento in un'unica soluzione" : ""}.`,
  saleHead: (name, percent, ends) => `${name ? `${name}: ` : ""}sconto del ${percent}${S}% · ${ends}`,
  saleNote: (until, plan) =>
    `Fino al ${until}. Lo sconto si applica nella pagina di pagamento, senza codice${plan ? "; il prezzo scontato vale per il pagamento in un'unica soluzione" : ""}.`,
  saleBanner: (name, percent, ends) =>
    `${name ? `${name}: ` : ""}sconto del ${percent}${S}% sui prodotti con il vecchio prezzo barrato · ${ends}`,
  saleBannerNote: "I prezzi qui sotto lo includono già; non serve alcun codice.",

  callLiveNone: "Sessione dal vivo, online, nessuna data in programma",
  callLive: (dates) => `Sessione dal vivo, online, ${dates} ${plural(dates, "data in programma", "date in programma")}`,
  callGroup: (minutes, seats) => `Chiamata di gruppo, ${minutes} minuti, fino a ${seats} persone, online`,
  callOne: (minutes) => `Chiamata di ${minutes} minuti, online`,
  inPersonLive: (dates) => `Sessione dal vivo, di persona, ${dates} ${plural(dates, "data in programma", "date in programma")}`,
  inPersonGroup: (minutes, seats) => `${minutes} minuti, fino a ${seats} persone, di persona`,
  inPersonOne: (minutes) => `${minutes} minuti, di persona`,
  inPersonLiveNone: "Sessione dal vivo, di persona, nessuna data in programma",
  bundleOf: (count, worth) => `Pacchetto di ${count} prodotti${worth ? ` · ${worth}` : ""}`,
  worth: (worth, price) => `${worth} di prodotti a ${price}`,
  podcast: (episodes) => `Podcast privato, ${episodes} ${plural(episodes, "episodio", "episodi")}, nella tua app di podcast`,
  fromCapital: "Da ",
  pwywFact: (least, suggested) => `Paga quanto vuoi, da ${least}. Suggerito: ${suggested}`,
  includes: (titles, more) => `Include ${titles}${more > 0 ? ` e altri ${more}` : ""}`,
  course: (lessons) => `Corso · ${lessons} ${plural(lessons, "lezione", "lezioni")}`,
  seeInside: "Scopri cosa contiene",
  readMore: "Leggi di più",
  soldOut: "Esaurito",
  left: (count, written) => `${count === 1 ? "Ne resta" : "Ne restano"} ${written}`,
  bought: (count) => `Acquistato ${count} volte`,
  orPlan: (plan) => `oppure ${plan}`,

  buySessions: (sessions, price) => `Acquista ${sessions} sessioni — ${price}`,
  packageNote: (saving, sessions, limit) =>
    `${saving ? `${saving} in meno rispetto a ${sessions} sessioni prenotate una per una. ` : ""}Paghi una volta e prenoti ciascuna quando vuoi. ${limit}.`,
  packageLimit: (days) => (days ? `Da usare entro ${days} giorni` : "Nessun limite di tempo per usarle"),

  whichOne: "Quale",
  perPerson: " a persona",
  giftSummary: "Regalalo",
  theirEmail: "La sua email",
  yourNameShown: "Il tuo nome, come lo vedrà",
  messageOptional: "Un messaggio (facoltativo)",
  buyAsGift: "Acquista come regalo",
  buyAsGiftFor: (price) => `Acquista come regalo — ${price}`,
  giftNote: (store) =>
    `Paghi sulla pagina di Stripe. Subito dopo, la persona riceve un'unica email da ${store} con il tuo nome, il tuo messaggio e un link per aprirlo con il proprio indirizzo. Tu ricevi la ricevuta, non una copia.`,
  giftProblems: {
    email: "Non sembra un indirizzo email. Controlla l'indirizzo del destinatario e riprova.",
    option: "Scegli cosa regalare, poi riprova. Non è stato addebitato nulla.",
    product: "Questo prodotto non può più essere acquistato come regalo.",
    unavailable: "I regali non sono disponibili al momento. Non è stato addebitato nulla.",
  },
  teamSummary: "Acquistalo per un team",
  howManyPeople: "Quante persone",
  buyForTeam: "Acquista per il tuo team",
  buyForTeamEach: (each) => `Acquista per il tuo team — ${each} a persona`,
  teamNote:
    "Paghi una sola volta sulla pagina di Stripe, dove vedi il totale prima di pagare. Subito dopo ricevi un link da condividere: ogni persona lo apre, inserisce la propria email e lo riceve al proprio indirizzo. Anche tu prendi il tuo posto allo stesso modo.",
  teamProblems: (least, most) => ({
    people: `Indica quante persone, da ${least} a ${most}. Non è stato addebitato nulla.`,
    option: "Scegli cosa acquistare per tutti, poi riprova. Non è stato addebitato nulla.",
    amount: "Così tante persone a questo prezzo superano ciò che un solo pagamento può coprire. Prova con meno persone o acquista in due volte. Non è stato addebitato nulla.",
    product: "Questo prodotto non può più essere acquistato per più persone.",
    unavailable: "L'acquisto per più persone non è disponibile al momento. Non è stato addebitato nulla.",
  }),

  leaveEmpty: "Lascia vuoto questo campo",
  comingSoon: "Presto disponibile",
  yourEmail: "La tua email",
  emailPlaceholder: "tu@esempio.com",
  friendPlaceholder: "amico@esempio.com",
  namePlaceholder: "Dana",
  alsoOtherEmails: (store) => `Inviami anche altre email di ${store}. Posso disiscrivermi quando voglio.`,
  alsoEmails: (store) => `Inviami anche email di ${store}. Posso disiscrivermi quando voglio.`,
  alsoClicks: (store) => `Permetti a ${store} di vedere quali link delle sue email uso, per inviarmi ciò che mi interessa. Posso smettere da qualsiasi email.`,
  tellMe: "Avvisami quando esce",
  waitlistNote: (store) =>
    `Confermi dalla tua casella di posta, poi ricevi un'unica email quando sarà in vendita, e basta. Il tuo indirizzo arriva a ${store} solo se hai spuntato la casella.`,
  emailItToMe: "Inviamelo via email",
  freeNote: (store) =>
    `Ti inviamo un link via email. Quando lo usi, ${store} riceve il tuo indirizzo, con l'indicazione se hai spuntato la casella. Marktmorgen non lo usa per nient'altro.`,
  notAvailable: "Non disponibile al momento.",
  noDates: "Nessuna data in vendita al momento.",
  notOnSale: "Non ancora in vendita.",
  soldOutStop: "Esaurito.",
  cannotTakePayments: "Questo negozio non può ancora accettare pagamenti.",
  joinWaitlist: "Unisciti alla lista d'attesa",
  getItFree: "Ottienilo gratis",

  pickSession: "Scegli una sessione",
  pickTime: "Scegli un orario",
  priced: (label, price) => `${label} — ${price}`,
  /** The store's blog (lib/store-blog.ts; app/[handle]/blog). */
  blog: "Blog",
  blogOf: (store) => `Il blog di ${store}`,
  blogEmpty: "Qui non c’è ancora niente.",
  blogMinutes: (n) => `${n} min di lettura`,
  blogNewer: "Articoli più recenti",
  blogOlder: "Articoli precedenti",
  blogAll: "Tutti gli articoli",
  blogPublished: (date) => `Pubblicato il ${date}`,
  blogFrom: (store) => `Da ${store}`,
  blogFeed: "Segui via RSS",
  /** What one unit costs within an option, when its name gives how many (lib/option-units.ts): "$7.80 per week". */
  perUnit: (price, unit) => `${price} a ${unit}`,
  /** How much less each unit costs than in the option of one. */
  unitSaving: (percent) => `risparmi il ${percent}%`,
  chooseOptionFor: (title) => `Scegli un'opzione per ${title}`,
  recommended: "Consigliato",
  recommendedAfter: " (consigliato)",
  howToPayFor: (title) => `Come pagare ${title}`,
  payInFull: "Paga in un'unica soluzione",
  today: (amount) => `${amount} oggi`,
  addFor: (title, price) => `Aggiungi ${title} a ${price}`,
  bundleBox: (count) => `Un pacchetto di ${count} prodotti, ciascuno tuo da aprire subito dopo il pagamento.`,
  onItsOwn: (price) => `${price} da solo`,
  chooseYourPrice: "Scegli il tuo prezzo",
  startTrial: (days) => `Inizia la prova gratuita di ${days} ${plural(days, "giorno", "giorni")}`,
  subscribe: "Abbonati",
  continueOption: "Continua con questa opzione",
  subscribeFor: (price, every) => `Abbonati — ${price} ${every}`,
  buyFor: (price) => `Acquista a ${price}`,
  startPlanToday: (amount) => `Inizia il pagamento a rate: ${amount} oggi`,
  startPlanWith: (named, amount) => `Inizia il pagamento a rate insieme a ${named}: ${amount} oggi`,
  nAdded: (count) => `altri ${count} prodotti`,
  buyItWith: (named) => `Acquista insieme a ${named}`,
  buyAllFor: (boxes, price) => `${["Acquista", "Acquista entrambi", "Acquista tutti e tre", "Acquista tutti e quattro"][boxes]} a ${price}`,
  pwywNote: (least, suggested) => `Inserisci l'importo nella pagina di pagamento: ${least} o più, ${suggested} suggerito.`,
  trialNote: (days, after, untilCancel) =>
    `Inserisci ora la tua carta e non ti viene addebitato nulla per ${days} ${plural(days, "giorno", "giorni")}. Poi ${after}${untilCancel ? " finché non annulli" : ""}. Se annulli prima della fine della prova, non paghi nulla.`,
  switchPlansNote: "Più avanti puoi passare a un altro piano di questo negozio, superiore o inferiore, e vedere l'importo esatto prima di qualsiasi addebito.",
  payPal: (alone, price) => `${alone ? "Acquista" : "Oppure paga"} con PayPal — ${price}`,
  payPalNote: (store) => `Pagato sul conto PayPal di ${store}. Ciò che acquisti viene inviato all'indirizzo email del tuo conto PayPal.`,
  chooseAndBuy: "Scegli e acquista",
  memberManage: "Sei già membro? Gestisci o annulla",
  memberSwitch: "Sei già membro? Cambia piano, gestisci o annulla",

  takenBy: (stripe, paypal) => (stripe && paypal ? "Stripe o PayPal" : paypal ? "PayPal" : "Stripe"),
  testModeTitle: "Questo checkout è in modalità di prova di Stripe.",
  testModeBody: "Non si muove denaro reale e nessuna carta reale viene addebitata, quindi non inserire una carta tua.",
  testModeLater: (store) =>
    `Quando sarà attivo, il pagamento verrà incassato da Stripe sul conto di ${store}: Marktmorgen non trattiene mai il denaro e non ne prende nulla.`,
  paidBy: (takers, store) =>
    `Il pagamento viene incassato da ${takers} sul conto di ${store}. Marktmorgen non trattiene mai il denaro e non ne prende nulla.`,
  noPaymentsTitle: "Questo negozio non può ancora accettare pagamenti.",
  noPaymentsBody: (store) => `I prezzi qui sopra sono reali, ma qui nulla può addebitare una carta. Per acquistare, scrivi direttamente a ${store}.`,
  noPaymentsBodyOne: (store) => `Il prezzo qui sopra è reale, ma qui nulla può addebitare una carta. Per acquistare, scrivi direttamente a ${store}.`,

  notices: {
    soldout: { title: "È appena andato esaurito", body: "L'ultimo è stato venduto un attimo prima che premessi acquista. Non è stato addebitato nulla." },
    busy: { title: "Qualcun altro lo sta acquistando proprio ora", body: "Non è stato addebitato nulla. Premi di nuovo acquista tra un momento." },
    slow: { title: "Troppi tentativi in pochi minuti", body: "Non è stato addebitato nulla. Attendi qualche minuto, poi premi di nuovo acquista." },
    error: { title: "Non è stato possibile aprire la pagina di pagamento", body: "Non è stato addebitato nulla. Riprova tra un momento." },
    paused: { title: "Questo negozio non accetta nuovi ordini in questo momento", body: "Non è stato addebitato nulla. I nuovi ordini riaprono all'inizio del mese prossimo, o prima." },
    "paypal-declined": {
      title: "PayPal non ha accettato il pagamento",
      body: "Non è stato addebitato nulla. Riprova con un'altra carta o un altro conto su PayPal, oppure paga qui con la carta.",
    },
    "paypal-error": {
      title: "Non è stato possibile associare quel pagamento PayPal a questo negozio",
      body: "Non è stato consegnato nulla per quel pagamento. Se PayPal mostra un addebito, scrivi al negozio rispondendo alla ricevuta di PayPal.",
    },
  },
  storeDescription: (store) => `Il negozio di ${store} su Marktmorgen.`,
  nothingYet: "Ancora niente qui",
  nothingYetBody: (store) => `Questa pagina è aperta ma vuota. Quando ${store} aggiungerà qualcosa, apparirà qui.`,
  continued: " (continua)",
  pagesOfProducts: "Pagine di prodotti",
  previous: "Precedente",
  next: "Successiva",
  pageOf: (page, pages) => `Pagina ${page} di ${pages}`,
  products: (count, written) => `${written} ${plural(count, "prodotto", "prodotti")}`,
  communityTitle: "Community dei membri",
  communityBody: "Per chi possiede uno dei prodotti che danno accesso. Entra con l'indirizzo email che hai usato per ottenerlo.",
  getAgain: "Hai acquistato qui? Recupera il tuo acquisto",
  affiliateProgram: (store) => `Guadagna condividendo ${store}: il programma di affiliazione`,
  madeWith: "Creato con Marktmorgen",

  productDescription: (title, store) => `${title}, dal negozio di ${store}.`,
  insideTitle: (count) => `Cosa contiene: ${count} prodotti`,
  insideCourse: (lessons) => `Corso, ${lessons} ${plural(lessons, "lezione", "lezioni")} · `,
  insideNote: "Ognuno è tuo subito dopo il pagamento, come se lo avessi acquistato da solo.",
  payInFullOr: (plan) => `Paga in un'unica soluzione oppure in ${plan}`,
  youChoose: (least) => `Scegli tu il prezzo: ${least} o più.`,
  readFirst: (pages) => `Leggi gratis ${pages === 1 ? "la prima pagina" : `le prime ${pages} pagine`} (PDF)`,
  everythingFrom: (store) => `Tutto di ${store}`,
  getTitle: (title) => `Ottieni ${title}`,
  moreFrom: (store) => `Altro di ${store}`,
  pairedWith: (title) => `Si abbina bene a ${title}`,
  pickedBy: (store) => `Scelto da ${store}`,
  collections: "Collezioni",
  inCollections: "Fa parte di",
  productCount: (n) => `${n} ${n === 1 ? "prodotto" : "prodotti"}`,
  alsoBought: (title) => `Chi ha acquistato ${title} ha acquistato anche`,
  boughtBoth: (n) => `${n} acquirenti hanno comprato entrambi`,
  billMonthly: "Mensile",
  billYearly: "Annuale",
  yearSave: (amount) => `Risparmi ${amount}`,
  yearlyFact: (price, save) => `Oppure ${price} ${every("year")}, con un risparmio di ${save}`,

  reviews: "Recensioni",
  verifiedReviews: (count, written) => `${written} ${plural(count, "recensione verificata", "recensioni verificate")}`,
  ratedFrom: (average, reviews) => `Valutato ${average} su 5 in base a ${reviews}`,
  ratedOutOf5: (average) => `Valutato ${average} su 5`,
  starsOutOf5: (stars) => `${stars} ${plural(stars, "stella", "stelle")} su 5`,
  verifiedBuyer: "Acquirente verificato",
  verifiedPurchase: "Acquisto verificato",
  pickedByCreator: "Scelta dal creatore",
  refundedNotCounted: "Rimborsato, non conteggiato",
  edited: (date) => ` · modificata il ${date}`,
  replyFrom: (store) => `Risposta di ${store}`,
  starsSpread: "Come sono distribuite le stelle",
  starLabel: (stars) => `${stars} ${plural(stars, "stella", "stelle")}`,
  reviewCount: (count) => `${count} ${plural(count, "recensione", "recensioni")}`,
  reviewRules: (title, store) =>
    `Solo chi ha acquistato ${title} qui può recensirlo, e ogni recensione viene verificata con il suo ordine. ${store} può rispondere e nascondere una recensione, ma non modificarla; le recensioni nascoste contano comunque nella media.`,
  hiddenByCreator: (count) => `${count} ${plural(count, "recensione nascosta", "recensioni nascoste")} dal creatore`,
  refundedOrders: (count) => `${count} da ${plural(count, "un ordine rimborsato, non conteggiata", "ordini rimborsati, non conteggiate")}`,
  noReviewsYet: "Le recensioni degli acquirenti appariranno qui quando qualcuno che ha pagato ne scriverà una.",
  seeAllReviews: (written) => `Vedi tutte le ${written} recensioni`,

  askAria: "Fai una domanda su questo prodotto",
  askLabel: "Una domanda prima di acquistare?",
  askPlaceholder: "È un PDF? Per quanto tempo ho accesso?",
  askBusy: "Sto leggendo…",
  ask: "Chiedi",
  askClosed: (store) => `Le domande sono chiuse al momento. Chiedi a ${store} prima di acquistare.`,
  askTypeFirst: "Scrivi prima la tua domanda.",
  askSlow: "Troppe domande in questo momento. Riprova tra qualche minuto.",
  askFailed: "Non è stato possibile rispondere ora. Riprova tra un momento.",
  askNote: (store) =>
    `Risposta automatica, solo in base a ciò che dice questa pagina. La tua domanda potrebbe essere mostrata a ${store}, senza nulla su chi sei, quindi non inserire dati personali.`,

  close: "Chiudi",
  beforeYouGo: "Prima di andare — gratis",

  aboutStore: (store) => `Informazioni su ${store}`,
  guarantee: "Garanzia",
  fullSize: (alt) => `${alt}, a grandezza intera`,
  openFullSize: "Apri questa immagine a grandezza intera",
  countdownUnits: { days: "giorni", hours: "ore", min: "min", sec: "sec" },
  until: (when) => `Fino a ${when}`,

  restingTitle: "Questa pagina è in pausa per ora",
  restingBody: (store) =>
    `Riaprirà all'inizio del mese prossimo, o prima. Tutto ciò che hai già da ${store} resta tuo e resta disponibile.`,
  restingBuyerBody: (store) =>
    `Il tuo accesso resta: non perdi nulla di ciò che hai da ${store}. Questa pagina riapre all'inizio del mese prossimo, o prima.`,
  restingOwner: "È il tuo negozio? Il tuo studio spiega perché e come riaprirlo",

  reviewsOf: (title) => `Recensioni di ${title}`,
  backTo: (title) => `Torna a ${title}`,
  missingTitle: "Questa pagina non è qui",
  missingBody: (store) => `Potrebbe essere stata spostata o rimossa. Tutto ciò che offre ${store} è nella pagina principale del negozio.`,
  noReviewsToShow: "Non ci sono recensioni da mostrare.",
  pagesOfReviews: "Pagine di recensioni",
  newer: "Più recenti",
  older: "Meno recenti",
  askUnknown: (store) => `Questa pagina non lo dice. Chiedi a ${store} prima di acquistare.`,

  noLongerOnSale: "Questo prodotto non è più in vendita.",
  seeStore: (store) => `Vedi ${store}`,
  cardTestMode: "Modalità di prova: nessuna carta reale viene addebitata.",
  cardCheckout: "Pagamento sicuro con Stripe, in una nuova scheda.",
  cardOpens: (store) => `Si apre nel negozio di ${store}, in una nuova scheda.`,
};
