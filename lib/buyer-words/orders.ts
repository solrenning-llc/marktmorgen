/**
 * The words of a buyer getting back what they bought, in the store's language
 * (lib/store-language.ts): the "Get it again" page and its list of purchases
 * (app/[handle]/orders/page.tsx), the email that sends the link to it
 * (lib/buyer-orders.ts), the confirmation emailed after paying and after an
 * offer taken in one click (lib/purchase-email.ts), and what the download
 * route answers when it cannot hand a file over (app/api/store/download).
 *
 * Also the words of the two pieces the list shares with the thanks page: a
 * bundle's products (components/bundle-delivery.tsx) and a license key
 * (components/licence-key-box.tsx), which take them already said.
 *
 * Prices, dates and counts arrive already written in the store's language
 * (lib/buyer-words/index.ts, speech): a sentence here only places them.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

type Interval = "day" | "week" | "month" | "year";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** French takes the singular for 0 and 1. */
const pluralFr = (n: number, one: string, many: string) => (n < 2 ? one : many);
/** A non-breaking space: before "%", and in French before ":", "?", "!" and ";". */
const S = " ";

const en = {
  // ---- The page --------------------------------------------------------------
  pageTitle: "Your purchases",
  /** A buyer's library across every store (lib/buyer-library.ts), linked from the foot of the list. */
  libraryLink: "Bought from other creators on Marktmorgen too? See everything in one place",
  /** What a purchase depends on: the store staying open (lib/plan-closing.ts, since 18 October 2026). */
  whileOpen: "What you bought is here while this store is open on Marktmorgen. A store that closes takes it with it, so download the files you want to keep.",
  notices: {
    email: {
      title: "That does not look like an email address",
      body: "Check it and try again. Use the address you paid with: the one you typed at checkout.",
    },
    limited: {
      title: "Too many requests for now",
      body: "To keep this form from being used to flood somebody's inbox, it takes a limited number of requests an hour. Try again in an hour.",
    },
    unavailable: {
      title: "This store cannot look up purchases right now",
      body: "Its payments are not connected to Stripe right now. Try again later.",
    },
    error: {
      title: "Something went wrong on our side",
      body: "Nothing was changed. Try again in a moment.",
    },
    expired: {
      title: "This link has expired",
      body: "A link to your purchases works for 24 hours. Ask for a new one below; it takes a few seconds.",
    },
    busy: {
      title: "This store can't show your purchases right now",
      body: "What you bought is kept. Try again later. If your link has expired by then, ask for a new one below.",
    },
  } as Record<string, { title: string; body: string }>,

  // ---- Asking for the link -------------------------------------------------------
  getAgainTitle: "Get what you bought again",
  getAgainIntro: (store: string) =>
    `Lost a download, or got a new phone? Type the email you paid ${store} with, and we will email you a link to everything you bought here. No account and no password.`,
  cannotLookUp: (store: string) =>
    `${store} cannot take payments through Stripe right now, so there is nothing to look up from here. Try again later.`,
  emailYouPaidWith: "The email you paid with",
  emailMe: "Email me my purchases",
  formNote: (store: string) =>
    `If that address bought something from ${store}, we try to email a link to all of it. Any link sent works for 24 hours. We say the same thing whether or not it did, so nobody can use this page to find out who bought what.`,
  checkInbox: "Check your inbox",
  sentBody: (store: string) =>
    `If that address bought something from ${store}, a link is normally on its way. It comes from ${store} via Marktmorgen and can take a few minutes. If it is not there, look in spam.`,
  nothingArrived: "Nothing arrived? You may have paid with a different address: the one you typed at checkout. Try that one below. If it was the right one, try again later.",

  // ---- The list of purchases -------------------------------------------------------
  bookedCalls: (count: number): string => (count === 1 ? "Your booking" : "Your bookings"),
  /** What the store waits on from them: payment requests and agreements still open (lib/buyer-waiting.ts). */
  waiting: "Waiting for you",
  waitingMore: (n: number) => `And ${n} more. Open the email each one came in to see it.`,
  waitingUnread: "What is waiting for you could not be read just now. Try this page again in a moment.",
  /** Each link names what it opens, so two of them never read the same (WCAG 2.4.9). `due` is a date already said, or "". */
  openRequest: (amount: string, due: string): string => (due ? `Open the ${amount} payment request due ${due}` : `Open the ${amount} payment request`),
  openToSign: (title: string): string => `Read and sign “${title}”`,
  /** The heading over nothingToOpen (656 [WG16], components/empty-state.tsx). */
  nothingToOpenTitle: "Nothing to open here",
  nothingToOpen: (store: string) =>
    `There is nothing to open here anymore. A purchase that was refunded in full is no longer listed. If something is missing, reply to the order confirmation you were emailed when you paid, and it reaches ${store}.`,
  everythingSold: (store: string) =>
    `Everything ${store} sold to this address that can be opened again, newest first. Open or download any of it again whenever you need it.`,
  memberRunning: "Membership, still running",
  memberEnded: "Membership, ended",
  addedAfterPaying: "Added after paying",
  /** Whoever gave a gift without giving their name (lib/gifts.ts, giftFrom). */
  someone: "someone",
  /** `date` is empty when it is not known. */
  giftFrom: (name: string, date: string) => `A gift from ${name}${date ? `, on ${date}` : ""}`,
  placeFor: (date: string) => `A place somebody bought for you${date ? `, taken on ${date}` : ""}`,
  boughtWithPayPal: (date: string) => `Bought on ${date}, paid with PayPal`,
  broughtOver: (date: string) => `Brought over from another platform${date ? ` on ${date}` : ""}`,
  givenByStore: (store: string, date: string) => `Given to you by ${store}${date ? ` on ${date}` : ""}`,
  boughtOn: (date: string) => `Bought on ${date}`,
  endedNote:
    "This membership is no longer running, so what it gave you access to is closed now. Renew it and everything opens again right away.",
  /** The same, for a store that is not taking payments after a report: the first sentence alone. */
  endedClosedNote: "This membership is no longer running, so what it gave you access to is closed now.",
  renew: "Renew your membership",
  openCourse: "Open the course",
  /** How far the buyer is in a course on the list (560 [AS1]): lessons done of the lessons it has now. */
  lessonsDone: (done: number, total: number) => `${done} of ${total} ${plural(total, "lesson", "lessons")} done`,
  /** Said when that could not be read just now: never as 0 done. */
  progressUnread: "We could not check your progress in this course just now. Open the course to see where you are.",
  bookSession: (left: number) => `Book a session (${left} left)`,
  packageExpired: "The time to book this package's sessions has passed.",
  packageAllBooked: "Every session of this package is booked.",
  addPodcast: "Add the podcast to your app",
  /** Above what a price option includes besides its course or podcast. */
  alsoIn: (option: string) => `Also in ${option}`,
  openIt: "Open it",
  openTitle: (title: string) => `Open ${title}`,
  /** Where a link too long to show as text is kept: its host alone (lib/buyer-orders-rules.ts, LINK_SHOWN). */
  keptOn: (host: string, link: string) => `Kept on ${host}: ${link}`,
  keptAt: (host: string) => `Kept on ${host}`,
  downloadIt: "Download it",
  downloadTitle: (title: string) => `Download ${title}`,
  importedNote: (store: string) =>
    `${store} moved this here from the platform you bought it on. Nothing was charged here and there is no receipt from this store for it.`,
  reviewAll: "Review what you bought",
  reviewTitle: (title: string) => `Review ${title}`,
  worksFor24: "This page works for 24 hours from the email. After that, open it again and ask for a new link whenever you need one.",
  /** A package of calls on the list: "Coaching, 5 sessions". */
  packageTitle: (title: string, sessions: number) => `${title}, ${sessions} sessions`,

  // ---- A booked call -----------------------------------------------------------------
  callLength: (zone: string, minutes: number) => `${zone} · ${minutes} minutes`,
  /** What the button that opens a call's room says (lib/call-rooms.ts, roomKind). */
  roomLabels: { room: "Join the video room", meet: "Join on Google Meet", zoom: "Join on Zoom", other: "Join the call" } as Record<
    "room" | "meet" | "zoom" | "other",
    string
  >,
  videoRoomNote:
    "This is a private Jitsi Meet room (a free video service run by a third party). The first person to open it may be asked to sign in to Jitsi (with a Google account, for example) to start the meeting; everyone else joins without an account once it has started.",
  linkBeforeCall: (store: string) => `${store} sends you the link to join before the call.`,
  addToCalendar: "Add it to your calendar",
  moveCall: "Move it to another time",

  // ---- A bundle's products (components/bundle-delivery.tsx) ------------------------------
  insideTitle: (title: string) => `Inside ${title}`,
  whatIsInside: "What is inside",
  /** The button that starts a course; the confirmation email names it too. */
  startCourse: "Start the course",
  nothingAttached: (store: string) =>
    `This one has nothing attached right now. Reply to your order confirmation email to ask ${store} for it.`,
  bundleMissing: (count: number, store: string) =>
    `${count === 1 ? "One product" : `${count} products`} of this bundle ${count === 1 ? "is" : "are"} no longer in ${store}'s store, so there is nothing here to open for ${count === 1 ? "it" : "them"}. Reply to your order confirmation email and it reaches ${store}.`,
  /** The button that shows a bundle's products, read only when asked for (components/orders-bundle.tsx), and the one that hides them. */
  showInside: (title: string) => `Show the products in ${title}`,
  loadingInside: "Getting the products…",
  insideFailed: "These products could not be shown just now. Try again in a moment.",
  /** Purchases whose refund did not fit in the opening's calls to Stripe (lib/buyer-orders.ts, ORDERS_STRIPE_CALLS), and the button that checks the next batch (components/older-purchases.tsx). */
  olderNotChecked: (count: number, withAdded = false) =>
    count === 0
      ? "Anything added to an order after paying is not checked yet."
      : withAdded
        ? `${count === 1 ? "1 older purchase" : `${count} older purchases`} and anything added to an order after paying are not checked yet.`
        : count === 1
          ? "1 older purchase is not checked yet."
          : `${count} older purchases are not checked yet.`,
  checkOlder: "Check older purchases",
  checkingOlder: "Checking older purchases…",
  olderShown: (count: number) =>
    count === 0 ? "None of the purchases checked can be opened again." : count === 1 ? "1 more purchase is now on the list." : `${count} more purchases are now on the list.`,
  olderBatchShown: (count: number) => count === 0 ? "No purchases in this batch can be opened again." : count === 1 ? "This page shows 1 purchase from this batch." : `This page shows ${count} purchases from this batch.`,
  olderFailed: "Older purchases could not be checked just now. Try again in a moment.",
  /** The pages drawn without JavaScript (app/[handle]/orders/page.tsx): a bundle's products, or a batch of older purchases, and the way back. */
  backToList: "Back to all your purchases",
  olderTitle: "Older purchases",

  // ---- A license key (components/licence-key-box.tsx) ------------------------------------
  yourKey: "Your license key",
  yourKeyFor: (title: string) => `Your license key for ${title}`,
  copy: "Copy",
  copied: "Copied",
  keyRevoked: (store: string) =>
    `${store} has marked this key as no longer valid. If you think that is a mistake, reply to your order confirmation email and it reaches them.`,
  keyYours: "It is yours alone: nobody else is given this key. It is also in your confirmation email and on your list of purchases.",
  keyWaiting: (store: string) =>
    `Your payment went through just as ${store}'s keys ran out, so yours is not ready yet. They have been told, and it is emailed to you the moment they add more. It also appears here and on your list of purchases.`,
  keyNotShown: "Your key could not be shown just now. Refresh the page in a moment; it is kept for you.",

  // ---- The email with the link to the list (lib/buyer-orders.ts) ---------------------------
  /** The name the email comes from. */
  ordersFrom: (store: string) => `${store} via Marktmorgen`,
  ordersSubject: (store: string) => `What you bought from ${store}`,
  ordersIntro: (store: string, count: number, withAdded = false) =>
    withAdded
      ? count === 0
        ? `You asked for what you bought from ${store}. Your purchases are not checked yet; the page checks them when you ask:`
        : `You asked for what you bought from ${store}. ${count === 1 ? "Here is 1" : `Here are ${count}`}, ready to open again, and older purchases the page checks when you ask:`
      : `You asked for what you bought from ${store}. ${count === 1 ? "Here it is" : `Here are all ${count}`}, ready to open again:`,
  ordersLinkNote: "The link works for 24 hours, on any device. After that, ask again from the store and a new one comes right away.",
  ordersIgnore: "If you did not ask for this, ignore this email; nothing happens unless the link is opened.",
  ordersSentBy: (store: string) => `Sent by Marktmorgen on behalf of ${store}.`,
  chargedBrought: (store: string, withPaypal: boolean) =>
    `What you bought here was charged by ${store} ${withPaypal ? "on their own Stripe or PayPal account" : "on their own Stripe account"}; what ${store} brought over from another platform was not charged again.`,
  chargedAll: (store: string, withPaypal: boolean) =>
    `Every purchase was charged by ${store} ${withPaypal ? "on their own Stripe or PayPal account" : "on their own Stripe account"}.`,

  // ---- The confirmation after paying (lib/purchase-email.ts) ------------------------------
  confirmSubject: (store: string, title: string) => `Your order from ${store}: ${title}`,
  confirmIntro: (store: string) => `Thank you for buying from ${store}. This is your confirmation.`,
  /** `added` is what was ticked at checkout, already listed, or empty. */
  whatYouBought: (title: string, added: string) => `What you bought: ${title}${added ? `, with ${added}` : ""}`,
  /** Two titles, or a list and one more title, joined: "A and B". */
  and: (first: string, second: string) => `${first} and ${second}`,
  insideOf: (title: string, titles: string) => `Inside ${title}: ${titles}`,
  /** The heading of the creator's own note after paying, when they gave it none (lib/thanks-note.ts). */
  noteFrom: (name: string) => `A note from ${name}`,
  paid: (amount: string) => `Paid: ${amount}`,
  orderReference: (id: string) => `Order reference: ${id}`,
  planNote: (payments: number, isWeekly: boolean, left: number, store: string) =>
    `This was the first of ${payments} ${isWeekly ? "weekly" : "monthly"} payments. The other ${left} are charged to the same card on ${store}'s own Stripe account, and they stop by themselves after the last one.`,
  addPodcastAt: (url: string) => `Add the podcast to your app: ${url}`,
  podcastNote: (email: string) =>
    `Type ${email} on that page and a link to your own private feed comes right away. It works in Apple Podcasts, Overcast, Pocket Casts and most other podcast apps, for as long as you have it.`,
  startCourseAt: (url: string) => `Start the course: ${url}`,
  courseNote: (email: string) =>
    `If you pressed "Start the course" after paying, it opens right away on that device. Anywhere else, the course page asks for your email: type ${email} and request an email link that lets that device in. There is no password to make.`,
  openWhatYouBought: (url: string) => `Open what you bought: ${url}`,
  threeDays: (ordersUrl: string, email: string, store: string) =>
    `That page has your download or your link for the next 3 days. After that it is not lost: open ${ordersUrl}, type ${email}, and a link to everything you bought from ${store} is emailed to you, at any time.`,
  startTitleAt: (title: string, url: string) => `Start ${title}: ${url}`,
  bundleCourseNote: (email: string) =>
    `A course you started after paying opens right away on that device. Anywhere else, its page asks for your email: type ${email} and request an email link that lets that device in.`,
  /** `label` is yourKey or yourKeyFor. */
  keyIssued: (label: string, key: string) => `${label}: ${key}`,
  keyOnItsWay: (label: string, store: string) =>
    `${label}: on its way. ${store}'s keys ran out just as you paid; it is emailed to you the moment they add more.`,
  movedToday: (zero: string) => `${zero} today: your membership moved here.`,
  movedCharge: (price: string, hasTax: boolean, date: string) =>
    `Nothing was charged today. Your first payment here of ${price}${hasTax ? " plus any sales tax" : ""} is taken on ${date}, from the card you gave. Cancel before then and you are not charged at all.`,
  trialCharge: (price: string, hasTax: boolean, days: number, date: string) =>
    `Nothing was charged today. Your first payment of ${price}${hasTax ? " plus any sales tax" : ""} is taken when the ${days}-day trial ends, on ${date}, from the card you gave. Cancel before then and you are not charged at all.`,
  /** How a membership renews: for a set number of payments, or until cancelled (payments 0). */
  renews: (interval: Interval, payments: number) => {
    const every = { day: "a day", week: "a week", month: "a month", year: "a year" }[interval];
    return payments > 0
      ? `This renews once ${every} for ${payments} payments in all and then ends by itself.`
      : `This renews once ${every} until you cancel it.`;
  },
  manageAt: (hasEnd: boolean, url: string, email: string) =>
    `To manage or cancel it yourself${hasEnd ? " before that" : ""}, at any time and without writing to anyone, open ${url} and type ${email}.`,
  cancelByReply: (hasEnd: boolean, store: string) => `To cancel${hasEnd ? " before that" : ""}, reply to this email and it reaches ${store}.`,
  earnBySharing: (percent: number, store: string, url: string) =>
    `Earn ${percent}% by sharing ${store}: get your own link, without applying, at ${url}`,
  storeAt: (store: string, url: string) => `${store}: ${url}`,
  questions: (store: string) => `Questions about this order? Reply to this email and it reaches ${store}.`,
  paymentWent: (store: string) => `The payment went to ${store}, on their own Stripe account. Marktmorgen sent this email for them.`,
  /** "Paid: $0.00 today. …": `zero` is no money, written. */
  trialStarted: (zero: string, days: number) => `${zero} today. Your ${days}-day free trial has started.`,
  discountCovered: (zero: string) => `${zero}. A discount code covered the whole price.`,
  /** "$9 a month, 12 payments in all". */
  paymentsInAll: (every: string, payments: number) => `${every}, ${payments} payments in all`,
  /**
   * A membership whose discount came off the first charge: what was paid today and what each charge after it is,
   * from the checkout (lib/purchase-email.ts). `then` is null when that price does not read; `isOpenEnded` when how long
   * the discount keeps coming off could not be read, so it is never said to end or to go on.
   */
  discountToday: (now: string, then: string | null, hasTax: boolean, isOpenEnded: boolean) =>
    `${now} today, with your discount. ${then ? `Each charge after this one: ${then}` : "Each charge after this one is at the membership's regular price"}${hasTax ? " plus any sales tax" : ""}${isOpenEnded ? ", less your discount for as long as it lasts" : ""}.`,
  /** An introductory price with sales tax added on top: what was charged today, then the schedule. */
  introTaxed: (now: string, schedule: string) => `${now} today. The price: ${schedule}, plus any sales tax.`,

  // ---- The confirmation of an offer taken after paying -------------------------------------
  offerSubject: (store: string, title: string) => `Added to your order from ${store}: ${title}`,
  offerIntro: (store: string) => `You added something to your order from ${store}. This is your confirmation.`,
  whatYouAdded: (title: string) => `What you added: ${title}`,
  insideIt: (titles: string) => `Inside it: ${titles}`,
  paidOnce: (amount: string) => `Paid: ${amount}, charged once to the card you had just paid with`,
  reference: (id: string) => `Reference: ${id}`,
  openItAt: (url: string) => `Open it: ${url}`,
  offerThreeDays: (ordersUrl: string, email: string, store: string) =>
    `That page has it, beside what you bought first, for the next 3 days. After that it is not lost: open ${ordersUrl}, type ${email}, and a link to everything you bought from ${store} is emailed to you, at any time.`,
  /** On top of a confirmation sent again at the store's request. */
  copyNote: (store: string) => `${store} asked us to send you this again. It is a copy of your confirmation.`,

  // ---- What the download route answers when it hands nothing over ----------------------------
  downloadProblems: {
    unpaid: "This order has not been paid.",
    processing: "This payment is still being confirmed by the bank. Try again once it clears.",
    expired: "This download link has expired.",
    invalid: "We could not find this order.",
    unavailable: "This store cannot take payments yet.",
    error: "We could not check this order right now. Please try again.",
    refunded: "This order was refunded in full, so its download is closed.",
    purchaseCheckFailed: "We could not check this purchase right now. Please try again.",
    linkExpired: "This link has expired, or this purchase is not on it. Ask the store for a new link to your purchases.",
    nothingToDownload: "There is nothing to download on this one.",
    notADownloadPurchases: "This one is not a download. Open your purchases again and use the link on it.",
    notADownloadOrder: "This one is not a download. Open the order page again and use the link on it.",
    productNotADownload: "This product is not a download. Open the order page again and use the link on it.",
    gift: "This was a gift: it opens from the email sent to the person it is for.",
    group: "This was bought for several people: each one opens it from the link in the receipt.",
    nothingAdded: "This order has nothing added to it.",
    addedNoPart: "This added product has no such part.",
    addedRefunded: "This added product was refunded in full, so its download is closed.",
    noFile: "There is no file on this product.",
    addedToOrderNoPart: "The product added to this order has no such part.",
    noSuchProduct: "This order has no such product in it.",
    tooOften: "This link has been opened very many times in the last hour. Please try again in a little while.",
  },
};

