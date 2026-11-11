/**
 * What the page a buyer lands on after paying says (app/[handle]/thanks/page.tsx),
 * in each language a store can speak.
 *
 * The English is today's English, word for word: a store that speaks English
 * shows exactly what it showed before. Words the other areas already say the
 * same way are borrowed from them (lib/buyer-words/orders.ts, giving.ts,
 * booking.ts) rather than written twice.
 *
 * Browser-safe: plain data and small functions, nothing from the server.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** French counts 0 and 1 as singular. */
const frPlural = (n: number, one: string, many: string) => (n < 2 ? one : many);
/** The non-breaking space French puts before : ? ! ; and %. */
const S = " ";

const en = {
  pageTitle: "Your order",
  /** Beside the drawn mark once Stripe confirmed the payment (components/payment-received.tsx, 654 [WG14]). */
  paymentReceived: "Payment received",
  /** What a page that found no paid order says, by what was found instead. */
  notices: {
    unpaid: {
      title: "This order has not been paid",
      body: "If you closed the payment page before finishing, nothing was charged. You can start again from the store.",
    },
    processing: {
      title: "Your payment is on its way",
      body: "Your bank is still confirming it, which can take a few days. Nothing more is needed from you: when it clears, open this page again, or choose “Get it again” at the bottom of the store with the address you paid with.",
    },
    expired: {
      title: "This link has expired",
      body: "A download link works for three days. You have not lost what you bought: type the address you paid with on the next page, and a link to all of it is emailed to you.",
    },
    invalid: {
      title: "We could not find this order",
      body: "Check the link you were given, or write to the store.",
    },
    unavailable: {
      title: "This order cannot be checked right now",
      body: "This store's payments are not connected at the moment, so the order cannot be looked up here. If you paid, reply to your order confirmation email and it reaches the store.",
    },
    error: {
      title: "We could not check this order",
      body: "Nothing is lost. Try the link again in a moment.",
    },
    slow: {
      title: "Give it a moment",
      body: "This page was opened many times in a few minutes, so it is paused for now. Nothing is wrong with your order and nothing is lost: open your link again in a few minutes, or use the link in the email you were sent.",
    },
    refunded: {
      title: "This order was refunded",
      body: "The payment was given back in full, so what it bought no longer opens here. If you think this is a mistake, reply to the order confirmation you were emailed when you paid; it reaches the store.",
    },
  } as Record<string, { title: string; body: string }>,
  /** What the buyer's answer to an offer after paying came to (lib/upsell.ts). */
  upsellNotes: {
    done: "Your yes was received. If what you added is not shown here yet, open this page again in a minute: it is charged once at most.",
    declined: "No thanks, noted. Nothing more was charged.",
    failed: "That offer was not charged.",
    checking: "We are still hearing back from Stripe about that offer. Open this page again in a minute: it is charged once at most.",
    unavailable: "That offer is no longer open, so nothing was charged for it.",
    changed: "That offer was changed while you were reading it, so nothing was charged. Below is the offer as it is now, so you can decide again.",
  } as Record<string, string>,
  remindDayHour: ", and reminders follow a day and an hour before",
  remindHour: ", and a reminder follows an hour before",
  paid: "Paid",
  youBought: "You bought ",
  backTo: (store: string) => `Back to ${store}`,
  theAddressYouPaidWith: "the address you paid with",

  // ---- A package of calls --------------------------------------------------------------------------
  sessionsReady: (sessions: number) => `Your ${sessions} sessions are ready`,
  packageBought: (sessions: number, store: string, price: string) =>
    `, ${sessions} sessions, from ${store} for ${price}. Book each one whenever you like; nothing more is charged.`,
  bookBy: (date: string) => `Book them by ${date}.`,
  bookFirst: "Book your first session",
  noBookingLink: "We could not get your booking link just now. Refresh this page in a moment. If an email with the link reaches you, keep it to book the rest.",
  packageSameLink: (email: string) => `The same link may reach ${email} by email. If it does, keep it: it is how you book the rest.`,

  // ---- A gift ----------------------------------------------------------------------------------------
  giftOnWay: "Your gift is on its way",
  giftBoughtFor: (store: string, price: string, to: string) => ` from ${store} for ${price}, as a gift for ${to}.`,
  giftBought: (store: string, price: string) => ` from ${store} for ${price}, as a gift.`,
  giftDemo:
    "This is the demo store, which sends no email: nobody was written to and nothing was handed over. On a real store the person you named gets one email with your name, your message and a link to open it.",
  giftEmailing: (to: string, from: string, withMessage: boolean) =>
    `We are emailing ${to} now${from ? `, from ${from}` : ""}${withMessage ? ", with your message" : ""}, and a link to open it. It is theirs, on their address; you do not get a copy.`,
  giftToAddress: "It goes to the address you gave, with a link to open it.",
  receiptTo: (email: string) => `Your receipt goes to ${email}.`,

  // ---- Places for several people ---------------------------------------------------------------------
  placesReadyCount: (people: number) => `Your ${people} places are ready`,
  placesReady: "Your places are ready",
  groupBoughtFor: (store: string, forWhom: string, price: string) => ` from ${store} for ${forWhom}, for ${price}.`,
  groupBought: (store: string, price: string) => ` from ${store}, for ${price}.`,
  groupSend: (title: string) =>
    `Send it to the people it is for. Each one opens it and types their own email address. If the email with the link reaches them, opening it puts ${title} on that address, as if they had bought it.`,
  groupTakeOne: (people: number) => `Take a place yourself the same way: you paid for ${people}, and you are one of them only if you take one.`,
  groupDemo:
    "This is the demo store, which sends no email, so it makes no link and hands out no places. On a real store this page shows one link to pass on, and the same link is in your receipt: each person opens it, types their own email and has it on their own address.",
  noGroupLink: "We could not get your link just now. Refresh this page in a moment; an email with it may also reach you.",
  groupReceipt: (email: string) => `If the receipt reaches ${email}, it includes the same link: keep it, it is how the places are handed out.`,

  // ---- What was bought -------------------------------------------------------------------------------
  trialStarted: "Trial started",
  youAreBooked: "You are booked",
  thankYou: "Thank you",
  startedTrialOf: "You started a free trial of ",
  subscribedTo: "You subscribed to ",
  youBooked: "You booked ",
  /** Between the last two titles: " and " for two, ", and " for more. */
  andTwo: " and ",
  andMany: ", and ",
  listComma: ", ",
  fromStore: (store: string) => ` from ${store}`,
  nothingChargedToday: ". Nothing was charged today",
  oneSessionOfPackage: ", as one session of your package. Nothing more was charged",
  forPrice: (price: string) => ` for ${price}`,
  priceEvery: (price: string, every: string) => `${price} ${every}`,
  priceToday: (price: string) => `${price} today`,
  sentenceEnd: ".",
  /** The heading of the creator's own note after paying, when they gave it none (lib/thanks-note.ts). */
  noteFrom: (name: string) => `A note from ${name}`,
  movedStarted: "Membership moved",
  movedNote: (price: string, withTax: boolean, date: string) =>
    `Your first payment here of ${price}${withTax ? " plus any sales tax" : ""} is taken on ${date}, from the card you gave. Cancel before then and you are not charged at all.`,
  trialNote: (price: string, withTax: boolean, days: number, date: string) =>
    `Your first payment of ${price}${withTax ? " plus any sales tax" : ""} is taken when the ${days}-day trial ends, on ${date}, from the card you gave. Cancel before then and you are not charged at all.`,
  planNote: (payments: number, isWeekly: boolean, store: string) =>
    `This is the first of ${payments} ${isWeekly ? "weekly" : "monthly"} payments. The other ${payments - 1} are charged to the same card on ${store}'s own account, and the plan stops by itself after the last one. To change the card or ask about a payment, reply to your order confirmation email; it reaches ${store}.`,
  renewsForSelf: (every: string, payments: number) =>
    `This renews once ${every} for ${payments} payments in all and then ends by itself. You can cancel it yourself before that, without writing to anyone: `,
  renewsUntilSelf: (every: string) => `This renews once ${every} until you cancel it, and you can cancel it yourself at any time, without writing to anyone: `,
  manageMembership: "manage your membership",
  withEmailPaid: " with the email you paid with.",
  renewsForReply: (every: string, payments: number, store: string) =>
    `This renews once ${every} for ${payments} payments in all and then ends by itself, unless you cancel it first. The charge is made by ${store}, on their own account. To cancel, reply to your order confirmation email; it reaches them.`,
  renewsUntilReply: (every: string, store: string) =>
    `This renews once ${every} until you cancel it. The charge is made by ${store}, on their own account. To cancel, reply to your order confirmation email; it reaches them.`,
  endedTitle: "Your membership has ended",
  endedBody: "Stripe says this membership is no longer running, so what it gave you access to is closed now. Renew it and everything opens again right away.",
  renew: "Renew your membership",

  // ---- A booked call ---------------------------------------------------------------------------------
  addToCalendar: "Add to your calendar",
  joinWithLink: "Join at that time with the link above. It is also in your confirmation email, with a calendar file.",
  willSendLink: (store: string) => `${store} will send you the link to join before the call.`,
  confirmationOnWay: (email: string, reminders: string, store: string) =>
    `A confirmation is on its way to ${email}${reminders}. To cancel, reply to the confirmation; it reaches ${store}.`,
  needAnotherTime: "Need another time? ",
  moveBooking: "Move your booking",
  upToBefore: (hours: number) => `, up to ${hours} ${plural(hours, "hour", "hours")} before it starts.`,

  // ---- Handing it over -------------------------------------------------------------------------------
  bundleDownloads: (hours: number, store: string) =>
    `Downloads here work for about ${hours} more ${plural(hours, "hour", "hours")}; courses and links keep working. After that nothing is lost: choose “Get it again” at the bottom of ${store}'s page, type the address you paid with, and a link to all of it is emailed to you.`,
  addPodcastApp: "Add it to your podcast app",
  podcastFeedNote: (store: string, email: string) =>
    `You get a feed of your own, for Apple Podcasts, Overcast, Pocket Casts or most other apps. On another device, open ${store}'s store, find the podcast and ask for it by email: it goes to ${email}.`,
  startCourse: "Start the course",
  courseDeviceNote: (store: string, email: string) =>
    `On this device it opens right away. On any other, open ${store}'s store, find the course and ask for a link: it goes to ${email}. No password to make.`,
  openWhatYouBought: "Open what you bought",
  keptOnBy: (host: string, store: string) => `It is kept on ${host} by ${store}, not here. Save the address: `,
  downloadIt: "Download it",
  fileLinkWorks: (hours: number, store: string) =>
    `This link works for about ${hours} more ${plural(hours, "hour", "hours")}. After that it is not lost: choose “Get it again” at the bottom of ${store}’s page, type the address you paid with, and a new link is emailed to you.`,
  nothingAttachedStrong: "Your payment went through, but this product has nothing attached to send.",
  nothingAttachedRest: (store: string) =>
    `That is for ${store} to put right, and the charge is on their own Stripe account, so reply to your order confirmation email and it reaches them.`,
  alsoIn: (option: string) => `Also in ${option}`,
  openIt: "Open it",
  keptOnSave: (host: string, store: string) => `Kept on ${host} by ${store}. Save the address: `,
  optionLinkWorks: (hours: number, isCourse: boolean) =>
    `This link works for about ${hours} more ${plural(hours, "hour", "hours")}; the ${isCourse ? "course" : "podcast"} keeps working.`,
  alsoYours: "Also yours",
  insideIt: "Inside it",
  communityOpens: (store: string, email: string) =>
    `This purchase opens ${store}'s members' community. Come in with ${email}: a link is sent there, and there is no password to make.`,
  goCommunity: "Go to the community",

  // ---- The offer after paying ------------------------------------------------------------------------
  beforeYouGo: "Before you go",
  oneMoreThing: "One more thing",
  titleFor: (title: string, price: string) => `${title} for ${price}`,
  onItsOwn: (price: string) => `${price} on its own`,
  yesAdd: (price: string) => `Yes, buy now for ${price}`,
  noThanks: "No thanks",
  offerNote: (store: string) =>
    `Yes charges the card you just used, once, on ${store}'s own account. No thanks charges nothing. You can also simply leave this page.`,
  stillHearing: (title: string) =>
    `We are still hearing back from Stripe about ${title}. Open this page again in a minute: it is charged once at most, and it appears here as soon as it is paid.`,
  bankNotConfirmed: (title: string) => `Your bank has not confirmed ${title}, so it was not charged.`,
  notChargedCard: (title: string) => `${title} was not charged: the card you paid with could not be used for it. You can still buy it from the store.`,
  confirmationFrom: (store: string, email: string) =>
    `A confirmation from ${store} is on its way to ${email}, with how to get back to this later. The charge was made on ${store}'s own Stripe account, not ours.`,
  filedUnder: (email: string, store: string) =>
    `This order is filed under ${email}. The charge was made on ${store}'s own Stripe account, not ours, so any receipt comes from them.`,
  checkLink: "Check the link you were given.",
  getAgain: "Get what you bought again",

  // ---- Reviews and sharing ---------------------------------------------------------------------------
  howIs: (title: string) => `How is ${title}?`,
  howIsWhat: "How is what you bought?",
  reviewWhenever: (store: string) =>
    `Whenever you are ready: now, or later from the list of your purchases. Only buyers can review ${store}'s products, and yours shows as a verified purchase.`,
  earnBy: (percent: number, store: string) => `Earn ${percent}% by sharing ${store}`,
  earnHow: (percent: number, store: string) =>
    `Get your own link, without applying. When someone buys through it, you earn ${percent}% of what they paid for one-time purchases, and ${store} pays you directly.`,
  getMyLink: "Get my link",

  // ---- Paid with PayPal ------------------------------------------------------------------------------
  paidWithPayPal: "Paid with PayPal",
  boughtFrom: (store: string, price: string) => ` from ${store} for ${price}.`,
  openCourse: "Open the course",
  openPurchases: "Open your purchases",
  ppReceipt: (email: string) => `A receipt with the same link is on its way to ${email}, the address of your PayPal account.`,
  ppPaidTo: (store: string) => `Paid to ${store}'s own PayPal account.`,
  waitingPayPal: "Waiting for PayPal",
  ppNotYet: "PayPal has not confirmed this payment yet",
  ppNotYetBody:
    "Some PayPal payments, such as ones from a bank account, take a few days to clear. As soon as PayPal confirms it, what you bought is emailed to the address of your PayPal account. There is nothing more to do here.",
  tooManyTries: "That was a lot of tries in a few minutes",
  ppWrite: (store: string) => `If PayPal shows a payment to ${store}, write to them by replying to PayPal's receipt.`,
  ppCouldNotCheck: "We could not check this payment just now",
  ppCouldNotCheckBody: "If you paid, it will be handed over and your receipt emailed; refresh in a minute.",
  ppHandingOver: "Payment received, we're handing it over",
  ppHandingOverBody: (email: string) => `Your receipt will be emailed to ${email} once it is handed over. Refresh in a minute.`,
  ppRefunded: "Payment refunded",
  ppRefundedBody: "This payment was refunded in full through PayPal, so this purchase is no longer yours to open. Your PayPal account shows the refund.",
  /** A payment PayPal took back by another way than a refund: failed or declined, or a capture ever reported reversed (pre-review MEDIUM on C4-13). */
  ppTakenBack: "Payment taken back",
  ppTakenBackBody: "This payment was taken back through PayPal, so this purchase is no longer yours to open. Your PayPal account shows what happened to it.",
  waitFew: "Wait a few minutes, then open this page again.",
};

