/**
 * The store's words in Spanish (lib/buyer-words/en.ts says what each is for).
 * Written for buyers anywhere Spanish is spoken: "tú", as Spanish-language
 * shops speak to their buyers, and no word that only Spain or only one
 * country in Latin America uses.
 */
import type { BuyerWords } from "./index";

type Interval = "day" | "week" | "month" | "year";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const every = (interval: Interval) => ({ day: "al día", week: "a la semana", month: "al mes", year: "al año" })[interval];
/** How long an introductory price lasts (lib/intro-price.ts). */
const introFirst = (count: number, interval: Interval) => (count > 1 ? `${every("month")} durante los primeros ${count} meses` : ({ day: "el primer día", week: "la primera semana", month: "el primer mes", year: "el primer año" })[interval]);

export const es: BuyerWords = {
  free: "Gratis",
  fromPrice: (price) => `desde ${price}`,
  was: "Antes ",
  now: "ahora ",
  every,
  membershipPrice: (trialDays, payments, interval, price) => {
    const trial = trialDays > 0 ? `${trialDays} ${plural(trialDays, "día", "días")} de prueba gratis, luego ` : "";
    if (payments > 0) {
      const adjective = { day: plural(payments, "diario", "diarios"), week: plural(payments, "semanal", "semanales"), month: plural(payments, "mensual", "mensuales"), year: plural(payments, "anual", "anuales") }[interval];
      return `${trial}${payments} ${plural(payments, "pago", "pagos")} ${adjective} de ${price}`;
    }
    return `${trial}${price} ${every(interval)}`;
  },
  introFirst,
  introThen: (intro, count, interval, then) => `${intro} ${introFirst(count, interval)}, luego ${then}`,
  planWords: (payments, interval, amount) =>
    `${payments} ${plural(payments, "pago", "pagos")} ${interval === "week" ? plural(payments, "semanal", "semanales") : plural(payments, "mensual", "mensuales")} de ${amount}`,
  planCount: (payments, interval) =>
    `${payments} ${plural(payments, "pago", "pagos")} ${interval === "week" ? plural(payments, "semanal", "semanales") : plural(payments, "mensual", "mensuales")}`,
  endsIn: (unit, n) =>
    unit === "day"
      ? `Termina en ${n} días`
      : unit === "hour"
        ? `Termina en ${n} ${plural(n, "hora", "horas")}`
        : `Termina en ${n} ${plural(n, "minuto", "minutos")}`,

  fairHead: (country, percent) => `Precio justo para tu país (${country}): ${percent}\u00a0% de descuento`,
  fairNote: (store, plan) =>
    `${store} baja sus precios donde el dinero rinde menos. Este precio se calculó automáticamente para ti a partir del país de tu conexión a internet. Se descuenta en la página de pago, sin necesidad de código${plan ? "; el precio rebajado es para el pago completo" : ""}.`,
  saleHead: (name, percent, ends) => `${name ? `${name}: ` : ""}${percent}\u00a0% de descuento · ${ends}`,
  saleNote: (until, plan) =>
    `Hasta el ${until}. Se descuenta en la página de pago, sin necesidad de código${plan ? "; el precio de oferta es para el pago completo" : ""}.`,
  saleBanner: (name, percent, ends) =>
    `${name ? `${name}: ` : ""}${percent}\u00a0% de descuento en los productos con el precio anterior tachado · ${ends}`,
  saleBannerNote: "Los precios de abajo ya lo incluyen; no hace falta ningún código.",

  callLiveNone: "Sesión en vivo, en línea, sin fechas programadas",
  callLive: (dates) => `Sesión en vivo, en línea, ${dates} ${plural(dates, "fecha programada", "fechas programadas")}`,
  callGroup: (minutes, seats) => `Llamada en grupo, ${minutes} minutos, hasta ${seats} personas, en línea`,
  callOne: (minutes) => `Llamada de ${minutes} minutos, en línea`,
  callLengths: (list) => `Llamada de ${list} minutos, en línea`,
  inPersonLive: (dates) => `Sesión en vivo, en persona, ${dates} ${plural(dates, "fecha programada", "fechas programadas")}`,
  inPersonGroup: (minutes, seats) => `${minutes} minutos, hasta ${seats} personas, en persona`,
  inPersonOne: (minutes) => `${minutes} minutos, en persona`,
  inPersonLengths: (list) => `${list} minutos, en persona`,
  inPersonLiveNone: "Sesión en vivo, en persona, sin fechas programadas",
  bundleOf: (count, worth) => `Paquete de ${count} productos${worth ? ` · ${worth}` : ""}`,
  worth: (worth, price) => `${worth} en productos por ${price}`,
  podcast: (episodes) => `Pódcast privado, ${episodes} ${plural(episodes, "episodio", "episodios")}, en tu propia app de pódcast`,
  fromCapital: "Desde ",
  pwywFact: (least, suggested) => `Paga lo que quieras, desde ${least}. Sugerido: ${suggested}`,
  includes: (titles, more) => `Incluye ${titles}${more > 0 ? ` y ${more} más` : ""}`,
  course: (lessons) => `Curso · ${lessons} ${plural(lessons, "lección", "lecciones")}`,
  seeInside: "Mira lo que incluye",
  readMore: "Leer más",
  soldOut: "Agotado",
  left: (count, written) => `${count === 1 ? "Queda" : "Quedan"} ${written}`,
  bought: (count) => `Comprado ${count} veces`,
  orPlan: (plan) => `o ${plan}`,

  buySessions: (sessions, price) => `Compra ${sessions} sesiones — ${price}`,
  packageNote: (saving, sessions, limit) =>
    `${saving ? `${saving} menos que ${sessions} sesiones reservadas una a una. ` : ""}Pagas una vez y reservas cada una cuando quieras. ${limit}.`,
  packageLimit: (days) => (days ? `Úsalas en un plazo de ${days} días` : "Sin plazo para usarlas"),

  whichOne: "Cuál",
  perPerson: " por persona",
  giftSummary: "Cómpralo como regalo",
  theirEmail: "Su email",
  yourNameShown: "Tu nombre, tal como lo verá",
  messageOptional: "Un mensaje (opcional)",
  buyAsGift: "Comprar como regalo",
  buyAsGiftFor: (price) => `Comprar como regalo — ${price}`,
  giftNote: (store) =>
    `Pagas en la página de Stripe. Después del pago, el regalo queda en su dirección. Si le llega el único email de ${store}, contiene tu nombre, tu mensaje y un enlace para abrirlo. Tú recibes el recibo, no una copia.`,
  giftProblems: {
    email: "Eso no parece una dirección de email. Revisa la dirección del destinatario y vuelve a intentarlo.",
    option: "Elige cuál quieres regalar y vuelve a intentarlo. No se ha cobrado nada.",
    product: "Esto ya no se puede comprar como regalo.",
    unavailable: "Los regalos no están disponibles ahora mismo. No se ha cobrado nada.",
  },
  teamSummary: "Cómpralo para un equipo",
  howManyPeople: "Cuántas personas",
  buyForTeam: "Comprar para tu equipo",
  buyForTeamEach: (each) => `Comprar para tu equipo — ${each} por persona`,
  teamNote:
    "Pagas una sola vez en la página de Stripe, donde ves el total antes de pagar. Justo después, recibes un enlace para compartir: cada persona lo abre, escribe su propio email y lo tiene en su propia dirección. Tú ocupas tu plaza de la misma forma.",
  teamProblems: (least, most) => ({
    people: `Escribe cuántas personas, de ${least} a ${most}. No se ha cobrado nada.`,
    option: "Elige cuál quieres comprar para todos y vuelve a intentarlo. No se ha cobrado nada.",
    amount: "Tantas personas a este precio superan lo que admite un solo pago. Prueba con menos personas o compra dos veces. No se ha cobrado nada.",
    product: "Esto ya no se puede comprar para varias personas.",
    unavailable: "Comprar para varias personas no está disponible ahora mismo. No se ha cobrado nada.",
  }),

  leaveEmpty: "Deja esto vacío",
  comingSoon: "Próximamente",
  yourEmail: "Tu email",
  emailPlaceholder: "tu@ejemplo.com",
  friendPlaceholder: "amigo@ejemplo.com",
  namePlaceholder: "Dana",
  alsoOtherEmails: (store) => `Envíame también otros emails de ${store}. Puedo darme de baja cuando quiera.`,
  alsoEmails: (store) => `Envíame también emails de ${store}. Puedo darme de baja cuando quiera.`,
  alsoClicks: (store) => `Permitir que ${store} vea qué enlaces de sus emails uso, para enviarme lo que me interese. Puedo dejarlo desde cualquier email.`,
  tellMe: "Avísame cuando salga",
  waitlistNote: (store) =>
    `Lo confirmas desde tu bandeja de entrada y recibes un único email cuando salga a la venta, nada más. Tu dirección solo llega a ${store} si marcaste la casilla.`,
  emailItToMe: "Envíamelo por email",
  freeNote: (store) =>
    `Te enviamos un enlace por email. Cuando lo uses, ${store} recibe tu dirección, indicando si marcaste la casilla. Marktmorgen no la usa para nada más.`,
  notAvailable: "No disponible ahora mismo.",
  noDates: "No hay fechas a la venta ahora mismo.",
  notOnSale: "Todavía no está a la venta.",
  soldOutStop: "Agotado.",
  cannotTakePayments: "Esta tienda todavía no puede aceptar pagos.",
  joinWaitlist: "Únete a la lista de espera",
  getItFree: "Consíguelo gratis",

  pickSession: "Elige una sesión",
  pickTime: "Elige un horario",
  priced: (label, price) => `${label} — ${price}`,
  /** The store's blog (lib/store-blog.ts; app/[handle]/blog). */
  blog: "Blog",
  blogOf: (store) => `Blog de ${store}`,
  blogPastEnd: "No hay entradas en esta página",
  blogPastEndBody: "Esta página está después de la última entrada.",
  blogMinutes: (n) => `${n} min de lectura`,
  blogNewer: "Entradas más recientes",
  blogOlder: "Entradas anteriores",
  blogAll: "Todas las entradas",
  blogPublished: (date) => `Publicado el ${date}`,
  blogFrom: (store) => `De ${store}`,
  blogFeed: "Seguir por RSS",
  /** What one unit costs within an option, when its name gives how many (lib/option-units.ts): "$7.80 per week". */
  perUnit: (price, unit) => `${price} por ${unit}`,
  /** How much less each unit costs than in the option of one. */
  unitSaving: (percent) => `ahorras un ${percent}\u00a0%`,
  chooseOptionFor: (title) => `Elige una opción de ${title}`,
  chooseOne: "Elige una",
  recommended: "Recomendado",
  recommendedAfter: " (recomendado)",
  howToPayFor: (title) => `Cómo pagar ${title}`,
  payInFull: "Pago completo",
  today: (amount) => `${amount} hoy`,
  addFor: (title, price) => `Añade ${title} por ${price}`,
  bundleBox: (count) => `Un paquete de ${count} productos, cada uno tuyo para abrirlo justo después de pagar.`,
  onItsOwn: (price) => `${price} por separado`,
  chooseYourPrice: "Elige tu precio",
  startTrial: (days) => `Empieza la prueba gratis de ${days} ${plural(days, "día", "días")}`,
  subscribe: "Suscribirme",
  continueOption: "Continuar con esta opción",
  subscribeFor: (price, every) => `Suscribirme — ${price} ${every}`,
  buyFor: (price) => `Comprar por ${price}`,
  startPlanToday: (amount) => `Empieza el plan: ${amount} hoy`,
  startPlanWith: (named, amount) => `Empieza el plan junto con ${named}: ${amount} hoy`,
  nAdded: (count) => `${count} productos más`,
  buyItWith: (named) => `Comprar junto con ${named}`,
  buyAllFor: (boxes, price) => `${["Comprar", "Comprar ambos", "Comprar los tres", "Comprar los cuatro"][boxes]} por ${price}`,
  pwywNote: (least, suggested) => `Escribes el importe en la página de pago: ${least} o más, ${suggested} sugerido.`,
  trialNote: (days, after, untilCancel) =>
    `Introduces tu tarjeta ahora y no se cobra nada durante ${days} ${plural(days, "día", "días")}. Después, ${after}${untilCancel ? " hasta que canceles" : ""}. Si cancelas antes de que termine la prueba, no pagas nada.`,
  switchPlansNote: "Más adelante puedes cambiar a otro plan de esta tienda, superior o inferior, y ver el importe exacto antes de que se cobre nada.",
  payPal: (alone, price) => `${alone ? "Comprar" : "O paga"} con PayPal — ${price}`,
  payPalNote: (store) => `Se paga en la propia cuenta de PayPal de ${store}. Lo que compres se envía a la dirección de email de tu cuenta de PayPal.`,
  chooseAndBuy: "Elige y compra",
  memberManage: "¿Ya eres miembro? Gestiona o cancela",
  memberSwitch: "¿Ya eres miembro? Cambia de plan, gestiona o cancela",

  takenBy: (stripe, paypal) => (stripe && paypal ? "Stripe o PayPal" : paypal ? "PayPal" : "Stripe"),
  testModeTitle: "Este pago funciona en el modo de prueba de Stripe.",
  testModeBody: "No se mueve dinero real y no se cobra ninguna tarjeta real, así que no introduzcas una tarjeta tuya.",
  testModeLater: (store) =>
    `Cuando esté activo, el pago lo cobra Stripe en la propia cuenta de ${store}: Marktmorgen nunca retiene el dinero ni se queda con nada.`,
  paidBy: (takers, store) =>
    `El pago lo cobra ${takers} en la propia cuenta de ${store}. Marktmorgen nunca retiene el dinero ni se queda con nada.`,
  whoAnswers: (store) =>
    `${store} es quien vende y responde de lo que compras, de los reembolsos y de cualquier derecho de desistimiento que tengas. Marktmorgen aloja las páginas de la tienda y no es parte en la venta.`,
  noPaymentsTitle: "Esta tienda todavía no puede aceptar pagos.",
  noPaymentsBody: (store) => `Los precios de arriba son reales, pero aquí nada puede cobrar una tarjeta. Para comprar, escribe directamente a ${store}.`,
  noPaymentsBodyOne: (store) => `El precio de arriba es real, pero aquí nada puede cobrar una tarjeta. Para comprar, escribe directamente a ${store}.`,

  notices: {
    soldout: { title: "Se acaba de agotar", body: "El último se vendió justo antes de que pulsaras comprar. No se ha cobrado nada." },
    busy: { title: "Alguien lo está comprando ahora mismo", body: "No se ha cobrado nada. Vuelve a pulsar comprar en un momento." },
    slow: { title: "Demasiados intentos en pocos minutos", body: "No se ha cobrado nada. Espera unos minutos y vuelve a pulsar comprar." },
    error: { title: "No se pudo abrir la página de pago", body: "No se ha cobrado nada. Vuelve a intentarlo en un momento." },
    paused: { title: "Esta tienda no acepta pedidos nuevos ahora mismo", body: "No se ha cobrado nada. Los pedidos nuevos vuelven a abrirse a principios del mes que viene, o antes." },
    "paypal-declined": {
      title: "PayPal no aceptó el pago",
      body: "No se ha cobrado nada. Prueba con otra tarjeta o cuenta en PayPal, o paga aquí con tarjeta.",
    },
    "paypal-error": {
      title: "No se pudo asociar ese pago de PayPal a esta tienda",
      body: "No se ha entregado nada por él. Si PayPal muestra un cargo, escribe a la tienda respondiendo al recibo de PayPal.",
    },
  },
  storeDescription: (store) => `La tienda de ${store} en Marktmorgen.`,
  nothingYet: "Todavía no hay nada",
  nothingYetBody: (store) => `Esta página está abierta pero vacía. Cuando ${store} añada algo, aparecerá aquí.`,
  continued: " (continuación)",
  pagesOfProducts: "Páginas de productos",
  previous: "Anterior",
  next: "Siguiente",
  pageOf: (page, pages) => `Página ${page} de ${pages}`,
  products: (count, written) => `${written} ${plural(count, "producto", "productos")}`,
  communityTitle: "Comunidad de miembros",
  communityBody: "Para quienes tienen uno de los productos que dan acceso. Entra con el email que usaste para conseguirlo.",
  getAgain: "¿Compraste algo aquí? Recupéralo",
  affiliateProgram: (store) => `Gana compartiendo ${store}: el programa de afiliados`,
  madeWith: "Hecho con Marktmorgen",

  productDescription: (title, store) => `${title}, de la tienda de ${store}.`,
  insideTitle: (count) => `Lo que incluye: ${count} productos`,
  insideCourse: (lessons) => `Curso, ${lessons} ${plural(lessons, "lección", "lecciones")} · `,
  insideNote: "Cada uno es tuyo justo después de pagar, como si lo hubieras comprado por separado.",
  payInFullOr: (plan) => `Paga todo de una vez o en ${plan}`,
  youChoose: (least) => `Tú eliges el precio: ${least} o más.`,
  readFirst: (pages) => `Lee gratis ${pages === 1 ? "la primera página" : `las primeras ${pages} páginas`} (PDF)`,
  everythingFrom: (store) => `Todo de ${store}`,
  getTitle: (title) => `Consigue ${title}`,
  moreFrom: (store) => `Más de ${store}`,
  pairedWith: (title) => `Va bien con ${title}`,
  pickedBy: (store) => `Elegido por ${store}`,
  collections: "Colecciones",
  inCollections: "Forma parte de",
  productCount: (n) => `${n} ${n === 1 ? "producto" : "productos"}`,
  alsoBought: (title) => `Quienes compraron ${title} también compraron`,
  boughtBoth: (n) => `${n} compradores compraron los dos`,
  billMonthly: "Mensual",
  billYearly: "Anual",
  yearSave: (amount) => `Ahorras ${amount}`,
  yearlyFact: (price, save) => `O ${price} ${every("year")}, con un ahorro de ${save}`,

  reviews: "Reseñas",
  verifiedReviews: (count, written) => `${written} ${plural(count, "reseña verificada", "reseñas verificadas")}`,
  ratedFrom: (average, reviews) => `Valorado con ${average} de 5 en ${reviews}`,
  ratedOutOf5: (average) => `Valorado con ${average} de 5`,
  starsOutOf5: (stars) => `${stars} de 5 estrellas`,
  verifiedBuyer: "Comprador verificado",
  verifiedPurchase: "Compra verificada",
  pickedByCreator: "Elegida por el creador",
  refundedNotCounted: "Reembolsado, no se cuenta",
  edited: (date) => ` · editado el ${date}`,
  replyFrom: (store) => `Respuesta de ${store}`,
  starsSpread: "Cómo se reparten las estrellas",
  starLabel: (stars) => `${stars} ${plural(stars, "estrella", "estrellas")}`,
  reviewCount: (count) => `${count} ${plural(count, "reseña", "reseñas")}`,
  reviewRules: (title, store) =>
    `Solo quienes compraron ${title} aquí pueden reseñarlo, y cada reseña se comprueba con su pedido. ${store} puede responder y ocultar una reseña, pero no modificarla; las reseñas ocultas siguen contando en la media.`,
  hiddenByCreator: (count) => `${count} ${plural(count, "reseña oculta", "reseñas ocultas")} por el creador`,
  reviewsUnreadKept: (count) => `${count} ${plural(count, "reseña no se pudo", "reseñas no se pudieron")} leer`,
  refundedOrders: (count) => count === 1 ? "1 de un pedido reembolsado, que no cuenta" : `${count} de pedidos reembolsados, que no cuentan`,
  noReviewsYet: "Las reseñas de los compradores aparecerán aquí cuando alguien que haya pagado escriba una.",
  seeAllReviews: (written) => `Ver las ${written} reseñas`,

  askAria: "Haz una pregunta sobre este producto",
  askLabel: "¿Una pregunta antes de comprar?",
  askPlaceholder: "¿Es un PDF? ¿Cuánto tiempo tengo acceso?",
  askBusy: "Leyendo…",
  ask: "Preguntar",
  askClosed: (store) => `Las preguntas están cerradas ahora mismo. Pregunta a ${store} antes de comprar.`,
  askTypeFirst: "Escribe primero tu pregunta.",
  askSlow: "Demasiadas preguntas en este momento. Vuelve a intentarlo en unos minutos.",
  askFailed: "No se ha podido responder ahora mismo. Vuelve a intentarlo en un momento.",
  askNote: (store) =>
    `Se responde automáticamente, solo con lo que dice esta página. Tu pregunta puede mostrarse a ${store}, sin nada sobre quién eres, así que no incluyas datos personales.`,

  close: "Cerrar",
  beforeYouGo: "Antes de irte — gratis",

  aboutStore: (store) => `Sobre ${store}`,
  guarantee: "Garantía",
  fullSize: (alt) => `${alt}, a tamaño completo`,
  openFullSize: "Abrir esta imagen a tamaño completo",
  countdownUnits: { days: "días", hours: "horas", min: "min", sec: "seg" },
  until: (when) => `Hasta ${when}`,

  restingTitle: "Esta página está en pausa por ahora",
  restingBody: (store) =>
    `Volverá a abrirse a principios del mes que viene, o antes. Todo lo que ya tienes de ${store} sigue siendo tuyo y sigue disponible.`,
  restingBuyerBody: (store) =>
    `Conservas tu acceso: no pierdes nada de lo que tienes de ${store}. Esta página vuelve a abrirse a principios del mes que viene, o antes.`,
  restingOwner: "¿Es tu tienda? Tu estudio explica por qué y cómo volver a abrirla",

  reviewsOf: (title) => `Reseñas de ${title}`,
  backTo: (title) => `Volver a ${title}`,
  missingTitle: "Esta página no está aquí",
  missingBody: (store) => `Puede que se haya movido o retirado. Todo lo que ofrece ${store} está en la portada de la tienda.`,
  noReviewsToShow: "No hay reseñas que mostrar.",
  reviewsUnread: "No se pudieron cargar las reseñas ahora mismo. Inténtalo de nuevo en un momento.",
  pagesOfReviews: "Páginas de reseñas",
  newer: "Más recientes",
  older: "Más antiguas",
  askUnknown: (store) => `Esta página no lo dice. Pregunta a ${store} antes de comprar.`,
  askTermsCut: () => "No tengo aquí las condiciones completas. Pregunta al creador antes de comprar.",

  noLongerOnSale: "Este producto ya no está a la venta.",
  cardUnread: "No se ha podido cargar este producto ahora mismo. Vuelve a intentarlo en un momento.",
  cardBuyUnread: "Ahora mismo no se puede comprar. Vuelve a intentarlo en un momento.",
  seeStore: (store) => `Ver ${store}`,
  cardTestMode: "Modo de prueba: no se cobra ninguna tarjeta real.",
  cardCheckout: "Pago seguro con Stripe, en una pestaña nueva.",
  cardSoldBy: (store) => `Lo vende ${store}, que responde de lo que compras.`,
  cardOpens: (store) => `Se abre en la tienda de ${store}, en una pestaña nueva.`,

  // ---- Email cards (lib/mail-product-price.ts)
  orMore: (price) => `${price} o más`,
  plusTax: "+ impuestos, si corresponden",
  salePriceUntil: (price, when) => `Precio de oferta: ${price}, hasta el ${when}`,
};
