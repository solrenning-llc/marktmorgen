/**
 * The store's words in French (lib/buyer-words/en.ts says what each is for).
 * "Vous", as French-language shops address their buyers, and French
 * typography: a non-breaking space before ":", "?", "!", ";" and "%", and the
 * singular for 0 and 1.
 */
import type { BuyerWords } from "./index";

type Interval = "day" | "week" | "month" | "year";

/** French takes the singular for 0 and 1. */
const plural = (n: number, one: string, many: string) => (n < 2 ? one : many);
/** A non-breaking space, before the signs French spaces from the word before them. */
const S = " ";

const every = (interval: Interval) => ({ day: "par jour", week: "par semaine", month: "par mois", year: "par an" })[interval];
/** How long an introductory price lasts (lib/intro-price.ts). */
const introFirst = (count: number, interval: Interval) => (count > 1 ? `${every("month")} pendant les ${count} premiers mois` : ({ day: "le premier jour", week: "la première semaine", month: "le premier mois", year: "la première année" })[interval]);

export const fr: BuyerWords = {
  free: "Gratuit",
  fromPrice: (price) => `à partir de ${price}`,
  was: "Avant ",
  now: "maintenant ",
  every,
  membershipPrice: (trialDays, payments, interval, price) => {
    const trial = trialDays > 0 ? `${trialDays}${S}${plural(trialDays, "jour", "jours")} d'essai gratuit, puis ` : "";
    if (payments > 0) {
      const adjective = { day: plural(payments, "quotidien", "quotidiens"), week: plural(payments, "hebdomadaire", "hebdomadaires"), month: plural(payments, "mensuel", "mensuels"), year: plural(payments, "annuel", "annuels") }[interval];
      return `${trial}${payments}${S}${plural(payments, "paiement", "paiements")} ${adjective} de ${price}`;
    }
    return `${trial}${price} ${every(interval)}`;
  },
  introFirst,
  introThen: (intro, count, interval, then) => `${intro} ${introFirst(count, interval)}, puis ${then}`,
  planWords: (payments, interval, amount) =>
    `${payments}${S}${plural(payments, "paiement", "paiements")} ${interval === "week" ? plural(payments, "hebdomadaire", "hebdomadaires") : plural(payments, "mensuel", "mensuels")} de ${amount}`,
  planCount: (payments, interval) =>
    `${payments}${S}${plural(payments, "paiement", "paiements")} ${interval === "week" ? plural(payments, "hebdomadaire", "hebdomadaires") : plural(payments, "mensuel", "mensuels")}`,
  endsIn: (unit, n) =>
    unit === "day"
      ? `Se termine dans ${n}${S}jours`
      : unit === "hour"
        ? `Se termine dans ${n}${S}${plural(n, "heure", "heures")}`
        : `Se termine dans ${n}${S}${plural(n, "minute", "minutes")}`,

  fairHead: (country, percent) => `Prix juste pour votre pays (${country})${S}: -${percent}${S}%`,
  fairNote: (store, plan) =>
    `${store} baisse ses prix là où l'argent a moins de valeur. Ce prix a été fixé automatiquement pour vous, d'après le pays de votre connexion internet. La remise s'applique sur la page de paiement, sans code${plan ? `${S}; le prix réduit concerne le paiement en une fois` : ""}.`,
  saleHead: (name, percent, ends) => `${name ? `${name}${S}: ` : ""}-${percent}${S}% · ${ends}`,
  saleNote: (until, plan) =>
    `Jusqu'au ${until}. La remise s'applique sur la page de paiement, sans code${plan ? `${S}; le prix soldé concerne le paiement en une fois` : ""}.`,
  saleBanner: (name, percent, ends) =>
    `${name ? `${name}${S}: ` : ""}-${percent}${S}% sur les produits dont l'ancien prix est barré · ${ends}`,
  saleBannerNote: `Les prix ci-dessous en tiennent déjà compte${S}; aucun code n'est nécessaire.`,

  callLiveNone: "Session en direct, en ligne, aucune date prévue",
  callLive: (dates) => `Session en direct, en ligne, ${dates}${S}${plural(dates, "date prévue", "dates prévues")}`,
  callGroup: (minutes, seats) => `Appel de groupe, ${minutes}${S}minutes, jusqu'à ${seats}${S}personnes, en ligne`,
  callOne: (minutes) => `Appel de ${minutes}${S}minutes, en ligne`,
  callLengths: (list) => `Appel de ${list}${S}minutes, en ligne`,
  inPersonLive: (dates) => `Séance en personne, ${dates}${S}${plural(dates, "date prévue", "dates prévues")}`,
  inPersonGroup: (minutes, seats) => `${minutes}${S}minutes, jusqu'à ${seats}${S}personnes, en personne`,
  inPersonOne: (minutes) => `${minutes}${S}minutes, en personne`,
  inPersonLengths: (list) => `${list}${S}minutes, en personne`,
  inPersonLiveNone: "Séance en personne, aucune date prévue",
  bundleOf: (count, worth) => `Lot de ${count}${S}produits${worth ? ` · ${worth}` : ""}`,
  worth: (worth, price) => `${worth} de produits pour ${price}`,
  podcast: (episodes) => `Podcast privé, ${episodes}${S}${plural(episodes, "épisode", "épisodes")}, dans votre propre application de podcasts`,
  fromCapital: "À partir de ",
  pwywFact: (least, suggested) => `Payez ce que vous voulez, à partir de ${least}. Suggéré${S}: ${suggested}`,
  includes: (titles, more) => `Comprend ${titles}${more > 0 ? ` et ${more}${S}autres` : ""}`,
  course: (lessons) => `Formation · ${lessons}${S}${plural(lessons, "leçon", "leçons")}`,
  seeInside: "Voir le contenu",
  readMore: "En savoir plus",
  soldOut: "Épuisé",
  left: (_count, written) => `Plus que ${written}`,
  bought: (count) => `Acheté ${count}${S}fois`,
  orPlan: (plan) => `ou ${plan}`,

  buySessions: (sessions, price) => `Acheter ${sessions}${S}séances — ${price}`,
  packageNote: (saving, sessions, limit) =>
    `${saving ? `${saving} de moins que ${sessions}${S}séances réservées une à une. ` : ""}Payées en une fois, chacune réservée quand vous le souhaitez. ${limit}.`,
  packageLimit: (days) => (days ? `À utiliser dans un délai de ${days}${S}jours` : "Sans limite de temps pour les utiliser"),

  whichOne: "Laquelle",
  perPerson: " par personne",
  giftSummary: "L'offrir en cadeau",
  theirEmail: "Son e-mail",
  yourNameShown: "Votre nom, tel qu'il le verra",
  messageOptional: "Un message (facultatif)",
  buyAsGift: "Offrir en cadeau",
  buyAsGiftFor: (price) => `Offrir en cadeau — ${price}`,
  giftNote: (store) =>
    `Vous payez sur la page de Stripe. Après le paiement, le cadeau est associé à son adresse. Si l'e-mail unique de ${store} lui parvient, il contient votre nom, votre message et un lien pour l'ouvrir. Vous recevez le reçu, pas une copie.`,
  giftProblems: {
    email: "Cela ne ressemble pas à une adresse e-mail. Vérifiez l'adresse du destinataire et réessayez.",
    option: "Choisissez ce que vous offrez, puis réessayez. Rien n'a été débité.",
    product: "Ce produit ne peut plus être offert en cadeau.",
    unavailable: "Les cadeaux ne sont pas disponibles pour le moment. Rien n'a été débité.",
  },
  teamSummary: "L'acheter pour une équipe",
  howManyPeople: "Combien de personnes",
  buyForTeam: "Acheter pour votre équipe",
  buyForTeamEach: (each) => `Acheter pour votre équipe — ${each} par personne`,
  teamNote:
    `Vous payez une seule fois sur la page de Stripe, où le total s'affiche avant le paiement. Juste après, vous recevez un lien à transmettre${S}: chaque personne l'ouvre, saisit son propre e-mail et y accède avec sa propre adresse. Vous prenez votre place de la même façon.`,
  teamProblems: (least, most) => ({
    people: `Indiquez le nombre de personnes, de ${least} à ${most}. Rien n'a été débité.`,
    option: "Choisissez ce que vous achetez pour tout le monde, puis réessayez. Rien n'a été débité.",
    amount: "Autant de personnes à ce prix dépassent ce qu'un seul paiement peut couvrir. Essayez avec moins de personnes, ou achetez en deux fois. Rien n'a été débité.",
    product: "Ce produit ne peut plus être acheté pour plusieurs personnes.",
    unavailable: "L'achat pour plusieurs personnes n'est pas disponible pour le moment. Rien n'a été débité.",
  }),

  leaveEmpty: "Laissez ce champ vide",
  comingSoon: "Bientôt disponible",
  yourEmail: "Votre e-mail",
  emailPlaceholder: "vous@exemple.com",
  friendPlaceholder: "ami@exemple.com",
  namePlaceholder: "Dana",
  alsoOtherEmails: (store) => `Envoyez-moi aussi d'autres e-mails de ${store}. Je peux me désabonner quand je veux.`,
  alsoEmails: (store) => `Envoyez-moi aussi des e-mails de ${store}. Je peux me désabonner quand je veux.`,
  alsoClicks: (store) => `Permettre à ${store} de voir quels liens de ses e-mails j'utilise, pour m'envoyer ce qui m'intéresse. Je peux arrêter depuis n'importe quel e-mail.`,
  tellMe: "Prévenez-moi à sa sortie",
  waitlistNote: (store) =>
    `Vous confirmez depuis votre boîte de réception, puis recevez un seul e-mail quand il sera en vente, et c'est tout. Votre adresse n'est transmise à ${store} que si vous avez coché la case.`,
  emailItToMe: "Recevoir par e-mail",
  freeNote: (store) =>
    `Un lien vous est envoyé par e-mail. Dès que vous l'utilisez, ${store} reçoit votre adresse, avec l'indication que vous avez coché la case ou non. Marktmorgen ne l'utilise pour rien d'autre.`,
  notAvailable: "Indisponible pour le moment.",
  noDates: "Aucune date en vente pour le moment.",
  notOnSale: "Pas encore en vente.",
  soldOutStop: "Épuisé.",
  cannotTakePayments: "Cette boutique ne peut pas encore accepter de paiements.",
  joinWaitlist: "Rejoindre la liste d'attente",
  getItFree: "L'obtenir gratuitement",

  pickSession: "Choisir une session",
  pickTime: "Choisir un créneau",
  priced: (label, price) => `${label} — ${price}`,
  /** The store's blog (lib/store-blog.ts; app/[handle]/blog). */
  blog: "Blog",
  blogOf: (store) => `Le blog de ${store}`,
  blogPastEnd: "Aucun article sur cette page",
  blogPastEndBody: "Cette page se trouve après le dernier article.",
  blogMinutes: (n) => `${n}\u00a0min de lecture`,
  blogNewer: "Articles plus récents",
  blogOlder: "Articles précédents",
  blogAll: "Tous les articles",
  blogPublished: (date) => `Publié le ${date}`,
  blogFrom: (store) => `Chez ${store}`,
  blogFeed: "Suivre par RSS",
  /** What one unit costs within an option, when its name gives how many (lib/option-units.ts): "$7.80 per week". */
  perUnit: (price, unit) => `${price} par ${unit}`,
  /** How much less each unit costs than in the option of one. */
  unitSaving: (percent) => `soit ${percent}\u00a0% d’économie`,
  chooseOptionFor: (title) => `Choisissez une option pour ${title}`,
  chooseOne: "Choisissez-en une",
  optionFromLink: (label) => `Vous venez pour ${label}, cette option est donc choisie ci-dessous. Vous pouvez en choisir une autre.`,
  recommended: "Recommandé",
  recommendedAfter: " (recommandé)",
  howToPayFor: (title) => `Comment payer ${title}`,
  payInFull: "Payer en une fois",
  today: (amount) => `${amount} aujourd'hui`,
  addFor: (title, price) => `Ajouter ${title} pour ${price}`,
  bundleBox: (count) => `Un lot de ${count}${S}produits, chacun à vous dès le paiement effectué.`,
  onItsOwn: (price) => `${price} seul`,
  chooseYourPrice: "Choisir votre prix",
  startTrial: (days) => `Commencer l'essai gratuit de ${days}${S}${plural(days, "jour", "jours")}`,
  subscribe: "S'abonner",
  continueOption: "Continuer avec cette option",
  subscribeFor: (price, every) => `S'abonner — ${price} ${every}`,
  buyFor: (price) => `Acheter pour ${price}`,
  startPlanToday: (amount) => `Commencer le paiement échelonné${S}: ${amount} aujourd'hui`,
  startPlanWith: (named, amount) => `Commencer le paiement échelonné avec ${named}${S}: ${amount} aujourd'hui`,
  nAdded: (count) => `${count}${S}produits en plus`,
  buyItWith: (named) => `Acheter avec ${named}`,
  buyAllFor: (boxes, price) => `${["Acheter", "Acheter les deux", "Acheter les trois", "Acheter les quatre"][boxes]} pour ${price}`,
  pwywNote: (least, suggested) => `Vous saisissez le montant sur la page de paiement${S}: ${least} ou plus, ${suggested} suggéré.`,
  trialNote: (days, after, untilCancel) =>
    `Vous saisissez votre carte maintenant, et rien n'est débité pendant ${days}${S}${plural(days, "jour", "jours")}. Ensuite, ${after}${untilCancel ? " jusqu'à ce que vous annuliez" : ""}. Annulez avant la fin de l'essai et vous ne payez rien.`,
  switchPlansNote: "Vous pourrez passer plus tard à une autre formule de cette boutique, supérieure ou inférieure, et voir le montant exact avant tout débit.",
  payPal: (alone, price) => `${alone ? "Acheter" : "Ou payer"} avec PayPal — ${price}`,
  payPalNote: (store) => `Payé sur le propre compte PayPal de ${store}. Votre achat est envoyé à l'adresse e-mail de votre compte PayPal.`,
  chooseAndBuy: "Choisir et acheter",
  memberManage: `Déjà membre${S}? Gérer ou annuler`,
  memberSwitch: `Déjà membre${S}? Changer de formule, gérer ou annuler`,

  takenBy: (stripe, paypal) => (stripe && paypal ? "Stripe ou PayPal" : paypal ? "PayPal" : "Stripe"),
  testModeTitle: "Ce paiement fonctionne en mode test de Stripe.",
  testModeBody: `Aucun argent réel ne circule et aucune vraie carte n'est débitée${S}: n'y saisissez donc pas une carte qui vous appartient.`,
  testModeLater: (store) =>
    `Une fois en service, le paiement sera encaissé par Stripe sur le propre compte de ${store}${S}: Marktmorgen ne détient jamais l'argent et n'en prend rien.`,
  paidBy: (takers, store) =>
    `Le paiement est encaissé par ${takers} sur le propre compte de ${store}. Marktmorgen ne détient jamais l'argent et n'en prend rien.`,
  whoAnswers: (store) =>
    `${store} est le vendeur et répond de ce que vous achetez, des remboursements et de tout droit de rétractation dont vous disposez. Marktmorgen héberge les pages de la boutique et n'est pas partie à la vente.`,
  noPaymentsTitle: "Cette boutique ne peut pas encore accepter de paiements.",
  noPaymentsBody: (store) => `Les prix ci-dessus sont réels, mais rien ici ne peut débiter une carte. Pour acheter, écrivez directement à ${store}.`,
  noPaymentsBodyOne: (store) => `Le prix ci-dessus est réel, mais rien ici ne peut débiter une carte. Pour acheter, écrivez directement à ${store}.`,

  notices: {
    soldout: { title: "Il vient d'être épuisé", body: "Le dernier est parti juste avant que vous cliquiez sur acheter. Rien n'a été débité." },
    busy: { title: "Quelqu'un est en train de l'acheter", body: "Rien n'a été débité. Cliquez de nouveau sur acheter dans un instant." },
    slow: { title: "Beaucoup de tentatives en quelques minutes", body: "Rien n'a été débité. Patientez quelques minutes, puis cliquez de nouveau sur acheter." },
    error: { title: "La page de paiement n'a pas pu s'ouvrir", body: "Rien n'a été débité. Réessayez dans un instant." },
    nocharges: { title: "Cette boutique ne peut pas accepter de paiements par carte pour le moment", body: "Rien n'a été débité. Réessayer ne fonctionnera pas tant que la boutique n'aura pas réglé le problème." },
    paused: { title: "Cette boutique ne prend pas de nouvelles commandes pour le moment", body: "Rien n'a été débité. Les nouvelles commandes rouvrent au début du mois prochain, ou avant." },
    "paypal-declined": {
      title: "PayPal n'a pas accepté le paiement",
      body: "Rien n'a été débité. Réessayez avec une autre carte ou un autre compte dans PayPal, ou payez par carte ici.",
    },
    "paypal-error": {
      title: "Ce paiement PayPal n'a pas pu être associé à cette boutique",
      body: "Rien n'a été remis en échange. Si PayPal indique un débit, écrivez à la boutique en répondant au reçu de PayPal.",
    },
  },
  storeDescription: (store) => `La boutique de ${store} sur Marktmorgen.`,
  nothingYet: "Rien pour l'instant",
  nothingYetBody: (store) => `Cette page est ouverte mais vide. Quand ${store} ajoutera quelque chose, cela apparaîtra ici.`,
  continued: " (suite)",
  pagesOfProducts: "Pages de produits",
  previous: "Précédent",
  next: "Suivant",
  pageOf: (page, pages) => `Page ${page} sur ${pages}`,
  products: (count, written) => `${written}${S}${plural(count, "produit", "produits")}`,
  communityTitle: "Communauté des membres",
  communityBody: "Pour les personnes qui possèdent l'un des produits qui y donnent accès. Entrez avec l'adresse e-mail utilisée pour l'obtenir.",
  getAgain: `Vous avez acheté ici${S}? Récupérez votre achat`,
  affiliateProgram: (store) => `Gagnez de l'argent en partageant ${store}${S}: le programme d'affiliation`,
  madeWith: "Créé avec Marktmorgen",

  productDescription: (title, store) => `${title}, de la boutique de ${store}.`,
  insideTitle: (count) => `Contenu${S}: ${count}${S}produits`,
  insideCourse: (lessons) => `Formation, ${lessons}${S}${plural(lessons, "leçon", "leçons")} · `,
  insideNote: "Chacun est à vous dès le paiement effectué, comme si vous l'aviez acheté seul.",
  payInFullOr: (plan) => `Payez en une fois, ou en ${plan}`,
  youChoose: (least) => `Vous choisissez le prix${S}: ${least} ou plus.`,
  readFirst: (pages) => `Lire gratuitement ${pages === 1 ? "la première page" : `les ${pages}${S}premières pages`} (PDF)`,
  everythingFrom: (store) => `Tout ce que propose ${store}`,
  getTitle: (title) => `Obtenir ${title}`,
  moreFrom: (store) => `Plus de ${store}`,
  pairedWith: (title) => `Va bien avec ${title}`,
  pickedBy: (store) => `Choisi par ${store}`,
  collections: "Collections",
  inCollections: "Fait partie de",
  productCount: (n) => `${n}${S}${n <= 1 ? "produit" : "produits"}`,
  alsoBought: (title) => `Les acheteurs de ${title} ont aussi acheté`,
  boughtBoth: (n) => `${n}${S}acheteurs ont acheté les deux`,
  billMonthly: "Mensuel",
  billYearly: "Annuel",
  yearSave: (amount) => `Économisez ${amount}`,
  yearlyFact: (price, save) => `Ou ${price} ${every("year")}, soit ${save} d'économie`,

  reviews: "Avis",
  verifiedReviews: (count, written) => `${written}${S}${plural(count, "avis vérifié", "avis vérifiés")}`,
  ratedFrom: (average, reviews) => `Noté ${average} sur 5 d'après ${reviews}`,
  ratedOutOf5: (average) => `Noté ${average} sur 5`,
  starsOutOf5: (stars) => `${stars} ${plural(stars, "étoile", "étoiles")} sur 5`,
  verifiedBuyer: "Acheteur vérifié",
  verifiedPurchase: "Achat vérifié",
  pickedByCreator: "Choisi par le créateur",
  refundedNotCounted: "Remboursé, non compté",
  edited: (date) => ` · modifié le ${date}`,
  replyFrom: (store) => `Réponse de ${store}`,
  starsSpread: "Répartition des étoiles",
  starLabel: (stars) => `${stars}${S}${plural(stars, "étoile", "étoiles")}`,
  reviewCount: (count) => `${count}${S}avis`,
  reviewRules: (title, store) =>
    `Seules les personnes qui ont acheté ${title} ici peuvent donner leur avis, et chaque avis est vérifié par rapport à sa commande. ${store} peut répondre et masquer un avis, mais pas le modifier${S}; les avis masqués comptent toujours dans la moyenne.`,
  hiddenByCreator: (count) => `${count}${S}${plural(count, "avis masqué", "avis masqués")} par le créateur`,
  refundedOrders: (count) => `${count}${S}${plural(count, "provenant d'une commande remboursée, non compté", "provenant de commandes remboursées, non comptés")}`,
  noReviewsYet: "Les avis des acheteurs apparaîtront ici dès qu'une personne ayant payé en écrira un.",
  seeAllReviews: (written) => `Voir les ${written}${S}avis`,

  askAria: "Poser une question sur ce produit",
  askLabel: `Une question avant d'acheter${S}?`,
  askPlaceholder: `Est-ce un PDF${S}? Combien de temps ai-je accès${S}?`,
  askBusy: "Lecture…",
  ask: "Demander",
  askClosed: (store) => `Les questions sont fermées pour le moment. Posez votre question à ${store} avant d'acheter.`,
  askTypeFirst: "Saisissez d'abord votre question.",
  askSlow: "Trop de questions en ce moment. Réessayez dans quelques minutes.",
  askFailed: "Impossible de répondre pour le moment. Réessayez dans un instant.",
  askNote: (store) =>
    `Réponse automatique, uniquement à partir de ce que dit cette page. Votre question peut être montrée à ${store}, sans rien sur votre identité${S}: n'y mettez donc pas d'informations personnelles.`,

  close: "Fermer",
  beforeYouGo: "Avant de partir — gratuit",

  aboutStore: (store) => `À propos de ${store}`,
  guarantee: "Garantie",
  fullSize: (alt) => `${alt}, en taille réelle`,
  openFullSize: "Ouvrir cette image en taille réelle",
  countdownUnits: { days: "jours", hours: "heures", min: "min", sec: "s" },
  until: (when) => `Fin${S}: ${when}`,

  restingTitle: "Cette page est en pause pour le moment",
  restingBody: (store) =>
    `Elle rouvrira au début du mois prochain, ou avant. Tout ce que vous avez déjà de ${store} reste à vous, et reste accessible.`,
  restingBuyerBody: (store) =>
    `Votre accès est conservé${S}: vous ne perdez rien de ce que vous avez de ${store}. Cette page rouvre au début du mois prochain, ou avant.`,
  restingOwner: `C'est votre boutique${S}? Votre studio explique pourquoi, et comment la rouvrir`,

  reviewsOf: (title) => `Avis sur ${title}`,
  backTo: (title) => `Retour à ${title}`,
  missingTitle: "Cette page n'est pas ici",
  missingBody: (store) => `Elle a peut-être été déplacée ou retirée. Tout ce que propose ${store} se trouve sur la page d'accueil de la boutique.`,
  noReviewsToShow: "Aucun avis à afficher.",
  pagesOfReviews: "Pages d'avis",
  newer: "Plus récents",
  older: "Plus anciens",
  askUnknown: (store) => `Cette page ne le précise pas. Posez la question à ${store} avant d'acheter.`,
  askTermsCut: () => "Je n'ai pas ici les conditions complètes. Posez la question au créateur avant d'acheter.",

  noLongerOnSale: "Ce produit n'est plus en vente.",
  cardUnread: "Impossible de charger ce produit pour le moment. Réessayez dans un instant.",
  cardBuyUnread: "L'achat n'est pas disponible pour le moment. Réessayez dans un instant.",
  seeStore: (store) => `Voir ${store}`,
  cardTestMode: `Mode test${S}: aucune vraie carte n'est débitée.`,
  cardCheckout: "Paiement sécurisé par Stripe, dans un nouvel onglet.",
  cardSoldBy: (store) => `Vendu par ${store}, qui en est responsable.`,
  cardOpens: (store) => `S'ouvre dans la boutique de ${store}, dans un nouvel onglet.`,

  // ---- Email cards (lib/mail-product-price.ts)
  orMore: (price) => `${price} ou plus`,
  plusTax: "+ taxes, le cas échéant",
  salePriceUntil: (price, when) => `Prix soldé${S}: ${price}, jusqu'au ${when}`,
};