export type ThanksWords = typeof en;

const es: ThanksWords = {
  pageTitle: "Tu pedido",
  paymentReceived: "Pago recibido",
  notices: {
    unpaid: {
      title: "Este pedido no se ha pagado",
      body: "Si cerraste la página de pago antes de terminar, no se cobró nada. Puedes empezar de nuevo desde la tienda.",
    },
    processing: {
      title: "Tu pago está en camino",
      body: "Tu banco todavía lo está confirmando, lo que puede tardar unos días. No necesitas hacer nada más: cuando se confirme, vuelve a abrir esta página o elige «Volver a recibirlo» al final de la tienda con la dirección con la que pagaste.",
    },
    expired: {
      title: "Este enlace ha caducado",
      body: "Un enlace de descarga funciona tres días. No has perdido lo que compraste: escribe en la página siguiente la dirección con la que pagaste y te enviaremos por email un enlace a todo.",
    },
    invalid: {
      title: "No encontramos este pedido",
      body: "Revisa el enlace que te dieron o escribe a la tienda.",
    },
    unavailable: {
      title: "Ahora mismo no se puede comprobar este pedido",
      body: "Los pagos de esta tienda no están conectados en este momento, así que el pedido no se puede consultar aquí. Si pagaste, responde al email de confirmación del pedido y le llegará a la tienda.",
    },
    error: {
      title: "No pudimos comprobar este pedido",
      body: "No se ha perdido nada. Vuelve a probar el enlace en un momento.",
    },
    slow: {
      title: "Espera un momento",
      body: "Esta página se abrió muchas veces en pocos minutos, así que está en pausa por ahora. Tu pedido está bien y no se ha perdido nada: vuelve a abrir tu enlace dentro de unos minutos o usa el enlace del email que te enviaron.",
    },
    refunded: {
      title: "Este pedido se reembolsó",
      body: "El pago se devolvió por completo, así que lo que compró ya no se abre aquí. Si crees que es un error, responde a la confirmación del pedido que recibiste por email al pagar; le llegará a la tienda.",
    },
  },
  upsellNotes: {
    done: "Recibimos tu sí. Si lo que añadiste aún no aparece aquí, vuelve a abrir esta página en un minuto: como mucho se cobra una vez.",
    declined: "No, gracias: anotado. No se cobró nada más.",
    failed: "Esa oferta no se cobró.",
    checking: "Seguimos esperando la respuesta de Stripe sobre esa oferta. Vuelve a abrir esta página en un minuto: como mucho se cobra una vez.",
    unavailable: "Esa oferta ya no está disponible, así que no se cobró nada por ella.",
    changed: "Esa oferta cambió mientras la leías, así que no se cobró nada. Abajo está la oferta tal como es ahora, por si quieres decidir de nuevo.",
  },
  remindDayHour: ", y recibirás recordatorios un día y una hora antes",
  remindHour: ", y recibirás un recordatorio una hora antes",
  paid: "Pagado",
  youBought: "Compraste ",
  backTo: (store) => `Volver a ${store}`,
  theAddressYouPaidWith: "la dirección con la que pagaste",

  sessionsReady: (sessions) => `Tus ${sessions} sesiones están listas`,
  packageBought: (sessions, store, price) =>
    `, ${sessions} sesiones, a ${store} por ${price}. Reserva cada una cuando quieras; no se cobra nada más.`,
  bookBy: (date) => `Resérvalas antes del ${date}.`,
  bookFirst: "Reservar tu primera sesión",
  noBookingLink: "No pudimos obtener tu enlace de reserva ahora mismo. Actualiza esta página en un momento. Si recibes un email con el enlace, guárdalo para reservar las demás.",
  packageSameLink: (email) => `El mismo enlace puede llegar por email a ${email}. Si llega, guárdalo: es como reservas las demás.`,

  giftOnWay: "Tu regalo está en camino",
  giftBoughtFor: (store, price, to) => ` a ${store} por ${price}, como regalo para ${to}.`,
  giftBought: (store, price) => ` a ${store} por ${price}, como regalo.`,
  giftDemo:
    "Esta es la tienda de demostración, que no envía emails: no se escribió a nadie ni se entregó nada. En una tienda real, la persona que indicaste recibe un email con tu nombre, tu mensaje y un enlace para abrirlo.",
  giftEmailing: (to, from, withMessage) =>
    `Estamos enviando ahora un email a ${to}${from ? `, de parte de ${from}` : ""}${withMessage ? ", con tu mensaje" : ""}, y un enlace para abrirlo. Es suyo, en su dirección; tú no recibes una copia.`,
  giftToAddress: "Se envía a la dirección que indicaste, con un enlace para abrirlo.",
  receiptTo: (email) => `Tu recibo se envía a ${email}.`,

  placesReadyCount: (people) => `Tus ${people} plazas están listas`,
  placesReady: "Tus plazas están listas",
  groupBoughtFor: (store, forWhom, price) => ` a ${store} para ${forWhom}, por ${price}.`,
  groupBought: (store, price) => ` a ${store}, por ${price}.`,
  groupSend: (title) =>
    `Envíalo a las personas para quienes es. Cada una lo abre y escribe su propia dirección de email. Si le llega el email con el enlace, al abrirlo ${title} queda en esa dirección, como si lo hubiera comprado.`,
  groupTakeOne: (people) => `Toma tú una plaza de la misma manera: pagaste por ${people}, y solo ocupas una si la tomas.`,
  groupDemo:
    "Esta es la tienda de demostración, que no envía emails, así que no crea ningún enlace ni reparte plazas. En una tienda real, esta página muestra un enlace para compartir, y el mismo enlace está en tu recibo: cada persona lo abre, escribe su propio email y lo tiene en su propia dirección.",
  noGroupLink: "Ahora mismo no pudimos obtener tu enlace. Actualiza esta página en un momento; también puede llegarte por email.",
  groupReceipt: (email) => `Si el recibo llega a ${email}, incluye el mismo enlace: guárdalo, es como se reparten las plazas.`,

  trialStarted: "Prueba iniciada",
  youAreBooked: "Tienes tu reserva",
  thankYou: "Gracias",
  startedTrialOf: "Empezaste una prueba gratuita de ",
  subscribedTo: "Te suscribiste a ",
  youBooked: "Reservaste ",
  andTwo: " y ",
  andMany: " y ",
  listComma: ", ",
  fromStore: (store) => ` a ${store}`,
  nothingChargedToday: ". Hoy no se cobró nada",
  oneSessionOfPackage: ", como una sesión de tu paquete. No se cobró nada más",
  forPrice: (price) => ` por ${price}`,
  priceEvery: (price, every) => `${price} ${every}`,
  priceToday: (price) => `${price} hoy`,
  sentenceEnd: ".",
  noteFrom: (name) => `Una nota de ${name}`,
  movedStarted: "Membresía trasladada",
  movedNote: (price, withTax, date) =>
    `Tu primer pago aquí de ${price}${withTax ? " más los impuestos que correspondan" : ""} se cobra el ${date}, en la tarjeta que indicaste. Cancela antes y no se te cobra nada.`,
  trialNote: (price, withTax, days, date) =>
    `Tu primer pago de ${price}${withTax ? " más los impuestos que correspondan" : ""} se cobra al terminar la prueba de ${days} días, el ${date}, en la tarjeta que indicaste. Cancela antes y no se te cobra nada.`,
  planNote: (payments, isWeekly, store) =>
    `Este es el primero de ${payments} pagos ${isWeekly ? "semanales" : "mensuales"}. Los otros ${payments - 1} se cobran en la misma tarjeta, en la cuenta propia de ${store}, y el plan se detiene solo después del último. Para cambiar la tarjeta o preguntar por un pago, responde al email de confirmación del pedido; le llegará a ${store}.`,
  renewsForSelf: (every, payments) =>
    `Se renueva ${every} durante ${payments} pagos en total y después termina solo. Puedes cancelarlo tú antes, sin escribir a nadie: `,
  renewsUntilSelf: (every) => `Se renueva ${every} hasta que lo canceles, y puedes cancelarlo tú en cualquier momento, sin escribir a nadie: `,
  manageMembership: "gestiona tu membresía",
  withEmailPaid: " con el email con el que pagaste.",
  renewsForReply: (every, payments, store) =>
    `Se renueva ${every} durante ${payments} pagos en total y después termina solo, salvo que lo canceles antes. El cobro lo hace ${store}, en su propia cuenta. Para cancelar, responde al email de confirmación del pedido; le llegará.`,
  renewsUntilReply: (every, store) =>
    `Se renueva ${every} hasta que lo canceles. El cobro lo hace ${store}, en su propia cuenta. Para cancelar, responde al email de confirmación del pedido; le llegará.`,
  endedTitle: "Tu membresía ha terminado",
  endedBody: "Stripe indica que esta membresía ya no está activa, así que lo que te daba acceso está cerrado ahora. Renuévala y todo se vuelve a abrir enseguida.",
  renew: "Renovar tu membresía",

  addToCalendar: "Añadir a tu calendario",
  joinWithLink: "Únete a esa hora con el enlace de arriba. También está en tu email de confirmación, con un archivo de calendario.",
  willSendLink: (store) => `${store} te enviará el enlace para unirte antes de la llamada.`,
  confirmationOnWay: (email, reminders, store) =>
    `Va de camino una confirmación a ${email}${reminders}. Para cancelar, responde a la confirmación; le llegará a ${store}.`,
  needAnotherTime: "¿Necesitas otra hora? ",
  moveBooking: "Cambia tu reserva",
  upToBefore: (hours) => `, hasta ${plural(hours, "1 hora", `${hours} horas`)} antes de que empiece.`,

  bundleDownloads: (hours, store) =>
    `Las descargas de aquí funcionan unas ${plural(hours, "1 hora", `${hours} horas`)} más; los cursos y los enlaces siguen funcionando. Después no se pierde nada: elige «Volver a recibirlo» al final de la página de ${store}, escribe la dirección con la que pagaste y te enviaremos por email un enlace a todo.`,
  addPodcastApp: "Añádelo a tu app de pódcast",
  podcastFeedNote: (store, email) =>
    `Recibes un feed propio, para Apple Podcasts, Overcast, Pocket Casts o casi cualquier otra app. En otro dispositivo, abre la tienda de ${store}, busca el pódcast y pídelo por email: se envía a ${email}.`,
  startCourse: "Empezar el curso",
  courseDeviceNote: (store, email) =>
    `En este dispositivo se abre enseguida. En cualquier otro, abre la tienda de ${store}, busca el curso y pide un enlace: se envía a ${email}. Sin contraseña que crear.`,
  openWhatYouBought: "Abrir lo que compraste",
  keptOnBy: (host, store) => `Lo guarda ${store} en ${host}, no aquí. Guarda la dirección: `,
  downloadIt: "Descargarlo",
  fileLinkWorks: (hours, store) =>
    `Este enlace funciona unas ${plural(hours, "1 hora", `${hours} horas`)} más. Después no se pierde: elige «Volver a recibirlo» al final de la página de ${store}, escribe la dirección con la que pagaste y te enviaremos por email un enlace nuevo.`,
  nothingAttachedStrong: "Tu pago se realizó, pero este producto no tiene nada adjunto que enviar.",
  nothingAttachedRest: (store) =>
    `Le toca a ${store} solucionarlo, y el cobro está en su propia cuenta de Stripe, así que responde al email de confirmación del pedido y le llegará.`,
  alsoIn: (option) => `También en ${option}`,
  openIt: "Abrirlo",
  keptOnSave: (host, store) => `Lo guarda ${store} en ${host}. Guarda la dirección: `,
  optionLinkWorks: (hours, isCourse) =>
    `Este enlace funciona unas ${plural(hours, "1 hora", `${hours} horas`)} más; el ${isCourse ? "curso" : "pódcast"} sigue funcionando.`,
  alsoYours: "También es tuyo",
  insideIt: "Lo que incluye",
  communityOpens: (store, email) =>
    `Esta compra abre la comunidad de miembros de ${store}. Entra con ${email}: allí se envía un enlace, y no hay contraseña que crear.`,
  goCommunity: "Ir a la comunidad",

  beforeYouGo: "Antes de irte",
  oneMoreThing: "Una cosa más",
  titleFor: (title, price) => `${title} por ${price}`,
  onItsOwn: (price) => `${price} por separado`,
  yesAdd: (price) => `Sí, comprar ahora por ${price}`,
  noThanks: "No, gracias",
  offerNote: (store) =>
    `Sí cobra una vez en la tarjeta que acabas de usar, en la cuenta propia de ${store}. No, gracias no cobra nada. También puedes simplemente salir de esta página.`,
  stillHearing: (title) =>
    `Seguimos esperando la respuesta de Stripe sobre ${title}. Vuelve a abrir esta página en un minuto: como mucho se cobra una vez, y aparece aquí en cuanto se pague.`,
  bankNotConfirmed: (title) => `Tu banco no ha confirmado ${title}, así que no se cobró.`,
  notChargedCard: (title) => `${title} no se cobró: la tarjeta con la que pagaste no se pudo usar para ello. Todavía puedes comprarlo en la tienda.`,
  confirmationFrom: (store, email) =>
    `Va de camino a ${email} una confirmación de ${store}, con cómo volver aquí más adelante. El cobro se hizo en la propia cuenta de Stripe de ${store}, no en la nuestra.`,
  filedUnder: (email, store) =>
    `Este pedido está registrado a nombre de ${email}. El cobro se hizo en la propia cuenta de Stripe de ${store}, no en la nuestra, así que cualquier recibo viene de su parte.`,
  checkLink: "Revisa el enlace que te dieron.",
  getAgain: "Volver a recibir lo que compraste",

  howIs: (title) => `¿Qué tal ${title}?`,
  howIsWhat: "¿Qué tal lo que compraste?",
  reviewWhenever: (store) =>
    `Cuando quieras: ahora o más tarde desde la lista de tus compras. Solo quienes compran pueden reseñar los productos de ${store}, y la tuya aparece como compra verificada.`,
  earnBy: (percent, store) => `Gana un ${percent}${S}% compartiendo ${store}`,
  earnHow: (percent, store) =>
    `Consigue tu propio enlace, sin solicitarlo. Cuando alguien compre a través de él, ganas el ${percent}${S}% de lo que pague en compras únicas, y ${store} te paga directamente.`,
  getMyLink: "Conseguir mi enlace",

  paidWithPayPal: "Pagado con PayPal",
  boughtFrom: (store, price) => ` a ${store} por ${price}.`,
  openCourse: "Abrir el curso",
  openPurchases: "Abrir tus compras",
  ppReceipt: (email) => `Va de camino un recibo con el mismo enlace a ${email}, la dirección de tu cuenta de PayPal.`,
  ppPaidTo: (store) => `Pagado a la propia cuenta de PayPal de ${store}.`,
  waitingPayPal: "Esperando a PayPal",
  ppNotYet: "PayPal aún no ha confirmado este pago",
  ppNotYetBody:
    "Algunos pagos de PayPal, como los hechos desde una cuenta bancaria, tardan unos días en confirmarse. En cuanto PayPal lo confirme, lo que compraste se envía por email a la dirección de tu cuenta de PayPal. No tienes que hacer nada más aquí.",
  tooManyTries: "Fueron muchos intentos en pocos minutos",
  ppWrite: (store) => `Si PayPal muestra un pago a ${store}, escríbele respondiendo al recibo de PayPal.`,
  ppCouldNotCheck: "No pudimos comprobar este pago ahora mismo",
  ppCouldNotCheckBody: "Si pagaste, lo que compraste se te entregará y tu recibo se enviará por email; actualiza la página en un minuto.",
  ppHandingOver: "Pago recibido, lo estamos entregando",
  ppHandingOverBody: (email) => `Tu recibo se enviará por email a ${email} en cuanto se entregue. Actualiza la página en un minuto.`,
  ppRefunded: "Pago reembolsado",
  ppRefundedBody: "Este pago se reembolsó por completo a través de PayPal, así que ya no puedes abrir esta compra. Tu cuenta de PayPal muestra el reembolso.",
  ppTakenBack: "Pago revertido",
  ppTakenBackBody: "Este pago se revirtió a través de PayPal, así que ya no puedes abrir esta compra. Tu cuenta de PayPal muestra qué pasó con él.",
  waitFew: "Espera unos minutos y vuelve a abrir esta página.",
};