export type OrdersWords = typeof en;

// ---- Spanish: "tú", for any Spanish-speaking buyer ------------------------------------------

const esOnce = (interval: Interval) => ({ day: "una vez al día", week: "una vez a la semana", month: "una vez al mes", year: "una vez al año" })[interval];
const esStart = "Empezar el curso";
const esWhere = (withPaypal: boolean) => (withPaypal ? "en su propia cuenta de Stripe o PayPal" : "en su propia cuenta de Stripe");

const es: OrdersWords = {
  pageTitle: "Tus compras",
  libraryLink: "¿También compraste a otros creadores en Marktmorgen? Míralo todo en un solo lugar",
  whileOpen: "Lo que compraste está aquí mientras esta tienda siga abierta en Marktmorgen. Si la tienda cierra, se va con ella: descarga los archivos que quieras conservar.",
  notices: {
    email: {
      title: "Eso no parece una dirección de email",
      body: "Revísala y vuelve a intentarlo. Usa la dirección con la que pagaste: la que escribiste al pagar.",
    },
    limited: {
      title: "Demasiadas solicitudes por ahora",
      body: "Para que nadie use este formulario para inundar la bandeja de entrada de otra persona, solo acepta un número limitado de solicitudes por hora. Vuelve a intentarlo dentro de una hora.",
    },
    unavailable: {
      title: "Esta tienda no puede buscar compras en este momento",
      body: "Sus pagos no están conectados a Stripe en este momento. Inténtalo de nuevo más tarde.",
    },
    error: {
      title: "Algo salió mal por nuestra parte",
      body: "No se cambió nada. Vuelve a intentarlo en un momento.",
    },
    expired: {
      title: "Este enlace ha caducado",
      body: "Un enlace a tus compras funciona durante 24 horas. Pide uno nuevo abajo; tarda unos segundos.",
    },
    busy: {
      title: "Esta tienda no puede mostrar tus compras ahora mismo",
      body: "Lo que compraste se conserva. Vuelve a intentarlo más tarde. Si para entonces tu enlace ha caducado, pide uno nuevo abajo.",
    },
  },

  getAgainTitle: "Vuelve a obtener lo que compraste",
  getAgainIntro: (store) =>
    `¿Perdiste una descarga o cambiaste de teléfono? Escribe el email con el que le pagaste a ${store} y te enviaremos por email un enlace a todo lo que compraste aquí. Sin cuenta y sin contraseña.`,
  cannotLookUp: (store) =>
    `${store} no puede recibir pagos a través de Stripe en este momento, así que desde aquí no hay nada que buscar. Inténtalo de nuevo más tarde.`,
  emailYouPaidWith: "El email con el que pagaste",
  emailMe: "Envíame mis compras por email",
  formNote: (store) =>
    `Si esa dirección le compró algo a ${store}, intentamos enviarle por email un enlace a todo ello. Cualquier enlace enviado funciona durante 24 horas. Decimos lo mismo tanto si compró como si no, para que nadie pueda usar esta página para averiguar quién compró qué.`,
  checkInbox: "Revisa tu bandeja de entrada",
  sentBody: (store) =>
    `Si esa dirección le compró algo a ${store}, normalmente el enlace va en camino. Llega de ${store} vía Marktmorgen y puede tardar unos minutos. Si no está, mira en la carpeta de spam.`,
  nothingArrived: "¿No te llegó nada? Puede que hayas pagado con otra dirección: la que escribiste al pagar. Prueba con esa abajo. Si era la correcta, inténtalo de nuevo más tarde.",

  bookedCalls: (count) => (count === 1 ? "Tu reserva" : "Tus reservas"),
  waiting: "Te espera",
  waitingMore: (n) => `Y ${n} más. Abre el correo con el que llegó cada uno para verlo.`,
  waitingUnread: "No pudimos leer ahora lo que te espera. Vuelve a abrir esta página en un momento.",
  openRequest: (amount, due) => (due ? `Abrir la solicitud de pago de ${amount} con vencimiento el ${due}` : `Abrir la solicitud de pago de ${amount}`),
  openToSign: (title) => `Leer y firmar «${title}»`,
  nothingToOpenTitle: "Nada que abrir aquí",
  nothingToOpen: (store) =>
    `Aquí ya no hay nada que abrir. Una compra reembolsada por completo deja de aparecer. Si falta algo, responde a la confirmación del pedido que te llegó por email cuando pagaste, y le llegará a ${store}.`,
  everythingSold: (store) =>
    `Todo lo que ${store} vendió a esta dirección y se puede volver a abrir, de lo más reciente a lo más antiguo. Ábrelo o descárgalo de nuevo siempre que lo necesites.`,
  memberRunning: "Membresía, sigue activa",
  memberEnded: "Membresía, terminada",
  addedAfterPaying: "Añadido después de pagar",
  someone: "alguien",
  giftFrom: (name, date) => `Un regalo de ${name}${date ? `, el ${date}` : ""}`,
  placeFor: (date) => `Una plaza que alguien compró para ti${date ? `, ocupada el ${date}` : ""}`,
  boughtWithPayPal: (date) => `Comprado el ${date}, pagado con PayPal`,
  broughtOver: (date) => `Traído desde otra plataforma${date ? ` el ${date}` : ""}`,
  givenByStore: (store, date) => `Te lo dio ${store}${date ? ` el ${date}` : ""}`,
  boughtOn: (date) => `Comprado el ${date}`,
  endedNote: "Esta membresía ya no está activa, así que lo que te daba acceso está cerrado ahora. Renuévala y todo se abre de nuevo al instante.",
  endedClosedNote: "Esta membresía ya no está activa, así que lo que te daba acceso está cerrado ahora.",
  renew: "Renueva tu membresía",
  openCourse: "Abrir el curso",
  lessonsDone: (done, total) => `${done} de ${total} ${plural(total, "lección completada", "lecciones completadas")}`,
  progressUnread: "No pudimos comprobar tu progreso en este curso en este momento. Abre el curso para ver por dónde vas.",
  bookSession: (left) => `Reservar una sesión (${left === 1 ? "queda 1" : `quedan ${left}`})`,
  packageExpired: "Ya pasó el plazo para reservar las sesiones de este paquete.",
  packageAllBooked: "Todas las sesiones de este paquete están reservadas.",
  addPodcast: "Añade el pódcast a tu app",
  alsoIn: (option) => `También incluido en ${option}`,
  openIt: "Abrirlo",
  openTitle: (title) => `Abrir ${title}`,
  keptOn: (host, link) => `Alojado en ${host}: ${link}`,
  keptAt: (host) => `Alojado en ${host}`,
  downloadIt: "Descargarlo",
  downloadTitle: (title) => `Descargar ${title}`,
  importedNote: (store) =>
    `${store} trajo esto aquí desde la plataforma donde lo compraste. Aquí no se cobró nada y no hay recibo de esta tienda por ello.`,
  reviewAll: "Escribe una reseña de lo que compraste",
  reviewTitle: (title) => `Escribe una reseña de ${title}`,
  worksFor24: "Esta página funciona durante 24 horas desde el email. Después, ábrela de nuevo y pide un enlace nuevo cuando lo necesites.",
  packageTitle: (title, sessions) => `${title}, ${sessions} ${plural(sessions, "sesión", "sesiones")}`,

  callLength: (zone, minutes) => `${zone} · ${minutes} ${plural(minutes, "minuto", "minutos")}`,
  roomLabels: { room: "Unirse a la sala de video", meet: "Unirse en Google Meet", zoom: "Unirse en Zoom", other: "Unirse a la llamada" },
  videoRoomNote:
    "Es una sala privada de Jitsi Meet (un servicio de video gratuito gestionado por un tercero). Puede que a la primera persona que la abra se le pida iniciar sesión en Jitsi (con una cuenta de Google, por ejemplo) para empezar la reunión; los demás se unen sin cuenta una vez que ha empezado.",
  linkBeforeCall: (store) => `${store} te envía el enlace para unirte antes de la llamada.`,
  addToCalendar: "Añadirla a tu calendario",
  moveCall: "Cambiarla a otra hora",

  insideTitle: (title) => `Contenido de ${title}`,
  whatIsInside: "Qué incluye",
  startCourse: esStart,
  nothingAttached: (store) =>
    `Este no tiene nada adjunto en este momento. Responde al email de confirmación de tu pedido para pedírselo a ${store}.`,
  bundleMissing: (count, store) =>
    count === 1
      ? `Un producto de este paquete ya no está en la tienda de ${store}, así que aquí no hay nada que abrir de él. Responde al email de confirmación de tu pedido y le llegará a ${store}.`
      : `${count} productos de este paquete ya no están en la tienda de ${store}, así que aquí no hay nada que abrir de ellos. Responde al email de confirmación de tu pedido y le llegará a ${store}.`,
  showInside: (title) => `Mostrar los productos de ${title}`,
  loadingInside: "Cargando los productos…",
  insideFailed: "No se han podido mostrar estos productos ahora. Inténtalo de nuevo en un momento.",
  olderNotChecked: (count, withAdded = false) =>
    count === 0
      ? "Aún falta comprobar lo que se añadió a un pedido después de pagar."
      : withAdded
        ? `Aún falta comprobar ${count === 1 ? "1 compra anterior" : `${count} compras anteriores`} y lo que se añadió a un pedido después de pagar.`
        : count === 1
          ? "1 compra anterior aún no está comprobada."
          : `${count} compras anteriores aún no están comprobadas.`,
  checkOlder: "Comprobar compras anteriores",
  checkingOlder: "Comprobando compras anteriores…",
  olderShown: (count) =>
    count === 0 ? "Ninguna de las compras comprobadas se puede volver a abrir." : count === 1 ? "1 compra más está ahora en la lista." : `${count} compras más están ahora en la lista.`,
  olderBatchShown: (count) => count === 0 ? "No se puede volver a abrir ninguna compra de este grupo." : count === 1 ? "Esta página muestra 1 compra de este grupo." : `Esta página muestra ${count} compras de este grupo.`,
  olderFailed: "No se han podido comprobar las compras anteriores ahora. Inténtalo de nuevo en un momento.",
  backToList: "Volver a todas tus compras",
  olderTitle: "Compras anteriores",

  yourKey: "Tu clave de licencia",
  yourKeyFor: (title) => `Tu clave de licencia de ${title}`,
  copy: "Copiar",
  copied: "Copiada",
  keyRevoked: (store) =>
    `${store} ha marcado esta clave como no válida. Si crees que es un error, responde al email de confirmación de tu pedido y le llegará a ${store}.`,
  keyYours: "Es solo tuya: nadie más recibe esta clave. También está en tu email de confirmación y en tu lista de compras.",
  keyWaiting: (store) =>
    `Tu pago se completó justo cuando a ${store} se le acabaron las claves, así que la tuya aún no está lista. Ya se le avisó, y te llegará por email en cuanto añada más. También aparecerá aquí y en tu lista de compras.`,
  keyNotShown: "Ahora mismo no se pudo mostrar tu clave. Actualiza la página en un momento; está guardada para ti.",

  ordersFrom: (store) => `${store} vía Marktmorgen`,
  ordersSubject: (store) => `Lo que le compraste a ${store}`,
  ordersIntro: (store, count, withAdded = false) =>
    withAdded
      ? count === 0
        ? `Pediste lo que le compraste a ${store}. Tus compras aún no están comprobadas; la página las comprueba cuando lo pidas:`
        : `Pediste lo que le compraste a ${store}. ${count === 1 ? "Aquí tienes 1 compra lista para abrirla de nuevo" : `Aquí tienes ${count} compras listas para abrirlas de nuevo`}, y compras anteriores que la página comprueba cuando lo pidas:`
      : `Pediste lo que le compraste a ${store}. ${count === 1 ? "Aquí lo tienes, listo para abrirlo de nuevo:" : `Aquí tienes tus ${count} compras, listas para abrirlas de nuevo:`}`,
  ordersLinkNote: "El enlace funciona durante 24 horas, en cualquier dispositivo. Después, vuelve a pedirlo desde la tienda y te llegará uno nuevo al instante.",
  ordersIgnore: "Si no lo pediste tú, ignora este email; no pasa nada a menos que se abra el enlace.",
  ordersSentBy: (store) => `Enviado por Marktmorgen en nombre de ${store}.`,
  chargedBrought: (store, withPaypal) =>
    `Lo que compraste aquí lo cobró ${store} ${esWhere(withPaypal)}; lo que ${store} trajo desde otra plataforma no se volvió a cobrar.`,
  chargedAll: (store, withPaypal) => `Todas las compras las cobró ${store} ${esWhere(withPaypal)}.`,

  confirmSubject: (store, title) => `Tu pedido de ${store}: ${title}`,
  confirmIntro: (store) => `Gracias por comprarle a ${store}. Esta es tu confirmación.`,
  whatYouBought: (title, added) => `Lo que compraste: ${title}${added ? `, con ${added}` : ""}`,
  // "y" becomes "e" before a word that starts with the sound of "i".
  and: (first, second) => `${first} ${/^h?[ií](?![aeoáéó])/i.test(second.trim()) ? "e" : "y"} ${second}`,
  insideOf: (title, titles) => `Contenido de ${title}: ${titles}`,
  noteFrom: (name) => `Una nota de ${name}`,
  paid: (amount) => `Pagado: ${amount}`,
  orderReference: (id) => `Referencia del pedido: ${id}`,
  planNote: (payments, isWeekly, left, store) =>
    `Este fue el primero de ${payments} pagos ${isWeekly ? "semanales" : "mensuales"}. ${
      left === 1
        ? `El otro pago se cobra a la misma tarjeta en la propia cuenta de Stripe de ${store}, y los cobros se detienen solos después de ese último.`
        : `Los otros ${left} se cobran a la misma tarjeta en la propia cuenta de Stripe de ${store}, y se detienen solos después del último.`
    }`,
  addPodcastAt: (url) => `Añade el pódcast a tu app: ${url}`,
  podcastNote: (email) =>
    `Escribe ${email} en esa página y al instante te llegará un enlace a tu propio feed privado. Funciona en Apple Podcasts, Overcast, Pocket Casts y la mayoría de las demás apps de pódcast, mientras lo tengas.`,
  startCourseAt: (url) => `Empieza el curso: ${url}`,
  courseNote: (email) =>
    `Si pulsaste «${esStart}» después de pagar, se abre al instante en ese dispositivo. En cualquier otro, la página del curso te pide tu email: escribe ${email} y pide por email un enlace que dé acceso a ese dispositivo. No hay contraseña que crear.`,
  openWhatYouBought: (url) => `Abre lo que compraste: ${url}`,
  threeDays: (ordersUrl, email, store) =>
    `Esa página tiene tu descarga o tu enlace durante los próximos 3 días. Después no se pierde: abre ${ordersUrl}, escribe ${email} y te enviaremos por email un enlace a todo lo que le compraste a ${store}, en cualquier momento.`,
  startTitleAt: (title, url) => `Empieza ${title}: ${url}`,
  bundleCourseNote: (email) =>
    `Un curso que empezaste después de pagar se abre al instante en ese dispositivo. En cualquier otro, su página te pide tu email: escribe ${email} y pide por email un enlace que dé acceso a ese dispositivo.`,
  keyIssued: (label, key) => `${label}: ${key}`,
  keyOnItsWay: (label, store) =>
    `${label}: en camino. A ${store} se le acabaron las claves justo cuando pagaste; te llegará por email en cuanto añada más.`,
  movedToday: (zero) => `${zero} hoy: tu membresía se trasladó aquí.`,
  movedCharge: (price, hasTax, date) =>
    `Hoy no se cobró nada. Tu primer pago aquí de ${price}${hasTax ? " más los impuestos sobre las ventas que correspondan" : ""} se cobra el ${date}, a la tarjeta que indicaste. Cancela antes y no se te cobrará nada.`,
  trialCharge: (price, hasTax, days, date) =>
    `Hoy no se cobró nada. Tu primer pago de ${price}${hasTax ? " más los impuestos sobre las ventas que correspondan" : ""} se cobra cuando termine la prueba de ${days} ${plural(days, "día", "días")}, el ${date}, a la tarjeta que indicaste. Cancela antes y no se te cobrará nada.`,
  renews: (interval, payments) =>
    payments > 0
      ? `Esta membresía se renueva ${esOnce(interval)} durante ${payments} ${plural(payments, "pago", "pagos")} en total y luego termina sola.`
      : `Esta membresía se renueva ${esOnce(interval)} hasta que la canceles.`,
  manageAt: (hasEnd, url, email) =>
    `Para gestionarla o cancelarla por tu cuenta${hasEnd ? " antes de que termine" : ""}, en cualquier momento y sin escribir a nadie, abre ${url} y escribe ${email}.`,
  cancelByReply: (hasEnd, store) => `Para cancelarla${hasEnd ? " antes de que termine" : ""}, responde a este email y le llegará a ${store}.`,
  earnBySharing: (percent, store, url) =>
    `Gana un ${percent}${S}% compartiendo ${store}: consigue tu propio enlace, sin tener que solicitarlo, en ${url}`,
  storeAt: (store, url) => `${store}: ${url}`,
  questions: (store) => `¿Preguntas sobre este pedido? Responde a este email y le llegará a ${store}.`,
  paymentWent: (store) => `El pago fue para ${store}, en su propia cuenta de Stripe. Marktmorgen envió este email en su nombre.`,
  trialStarted: (zero, days) => `${zero} hoy. Tu prueba gratuita de ${days} ${plural(days, "día", "días")} ha empezado.`,
  discountCovered: (zero) => `${zero}. Un código de descuento cubrió el precio completo.`,
  paymentsInAll: (every, payments) => `${every}, ${payments} ${plural(payments, "pago", "pagos")} en total`,
  discountToday: (now, then, hasTax, isOpenEnded) =>
    `${now} hoy, con tu descuento. ${then ? `Cada cobro después de este: ${then}` : "Cada cobro después de este es al precio habitual de la membresía"}${hasTax ? " más los impuestos sobre las ventas que correspondan" : ""}${isOpenEnded ? ", menos tu descuento mientras dure" : ""}.`,
  introTaxed: (now, schedule) => `${now} hoy. El precio: ${schedule}, más los impuestos sobre las ventas que correspondan.`,

  offerSubject: (store, title) => `Añadido a tu pedido de ${store}: ${title}`,
  offerIntro: (store) => `Añadiste algo a tu pedido de ${store}. Esta es tu confirmación.`,
  whatYouAdded: (title) => `Lo que añadiste: ${title}`,
  insideIt: (titles) => `Contenido: ${titles}`,
  paidOnce: (amount) => `Pagado: ${amount}, cobrado una sola vez a la tarjeta con la que acababas de pagar`,
  reference: (id) => `Referencia: ${id}`,
  openItAt: (url) => `Ábrelo: ${url}`,
  offerThreeDays: (ordersUrl, email, store) =>
    `Esa página lo tiene, junto a lo que compraste primero, durante los próximos 3 días. Después no se pierde: abre ${ordersUrl}, escribe ${email} y te enviaremos por email un enlace a todo lo que le compraste a ${store}, en cualquier momento.`,
  copyNote: (store) => `${store} nos pidió que te enviáramos esto de nuevo. Es una copia de tu confirmación.`,

  downloadProblems: {
    unpaid: "Este pedido no se ha pagado.",
    processing: "El banco todavía está confirmando este pago. Vuelve a intentarlo cuando se complete.",
    expired: "Este enlace de descarga ha caducado.",
    invalid: "No encontramos este pedido.",
    unavailable: "Esta tienda todavía no puede aceptar pagos.",
    error: "Ahora mismo no pudimos comprobar este pedido. Vuelve a intentarlo.",
    refunded: "Este pedido se reembolsó por completo, así que su descarga está cerrada.",
    purchaseCheckFailed: "Ahora mismo no pudimos comprobar esta compra. Vuelve a intentarlo.",
    linkExpired: "Este enlace ha caducado o esta compra no está en él. Pide a la tienda un enlace nuevo a tus compras.",
    nothingToDownload: "No hay nada que descargar en este.",
    notADownloadPurchases: "Esto no es una descarga. Vuelve a abrir tus compras y usa el enlace que aparece ahí.",
    notADownloadOrder: "Esto no es una descarga. Vuelve a abrir la página del pedido y usa el enlace que aparece ahí.",
    productNotADownload: "Este producto no es una descarga. Vuelve a abrir la página del pedido y usa el enlace que aparece ahí.",
    gift: "Esto fue un regalo: se abre desde el email enviado a la persona a quien va dirigido.",
    group: "Esto se compró para varias personas: cada una lo abre desde el enlace del recibo.",
    nothingAdded: "Este pedido no tiene nada añadido.",
    addedNoPart: "Este producto añadido no tiene esa parte.",
    addedRefunded: "Este producto añadido se reembolsó por completo, así que su descarga está cerrada.",
    noFile: "Este producto no tiene ningún archivo.",
    addedToOrderNoPart: "El producto añadido a este pedido no tiene esa parte.",
    noSuchProduct: "Este pedido no contiene ese producto.",
    tooOften: "Este enlace se ha abierto muchísimas veces en la última hora. Vuelve a intentarlo dentro de un rato.",
  },
};