const fr: ThanksWords = {
  pageTitle: "Votre commande",
  paymentReceived: "Paiement reçu",
  notices: {
    unpaid: {
      title: "Cette commande n'a pas été payée",
      body: "Si vous avez fermé la page de paiement avant la fin, rien n'a été débité. Vous pouvez recommencer depuis la boutique.",
    },
    processing: {
      title: "Votre paiement est en cours",
      body: `Votre banque le confirme encore, ce qui peut prendre quelques jours. Vous n'avez rien d'autre à faire${S}: une fois confirmé, rouvrez cette page, ou choisissez «${S}Le recevoir à nouveau${S}» en bas de la boutique avec l'adresse utilisée pour payer.`,
    },
    expired: {
      title: "Ce lien a expiré",
      body: `Un lien de téléchargement fonctionne trois jours. Vous n'avez pas perdu votre achat${S}: saisissez sur la page suivante l'adresse utilisée pour payer, et un lien vers tout ce que vous avez acheté vous est envoyé par e-mail.`,
    },
    invalid: {
      title: "Nous n'avons pas trouvé cette commande",
      body: "Vérifiez le lien qui vous a été donné, ou écrivez à la boutique.",
    },
    unavailable: {
      title: "Cette commande ne peut pas être vérifiée pour le moment",
      body: "Les paiements de cette boutique ne sont pas connectés pour le moment, la commande ne peut donc pas être consultée ici. Si vous avez payé, répondez à l'e-mail de confirmation de commande et il parviendra à la boutique.",
    },
    error: {
      title: "Nous n'avons pas pu vérifier cette commande",
      body: "Rien n'est perdu. Réessayez le lien dans un instant.",
    },
    slow: {
      title: "Patientez un instant",
      body: `Cette page a été ouverte de nombreuses fois en quelques minutes, elle est donc en pause pour le moment. Votre commande n'a aucun problème et rien n'est perdu${S}: rouvrez votre lien dans quelques minutes, ou utilisez le lien de l'e-mail qui vous a été envoyé.`,
    },
    refunded: {
      title: "Cette commande a été remboursée",
      body: `Le paiement a été intégralement rendu, ce qu'il avait acheté ne s'ouvre donc plus ici. Si vous pensez qu'il s'agit d'une erreur, répondez à l'e-mail de confirmation reçu lors du paiement${S}; il parviendra à la boutique.`,
    },
  },
  upsellNotes: {
    done: `Votre oui a bien été reçu. Si ce que vous avez ajouté n'apparaît pas encore ici, rouvrez cette page dans une minute${S}: il n'est débité qu'une fois au plus.`,
    declined: "Non merci, c'est noté. Rien de plus n'a été débité.",
    failed: "Cette offre n'a pas été débitée.",
    checking: `Nous attendons encore la réponse de Stripe pour cette offre. Rouvrez cette page dans une minute${S}: elle n'est débitée qu'une fois au plus.`,
    unavailable: "Cette offre n'est plus disponible, rien n'a donc été débité pour elle.",
    changed: "Cette offre a changé pendant que vous la lisiez, rien n'a donc été débité. Elle est présentée ci-dessous telle qu'elle est maintenant, pour que vous puissiez décider à nouveau.",
  },
  remindDayHour: ", et des rappels suivront un jour et une heure avant",
  remindHour: ", et un rappel suivra une heure avant",
  paid: "Payé",
  youBought: "Vous avez acheté ",
  backTo: (store) => `Retour à ${store}`,
  theAddressYouPaidWith: "l'adresse utilisée pour payer",

  sessionsReady: (sessions) => `Vos ${sessions}${S}séances sont prêtes`,
  packageBought: (sessions, store, price) =>
    `, ${sessions}${S}séances, auprès de ${store} pour ${price}. Réservez chacune quand vous le souhaitez${S}; rien de plus n'est débité.`,
  bookBy: (date) => `À réserver avant le ${date}.`,
  bookFirst: "Réserver votre première séance",
  noBookingLink: "Nous n'avons pas pu obtenir votre lien de réservation pour l'instant. Actualisez cette page dans un instant. Si vous recevez un e-mail contenant le lien, gardez-le pour réserver les autres séances.",
  packageSameLink: (email) => `Le même lien peut arriver par e-mail à ${email}. S'il arrive, gardez-le${S}: c'est avec lui que vous réservez les autres.`,

  giftOnWay: "Votre cadeau est en route",
  giftBoughtFor: (store, price, to) => ` auprès de ${store} pour ${price}, en cadeau pour ${to}.`,
  giftBought: (store, price) => ` auprès de ${store} pour ${price}, en cadeau.`,
  giftDemo: `Ceci est la boutique de démonstration, qui n'envoie aucun e-mail${S}: personne n'a été contacté et rien n'a été remis. Dans une vraie boutique, la personne indiquée reçoit un e-mail avec votre nom, votre message et un lien pour l'ouvrir.`,
  giftEmailing: (to, from, withMessage) =>
    `Nous envoyons maintenant un e-mail à ${to}${from ? `, de la part de ${from}` : ""}${withMessage ? ", avec votre message" : ""}, et un lien pour l'ouvrir. C'est à cette personne, sur son adresse${S}; vous n'en recevez pas de copie.`,
  giftToAddress: "Il est envoyé à l'adresse indiquée, avec un lien pour l'ouvrir.",
  receiptTo: (email) => `Votre reçu est envoyé à ${email}.`,

  placesReadyCount: (people) => `Vos ${people}${S}places sont prêtes`,
  placesReady: "Vos places sont prêtes",
  groupBoughtFor: (store, forWhom, price) => ` auprès de ${store} pour ${forWhom}, pour ${price}.`,
  groupBought: (store, price) => ` auprès de ${store}, pour ${price}.`,
  groupSend: (title) =>
    `Envoyez-le aux personnes concernées. Chacune l'ouvre et saisit sa propre adresse e-mail${S}; si l'e-mail contenant le lien lui parvient, l'ouvrir met ${title} sur cette adresse, comme si elle l'avait acheté.`,
  groupTakeOne: (people) =>
    `Prenez vous-même une place de la même façon${S}: vous avez payé pour ${people}, et vous n'en faites partie que si vous en prenez une.`,
  groupDemo: `Ceci est la boutique de démonstration, qui n'envoie aucun e-mail, elle ne crée donc aucun lien et ne distribue aucune place. Dans une vraie boutique, cette page affiche un lien à transmettre, et le même lien figure sur votre reçu${S}: chaque personne l'ouvre, saisit son propre e-mail et l'a sur sa propre adresse.`,
  noGroupLink: `Nous n'avons pas pu obtenir votre lien pour l'instant. Actualisez cette page dans un instant${S}; il peut aussi vous parvenir par e-mail.`,
  groupReceipt: (email) => `Si le reçu arrive à ${email}, il contient le même lien${S}: gardez-le, c'est avec lui que les places sont distribuées.`,

  trialStarted: "Essai commencé",
  youAreBooked: "Votre réservation est faite",
  thankYou: "Merci",
  startedTrialOf: "Vous avez commencé un essai gratuit de ",
  subscribedTo: "Vous vous êtes abonné à ",
  youBooked: "Vous avez réservé ",
  andTwo: " et ",
  andMany: " et ",
  listComma: ", ",
  fromStore: (store) => ` auprès de ${store}`,
  nothingChargedToday: ". Rien n'a été débité aujourd'hui",
  oneSessionOfPackage: ", comme une séance de votre forfait. Rien de plus n'a été débité",
  forPrice: (price) => ` pour ${price}`,
  priceEvery: (price, every) => `${price} ${every}`,
  priceToday: (price) => `${price} aujourd'hui`,
  sentenceEnd: ".",
  noteFrom: (name) => `Un mot de ${name}`,
  movedStarted: "Abonnement transféré",
  movedNote: (price, withTax, date) =>
    `Votre premier paiement ici, de ${price}${withTax ? " plus les taxes éventuelles" : ""}, est prélevé le ${date}, sur la carte indiquée. Annulez avant et rien ne vous est débité.`,
  trialNote: (price, withTax, days, date) =>
    `Votre premier paiement de ${price}${withTax ? " plus les taxes éventuelles" : ""} est prélevé à la fin de l'essai de ${days}${S}jours, le ${date}, sur la carte indiquée. Annulez avant et rien ne vous est débité.`,
  planNote: (payments, isWeekly, store) =>
    `Ceci est le premier de ${payments}${S}paiements ${isWeekly ? "hebdomadaires" : "mensuels"}. Les ${payments - 1}${S}autres sont débités sur la même carte, sur le compte de ${store}, et le plan s'arrête de lui-même après le dernier. Pour changer de carte ou poser une question sur un paiement, répondez à l'e-mail de confirmation de commande${S}; il parvient à ${store}.`,
  renewsForSelf: (every, payments) =>
    `Ceci se renouvelle ${every} pour ${payments}${S}paiements au total, puis s'arrête de lui-même. Vous pouvez l'annuler vous-même avant, sans écrire à personne${S}: `,
  renewsUntilSelf: (every) =>
    `Ceci se renouvelle ${every} jusqu'à ce que vous l'annuliez, et vous pouvez l'annuler vous-même à tout moment, sans écrire à personne${S}: `,
  manageMembership: "gérer votre abonnement",
  withEmailPaid: " avec l'e-mail utilisé pour payer.",
  renewsForReply: (every, payments, store) =>
    `Ceci se renouvelle ${every} pour ${payments}${S}paiements au total, puis s'arrête de lui-même, sauf si vous l'annulez avant. Le prélèvement est fait par ${store}, sur son propre compte. Pour annuler, répondez à l'e-mail de confirmation de commande${S}; il lui parvient.`,
  renewsUntilReply: (every, store) =>
    `Ceci se renouvelle ${every} jusqu'à ce que vous l'annuliez. Le prélèvement est fait par ${store}, sur son propre compte. Pour annuler, répondez à l'e-mail de confirmation de commande${S}; il lui parvient.`,
  endedTitle: "Votre abonnement a pris fin",
  endedBody: "Stripe indique que cet abonnement n'est plus actif, ce à quoi il vous donnait accès est donc fermé. Renouvelez-le et tout se rouvre immédiatement.",
  renew: "Renouveler votre abonnement",

  addToCalendar: "Ajouter à votre agenda",
  joinWithLink: "Rejoignez-le à l'heure prévue avec le lien ci-dessus. Il figure aussi dans votre e-mail de confirmation, avec un fichier d'agenda.",
  willSendLink: (store) => `${store} vous enverra le lien pour rejoindre l'appel avant qu'il commence.`,
  confirmationOnWay: (email, reminders, store) =>
    `Une confirmation est en route vers ${email}${reminders}. Pour annuler, répondez à la confirmation${S}; elle parvient à ${store}.`,
  needAnotherTime: `Besoin d'un autre horaire${S}? `,
  moveBooking: "Déplacez votre réservation",
  upToBefore: (hours) => `, jusqu'à ${hours}${S}${frPlural(hours, "heure", "heures")} avant le début.`,

  bundleDownloads: (hours, store) =>
    `Les téléchargements ici fonctionnent encore environ ${hours}${S}${frPlural(hours, "heure", "heures")}${S}; les formations et les liens continuent de fonctionner. Ensuite, rien n'est perdu${S}: choisissez «${S}Le recevoir à nouveau${S}» en bas de la page de ${store}, saisissez l'adresse utilisée pour payer, et un lien vers tout vous est envoyé par e-mail.`,
  addPodcastApp: "L'ajouter à votre appli de podcasts",
  podcastFeedNote: (store, email) =>
    `Vous recevez un flux personnel, pour Apple Podcasts, Overcast, Pocket Casts ou la plupart des autres applis. Sur un autre appareil, ouvrez la boutique de ${store}, trouvez le podcast et demandez-le par e-mail${S}: il est envoyé à ${email}.`,
  startCourse: "Commencer la formation",
  courseDeviceNote: (store, email) =>
    `Sur cet appareil, elle s'ouvre immédiatement. Sur tout autre, ouvrez la boutique de ${store}, trouvez la formation et demandez un lien${S}: il est envoyé à ${email}. Aucun mot de passe à créer.`,
  openWhatYouBought: "Ouvrir votre achat",
  keptOnBy: (host, store) => `Il est hébergé sur ${host} par ${store}, pas ici. Gardez l'adresse${S}: `,
  downloadIt: "Le télécharger",
  fileLinkWorks: (hours, store) =>
    `Ce lien fonctionne encore environ ${hours}${S}${frPlural(hours, "heure", "heures")}. Ensuite, il n'est pas perdu${S}: choisissez «${S}Le recevoir à nouveau${S}» en bas de la page de ${store}, saisissez l'adresse utilisée pour payer, et un nouveau lien vous est envoyé par e-mail.`,
  nothingAttachedStrong: "Votre paiement est passé, mais ce produit n'a rien de joint à envoyer.",
  nothingAttachedRest: (store) =>
    `C'est à ${store} de corriger cela, et le débit est sur son propre compte Stripe${S}: répondez donc à l'e-mail de confirmation de commande et il lui parviendra.`,
  alsoIn: (option) => `Également dans ${option}`,
  openIt: "L'ouvrir",
  keptOnSave: (host, store) => `Hébergé sur ${host} par ${store}. Gardez l'adresse${S}: `,
  optionLinkWorks: (hours, isCourse) =>
    `Ce lien fonctionne encore environ ${hours}${S}${frPlural(hours, "heure", "heures")}${S}; ${isCourse ? "la formation continue" : "le podcast continue"} de fonctionner.`,
  alsoYours: "Également à vous",
  insideIt: "Ce qu'il contient",
  communityOpens: (store, email) =>
    `Cet achat ouvre la communauté des membres de ${store}. Entrez avec ${email}${S}: un lien y est envoyé, et il n'y a aucun mot de passe à créer.`,
  goCommunity: "Aller à la communauté",

  beforeYouGo: "Avant de partir",
  oneMoreThing: "Encore une chose",
  titleFor: (title, price) => `${title} pour ${price}`,
  onItsOwn: (price) => `${price} seul`,
  yesAdd: (price) => `Oui, acheter maintenant pour ${price}`,
  noThanks: "Non merci",
  offerNote: (store) =>
    `Oui débite une fois la carte que vous venez d'utiliser, sur le compte de ${store}. Non merci ne débite rien. Vous pouvez aussi simplement quitter cette page.`,
  stillHearing: (title) =>
    `Nous attendons encore la réponse de Stripe pour ${title}. Rouvrez cette page dans une minute${S}: il n'est débité qu'une fois au plus, et apparaît ici dès qu'il est payé.`,
  bankNotConfirmed: (title) => `Votre banque n'a pas confirmé ${title}, il n'a donc pas été débité.`,
  notChargedCard: (title) =>
    `${title} n'a pas été débité${S}: la carte utilisée pour payer n'a pas pu servir pour cet achat. Vous pouvez toujours l'acheter dans la boutique.`,
  confirmationFrom: (store, email) =>
    `Une confirmation de ${store} est en route vers ${email}, avec la façon de revenir ici plus tard. Le débit a été fait sur le propre compte Stripe de ${store}, pas le nôtre.`,
  filedUnder: (email, store) =>
    `Cette commande est enregistrée sous ${email}. Le débit a été fait sur le propre compte Stripe de ${store}, pas le nôtre, tout reçu vient donc de sa part.`,
  checkLink: "Vérifiez le lien qui vous a été donné.",
  getAgain: "Recevoir à nouveau votre achat",

  howIs: (title) => `Que pensez-vous de ${title}${S}?`,
  howIsWhat: `Que pensez-vous de votre achat${S}?`,
  reviewWhenever: (store) =>
    `Quand vous voulez${S}: maintenant, ou plus tard depuis la liste de vos achats. Seuls les acheteurs peuvent donner un avis sur les produits de ${store}, et le vôtre apparaît comme achat vérifié.`,
  earnBy: (percent, store) => `Gagnez ${percent}${S}% en partageant ${store}`,
  earnHow: (percent, store) =>
    `Obtenez votre propre lien, sans candidature. Quand quelqu'un achète par ce lien, vous gagnez ${percent}${S}% de ce qu'il a payé pour les achats uniques, et ${store} vous paie directement.`,
  getMyLink: "Obtenir mon lien",

  paidWithPayPal: "Payé avec PayPal",
  boughtFrom: (store, price) => ` auprès de ${store} pour ${price}.`,
  openCourse: "Ouvrir la formation",
  openPurchases: "Ouvrir vos achats",
  ppReceipt: (email) => `Un reçu avec le même lien est en route vers ${email}, l'adresse de votre compte PayPal.`,
  ppPaidTo: (store) => `Payé sur le propre compte PayPal de ${store}.`,
  waitingPayPal: "En attente de PayPal",
  ppNotYet: "PayPal n'a pas encore confirmé ce paiement",
  ppNotYetBody:
    "Certains paiements PayPal, comme ceux depuis un compte bancaire, prennent quelques jours. Dès que PayPal le confirme, votre achat est envoyé par e-mail à l'adresse de votre compte PayPal. Vous n'avez rien d'autre à faire ici.",
  tooManyTries: "Beaucoup d'essais en quelques minutes",
  ppWrite: (store) => `Si PayPal affiche un paiement à ${store}, écrivez-lui en répondant au reçu de PayPal.`,
  ppCouldNotCheck: "Nous n'avons pas pu vérifier ce paiement pour le moment",
  ppCouldNotCheckBody: "Si vous avez payé, votre achat vous sera remis et votre reçu envoyé par e-mail ; actualisez la page dans une minute.",
  ppHandingOver: "Paiement reçu, nous vous remettons votre achat",
  ppHandingOverBody: (email) => `Votre reçu sera envoyé par e-mail à ${email} dès que l'achat vous sera remis. Actualisez la page dans une minute.`,
  ppRefunded: "Paiement remboursé",
  ppRefundedBody: "Ce paiement a été remboursé en totalité via PayPal, vous ne pouvez donc plus ouvrir cet achat. Votre compte PayPal indique le remboursement.",
  ppTakenBack: "Paiement annulé",
  ppTakenBackBody: "Ce paiement a été annulé via PayPal, vous ne pouvez donc plus ouvrir cet achat. Votre compte PayPal indique ce qu'il est devenu.",
  waitFew: "Patientez quelques minutes, puis rouvrez cette page.",
};

const de: ThanksWords = {
  pageTitle: "Ihre Bestellung",
  paymentReceived: "Zahlung erhalten",
  notices: {
    unpaid: {
      title: "Diese Bestellung wurde nicht bezahlt",
      body: "Wenn Sie die Zahlungsseite vor dem Abschluss geschlossen haben, wurde nichts belastet. Sie können im Shop neu beginnen.",
    },
    processing: {
      title: "Ihre Zahlung ist unterwegs",
      body: "Ihre Bank bestätigt sie noch, was einige Tage dauern kann. Sie müssen nichts weiter tun: Sobald sie bestätigt ist, öffnen Sie diese Seite erneut oder wählen Sie unten im Shop „Erneut erhalten“ mit der Adresse, mit der Sie bezahlt haben.",
    },
    expired: {
      title: "Dieser Link ist abgelaufen",
      body: "Ein Download-Link gilt drei Tage. Ihr Kauf ist nicht verloren: Geben Sie auf der nächsten Seite die Adresse ein, mit der Sie bezahlt haben, und ein Link zu allem wird Ihnen per E-Mail geschickt.",
    },
    invalid: {
      title: "Wir konnten diese Bestellung nicht finden",
      body: "Prüfen Sie den Link, den Sie erhalten haben, oder schreiben Sie dem Shop.",
    },
    unavailable: {
      title: "Diese Bestellung kann gerade nicht geprüft werden",
      body: "Die Zahlungen dieses Shops sind im Moment nicht verbunden, daher kann die Bestellung hier nicht nachgeschlagen werden. Wenn Sie bezahlt haben, antworten Sie auf Ihre Bestellbestätigung per E-Mail, dann erreicht sie den Shop.",
    },
    error: {
      title: "Wir konnten diese Bestellung nicht prüfen",
      body: "Nichts ist verloren. Versuchen Sie den Link gleich noch einmal.",
    },
    slow: {
      title: "Einen Moment bitte",
      body: "Diese Seite wurde in wenigen Minuten sehr oft geöffnet und ist daher vorerst pausiert. Mit Ihrer Bestellung ist alles in Ordnung und nichts ist verloren: Öffnen Sie Ihren Link in ein paar Minuten erneut oder nutzen Sie den Link in der E-Mail, die Sie erhalten haben.",
    },
    refunded: {
      title: "Diese Bestellung wurde erstattet",
      body: "Die Zahlung wurde vollständig zurückgegeben, daher öffnet sich der Kauf hier nicht mehr. Wenn Sie das für einen Fehler halten, antworten Sie auf die Bestellbestätigung, die Sie beim Bezahlen per E-Mail erhalten haben; sie erreicht den Shop.",
    },
  },
  upsellNotes: {
    done: "Ihr Ja ist angekommen. Wenn Ihre Ergänzung hier noch nicht erscheint, öffnen Sie diese Seite in einer Minute erneut: Sie wird höchstens einmal belastet.",
    declined: "Nein danke, notiert. Es wurde nichts weiter belastet.",
    failed: "Dieses Angebot wurde nicht belastet.",
    checking: "Wir warten noch auf die Antwort von Stripe zu diesem Angebot. Öffnen Sie diese Seite in einer Minute erneut: Es wird höchstens einmal belastet.",
    unavailable: "Dieses Angebot gilt nicht mehr, daher wurde dafür nichts belastet.",
    changed: "Dieses Angebot wurde geändert, während Sie es gelesen haben, daher wurde nichts belastet. Unten sehen Sie das Angebot, wie es jetzt ist, damit Sie neu entscheiden können.",
  },
  remindDayHour: ", und Erinnerungen folgen einen Tag und eine Stunde vorher",
  remindHour: ", und eine Erinnerung folgt eine Stunde vorher",
  paid: "Bezahlt",
  youBought: "Sie haben gekauft: ",
  backTo: (store) => `Zurück zu ${store}`,
  theAddressYouPaidWith: "die Adresse, mit der Sie bezahlt haben",

  sessionsReady: (sessions) => `Ihre ${sessions} Termine sind bereit`,
  packageBought: (sessions, store, price) =>
    `, ${sessions} Termine, bei ${store} für ${price}. Buchen Sie jeden, wann Sie möchten; es wird nichts weiter berechnet.`,
  bookBy: (date) => `Buchen Sie sie bis zum ${date}.`,
  bookFirst: "Ersten Termin buchen",
  noBookingLink: "Wir konnten Ihren Buchungslink gerade nicht abrufen. Laden Sie diese Seite gleich neu. Falls Sie eine E-Mail mit dem Link erhalten, bewahren Sie ihn auf, um die übrigen Termine zu buchen.",
  packageSameLink: (email) => `Derselbe Link kann per E-Mail an ${email} ankommen. Falls er ankommt, bewahren Sie ihn auf: Damit buchen Sie die übrigen.`,

  giftOnWay: "Ihr Geschenk ist unterwegs",
  giftBoughtFor: (store, price, to) => ` bei ${store} für ${price}, als Geschenk für ${to}.`,
  giftBought: (store, price) => ` bei ${store} für ${price}, als Geschenk.`,
  giftDemo:
    "Dies ist der Demo-Shop, der keine E-Mails verschickt: Niemand wurde angeschrieben und nichts übergeben. In einem echten Shop erhält die genannte Person eine E-Mail mit Ihrem Namen, Ihrer Nachricht und einem Link zum Öffnen.",
  giftEmailing: (to, from, withMessage) =>
    `Wir schicken ${to} jetzt eine E-Mail${from ? `, von ${from}` : ""}${withMessage ? ", mit Ihrer Nachricht" : ""}, und einen Link zum Öffnen. Es gehört der beschenkten Person, an ihre Adresse; Sie erhalten keine Kopie.`,
  giftToAddress: "Es geht an die angegebene Adresse, mit einem Link zum Öffnen.",
  receiptTo: (email) => `Ihre Quittung geht an ${email}.`,

  placesReadyCount: (people) => `Ihre ${people} Plätze sind bereit`,
  placesReady: "Ihre Plätze sind bereit",
  groupBoughtFor: (store, forWhom, price) => ` bei ${store} für ${forWhom}, für ${price}.`,
  groupBought: (store, price) => ` bei ${store}, für ${price}.`,
  groupSend: (title) =>
    `Schicken Sie ihn an die Personen, für die er gedacht ist. Jede öffnet ihn und gibt ihre eigene E-Mail-Adresse ein. Falls die E-Mail mit dem Link sie erreicht, wird ${title} beim Öffnen dieser Adresse zugeordnet, als hätte sie es gekauft.`,
  groupTakeOne: (people) => `Nehmen Sie selbst auf dieselbe Weise einen Platz: Sie haben für ${people} bezahlt und gehören nur dazu, wenn Sie einen nehmen.`,
  groupDemo:
    "Dies ist der Demo-Shop, der keine E-Mails verschickt, daher erstellt er keinen Link und vergibt keine Plätze. In einem echten Shop zeigt diese Seite einen Link zum Weitergeben, und derselbe Link steht auf Ihrer Quittung: Jede Person öffnet ihn, gibt ihre eigene E-Mail ein und hat es auf ihrer eigenen Adresse.",
  noGroupLink: "Wir konnten Ihren Link gerade nicht abrufen. Laden Sie diese Seite gleich neu; er kann Sie auch per E-Mail erreichen.",
  groupReceipt: (email) => `Falls die Quittung ${email} erreicht, enthält sie denselben Link: Bewahren Sie ihn auf, damit werden die Plätze vergeben.`,

  trialStarted: "Testphase gestartet",
  youAreBooked: "Ihr Termin ist gebucht",
  thankYou: "Vielen Dank",
  startedTrialOf: "Sie haben eine kostenlose Testphase gestartet: ",
  subscribedTo: "Sie haben abonniert: ",
  youBooked: "Sie haben gebucht: ",
  andTwo: " und ",
  andMany: " und ",
  listComma: ", ",
  fromStore: (store) => ` bei ${store}`,
  nothingChargedToday: ". Heute wurde nichts belastet",
  oneSessionOfPackage: ", als ein Termin Ihres Pakets. Es wurde nichts weiter belastet",
  forPrice: (price) => ` für ${price}`,
  priceEvery: (price, every) => `${price} ${every}`,
  priceToday: (price) => `${price} heute`,
  sentenceEnd: ".",
  noteFrom: (name) => `Eine Nachricht von ${name}`,
  movedStarted: "Mitgliedschaft umgezogen",
  movedNote: (price, withTax, date) =>
    `Ihre erste Zahlung hier von ${price}${withTax ? " zuzüglich etwaiger Steuern" : ""} wird am ${date} von der angegebenen Karte abgebucht. Kündigen Sie vorher, wird Ihnen gar nichts berechnet.`,
  trialNote: (price, withTax, days, date) =>
    `Ihre erste Zahlung von ${price}${withTax ? " zuzüglich etwaiger Steuern" : ""} wird am Ende der ${days}-tägigen Testphase am ${date} von der angegebenen Karte abgebucht. Kündigen Sie vorher, wird Ihnen gar nichts berechnet.`,
  planNote: (payments, isWeekly, store) =>
    `Dies ist die erste von ${payments} ${isWeekly ? "wöchentlichen" : "monatlichen"} Zahlungen. Die übrigen ${payments - 1} werden von derselben Karte auf das eigene Konto von ${store} abgebucht, und der Plan endet nach der letzten von selbst. Um die Karte zu ändern oder nach einer Zahlung zu fragen, antworten Sie auf Ihre Bestellbestätigung per E-Mail; sie erreicht ${store}.`,
  renewsForSelf: (every, payments) =>
    `Dies verlängert sich ${every} für insgesamt ${payments} Zahlungen und endet dann von selbst. Sie können es vorher selbst kündigen, ohne jemandem zu schreiben: `,
  renewsUntilSelf: (every) => `Dies verlängert sich ${every}, bis Sie es kündigen, und Sie können es jederzeit selbst kündigen, ohne jemandem zu schreiben: `,
  manageMembership: "Mitgliedschaft verwalten",
  withEmailPaid: ", mit der E-Mail, mit der Sie bezahlt haben.",
  renewsForReply: (every, payments, store) =>
    `Dies verlängert sich ${every} für insgesamt ${payments} Zahlungen und endet dann von selbst, sofern Sie es nicht vorher kündigen. Die Abbuchung erfolgt durch ${store}, auf dessen eigenes Konto. Zum Kündigen antworten Sie auf Ihre Bestellbestätigung per E-Mail; sie erreicht den Shop.`,
  renewsUntilReply: (every, store) =>
    `Dies verlängert sich ${every}, bis Sie es kündigen. Die Abbuchung erfolgt durch ${store}, auf dessen eigenes Konto. Zum Kündigen antworten Sie auf Ihre Bestellbestätigung per E-Mail; sie erreicht den Shop.`,
  endedTitle: "Ihre Mitgliedschaft ist beendet",
  endedBody: "Laut Stripe läuft diese Mitgliedschaft nicht mehr, daher ist alles, wozu sie Zugang gab, jetzt geschlossen. Verlängern Sie sie, und alles öffnet sich sofort wieder.",
  renew: "Mitgliedschaft verlängern",

  addToCalendar: "Zum Kalender hinzufügen",
  joinWithLink: "Treten Sie zur vereinbarten Zeit über den Link oben bei. Er steht auch in Ihrer Bestätigungs-E-Mail, mit einer Kalenderdatei.",
  willSendLink: (store) => `${store} schickt Ihnen den Link zum Beitreten vor dem Gespräch.`,
  confirmationOnWay: (email, reminders, store) =>
    `Eine Bestätigung ist unterwegs an ${email}${reminders}. Zum Absagen antworten Sie auf die Bestätigung; sie erreicht ${store}.`,
  needAnotherTime: "Brauchen Sie eine andere Zeit? ",
  moveBooking: "Buchung verschieben",
  upToBefore: (hours) => `, bis ${hours} ${plural(hours, "Stunde", "Stunden")} vor Beginn.`,

  bundleDownloads: (hours, store) =>
    `Die Downloads hier funktionieren noch etwa ${hours} ${plural(hours, "Stunde", "Stunden")}; Kurse und Links funktionieren weiter. Danach ist nichts verloren: Wählen Sie unten auf der Seite von ${store} „Erneut erhalten“, geben Sie die Adresse ein, mit der Sie bezahlt haben, und ein Link zu allem wird Ihnen per E-Mail geschickt.`,
  addPodcastApp: "Zur Podcast-App hinzufügen",
  podcastFeedNote: (store, email) =>
    `Sie erhalten einen eigenen Feed, für Apple Podcasts, Overcast, Pocket Casts oder die meisten anderen Apps. Öffnen Sie auf einem anderen Gerät den Shop von ${store}, suchen Sie den Podcast und fordern Sie ihn per E-Mail an: Er geht an ${email}.`,
  startCourse: "Kurs starten",
  courseDeviceNote: (store, email) =>
    `Auf diesem Gerät öffnet er sich sofort. Auf jedem anderen öffnen Sie den Shop von ${store}, suchen den Kurs und fordern einen Link an: Er geht an ${email}. Kein Passwort nötig.`,
  openWhatYouBought: "Ihren Kauf öffnen",
  keptOnBy: (host, store) => `Es liegt bei ${host}, verwaltet von ${store}, nicht hier. Speichern Sie die Adresse: `,
  downloadIt: "Herunterladen",
  fileLinkWorks: (hours, store) =>
    `Dieser Link funktioniert noch etwa ${hours} ${plural(hours, "Stunde", "Stunden")}. Danach ist er nicht verloren: Wählen Sie unten auf der Seite von ${store} „Erneut erhalten“, geben Sie die Adresse ein, mit der Sie bezahlt haben, und ein neuer Link wird Ihnen per E-Mail geschickt.`,
  nothingAttachedStrong: "Ihre Zahlung ist durchgegangen, aber an dieses Produkt ist nichts zum Senden angehängt.",
  nothingAttachedRest: (store) =>
    `Das muss ${store} in Ordnung bringen, und die Belastung liegt auf dessen eigenem Stripe-Konto. Antworten Sie also auf Ihre Bestellbestätigung per E-Mail, dann erreicht sie den Shop.`,
  alsoIn: (option) => `Ebenfalls in ${option}`,
  openIt: "Öffnen",
  keptOnSave: (host, store) => `Liegt bei ${host}, verwaltet von ${store}. Speichern Sie die Adresse: `,
  optionLinkWorks: (hours, isCourse) =>
    `Dieser Link funktioniert noch etwa ${hours} ${plural(hours, "Stunde", "Stunden")}; der ${isCourse ? "Kurs" : "Podcast"} funktioniert weiter.`,
  alsoYours: "Ebenfalls Ihres",
  insideIt: "Was enthalten ist",
  communityOpens: (store, email) =>
    `Dieser Kauf öffnet die Mitglieder-Community von ${store}. Kommen Sie mit ${email} herein: Dorthin wird ein Link geschickt, und kein Passwort ist nötig.`,
  goCommunity: "Zur Community",

  beforeYouGo: "Bevor Sie gehen",
  oneMoreThing: "Noch etwas",
  titleFor: (title, price) => `${title} für ${price}`,
  onItsOwn: (price) => `${price} einzeln`,
  yesAdd: (price) => `Ja, jetzt für ${price} kaufen`,
  noThanks: "Nein danke",
  offerNote: (store) =>
    `Ja belastet die Karte, die Sie gerade benutzt haben, einmal, auf dem eigenen Konto von ${store}. Nein danke belastet nichts. Sie können diese Seite auch einfach verlassen.`,
  stillHearing: (title) =>
    `Wir warten noch auf die Antwort von Stripe zu ${title}. Öffnen Sie diese Seite in einer Minute erneut: Es wird höchstens einmal belastet und erscheint hier, sobald es bezahlt ist.`,
  bankNotConfirmed: (title) => `Ihre Bank hat ${title} nicht bestätigt, daher wurde es nicht belastet.`,
  notChargedCard: (title) =>
    `${title} wurde nicht belastet: Die Karte, mit der Sie bezahlt haben, konnte dafür nicht verwendet werden. Sie können es weiterhin im Shop kaufen.`,
  confirmationFrom: (store, email) =>
    `Eine Bestätigung von ${store} ist unterwegs an ${email}, mit dem Weg zurück hierher. Die Belastung erfolgte auf dem eigenen Stripe-Konto von ${store}, nicht auf unserem.`,
  filedUnder: (email, store) =>
    `Diese Bestellung ist unter ${email} abgelegt. Die Belastung erfolgte auf dem eigenen Stripe-Konto von ${store}, nicht auf unserem, daher kommt jede Quittung von dort.`,
  checkLink: "Prüfen Sie den Link, den Sie erhalten haben.",
  getAgain: "Ihren Kauf erneut erhalten",

  howIs: (title) => `Wie ist ${title}?`,
  howIsWhat: "Wie ist Ihr Kauf?",
  reviewWhenever: (store) =>
    `Wann immer Sie möchten: jetzt oder später über die Liste Ihrer Käufe. Nur Käufer können die Produkte von ${store} bewerten, und Ihre Bewertung erscheint als verifizierter Kauf.`,
  earnBy: (percent, store) => `Verdienen Sie ${percent}${S}%, wenn Sie ${store} teilen`,
  earnHow: (percent, store) =>
    `Holen Sie sich Ihren eigenen Link, ohne Bewerbung. Wenn jemand darüber kauft, verdienen Sie ${percent}${S}% dessen, was für Einmalkäufe bezahlt wurde, und ${store} zahlt Sie direkt aus.`,
  getMyLink: "Meinen Link holen",

  paidWithPayPal: "Mit PayPal bezahlt",
  boughtFrom: (store, price) => ` bei ${store} für ${price}.`,
  openCourse: "Kurs öffnen",
  openPurchases: "Ihre Käufe öffnen",
  ppReceipt: (email) => `Eine Quittung mit demselben Link ist unterwegs an ${email}, die Adresse Ihres PayPal-Kontos.`,
  ppPaidTo: (store) => `Bezahlt an das eigene PayPal-Konto von ${store}.`,
  waitingPayPal: "Warten auf PayPal",
  ppNotYet: "PayPal hat diese Zahlung noch nicht bestätigt",
  ppNotYetBody:
    "Manche PayPal-Zahlungen, etwa vom Bankkonto, brauchen ein paar Tage. Sobald PayPal sie bestätigt, wird Ihr Kauf an die Adresse Ihres PayPal-Kontos gemailt. Hier ist nichts weiter zu tun.",
  tooManyTries: "Das waren viele Versuche in wenigen Minuten",
  ppWrite: (store) => `Wenn PayPal eine Zahlung an ${store} zeigt, schreiben Sie, indem Sie auf die Quittung von PayPal antworten.`,
  ppCouldNotCheck: "Wir konnten diese Zahlung gerade nicht prüfen",
  ppCouldNotCheckBody: "Wenn Sie bezahlt haben, wird Ihr Kauf übergeben und Ihre Quittung gemailt; laden Sie die Seite in einer Minute neu.",
  ppHandingOver: "Zahlung erhalten, wir übergeben Ihren Kauf",
  ppHandingOverBody: (email) => `Ihre Quittung wird an ${email} gemailt, sobald der Kauf übergeben ist. Laden Sie die Seite in einer Minute neu.`,
  ppRefunded: "Zahlung erstattet",
  ppRefundedBody: "Diese Zahlung wurde über PayPal vollständig erstattet, daher können Sie diesen Kauf nicht mehr öffnen. Ihr PayPal-Konto zeigt die Erstattung.",
  ppTakenBack: "Zahlung rückgängig gemacht",
  ppTakenBackBody: "Diese Zahlung wurde über PayPal rückgängig gemacht, daher können Sie diesen Kauf nicht mehr öffnen. Ihr PayPal-Konto zeigt, was mit ihr geschehen ist.",
  waitFew: "Warten Sie ein paar Minuten und öffnen Sie diese Seite dann erneut.",
};