// ---- French: "vous" ----------------------------------------------------------------------------

const frOnce = (interval: Interval) => ({ day: "une fois par jour", week: "une fois par semaine", month: "une fois par mois", year: "une fois par an" })[interval];
const frStart = "Commencer la formation";
const frWhere = (withPaypal: boolean) => (withPaypal ? "sur son propre compte Stripe ou PayPal" : "sur son propre compte Stripe");

const fr: OrdersWords = {
  pageTitle: "Vos achats",
  libraryLink: `Vous avez aussi acheté chez d'autres créateurs sur Marktmorgen${S}? Retrouvez tout au même endroit`,
  whileOpen: "Vos achats sont ici tant que cette boutique reste ouverte sur Marktmorgen. Une boutique qui ferme les emporte avec elle : téléchargez les fichiers que vous voulez garder.",
  notices: {
    email: {
      title: "Cette adresse e-mail ne semble pas valide",
      body: `Vérifiez-la et réessayez. Utilisez l'adresse avec laquelle vous avez payé${S}: celle que vous avez saisie lors du paiement.`,
    },
    limited: {
      title: "Trop de demandes pour le moment",
      body: "Pour éviter que ce formulaire serve à inonder la boîte de réception de quelqu'un, il n'accepte qu'un nombre limité de demandes par heure. Réessayez dans une heure.",
    },
    unavailable: {
      title: "Cette boutique ne peut pas rechercher d'achats pour le moment",
      body: "Ses paiements ne sont pas reliés à Stripe pour le moment. Réessayez plus tard.",
    },
    error: {
      title: "Un problème est survenu de notre côté",
      body: "Rien n'a été modifié. Réessayez dans un instant.",
    },
    expired: {
      title: "Ce lien a expiré",
      body: `Un lien vers vos achats est valable 24${S}heures. Demandez-en un nouveau ci-dessous${S}; cela ne prend que quelques secondes.`,
    },
    busy: {
      title: "Cette boutique ne peut pas afficher vos achats pour le moment",
      body: "Ce que vous avez acheté est conservé. Réessayez plus tard. Si votre lien a expiré d'ici là, demandez-en un nouveau ci-dessous.",
    },
  },

  getAgainTitle: "Récupérez ce que vous avez acheté",
  getAgainIntro: (store) =>
    `Vous avez perdu un téléchargement ou changé de téléphone${S}? Saisissez l'e-mail avec lequel vous avez payé ${store}, et nous vous enverrons par e-mail un lien vers tout ce que vous avez acheté ici. Sans compte ni mot de passe.`,
  cannotLookUp: (store) =>
    `${store} ne peut pas accepter de paiements via Stripe pour le moment, il n'y a donc rien à rechercher ici. Réessayez plus tard.`,
  emailYouPaidWith: "L'e-mail avec lequel vous avez payé",
  emailMe: "M'envoyer mes achats par e-mail",
  formNote: (store) =>
    `Si cette adresse a acheté quelque chose chez ${store}, nous essayons de lui envoyer par e-mail un lien vers tous ses achats. Tout lien envoyé reste valable 24${S}heures. Nous affichons le même message dans tous les cas, pour que personne ne puisse se servir de cette page pour savoir qui a acheté quoi.`,
  checkInbox: "Consultez votre boîte de réception",
  sentBody: (store) =>
    `Si cette adresse a acheté quelque chose chez ${store}, le lien est normalement en route. Il vient de ${store} via Marktmorgen et peut mettre quelques minutes. S'il n'y est pas, regardez dans les spams.`,
  nothingArrived: `Rien reçu${S}? Vous avez peut-être payé avec une autre adresse${S}: celle saisie lors du paiement. Essayez-la ci-dessous. Si c'était la bonne, réessayez plus tard.`,

  bookedCalls: (count) => (count < 2 ? "Votre réservation" : "Vos réservations"),
  waiting: "Ce qui vous attend",
  waitingMore: (n) => `Et ${n} de plus. Ouvrez l’e-mail par lequel chacun est arrivé pour le voir.`,
  waitingUnread: "Ce qui vous attend n’a pas pu être lu pour le moment. Rouvrez cette page dans un instant.",
  openRequest: (amount, due) => (due ? `Ouvrir la demande de paiement de ${amount} à régler le ${due}` : `Ouvrir la demande de paiement de ${amount}`),
  openToSign: (title) => `Lire et signer «${S}${title}${S}»`,
  nothingToOpenTitle: "Rien à ouvrir ici",
  nothingToOpen: (store) =>
    `Il n'y a plus rien à ouvrir ici. Un achat remboursé en totalité n'apparaît plus. S'il manque quelque chose, répondez à la confirmation de commande reçue par e-mail lors de votre paiement, et votre message parviendra à ${store}.`,
  everythingSold: (store) =>
    `Tout ce que ${store} a vendu à cette adresse et qui peut être rouvert, du plus récent au plus ancien. Ouvrez-le ou téléchargez-le de nouveau dès que vous en avez besoin.`,
  memberRunning: "Abonnement, toujours actif",
  memberEnded: "Abonnement, terminé",
  addedAfterPaying: "Ajouté après le paiement",
  someone: "quelqu'un",
  giftFrom: (name, date) => `Un cadeau de ${name}${date ? `, le ${date}` : ""}`,
  placeFor: (date) => `Une place achetée pour vous par quelqu'un${date ? `, prise le ${date}` : ""}`,
  boughtWithPayPal: (date) => `Acheté le ${date}, payé avec PayPal`,
  broughtOver: (date) => `Transféré depuis une autre plateforme${date ? ` le ${date}` : ""}`,
  givenByStore: (store, date) => `Offert par ${store}${date ? ` le ${date}` : ""}`,
  boughtOn: (date) => `Acheté le ${date}`,
  endedNote: "Cet abonnement n'est plus actif, l'accès qu'il vous donnait est donc fermé. Renouvelez-le et tout s'ouvre de nouveau immédiatement.",
  endedClosedNote: "Cet abonnement n'est plus actif, l'accès qu'il vous donnait est donc fermé.",
  renew: "Renouveler votre abonnement",
  openCourse: "Ouvrir la formation",
  lessonsDone: (done, total) => `${done} ${pluralFr(done, "leçon terminée", "leçons terminées")} sur ${total}`,
  progressUnread: "Nous n'avons pas pu vérifier votre progression dans cette formation pour le moment. Ouvrez la formation pour voir où vous en êtes.",
  bookSession: (left) => `Réserver une séance (${left}${S}${pluralFr(left, "restante", "restantes")})`,
  packageExpired: "Le délai pour réserver les séances de ce forfait est dépassé.",
  packageAllBooked: "Toutes les séances de ce forfait sont réservées.",
  addPodcast: "Ajouter le podcast à votre application",
  alsoIn: (option) => `Également inclus dans ${option}`,
  openIt: "L'ouvrir",
  openTitle: (title) => `Ouvrir ${title}`,
  keptOn: (host, link) => `Hébergé sur ${host}${S}: ${link}`,
  keptAt: (host) => `Hébergé sur ${host}`,
  downloadIt: "Le télécharger",
  downloadTitle: (title) => `Télécharger ${title}`,
  importedNote: (store) =>
    `${store} a transféré cet achat ici depuis la plateforme où vous l'avez fait. Rien n'a été débité ici et cette boutique n'a émis aucun reçu pour lui.`,
  reviewAll: "Donner votre avis sur vos achats",
  reviewTitle: (title) => `Donner votre avis sur ${title}`,
  worksFor24: `Cette page est valable 24${S}heures à partir de l'e-mail. Ensuite, rouvrez-la et demandez un nouveau lien chaque fois que vous en avez besoin.`,
  packageTitle: (title, sessions) => `${title}, ${sessions}${S}${pluralFr(sessions, "séance", "séances")}`,

  callLength: (zone, minutes) => `${zone} · ${minutes}${S}${pluralFr(minutes, "minute", "minutes")}`,
  roomLabels: { room: "Rejoindre la salle vidéo", meet: "Rejoindre sur Google Meet", zoom: "Rejoindre sur Zoom", other: "Rejoindre l'appel" },
  videoRoomNote: `Il s'agit d'une salle Jitsi Meet privée (un service de vidéo gratuit géré par un tiers). La première personne qui l'ouvre peut devoir se connecter à Jitsi (avec un compte Google, par exemple) pour lancer la réunion${S}; les autres la rejoignent sans compte une fois qu'elle a commencé.`,
  linkBeforeCall: (store) => `${store} vous envoie le lien pour rejoindre l'appel avant qu'il commence.`,
  addToCalendar: "L'ajouter à votre agenda",
  moveCall: "Le déplacer à un autre horaire",

  insideTitle: (title) => `Contenu de ${title}`,
  whatIsInside: "Contenu",
  startCourse: frStart,
  nothingAttached: (store) =>
    `Rien n'y est joint pour le moment. Répondez à l'e-mail de confirmation de votre commande pour le demander à ${store}.`,
  bundleMissing: (count, store) =>
    count < 2
      ? `Un produit de ce lot n'est plus dans la boutique de ${store}, il n'y a donc rien à ouvrir ici pour lui. Répondez à l'e-mail de confirmation de votre commande et votre message parviendra à ${store}.`
      : `${count}${S}produits de ce lot ne sont plus dans la boutique de ${store}, il n'y a donc rien à ouvrir ici pour eux. Répondez à l'e-mail de confirmation de votre commande et votre message parviendra à ${store}.`,
  showInside: (title) => `Afficher les produits de ${title}`,
  loadingInside: "Chargement des produits…",
  insideFailed: "Ces produits ne peuvent pas être affichés pour le moment. Réessayez dans un instant.",
  olderNotChecked: (count, withAdded = false) =>
    count === 0
      ? "Ce qui a été ajouté à une commande après le paiement n'est pas encore vérifié."
      : withAdded
        ? `${count < 2 ? "1 achat plus ancien" : `${count}${S}achats plus anciens`} et ce qui a été ajouté à une commande après le paiement ne sont pas encore vérifiés.`
        : count < 2
          ? "1 achat plus ancien n'est pas encore vérifié."
          : `${count}${S}achats plus anciens ne sont pas encore vérifiés.`,
  checkOlder: "Vérifier les achats plus anciens",
  checkingOlder: "Vérification des achats plus anciens…",
  olderShown: (count) =>
    count === 0 ? "Aucun des achats vérifiés ne peut être rouvert." : count < 2 ? "1 achat de plus figure maintenant dans la liste." : `${count}${S}achats de plus figurent maintenant dans la liste.`,
  olderBatchShown: (count) => count === 0 ? "Aucun achat de ce groupe ne peut être rouvert." : count === 1 ? "Cette page présente 1 achat de ce groupe." : `Cette page présente ${count} achats de ce groupe.`,
  olderFailed: "Les achats plus anciens ne peuvent pas être vérifiés pour le moment. Réessayez dans un instant.",
  backToList: "Retour à tous vos achats",
  olderTitle: "Achats plus anciens",

  yourKey: "Votre clé de licence",
  yourKeyFor: (title) => `Votre clé de licence pour ${title}`,
  copy: "Copier",
  copied: "Copiée",
  keyRevoked: (store) =>
    `${store} a indiqué que cette clé n'est plus valable. Si vous pensez qu'il s'agit d'une erreur, répondez à l'e-mail de confirmation de votre commande et votre message parviendra à ${store}.`,
  keyYours: `Elle n'appartient qu'à vous${S}: personne d'autre ne reçoit cette clé. Elle figure aussi dans votre e-mail de confirmation et dans votre liste d'achats.`,
  keyWaiting: (store) =>
    `Votre paiement a abouti juste au moment où ${store} n'avait plus de clés, la vôtre n'est donc pas encore prête. L'information a été transmise, et votre clé vous sera envoyée par e-mail dès que de nouvelles clés seront ajoutées. Elle apparaîtra aussi ici et dans votre liste d'achats.`,
  keyNotShown: `Votre clé n'a pas pu être affichée pour le moment. Actualisez la page dans un instant${S}; elle est conservée pour vous.`,

  ordersFrom: (store) => `${store} via Marktmorgen`,
  ordersSubject: (store) => `Ce que vous avez acheté chez ${store}`,
  ordersIntro: (store, count, withAdded = false) =>
    withAdded
      ? count === 0
        ? `Vous avez demandé ce que vous avez acheté chez ${store}. Vos achats ne sont pas encore vérifiés${S}; la page les vérifie quand vous le demandez${S}:`
        : `Vous avez demandé ce que vous avez acheté chez ${store}. ${count < 2 ? "En voici 1, prêt à être rouvert" : `En voici ${count}, prêts à être rouverts`}, et des achats plus anciens que la page vérifie quand vous le demandez${S}:`
      : `Vous avez demandé ce que vous avez acheté chez ${store}. ${count < 2 ? "Le voici, prêt à être rouvert" : `Voici vos ${count}${S}achats, prêts à être rouverts`}${S}:`,
  ordersLinkNote: `Le lien est valable 24${S}heures, sur n'importe quel appareil. Ensuite, faites une nouvelle demande depuis la boutique et un nouveau lien arrive aussitôt.`,
  ordersIgnore: `Si vous n'avez rien demandé, ignorez cet e-mail${S}; rien ne se passe tant que le lien n'est pas ouvert.`,
  ordersSentBy: (store) => `Envoyé par Marktmorgen pour le compte de ${store}.`,
  chargedBrought: (store, withPaypal) =>
    `Ce que vous avez acheté ici a été débité par ${store} ${frWhere(withPaypal)}${S}; ce que ${store} a transféré depuis une autre plateforme n'a pas été débité à nouveau.`,
  chargedAll: (store, withPaypal) => `Chaque achat a été débité par ${store} ${frWhere(withPaypal)}.`,

  confirmSubject: (store, title) => `Votre commande chez ${store}${S}: ${title}`,
  confirmIntro: (store) => `Merci pour votre achat chez ${store}. Voici votre confirmation.`,
  whatYouBought: (title, added) => `Votre achat${S}: ${title}${added ? `, avec ${added}` : ""}`,
  and: (first, second) => `${first} et ${second}`,
  insideOf: (title, titles) => `Contenu de ${title}${S}: ${titles}`,
  noteFrom: (name) => `Un mot de ${name}`,
  paid: (amount) => `Payé${S}: ${amount}`,
  orderReference: (id) => `Référence de commande${S}: ${id}`,
  planNote: (payments, isWeekly, left, store) =>
    `Il s'agissait du premier de ${payments}${S}paiements ${isWeekly ? "hebdomadaires" : "mensuels"}. ${
      left < 2
        ? `Le paiement restant est débité sur la même carte, sur le propre compte Stripe de ${store}, et les prélèvements s'arrêtent d'eux-mêmes après celui-ci.`
        : `Les ${left}${S}autres sont débités sur la même carte, sur le propre compte Stripe de ${store}, et s'arrêtent d'eux-mêmes après le dernier.`
    }`,
  addPodcastAt: (url) => `Ajoutez le podcast à votre application${S}: ${url}`,
  podcastNote: (email) =>
    `Saisissez ${email} sur cette page et un lien vers votre propre flux privé arrive aussitôt. Il fonctionne dans Apple Podcasts, Overcast, Pocket Casts et la plupart des autres applications de podcasts, aussi longtemps que vous l'avez.`,
  startCourseAt: (url) => `Commencez la formation${S}: ${url}`,
  courseNote: (email) =>
    `Si vous avez cliqué sur «${S}${frStart}${S}» après le paiement, elle s'ouvre immédiatement sur cet appareil. Ailleurs, la page de la formation vous demande votre e-mail${S}: saisissez ${email} et demandez par e-mail un lien qui donne accès à cet appareil. Aucun mot de passe à créer.`,
  openWhatYouBought: (url) => `Ouvrez votre achat${S}: ${url}`,
  threeDays: (ordersUrl, email, store) =>
    `Cette page contient votre téléchargement ou votre lien pendant les 3${S}prochains jours. Ensuite, rien n'est perdu${S}: ouvrez ${ordersUrl}, saisissez ${email}, et un lien vers tout ce que vous avez acheté chez ${store} vous est envoyé par e-mail, à tout moment.`,
  startTitleAt: (title, url) => `Commencez ${title}${S}: ${url}`,
  bundleCourseNote: (email) =>
    `Une formation commencée après le paiement s'ouvre immédiatement sur cet appareil. Ailleurs, sa page vous demande votre e-mail${S}: saisissez ${email} et demandez par e-mail un lien qui donne accès à cet appareil.`,
  keyIssued: (label, key) => `${label}${S}: ${key}`,
  keyOnItsWay: (label, store) =>
    `${label}${S}: en route. ${store} n'avait plus de clés au moment de votre paiement${S}; elle vous sera envoyée par e-mail dès que de nouvelles clés seront ajoutées.`,
  movedToday: (zero) => `${zero} aujourd'hui. Votre abonnement a été transféré ici.`,
  movedCharge: (price, hasTax, date) =>
    `Rien n'a été débité aujourd'hui. Votre premier paiement ici, de ${price}${hasTax ? ", plus les éventuelles taxes de vente," : ""} est prélevé le ${date}, sur la carte que vous avez indiquée. Annulez avant cette date et rien ne vous sera débité.`,
  trialCharge: (price, hasTax, days, date) =>
    `Rien n'a été débité aujourd'hui. Votre premier paiement de ${price}${hasTax ? ", plus les éventuelles taxes de vente," : ""} est prélevé à la fin de l'essai de ${days}${S}${pluralFr(days, "jour", "jours")}, le ${date}, sur la carte que vous avez indiquée. Annulez avant cette date et rien ne vous sera débité.`,
  renews: (interval, payments) =>
    payments > 0
      ? `Cet abonnement se renouvelle ${frOnce(interval)} pendant ${payments}${S}${pluralFr(payments, "paiement", "paiements")} au total, puis prend fin de lui-même.`
      : `Cet abonnement se renouvelle ${frOnce(interval)} jusqu'à ce que vous l'annuliez.`,
  manageAt: (hasEnd, url, email) =>
    `Pour le gérer ou l'annuler vous-même${hasEnd ? " d'ici là" : ""}, à tout moment et sans écrire à personne, ouvrez ${url} et saisissez ${email}.`,
  cancelByReply: (hasEnd, store) => `Pour l'annuler${hasEnd ? " d'ici là" : ""}, répondez à cet e-mail et votre message parviendra à ${store}.`,
  earnBySharing: (percent, store, url) =>
    `Gagnez ${percent}${S}% en partageant ${store}${S}: obtenez votre propre lien, sans candidature, sur ${url}`,
  storeAt: (store, url) => `${store}${S}: ${url}`,
  questions: (store) => `Une question sur cette commande${S}? Répondez à cet e-mail et votre message parviendra à ${store}.`,
  paymentWent: (store) => `Le paiement a été versé à ${store}, sur son propre compte Stripe. Marktmorgen a envoyé cet e-mail pour son compte.`,
  trialStarted: (zero, days) => `${zero} aujourd'hui. Votre essai gratuit de ${days}${S}${pluralFr(days, "jour", "jours")} a commencé.`,
  discountCovered: (zero) => `${zero}. Un code de réduction a couvert la totalité du prix.`,
  paymentsInAll: (every, payments) => `${every}, ${payments}${S}${pluralFr(payments, "paiement", "paiements")} au total`,
  discountToday: (now, then, hasTax, isOpenEnded) =>
    `${now} aujourd'hui, avec votre réduction. ${then ? `Chaque paiement suivant${S}: ${then}` : "Chaque paiement suivant est au prix habituel de l'abonnement"}${hasTax ? ", plus les éventuelles taxes de vente" : ""}${isOpenEnded ? ", moins votre réduction tant qu'elle s'applique" : ""}.`,
  introTaxed: (now, schedule) => `${now} aujourd'hui. Le prix${S}: ${schedule}, plus les éventuelles taxes de vente.`,

  offerSubject: (store, title) => `Ajouté à votre commande chez ${store}${S}: ${title}`,
  offerIntro: (store) => `Vous avez ajouté quelque chose à votre commande chez ${store}. Voici votre confirmation.`,
  whatYouAdded: (title) => `Votre ajout${S}: ${title}`,
  insideIt: (titles) => `Contenu${S}: ${titles}`,
  paidOnce: (amount) => `Payé${S}: ${amount}, débité une seule fois sur la carte avec laquelle vous veniez de payer`,
  reference: (id) => `Référence${S}: ${id}`,
  openItAt: (url) => `L'ouvrir${S}: ${url}`,
  offerThreeDays: (ordersUrl, email, store) =>
    `Cette page le contient, à côté de votre premier achat, pendant les 3${S}prochains jours. Ensuite, rien n'est perdu${S}: ouvrez ${ordersUrl}, saisissez ${email}, et un lien vers tout ce que vous avez acheté chez ${store} vous est envoyé par e-mail, à tout moment.`,
  copyNote: (store) => `${store} nous a demandé de vous renvoyer ceci. C'est une copie de votre confirmation.`,

  downloadProblems: {
    unpaid: "Cette commande n'a pas été payée.",
    processing: "Ce paiement est encore en cours de confirmation par la banque. Réessayez une fois qu'il sera validé.",
    expired: "Ce lien de téléchargement a expiré.",
    invalid: "Nous n'avons pas trouvé cette commande.",
    unavailable: "Cette boutique ne peut pas encore accepter de paiements.",
    error: "Nous n'avons pas pu vérifier cette commande pour le moment. Veuillez réessayer.",
    refunded: "Cette commande a été remboursée en totalité, son téléchargement est donc fermé.",
    purchaseCheckFailed: "Nous n'avons pas pu vérifier cet achat pour le moment. Veuillez réessayer.",
    linkExpired: "Ce lien a expiré, ou cet achat n'y figure pas. Demandez à la boutique un nouveau lien vers vos achats.",
    nothingToDownload: "Il n'y a rien à télécharger pour celui-ci.",
    notADownloadPurchases: "Ceci n'est pas un téléchargement. Rouvrez vos achats et utilisez le lien indiqué.",
    notADownloadOrder: "Ceci n'est pas un téléchargement. Rouvrez la page de la commande et utilisez le lien indiqué.",
    productNotADownload: "Ce produit n'est pas un téléchargement. Rouvrez la page de la commande et utilisez le lien indiqué.",
    gift: `C'était un cadeau${S}: il s'ouvre depuis l'e-mail envoyé à la personne à qui il est destiné.`,
    group: `Cet achat a été fait pour plusieurs personnes${S}: chacune l'ouvre depuis le lien figurant dans le reçu.`,
    nothingAdded: "Rien n'a été ajouté à cette commande.",
    addedNoPart: "Ce produit ajouté ne contient pas cet élément.",
    addedRefunded: "Ce produit ajouté a été remboursé en totalité, son téléchargement est donc fermé.",
    noFile: "Ce produit n'a aucun fichier.",
    addedToOrderNoPart: "Le produit ajouté à cette commande ne contient pas cet élément.",
    noSuchProduct: "Cette commande ne contient pas ce produit.",
    tooOften: "Ce lien a été ouvert un très grand nombre de fois dans la dernière heure. Réessayez dans un moment.",
  },
};