const it: ThanksWords = {
  pageTitle: "Il tuo ordine",
  paymentReceived: "Pagamento ricevuto",
  notices: {
    unpaid: {
      title: "Questo ordine non è stato pagato",
      body: "Se hai chiuso la pagina di pagamento prima di finire, non è stato addebitato nulla. Puoi ricominciare dal negozio.",
    },
    processing: {
      title: "Il tuo pagamento è in arrivo",
      body: "La tua banca lo sta ancora confermando, e possono volerci alcuni giorni. Non devi fare altro: quando sarà confermato, riapri questa pagina, oppure scegli «Ricevilo di nuovo» in fondo al negozio con l'indirizzo con cui hai pagato.",
    },
    expired: {
      title: "Questo link è scaduto",
      body: "Un link di download funziona per tre giorni. Non hai perso ciò che hai comprato: scrivi nella pagina successiva l'indirizzo con cui hai pagato e ti mandiamo via email un link a tutto.",
    },
    invalid: {
      title: "Non abbiamo trovato questo ordine",
      body: "Controlla il link che hai ricevuto, oppure scrivi al negozio.",
    },
    unavailable: {
      title: "Questo ordine non si può verificare in questo momento",
      body: "I pagamenti di questo negozio al momento non sono collegati, quindi l'ordine non si può consultare qui. Se hai pagato, rispondi all'email di conferma dell'ordine e arriverà al negozio.",
    },
    error: {
      title: "Non siamo riusciti a verificare questo ordine",
      body: "Non si è perso nulla. Riprova il link tra un momento.",
    },
    slow: {
      title: "Aspetta un momento",
      body: "Questa pagina è stata aperta molte volte in pochi minuti, quindi per ora è in pausa. Il tuo ordine va bene e non si è perso nulla: riapri il tuo link tra qualche minuto, oppure usa il link nell'email che hai ricevuto.",
    },
    refunded: {
      title: "Questo ordine è stato rimborsato",
      body: "Il pagamento è stato restituito per intero, quindi ciò che aveva acquistato non si apre più qui. Se pensi che sia un errore, rispondi all'email di conferma ricevuta quando hai pagato; arriverà al negozio.",
    },
  },
  upsellNotes: {
    done: "Il tuo sì è arrivato. Se ciò che hai aggiunto non compare ancora qui, riapri questa pagina tra un minuto: viene addebitato al massimo una volta.",
    declined: "No grazie, ricevuto. Non è stato addebitato altro.",
    failed: "Quell'offerta non è stata addebitata.",
    checking: "Stiamo ancora aspettando la risposta di Stripe su quell'offerta. Riapri questa pagina tra un minuto: viene addebitata al massimo una volta.",
    unavailable: "Quell'offerta non è più disponibile, quindi non è stato addebitato nulla.",
    changed: "Quell'offerta è cambiata mentre la leggevi, quindi non è stato addebitato nulla. Qui sotto trovi l'offerta com'è ora, così puoi decidere di nuovo.",
  },
  remindDayHour: ", e seguiranno promemoria un giorno e un'ora prima",
  remindHour: ", e seguirà un promemoria un'ora prima",
  paid: "Pagato",
  youBought: "Hai comprato ",
  backTo: (store) => `Torna a ${store}`,
  theAddressYouPaidWith: "l'indirizzo con cui hai pagato",

  sessionsReady: (sessions) => `Le tue ${sessions} sessioni sono pronte`,
  packageBought: (sessions, store, price) =>
    `, ${sessions} sessioni, da ${store} per ${price}. Prenota ciascuna quando vuoi; non viene addebitato altro.`,
  bookBy: (date) => `Prenotale entro il ${date}.`,
  bookFirst: "Prenota la tua prima sessione",
  noBookingLink: "Al momento non siamo riusciti a ottenere il tuo link di prenotazione. Aggiorna questa pagina tra un momento. Se ricevi un'email con il link, conservalo per prenotare le altre sessioni.",
  packageSameLink: (email) => `Lo stesso link potrebbe arrivare via email a ${email}. Se arriva, conservalo: è così che prenoti le altre.`,

  giftOnWay: "Il tuo regalo è in arrivo",
  giftBoughtFor: (store, price, to) => ` da ${store} per ${price}, come regalo per ${to}.`,
  giftBought: (store, price) => ` da ${store} per ${price}, come regalo.`,
  giftDemo:
    "Questo è il negozio dimostrativo, che non invia email: non è stato scritto a nessuno e non è stato consegnato nulla. In un negozio vero, la persona indicata riceve un'email con il tuo nome, il tuo messaggio e un link per aprirlo.",
  giftEmailing: (to, from, withMessage) =>
    `Stiamo inviando ora un'email a ${to}${from ? `, da parte di ${from}` : ""}${withMessage ? ", con il tuo messaggio" : ""}, e un link per aprirlo. È suo, sul suo indirizzo; tu non ricevi una copia.`,
  giftToAddress: "Va all'indirizzo che hai indicato, con un link per aprirlo.",
  receiptTo: (email) => `La tua ricevuta va a ${email}.`,

  placesReadyCount: (people) => `I tuoi ${people} posti sono pronti`,
  placesReady: "I tuoi posti sono pronti",
  groupBoughtFor: (store, forWhom, price) => ` da ${store} per ${forWhom}, per ${price}.`,
  groupBought: (store, price) => ` da ${store}, per ${price}.`,
  groupSend: (title) =>
    `Mandalo alle persone a cui è destinato. Ognuna lo apre e scrive il proprio indirizzo email. Se le arriva l'email con il link, aprendolo ${title} viene associato a quell'indirizzo, come se l'avesse comprato.`,
  groupTakeOne: (people) => `Prendi anche tu un posto allo stesso modo: hai pagato per ${people}, e ne fai parte solo se ne prendi uno.`,
  groupDemo:
    "Questo è il negozio dimostrativo, che non invia email, quindi non crea nessun link e non assegna posti. In un negozio vero, questa pagina mostra un link da passare, e lo stesso link è nella tua ricevuta: ogni persona lo apre, scrive la propria email e lo ha sul proprio indirizzo.",
  noGroupLink: "Al momento non siamo riusciti a ottenere il tuo link. Aggiorna questa pagina tra un momento; potrebbe anche arrivarti via email.",
  groupReceipt: (email) => `Se la ricevuta arriva a ${email}, contiene lo stesso link: conservalo, è così che si assegnano i posti.`,

  trialStarted: "Prova iniziata",
  youAreBooked: "Hai prenotato",
  thankYou: "Grazie",
  startedTrialOf: "Hai iniziato una prova gratuita di ",
  subscribedTo: "Ti sei abbonato a ",
  youBooked: "Hai prenotato ",
  andTwo: " e ",
  andMany: " e ",
  listComma: ", ",
  fromStore: (store) => ` da ${store}`,
  nothingChargedToday: ". Oggi non è stato addebitato nulla",
  oneSessionOfPackage: ", come una sessione del tuo pacchetto. Non è stato addebitato altro",
  forPrice: (price) => ` per ${price}`,
  priceEvery: (price, every) => `${price} ${every}`,
  priceToday: (price) => `${price} oggi`,
  sentenceEnd: ".",
  noteFrom: (name) => `Un messaggio da ${name}`,
  movedStarted: "Abbonamento trasferito",
  movedNote: (price, withTax, date) =>
    `Il tuo primo pagamento qui di ${price}${withTax ? " più le eventuali imposte" : ""} viene addebitato il ${date}, sulla carta che hai indicato. Annulla prima e non ti viene addebitato nulla.`,
  trialNote: (price, withTax, days, date) =>
    `Il tuo primo pagamento di ${price}${withTax ? " più le eventuali imposte" : ""} viene addebitato alla fine della prova di ${days} giorni, il ${date}, sulla carta che hai indicato. Annulla prima e non ti viene addebitato nulla.`,
  planNote: (payments, isWeekly, store) =>
    `Questo è il primo di ${payments} pagamenti ${isWeekly ? "settimanali" : "mensili"}. Gli altri ${payments - 1} vengono addebitati sulla stessa carta, sul conto di ${store}, e il piano si ferma da solo dopo l'ultimo. Per cambiare carta o chiedere di un pagamento, rispondi all'email di conferma dell'ordine; arriverà a ${store}.`,
  renewsForSelf: (every, payments) =>
    `Si rinnova ${every} per ${payments} pagamenti in tutto e poi termina da solo. Puoi annullarlo tu prima, senza scrivere a nessuno: `,
  renewsUntilSelf: (every) => `Si rinnova ${every} finché non lo annulli, e puoi annullarlo tu in qualsiasi momento, senza scrivere a nessuno: `,
  manageMembership: "gestisci il tuo abbonamento",
  withEmailPaid: " con l'email con cui hai pagato.",
  renewsForReply: (every, payments, store) =>
    `Si rinnova ${every} per ${payments} pagamenti in tutto e poi termina da solo, a meno che tu non lo annulli prima. L'addebito è fatto da ${store}, sul proprio conto. Per annullare, rispondi all'email di conferma dell'ordine; arriverà al negozio.`,
  renewsUntilReply: (every, store) =>
    `Si rinnova ${every} finché non lo annulli. L'addebito è fatto da ${store}, sul proprio conto. Per annullare, rispondi all'email di conferma dell'ordine; arriverà al negozio.`,
  endedTitle: "Il tuo abbonamento è terminato",
  endedBody: "Secondo Stripe questo abbonamento non è più attivo, quindi ciò a cui dava accesso ora è chiuso. Rinnovalo e tutto si riapre subito.",
  renew: "Rinnova il tuo abbonamento",

  addToCalendar: "Aggiungi al calendario",
  joinWithLink: "Partecipa a quell'ora con il link qui sopra. È anche nella tua email di conferma, con un file di calendario.",
  willSendLink: (store) => `${store} ti manderà il link per partecipare prima della chiamata.`,
  confirmationOnWay: (email, reminders, store) =>
    `Una conferma è in arrivo a ${email}${reminders}. Per annullare, rispondi alla conferma; arriverà a ${store}.`,
  needAnotherTime: "Ti serve un altro orario? ",
  moveBooking: "Sposta la prenotazione",
  upToBefore: (hours) => `, fino a ${plural(hours, "1 ora", `${hours} ore`)} prima dell'inizio.`,

  bundleDownloads: (hours, store) =>
    `I download qui funzionano ancora per circa ${plural(hours, "1 ora", `${hours} ore`)}; corsi e link continuano a funzionare. Dopo non si perde nulla: scegli «Ricevilo di nuovo» in fondo alla pagina di ${store}, scrivi l'indirizzo con cui hai pagato e ti mandiamo via email un link a tutto.`,
  addPodcastApp: "Aggiungilo alla tua app di podcast",
  podcastFeedNote: (store, email) =>
    `Ricevi un feed tutto tuo, per Apple Podcasts, Overcast, Pocket Casts o quasi tutte le altre app. Su un altro dispositivo, apri il negozio di ${store}, trova il podcast e richiedilo via email: arriva a ${email}.`,
  startCourse: "Inizia il corso",
  courseDeviceNote: (store, email) =>
    `Su questo dispositivo si apre subito. Su qualsiasi altro, apri il negozio di ${store}, trova il corso e chiedi un link: arriva a ${email}. Nessuna password da creare.`,
  openWhatYouBought: "Apri ciò che hai comprato",
  keptOnBy: (host, store) => `Lo conserva ${store} su ${host}, non qui. Salva l'indirizzo: `,
  downloadIt: "Scaricalo",
  fileLinkWorks: (hours, store) =>
    `Questo link funziona ancora per circa ${plural(hours, "1 ora", `${hours} ore`)}. Dopo non si perde: scegli «Ricevilo di nuovo» in fondo alla pagina di ${store}, scrivi l'indirizzo con cui hai pagato e ti mandiamo via email un nuovo link.`,
  nothingAttachedStrong: "Il tuo pagamento è andato a buon fine, ma questo prodotto non ha nulla di allegato da inviare.",
  nothingAttachedRest: (store) =>
    `Tocca a ${store} sistemarlo, e l'addebito è sul suo conto Stripe, quindi rispondi all'email di conferma dell'ordine e arriverà al negozio.`,
  alsoIn: (option) => `Incluso anche in ${option}`,
  openIt: "Aprilo",
  keptOnSave: (host, store) => `Conservato su ${host} da ${store}. Salva l'indirizzo: `,
  optionLinkWorks: (hours, isCourse) =>
    `Questo link funziona ancora per circa ${plural(hours, "1 ora", `${hours} ore`)}; il ${isCourse ? "corso" : "podcast"} continua a funzionare.`,
  alsoYours: "Anche tuo",
  insideIt: "Cosa contiene",
  communityOpens: (store, email) =>
    `Questo acquisto apre la community dei membri di ${store}. Entra con ${email}: lì arriva un link, e non c'è nessuna password da creare.`,
  goCommunity: "Vai alla community",

  beforeYouGo: "Prima di andare",
  oneMoreThing: "Un'ultima cosa",
  titleFor: (title, price) => `${title} a ${price}`,
  onItsOwn: (price) => `${price} da solo`,
  yesAdd: (price) => `Sì, acquista ora a ${price}`,
  noThanks: "No grazie",
  offerNote: (store) =>
    `Sì addebita una volta la carta che hai appena usato, sul conto di ${store}. No grazie non addebita nulla. Puoi anche semplicemente lasciare questa pagina.`,
  stillHearing: (title) =>
    `Stiamo ancora aspettando la risposta di Stripe su ${title}. Riapri questa pagina tra un minuto: viene addebitato al massimo una volta, e compare qui appena è pagato.`,
  bankNotConfirmed: (title) => `La tua banca non ha confermato ${title}, quindi non è stato addebitato.`,
  notChargedCard: (title) =>
    `${title} non è stato addebitato: la carta con cui hai pagato non si è potuta usare per questo. Puoi comunque comprarlo dal negozio.`,
  confirmationFrom: (store, email) =>
    `Una conferma da ${store} è in arrivo a ${email}, con come tornare qui più tardi. L'addebito è stato fatto sul conto Stripe di ${store}, non sul nostro.`,
  filedUnder: (email, store) =>
    `Questo ordine è registrato a nome di ${email}. L'addebito è stato fatto sul conto Stripe di ${store}, non sul nostro, quindi qualsiasi ricevuta arriva da lì.`,
  checkLink: "Controlla il link che hai ricevuto.",
  getAgain: "Ricevi di nuovo ciò che hai comprato",

  howIs: (title) => `Com'è ${title}?`,
  howIsWhat: "Com'è ciò che hai comprato?",
  reviewWhenever: (store) =>
    `Quando vuoi: ora, o più tardi dall'elenco dei tuoi acquisti. Solo chi ha comprato può recensire i prodotti di ${store}, e la tua appare come acquisto verificato.`,
  earnBy: (percent, store) => `Guadagna il ${percent}% condividendo ${store}`,
  earnHow: (percent, store) =>
    `Ottieni il tuo link, senza candidarti. Quando qualcuno compra tramite il link, guadagni il ${percent}% di quanto ha pagato per gli acquisti singoli, e ${store} ti paga direttamente.`,
  getMyLink: "Ottieni il mio link",

  paidWithPayPal: "Pagato con PayPal",
  boughtFrom: (store, price) => ` da ${store} per ${price}.`,
  openCourse: "Apri il corso",
  openPurchases: "Apri i tuoi acquisti",
  ppReceipt: (email) => `Una ricevuta con lo stesso link è in arrivo a ${email}, l'indirizzo del tuo account PayPal.`,
  ppPaidTo: (store) => `Pagato sull'account PayPal di ${store}.`,
  waitingPayPal: "In attesa di PayPal",
  ppNotYet: "PayPal non ha ancora confermato questo pagamento",
  ppNotYetBody:
    "Alcuni pagamenti PayPal, come quelli da conto bancario, richiedono alcuni giorni. Appena PayPal lo conferma, ciò che hai comprato viene inviato via email all'indirizzo del tuo account PayPal. Qui non c'è altro da fare.",
  tooManyTries: "Sono stati tanti tentativi in pochi minuti",
  ppWrite: (store) => `Se PayPal mostra un pagamento a ${store}, scrivigli rispondendo alla ricevuta di PayPal.`,
  ppCouldNotCheck: "Non siamo riusciti a verificare questo pagamento in questo momento",
  ppCouldNotCheckBody: "Se hai pagato, l'acquisto ti verrà consegnato e la ricevuta inviata via email; aggiorna la pagina tra un minuto.",
  ppHandingOver: "Pagamento ricevuto, stiamo consegnando l'acquisto",
  ppHandingOverBody: (email) => `La ricevuta verrà inviata via email a ${email} appena l'acquisto sarà consegnato. Aggiorna la pagina tra un minuto.`,
  ppRefunded: "Pagamento rimborsato",
  ppRefundedBody: "Questo pagamento è stato rimborsato per intero tramite PayPal, quindi non puoi più aprire questo acquisto. Il tuo account PayPal mostra il rimborso.",
  ppTakenBack: "Pagamento stornato",
  ppTakenBackBody: "Questo pagamento è stato stornato tramite PayPal, quindi non puoi più aprire questo acquisto. Il tuo account PayPal mostra cosa è successo.",
  waitFew: "Aspetta qualche minuto, poi riapri questa pagina.",
};

const nl: ThanksWords = {
  pageTitle: "Je bestelling",
  paymentReceived: "Betaling ontvangen",
  notices: {
    unpaid: {
      title: "Deze bestelling is niet betaald",
      body: "Als je de betaalpagina sloot voordat je klaar was, is er niets afgeschreven. Je kunt opnieuw beginnen vanuit de winkel.",
    },
    processing: {
      title: "Je betaling is onderweg",
      body: "Je bank bevestigt hem nog, wat een paar dagen kan duren. Je hoeft verder niets te doen: zodra hij rond is, open je deze pagina opnieuw, of kies je onderaan de winkel ‘Opnieuw ontvangen’ met het adres waarmee je betaalde.",
    },
    expired: {
      title: "Deze link is verlopen",
      body: "Een downloadlink werkt drie dagen. Je bent je aankoop niet kwijt: typ op de volgende pagina het adres waarmee je betaalde, en je krijgt een link naar alles per e-mail.",
    },
    invalid: {
      title: "We konden deze bestelling niet vinden",
      body: "Controleer de link die je kreeg, of schrijf de winkel.",
    },
    unavailable: {
      title: "Deze bestelling kan nu niet worden gecontroleerd",
      body: "De betalingen van deze winkel zijn op dit moment niet gekoppeld, dus de bestelling kan hier niet worden opgezocht. Heb je betaald, antwoord dan op de bevestigingsmail van je bestelling; die komt bij de winkel aan.",
    },
    error: {
      title: "We konden deze bestelling niet controleren",
      body: "Er is niets verloren. Probeer de link zo meteen opnieuw.",
    },
    slow: {
      title: "Even geduld",
      body: "Deze pagina is in een paar minuten heel vaak geopend en staat daarom even op pauze. Er is niets mis met je bestelling en niets verloren: open je link over een paar minuten opnieuw, of gebruik de link in de e-mail die je kreeg.",
    },
    refunded: {
      title: "Deze bestelling is terugbetaald",
      body: "De betaling is volledig teruggegeven, dus wat je ermee kocht opent hier niet meer. Denk je dat dit een vergissing is, antwoord dan op de bevestigingsmail die je kreeg toen je betaalde; die komt bij de winkel aan.",
    },
  },
  upsellNotes: {
    done: "Je ja is ontvangen. Staat wat je toevoegde hier nog niet, open deze pagina dan over een minuut opnieuw: het wordt hooguit één keer afgeschreven.",
    declined: "Nee bedankt, genoteerd. Er is niets meer afgeschreven.",
    failed: "Dat aanbod is niet afgeschreven.",
    checking: "We wachten nog op antwoord van Stripe over dat aanbod. Open deze pagina over een minuut opnieuw: het wordt hooguit één keer afgeschreven.",
    unavailable: "Dat aanbod geldt niet meer, dus er is niets voor afgeschreven.",
    changed: "Dat aanbod is veranderd terwijl je het las, dus er is niets afgeschreven. Hieronder staat het aanbod zoals het nu is, zodat je opnieuw kunt beslissen.",
  },
  remindDayHour: ", en herinneringen volgen een dag en een uur vooraf",
  remindHour: ", en een herinnering volgt een uur vooraf",
  paid: "Betaald",
  youBought: "Je kocht ",
  backTo: (store) => `Terug naar ${store}`,
  theAddressYouPaidWith: "het adres waarmee je betaalde",

  sessionsReady: (sessions) => `Je ${sessions} sessies staan klaar`,
  packageBought: (sessions, store, price) =>
    `, ${sessions} sessies, bij ${store} voor ${price}. Boek ze elk wanneer je wilt; er wordt niets meer afgeschreven.`,
  bookBy: (date) => `Boek ze vóór ${date}.`,
  bookFirst: "Boek je eerste sessie",
  noBookingLink: "We konden je boekingslink nu niet ophalen. Vernieuw deze pagina zo meteen. Als je een e-mail met de link ontvangt, bewaar hem dan om de rest te boeken.",
  packageSameLink: (email) => `Dezelfde link kan per e-mail aankomen op ${email}. Als hij aankomt, bewaar hem: daarmee boek je de rest.`,

  giftOnWay: "Je cadeau is onderweg",
  giftBoughtFor: (store, price, to) => ` bij ${store} voor ${price}, als cadeau voor ${to}.`,
  giftBought: (store, price) => ` bij ${store} voor ${price}, als cadeau.`,
  giftDemo:
    "Dit is de demowinkel, die geen e-mails verstuurt: niemand is aangeschreven en er is niets overgedragen. In een echte winkel krijgt de persoon die je noemde één e-mail met je naam, je bericht en een link om het te openen.",
  giftEmailing: (to, from, withMessage) =>
    `We mailen ${to} nu${from ? `, namens ${from}` : ""}${withMessage ? ", met je bericht" : ""}, en een link om het te openen. Het is van hen, op hun adres; jij krijgt geen kopie.`,
  giftToAddress: "Het gaat naar het adres dat je opgaf, met een link om het te openen.",
  receiptTo: (email) => `Je bon gaat naar ${email}.`,

  placesReadyCount: (people) => `Je ${people} plekken staan klaar`,
  placesReady: "Je plekken staan klaar",
  groupBoughtFor: (store, forWhom, price) => ` bij ${store} voor ${forWhom}, voor ${price}.`,
  groupBought: (store, price) => ` bij ${store}, voor ${price}.`,
  groupSend: (title) =>
    `Stuur hem naar de mensen voor wie hij is. Ieder opent hem en typt een eigen e-mailadres. Als de e-mail met de link aankomt, staat ${title} na het openen op dat adres, alsof die persoon het zelf kocht.`,
  groupTakeOne: (people) => `Neem zelf op dezelfde manier een plek: je betaalde voor ${people}, en je hoort er alleen bij als je er een neemt.`,
  groupDemo:
    "Dit is de demowinkel, die geen e-mails verstuurt, dus hij maakt geen link en deelt geen plekken uit. In een echte winkel toont deze pagina één link om door te geven, en dezelfde link staat op je bon: ieder opent hem, typt een eigen e-mailadres en heeft het op een eigen adres.",
  noGroupLink: "We konden je link nu niet ophalen. Vernieuw deze pagina zo meteen; hij kan je ook per e-mail bereiken.",
  groupReceipt: (email) => `Als de bon ${email} bereikt, staat dezelfde link erop: bewaar hem, daarmee worden de plekken uitgedeeld.`,

  trialStarted: "Proefperiode gestart",
  youAreBooked: "Je bent geboekt",
  thankYou: "Bedankt",
  startedTrialOf: "Je begon een gratis proefperiode van ",
  subscribedTo: "Je nam een abonnement op ",
  youBooked: "Je boekte ",
  andTwo: " en ",
  andMany: " en ",
  listComma: ", ",
  fromStore: (store) => ` bij ${store}`,
  nothingChargedToday: ". Vandaag is er niets afgeschreven",
  oneSessionOfPackage: ", als één sessie van je pakket. Er is niets meer afgeschreven",
  forPrice: (price) => ` voor ${price}`,
  priceEvery: (price, every) => `${price} ${every}`,
  priceToday: (price) => `${price} vandaag`,
  sentenceEnd: ".",
  noteFrom: (name) => `Een bericht van ${name}`,
  movedStarted: "Lidmaatschap verhuisd",
  movedNote: (price, withTax, date) =>
    `Je eerste betaling hier van ${price}${withTax ? " plus eventuele btw" : ""} wordt op ${date} afgeschreven van de kaart die je opgaf. Zeg je vóór die tijd op, dan betaal je helemaal niets.`,
  trialNote: (price, withTax, days, date) =>
    `Je eerste betaling van ${price}${withTax ? " plus eventuele btw" : ""} wordt afgeschreven als de proefperiode van ${days} dagen eindigt, op ${date}, van de kaart die je opgaf. Zeg je vóór die tijd op, dan betaal je helemaal niets.`,
  planNote: (payments, isWeekly, store) =>
    `Dit is de eerste van ${payments} ${isWeekly ? "wekelijkse" : "maandelijkse"} betalingen. De andere ${payments - 1} worden van dezelfde kaart afgeschreven op de eigen rekening van ${store}, en het plan stopt vanzelf na de laatste. Wil je de kaart wijzigen of iets vragen over een betaling, antwoord dan op de bevestigingsmail van je bestelling; die komt bij ${store} aan.`,
  renewsForSelf: (every, payments) =>
    `Dit verlengt ${every} voor ${payments} betalingen in totaal en stopt daarna vanzelf. Je kunt het vóór die tijd zelf opzeggen, zonder iemand te schrijven: `,
  renewsUntilSelf: (every) => `Dit verlengt ${every} tot je het opzegt, en je kunt het op elk moment zelf opzeggen, zonder iemand te schrijven: `,
  manageMembership: "beheer je lidmaatschap",
  withEmailPaid: " met het e-mailadres waarmee je betaalde.",
  renewsForReply: (every, payments, store) =>
    `Dit verlengt ${every} voor ${payments} betalingen in totaal en stopt daarna vanzelf, tenzij je het eerder opzegt. De afschrijving gebeurt door ${store}, op een eigen rekening. Om op te zeggen, antwoord je op de bevestigingsmail van je bestelling; die komt bij de winkel aan.`,
  renewsUntilReply: (every, store) =>
    `Dit verlengt ${every} tot je het opzegt. De afschrijving gebeurt door ${store}, op een eigen rekening. Om op te zeggen, antwoord je op de bevestigingsmail van je bestelling; die komt bij de winkel aan.`,
  endedTitle: "Je lidmaatschap is beëindigd",
  endedBody: "Volgens Stripe loopt dit lidmaatschap niet meer, dus waar het je toegang toe gaf, is nu gesloten. Verleng het en alles gaat meteen weer open.",
  renew: "Verleng je lidmaatschap",

  addToCalendar: "Toevoegen aan je agenda",
  joinWithLink: "Doe op dat tijdstip mee via de link hierboven. Hij staat ook in je bevestigingsmail, met een agendabestand.",
  willSendLink: (store) => `${store} stuurt je de link om mee te doen vóór het gesprek.`,
  confirmationOnWay: (email, reminders, store) =>
    `Er is een bevestiging onderweg naar ${email}${reminders}. Om af te zeggen, antwoord je op de bevestiging; die komt bij ${store} aan.`,
  needAnotherTime: "Een ander tijdstip nodig? ",
  moveBooking: "Verplaats je boeking",
  upToBefore: (hours) => `, tot ${hours} uur voor het begin.`,

  bundleDownloads: (hours, store) =>
    `De downloads hier werken nog ongeveer ${hours} uur; cursussen en links blijven werken. Daarna is niets verloren: kies ‘Opnieuw ontvangen’ onderaan de pagina van ${store}, typ het adres waarmee je betaalde, en je krijgt een link naar alles per e-mail.`,
  addPodcastApp: "Voeg hem toe aan je podcastapp",
  podcastFeedNote: (store, email) =>
    `Je krijgt een eigen feed, voor Apple Podcasts, Overcast, Pocket Casts of de meeste andere apps. Open op een ander apparaat de winkel van ${store}, zoek de podcast en vraag hem per e-mail aan: hij gaat naar ${email}.`,
  startCourse: "Start de cursus",
  courseDeviceNote: (store, email) =>
    `Op dit apparaat opent hij meteen. Op elk ander apparaat open je de winkel van ${store}, zoek je de cursus en vraag je een link aan: die gaat naar ${email}. Geen wachtwoord nodig.`,
  openWhatYouBought: "Open wat je kocht",
  keptOnBy: (host, store) => `Het staat op ${host}, beheerd door ${store}, niet hier. Bewaar het adres: `,
  downloadIt: "Downloaden",
  fileLinkWorks: (hours, store) =>
    `Deze link werkt nog ongeveer ${hours} uur. Daarna is hij niet verloren: kies ‘Opnieuw ontvangen’ onderaan de pagina van ${store}, typ het adres waarmee je betaalde, en je krijgt een nieuwe link per e-mail.`,
  nothingAttachedStrong: "Je betaling is gelukt, maar aan dit product is niets gekoppeld om te versturen.",
  nothingAttachedRest: (store) =>
    `Dat moet ${store} rechtzetten, en de afschrijving staat op een eigen Stripe-rekening, dus antwoord op de bevestigingsmail van je bestelling en die komt bij de winkel aan.`,
  alsoIn: (option) => `Ook in ${option}`,
  openIt: "Openen",
  keptOnSave: (host, store) => `Staat op ${host}, beheerd door ${store}. Bewaar het adres: `,
  optionLinkWorks: (hours, isCourse) =>
    `Deze link werkt nog ongeveer ${hours} uur; de ${isCourse ? "cursus" : "podcast"} blijft werken.`,
  alsoYours: "Ook van jou",
  insideIt: "Wat erin zit",
  communityOpens: (store, email) =>
    `Deze aankoop opent de ledencommunity van ${store}. Kom binnen met ${email}: daar wordt een link naartoe gestuurd, en je hoeft geen wachtwoord te maken.`,
  goCommunity: "Naar de community",

  beforeYouGo: "Voordat je gaat",
  oneMoreThing: "Nog één ding",
  titleFor: (title, price) => `${title} voor ${price}`,
  onItsOwn: (price) => `${price} los`,
  yesAdd: (price) => `Ja, nu kopen voor ${price}`,
  noThanks: "Nee bedankt",
  offerNote: (store) =>
    `Ja schrijft één keer af van de kaart die je net gebruikte, op de eigen rekening van ${store}. Nee bedankt schrijft niets af. Je kunt deze pagina ook gewoon verlaten.`,
  stillHearing: (title) =>
    `We wachten nog op antwoord van Stripe over ${title}. Open deze pagina over een minuut opnieuw: het wordt hooguit één keer afgeschreven, en het verschijnt hier zodra het betaald is.`,
  bankNotConfirmed: (title) => `Je bank heeft ${title} niet bevestigd, dus het is niet afgeschreven.`,
  notChargedCard: (title) =>
    `${title} is niet afgeschreven: de kaart waarmee je betaalde kon er niet voor worden gebruikt. Je kunt het nog steeds in de winkel kopen.`,
  confirmationFrom: (store, email) =>
    `Er is een bevestiging van ${store} onderweg naar ${email}, met hoe je hier later terugkomt. De afschrijving gebeurde op de eigen Stripe-rekening van ${store}, niet op die van ons.`,
  filedUnder: (email, store) =>
    `Deze bestelling staat op naam van ${email}. De afschrijving gebeurde op de eigen Stripe-rekening van ${store}, niet op die van ons, dus een eventuele bon komt van hen.`,
  checkLink: "Controleer de link die je kreeg.",
  getAgain: "Ontvang je aankoop opnieuw",

  howIs: (title) => `Hoe bevalt ${title}?`,
  howIsWhat: "Hoe bevalt je aankoop?",
  reviewWhenever: (store) =>
    `Wanneer je wilt: nu, of later vanuit de lijst met je aankopen. Alleen kopers kunnen de producten van ${store} beoordelen, en die van jou staat er als geverifieerde aankoop.`,
  earnBy: (percent, store) => `Verdien ${percent}% door ${store} te delen`,
  earnHow: (percent, store) =>
    `Krijg je eigen link, zonder aanmelding. Als iemand via jouw link koopt, verdien je ${percent}% van wat diegene betaalde voor eenmalige aankopen, en ${store} betaalt je rechtstreeks.`,
  getMyLink: "Mijn link ophalen",

  paidWithPayPal: "Betaald met PayPal",
  boughtFrom: (store, price) => ` bij ${store} voor ${price}.`,
  openCourse: "Open de cursus",
  openPurchases: "Open je aankopen",
  ppReceipt: (email) => `Er is een bon met dezelfde link onderweg naar ${email}, het adres van je PayPal-rekening.`,
  ppPaidTo: (store) => `Betaald aan de eigen PayPal-rekening van ${store}.`,
  waitingPayPal: "Wachten op PayPal",
  ppNotYet: "PayPal heeft deze betaling nog niet bevestigd",
  ppNotYetBody:
    "Sommige PayPal-betalingen, zoals die vanaf een bankrekening, duren een paar dagen. Zodra PayPal hem bevestigt, wordt wat je kocht gemaild naar het adres van je PayPal-rekening. Je hoeft hier verder niets te doen.",
  tooManyTries: "Dat waren veel pogingen in een paar minuten",
  ppWrite: (store) => `Toont PayPal een betaling aan ${store}, schrijf hen dan door op de bon van PayPal te antwoorden.`,
  ppCouldNotCheck: "We konden deze betaling nu niet controleren",
  ppCouldNotCheckBody: "Heb je betaald, dan wordt je aankoop overgedragen en je bon gemaild; vernieuw de pagina over een minuut.",
  ppHandingOver: "Betaling ontvangen, we dragen je aankoop over",
  ppHandingOverBody: (email) => `Je bon wordt naar ${email} gemaild zodra de aankoop is overgedragen. Vernieuw de pagina over een minuut.`,
  ppRefunded: "Betaling terugbetaald",
  ppRefundedBody: "Deze betaling is volledig terugbetaald via PayPal, dus je kunt deze aankoop niet meer openen. Je PayPal-rekening toont de terugbetaling.",
  ppTakenBack: "Betaling teruggedraaid",
  ppTakenBackBody: "Deze betaling is via PayPal teruggedraaid, dus je kunt deze aankoop niet meer openen. Je PayPal-rekening toont wat ermee is gebeurd.",
  waitFew: "Wacht een paar minuten en open deze pagina dan opnieuw.",
};