// ---- German: "Sie" ------------------------------------------------------------------------------

const deOnce = (interval: Interval) => ({ day: "einmal täglich", week: "einmal pro Woche", month: "einmal im Monat", year: "einmal im Jahr" })[interval];
const deStart = "Kurs starten";
const deWhere = (withPaypal: boolean) => (withPaypal ? "über das eigene Stripe- oder PayPal-Konto" : "über das eigene Stripe-Konto");

const de: OrdersWords = {
  pageTitle: "Ihre Käufe",
  libraryLink: "Auch bei anderen Creators auf Marktmorgen gekauft? Alles an einem Ort",
  whileOpen: "Was Sie gekauft haben, finden Sie hier, solange dieser Shop auf Marktmorgen geöffnet ist. Schließt der Shop, verschwindet es mit ihm: Laden Sie die Dateien herunter, die Sie behalten möchten.",
  notices: {
    email: {
      title: "Das sieht nicht nach einer E-Mail-Adresse aus",
      body: "Prüfen Sie sie und versuchen Sie es erneut. Verwenden Sie die Adresse, mit der Sie bezahlt haben: die, die Sie beim Bezahlen eingegeben haben.",
    },
    limited: {
      title: "Vorerst zu viele Anfragen",
      body: "Damit dieses Formular nicht genutzt werden kann, um jemandes Posteingang zu überfluten, nimmt es nur eine begrenzte Zahl von Anfragen pro Stunde an. Versuchen Sie es in einer Stunde erneut.",
    },
    unavailable: {
      title: "Dieser Shop kann gerade keine Käufe nachschlagen",
      body: "Seine Zahlungen sind gerade nicht mit Stripe verbunden. Versuchen Sie es später noch einmal.",
    },
    error: {
      title: "Bei uns ist etwas schiefgelaufen",
      body: "Es wurde nichts geändert. Versuchen Sie es gleich noch einmal.",
    },
    expired: {
      title: "Dieser Link ist abgelaufen",
      body: "Ein Link zu Ihren Käufen gilt 24 Stunden. Fordern Sie unten einen neuen an; das dauert nur ein paar Sekunden.",
    },
    busy: {
      title: "Dieser Shop kann Ihre Käufe gerade nicht anzeigen",
      body: "Was Sie gekauft haben, bleibt erhalten. Versuchen Sie es später noch einmal. Wenn Ihr Link bis dahin abgelaufen ist, fordern Sie unten einen neuen an.",
    },
  },

  getAgainTitle: "Ihre Käufe erneut abrufen",
  getAgainIntro: (store) =>
    `Einen Download verloren oder ein neues Handy? Geben Sie die E-Mail-Adresse ein, mit der Sie bei ${store} bezahlt haben, und wir schicken Ihnen per E-Mail einen Link zu allem, was Sie hier gekauft haben. Ohne Konto und ohne Passwort.`,
  cannotLookUp: (store) =>
    `${store} kann gerade keine Zahlungen über Stripe annehmen, daher gibt es hier nichts nachzuschlagen. Versuchen Sie es später noch einmal.`,
  emailYouPaidWith: "Die E-Mail-Adresse, mit der Sie bezahlt haben",
  emailMe: "Meine Käufe per E-Mail senden",
  formNote: (store) =>
    `Wenn mit dieser Adresse etwas bei ${store} gekauft wurde, versuchen wir, per E-Mail einen Link zu allem zu senden. Jeder gesendete Link gilt 24 Stunden. Wir sagen dasselbe, ob das der Fall ist oder nicht, damit niemand über diese Seite herausfinden kann, wer was gekauft hat.`,
  checkInbox: "Sehen Sie in Ihrem Posteingang nach",
  sentBody: (store) =>
    `Wenn mit dieser Adresse etwas bei ${store} gekauft wurde, ist der Link normalerweise unterwegs. Er kommt von ${store} über Marktmorgen und kann ein paar Minuten dauern. Wenn er nicht da ist, sehen Sie im Spam-Ordner nach.`,
  nothingArrived: "Nichts angekommen? Vielleicht haben Sie mit einer anderen Adresse bezahlt: der, die Sie beim Bezahlen eingegeben haben. Versuchen Sie es unten mit dieser. Wenn es die richtige war, versuchen Sie es später noch einmal.",

  bookedCalls: (count) => (count === 1 ? "Ihre Buchung" : "Ihre Buchungen"),
  waiting: "Wartet auf Sie",
  waitingMore: (n) => `Und ${n} weitere. Öffnen Sie die E-Mail, mit der jeweils eines kam, um es zu sehen.`,
  waitingUnread: "Was auf Sie wartet, konnte gerade nicht gelesen werden. Öffnen Sie diese Seite gleich noch einmal.",
  openRequest: (amount, due) => (due ? `Zahlungsanfrage über ${amount}, fällig am ${due}, öffnen` : `Zahlungsanfrage über ${amount} öffnen`),
  openToSign: (title) => `„${title}“ lesen und unterschreiben`,
  nothingToOpenTitle: "Hier gibt es nichts zu öffnen",
  nothingToOpen: (store) =>
    `Hier gibt es nichts mehr zu öffnen. Ein vollständig erstatteter Kauf wird nicht mehr aufgeführt. Wenn etwas fehlt, antworten Sie auf die Bestellbestätigung, die Sie beim Bezahlen per E-Mail erhalten haben, dann erreicht Ihre Nachricht ${store}.`,
  everythingSold: (store) =>
    `Alles, was ${store} an diese Adresse verkauft hat und erneut geöffnet werden kann, das Neueste zuerst. Öffnen oder laden Sie es jederzeit erneut herunter, wenn Sie es brauchen.`,
  memberRunning: "Mitgliedschaft, läuft noch",
  memberEnded: "Mitgliedschaft, beendet",
  addedAfterPaying: "Nach dem Bezahlen hinzugefügt",
  someone: "jemandem",
  giftFrom: (name, date) => `Ein Geschenk von ${name}${date ? `, am ${date}` : ""}`,
  placeFor: (date) => `Ein Platz, den jemand für Sie gekauft hat${date ? `, eingenommen am ${date}` : ""}`,
  boughtWithPayPal: (date) => `Gekauft am ${date}, bezahlt mit PayPal`,
  broughtOver: (date) => `Von einer anderen Plattform übernommen${date ? ` am ${date}` : ""}`,
  givenByStore: (store, date) => `Von ${store} erhalten${date ? ` am ${date}` : ""}`,
  boughtOn: (date) => `Gekauft am ${date}`,
  endedNote: "Diese Mitgliedschaft läuft nicht mehr, daher ist der Zugang, den sie Ihnen gab, jetzt geschlossen. Verlängern Sie sie, und alles ist sofort wieder offen.",
  endedClosedNote: "Diese Mitgliedschaft läuft nicht mehr, daher ist der Zugang, den sie Ihnen gab, jetzt geschlossen.",
  renew: "Mitgliedschaft verlängern",
  openCourse: "Kurs öffnen",
  lessonsDone: (done, total) => `${done} von ${total} ${plural(total, "Lektion", "Lektionen")} erledigt`,
  progressUnread: "Wir konnten Ihren Fortschritt in diesem Kurs gerade nicht prüfen. Öffnen Sie den Kurs, um zu sehen, wo Sie stehen.",
  bookSession: (left) => `Termin buchen (noch ${left} übrig)`,
  packageExpired: "Die Frist, um die Termine dieses Pakets zu buchen, ist abgelaufen.",
  packageAllBooked: "Alle Termine dieses Pakets sind gebucht.",
  addPodcast: "Podcast zu Ihrer App hinzufügen",
  alsoIn: (option) => `Ebenfalls in ${option} enthalten`,
  openIt: "Öffnen",
  openTitle: (title) => `${title} öffnen`,
  keptOn: (host, link) => `Gespeichert auf ${host}: ${link}`,
  keptAt: (host) => `Gespeichert auf ${host}`,
  downloadIt: "Herunterladen",
  downloadTitle: (title) => `${title} herunterladen`,
  importedNote: (store) =>
    `${store} hat dies von der Plattform, auf der Sie es gekauft haben, hierher übertragen. Hier wurde nichts berechnet, und es gibt von diesem Shop keine Quittung dafür.`,
  reviewAll: "Ihren Kauf bewerten",
  reviewTitle: (title) => `${title} bewerten`,
  worksFor24: "Diese Seite gilt 24 Stunden ab der E-Mail. Danach öffnen Sie sie erneut und fordern einen neuen Link an, wann immer Sie einen brauchen.",
  packageTitle: (title, sessions) => `${title}, ${sessions} ${plural(sessions, "Termin", "Termine")}`,

  callLength: (zone, minutes) => `${zone} · ${minutes} ${plural(minutes, "Minute", "Minuten")}`,
  roomLabels: { room: "Videoraum betreten", meet: "Über Google Meet teilnehmen", zoom: "Über Zoom teilnehmen", other: "Am Gespräch teilnehmen" },
  videoRoomNote:
    "Dies ist ein privater Jitsi-Meet-Raum (ein kostenloser Videodienst eines Drittanbieters). Die erste Person, die ihn öffnet, muss sich möglicherweise bei Jitsi anmelden (zum Beispiel mit einem Google-Konto), um das Meeting zu starten; alle anderen nehmen ohne Konto teil, sobald es begonnen hat.",
  linkBeforeCall: (store) => `${store} schickt Ihnen den Link zur Teilnahme vor dem Gespräch.`,
  addToCalendar: "Zu Ihrem Kalender hinzufügen",
  moveCall: "Auf eine andere Zeit verschieben",

  insideTitle: (title) => `Inhalt von ${title}`,
  whatIsInside: "Inhalt",
  startCourse: deStart,
  nothingAttached: (store) =>
    `Hierzu ist gerade nichts hinterlegt. Antworten Sie auf Ihre Bestellbestätigung, um ${store} danach zu fragen.`,
  bundleMissing: (count, store) =>
    count === 1
      ? `Ein Produkt dieses Pakets ist nicht mehr im Shop von ${store}, daher gibt es hier dafür nichts zu öffnen. Antworten Sie auf Ihre Bestellbestätigung, dann erreicht Ihre Nachricht ${store}.`
      : `${count} Produkte dieses Pakets sind nicht mehr im Shop von ${store}, daher gibt es hier dafür nichts zu öffnen. Antworten Sie auf Ihre Bestellbestätigung, dann erreicht Ihre Nachricht ${store}.`,
  showInside: (title) => `Die Produkte in ${title} anzeigen`,
  loadingInside: "Die Produkte werden geladen…",
  insideFailed: "Diese Produkte können gerade nicht angezeigt werden. Versuchen Sie es gleich noch einmal.",
  olderNotChecked: (count, withAdded = false) =>
    count === 0
      ? "Was nach dem Bezahlen zu einer Bestellung hinzugefügt wurde, ist noch nicht geprüft."
      : withAdded
        ? `${count === 1 ? "1 älterer Kauf" : `${count} ältere Käufe`} und was nach dem Bezahlen zu einer Bestellung hinzugefügt wurde, sind noch nicht geprüft.`
        : count === 1
          ? "1 älterer Kauf ist noch nicht geprüft."
          : `${count} ältere Käufe sind noch nicht geprüft.`,
  checkOlder: "Ältere Käufe prüfen",
  checkingOlder: "Ältere Käufe werden geprüft…",
  olderShown: (count) =>
    count === 0 ? "Keiner der geprüften Käufe kann erneut geöffnet werden." : count === 1 ? "1 weiterer Kauf steht jetzt in der Liste." : `${count} weitere Käufe stehen jetzt in der Liste.`,
  olderBatchShown: (count) => count === 0 ? "Kein Kauf aus dieser Gruppe kann erneut geöffnet werden." : count === 1 ? "Diese Seite zeigt 1 Kauf aus dieser Gruppe." : `Diese Seite zeigt ${count} Käufe aus dieser Gruppe.`,
  olderFailed: "Ältere Käufe können gerade nicht geprüft werden. Versuchen Sie es gleich noch einmal.",
  backToList: "Zurück zu all Ihren Käufen",
  olderTitle: "Ältere Käufe",

  yourKey: "Ihr Lizenzschlüssel",
  yourKeyFor: (title) => `Ihr Lizenzschlüssel für ${title}`,
  copy: "Kopieren",
  copied: "Kopiert",
  keyRevoked: (store) =>
    `${store} hat diesen Schlüssel als nicht mehr gültig markiert. Wenn Sie das für einen Fehler halten, antworten Sie auf Ihre Bestellbestätigung, dann erreicht Ihre Nachricht ${store}.`,
  keyYours: "Er gehört nur Ihnen: Niemand sonst erhält diesen Schlüssel. Er steht auch in Ihrer Bestätigungs-E-Mail und in Ihrer Liste der Käufe.",
  keyWaiting: (store) =>
    `Ihre Zahlung ging genau in dem Moment ein, als ${store} keine Schlüssel mehr hatte, daher ist Ihrer noch nicht bereit. ${store} weiß Bescheid, und Ihr Schlüssel wird Ihnen per E-Mail geschickt, sobald neue hinzugefügt werden. Er erscheint auch hier und in Ihrer Liste der Käufe.`,
  keyNotShown: "Ihr Schlüssel konnte gerade nicht angezeigt werden. Laden Sie die Seite gleich neu; er bleibt für Sie aufbewahrt.",

  ordersFrom: (store) => `${store} über Marktmorgen`,
  ordersSubject: (store) => `Ihre Käufe bei ${store}`,
  ordersIntro: (store, count, withAdded = false) =>
    withAdded
      ? count === 0
        ? `Sie haben angefordert, was Sie bei ${store} gekauft haben. Ihre Käufe sind noch nicht geprüft; die Seite prüft sie, wenn Sie es möchten:`
        : `Sie haben angefordert, was Sie bei ${store} gekauft haben. ${count === 1 ? "Hier ist 1" : `Hier sind ${count}`}, bereit zum erneuten Öffnen, und ältere Käufe, die die Seite prüft, wenn Sie es möchten:`
      : `Sie haben angefordert, was Sie bei ${store} gekauft haben. ${count === 1 ? "Hier ist es" : `Hier sind alle ${count}`}, bereit zum erneuten Öffnen:`,
  ordersLinkNote: "Der Link gilt 24 Stunden, auf jedem Gerät. Danach fordern Sie ihn im Shop einfach erneut an, und ein neuer kommt sofort.",
  ordersIgnore: "Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail; es passiert nichts, solange der Link nicht geöffnet wird.",
  ordersSentBy: (store) => `Gesendet von Marktmorgen im Auftrag von ${store}.`,
  chargedBrought: (store, withPaypal) =>
    `Was Sie hier gekauft haben, hat ${store} ${deWhere(withPaypal)} berechnet; was ${store} von einer anderen Plattform übernommen hat, wurde nicht erneut berechnet.`,
  chargedAll: (store, withPaypal) => `Jeder Kauf wurde von ${store} ${deWhere(withPaypal)} berechnet.`,

  confirmSubject: (store, title) => `Ihre Bestellung bei ${store}: ${title}`,
  confirmIntro: (store) => `Vielen Dank für Ihren Einkauf bei ${store}. Dies ist Ihre Bestätigung.`,
  whatYouBought: (title, added) => `Ihr Kauf: ${title}${added ? `, mit ${added}` : ""}`,
  and: (first, second) => `${first} und ${second}`,
  insideOf: (title, titles) => `Inhalt von ${title}: ${titles}`,
  noteFrom: (name) => `Eine Nachricht von ${name}`,
  paid: (amount) => `Bezahlt: ${amount}`,
  orderReference: (id) => `Bestellreferenz: ${id}`,
  planNote: (payments, isWeekly, left, store) =>
    `Dies war die erste von ${payments} ${isWeekly ? "wöchentlichen" : "monatlichen"} Zahlungen. ${
      left === 1
        ? `Die verbleibende Zahlung wird über das eigene Stripe-Konto von ${store} von derselben Karte abgebucht, danach enden die Zahlungen von selbst.`
        : `Die übrigen ${left} werden über das eigene Stripe-Konto von ${store} von derselben Karte abgebucht und enden nach der letzten von selbst.`
    }`,
  addPodcastAt: (url) => `Fügen Sie den Podcast zu Ihrer App hinzu: ${url}`,
  podcastNote: (email) =>
    `Geben Sie auf dieser Seite ${email} ein, und ein Link zu Ihrem eigenen privaten Feed kommt sofort. Er funktioniert in Apple Podcasts, Overcast, Pocket Casts und den meisten anderen Podcast-Apps, solange Sie den Podcast haben.`,
  startCourseAt: (url) => `Kurs starten: ${url}`,
  courseNote: (email) =>
    `Wenn Sie nach dem Bezahlen auf „${deStart}“ geklickt haben, öffnet sich der Kurs auf diesem Gerät sofort. Überall sonst fragt die Kursseite nach Ihrer E-Mail-Adresse: Geben Sie ${email} ein und fordern Sie per E-Mail einen Link an, der dieses Gerät freischaltet. Sie müssen kein Passwort anlegen.`,
  openWhatYouBought: (url) => `Ihren Kauf öffnen: ${url}`,
  threeDays: (ordersUrl, email, store) =>
    `Auf dieser Seite finden Sie Ihren Download oder Ihren Link für die nächsten 3 Tage. Danach ist nichts verloren: Öffnen Sie ${ordersUrl}, geben Sie ${email} ein, und ein Link zu allem, was Sie bei ${store} gekauft haben, wird Ihnen jederzeit per E-Mail geschickt.`,
  startTitleAt: (title, url) => `${title} starten: ${url}`,
  bundleCourseNote: (email) =>
    `Ein Kurs, den Sie nach dem Bezahlen gestartet haben, öffnet sich auf diesem Gerät sofort. Überall sonst fragt seine Seite nach Ihrer E-Mail-Adresse: Geben Sie ${email} ein und fordern Sie per E-Mail einen Link an, der dieses Gerät freischaltet.`,
  keyIssued: (label, key) => `${label}: ${key}`,
  keyOnItsWay: (label, store) =>
    `${label}: unterwegs. ${store} hatte genau bei Ihrer Zahlung keine Schlüssel mehr; Ihr Schlüssel wird Ihnen per E-Mail geschickt, sobald neue hinzugefügt werden.`,
  movedToday: (zero) => `${zero} heute. Ihre Mitgliedschaft ist hierher umgezogen.`,
  movedCharge: (price, hasTax, date) =>
    `Heute wurde nichts berechnet. Ihre erste Zahlung hier von ${price}${hasTax ? " zuzüglich eventuell anfallender Umsatzsteuer" : ""} wird am ${date} von der angegebenen Karte abgebucht. Kündigen Sie vorher, wird Ihnen gar nichts berechnet.`,
  trialCharge: (price, hasTax, days, date) =>
    `Heute wurde nichts berechnet. Ihre erste Zahlung von ${price}${hasTax ? " zuzüglich eventuell anfallender Umsatzsteuer" : ""} wird am Ende des ${days}-tägigen Testzeitraums, am ${date}, von der angegebenen Karte abgebucht. Kündigen Sie vorher, wird Ihnen gar nichts berechnet.`,
  renews: (interval, payments) =>
    payments > 0
      ? `Die Mitgliedschaft verlängert sich ${deOnce(interval)} für insgesamt ${payments} ${plural(payments, "Zahlung", "Zahlungen")} und endet dann von selbst.`
      : `Die Mitgliedschaft verlängert sich ${deOnce(interval)}, bis Sie sie kündigen.`,
  manageAt: (hasEnd, url, email) =>
    `Um sie${hasEnd ? " vorher" : ""} selbst zu verwalten oder zu kündigen, jederzeit und ohne jemandem zu schreiben, öffnen Sie ${url} und geben Sie ${email} ein.`,
  cancelByReply: (hasEnd, store) => `Um sie${hasEnd ? " vorher" : ""} zu kündigen, antworten Sie auf diese E-Mail, dann erreicht Ihre Nachricht ${store}.`,
  earnBySharing: (percent, store, url) =>
    `Verdienen Sie ${percent}${S}%, indem Sie ${store} empfehlen: Holen Sie sich Ihren eigenen Link, ohne Bewerbung, unter ${url}`,
  storeAt: (store, url) => `${store}: ${url}`,
  questions: (store) => `Fragen zu dieser Bestellung? Antworten Sie auf diese E-Mail, dann erreicht Ihre Nachricht ${store}.`,
  paymentWent: (store) => `Die Zahlung ging auf das eigene Stripe-Konto von ${store}. Marktmorgen hat diese E-Mail für ${store} gesendet.`,
  trialStarted: (zero, days) => `${zero} heute. Ihr ${days}-tägiger kostenloser Testzeitraum hat begonnen.`,
  discountCovered: (zero) => `${zero}. Ein Rabattcode hat den gesamten Preis abgedeckt.`,
  paymentsInAll: (every, payments) => `${every}, insgesamt ${payments} ${plural(payments, "Zahlung", "Zahlungen")}`,
  discountToday: (now, then, hasTax, isOpenEnded) =>
    `${now} heute, mit Ihrem Rabatt. ${then ? `Jede weitere Zahlung: ${then}` : "Jede weitere Zahlung erfolgt zum regulären Preis der Mitgliedschaft"}${hasTax ? " zuzüglich eventuell anfallender Umsatzsteuer" : ""}${isOpenEnded ? ", abzüglich Ihres Rabatts, solange er gilt" : ""}.`,
  introTaxed: (now, schedule) => `${now} heute. Der Preis: ${schedule}, zuzüglich eventuell anfallender Umsatzsteuer.`,

  offerSubject: (store, title) => `Zu Ihrer Bestellung bei ${store} hinzugefügt: ${title}`,
  offerIntro: (store) => `Sie haben Ihrer Bestellung bei ${store} etwas hinzugefügt. Dies ist Ihre Bestätigung.`,
  whatYouAdded: (title) => `Hinzugefügt: ${title}`,
  insideIt: (titles) => `Inhalt: ${titles}`,
  paidOnce: (amount) => `Bezahlt: ${amount}, einmalig von der Karte abgebucht, mit der Sie gerade bezahlt hatten`,
  reference: (id) => `Referenz: ${id}`,
  openItAt: (url) => `Öffnen: ${url}`,
  offerThreeDays: (ordersUrl, email, store) =>
    `Auf dieser Seite finden Sie es neben Ihrem ersten Kauf für die nächsten 3 Tage. Danach ist nichts verloren: Öffnen Sie ${ordersUrl}, geben Sie ${email} ein, und ein Link zu allem, was Sie bei ${store} gekauft haben, wird Ihnen jederzeit per E-Mail geschickt.`,
  copyNote: (store) => `${store} hat uns gebeten, Ihnen dies erneut zu senden. Es ist eine Kopie Ihrer Bestätigung.`,

  downloadProblems: {
    unpaid: "Diese Bestellung wurde nicht bezahlt.",
    processing: "Diese Zahlung wird noch von der Bank bestätigt. Versuchen Sie es erneut, sobald sie abgeschlossen ist.",
    expired: "Dieser Download-Link ist abgelaufen.",
    invalid: "Wir konnten diese Bestellung nicht finden.",
    unavailable: "Dieser Shop kann noch keine Zahlungen annehmen.",
    error: "Wir konnten diese Bestellung gerade nicht prüfen. Bitte versuchen Sie es erneut.",
    refunded: "Diese Bestellung wurde vollständig erstattet, daher ist ihr Download geschlossen.",
    purchaseCheckFailed: "Wir konnten diesen Kauf gerade nicht prüfen. Bitte versuchen Sie es erneut.",
    linkExpired: "Dieser Link ist abgelaufen, oder dieser Kauf ist nicht darin enthalten. Fordern Sie im Shop einen neuen Link zu Ihren Käufen an.",
    nothingToDownload: "Hier gibt es nichts herunterzuladen.",
    notADownloadPurchases: "Dies ist kein Download. Öffnen Sie Ihre Käufe erneut und verwenden Sie den Link dort.",
    notADownloadOrder: "Dies ist kein Download. Öffnen Sie die Bestellseite erneut und verwenden Sie den Link dort.",
    productNotADownload: "Dieses Produkt ist kein Download. Öffnen Sie die Bestellseite erneut und verwenden Sie den Link dort.",
    gift: "Dies war ein Geschenk: Es wird über die E-Mail geöffnet, die an die beschenkte Person ging.",
    group: "Dies wurde für mehrere Personen gekauft: Jede öffnet es über den Link in der Quittung.",
    nothingAdded: "Zu dieser Bestellung wurde nichts hinzugefügt.",
    addedNoPart: "Dieses hinzugefügte Produkt hat keinen solchen Teil.",
    addedRefunded: "Dieses hinzugefügte Produkt wurde vollständig erstattet, daher ist sein Download geschlossen.",
    noFile: "Zu diesem Produkt gibt es keine Datei.",
    addedToOrderNoPart: "Das zu dieser Bestellung hinzugefügte Produkt hat keinen solchen Teil.",
    noSuchProduct: "Diese Bestellung enthält kein solches Produkt.",
    tooOften: "Dieser Link wurde in der letzten Stunde sehr oft geöffnet. Bitte versuchen Sie es in Kürze noch einmal.",
  },
};

// ---- Italian: "tu" ------------------------------------------------------------------------------

const itOnce = (interval: Interval) => ({ day: "una volta al giorno", week: "una volta alla settimana", month: "una volta al mese", year: "una volta all'anno" })[interval];
const itStart = "Inizia il corso";
const itWhere = (withPaypal: boolean) => (withPaypal ? "sul proprio account Stripe o PayPal" : "sul proprio account Stripe");
/** "il 9 ottobre", "l'8 ottobre", "l'11 ottobre". */
const itOn = (date: string) => (/^(8|11)\b/.test(date) ? `l'${date}` : `il ${date}`);
/** "il 10 %", "l'8 %", "l'11 %", "l'80 %". */
const itThe = (percent: number) => (/^(1|8|11|8\d)$/.test(String(percent)) ? "l'" : "il ");

const it: OrdersWords = {
  pageTitle: "I tuoi acquisti",
  libraryLink: "Hai acquistato anche da altri creator su Marktmorgen? Trova tutto in un unico posto",
  whileOpen: "Ciò che hai acquistato è qui finché questo negozio resta aperto su Marktmorgen. Un negozio che chiude lo porta con sé: scarica i file che vuoi conservare.",
  notices: {
    email: {
      title: "Questo non sembra un indirizzo email",
      body: "Controllalo e riprova. Usa l'indirizzo con cui hai pagato: quello che hai inserito al momento del pagamento.",
    },
    limited: {
      title: "Troppe richieste per ora",
      body: "Per evitare che questo modulo venga usato per inondare di messaggi la casella di qualcuno, accetta un numero limitato di richieste all'ora. Riprova tra un'ora.",
    },
    unavailable: {
      title: "Questo negozio non può cercare acquisti in questo momento",
      body: "I suoi pagamenti non sono collegati a Stripe in questo momento. Riprova più tardi.",
    },
    error: {
      title: "Qualcosa è andato storto da parte nostra",
      body: "Non è stato modificato nulla. Riprova tra un momento.",
    },
    expired: {
      title: "Questo link è scaduto",
      body: "Un link ai tuoi acquisti funziona per 24 ore. Chiedine uno nuovo qui sotto; ci vogliono pochi secondi.",
    },
    busy: {
      title: "Questo negozio non può mostrare i tuoi acquisti in questo momento",
      body: "Ciò che hai acquistato è conservato. Riprova più tardi. Se nel frattempo il tuo link è scaduto, chiedine uno nuovo qui sotto.",
    },
  },

  getAgainTitle: "Recupera ciò che hai acquistato",
  getAgainIntro: (store) =>
    `Hai perso un download o hai cambiato telefono? Inserisci l'email con cui hai pagato ${store} e ti invieremo via email un link a tutto ciò che hai acquistato qui. Nessun account e nessuna password.`,
  cannotLookUp: (store) =>
    `${store} non può accettare pagamenti tramite Stripe in questo momento, quindi da qui non c'è nulla da cercare. Riprova più tardi.`,
  emailYouPaidWith: "L'email con cui hai pagato",
  emailMe: "Inviami i miei acquisti via email",
  formNote: (store) =>
    `Se quell'indirizzo ha acquistato qualcosa da ${store}, proviamo a inviare via email un link a tutto. Ogni link inviato è valido per 24 ore. Diciamo la stessa cosa in ogni caso, così nessuno può usare questa pagina per scoprire chi ha comprato cosa.`,
  checkInbox: "Controlla la tua casella di posta",
  sentBody: (store) =>
    `Se quell'indirizzo ha acquistato qualcosa da ${store}, di norma il link è in arrivo. Arriva da ${store} tramite Marktmorgen e può richiedere qualche minuto. Se non lo trovi, guarda nella cartella spam.`,
  nothingArrived: "Non è arrivato nulla? Forse hai pagato con un altro indirizzo: quello che hai inserito al momento del pagamento. Prova con quello qui sotto. Se era quello giusto, riprova più tardi.",

  bookedCalls: (count) => (count === 1 ? "La tua prenotazione" : "Le tue prenotazioni"),
  waiting: "Ti aspetta",
  waitingMore: (n) => `E altri ${n}. Apri l’email con cui è arrivato ciascuno per vederlo.`,
  waitingUnread: "Non è stato possibile leggere ora cosa ti aspetta. Riapri questa pagina tra un momento.",
  openRequest: (amount, due) => (due ? `Apri la richiesta di pagamento di ${amount} con scadenza ${due}` : `Apri la richiesta di pagamento di ${amount}`),
  openToSign: (title) => `Leggi e firma «${title}»`,
  nothingToOpenTitle: "Niente da aprire qui",
  nothingToOpen: (store) =>
    `Qui non c'è più nulla da aprire. Un acquisto rimborsato per intero non compare più. Se manca qualcosa, rispondi alla conferma d'ordine che hai ricevuto via email quando hai pagato, e il messaggio arriverà a ${store}.`,
  everythingSold: (store) =>
    `Tutto ciò che ${store} ha venduto a questo indirizzo e che può essere riaperto, dal più recente. Aprilo o scaricalo di nuovo ogni volta che ti serve.`,
  memberRunning: "Abbonamento, ancora attivo",
  memberEnded: "Abbonamento, terminato",
  addedAfterPaying: "Aggiunto dopo il pagamento",
  someone: "qualcuno",
  giftFrom: (name, date) => `Un regalo da parte di ${name}${date ? `, ${itOn(date)}` : ""}`,
  placeFor: (date) => `Un posto che qualcuno ha acquistato per te${date ? `, preso ${itOn(date)}` : ""}`,
  boughtWithPayPal: (date) => `Acquistato ${itOn(date)}, pagato con PayPal`,
  broughtOver: (date) => `Trasferito da un'altra piattaforma${date ? ` ${itOn(date)}` : ""}`,
  givenByStore: (store, date) => `Ricevuto da ${store}${date ? ` ${itOn(date)}` : ""}`,
  boughtOn: (date) => `Acquistato ${itOn(date)}`,
  endedNote: "Questo abbonamento non è più attivo, quindi ciò a cui ti dava accesso ora è chiuso. Rinnovalo e tutto si riapre subito.",
  endedClosedNote: "Questo abbonamento non è più attivo, quindi ciò a cui ti dava accesso ora è chiuso.",
  renew: "Rinnova il tuo abbonamento",
  openCourse: "Apri il corso",
  lessonsDone: (done, total) => `${done} di ${total} ${plural(total, "lezione completata", "lezioni completate")}`,
  progressUnread: "Non siamo riusciti a controllare i tuoi progressi in questo corso in questo momento. Apri il corso per vedere a che punto sei.",
  bookSession: (left) => `Prenota una sessione (${left === 1 ? "ne resta 1" : `ne restano ${left}`})`,
  packageExpired: "Il tempo per prenotare le sessioni di questo pacchetto è scaduto.",
  packageAllBooked: "Tutte le sessioni di questo pacchetto sono prenotate.",
  addPodcast: "Aggiungi il podcast alla tua app",
  alsoIn: (option) => `Incluso anche in ${option}`,
  openIt: "Aprilo",
  openTitle: (title) => `Apri ${title}`,
  keptOn: (host, link) => `Ospitato su ${host}: ${link}`,
  keptAt: (host) => `Ospitato su ${host}`,
  downloadIt: "Scaricalo",
  downloadTitle: (title) => `Scarica ${title}`,
  importedNote: (store) =>
    `${store} ha trasferito qui questo acquisto dalla piattaforma su cui l'hai fatto. Qui non è stato addebitato nulla e questo negozio non ha emesso alcuna ricevuta per esso.`,
  reviewAll: "Recensisci ciò che hai acquistato",
  reviewTitle: (title) => `Recensisci ${title}`,
  worksFor24: "Questa pagina funziona per 24 ore dall'email. Dopo, riaprila e chiedi un nuovo link ogni volta che ti serve.",
  packageTitle: (title, sessions) => `${title}, ${sessions} ${plural(sessions, "sessione", "sessioni")}`,

  callLength: (zone, minutes) => `${zone} · ${minutes} ${plural(minutes, "minuto", "minuti")}`,
  roomLabels: { room: "Entra nella stanza video", meet: "Partecipa su Google Meet", zoom: "Partecipa su Zoom", other: "Partecipa alla chiamata" },
  videoRoomNote:
    "Questa è una stanza privata di Jitsi Meet (un servizio video gratuito gestito da terzi). Alla prima persona che la apre potrebbe essere chiesto di accedere a Jitsi (con un account Google, per esempio) per avviare la riunione; tutti gli altri partecipano senza account una volta iniziata.",
  linkBeforeCall: (store) => `${store} ti invia il link per partecipare prima della chiamata.`,
  addToCalendar: "Aggiungila al tuo calendario",
  moveCall: "Spostala a un altro orario",

  insideTitle: (title) => `Contenuto di ${title}`,
  whatIsInside: "Contenuto",
  startCourse: itStart,
  nothingAttached: (store) =>
    `Per questo al momento non c'è nulla di allegato. Rispondi all'email di conferma dell'ordine per chiederlo a ${store}.`,
  bundleMissing: (count, store) =>
    count === 1
      ? `Un prodotto di questo pacchetto non è più nel negozio di ${store}, quindi qui non c'è nulla da aprire per esso. Rispondi all'email di conferma dell'ordine e il messaggio arriverà a ${store}.`
      : `${count} prodotti di questo pacchetto non sono più nel negozio di ${store}, quindi qui non c'è nulla da aprire per essi. Rispondi all'email di conferma dell'ordine e il messaggio arriverà a ${store}.`,
  showInside: (title) => `Mostra i prodotti in ${title}`,
  loadingInside: "Caricamento dei prodotti…",
  insideFailed: "Non è stato possibile mostrare questi prodotti ora. Riprova tra un momento.",
  olderNotChecked: (count, withAdded = false) =>
    count === 0
      ? "Ciò che è stato aggiunto a un ordine dopo il pagamento non è ancora verificato."
      : withAdded
        ? `${count === 1 ? "1 acquisto precedente" : `${count} acquisti precedenti`} e ciò che è stato aggiunto a un ordine dopo il pagamento non sono ancora verificati.`
        : count === 1
          ? "1 acquisto precedente non è ancora verificato."
          : `${count} acquisti precedenti non sono ancora verificati.`,
  checkOlder: "Verifica gli acquisti precedenti",
  checkingOlder: "Verifica degli acquisti precedenti…",
  olderShown: (count) =>
    count === 0 ? "Nessuno degli acquisti verificati può essere riaperto." : count === 1 ? "1 acquisto in più è ora nell'elenco." : `${count} acquisti in più sono ora nell'elenco.`,
  olderBatchShown: (count) => count === 0 ? "Nessun acquisto di questo gruppo può essere riaperto." : count === 1 ? "Questa pagina mostra 1 acquisto di questo gruppo." : `Questa pagina mostra ${count} acquisti di questo gruppo.`,
  olderFailed: "Non è stato possibile verificare gli acquisti precedenti ora. Riprova tra un momento.",
  backToList: "Torna a tutti i tuoi acquisti",
  olderTitle: "Acquisti precedenti",

  yourKey: "La tua chiave di licenza",
  yourKeyFor: (title) => `La tua chiave di licenza per ${title}`,
  copy: "Copia",
  copied: "Copiata",
  keyRevoked: (store) =>
    `${store} ha segnato questa chiave come non più valida. Se pensi che sia un errore, rispondi all'email di conferma dell'ordine e il messaggio arriverà a ${store}.`,
  keyYours: "È solo tua: nessun altro riceve questa chiave. La trovi anche nella tua email di conferma e nel tuo elenco di acquisti.",
  keyWaiting: (store) =>
    `Il tuo pagamento è andato a buon fine proprio mentre le chiavi di ${store} si esaurivano, quindi la tua non è ancora pronta. ${store} ne è già al corrente, e la chiave ti verrà inviata via email appena ne verranno aggiunte altre. Comparirà anche qui e nel tuo elenco di acquisti.`,
  keyNotShown: "Al momento non è stato possibile mostrare la tua chiave. Ricarica la pagina tra un momento; è conservata per te.",

  ordersFrom: (store) => `${store} tramite Marktmorgen`,
  ordersSubject: (store) => `Ciò che hai acquistato da ${store}`,
  ordersIntro: (store, count, withAdded = false) =>
    withAdded
      ? count === 0
        ? `Hai chiesto ciò che hai acquistato da ${store}. I tuoi acquisti non sono ancora verificati; la pagina li verifica quando lo chiedi:`
        : `Hai chiesto ciò che hai acquistato da ${store}. ${count === 1 ? "Eccone 1, pronto per essere riaperto" : `Eccone ${count}, pronti per essere riaperti`}, e acquisti precedenti che la pagina verifica quando lo chiedi:`
      : `Hai chiesto ciò che hai acquistato da ${store}. ${count === 1 ? "Eccolo, pronto per essere riaperto:" : `Eccoli tutti (${count}), pronti per essere riaperti:`}`,
  ordersLinkNote: "Il link funziona per 24 ore, su qualsiasi dispositivo. Dopo, richiedilo di nuovo dal negozio e ne arriva subito uno nuovo.",
  ordersIgnore: "Se non l'hai chiesto tu, ignora questa email; non succede nulla finché il link non viene aperto.",
  ordersSentBy: (store) => `Inviata da Marktmorgen per conto di ${store}.`,
  chargedBrought: (store, withPaypal) =>
    `Ciò che hai acquistato qui è stato addebitato da ${store} ${itWhere(withPaypal)}; ciò che ${store} ha trasferito da un'altra piattaforma non è stato addebitato di nuovo.`,
  chargedAll: (store, withPaypal) => `Ogni acquisto è stato addebitato da ${store} ${itWhere(withPaypal)}.`,

  confirmSubject: (store, title) => `Il tuo ordine da ${store}: ${title}`,
  confirmIntro: (store) => `Grazie per aver acquistato da ${store}. Questa è la tua conferma.`,
  whatYouBought: (title, added) => `Hai acquistato: ${title}${added ? `, con ${added}` : ""}`,
  and: (first, second) => `${first} e ${second}`,
  insideOf: (title, titles) => `Contenuto di ${title}: ${titles}`,
  noteFrom: (name) => `Un messaggio da ${name}`,
  paid: (amount) => `Pagato: ${amount}`,
  orderReference: (id) => `Riferimento dell'ordine: ${id}`,
  planNote: (payments, isWeekly, left, store) =>
    `Questo era il primo di ${payments} pagamenti ${isWeekly ? "settimanali" : "mensili"}. ${
      left === 1
        ? `L'altro viene addebitato sulla stessa carta, sull'account Stripe di ${store}, e dopo di esso gli addebiti si interrompono da soli.`
        : `Gli altri ${left} vengono addebitati sulla stessa carta, sull'account Stripe di ${store}, e si interrompono da soli dopo l'ultimo.`
    }`,
  addPodcastAt: (url) => `Aggiungi il podcast alla tua app: ${url}`,
  podcastNote: (email) =>
    `Inserisci ${email} in quella pagina e ricevi subito un link al tuo feed privato. Funziona con Apple Podcasts, Overcast, Pocket Casts e la maggior parte delle altre app di podcast, per tutto il tempo in cui lo hai.`,
  startCourseAt: (url) => `Inizia il corso: ${url}`,
  courseNote: (email) =>
    `Se dopo il pagamento hai premuto «${itStart}», si apre subito su quel dispositivo. Altrove, la pagina del corso ti chiede la tua email: inserisci ${email} e richiedi via email un link che dia accesso a quel dispositivo. Non c'è nessuna password da creare.`,
  openWhatYouBought: (url) => `Apri ciò che hai acquistato: ${url}`,
  threeDays: (ordersUrl, email, store) =>
    `Quella pagina contiene il tuo download o il tuo link per i prossimi 3 giorni. Dopo non va perso: apri ${ordersUrl}, inserisci ${email} e ti verrà inviato via email un link a tutto ciò che hai acquistato da ${store}, in qualsiasi momento.`,
  startTitleAt: (title, url) => `Inizia ${title}: ${url}`,
  bundleCourseNote: (email) =>
    `Un corso che hai iniziato dopo il pagamento si apre subito su quel dispositivo. Altrove, la sua pagina ti chiede la tua email: inserisci ${email} e richiedi via email un link che dia accesso a quel dispositivo.`,
  keyIssued: (label, key) => `${label}: ${key}`,
  keyOnItsWay: (label, store) =>
    `${label}: in arrivo. Le chiavi di ${store} si sono esaurite proprio mentre pagavi; ti verrà inviata via email appena ne verranno aggiunte altre.`,
  movedToday: (zero) => `${zero} oggi. Il tuo abbonamento è stato trasferito qui.`,
  movedCharge: (price, hasTax, date) =>
    `Oggi non ti è stato addebitato nulla. Il tuo primo pagamento qui di ${price}${hasTax ? " più le eventuali imposte sulle vendite" : ""} viene addebitato ${itOn(date)}, sulla carta che hai indicato. Se annulli prima, non ti viene addebitato nulla.`,
  trialCharge: (price, hasTax, days, date) =>
    `Oggi non ti è stato addebitato nulla. Il tuo primo pagamento di ${price}${hasTax ? " più le eventuali imposte sulle vendite" : ""} viene addebitato alla fine della prova di ${days} ${plural(days, "giorno", "giorni")}, ${itOn(date)}, sulla carta che hai indicato. Se annulli prima, non ti viene addebitato nulla.`,
  renews: (interval, payments) =>
    payments > 0
      ? `L'abbonamento si rinnova ${itOnce(interval)} per ${payments} ${plural(payments, "pagamento", "pagamenti")} in tutto e poi termina da solo.`
      : `L'abbonamento si rinnova ${itOnce(interval)} finché non lo annulli.`,
  manageAt: (hasEnd, url, email) =>
    `Per gestirlo o annullarlo in autonomia${hasEnd ? " prima che termini" : ""}, in qualsiasi momento e senza scrivere a nessuno, apri ${url} e inserisci ${email}.`,
  cancelByReply: (hasEnd, store) => `Per annullarlo${hasEnd ? " prima che termini" : ""}, rispondi a questa email e il messaggio arriverà a ${store}.`,
  earnBySharing: (percent, store, url) =>
    `Guadagna ${itThe(percent)}${percent}${S}% condividendo ${store}: ottieni il tuo link personale, senza candidatura, su ${url}`,
  storeAt: (store, url) => `${store}: ${url}`,
  questions: (store) => `Domande su questo ordine? Rispondi a questa email e il messaggio arriverà a ${store}.`,
  paymentWent: (store) => `Il pagamento è andato a ${store}, sul suo account Stripe. Marktmorgen ha inviato questa email per suo conto.`,
  trialStarted: (zero, days) => `${zero} oggi. La tua prova gratuita di ${days} ${plural(days, "giorno", "giorni")} è iniziata.`,
  discountCovered: (zero) => `${zero}. Un codice sconto ha coperto l'intero prezzo.`,
  paymentsInAll: (every, payments) => `${every}, ${payments} ${plural(payments, "pagamento", "pagamenti")} in tutto`,
  discountToday: (now, then, hasTax, isOpenEnded) =>
    `${now} oggi, con il tuo sconto. ${then ? `Ogni addebito successivo: ${then}` : "Ogni addebito successivo è al prezzo normale dell'abbonamento"}${hasTax ? " più le eventuali imposte sulle vendite" : ""}${isOpenEnded ? ", meno il tuo sconto finché vale" : ""}.`,
  introTaxed: (now, schedule) => `${now} oggi. Il prezzo: ${schedule}, più le eventuali imposte sulle vendite.`,

  offerSubject: (store, title) => `Aggiunto al tuo ordine da ${store}: ${title}`,
  offerIntro: (store) => `Hai aggiunto qualcosa al tuo ordine da ${store}. Questa è la tua conferma.`,
  whatYouAdded: (title) => `Hai aggiunto: ${title}`,
  insideIt: (titles) => `Contenuto: ${titles}`,
  paidOnce: (amount) => `Pagato: ${amount}, addebitato una sola volta sulla carta con cui avevi appena pagato`,
  reference: (id) => `Riferimento: ${id}`,
  openItAt: (url) => `Aprilo: ${url}`,
  offerThreeDays: (ordersUrl, email, store) =>
    `Quella pagina lo contiene, accanto a ciò che hai acquistato prima, per i prossimi 3 giorni. Dopo non va perso: apri ${ordersUrl}, inserisci ${email} e ti verrà inviato via email un link a tutto ciò che hai acquistato da ${store}, in qualsiasi momento.`,
  copyNote: (store) => `${store} ci ha chiesto di inviarti di nuovo questa email. È una copia della tua conferma.`,

  downloadProblems: {
    unpaid: "Questo ordine non è stato pagato.",
    processing: "La banca sta ancora confermando questo pagamento. Riprova quando sarà completato.",
    expired: "Questo link per il download è scaduto.",
    invalid: "Non siamo riusciti a trovare questo ordine.",
    unavailable: "Questo negozio non può ancora accettare pagamenti.",
    error: "Non siamo riusciti a verificare questo ordine in questo momento. Riprova.",
    refunded: "Questo ordine è stato rimborsato per intero, quindi il suo download è chiuso.",
    purchaseCheckFailed: "Non siamo riusciti a verificare questo acquisto in questo momento. Riprova.",
    linkExpired: "Questo link è scaduto, oppure questo acquisto non vi è incluso. Chiedi al negozio un nuovo link ai tuoi acquisti.",
    nothingToDownload: "Non c'è nulla da scaricare per questo.",
    notADownloadPurchases: "Questo non è un download. Riapri i tuoi acquisti e usa il link indicato.",
    notADownloadOrder: "Questo non è un download. Riapri la pagina dell'ordine e usa il link indicato.",
    productNotADownload: "Questo prodotto non è un download. Riapri la pagina dell'ordine e usa il link indicato.",
    gift: "Questo era un regalo: si apre dall'email inviata alla persona a cui è destinato.",
    group: "Questo è stato acquistato per più persone: ognuna lo apre dal link nella ricevuta.",
    nothingAdded: "A questo ordine non è stato aggiunto nulla.",
    addedNoPart: "Questo prodotto aggiunto non contiene quella parte.",
    addedRefunded: "Questo prodotto aggiunto è stato rimborsato per intero, quindi il suo download è chiuso.",
    noFile: "Questo prodotto non ha alcun file.",
    addedToOrderNoPart: "Il prodotto aggiunto a questo ordine non contiene quella parte.",
    noSuchProduct: "Questo ordine non contiene quel prodotto.",
    tooOften: "Questo link è stato aperto moltissime volte nell'ultima ora. Riprova tra poco.",
  },
};