const pt: ThanksWords = {
  pageTitle: "A sua encomenda",
  paymentReceived: "Pagamento recebido",
  notices: {
    unpaid: {
      title: "Esta encomenda não foi paga",
      body: "Se fechou a página de pagamento antes de terminar, nada foi cobrado. Pode recomeçar a partir da loja.",
    },
    processing: {
      title: "O seu pagamento está a caminho",
      body: "O seu banco ainda o está a confirmar, o que pode demorar alguns dias. Não precisa de fazer mais nada: quando for confirmado, abra novamente esta página, ou escolha «Receber de novo» no fundo da loja com o endereço com que pagou.",
    },
    expired: {
      title: "Esta ligação expirou",
      body: "Uma ligação de transferência funciona durante três dias. Não perdeu o que comprou: escreva na página seguinte o endereço com que pagou, e uma ligação para tudo é-lhe enviada por email.",
    },
    invalid: {
      title: "Não encontrámos esta encomenda",
      body: "Verifique a ligação que recebeu, ou escreva à loja.",
    },
    unavailable: {
      title: "Neste momento não é possível verificar esta encomenda",
      body: "Os pagamentos desta loja não estão ligados de momento, por isso a encomenda não pode ser consultada aqui. Se pagou, responda ao email de confirmação da encomenda e ele chega à loja.",
    },
    error: {
      title: "Não conseguimos verificar esta encomenda",
      body: "Nada se perdeu. Tente a ligação novamente daqui a pouco.",
    },
    slow: {
      title: "Aguarde um momento",
      body: "Esta página foi aberta muitas vezes em poucos minutos, por isso está em pausa por agora. A sua encomenda está bem e nada se perdeu: abra a sua ligação novamente daqui a alguns minutos, ou use a ligação do email que recebeu.",
    },
    refunded: {
      title: "Esta encomenda foi reembolsada",
      body: "O pagamento foi devolvido na totalidade, por isso o que comprou já não abre aqui. Se acha que é um erro, responda à confirmação da encomenda que recebeu por email quando pagou; ela chega à loja.",
    },
  },
  upsellNotes: {
    done: "O seu sim foi recebido. Se o que acrescentou ainda não aparece aqui, abra esta página novamente daqui a um minuto: é cobrado no máximo uma vez.",
    declined: "Não, obrigado: registado. Nada mais foi cobrado.",
    failed: "Essa oferta não foi cobrada.",
    checking: "Ainda estamos a aguardar a resposta da Stripe sobre essa oferta. Abra esta página novamente daqui a um minuto: é cobrada no máximo uma vez.",
    unavailable: "Essa oferta já não está disponível, por isso nada foi cobrado por ela.",
    changed: "Essa oferta foi alterada enquanto a lia, por isso nada foi cobrado. Abaixo está a oferta tal como é agora, para que possa decidir de novo.",
  },
  remindDayHour: ", e seguem-se lembretes um dia e uma hora antes",
  remindHour: ", e segue-se um lembrete uma hora antes",
  paid: "Pago",
  youBought: "Comprou ",
  backTo: (store) => `Voltar a ${store}`,
  theAddressYouPaidWith: "o endereço com que pagou",

  sessionsReady: (sessions) => `As suas ${sessions} sessões estão prontas`,
  packageBought: (sessions, store, price) =>
    `, ${sessions} sessões, a ${store} por ${price}. Marque cada uma quando quiser; nada mais é cobrado.`,
  bookBy: (date) => `Marque-as até ${date}.`,
  bookFirst: "Marcar a primeira sessão",
  noBookingLink: "Não conseguimos obter a sua ligação de marcação neste momento. Atualize esta página daqui a pouco. Se receber um email com a ligação, guarde-a para marcar as restantes sessões.",
  packageSameLink: (email) => `A mesma ligação pode chegar por email a ${email}. Se chegar, guarde-a: é com ela que marca as restantes.`,

  giftOnWay: "O seu presente está a caminho",
  giftBoughtFor: (store, price, to) => ` a ${store} por ${price}, como presente para ${to}.`,
  giftBought: (store, price) => ` a ${store} por ${price}, como presente.`,
  giftDemo:
    "Esta é a loja de demonstração, que não envia emails: não se escreveu a ninguém nem se entregou nada. Numa loja real, a pessoa indicada recebe um email com o seu nome, a sua mensagem e uma ligação para o abrir.",
  giftEmailing: (to, from, withMessage) =>
    `Estamos agora a enviar um email a ${to}${from ? `, da parte de ${from}` : ""}${withMessage ? ", com a sua mensagem" : ""}, e uma ligação para o abrir. É dessa pessoa, no endereço dela; não recebe uma cópia.`,
  giftToAddress: "Vai para o endereço que indicou, com uma ligação para o abrir.",
  receiptTo: (email) => `O seu recibo vai para ${email}.`,

  placesReadyCount: (people) => `Os seus ${people} lugares estão prontos`,
  placesReady: "Os seus lugares estão prontos",
  groupBoughtFor: (store, forWhom, price) => ` a ${store} para ${forWhom}, por ${price}.`,
  groupBought: (store, price) => ` a ${store}, por ${price}.`,
  groupSend: (title) =>
    `Envie-a às pessoas a quem se destina. Cada uma abre-a e escreve o próprio endereço de email. Se o email com a ligação lhe chegar, ao abri-la ${title} fica associado a esse endereço, como se o tivesse comprado.`,
  groupTakeOne: (people) => `Fique também com um lugar da mesma forma: pagou por ${people}, e só faz parte delas se ficar com um.`,
  groupDemo:
    "Esta é a loja de demonstração, que não envia emails, por isso não cria nenhuma ligação nem distribui lugares. Numa loja real, esta página mostra uma ligação para partilhar, e a mesma ligação está no seu recibo: cada pessoa abre-a, escreve o próprio email e fica com ele no próprio endereço.",
  noGroupLink: "Não conseguimos obter a sua ligação neste momento. Atualize esta página daqui a pouco; também pode chegar-lhe por email.",
  groupReceipt: (email) => `Se o recibo chegar a ${email}, inclui a mesma ligação: guarde-a, é com ela que os lugares são distribuídos.`,

  trialStarted: "Período experimental iniciado",
  youAreBooked: "A sua marcação está feita",
  thankYou: "Obrigado",
  startedTrialOf: "Iniciou um período experimental gratuito de ",
  subscribedTo: "Subscreveu ",
  youBooked: "Marcou ",
  andTwo: " e ",
  andMany: " e ",
  listComma: ", ",
  fromStore: (store) => ` a ${store}`,
  nothingChargedToday: ". Hoje nada foi cobrado",
  oneSessionOfPackage: ", como uma sessão do seu pacote. Nada mais foi cobrado",
  forPrice: (price) => ` por ${price}`,
  priceEvery: (price, every) => `${price} ${every}`,
  priceToday: (price) => `${price} hoje`,
  sentenceEnd: ".",
  noteFrom: (name) => `Uma nota de ${name}`,
  movedStarted: "Subscrição transferida",
  movedNote: (price, withTax, date) =>
    `O seu primeiro pagamento aqui, de ${price}${withTax ? " mais os impostos aplicáveis" : ""}, é cobrado a ${date}, no cartão que indicou. Cancele antes e não lhe é cobrado nada.`,
  trialNote: (price, withTax, days, date) =>
    `O seu primeiro pagamento de ${price}${withTax ? " mais os impostos aplicáveis" : ""} é cobrado quando terminar o período experimental de ${days} dias, a ${date}, no cartão que indicou. Cancele antes e não lhe é cobrado nada.`,
  planNote: (payments, isWeekly, store) =>
    `Este é o primeiro de ${payments} pagamentos ${isWeekly ? "semanais" : "mensais"}. Os outros ${payments - 1} são cobrados no mesmo cartão, na conta própria de ${store}, e o plano termina sozinho depois do último. Para mudar o cartão ou perguntar por um pagamento, responda ao email de confirmação da encomenda; ele chega a ${store}.`,
  renewsForSelf: (every, payments) =>
    `Renova-se ${every} durante ${payments} pagamentos no total e depois termina sozinho. Pode cancelá-lo antes, sem escrever a ninguém: `,
  renewsUntilSelf: (every) => `Renova-se ${every} até o cancelar, e pode cancelá-lo a qualquer momento, sem escrever a ninguém: `,
  manageMembership: "gerir a sua subscrição",
  withEmailPaid: " com o email com que pagou.",
  renewsForReply: (every, payments, store) =>
    `Renova-se ${every} durante ${payments} pagamentos no total e depois termina sozinho, a menos que o cancele antes. A cobrança é feita por ${store}, na sua própria conta. Para cancelar, responda ao email de confirmação da encomenda; ele chega à loja.`,
  renewsUntilReply: (every, store) =>
    `Renova-se ${every} até o cancelar. A cobrança é feita por ${store}, na sua própria conta. Para cancelar, responda ao email de confirmação da encomenda; ele chega à loja.`,
  endedTitle: "A sua subscrição terminou",
  endedBody: "Segundo a Stripe, esta subscrição já não está ativa, por isso aquilo a que dava acesso está agora fechado. Renove-a e tudo volta a abrir de imediato.",
  renew: "Renovar a sua subscrição",

  addToCalendar: "Adicionar ao seu calendário",
  joinWithLink: "Entre a essa hora com a ligação acima. Também está no seu email de confirmação, com um ficheiro de calendário.",
  willSendLink: (store) => `${store} vai enviar-lhe a ligação para entrar antes da chamada.`,
  confirmationOnWay: (email, reminders, store) =>
    `Vai a caminho uma confirmação para ${email}${reminders}. Para cancelar, responda à confirmação; ela chega a ${store}.`,
  needAnotherTime: "Precisa de outra hora? ",
  moveBooking: "Mude a sua marcação",
  upToBefore: (hours) => `, até ${plural(hours, "1 hora", `${hours} horas`)} antes do início.`,

  bundleDownloads: (hours, store) =>
    `As transferências aqui funcionam durante mais ${plural(hours, "1 hora", `${hours} horas`)}, aproximadamente; os cursos e as ligações continuam a funcionar. Depois disso nada se perde: escolha «Receber de novo» no fundo da página de ${store}, escreva o endereço com que pagou, e uma ligação para tudo é-lhe enviada por email.`,
  addPodcastApp: "Adicionar à sua aplicação de podcasts",
  podcastFeedNote: (store, email) =>
    `Recebe um feed próprio, para Apple Podcasts, Overcast, Pocket Casts ou a maioria das outras aplicações. Noutro dispositivo, abra a loja de ${store}, encontre o podcast e peça-o por email: vai para ${email}.`,
  startCourse: "Começar o curso",
  courseDeviceNote: (store, email) =>
    `Neste dispositivo abre de imediato. Em qualquer outro, abra a loja de ${store}, encontre o curso e peça uma ligação: vai para ${email}. Sem palavra-passe para criar.`,
  openWhatYouBought: "Abrir o que comprou",
  keptOnBy: (host, store) => `Está guardado em ${host} por ${store}, não aqui. Guarde o endereço: `,
  downloadIt: "Transferir",
  fileLinkWorks: (hours, store) =>
    `Esta ligação funciona durante mais ${plural(hours, "1 hora", `${hours} horas`)}, aproximadamente. Depois disso não se perde: escolha «Receber de novo» no fundo da página de ${store}, escreva o endereço com que pagou, e uma nova ligação é-lhe enviada por email.`,
  nothingAttachedStrong: "O seu pagamento foi concluído, mas este produto não tem nada anexado para enviar.",
  nothingAttachedRest: (store) =>
    `Cabe a ${store} resolver isto, e a cobrança está na sua própria conta Stripe, por isso responda ao email de confirmação da encomenda e ele chega à loja.`,
  alsoIn: (option) => `Também incluído em ${option}`,
  openIt: "Abrir",
  keptOnSave: (host, store) => `Guardado em ${host} por ${store}. Guarde o endereço: `,
  optionLinkWorks: (hours, isCourse) =>
    `Esta ligação funciona durante mais ${plural(hours, "1 hora", `${hours} horas`)}, aproximadamente; o ${isCourse ? "curso" : "podcast"} continua a funcionar.`,
  alsoYours: "Também é seu",
  insideIt: "O que inclui",
  communityOpens: (store, email) =>
    `Esta compra abre a comunidade de membros de ${store}. Entre com ${email}: é enviada uma ligação para lá, e não há palavra-passe para criar.`,
  goCommunity: "Ir para a comunidade",

  beforeYouGo: "Antes de sair",
  oneMoreThing: "Só mais uma coisa",
  titleFor: (title, price) => `${title} por ${price}`,
  onItsOwn: (price) => `${price} em separado`,
  yesAdd: (price) => `Sim, comprar agora por ${price}`,
  noThanks: "Não, obrigado",
  offerNote: (store) =>
    `Sim cobra uma vez o cartão que acabou de usar, na conta própria de ${store}. Não, obrigado não cobra nada. Também pode simplesmente sair desta página.`,
  stillHearing: (title) =>
    `Ainda estamos a aguardar a resposta da Stripe sobre ${title}. Abra esta página novamente daqui a um minuto: é cobrado no máximo uma vez, e aparece aqui assim que for pago.`,
  bankNotConfirmed: (title) => `O seu banco não confirmou ${title}, por isso não foi cobrado.`,
  notChargedCard: (title) =>
    `${title} não foi cobrado: o cartão com que pagou não pôde ser usado para isso. Ainda o pode comprar na loja.`,
  confirmationFrom: (store, email) =>
    `Vai a caminho de ${email} uma confirmação de ${store}, com a forma de voltar aqui mais tarde. A cobrança foi feita na conta Stripe própria de ${store}, não na nossa.`,
  filedUnder: (email, store) =>
    `Esta encomenda está registada em ${email}. A cobrança foi feita na conta Stripe própria de ${store}, não na nossa, por isso qualquer recibo vem de lá.`,
  checkLink: "Verifique a ligação que recebeu.",
  getAgain: "Receber de novo o que comprou",

  howIs: (title) => `Que tal ${title}?`,
  howIsWhat: "Que tal o que comprou?",
  reviewWhenever: (store) =>
    `Quando quiser: agora, ou mais tarde a partir da lista das suas compras. Só quem comprou pode avaliar os produtos de ${store}, e a sua avaliação aparece como compra verificada.`,
  earnBy: (percent, store) => `Ganhe ${percent}% ao partilhar ${store}`,
  earnHow: (percent, store) =>
    `Obtenha a sua própria ligação, sem candidatura. Quando alguém comprar através dela, ganha ${percent}% do que essa pessoa pagou em compras únicas, e ${store} paga-lhe diretamente.`,
  getMyLink: "Obter a minha ligação",

  paidWithPayPal: "Pago com PayPal",
  boughtFrom: (store, price) => ` a ${store} por ${price}.`,
  openCourse: "Abrir o curso",
  openPurchases: "Abrir as suas compras",
  ppReceipt: (email) => `Vai a caminho de ${email}, o endereço da sua conta PayPal, um recibo com a mesma ligação.`,
  ppPaidTo: (store) => `Pago na conta PayPal própria de ${store}.`,
  waitingPayPal: "A aguardar o PayPal",
  ppNotYet: "O PayPal ainda não confirmou este pagamento",
  ppNotYetBody:
    "Alguns pagamentos PayPal, como os feitos a partir de uma conta bancária, demoram alguns dias. Assim que o PayPal o confirmar, o que comprou é enviado por email para o endereço da sua conta PayPal. Não há mais nada a fazer aqui.",
  tooManyTries: "Foram muitas tentativas em poucos minutos",
  ppWrite: (store) => `Se o PayPal mostrar um pagamento a ${store}, escreva-lhe respondendo ao recibo do PayPal.`,
  ppCouldNotCheck: "Não foi possível verificar este pagamento agora",
  ppCouldNotCheckBody: "Se pagou, a compra será entregue e o recibo enviado por email; atualize a página dentro de um minuto.",
  ppHandingOver: "Pagamento recebido, estamos a entregar a sua compra",
  ppHandingOverBody: (email) => `O recibo será enviado por email para ${email} assim que a compra for entregue. Atualize a página dentro de um minuto.`,
  ppRefunded: "Pagamento reembolsado",
  ppRefundedBody: "Este pagamento foi reembolsado na totalidade através do PayPal, por isso já não pode abrir esta compra. A sua conta PayPal mostra o reembolso.",
  ppTakenBack: "Pagamento revertido",
  ppTakenBackBody: "Este pagamento foi revertido através do PayPal, por isso já não pode abrir esta compra. A sua conta PayPal mostra o que aconteceu.",
  waitFew: "Aguarde alguns minutos e depois abra esta página novamente.",
};

export const THANKS_WORDS: Record<LanguageCode, ThanksWords> = { en, es, fr, de, it, nl, pt };

/** The thanks page's words in the store's language; English for anything unknown. */
export function thanksWords(language: unknown): ThanksWords {
  return THANKS_WORDS[parseLanguage(language)];
}