// ---- Dutch: "je" ------------------------------------------------------------------------------

const nlOnce = (interval: Interval) => ({ day: "één keer per dag", week: "één keer per week", month: "één keer per maand", year: "één keer per jaar" })[interval];
const nlStart = "Start de cursus";
const nlWhere = (withPaypal: boolean) => (withPaypal ? "via het eigen Stripe- of PayPal-account" : "via het eigen Stripe-account");

const nl: OrdersWords = {
  pageTitle: "Je aankopen",
  libraryLink: "Ook bij andere makers op Marktmorgen gekocht? Zie alles op één plek",
  whileOpen: "Wat je kocht staat hier zolang deze winkel open is op Marktmorgen. Een winkel die sluit, neemt het mee: download de bestanden die je wilt houden.",
  notices: {
    email: {
      title: "Dat lijkt geen e-mailadres",
      body: "Controleer het en probeer het opnieuw. Gebruik het adres waarmee je hebt betaald: het adres dat je bij het afrekenen hebt ingevuld.",
    },
    limited: {
      title: "Voorlopig te veel aanvragen",
      body: "Om te voorkomen dat dit formulier wordt gebruikt om iemands inbox te overspoelen, neemt het maar een beperkt aantal aanvragen per uur aan. Probeer het over een uur opnieuw.",
    },
    unavailable: {
      title: "Deze winkel kan nu geen aankopen opzoeken",
      body: "De betalingen van deze winkel zijn nu niet aan Stripe gekoppeld. Probeer het later opnieuw.",
    },
    error: {
      title: "Er ging aan onze kant iets mis",
      body: "Er is niets gewijzigd. Probeer het zo opnieuw.",
    },
    expired: {
      title: "Deze link is verlopen",
      body: "Een link naar je aankopen werkt 24 uur. Vraag hieronder een nieuwe aan; dat duurt maar een paar seconden.",
    },
    busy: {
      title: "Deze winkel kan je aankopen nu niet tonen",
      body: "Wat je hebt gekocht, blijft bewaard. Probeer het later opnieuw. Is je link tegen die tijd verlopen, vraag dan hieronder een nieuwe aan.",
    },
  },

  getAgainTitle: "Haal je aankopen opnieuw op",
  getAgainIntro: (store) =>
    `Een download kwijt, of een nieuwe telefoon? Vul het e-mailadres in waarmee je ${store} hebt betaald, en we mailen je een link naar alles wat je hier hebt gekocht. Geen account en geen wachtwoord.`,
  cannotLookUp: (store) =>
    `${store} kan nu geen betalingen via Stripe ontvangen, dus hier valt niets op te zoeken. Probeer het later opnieuw.`,
  emailYouPaidWith: "Het e-mailadres waarmee je hebt betaald",
  emailMe: "Mail me mijn aankopen",
  formNote: (store) =>
    `Als met dat adres iets is gekocht bij ${store}, proberen we per e-mail een link naar alles te sturen. Elke verstuurde link werkt 24 uur. We zeggen hetzelfde, of dat nu zo is of niet, zodat niemand via deze pagina kan uitzoeken wie wat heeft gekocht.`,
  checkInbox: "Kijk in je inbox",
  sentBody: (store) =>
    `Als met dat adres iets is gekocht bij ${store}, is de link normaal gesproken onderweg. Hij komt van ${store} via Marktmorgen en kan een paar minuten duren. Staat hij er niet, kijk dan in je spam.`,
  nothingArrived: "Niets ontvangen? Misschien heb je met een ander adres betaald: het adres dat je bij het afrekenen hebt ingevuld. Probeer dat hieronder. Was het het juiste adres, probeer het dan later opnieuw.",

  bookedCalls: (count) => (count === 1 ? "Je boeking" : "Je boekingen"),
  waiting: "Wacht op jou",
  waitingMore: (n) => `En nog ${n}. Open de e-mail waarmee elk binnenkwam om het te zien.`,
  waitingUnread: "Wat op je wacht, kon nu niet worden gelezen. Open deze pagina zo meteen opnieuw.",
  openRequest: (amount, due) => (due ? `Het betaalverzoek van ${amount}, te betalen op ${due}, openen` : `Het betaalverzoek van ${amount} openen`),
  openToSign: (title) => `‘${title}’ lezen en ondertekenen`,
  nothingToOpenTitle: "Hier is niets te openen",
  nothingToOpen: (store) =>
    `Hier valt niets meer te openen. Een aankoop die volledig is terugbetaald, staat er niet meer bij. Mist er iets, beantwoord dan de orderbevestiging die je per e-mail kreeg toen je betaalde, dan komt je bericht bij ${store} aan.`,
  everythingSold: (store) =>
    `Alles wat ${store} aan dit adres heeft verkocht en opnieuw kan worden geopend, nieuwste eerst. Open of download het opnieuw wanneer je het nodig hebt.`,
  memberRunning: "Lidmaatschap, loopt nog",
  memberEnded: "Lidmaatschap, beëindigd",
  addedAfterPaying: "Toegevoegd na betaling",
  someone: "iemand",
  giftFrom: (name, date) => `Een cadeau van ${name}${date ? `, op ${date}` : ""}`,
  placeFor: (date) => `Een plek die iemand voor je heeft gekocht${date ? `, ingenomen op ${date}` : ""}`,
  boughtWithPayPal: (date) => `Gekocht op ${date}, betaald met PayPal`,
  broughtOver: (date) => `Overgezet van een ander platform${date ? ` op ${date}` : ""}`,
  givenByStore: (store, date) => `Gekregen van ${store}${date ? ` op ${date}` : ""}`,
  boughtOn: (date) => `Gekocht op ${date}`,
  endedNote: "Dit lidmaatschap loopt niet meer, dus waar het je toegang toe gaf, is nu gesloten. Verleng het en alles gaat meteen weer open.",
  endedClosedNote: "Dit lidmaatschap loopt niet meer, dus waar het je toegang toe gaf, is nu gesloten.",
  renew: "Verleng je lidmaatschap",
  openCourse: "Open de cursus",
  lessonsDone: (done, total) => `${done} van ${total} ${plural(total, "les", "lessen")} afgerond`,
  progressUnread: "We konden je voortgang in deze cursus op dit moment niet controleren. Open de cursus om te zien waar je bent.",
  bookSession: (left) => `Boek een sessie (nog ${left} over)`,
  packageExpired: "De tijd om de sessies van dit pakket te boeken is verstreken.",
  packageAllBooked: "Alle sessies van dit pakket zijn geboekt.",
  addPodcast: "Voeg de podcast toe aan je app",
  alsoIn: (option) => `Ook inbegrepen in ${option}`,
  openIt: "Openen",
  openTitle: (title) => `${title} openen`,
  keptOn: (host, link) => `Bewaard op ${host}: ${link}`,
  keptAt: (host) => `Bewaard op ${host}`,
  downloadIt: "Downloaden",
  downloadTitle: (title) => `${title} downloaden`,
  importedNote: (store) =>
    `${store} heeft dit hierheen overgezet van het platform waar je het hebt gekocht. Hier is niets afgeschreven en deze winkel heeft er geen bon voor.`,
  reviewAll: "Beoordeel wat je hebt gekocht",
  reviewTitle: (title) => `Beoordeel ${title}`,
  worksFor24: "Deze pagina werkt 24 uur vanaf de e-mail. Open hem daarna opnieuw en vraag een nieuwe link aan wanneer je er een nodig hebt.",
  packageTitle: (title, sessions) => `${title}, ${sessions} ${plural(sessions, "sessie", "sessies")}`,

  callLength: (zone, minutes) => `${zone} · ${minutes} ${plural(minutes, "minuut", "minuten")}`,
  roomLabels: { room: "Naar de videoruimte", meet: "Deelnemen via Google Meet", zoom: "Deelnemen via Zoom", other: "Deelnemen aan het gesprek" },
  videoRoomNote:
    "Dit is een privéruimte in Jitsi Meet (een gratis videodienst van een derde partij). Wie hem als eerste opent, moet mogelijk inloggen bij Jitsi (bijvoorbeeld met een Google-account) om de vergadering te starten; alle anderen doen mee zonder account zodra die is begonnen.",
  linkBeforeCall: (store) => `${store} stuurt je vóór het gesprek de link om deel te nemen.`,
  addToCalendar: "Zet het in je agenda",
  moveCall: "Verplaats het naar een ander tijdstip",

  insideTitle: (title) => `Inhoud van ${title}`,
  whatIsInside: "Inhoud",
  startCourse: nlStart,
  nothingAttached: (store) => `Hier is nu niets aan gekoppeld. Beantwoord je orderbevestiging om ${store} erom te vragen.`,
  bundleMissing: (count, store) =>
    count === 1
      ? `Eén product van deze bundel staat niet meer in de winkel van ${store}, dus hier valt daarvoor niets te openen. Beantwoord je orderbevestiging, dan komt je bericht bij ${store} aan.`
      : `${count} producten van deze bundel staan niet meer in de winkel van ${store}, dus hier valt daarvoor niets te openen. Beantwoord je orderbevestiging, dan komt je bericht bij ${store} aan.`,
  showInside: (title) => `Toon de producten in ${title}`,
  loadingInside: "De producten worden geladen…",
  insideFailed: "Deze producten kunnen nu niet worden getoond. Probeer het zo opnieuw.",
  olderNotChecked: (count, withAdded = false) =>
    count === 0
      ? "Wat na het betalen aan een bestelling is toegevoegd, is nog niet gecontroleerd."
      : withAdded
        ? `${count === 1 ? "1 oudere aankoop" : `${count} oudere aankopen`} en wat na het betalen aan een bestelling is toegevoegd, zijn nog niet gecontroleerd.`
        : count === 1
          ? "1 oudere aankoop is nog niet gecontroleerd."
          : `${count} oudere aankopen zijn nog niet gecontroleerd.`,
  checkOlder: "Oudere aankopen controleren",
  checkingOlder: "Oudere aankopen worden gecontroleerd…",
  olderShown: (count) =>
    count === 0 ? "Geen van de gecontroleerde aankopen kan opnieuw worden geopend." : count === 1 ? "1 aankoop extra staat nu in de lijst." : `${count} aankopen extra staan nu in de lijst.`,
  olderBatchShown: (count) => count === 0 ? "Geen aankoop uit deze groep kan opnieuw worden geopend." : count === 1 ? "Deze pagina toont 1 aankoop uit deze groep." : `Deze pagina toont ${count} aankopen uit deze groep.`,
  olderFailed: "Oudere aankopen kunnen nu niet worden gecontroleerd. Probeer het zo opnieuw.",
  backToList: "Terug naar al je aankopen",
  olderTitle: "Oudere aankopen",

  yourKey: "Je licentiesleutel",
  yourKeyFor: (title) => `Je licentiesleutel voor ${title}`,
  copy: "Kopiëren",
  copied: "Gekopieerd",
  keyRevoked: (store) =>
    `${store} heeft deze sleutel als niet meer geldig gemarkeerd. Denk je dat dat een vergissing is, beantwoord dan je orderbevestiging, dan komt je bericht bij ${store} aan.`,
  keyYours: "Hij is alleen van jou: niemand anders krijgt deze sleutel. Hij staat ook in je bevestigingsmail en in je lijst met aankopen.",
  keyWaiting: (store) =>
    `Je betaling kwam binnen net toen de sleutels van ${store} op waren, dus die van jou is nog niet klaar. ${store} is op de hoogte, en je sleutel wordt je gemaild zodra er nieuwe zijn toegevoegd. Hij verschijnt ook hier en in je lijst met aankopen.`,
  keyNotShown: "Je sleutel kon nu niet worden getoond. Vernieuw de pagina zo; hij wordt voor je bewaard.",

  ordersFrom: (store) => `${store} via Marktmorgen`,
  ordersSubject: (store) => `Wat je bij ${store} hebt gekocht`,
  ordersIntro: (store, count, withAdded = false) =>
    withAdded
      ? count === 0
        ? `Je vroeg om wat je bij ${store} hebt gekocht. Je aankopen zijn nog niet gecontroleerd; de pagina controleert ze wanneer je dat vraagt:`
        : `Je vroeg om wat je bij ${store} hebt gekocht. ${count === 1 ? "Hier is er 1" : `Hier zijn er ${count}`}, klaar om opnieuw te openen, en oudere aankopen die de pagina controleert wanneer je dat vraagt:`
      : `Je vroeg om wat je bij ${store} hebt gekocht. ${count === 1 ? "Hier is het" : `Hier zijn ze alle ${count}`}, klaar om opnieuw te openen:`,
  ordersLinkNote: "De link werkt 24 uur, op elk apparaat. Vraag daarna opnieuw aan via de winkel en er komt meteen een nieuwe.",
  ordersIgnore: "Heb je hier niet om gevraagd, negeer deze e-mail dan; er gebeurt niets zolang de link niet wordt geopend.",
  ordersSentBy: (store) => `Verstuurd door Marktmorgen namens ${store}.`,
  chargedBrought: (store, withPaypal) =>
    `Wat je hier hebt gekocht, is door ${store} afgeschreven ${nlWhere(withPaypal)}; wat ${store} van een ander platform heeft overgezet, is niet opnieuw afgeschreven.`,
  chargedAll: (store, withPaypal) => `Elke aankoop is door ${store} afgeschreven ${nlWhere(withPaypal)}.`,

  confirmSubject: (store, title) => `Je bestelling bij ${store}: ${title}`,
  confirmIntro: (store) => `Bedankt voor je aankoop bij ${store}. Dit is je bevestiging.`,
  whatYouBought: (title, added) => `Wat je hebt gekocht: ${title}${added ? `, met ${added}` : ""}`,
  and: (first, second) => `${first} en ${second}`,
  insideOf: (title, titles) => `Inhoud van ${title}: ${titles}`,
  noteFrom: (name) => `Een bericht van ${name}`,
  paid: (amount) => `Betaald: ${amount}`,
  orderReference: (id) => `Bestelreferentie: ${id}`,
  planNote: (payments, isWeekly, left, store) =>
    `Dit was de eerste van ${payments} ${isWeekly ? "wekelijkse" : "maandelijkse"} betalingen. ${
      left === 1
        ? `De laatste wordt via het eigen Stripe-account van ${store} van dezelfde kaart afgeschreven, en daarna stopt het vanzelf.`
        : `De andere ${left} worden via het eigen Stripe-account van ${store} van dezelfde kaart afgeschreven, en ze stoppen vanzelf na de laatste.`
    }`,
  addPodcastAt: (url) => `Voeg de podcast toe aan je app: ${url}`,
  podcastNote: (email) =>
    `Vul op die pagina ${email} in en je krijgt meteen een link naar je eigen privéfeed. Die werkt in Apple Podcasts, Overcast, Pocket Casts en de meeste andere podcastapps, zolang je de podcast hebt.`,
  startCourseAt: (url) => `Start de cursus: ${url}`,
  courseNote: (email) =>
    `Als je na het betalen op ‘${nlStart}’ hebt gedrukt, opent de cursus meteen op dat apparaat. Op elk ander apparaat vraagt de cursuspagina om je e-mailadres: vul ${email} in en vraag per e-mail een link aan die dat apparaat toegang geeft. Je hoeft geen wachtwoord aan te maken.`,
  openWhatYouBought: (url) => `Open wat je hebt gekocht: ${url}`,
  threeDays: (ordersUrl, email, store) =>
    `Op die pagina staat je download of je link de komende 3 dagen. Daarna is het niet kwijt: open ${ordersUrl}, vul ${email} in en je krijgt op elk moment een link gemaild naar alles wat je bij ${store} hebt gekocht.`,
  startTitleAt: (title, url) => `Start ${title}: ${url}`,
  bundleCourseNote: (email) =>
    `Een cursus die je na het betalen hebt gestart, opent meteen op dat apparaat. Op elk ander apparaat vraagt de pagina om je e-mailadres: vul ${email} in en vraag per e-mail een link aan die dat apparaat toegang geeft.`,
  keyIssued: (label, key) => `${label}: ${key}`,
  keyOnItsWay: (label, store) =>
    `${label}: onderweg. De sleutels van ${store} waren op net toen je betaalde; je sleutel wordt je gemaild zodra er nieuwe zijn toegevoegd.`,
  movedToday: (zero) => `${zero} vandaag. Je lidmaatschap is hierheen verhuisd.`,
  movedCharge: (price, hasTax, date) =>
    `Vandaag is er niets afgeschreven. Je eerste betaling hier van ${price}${hasTax ? " plus eventuele omzetbelasting" : ""} wordt op ${date} afgeschreven van de kaart die je hebt opgegeven. Zeg je daarvoor op, dan betaal je helemaal niets.`,
  trialCharge: (price, hasTax, days, date) =>
    `Vandaag is er niets afgeschreven. Je eerste betaling van ${price}${hasTax ? " plus eventuele omzetbelasting" : ""} wordt afgeschreven als de proefperiode van ${days} ${plural(days, "dag", "dagen")} afloopt, op ${date}, van de kaart die je hebt opgegeven. Zeg je daarvoor op, dan betaal je helemaal niets.`,
  renews: (interval, payments) =>
    payments > 0
      ? `Het lidmaatschap wordt ${nlOnce(interval)} verlengd, voor in totaal ${payments} ${plural(payments, "betaling", "betalingen")}, en stopt daarna vanzelf.`
      : `Het lidmaatschap wordt ${nlOnce(interval)} verlengd tot je het opzegt.`,
  manageAt: (hasEnd, url, email) =>
    `Om het zelf te beheren of op te zeggen${hasEnd ? " voor die tijd" : ""}, op elk moment en zonder iemand te schrijven, open je ${url} en vul je ${email} in.`,
  cancelByReply: (hasEnd, store) => `Om het op te zeggen${hasEnd ? " voor die tijd" : ""}, beantwoord je deze e-mail; dan komt je bericht bij ${store} aan.`,
  earnBySharing: (percent, store, url) =>
    `Verdien ${percent}${S}% door ${store} te delen: haal je eigen link op, zonder aanmelding, via ${url}`,
  storeAt: (store, url) => `${store}: ${url}`,
  questions: (store) => `Vragen over deze bestelling? Beantwoord deze e-mail, dan komt je bericht bij ${store} aan.`,
  paymentWent: (store) => `De betaling ging naar ${store}, op het eigen Stripe-account. Marktmorgen heeft deze e-mail namens ${store} verstuurd.`,
  trialStarted: (zero, days) => `${zero} vandaag. Je gratis proefperiode van ${days} ${plural(days, "dag", "dagen")} is begonnen.`,
  discountCovered: (zero) => `${zero}. Een kortingscode dekte de volledige prijs.`,
  paymentsInAll: (every, payments) => `${every}, ${payments} ${plural(payments, "betaling", "betalingen")} in totaal`,
  discountToday: (now, then, hasTax, isOpenEnded) =>
    `${now} vandaag, met je korting. ${then ? `Elke volgende betaling: ${then}` : "Elke volgende betaling is tegen de normale prijs van het lidmaatschap"}${hasTax ? " plus eventuele omzetbelasting" : ""}${isOpenEnded ? ", min je korting zolang die geldt" : ""}.`,
  introTaxed: (now, schedule) => `${now} vandaag. De prijs: ${schedule}, plus eventuele omzetbelasting.`,

  offerSubject: (store, title) => `Toegevoegd aan je bestelling bij ${store}: ${title}`,
  offerIntro: (store) => `Je hebt iets toegevoegd aan je bestelling bij ${store}. Dit is je bevestiging.`,
  whatYouAdded: (title) => `Wat je hebt toegevoegd: ${title}`,
  insideIt: (titles) => `Inhoud: ${titles}`,
  paidOnce: (amount) => `Betaald: ${amount}, één keer afgeschreven van de kaart waarmee je net had betaald`,
  reference: (id) => `Referentie: ${id}`,
  openItAt: (url) => `Openen: ${url}`,
  offerThreeDays: (ordersUrl, email, store) =>
    `Op die pagina staat het de komende 3 dagen, naast wat je eerst kocht. Daarna is het niet kwijt: open ${ordersUrl}, vul ${email} in en je krijgt op elk moment een link gemaild naar alles wat je bij ${store} hebt gekocht.`,
  copyNote: (store) => `${store} heeft ons gevraagd je dit opnieuw te sturen. Het is een kopie van je bevestiging.`,

  downloadProblems: {
    unpaid: "Deze bestelling is niet betaald.",
    processing: "Deze betaling wordt nog door de bank bevestigd. Probeer het opnieuw zodra ze is verwerkt.",
    expired: "Deze downloadlink is verlopen.",
    invalid: "We konden deze bestelling niet vinden.",
    unavailable: "Deze winkel kan nog geen betalingen ontvangen.",
    error: "We konden deze bestelling nu niet controleren. Probeer het opnieuw.",
    refunded: "Deze bestelling is volledig terugbetaald, dus de download is gesloten.",
    purchaseCheckFailed: "We konden deze aankoop nu niet controleren. Probeer het opnieuw.",
    linkExpired: "Deze link is verlopen, of deze aankoop staat er niet op. Vraag bij de winkel een nieuwe link naar je aankopen aan.",
    nothingToDownload: "Hier valt niets te downloaden.",
    notADownloadPurchases: "Dit is geen download. Open je aankopen opnieuw en gebruik de link die erbij staat.",
    notADownloadOrder: "Dit is geen download. Open de bestelpagina opnieuw en gebruik de link die erbij staat.",
    productNotADownload: "Dit product is geen download. Open de bestelpagina opnieuw en gebruik de link die erbij staat.",
    gift: "Dit was een cadeau: het wordt geopend via de e-mail die is gestuurd naar degene voor wie het is.",
    group: "Dit is voor meerdere mensen gekocht: iedereen opent het via de link in de bon.",
    nothingAdded: "Aan deze bestelling is niets toegevoegd.",
    addedNoPart: "Dit toegevoegde product heeft zo'n onderdeel niet.",
    addedRefunded: "Dit toegevoegde product is volledig terugbetaald, dus de download is gesloten.",
    noFile: "Bij dit product hoort geen bestand.",
    addedToOrderNoPart: "Het product dat aan deze bestelling is toegevoegd, heeft zo'n onderdeel niet.",
    noSuchProduct: "Deze bestelling bevat zo'n product niet.",
    tooOften: "Deze link is het afgelopen uur heel vaak geopend. Probeer het over een poosje opnieuw.",
  },
};

// ---- European Portuguese: the courteous third person --------------------------------------------

const ptOnce = (interval: Interval) => ({ day: "uma vez por dia", week: "uma vez por semana", month: "uma vez por mês", year: "uma vez por ano" })[interval];
const ptStart = "Começar o curso";
const ptWhere = (withPaypal: boolean) => (withPaypal ? "na própria conta Stripe ou PayPal" : "na própria conta Stripe");

const pt: OrdersWords = {
  pageTitle: "As suas compras",
  libraryLink: "Comprou também a outros criadores na Marktmorgen? Veja tudo num só lugar",
  whileOpen: "O que comprou está aqui enquanto esta loja estiver aberta na Marktmorgen. Uma loja que fecha leva-o consigo: transfira os ficheiros que quer guardar.",
  notices: {
    email: {
      title: "Isso não parece um endereço de email",
      body: "Verifique-o e tente novamente. Utilize o endereço com que pagou: o que introduziu no pagamento.",
    },
    limited: {
      title: "Demasiados pedidos por agora",
      body: "Para evitar que este formulário seja utilizado para inundar a caixa de entrada de alguém, aceita um número limitado de pedidos por hora. Tente novamente daqui a uma hora.",
    },
    unavailable: {
      title: "Esta loja não pode procurar compras neste momento",
      body: "Os pagamentos da loja não estão ligados à Stripe neste momento. Tente novamente mais tarde.",
    },
    error: {
      title: "Algo correu mal do nosso lado",
      body: "Nada foi alterado. Tente novamente daqui a pouco.",
    },
    expired: {
      title: "Esta ligação expirou",
      body: "Uma ligação para as suas compras funciona durante 24 horas. Peça uma nova abaixo; demora apenas alguns segundos.",
    },
    busy: {
      title: "Esta loja não pode mostrar as suas compras neste momento",
      body: "O que comprou fica guardado. Tente novamente mais tarde. Se entretanto a sua ligação expirar, peça uma nova abaixo.",
    },
  },

  getAgainTitle: "Volte a obter o que comprou",
  getAgainIntro: (store) =>
    `Perdeu um ficheiro descarregado ou mudou de telemóvel? Introduza o email com que pagou a ${store} e enviamos-lhe por email uma ligação para tudo o que comprou aqui. Sem conta e sem palavra-passe.`,
  cannotLookUp: (store) =>
    `${store} não pode receber pagamentos através da Stripe neste momento, por isso não há nada a procurar aqui. Tente novamente mais tarde.`,
  emailYouPaidWith: "O email com que pagou",
  emailMe: "Enviar-me as minhas compras por email",
  formNote: (store) =>
    `Se esse endereço comprou algo a ${store}, tentamos enviar-lhe por email uma ligação para tudo. Qualquer ligação enviada funciona durante 24 horas. Dizemos o mesmo quer tenha comprado quer não, para que ninguém possa usar esta página para descobrir quem comprou o quê.`,
  checkInbox: "Verifique a sua caixa de entrada",
  sentBody: (store) =>
    `Se esse endereço comprou algo a ${store}, a ligação normalmente está a caminho. Chega de ${store} via Marktmorgen e pode demorar alguns minutos. Se não estiver lá, veja na pasta de spam.`,
  nothingArrived: "Não recebeu nada? Talvez tenha pago com outro endereço: o que introduziu no pagamento. Experimente esse abaixo. Se era o correto, tente novamente mais tarde.",

  bookedCalls: (count) => (count === 1 ? "A sua marcação" : "As suas marcações"),
  waiting: "À sua espera",
  waitingMore: (n) => `E mais ${n}. Abra o email com que cada um chegou para o ver.`,
  waitingUnread: "Não foi possível ler agora o que está à sua espera. Volte a abrir esta página daqui a pouco.",
  openRequest: (amount, due) => (due ? `Abrir o pedido de pagamento de ${amount} que vence a ${due}` : `Abrir o pedido de pagamento de ${amount}`),
  openToSign: (title) => `Ler e assinar «${title}»`,
  nothingToOpenTitle: "Nada para abrir aqui",
  nothingToOpen: (store) =>
    `Já não há nada para abrir aqui. Uma compra reembolsada na totalidade deixa de aparecer. Se faltar alguma coisa, responda à confirmação da encomenda que recebeu por email quando pagou, e a mensagem chega a ${store}.`,
  everythingSold: (store) =>
    `Tudo o que ${store} vendeu a este endereço e que pode voltar a ser aberto, do mais recente para o mais antigo. Volte a abrir ou a descarregar qualquer item sempre que precisar.`,
  memberRunning: "Subscrição, ainda ativa",
  memberEnded: "Subscrição, terminada",
  addedAfterPaying: "Adicionado depois de pagar",
  someone: "alguém",
  giftFrom: (name, date) => `Um presente de ${name}${date ? `, a ${date}` : ""}`,
  placeFor: (date) => `Um lugar que alguém comprou para si${date ? `, ocupado a ${date}` : ""}`,
  boughtWithPayPal: (date) => `Comprado a ${date}, pago com PayPal`,
  broughtOver: (date) => `Transferido de outra plataforma${date ? ` a ${date}` : ""}`,
  givenByStore: (store, date) => `Oferecido por ${store}${date ? ` a ${date}` : ""}`,
  boughtOn: (date) => `Comprado a ${date}`,
  endedNote: "Esta subscrição já não está ativa, por isso aquilo a que lhe dava acesso está agora fechado. Renove-a e tudo volta a abrir de imediato.",
  endedClosedNote: "Esta subscrição já não está ativa, por isso aquilo a que lhe dava acesso está agora fechado.",
  renew: "Renovar a sua subscrição",
  openCourse: "Abrir o curso",
  lessonsDone: (done, total) => `${done} de ${total} ${plural(total, "aula concluída", "aulas concluídas")}`,
  progressUnread: "Não foi possível verificar o seu progresso neste curso agora. Abra o curso para ver onde está.",
  bookSession: (left) => `Marcar uma sessão (${left === 1 ? "resta 1" : `restam ${left}`})`,
  packageExpired: "O prazo para marcar as sessões deste pacote já terminou.",
  packageAllBooked: "Todas as sessões deste pacote estão marcadas.",
  addPodcast: "Adicionar o podcast à sua aplicação",
  alsoIn: (option) => `Também incluído em ${option}`,
  openIt: "Abrir",
  openTitle: (title) => `Abrir ${title}`,
  keptOn: (host, link) => `Alojado em ${host}: ${link}`,
  keptAt: (host) => `Alojado em ${host}`,
  downloadIt: "Descarregar",
  downloadTitle: (title) => `Descarregar ${title}`,
  importedNote: (store) =>
    `${store} trouxe esta compra para aqui a partir da plataforma onde a fez. Nada foi cobrado aqui e esta loja não emitiu recibo por ela.`,
  reviewAll: "Avaliar o que comprou",
  reviewTitle: (title) => `Avaliar ${title}`,
  worksFor24: "Esta página funciona durante 24 horas a partir do email. Depois disso, volte a abri-la e peça uma nova ligação sempre que precisar.",
  packageTitle: (title, sessions) => `${title}, ${sessions} ${plural(sessions, "sessão", "sessões")}`,

  callLength: (zone, minutes) => `${zone} · ${minutes} ${plural(minutes, "minuto", "minutos")}`,
  roomLabels: { room: "Entrar na sala de vídeo", meet: "Entrar no Google Meet", zoom: "Entrar no Zoom", other: "Entrar na chamada" },
  videoRoomNote:
    "Esta é uma sala privada do Jitsi Meet (um serviço de vídeo gratuito gerido por terceiros). A primeira pessoa a abri-la pode ter de iniciar sessão no Jitsi (com uma conta Google, por exemplo) para começar a reunião; todos os outros entram sem conta depois de a reunião ter começado.",
  linkBeforeCall: (store) => `${store} envia-lhe a ligação para entrar antes da chamada.`,
  addToCalendar: "Adicionar ao seu calendário",
  moveCall: "Mudar para outro horário",

  insideTitle: (title) => `Conteúdo de ${title}`,
  whatIsInside: "O que inclui",
  startCourse: ptStart,
  nothingAttached: (store) =>
    `Este não tem nada anexado neste momento. Responda ao email de confirmação da sua encomenda para o pedir a ${store}.`,
  bundleMissing: (count, store) =>
    count === 1
      ? `Um produto deste pacote já não está na loja de ${store}, por isso não há nada aqui para o abrir. Responda ao email de confirmação da sua encomenda e a mensagem chega a ${store}.`
      : `${count} produtos deste pacote já não estão na loja de ${store}, por isso não há nada aqui para os abrir. Responda ao email de confirmação da sua encomenda e a mensagem chega a ${store}.`,
  showInside: (title) => `Mostrar os produtos de ${title}`,
  loadingInside: "A carregar os produtos…",
  insideFailed: "Não foi possível mostrar estes produtos agora. Tente novamente daqui a pouco.",
  olderNotChecked: (count, withAdded = false) =>
    count === 0
      ? "O que foi acrescentado a uma encomenda depois de pagar ainda não foi verificado."
      : withAdded
        ? `${count === 1 ? "1 compra anterior" : `${count} compras anteriores`} e o que foi acrescentado a uma encomenda depois de pagar ainda não foram verificados.`
        : count === 1
          ? "1 compra anterior ainda não foi verificada."
          : `${count} compras anteriores ainda não foram verificadas.`,
  checkOlder: "Verificar compras anteriores",
  checkingOlder: "A verificar compras anteriores…",
  olderShown: (count) =>
    count === 0 ? "Nenhuma das compras verificadas pode ser aberta novamente." : count === 1 ? "Mais 1 compra está agora na lista." : `Mais ${count} compras estão agora na lista.`,
  olderBatchShown: (count) => count === 0 ? "Nenhuma compra deste grupo pode ser aberta novamente." : count === 1 ? "Esta página mostra 1 compra deste grupo." : `Esta página mostra ${count} compras deste grupo.`,
  olderFailed: "Não foi possível verificar as compras anteriores agora. Tente novamente daqui a pouco.",
  backToList: "Voltar a todas as suas compras",
  olderTitle: "Compras anteriores",

  yourKey: "A sua chave de licença",
  yourKeyFor: (title) => `A sua chave de licença de ${title}`,
  copy: "Copiar",
  copied: "Copiada",
  keyRevoked: (store) =>
    `${store} marcou esta chave como já não válida. Se achar que é um engano, responda ao email de confirmação da sua encomenda e a mensagem chega a ${store}.`,
  keyYours: "É só sua: mais ninguém recebe esta chave. Também está no seu email de confirmação e na sua lista de compras.",
  keyWaiting: (store) =>
    `O seu pagamento foi concluído no momento em que as chaves de ${store} se esgotaram, por isso a sua ainda não está pronta. ${store} já tem conhecimento disso, e a chave ser-lhe-á enviada por email assim que forem adicionadas mais. Também aparecerá aqui e na sua lista de compras.`,
  keyNotShown: "Não foi possível mostrar a sua chave agora. Atualize a página daqui a pouco; está guardada para si.",

  ordersFrom: (store) => `${store} via Marktmorgen`,
  ordersSubject: (store) => `O que comprou a ${store}`,
  ordersIntro: (store, count, withAdded = false) =>
    withAdded
      ? count === 0
        ? `Pediu o que comprou a ${store}. As suas compras ainda não foram verificadas; a página verifica-as quando pedir:`
        : `Pediu o que comprou a ${store}. ${count === 1 ? "Aqui está 1 compra, pronta a abrir de novo" : `Aqui estão ${count} compras, prontas a abrir de novo`}, e compras anteriores que a página verifica quando pedir:`
      : `Pediu o que comprou a ${store}. ${count === 1 ? "Aqui está, pronto a abrir de novo:" : `Aqui estão as ${count} compras, prontas a abrir de novo:`}`,
  ordersLinkNote: "A ligação funciona durante 24 horas, em qualquer dispositivo. Depois disso, peça novamente a partir da loja e chega logo uma nova.",
  ordersIgnore: "Se não pediu isto, ignore este email; nada acontece a menos que a ligação seja aberta.",
  ordersSentBy: (store) => `Enviado pela Marktmorgen em nome de ${store}.`,
  chargedBrought: (store, withPaypal) =>
    `O que comprou aqui foi cobrado por ${store} ${ptWhere(withPaypal)}; o que ${store} trouxe de outra plataforma não foi cobrado novamente.`,
  chargedAll: (store, withPaypal) => `Todas as compras foram cobradas por ${store} ${ptWhere(withPaypal)}.`,

  confirmSubject: (store, title) => `A sua encomenda de ${store}: ${title}`,
  confirmIntro: (store) => `Obrigado por comprar a ${store}. Esta é a sua confirmação.`,
  whatYouBought: (title, added) => `O que comprou: ${title}${added ? `, com ${added}` : ""}`,
  and: (first, second) => `${first} e ${second}`,
  insideOf: (title, titles) => `Conteúdo de ${title}: ${titles}`,
  noteFrom: (name) => `Uma nota de ${name}`,
  paid: (amount) => `Pago: ${amount}`,
  orderReference: (id) => `Referência da encomenda: ${id}`,
  planNote: (payments, isWeekly, left, store) =>
    `Esta foi a primeira de ${payments} prestações ${isWeekly ? "semanais" : "mensais"}. ${
      left === 1
        ? `A restante é cobrada no mesmo cartão, na própria conta Stripe de ${store}, e depois dela não há mais cobranças.`
        : `As ${left} restantes são cobradas no mesmo cartão, na própria conta Stripe de ${store}, e param automaticamente depois da última.`
    }`,
  addPodcastAt: (url) => `Adicione o podcast à sua aplicação: ${url}`,
  podcastNote: (email) =>
    `Introduza ${email} nessa página e recebe de imediato uma ligação para o seu próprio feed privado. Funciona no Apple Podcasts, Overcast, Pocket Casts e na maioria das outras aplicações de podcasts, enquanto o tiver.`,
  startCourseAt: (url) => `Comece o curso: ${url}`,
  courseNote: (email) =>
    `Se carregou em «${ptStart}» depois de pagar, o curso abre de imediato nesse dispositivo. Em qualquer outro, a página do curso pede o seu email: introduza ${email} e peça por email uma ligação que dê acesso a esse dispositivo. Não há palavra-passe para criar.`,
  openWhatYouBought: (url) => `Abra o que comprou: ${url}`,
  threeDays: (ordersUrl, email, store) =>
    `Essa página tem o seu ficheiro para descarregar ou a sua ligação durante os próximos 3 dias. Depois disso não se perde: abra ${ordersUrl}, introduza ${email} e é-lhe enviada por email uma ligação para tudo o que comprou a ${store}, a qualquer momento.`,
  startTitleAt: (title, url) => `Comece ${title}: ${url}`,
  bundleCourseNote: (email) =>
    `Um curso que começou depois de pagar abre de imediato nesse dispositivo. Em qualquer outro, a página do curso pede o seu email: introduza ${email} e peça por email uma ligação que dê acesso a esse dispositivo.`,
  keyIssued: (label, key) => `${label}: ${key}`,
  keyOnItsWay: (label, store) =>
    `${label}: a caminho. As chaves de ${store} esgotaram-se no momento em que pagou; a sua ser-lhe-á enviada por email assim que forem adicionadas mais.`,
  movedToday: (zero) => `${zero} hoje. A sua subscrição foi transferida para aqui.`,
  movedCharge: (price, hasTax, date) =>
    `Hoje não foi cobrado nada. O seu primeiro pagamento aqui, de ${price}${hasTax ? " mais os impostos sobre vendas aplicáveis" : ""}, é cobrado a ${date}, no cartão que indicou. Se cancelar antes disso, não paga nada.`,
  trialCharge: (price, hasTax, days, date) =>
    `Hoje não foi cobrado nada. O seu primeiro pagamento de ${price}${hasTax ? " mais os impostos sobre vendas aplicáveis" : ""} é cobrado quando terminar o período de teste de ${days} ${plural(days, "dia", "dias")}, a ${date}, no cartão que indicou. Se cancelar antes disso, não paga nada.`,
  renews: (interval, payments) =>
    payments > 0
      ? `Esta subscrição renova-se ${ptOnce(interval)} durante ${payments} ${plural(payments, "pagamento", "pagamentos")} no total e depois termina automaticamente.`
      : `Esta subscrição renova-se ${ptOnce(interval)} até a cancelar.`,
  manageAt: (hasEnd, url, email) =>
    `Para a gerir ou cancelar por si${hasEnd ? " antes disso" : ""}, a qualquer momento e sem escrever a ninguém, abra ${url} e introduza ${email}.`,
  cancelByReply: (hasEnd, store) => `Para a cancelar${hasEnd ? " antes disso" : ""}, responda a este email e a mensagem chega a ${store}.`,
  earnBySharing: (percent, store, url) =>
    `Ganhe ${percent}${S}% ao partilhar ${store}: obtenha a sua própria ligação, sem candidatura, em ${url}`,
  storeAt: (store, url) => `${store}: ${url}`,
  questions: (store) => `Dúvidas sobre esta encomenda? Responda a este email e a mensagem chega a ${store}.`,
  paymentWent: (store) => `O pagamento foi para a própria conta Stripe de ${store}. A Marktmorgen enviou este email em nome de ${store}.`,
  trialStarted: (zero, days) => `${zero} hoje. O seu período de teste grátis de ${days} ${plural(days, "dia", "dias")} começou.`,
  discountCovered: (zero) => `${zero}. Um código de desconto cobriu o preço total.`,
  paymentsInAll: (every, payments) => `${every}, ${payments} ${plural(payments, "pagamento", "pagamentos")} no total`,
  discountToday: (now, then, hasTax, isOpenEnded) =>
    `${now} hoje, com o seu desconto. ${then ? `Cada pagamento seguinte: ${then}` : "Cada pagamento seguinte é ao preço normal da subscrição"}${hasTax ? " mais os impostos sobre vendas aplicáveis" : ""}${isOpenEnded ? ", menos o seu desconto enquanto se aplicar" : ""}.`,
  introTaxed: (now, schedule) => `${now} hoje. O preço: ${schedule}, mais os impostos sobre vendas aplicáveis.`,

  offerSubject: (store, title) => `Adicionado à sua encomenda de ${store}: ${title}`,
  offerIntro: (store) => `Adicionou algo à sua encomenda de ${store}. Esta é a sua confirmação.`,
  whatYouAdded: (title) => `O que adicionou: ${title}`,
  insideIt: (titles) => `Conteúdo: ${titles}`,
  paidOnce: (amount) => `Pago: ${amount}, cobrado uma única vez no cartão com que tinha acabado de pagar`,
  reference: (id) => `Referência: ${id}`,
  openItAt: (url) => `Abrir: ${url}`,
  offerThreeDays: (ordersUrl, email, store) =>
    `Essa página tem-no, ao lado do que comprou primeiro, durante os próximos 3 dias. Depois disso não se perde: abra ${ordersUrl}, introduza ${email} e é-lhe enviada por email uma ligação para tudo o que comprou a ${store}, a qualquer momento.`,
  copyNote: (store) => `${store} pediu-nos que lhe enviássemos isto novamente. É uma cópia da sua confirmação.`,

  downloadProblems: {
    unpaid: "Esta encomenda não foi paga.",
    processing: "Este pagamento ainda está a ser confirmado pelo banco. Tente novamente quando estiver concluído.",
    expired: "Esta ligação para descarregar expirou.",
    invalid: "Não encontrámos esta encomenda.",
    unavailable: "Esta loja ainda não pode receber pagamentos.",
    error: "Não foi possível verificar esta encomenda agora. Tente novamente.",
    refunded: "Esta encomenda foi reembolsada na totalidade, por isso o ficheiro já não pode ser descarregado.",
    purchaseCheckFailed: "Não foi possível verificar esta compra agora. Tente novamente.",
    linkExpired: "Esta ligação expirou ou esta compra não consta dela. Peça à loja uma nova ligação para as suas compras.",
    nothingToDownload: "Não há nada para descarregar aqui.",
    notADownloadPurchases: "Isto não é um ficheiro para descarregar. Abra novamente as suas compras e utilize a ligação indicada.",
    notADownloadOrder: "Isto não é um ficheiro para descarregar. Abra novamente a página da encomenda e utilize a ligação indicada.",
    productNotADownload: "Este produto não é um ficheiro para descarregar. Abra novamente a página da encomenda e utilize a ligação indicada.",
    gift: "Isto foi um presente: abre-se a partir do email enviado à pessoa a quem se destina.",
    group: "Isto foi comprado para várias pessoas: cada uma abre-o a partir da ligação no recibo.",
    nothingAdded: "Nada foi adicionado a esta encomenda.",
    addedNoPart: "Este produto adicionado não tem essa parte.",
    addedRefunded: "Este produto adicionado foi reembolsado na totalidade, por isso o ficheiro já não pode ser descarregado.",
    noFile: "Este produto não tem nenhum ficheiro.",
    addedToOrderNoPart: "O produto adicionado a esta encomenda não tem essa parte.",
    noSuchProduct: "Esta encomenda não contém esse produto.",
    tooOften: "Esta ligação foi aberta muitíssimas vezes na última hora. Tente novamente daqui a pouco.",
  },
};

export const ORDERS_WORDS: Record<LanguageCode, OrdersWords> = { en, es, fr, de, it, nl, pt };

export function ordersWords(language: unknown): OrdersWords {
  return ORDERS_WORDS[parseLanguage(language)];
}
