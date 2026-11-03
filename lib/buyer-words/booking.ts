/**
 * Every word a buyer meets while booking a call, in the store's language
 * (lib/store-language.ts): the booking page and its notices, the time and
 * session pickers, the page that moves a booking, the label of the button
 * that opens the call, and the emails and calendar files a buyer gets —
 * confirmed, moved, a new link, the reminders, and a package of sessions.
 *
 * What goes to the creator (their own copy of a booking, their reminders)
 * stays in English, like the studio.
 *
 * Times, dates and prices arrive already written in the store's language
 * (lib/call-setup.ts, readableTime and zoneName with the store's locale;
 * lib/buyer-words/index.ts, speech): a sentence here only places them.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** French takes the singular for 0 and 1. */
const pluralFr = (n: number, one: string, many: string) => (n < 2 ? one : many);
/** The space French puts before ":", ";", "?" and "!", and every language before "%": one a line cannot break at. */
const S = " ";

type Notice = { title: string; body: string };
type RoomKind = "room" | "meet" | "zoom" | "other";

const en = {
  /** Between a label and what it labels: "Pick a time: Coaching". French puts a space before it. */
  colon: ": ",

  // ---- The booking page: what a return from a refused booking says (?status=) ----
  notices: {
    "pkg-used": { title: "Your package has no sessions left", body: "Every session of it is booked or being booked. Nothing was charged." },
    "pkg-expired": { title: "Your package's time to book has passed", body: "Nothing was charged. Reply to your package's email to ask the creator." },
    "pkg-refunded": { title: "This package was refunded", body: "It books nothing more. Nothing was charged." },
    "pkg-gone": { title: "That package link does not work", body: "Use the link in your package's email. Nothing was charged." },
    "pkg-error": { title: "We could not book from your package just now", body: "Nothing was charged. Try again in a moment." },
    taken: {
      title: "That time was just taken",
      body: "Somebody booked it a moment before you, or it is being paid for right now. Pick another; nothing was charged.",
    },
    invalid: {
      title: "Pick a time first",
      body: "Choose one of the times below, then continue.",
    },
    error: {
      title: "Something went wrong on our side",
      body: "Nothing was charged. Try again in a moment.",
    },
    unavailable: {
      title: "This cannot be booked right now",
      body: "Nothing was charged.",
    },
    "code-unknown": { title: "That code does not work here", body: "Nothing was charged. Check the code, or book without it." },
    "code-limited": { title: "That code cannot be used with a deposit", body: "Nothing was charged. A code with conditions (a limit on its uses, a first purchase or one customer only, some products only, or an end date) cannot be used when part of the price is paid in person. Book without it." },
    "code-small": { title: "That code leaves too little to pay online", body: "Nothing was charged. With that code, what is left to pay online is below the smallest amount that can be charged. Book without it." },
    "host-changed": { title: "The team changed since this page opened", body: "Nothing was charged. Pick who you book with again." },
    slow: {
      title: "That was a lot of tries in a few minutes",
      body: "Nothing was charged. Wait a few minutes, then pick a time again.",
    },
  } as Record<string, Notice>,
  /** What a buyer moving their booking may be told. */
  moveNotices: {
    taken: {
      title: "That time was just taken",
      body: "Somebody booked it a moment before you. Your booking has not changed; pick another.",
    },
    invalid: { title: "Pick a time first", body: "Choose one of the times below, then continue." },
    same: { title: "That is the time you already have", body: "Pick a different one to move to." },
    late: {
      title: "It is too close to the start to move",
      body: "Your booking has not changed. To ask the creator about it, reply to your confirmation email.",
    },
    limit: {
      title: "This booking has been moved as often as it can be",
      body: "Your booking has not changed. To ask the creator about it, reply to your confirmation email.",
    },
    error: { title: "Something went wrong on our side", body: "Your booking has not changed. Try again in a moment." },
    unavailable: { title: "Bookings cannot be moved right now", body: "Your booking has not changed." },
    slow: { title: "That was a lot of tries in a few minutes", body: "Your booking has not changed. Wait a few minutes, then try again." },
  } as Record<string, Notice>,

  // ---- The booking page ----------------------------------------------------
  packageLeft: (left: number, total: number) => `Booking from your package: ${left} of ${total} left`,
  /** After packageLeft; the date is written without the year. */
  packageBookBy: (date: string) => ` · book by ${date}`,
  packageLinkWrong: "That package link is not for this booking, or no longer works. Use the link in your package's email.",
  closedBody: (store: string) => `${store}'s store is not taking payments at the moment. Nothing here can charge a card.`,
  timesUnread: "The times could not be read just now",
  timesUnreadBody: "Nothing was charged. Refresh the page in a moment.",
  timesUnreadMoveBody: "Your booking has not changed. Refresh the page in a moment.",

  // ---- The line under a call's title: how long, how many, and where ----------
  whereMeet: (meet: string) => `online, on ${meet}; you get the link when you book`,
  whereVideo: "online, in a private video room; you get the link when you book",
  whereLink: "online; you get the link when you book",
  liveLine: (where: string) => `Live session · ${where}`,
  liveOnline: "Live session · online",
  groupLine: (seats: number, minutes: number, where: string) => `Group call, up to ${seats} people · ${minutes} minutes · ${where}`,
  groupOnline: (seats: number, minutes: number) => `Group call, up to ${seats} people · ${minutes} minutes · online`,
  oneLine: (minutes: number, where: string) => `${minutes}-minute call · ${where}`,
  oneOnline: (minutes: number) => `${minutes}-minute call · online`,
  /** An in-person booking (lib/call-place.ts): where, under its title. */
  inPersonLine: (minutes: number, address: string) => `${minutes} minutes · in person, at ${address}`,
  inPersonGroupLine: (seats: number, minutes: number, address: string) => `Up to ${seats} people · ${minutes} minutes · in person, at ${address}`,
  inPersonLiveLine: (address: string) => `Live session · in person, at ${address}`,

  // ---- Picking a time (components/slot-picker.tsx) ---------------------------
  pickDay: "Pick a day",
  noTimes: "No free times right now",
  noTimesBody: "Every time that can be booked is taken. Come back in a day or two: new times open as the days go by.",
  noOtherTimes: "No other times are free right now",
  noOtherTimesBody: "Your booking stays as it is. Come back in a day or two: new times open as the days go by.",
  /** Under a time of a group call. */
  seatsLeft: (left: number) => `${left} ${left === 1 ? "seat" : "seats"} left`,
  /** The zone is the buyer's own, once their browser has said which. */
  timesInYours: (zone: string) => `Times are in your time zone, ${zone}.`,
  timesInCreators: (zone: string) => `Times are in the creator's time zone, ${zone}.`,
  /** After the time picked. */
  chosenLength: (minutes: number) => ` · ${minutes} minutes`,
  continueToPay: (price: string) => `Continue to payment — ${price}`,
  moveToTime: "Move my booking to this time",
  bookFromPackage: "Book this time from my package",
  moveNoCharge: "Nothing is charged. Your old time is freed for somebody else.",
  packageNoCharge: "You confirm it on the next page; nothing is charged.",
  timeKept: "The time is kept for you for 30 minutes while you pay.",

  // ---- Picking a dated session (components/session-picker.tsx) ---------------
  noSessions: "No sessions to book right now",
  noSessionsBody: "Every session is full or too close to its start to book. New dates appear here when they are added.",
  noOtherSessions: "No other session has a seat right now",
  seatStays: "Your seat stays as it is.",
  /** "45 min", "1 h 30 min", "2 hours", and the seats left when there is more than one. */
  sessionDetail: (minutes: number, left: number, seats: number) => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const length = minutes < 60 ? `${minutes} min` : m ? `${h} h ${m} min` : `${h} ${h === 1 ? "hour" : "hours"}`;
    return `${length}${seats > 1 ? ` · ${left} of ${seats} seats left` : ""}`;
  },
  moveSeat: "Move my seat to this session",
  seatNoCharge: "Nothing is charged. Your old seat is freed for somebody else.",
  seatKept: "Your seat is kept for you for 30 minutes while you pay.",

  // ---- Moving a booking ------------------------------------------------------
  unreadable: "Your booking could not be read just now",
  unreadableBody: "Nothing has changed. Try the link again in a moment.",
  notFound: "We could not find this booking",
  notFoundBody: "Check the link in your confirmation email. A booking whose time has passed cannot be moved.",
  movedLabel: "Moved",
  yourBooking: "Your booking",
  movedTitle: "Your booking has moved",
  moveTitle: (title: string) => `Move ${title}`,
  newTime: "Your new time",
  bookedFor: "Booked for",
  bookedLine: (zone: string, minutes: number, title: string) => `${zone} · ${minutes} minutes · ${title}`,
  addNewTime: "Add the new time to your calendar",
  movedNote: (store: string) =>
    `${store} has been told, and an email with the new time and a calendar file is on its way to you. The old time is free again for somebody else.`,
  moveAgain: (left: number) => ` You can move it ${left === 1 ? "once more" : `${left} more times`} from this page.`,
  noOtherSession: "There is no other session to move to",
  staysAsIs: (store: string) => `Your booking stays as it is. To ask ${store} about it, reply to your confirmation email.`,
  /** `hasMoved`: moved before, so the times left are "more" times. */
  canMoveUntil: (left: number, hasMoved: boolean, until: string, zone: string) =>
    `You can move it ${left === 1 ? "once more" : `${left} ${hasMoved ? "more " : ""}times`}, until ${until} (${zone}). Nothing is charged or refunded.`,

  // ---- Where the call happens (lib/call-rooms.ts) ------------------------------
  roomLabels: {
    room: "Join the video room",
    meet: "Join on Google Meet",
    zoom: "Join on Zoom",
    other: "Join the call",
  } as Record<RoomKind, string>,
  videoRoomNote:
    "This is a private Jitsi Meet room (a free video service run by a third party). The first person to open it may be asked to sign in to Jitsi (with a Google account, for example) to start the meeting; everyone else joins without an account once it has started.",

  // ---- The email that confirms a booking ----------------------------------------
  bookedSubject: (title: string, store: string) => `Booked: ${title} with ${store}`,
  seatBooked: (store: string) => `Your seat with ${store} is booked.`,
  groupBooked: (store: string) => `Your place in the group call with ${store} is booked.`,
  callBooked: (store: string) => `Your call with ${store} is booked.`,
  /** An in-person booking (lib/call-place.ts): no "call" in it. */
  timeBooked: (store: string) => `Your time with ${store} is booked.`,
  titleLength: (title: string, minutes: number) => `${title}, ${minutes} minutes`,
  joinAtThatTime: (room: string) => `Join here at that time: ${room}`,
  willSendLink: (store: string) => `${store} will send you the link to join before the call.`,
  calendarAttached: "The calendar file attached adds it to your calendar.",
  remindDayHour: " You will get a reminder a day before and an hour before.",
  remindHour: " You will get a reminder an hour before.",
  moveYourself: (hours: number, link: string) =>
    `To move it to another time yourself, up to ${hours} ${hours === 1 ? "hour" : "hours"} before it starts: ${link}`,
  toCancel: (store: string) => `To cancel, reply to this email; the reply goes to ${store}.`,

  // ---- The email that says a booking moved ----------------------------------------
  movedSubject: (title: string, store: string) => `Moved: ${title} with ${store}`,
  movedHead: (store: string) => `Your booking with ${store} has moved.`,
  nowAt: (when: string) => `Now: ${when}`,
  wasAt: (when: string) => `Was: ${when}`,
  joinAtNewTime: (room: string) => `Join here at the new time: ${room}`,
  newTimeAttached: "The calendar file attached has the new time. If your calendar still shows the old one as well, delete the old one.",
  moveAgainLink: (link: string, count: number) => `To move it again: ${link} (you can move a booking ${count} times in all).`,
  cannotMoveAgain: (store: string) =>
    `This booking cannot be moved again from the link. To change it, reply to this email; the reply goes to ${store}.`,

  // ---- The email with a meeting link made later ----------------------------------------
  newLinkSubject: (title: string, store: string) => `New link to join: ${title} with ${store}`,
  newLinkHead: (title: string, store: string) => `The link to join ${title} with ${store} has changed. The time has not.`,
  joinOn: (meet: string, link: string) => `Join here at that time, on ${meet}: ${link}`,
  oldLink: (previous: string) => `The link you were sent before (${previous}) is no longer the one to use.`,
  replacesFile: "The calendar file attached replaces the one sent before.",

  // ---- The reminders a day and an hour before ------------------------------------------
  /** `isDay`: the one a day before. */
  reminderSubject: (isDay: boolean, title: string, store: string) => `${isDay ? "Tomorrow" : "In 1 hour"}: ${title} with ${store}`,
  reminderHead: (isDay: boolean, title: string, store: string) =>
    `A reminder: ${title} with ${store} starts ${isDay ? "in a day" : "in an hour"}.`,
  whenLength: (when: string, minutes: number) => `${when}, ${minutes} minutes`,
  willSendOrReply: (store: string) => `${store} will send you the link to join. If it has not reached you, reply to this email.`,
  addToCalendar: (link: string) => `Add it to your calendar: ${link}`,
  moveToAnother: (link: string) => `To move it to another time: ${link}`,

  // ---- The calendar file a buyer gets ------------------------------------------------
  icsSummary: (title: string, store: string) => `${title} with ${store}`,
  icsAlarm: (title: string) => `${title} in 15 minutes`,
  icsJoin: (room: string) => `Join: ${room}`,
  icsWillSend: (store: string) => `${store} will send the link to join.`,
  /** An in-person booking (lib/call-place.ts): where it is, in the email and the calendar file. */
  whereAt: (address: string) => `Where: ${address}`,
  /** A deposit on an in-person booking (lib/call-deposit.ts): what is paid now, and the rest in person. */
  depositRest: (amount: string, store: string) => `A deposit to hold your time. The rest, ${amount}, is paid in person to ${store}.`,
  /** A code on a booking with a deposit (lib/deposit-code.ts): typed on the booking page, off the whole price. */
  codeLabel: "Discount code (optional)",
  codeHelp: "It comes off the whole price. What is left after the deposit is paid in person.",
  codeOffPrice: (code: string, amount: string) => `Code ${code}: ${amount} off the whole price.`,
  /** Choosing who to book with, on a team that lets buyers choose (lib/team-scheduling-rules.ts, hostChoices). */
  hostPick: "Who would you like to book with?",
  hostAny: "Any available",
  hostShow: "Show their times",
  /** Choosing one of a call's lengths, each with its price (lib/call-lengths.ts). */
  lengthPick: "How long would you like?",
  lengthChosen: (what: string) => `Showing times for ${what}.`,
  lengthOption: (minutes: number, price: string) => `${minutes} minutes, ${price}`,
  withHost: (name: string) => `With ${name}`,
  /** The creator's cancellation deadline (lib/call-setup.ts, cancelHours), said before paying and in the confirmation. */
  cancelPolicy: (hours: number, store: string) =>
    `Cancel at least ${hours} hours before the start, by replying to your confirmation email, and ${store} refunds what you paid online. If you cancel later or miss it, ${store} does not have to refund it. If ${store} cancels, you get it all back. This does not affect your rights under the law.`,
  /** The same deadline, for a time already inside it when booked. */
  cancelTooLate: (hours: number, store: string) =>
    `This time starts in less than ${hours} hours, so if you cancel or miss it, ${store} does not have to refund what you paid online. If ${store} cancels, you get it all back. This does not affect your rights under the law.`,

  // ---- A package of sessions ---------------------------------------------------------
  /** On Stripe's page. */
  packageName: (title: string, sessions: number) => `${title} — ${sessions} sessions`,
  /** On Stripe's page; `limit` is the store's packageLimit, already said. */
  packageDescription: (sessions: number, limit: string) => `${sessions} sessions, each booked when you like. ${limit}.`,
  /** The name of the coupon that makes a session from a package free, shown on Stripe's page. */
  packageCoupon: "Session from a package",
  packageSubject: (total: number, title: string) => `Your ${total} sessions: ${title}`,
  packageThanks: (store: string) => `Thank you for buying from ${store}. This is your confirmation.`,
  packageWhat: (title: string, total: number) => `What you bought: ${title}, ${total} sessions`,
  packagePaid: (amount: string) => `Paid: ${amount}`,
  packageReference: (reference: string) => `Order reference: ${reference}`,
  packageBookByDate: (date: string) => `Book them by: ${date}`,
  packageNoLimit: "No time limit to book them.",
  packageBookHere: "Book each session, whenever you like, here:",
  packageKeep:
    "Keep this email: that link is how you book the rest. Each one gets its own confirmation, reminders and meeting link, and can be moved like any booking.",
  /** A package of in-person bookings (lib/call-place.ts): no meeting link, the address instead. */
  packageKeepPlace:
    "Keep this email: that link is how you book the rest. Each one gets its own confirmation and reminders, with the address, and can be moved like any booking.",
  packageCharged: (store: string) =>
    `Charged by ${store} on their own Stripe account. Questions go to ${store} by replying to this email.`,
};

export type BookingWords = typeof en;

// ---- Spanish: "tú", for any Spanish-speaking buyer ----------------------------------

const esLength = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return minutes < 60 ? `${minutes} min` : m ? `${h} h ${m} min` : `${h} ${plural(h, "hora", "horas")}`;
};

const esStays = "Tu reserva no ha cambiado. Para preguntarle al creador sobre ella, responde a tu email de confirmación.";

const es: BookingWords = {
  colon: ": ",
  notices: {
    "pkg-used": { title: "A tu paquete no le quedan sesiones", body: "Todas sus sesiones están reservadas o en proceso de reserva. No se ha cobrado nada." },
    "pkg-expired": { title: "El plazo para reservar con tu paquete ha terminado", body: "No se ha cobrado nada. Responde al email de tu paquete para preguntarle al creador." },
    "pkg-refunded": { title: "Este paquete fue reembolsado", body: "Ya no sirve para reservar nada más. No se ha cobrado nada." },
    "pkg-gone": { title: "Ese enlace del paquete no funciona", body: "Usa el enlace del email de tu paquete. No se ha cobrado nada." },
    "pkg-error": { title: "No pudimos reservar con tu paquete en este momento", body: "No se ha cobrado nada. Vuelve a intentarlo en un momento." },
    taken: {
      title: "Ese horario acaba de ocuparse",
      body: "Alguien lo reservó justo antes que tú, o se está pagando ahora mismo. Elige otro; no se ha cobrado nada.",
    },
    invalid: { title: "Primero elige un horario", body: "Elige uno de los horarios de abajo y luego continúa." },
    error: { title: "Algo salió mal por nuestra parte", body: "No se ha cobrado nada. Vuelve a intentarlo en un momento." },
    unavailable: { title: "No se puede reservar en este momento", body: "No se ha cobrado nada." },
    "code-unknown": { title: "Ese código no sirve aquí", body: "No se ha cobrado nada. Revisa el código o reserva sin él." },
    "code-limited": { title: "Ese código no se puede usar con un depósito", body: "No se ha cobrado nada. Un código con condiciones (usos limitados, solo una primera compra o un cliente, solo algunos productos o una fecha de fin) no se puede usar cuando parte del precio se paga en persona. Reserva sin él." },
    "code-small": { title: "Con ese código queda muy poco para pagar en línea", body: "No se ha cobrado nada. Con ese código, lo que queda por pagar en línea está por debajo del importe mínimo que se puede cobrar. Reserva sin él." },
    "host-changed": { title: "El equipo cambió desde que abriste esta página", body: "No se ha cobrado nada. Vuelve a elegir con quién reservar." },
    slow: { title: "Demasiados intentos en pocos minutos", body: "No se ha cobrado nada. Espera unos minutos y vuelve a elegir un horario." },
  },
  moveNotices: {
    taken: { title: "Ese horario acaba de ocuparse", body: "Alguien lo reservó justo antes que tú. Tu reserva no ha cambiado; elige otro." },
    invalid: { title: "Primero elige un horario", body: "Elige uno de los horarios de abajo y luego continúa." },
    same: { title: "Ese es el horario que ya tienes", body: "Elige otro distinto al que cambiarla." },
    late: { title: "Falta muy poco para el inicio como para cambiarla", body: esStays },
    limit: { title: "Esta reserva ya se cambió todas las veces posibles", body: esStays },
    error: { title: "Algo salió mal por nuestra parte", body: "Tu reserva no ha cambiado. Vuelve a intentarlo en un momento." },
    unavailable: { title: "Ahora mismo no se pueden cambiar las reservas", body: "Tu reserva no ha cambiado." },
    slow: { title: "Demasiados intentos en pocos minutos", body: "Tu reserva no ha cambiado. Espera unos minutos y vuelve a intentarlo." },
  },

  packageLeft: (left, total) => `Reservando con tu paquete: te ${left === 1 ? "queda" : "quedan"} ${left} de ${total}`,
  packageBookBy: (date) => ` · reserva a más tardar el ${date}`,
  packageLinkWrong: "Ese enlace del paquete no es para esta reserva o ya no funciona. Usa el enlace del email de tu paquete.",
  closedBody: (store) => `La tienda de ${store} no está aceptando pagos en este momento. Nada aquí puede cobrar una tarjeta.`,
  timesUnread: "No se pudieron leer los horarios en este momento",
  timesUnreadBody: "No se ha cobrado nada. Actualiza la página en un momento.",
  timesUnreadMoveBody: "Tu reserva no ha cambiado. Actualiza la página en un momento.",

  whereMeet: (meet) => `en línea, en ${meet}; recibes el enlace al reservar`,
  whereVideo: "en línea, en una sala privada de videollamada; recibes el enlace al reservar",
  whereLink: "en línea; recibes el enlace al reservar",
  liveLine: (where) => `Sesión en vivo · ${where}`,
  liveOnline: "Sesión en vivo · en línea",
  groupLine: (seats, minutes, where) => `Llamada en grupo, hasta ${seats} personas · ${minutes} minutos · ${where}`,
  groupOnline: (seats, minutes) => `Llamada en grupo, hasta ${seats} personas · ${minutes} minutos · en línea`,
  oneLine: (minutes, where) => `Llamada de ${minutes} minutos · ${where}`,
  oneOnline: (minutes) => `Llamada de ${minutes} minutos · en línea`,
  inPersonLine: (minutes, address) => `${minutes} minutos · en persona, en ${address}`,
  inPersonGroupLine: (seats, minutes, address) => `Hasta ${seats} personas · ${minutes} minutos · en persona, en ${address}`,
  inPersonLiveLine: (address) => `Sesión en vivo · en persona, en ${address}`,

  pickDay: "Elige un día",
  noTimes: "No hay horarios libres en este momento",
  noTimesBody: "Todos los horarios que se pueden reservar están ocupados. Vuelve en uno o dos días: se abren horarios nuevos a medida que pasan los días.",
  noOtherTimes: "No hay otros horarios libres en este momento",
  noOtherTimesBody: "Tu reserva se queda como está. Vuelve en uno o dos días: se abren horarios nuevos a medida que pasan los días.",
  seatsLeft: (left) => `${left === 1 ? "Queda" : "Quedan"} ${left} ${plural(left, "plaza", "plazas")}`,
  timesInYours: (zone) => `Los horarios están en tu zona horaria, ${zone}.`,
  timesInCreators: (zone) => `Los horarios están en la zona horaria del creador, ${zone}.`,
  chosenLength: (minutes) => ` · ${minutes} minutos`,
  continueToPay: (price) => `Continuar al pago — ${price}`,
  moveToTime: "Cambiar mi reserva a este horario",
  bookFromPackage: "Reservar este horario con mi paquete",
  moveNoCharge: "No se cobra nada. Tu horario anterior queda libre para otra persona.",
  packageNoCharge: "Lo confirmas en la página siguiente; no se cobra nada.",
  timeKept: "El horario se te guarda durante 30 minutos mientras pagas.",

  noSessions: "No hay sesiones para reservar en este momento",
  noSessionsBody: "Todas las sesiones están llenas o demasiado cerca de su inicio para reservarlas. Las nuevas fechas aparecen aquí cuando se añaden.",
  noOtherSessions: "Ninguna otra sesión tiene plazas en este momento",
  seatStays: "Tu plaza se queda como está.",
  sessionDetail: (minutes, left, seats) =>
    `${esLength(minutes)}${seats > 1 ? ` · ${left === 1 ? "queda" : "quedan"} ${left} de ${seats} plazas` : ""}`,
  moveSeat: "Cambiar mi plaza a esta sesión",
  seatNoCharge: "No se cobra nada. Tu plaza anterior queda libre para otra persona.",
  seatKept: "Tu plaza se te guarda durante 30 minutos mientras pagas.",

  unreadable: "No se pudo leer tu reserva en este momento",
  unreadableBody: "No ha cambiado nada. Vuelve a probar el enlace en un momento.",
  notFound: "No encontramos esta reserva",
  notFoundBody: "Revisa el enlace de tu email de confirmación. Una reserva cuyo horario ya pasó no se puede cambiar.",
  movedLabel: "Horario cambiado",
  yourBooking: "Tu reserva",
  movedTitle: "Tu reserva ha cambiado de horario",
  moveTitle: (title) => `Cambiar ${title} de horario`,
  newTime: "Tu nuevo horario",
  bookedFor: "Reservada para",
  bookedLine: (zone, minutes, title) => `${zone} · ${minutes} minutos · ${title}`,
  addNewTime: "Añadir el nuevo horario a tu calendario",
  movedNote: (store) =>
    `${store} ya está al tanto, y te llega un email con el nuevo horario y un archivo de calendario. El horario anterior vuelve a quedar libre para otra persona.`,
  moveAgain: (left) => ` Puedes cambiarla ${left === 1 ? "una vez más" : `${left} veces más`} desde esta página.`,
  noOtherSession: "No hay otra sesión a la que cambiarla",
  staysAsIs: (store) => `Tu reserva se queda como está. Para preguntarle a ${store} sobre ella, responde a tu email de confirmación.`,
  canMoveUntil: (left, hasMoved, until, zone) =>
    `Puedes cambiarla ${left === 1 ? "una vez más" : `${left} ${hasMoved ? "veces más" : "veces"}`}, hasta el ${until} (${zone}). No se cobra ni se reembolsa nada.`,

  roomLabels: {
    room: "Unirse a la sala de videollamada",
    meet: "Unirse en Google Meet",
    zoom: "Unirse en Zoom",
    other: "Unirse a la llamada",
  },
  videoRoomNote:
    "Es una sala privada de Jitsi Meet (un servicio gratuito de videollamadas gestionado por un tercero). A la primera persona que la abra se le puede pedir que inicie sesión en Jitsi (con una cuenta de Google, por ejemplo) para empezar la reunión; los demás entran sin cuenta una vez que ha empezado.",

  bookedSubject: (title, store) => `Reservado: ${title} con ${store}`,
  seatBooked: (store) => `Tu plaza con ${store} está reservada.`,
  groupBooked: (store) => `Tu lugar en la llamada en grupo con ${store} está reservado.`,
  callBooked: (store) => `Tu llamada con ${store} está reservada.`,
  timeBooked: (store) => `Tu cita con ${store} está reservada.`,
  titleLength: (title, minutes) => `${title}, ${minutes} minutos`,
  joinAtThatTime: (room) => `Únete aquí a esa hora: ${room}`,
  willSendLink: (store) => `${store} te enviará el enlace para unirte antes de la llamada.`,
  calendarAttached: "El archivo de calendario adjunto la añade a tu calendario.",
  remindDayHour: " Recibirás un recordatorio un día antes y otro una hora antes.",
  remindHour: " Recibirás un recordatorio una hora antes.",
  moveYourself: (hours, link) =>
    `Para cambiarla por tu cuenta a otro horario, hasta ${hours} ${plural(hours, "hora", "horas")} antes de que empiece: ${link}`,
  toCancel: (store) => `Para cancelar, responde a este email; la respuesta le llega a ${store}.`,

  movedSubject: (title, store) => `Cambio de horario: ${title} con ${store}`,
  movedHead: (store) => `Tu reserva con ${store} ha cambiado de horario.`,
  nowAt: (when) => `Ahora: ${when}`,
  wasAt: (when) => `Antes: ${when}`,
  joinAtNewTime: (room) => `Únete aquí en el nuevo horario: ${room}`,
  newTimeAttached: "El archivo de calendario adjunto tiene el nuevo horario. Si tu calendario sigue mostrando también el anterior, elimina el anterior.",
  moveAgainLink: (link, count) => `Para volver a cambiarla: ${link} (puedes cambiar una reserva ${count} veces en total).`,
  cannotMoveAgain: (store) =>
    `Esta reserva ya no se puede cambiar desde el enlace. Para modificarla, responde a este email; la respuesta le llega a ${store}.`,

  newLinkSubject: (title, store) => `Nuevo enlace para unirte: ${title} con ${store}`,
  newLinkHead: (title, store) => `El enlace para unirte a ${title} con ${store} ha cambiado. El horario no.`,
  joinOn: (meet, link) => `Únete aquí a esa hora, en ${meet}: ${link}`,
  oldLink: (previous) => `El enlace que recibiste antes (${previous}) ya no es el que debes usar.`,
  replacesFile: "El archivo de calendario adjunto sustituye al que se envió antes.",

  reminderSubject: (isDay, title, store) => `${isDay ? "Mañana" : "En 1 hora"}: ${title} con ${store}`,
  reminderHead: (isDay, title, store) => `Un recordatorio: ${title} con ${store} empieza ${isDay ? "en un día" : "en una hora"}.`,
  whenLength: (when, minutes) => `${when}, ${minutes} minutos`,
  willSendOrReply: (store) => `${store} te enviará el enlace para unirte. Si no te ha llegado, responde a este email.`,
  addToCalendar: (link) => `Añádela a tu calendario: ${link}`,
  moveToAnother: (link) => `Para cambiarla a otro horario: ${link}`,

  icsSummary: (title, store) => `${title} con ${store}`,
  icsAlarm: (title) => `${title} en 15 minutos`,
  icsJoin: (room) => `Unirse: ${room}`,
  icsWillSend: (store) => `${store} enviará el enlace para unirse.`,
  whereAt: (address) => `Dónde: ${address}`,
  depositRest: (amount, store) => `Un depósito para reservar tu hora. El resto, ${amount}, se paga en persona a ${store}.`,
  codeLabel: "Código de descuento (opcional)",
  codeHelp: "Se descuenta del precio completo. Lo que queda después del depósito se paga en persona.",
  codeOffPrice: (code, amount) => `Código ${code}: ${amount} de descuento sobre el precio total.`,
  hostPick: "¿Con quién quieres reservar?",
  hostAny: "Cualquiera disponible",
  hostShow: "Ver sus horarios",
  lengthPick: "¿Cuánto tiempo quieres?",
  lengthChosen: (what: string) => `Horarios para ${what}.`,
  lengthOption: (minutes: number, price: string) => `${minutes} minutos, ${price}`,
  withHost: (name) => `Con ${name}`,
  cancelPolicy: (hours, store) =>
    `Cancela con al menos ${hours} horas de antelación, respondiendo a tu correo de confirmación, y ${store} te devuelve lo que pagaste en línea. Si cancelas más tarde o no vienes, ${store} no tiene que devolverlo. Si ${store} cancela, se te devuelve todo. Esto no afecta a tus derechos según la ley.`,
  cancelTooLate: (hours, store) =>
    `Este horario empieza en menos de ${hours} horas, así que si cancelas o no vienes, ${store} no tiene que devolverte lo que pagaste en línea. Si ${store} cancela, se te devuelve todo. Esto no afecta a tus derechos según la ley.`,

  packageName: (title, sessions) => `${title} — ${sessions} ${plural(sessions, "sesión", "sesiones")}`,
  packageDescription: (sessions, limit) =>
    `${sessions} ${plural(sessions, "sesión", "sesiones")}, cada una reservada cuando quieras. ${limit}.`,
  packageCoupon: "Sesión de un paquete",
  packageSubject: (total, title) => `${plural(total, "Tu", "Tus")} ${total} ${plural(total, "sesión", "sesiones")}: ${title}`,
  packageThanks: (store) => `Gracias por comprarle a ${store}. Esta es tu confirmación.`,
  packageWhat: (title, total) => `Lo que compraste: ${title}, ${total} ${plural(total, "sesión", "sesiones")}`,
  packagePaid: (amount) => `Pagado: ${amount}`,
  packageReference: (reference) => `Referencia del pedido: ${reference}`,
  packageBookByDate: (date) => `Resérvalas a más tardar el ${date}`,
  packageNoLimit: "Sin plazo para reservarlas.",
  packageBookHere: "Reserva cada sesión, cuando quieras, aquí:",
  packageKeep:
    "Guarda este email: con ese enlace reservas el resto. Cada una recibe su propia confirmación, sus recordatorios y su enlace de reunión, y se puede cambiar como cualquier reserva.",
  packageKeepPlace:
    "Guarda este email: con ese enlace reservas el resto. Cada una recibe su propia confirmación y sus recordatorios, con la dirección, y se puede cambiar como cualquier reserva.",
  packageCharged: (store) =>
    `Cobrado por ${store} en su propia cuenta de Stripe. Las preguntas le llegan a ${store} si respondes a este email.`,
};

// ---- French: "vous", a space that cannot break before : ; ? ! ---------------------------

const frLength = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return minutes < 60 ? `${minutes}${S}min` : m ? `${h}${S}h${S}${m}${S}min` : `${h}${S}${pluralFr(h, "heure", "heures")}`;
};
const frTimes = (n: number) => (n === 1 ? "une fois" : `${n}${S}fois`);
const frStays = "Votre réservation n'a pas changé. Pour en parler au créateur, répondez à votre e-mail de confirmation.";

const fr: BookingWords = {
  colon: `${S}: `,
  notices: {
    "pkg-used": { title: "Votre forfait n'a plus de séances", body: "Toutes ses séances sont réservées ou en cours de réservation. Rien n'a été débité." },
    "pkg-expired": {
      title: "Le délai pour réserver avec votre forfait est passé",
      body: "Rien n'a été débité. Répondez à l'e-mail de votre forfait pour poser la question au créateur.",
    },
    "pkg-refunded": { title: "Ce forfait a été remboursé", body: "Il ne permet plus aucune réservation. Rien n'a été débité." },
    "pkg-gone": { title: "Ce lien de forfait ne fonctionne pas", body: "Utilisez le lien de l'e-mail de votre forfait. Rien n'a été débité." },
    "pkg-error": { title: "Nous n'avons pas pu réserver avec votre forfait pour l'instant", body: "Rien n'a été débité. Réessayez dans un instant." },
    taken: {
      title: "Ce créneau vient d'être pris",
      body: `Quelqu'un l'a réservé juste avant vous, ou il est en train d'être payé. Choisissez-en un autre${S}; rien n'a été débité.`,
    },
    invalid: { title: "Choisissez d'abord un créneau", body: "Choisissez l'un des créneaux ci-dessous, puis continuez." },
    error: { title: "Un problème est survenu de notre côté", body: "Rien n'a été débité. Réessayez dans un instant." },
    unavailable: { title: "La réservation n'est pas possible pour l'instant", body: "Rien n'a été débité." },
    "code-unknown": { title: "Ce code ne fonctionne pas ici", body: "Rien n'a été débité. Vérifiez le code, ou réservez sans lui." },
    "code-limited": { title: "Ce code ne peut pas être utilisé avec un acompte", body: "Rien n'a été débité. Un code avec des conditions (utilisations limitées, premier achat ou un seul client, certains produits seulement, ou une date de fin) ne peut pas servir quand une partie du prix se paie en personne. Réservez sans lui." },
    "code-small": { title: "Avec ce code, il reste trop peu à payer en ligne", body: "Rien n'a été débité. Avec ce code, ce qui reste à payer en ligne est sous le plus petit montant qui peut être débité. Réservez sans lui." },
    "host-changed": { title: "L'équipe a changé depuis l'ouverture de cette page", body: "Rien n'a été débité. Choisissez à nouveau avec qui réserver." },
    slow: { title: "Beaucoup de tentatives en quelques minutes", body: "Rien n'a été débité. Patientez quelques minutes, puis choisissez de nouveau un créneau." },
  },
  moveNotices: {
    taken: {
      title: "Ce créneau vient d'être pris",
      body: `Quelqu'un l'a réservé juste avant vous. Votre réservation n'a pas changé${S}; choisissez-en un autre.`,
    },
    invalid: { title: "Choisissez d'abord un créneau", body: "Choisissez l'un des créneaux ci-dessous, puis continuez." },
    same: { title: "C'est déjà votre créneau", body: "Choisissez-en un autre où la déplacer." },
    late: { title: "Le début est trop proche pour la déplacer", body: frStays },
    limit: { title: "Cette réservation a été déplacée autant de fois que possible", body: frStays },
    error: { title: "Un problème est survenu de notre côté", body: "Votre réservation n'a pas changé. Réessayez dans un instant." },
    unavailable: { title: "Les réservations ne peuvent pas être déplacées pour l'instant", body: "Votre réservation n'a pas changé." },
    slow: { title: "Beaucoup de tentatives en quelques minutes", body: "Votre réservation n'a pas changé. Patientez quelques minutes, puis réessayez." },
  },

  packageLeft: (left, total) => `Réservation avec votre forfait${S}: il vous en reste ${left} sur ${total}`,
  packageBookBy: (date) => ` · à réserver au plus tard le ${date}`,
  packageLinkWrong: "Ce lien de forfait ne concerne pas cette réservation, ou ne fonctionne plus. Utilisez le lien de l'e-mail de votre forfait.",
  closedBody: (store) => `La boutique de ${store} n'accepte pas de paiements pour le moment. Rien ici ne peut débiter une carte.`,
  timesUnread: "Les créneaux n'ont pas pu être lus pour l'instant",
  timesUnreadBody: "Rien n'a été débité. Actualisez la page dans un instant.",
  timesUnreadMoveBody: "Votre réservation n'a pas changé. Actualisez la page dans un instant.",

  whereMeet: (meet) => `en ligne, sur ${meet}${S}; vous recevez le lien en réservant`,
  whereVideo: `en ligne, dans une salle vidéo privée${S}; vous recevez le lien en réservant`,
  whereLink: `en ligne${S}; vous recevez le lien en réservant`,
  liveLine: (where) => `Session en direct · ${where}`,
  liveOnline: "Session en direct · en ligne",
  groupLine: (seats, minutes, where) => `Appel de groupe, jusqu'à ${seats}${S}personnes · ${minutes}${S}minutes · ${where}`,
  groupOnline: (seats, minutes) => `Appel de groupe, jusqu'à ${seats}${S}personnes · ${minutes}${S}minutes · en ligne`,
  oneLine: (minutes, where) => `Appel de ${minutes}${S}minutes · ${where}`,
  oneOnline: (minutes) => `Appel de ${minutes}${S}minutes · en ligne`,
  inPersonLine: (minutes, address) => `${minutes}${S}minutes · en personne, adresse${S}: ${address}`,
  inPersonGroupLine: (seats, minutes, address) => `Jusqu'à ${seats}${S}personnes · ${minutes}${S}minutes · en personne, adresse${S}: ${address}`,
  inPersonLiveLine: (address) => `Séance en personne, adresse${S}: ${address}`,

  pickDay: "Choisir un jour",
  noTimes: "Aucun créneau libre pour l'instant",
  noTimesBody: `Tous les créneaux réservables sont pris. Revenez dans un jour ou deux${S}: de nouveaux créneaux s'ouvrent au fil des jours.`,
  noOtherTimes: "Aucun autre créneau n'est libre pour l'instant",
  noOtherTimesBody: `Votre réservation reste telle quelle. Revenez dans un jour ou deux${S}: de nouveaux créneaux s'ouvrent au fil des jours.`,
  seatsLeft: (left) => `${left}${S}${pluralFr(left, "place restante", "places restantes")}`,
  timesInYours: (zone) => `Les horaires sont indiqués dans votre fuseau horaire, ${zone}.`,
  timesInCreators: (zone) => `Les horaires sont indiqués dans le fuseau horaire du créateur, ${zone}.`,
  chosenLength: (minutes) => ` · ${minutes}${S}minutes`,
  continueToPay: (price) => `Continuer vers le paiement — ${price}`,
  moveToTime: "Déplacer ma réservation à ce créneau",
  bookFromPackage: "Réserver ce créneau avec mon forfait",
  moveNoCharge: "Rien n'est débité. Votre ancien créneau est libéré pour quelqu'un d'autre.",
  packageNoCharge: `Vous confirmez sur la page suivante${S}; rien n'est débité.`,
  timeKept: `Le créneau vous est réservé pendant 30${S}minutes, le temps de payer.`,

  noSessions: "Aucune session à réserver pour l'instant",
  noSessionsBody: "Toutes les sessions sont complètes ou trop proches de leur début pour être réservées. Les nouvelles dates apparaissent ici dès qu'elles sont ajoutées.",
  noOtherSessions: "Aucune autre session n'a de place libre pour l'instant",
  seatStays: "Votre place reste telle quelle.",
  sessionDetail: (minutes, left, seats) =>
    `${frLength(minutes)}${seats > 1 ? ` · ${left}${S}${pluralFr(left, "place restante", "places restantes")} sur ${seats}` : ""}`,
  moveSeat: "Déplacer ma place vers cette session",
  seatNoCharge: "Rien n'est débité. Votre ancienne place est libérée pour quelqu'un d'autre.",
  seatKept: `Votre place vous est réservée pendant 30${S}minutes, le temps de payer.`,

  unreadable: "Votre réservation n'a pas pu être lue pour l'instant",
  unreadableBody: "Rien n'a changé. Réessayez le lien dans un instant.",
  notFound: "Nous n'avons pas trouvé cette réservation",
  notFoundBody: "Vérifiez le lien de votre e-mail de confirmation. Une réservation dont l'horaire est passé ne peut pas être déplacée.",
  movedLabel: "Déplacée",
  yourBooking: "Votre réservation",
  movedTitle: "Votre réservation a été déplacée",
  moveTitle: (title) => `Déplacer ${title}`,
  newTime: "Votre nouvel horaire",
  bookedFor: "Réservée pour",
  bookedLine: (zone, minutes, title) => `${zone} · ${minutes}${S}minutes · ${title}`,
  addNewTime: "Ajouter le nouvel horaire à votre agenda",
  movedNote: (store) =>
    `${store} a été prévenu, et un e-mail avec le nouvel horaire et un fichier de calendrier est en route vers vous. L'ancien créneau est de nouveau libre pour quelqu'un d'autre.`,
  moveAgain: (left) => ` Vous pouvez encore la déplacer ${frTimes(left)} depuis cette page.`,
  noOtherSession: "Il n'y a pas d'autre session vers laquelle la déplacer",
  staysAsIs: (store) => `Votre réservation reste telle quelle. Pour en parler à ${store}, répondez à votre e-mail de confirmation.`,
  canMoveUntil: (left, hasMoved, until, zone) =>
    `Vous pouvez la déplacer ${left === 1 || hasMoved ? "encore " : ""}${frTimes(left)}, jusqu'au ${until} (${zone}). Rien n'est débité ni remboursé.`,

  roomLabels: {
    room: "Rejoindre la salle vidéo",
    meet: "Rejoindre sur Google Meet",
    zoom: "Rejoindre sur Zoom",
    other: "Rejoindre l'appel",
  },
  videoRoomNote: `Il s'agit d'une salle Jitsi Meet privée (un service de visioconférence gratuit géré par un tiers). La première personne qui l'ouvre peut devoir se connecter à Jitsi (avec un compte Google, par exemple) pour lancer la réunion${S}; les autres participants la rejoignent sans compte une fois qu'elle a commencé.`,

  bookedSubject: (title, store) => `Réservé${S}: ${title} avec ${store}`,
  seatBooked: (store) => `Votre place avec ${store} est réservée.`,
  groupBooked: (store) => `Votre place dans l'appel de groupe avec ${store} est réservée.`,
  callBooked: (store) => `Votre appel avec ${store} est réservé.`,
  timeBooked: (store) => `Votre rendez-vous avec ${store} est réservé.`,
  titleLength: (title, minutes) => `${title}, ${minutes}${S}minutes`,
  joinAtThatTime: (room) => `Participez ici à l'heure prévue${S}: ${room}`,
  willSendLink: (store) => `${store} vous enverra le lien pour participer avant l'appel.`,
  calendarAttached: "Le fichier de calendrier joint l'ajoute à votre agenda.",
  remindDayHour: " Vous recevrez un rappel un jour avant et un autre une heure avant.",
  remindHour: " Vous recevrez un rappel une heure avant.",
  moveYourself: (hours, link) =>
    `Pour la déplacer vous-même à un autre créneau, jusqu'à ${hours}${S}${pluralFr(hours, "heure", "heures")} avant le début${S}: ${link}`,
  toCancel: (store) => `Pour annuler, répondez à cet e-mail${S}; la réponse est transmise à ${store}.`,

  movedSubject: (title, store) => `Déplacé${S}: ${title} avec ${store}`,
  movedHead: (store) => `Votre réservation avec ${store} a été déplacée.`,
  nowAt: (when) => `Désormais${S}: ${when}`,
  wasAt: (when) => `Avant${S}: ${when}`,
  joinAtNewTime: (room) => `Participez ici au nouvel horaire${S}: ${room}`,
  newTimeAttached: "Le fichier de calendrier joint contient le nouvel horaire. Si votre agenda affiche encore l'ancien aussi, supprimez l'ancien.",
  moveAgainLink: (link, count) => `Pour la déplacer de nouveau${S}: ${link} (une réservation peut être déplacée ${count}${S}fois en tout).`,
  cannotMoveAgain: (store) =>
    `Cette réservation ne peut plus être déplacée depuis le lien. Pour la modifier, répondez à cet e-mail${S}; la réponse est transmise à ${store}.`,

  newLinkSubject: (title, store) => `Nouveau lien pour participer${S}: ${title} avec ${store}`,
  newLinkHead: (title, store) => `Le lien pour participer à ${title} avec ${store} a changé. L'horaire, lui, n'a pas changé.`,
  joinOn: (meet, link) => `Participez ici à l'heure prévue, sur ${meet}${S}: ${link}`,
  oldLink: (previous) => `Le lien qui vous a été envoyé auparavant (${previous}) n'est plus celui à utiliser.`,
  replacesFile: "Le fichier de calendrier joint remplace celui envoyé auparavant.",

  reminderSubject: (isDay, title, store) => `${isDay ? "Demain" : `Dans 1${S}heure`}${S}: ${title} avec ${store}`,
  reminderHead: (isDay, title, store) => `Petit rappel${S}: ${title} avec ${store} commence ${isDay ? "dans un jour" : "dans une heure"}.`,
  whenLength: (when, minutes) => `${when}, ${minutes}${S}minutes`,
  willSendOrReply: (store) => `${store} vous enverra le lien pour participer. S'il ne vous est pas parvenu, répondez à cet e-mail.`,
  addToCalendar: (link) => `Pour l'ajouter à votre agenda${S}: ${link}`,
  moveToAnother: (link) => `Pour déplacer cette réservation à un autre créneau${S}: ${link}`,

  icsSummary: (title, store) => `${title} avec ${store}`,
  icsAlarm: (title) => `${title} dans 15${S}minutes`,
  icsJoin: (room) => `Participer${S}: ${room}`,
  icsWillSend: (store) => `${store} enverra le lien pour participer.`,
  whereAt: (address) => `Où${S}: ${address}`,
  depositRest: (amount, store) => `Un acompte pour réserver votre créneau. Le reste, ${amount}, se paie en personne à ${store}.`,
  codeLabel: "Code de réduction (facultatif)",
  codeHelp: "Il s'applique au prix entier. Ce qui reste après l'acompte se paie en personne.",
  codeOffPrice: (code, amount) => `Code ${code}${S}: ${amount} de moins sur le prix entier.`,
  hostPick: `Avec qui voulez-vous réserver${S}?`,
  hostAny: "Toute personne disponible",
  hostShow: "Voir ses horaires",
  lengthPick: `Quelle durée souhaitez-vous${S}?`,
  lengthChosen: (what: string) => `Horaires pour ${what}.`,
  lengthOption: (minutes: number, price: string) => `${minutes} minutes pour ${price}`,
  withHost: (name) => `Avec ${name}`,
  cancelPolicy: (hours, store) =>
    `Annulez au moins ${hours} heures avant le début, en répondant à votre e-mail de confirmation, et ${store} rembourse ce que vous avez payé en ligne. Si vous annulez plus tard ou ne venez pas, ${store} n'est pas tenu de le rembourser. Si ${store} annule, tout vous est remboursé. Cela ne change rien à vos droits prévus par la loi.`,
  cancelTooLate: (hours, store) =>
    `Ce créneau commence dans moins de ${hours} heures${S}: si vous annulez ou ne venez pas, ${store} n'est pas tenu de rembourser ce que vous avez payé en ligne. Si ${store} annule, tout vous est remboursé. Cela ne change rien à vos droits prévus par la loi.`,

  packageName: (title, sessions) => `${title} — ${sessions}${S}${pluralFr(sessions, "séance", "séances")}`,
  packageDescription: (sessions, limit) =>
    `${sessions}${S}${pluralFr(sessions, "séance", "séances")}, chacune réservée quand vous le souhaitez. ${limit}.`,
  packageCoupon: "Séance d'un forfait",
  packageSubject: (total, title) => `${pluralFr(total, "Votre", "Vos")} ${total}${S}${pluralFr(total, "séance", "séances")}${S}: ${title}`,
  packageThanks: (store) => `Merci pour votre achat auprès de ${store}. Voici votre confirmation.`,
  packageWhat: (title, total) => `Votre achat${S}: ${title}, ${total}${S}${pluralFr(total, "séance", "séances")}`,
  packagePaid: (amount) => `Payé${S}: ${amount}`,
  packageReference: (reference) => `Référence de commande${S}: ${reference}`,
  packageBookByDate: (date) => `À réserver au plus tard le ${date}`,
  packageNoLimit: "Pas de limite de temps pour les réserver.",
  packageBookHere: `Réservez chaque séance, quand vous le souhaitez, ici${S}:`,
  packageKeep: `Conservez cet e-mail${S}: ce lien vous permet de réserver les suivantes. Chacune reçoit sa propre confirmation, ses rappels et son lien de réunion, et peut être déplacée comme n'importe quelle réservation.`,
  packageKeepPlace: `Conservez cet e-mail${S}: ce lien vous permet de réserver les suivantes. Chacune reçoit sa propre confirmation et ses rappels, avec l'adresse, et peut être déplacée comme n'importe quelle réservation.`,
  packageCharged: (store) =>
    `Débité par ${store} sur son propre compte Stripe. Pour toute question, écrivez à ${store} en répondant à cet e-mail.`,
};

// ---- German: "Sie" -------------------------------------------------------------------

const deLength = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return minutes < 60 ? `${minutes} Min.` : m ? `${h} Std. ${m} Min.` : `${h} ${plural(h, "Stunde", "Stunden")}`;
};
const deTimes = (n: number) => (n === 1 ? "einmal" : `${n}-mal`);
const deStays = "Ihre Buchung ist unverändert. Wenn Sie beim Ersteller nachfragen möchten, antworten Sie auf Ihre Bestätigungs-E-Mail.";

const de: BookingWords = {
  colon: ": ",
  notices: {
    "pkg-used": { title: "In Ihrem Paket sind keine Termine mehr übrig", body: "Alle Termine daraus sind gebucht oder werden gerade gebucht. Es wurde nichts berechnet." },
    "pkg-expired": {
      title: "Die Frist zum Buchen mit Ihrem Paket ist abgelaufen",
      body: "Es wurde nichts berechnet. Antworten Sie auf die E-Mail zu Ihrem Paket, um beim Ersteller nachzufragen.",
    },
    "pkg-refunded": { title: "Dieses Paket wurde erstattet", body: "Damit kann nichts mehr gebucht werden. Es wurde nichts berechnet." },
    "pkg-gone": { title: "Dieser Paket-Link funktioniert nicht", body: "Verwenden Sie den Link aus der E-Mail zu Ihrem Paket. Es wurde nichts berechnet." },
    "pkg-error": { title: "Die Buchung aus Ihrem Paket hat gerade nicht geklappt", body: "Es wurde nichts berechnet. Versuchen Sie es gleich noch einmal." },
    taken: {
      title: "Dieser Termin wurde gerade vergeben",
      body: "Jemand hat ihn kurz vor Ihnen gebucht, oder er wird gerade bezahlt. Wählen Sie einen anderen; es wurde nichts berechnet.",
    },
    invalid: { title: "Wählen Sie zuerst einen Termin", body: "Wählen Sie einen der Termine unten und fahren Sie dann fort." },
    error: { title: "Bei uns ist etwas schiefgelaufen", body: "Es wurde nichts berechnet. Versuchen Sie es gleich noch einmal." },
    unavailable: { title: "Das kann gerade nicht gebucht werden", body: "Es wurde nichts berechnet." },
    "code-unknown": { title: "Dieser Code gilt hier nicht", body: "Es wurde nichts berechnet. Prüfen Sie den Code oder buchen Sie ohne ihn." },
    "code-limited": { title: "Dieser Code gilt nicht mit einer Anzahlung", body: "Es wurde nichts berechnet. Ein Code mit Bedingungen (begrenzte Einlösungen, nur erster Kauf oder ein Kunde, nur bestimmte Produkte oder ein Enddatum) gilt nicht, wenn ein Teil des Preises vor Ort bezahlt wird. Buchen Sie ohne ihn." },
    "code-small": { title: "Mit diesem Code bleibt online zu wenig zu zahlen", body: "Es wurde nichts berechnet. Mit diesem Code liegt der online zu zahlende Betrag unter dem kleinsten Betrag, der berechnet werden kann. Buchen Sie ohne ihn." },
    "host-changed": { title: "Das Team hat sich geändert, seit diese Seite geöffnet wurde", body: "Es wurde nichts berechnet. Wählen Sie erneut, bei wem Sie buchen." },
    slow: { title: "Viele Versuche in wenigen Minuten", body: "Es wurde nichts berechnet. Warten Sie ein paar Minuten und wählen Sie dann erneut einen Termin." },
  },
  moveNotices: {
    taken: { title: "Dieser Termin wurde gerade vergeben", body: "Jemand hat ihn kurz vor Ihnen gebucht. Ihre Buchung ist unverändert; wählen Sie einen anderen." },
    invalid: { title: "Wählen Sie zuerst einen Termin", body: "Wählen Sie einen der Termine unten und fahren Sie dann fort." },
    same: { title: "Diesen Termin haben Sie bereits", body: "Wählen Sie einen anderen, auf den Sie verschieben möchten." },
    late: { title: "Der Beginn ist zu nah, um noch zu verschieben", body: deStays },
    limit: { title: "Diese Buchung wurde so oft verschoben wie möglich", body: deStays },
    error: { title: "Bei uns ist etwas schiefgelaufen", body: "Ihre Buchung ist unverändert. Versuchen Sie es gleich noch einmal." },
    unavailable: { title: "Buchungen können gerade nicht verschoben werden", body: "Ihre Buchung ist unverändert." },
    slow: { title: "Viele Versuche in wenigen Minuten", body: "Ihre Buchung ist unverändert. Warten Sie ein paar Minuten und versuchen Sie es dann erneut." },
  },

  packageLeft: (left, total) => `Buchung aus Ihrem Paket: noch ${left} von ${total} übrig`,
  packageBookBy: (date) => ` · zu buchen bis ${date}`,
  packageLinkWrong: "Dieser Paket-Link gilt nicht für diese Buchung oder funktioniert nicht mehr. Verwenden Sie den Link aus der E-Mail zu Ihrem Paket.",
  closedBody: (store) => `Der Shop von ${store} nimmt im Moment keine Zahlungen an. Hier kann keine Karte belastet werden.`,
  timesUnread: "Die Termine konnten gerade nicht geladen werden",
  timesUnreadBody: "Es wurde nichts berechnet. Laden Sie die Seite gleich neu.",
  timesUnreadMoveBody: "Ihre Buchung ist unverändert. Laden Sie die Seite gleich neu.",

  whereMeet: (meet) => `online, über ${meet}; den Link erhalten Sie bei der Buchung`,
  whereVideo: "online, in einem privaten Videoraum; den Link erhalten Sie bei der Buchung",
  whereLink: "online; den Link erhalten Sie bei der Buchung",
  liveLine: (where) => `Live-Session · ${where}`,
  liveOnline: "Live-Session · online",
  groupLine: (seats, minutes, where) => `Gruppengespräch, bis zu ${seats} Personen · ${minutes} Minuten · ${where}`,
  groupOnline: (seats, minutes) => `Gruppengespräch, bis zu ${seats} Personen · ${minutes} Minuten · online`,
  oneLine: (minutes, where) => `${minutes}-minütiges Gespräch · ${where}`,
  oneOnline: (minutes) => `${minutes}-minütiges Gespräch · online`,
  inPersonLine: (minutes, address) => `${minutes} Minuten · vor Ort, Adresse: ${address}`,
  inPersonGroupLine: (seats, minutes, address) => `Bis zu ${seats} Personen · ${minutes} Minuten · vor Ort, Adresse: ${address}`,
  inPersonLiveLine: (address) => `Live-Session · vor Ort, Adresse: ${address}`,

  pickDay: "Tag wählen",
  noTimes: "Gerade sind keine Termine frei",
  noTimesBody: "Alle buchbaren Termine sind vergeben. Schauen Sie in ein oder zwei Tagen wieder vorbei: Mit jedem Tag werden neue Termine frei.",
  noOtherTimes: "Gerade sind keine anderen Termine frei",
  noOtherTimesBody: "Ihre Buchung bleibt, wie sie ist. Schauen Sie in ein oder zwei Tagen wieder vorbei: Mit jedem Tag werden neue Termine frei.",
  seatsLeft: (left) => `Noch ${left} ${plural(left, "Platz", "Plätze")} frei`,
  timesInYours: (zone) => `Die Zeiten sind in Ihrer Zeitzone angegeben, ${zone}.`,
  timesInCreators: (zone) => `Die Zeiten sind in der Zeitzone des Erstellers angegeben, ${zone}.`,
  chosenLength: (minutes) => ` · ${minutes} Minuten`,
  continueToPay: (price) => `Weiter zur Zahlung — ${price}`,
  moveToTime: "Meine Buchung auf diesen Termin verschieben",
  bookFromPackage: "Diesen Termin aus meinem Paket buchen",
  moveNoCharge: "Es wird nichts berechnet. Ihr alter Termin wird für jemand anderen frei.",
  packageNoCharge: "Sie bestätigen auf der nächsten Seite; es wird nichts berechnet.",
  timeKept: "Der Termin wird 30 Minuten lang für Sie reserviert, während Sie bezahlen.",

  noSessions: "Gerade sind keine Sessions buchbar",
  noSessionsBody: "Alle Sessions sind ausgebucht oder beginnen zu bald, um noch gebucht zu werden. Neue Termine erscheinen hier, sobald sie hinzugefügt werden.",
  noOtherSessions: "Gerade hat keine andere Session einen freien Platz",
  seatStays: "Ihr Platz bleibt, wie er ist.",
  sessionDetail: (minutes, left, seats) =>
    `${deLength(minutes)}${seats > 1 ? ` · noch ${left} von ${seats} Plätzen frei` : ""}`,
  moveSeat: "Meinen Platz in diese Session verschieben",
  seatNoCharge: "Es wird nichts berechnet. Ihr alter Platz wird für jemand anderen frei.",
  seatKept: "Ihr Platz wird 30 Minuten lang für Sie reserviert, während Sie bezahlen.",

  unreadable: "Ihre Buchung konnte gerade nicht gelesen werden",
  unreadableBody: "Es hat sich nichts geändert. Versuchen Sie den Link gleich noch einmal.",
  notFound: "Wir konnten diese Buchung nicht finden",
  notFoundBody: "Prüfen Sie den Link in Ihrer Bestätigungs-E-Mail. Eine Buchung, deren Termin vorbei ist, kann nicht verschoben werden.",
  movedLabel: "Verschoben",
  yourBooking: "Ihre Buchung",
  movedTitle: "Ihre Buchung wurde verschoben",
  moveTitle: (title) => `${title} verschieben`,
  newTime: "Ihr neuer Termin",
  bookedFor: "Gebucht für",
  bookedLine: (zone, minutes, title) => `${zone} · ${minutes} Minuten · ${title}`,
  addNewTime: "Den neuen Termin in Ihren Kalender eintragen",
  movedNote: (store) =>
    `${store} wurde informiert, und eine E-Mail mit dem neuen Termin und einer Kalenderdatei ist unterwegs zu Ihnen. Der alte Termin ist wieder frei für jemand anderen.`,
  moveAgain: (left) => ` Sie können sie auf dieser Seite noch ${deTimes(left)} verschieben.`,
  noOtherSession: "Es gibt keine andere Session, auf die Sie verschieben können",
  staysAsIs: (store) => `Ihre Buchung bleibt, wie sie ist. Wenn Sie ${store} dazu etwas fragen möchten, antworten Sie auf Ihre Bestätigungs-E-Mail.`,
  canMoveUntil: (left, hasMoved, until, zone) =>
    `Sie können sie ${left === 1 || hasMoved ? "noch " : ""}${deTimes(left)} verschieben, bis ${until} (${zone}). Es wird nichts berechnet oder erstattet.`,

  roomLabels: {
    room: "Den Videoraum betreten",
    meet: "Über Google Meet teilnehmen",
    zoom: "Über Zoom teilnehmen",
    other: "Am Gespräch teilnehmen",
  },
  videoRoomNote:
    "Dies ist ein privater Jitsi-Meet-Raum (ein kostenloser Videodienst eines Drittanbieters). Wer ihn als Erstes öffnet, muss sich unter Umständen bei Jitsi anmelden (zum Beispiel mit einem Google-Konto), um das Meeting zu starten; alle anderen nehmen ohne Konto teil, sobald es begonnen hat.",

  bookedSubject: (title, store) => `Gebucht: ${title} mit ${store}`,
  seatBooked: (store) => `Ihr Platz bei ${store} ist gebucht.`,
  groupBooked: (store) => `Ihr Platz im Gruppengespräch mit ${store} ist gebucht.`,
  callBooked: (store) => `Ihr Gespräch mit ${store} ist gebucht.`,
  timeBooked: (store) => `Ihr Termin bei ${store} ist gebucht.`,
  titleLength: (title, minutes) => `${title}, ${minutes} Minuten`,
  joinAtThatTime: (room) => `Nehmen Sie zu diesem Zeitpunkt hier teil: ${room}`,
  willSendLink: (store) => `${store} schickt Ihnen vor dem Gespräch den Link zur Teilnahme.`,
  calendarAttached: "Mit der angehängten Kalenderdatei tragen Sie den Termin in Ihren Kalender ein.",
  remindDayHour: " Sie erhalten einen Tag vorher und eine Stunde vorher eine Erinnerung.",
  remindHour: " Sie erhalten eine Stunde vorher eine Erinnerung.",
  moveYourself: (hours, link) =>
    `Um den Termin selbst zu verschieben, bis spätestens ${hours} ${plural(hours, "Stunde", "Stunden")} vor Beginn: ${link}`,
  toCancel: (store) => `Zum Absagen antworten Sie auf diese E-Mail; die Antwort geht an ${store}.`,

  movedSubject: (title, store) => `Verschoben: ${title} mit ${store}`,
  movedHead: (store) => `Ihre Buchung bei ${store} wurde verschoben.`,
  nowAt: (when) => `Neu: ${when}`,
  wasAt: (when) => `Bisher: ${when}`,
  joinAtNewTime: (room) => `Nehmen Sie zum neuen Termin hier teil: ${room}`,
  newTimeAttached: "Die angehängte Kalenderdatei enthält den neuen Termin. Wenn Ihr Kalender zusätzlich noch den alten anzeigt, löschen Sie den alten.",
  moveAgainLink: (link, count) => `Um erneut zu verschieben: ${link} (eine Buchung kann insgesamt ${count}-mal verschoben werden).`,
  cannotMoveAgain: (store) =>
    `Diese Buchung kann über den Link nicht mehr verschoben werden. Um sie zu ändern, antworten Sie auf diese E-Mail; die Antwort geht an ${store}.`,

  newLinkSubject: (title, store) => `Neuer Link zur Teilnahme: ${title} mit ${store}`,
  newLinkHead: (title, store) => `Der Link zur Teilnahme an ${title} mit ${store} hat sich geändert. Der Termin nicht.`,
  joinOn: (meet, link) => `Nehmen Sie zu diesem Zeitpunkt hier teil, über ${meet}: ${link}`,
  oldLink: (previous) => `Der Link, den Sie vorher erhalten haben (${previous}), ist nicht mehr der richtige.`,
  replacesFile: "Die angehängte Kalenderdatei ersetzt die zuvor gesendete.",

  reminderSubject: (isDay, title, store) => `${isDay ? "Morgen" : "In 1 Stunde"}: ${title} mit ${store}`,
  reminderHead: (isDay, title, store) => `Zur Erinnerung: ${title} mit ${store} beginnt ${isDay ? "in einem Tag" : "in einer Stunde"}.`,
  whenLength: (when, minutes) => `${when}, ${minutes} Minuten`,
  willSendOrReply: (store) => `${store} schickt Ihnen den Link zur Teilnahme. Falls er Sie nicht erreicht hat, antworten Sie auf diese E-Mail.`,
  addToCalendar: (link) => `In Ihren Kalender eintragen: ${link}`,
  moveToAnother: (link) => `Auf einen anderen Termin verschieben: ${link}`,

  icsSummary: (title, store) => `${title} mit ${store}`,
  icsAlarm: (title) => `${title} in 15 Minuten`,
  icsJoin: (room) => `Teilnehmen: ${room}`,
  icsWillSend: (store) => `${store} schickt den Link zur Teilnahme.`,
  whereAt: (address) => `Wo: ${address}`,
  depositRest: (amount, store) => `Eine Anzahlung, um Ihren Termin zu sichern. Den Rest, ${amount}, zahlen Sie vor Ort an ${store}.`,
  codeLabel: "Rabattcode (optional)",
  codeHelp: "Er gilt für den ganzen Preis. Was nach der Anzahlung bleibt, zahlen Sie vor Ort.",
  codeOffPrice: (code, amount) => `Code ${code}: ${amount} Rabatt auf den Gesamtpreis.`,
  hostPick: "Bei wem möchten Sie buchen?",
  hostAny: "Wer gerade frei ist",
  hostShow: "Zeiten anzeigen",
  lengthPick: "Wie lange möchten Sie buchen?",
  lengthChosen: (what: string) => `Zeiten für ${what}.`,
  lengthOption: (minutes: number, price: string) => `${minutes} Minuten, ${price}`,
  withHost: (name) => `Bei ${name}`,
  cancelPolicy: (hours, store) =>
    `Stornieren Sie mindestens ${hours} Stunden vor Beginn, indem Sie auf Ihre Bestätigungs-E-Mail antworten, dann erstattet ${store}, was Sie online bezahlt haben. Stornieren Sie später oder kommen Sie nicht, muss ${store} es nicht erstatten. Sagt ${store} ab, bekommen Sie alles zurück. Ihre gesetzlichen Rechte bleiben unberührt.`,
  cancelTooLate: (hours, store) =>
    `Dieser Termin beginnt in weniger als ${hours} Stunden: Stornieren Sie oder kommen Sie nicht, muss ${store} nicht erstatten, was Sie online bezahlt haben. Sagt ${store} ab, bekommen Sie alles zurück. Ihre gesetzlichen Rechte bleiben unberührt.`,

  packageName: (title, sessions) => `${title} — ${sessions} ${plural(sessions, "Termin", "Termine")}`,
  packageDescription: (sessions, limit) =>
    `${sessions} ${plural(sessions, "Termin", "Termine")}, jeder gebucht, wann Sie möchten. ${limit}.`,
  packageCoupon: "Termin aus einem Paket",
  packageSubject: (total, title) => `${plural(total, "Ihr", "Ihre")} ${total} ${plural(total, "Termin", "Termine")}: ${title}`,
  packageThanks: (store) => `Vielen Dank für Ihren Kauf bei ${store}. Dies ist Ihre Bestätigung.`,
  packageWhat: (title, total) => `Ihr Kauf: ${title}, ${total} ${plural(total, "Termin", "Termine")}`,
  packagePaid: (amount) => `Bezahlt: ${amount}`,
  packageReference: (reference) => `Bestellnummer: ${reference}`,
  packageBookByDate: (date) => `Zu buchen bis: ${date}`,
  packageNoLimit: "Ohne zeitliche Begrenzung zu buchen.",
  packageBookHere: "Buchen Sie jeden Termin, wann Sie möchten, hier:",
  packageKeep:
    "Bewahren Sie diese E-Mail auf: Mit diesem Link buchen Sie die übrigen Termine. Jeder erhält eine eigene Bestätigung, eigene Erinnerungen und einen eigenen Meeting-Link und kann wie jede Buchung verschoben werden.",
  packageKeepPlace:
    "Bewahren Sie diese E-Mail auf: Mit diesem Link buchen Sie die übrigen Termine. Jeder erhält eine eigene Bestätigung und eigene Erinnerungen mit der Adresse und kann wie jede Buchung verschoben werden.",
  packageCharged: (store) =>
    `Berechnet von ${store} über das eigene Stripe-Konto. Fragen richten Sie an ${store}, indem Sie auf diese E-Mail antworten.`,
};

// ---- Italian: "tu" -------------------------------------------------------------------

const itLength = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return minutes < 60 ? `${minutes} min` : m ? `${h} h ${m} min` : `${h} ${plural(h, "ora", "ore")}`;
};
const itTimes = (n: number) => (n === 1 ? "una volta" : `${n} volte`);
const itStays = "La tua prenotazione non è cambiata. Per chiedere al creatore, rispondi alla tua email di conferma.";

const it: BookingWords = {
  colon: ": ",
  notices: {
    "pkg-used": { title: "Il tuo pacchetto non ha più sessioni", body: "Tutte le sue sessioni sono prenotate o in fase di prenotazione. Non è stato addebitato nulla." },
    "pkg-expired": {
      title: "Il tempo per prenotare con il tuo pacchetto è scaduto",
      body: "Non è stato addebitato nulla. Rispondi all'email del tuo pacchetto per chiedere al creatore.",
    },
    "pkg-refunded": { title: "Questo pacchetto è stato rimborsato", body: "Non permette più di prenotare. Non è stato addebitato nulla." },
    "pkg-gone": { title: "Quel link del pacchetto non funziona", body: "Usa il link nell'email del tuo pacchetto. Non è stato addebitato nulla." },
    "pkg-error": { title: "Non siamo riusciti a prenotare con il tuo pacchetto in questo momento", body: "Non è stato addebitato nulla. Riprova tra un momento." },
    taken: {
      title: "Quell'orario è appena stato preso",
      body: "Qualcuno l'ha prenotato un attimo prima di te, oppure lo sta pagando proprio ora. Scegline un altro; non è stato addebitato nulla.",
    },
    invalid: { title: "Prima scegli un orario", body: "Scegli uno degli orari qui sotto, poi continua." },
    error: { title: "Qualcosa è andato storto da parte nostra", body: "Non è stato addebitato nulla. Riprova tra un momento." },
    unavailable: { title: "Al momento non si può prenotare", body: "Non è stato addebitato nulla." },
    "code-unknown": { title: "Quel codice qui non vale", body: "Non è stato addebitato nulla. Controlla il codice, oppure prenota senza." },
    "code-limited": { title: "Quel codice non vale con un acconto", body: "Non è stato addebitato nulla. Un codice con condizioni (utilizzi limitati, solo primo acquisto o un solo cliente, solo alcuni prodotti, o una data di fine) non vale quando una parte del prezzo si paga di persona. Prenota senza." },
    "code-small": { title: "Con quel codice resta troppo poco da pagare online", body: "Non è stato addebitato nulla. Con quel codice, quanto resta da pagare online è sotto l'importo minimo che si può addebitare. Prenota senza." },
    "host-changed": { title: "Il team è cambiato da quando hai aperto questa pagina", body: "Non è stato addebitato nulla. Scegli di nuovo con chi prenotare." },
    slow: { title: "Troppi tentativi in pochi minuti", body: "Non è stato addebitato nulla. Attendi qualche minuto, poi scegli di nuovo un orario." },
  },
  moveNotices: {
    taken: { title: "Quell'orario è appena stato preso", body: "Qualcuno l'ha prenotato un attimo prima di te. La tua prenotazione non è cambiata; scegline un altro." },
    invalid: { title: "Prima scegli un orario", body: "Scegli uno degli orari qui sotto, poi continua." },
    same: { title: "È l'orario che hai già", body: "Scegline uno diverso in cui spostarla." },
    late: { title: "Manca troppo poco all'inizio per spostarla", body: itStays },
    limit: { title: "Questa prenotazione è già stata spostata tutte le volte possibili", body: itStays },
    error: { title: "Qualcosa è andato storto da parte nostra", body: "La tua prenotazione non è cambiata. Riprova tra un momento." },
    unavailable: { title: "Al momento le prenotazioni non si possono spostare", body: "La tua prenotazione non è cambiata." },
    slow: { title: "Troppi tentativi in pochi minuti", body: "La tua prenotazione non è cambiata. Attendi qualche minuto, poi riprova." },
  },

  packageLeft: (left, total) => `Prenotazione con il tuo pacchetto: ${plural(left, "ne resta", "ne restano")} ${left} su ${total}`,
  packageBookBy: (date) => ` · scadenza per prenotare: ${date}`,
  packageLinkWrong: "Quel link del pacchetto non è per questa prenotazione, oppure non funziona più. Usa il link nell'email del tuo pacchetto.",
  closedBody: (store) => `Il negozio di ${store} al momento non accetta pagamenti. Qui nessuna carta può essere addebitata.`,
  timesUnread: "Non è stato possibile leggere gli orari in questo momento",
  timesUnreadBody: "Non è stato addebitato nulla. Ricarica la pagina tra un momento.",
  timesUnreadMoveBody: "La tua prenotazione non è cambiata. Ricarica la pagina tra un momento.",

  whereMeet: (meet) => `online, su ${meet}; ricevi il link quando prenoti`,
  whereVideo: "online, in una stanza video privata; ricevi il link quando prenoti",
  whereLink: "online; ricevi il link quando prenoti",
  liveLine: (where) => `Sessione dal vivo · ${where}`,
  liveOnline: "Sessione dal vivo · online",
  groupLine: (seats, minutes, where) => `Chiamata di gruppo, fino a ${seats} persone · ${minutes} minuti · ${where}`,
  groupOnline: (seats, minutes) => `Chiamata di gruppo, fino a ${seats} persone · ${minutes} minuti · online`,
  oneLine: (minutes, where) => `Chiamata di ${minutes} minuti · ${where}`,
  oneOnline: (minutes) => `Chiamata di ${minutes} minuti · online`,
  inPersonLine: (minutes, address) => `${minutes} minuti · di persona, indirizzo: ${address}`,
  inPersonGroupLine: (seats, minutes, address) => `Fino a ${seats} persone · ${minutes} minuti · di persona, indirizzo: ${address}`,
  inPersonLiveLine: (address) => `Sessione dal vivo · di persona, indirizzo: ${address}`,

  pickDay: "Scegli un giorno",
  noTimes: "Nessun orario libero al momento",
  noTimesBody: "Tutti gli orari prenotabili sono occupati. Torna tra un giorno o due: nuovi orari si aprono man mano che passano i giorni.",
  noOtherTimes: "Nessun altro orario libero al momento",
  noOtherTimesBody: "La tua prenotazione resta com'è. Torna tra un giorno o due: nuovi orari si aprono man mano che passano i giorni.",
  seatsLeft: (left) => `${plural(left, "Resta", "Restano")} ${left} ${plural(left, "posto", "posti")}`,
  timesInYours: (zone) => `Gli orari sono nel tuo fuso orario, ${zone}.`,
  timesInCreators: (zone) => `Gli orari sono nel fuso orario del creatore, ${zone}.`,
  chosenLength: (minutes) => ` · ${minutes} minuti`,
  continueToPay: (price) => `Continua al pagamento — ${price}`,
  moveToTime: "Sposta la mia prenotazione a questo orario",
  bookFromPackage: "Prenota questo orario con il mio pacchetto",
  moveNoCharge: "Non viene addebitato nulla. Il tuo vecchio orario si libera per qualcun altro.",
  packageNoCharge: "Lo confermi nella pagina successiva; non viene addebitato nulla.",
  timeKept: "L'orario resta riservato a te per 30 minuti mentre paghi.",

  noSessions: "Nessuna sessione da prenotare al momento",
  noSessionsBody: "Tutte le sessioni sono al completo o troppo vicine all'inizio per essere prenotate. Le nuove date compaiono qui quando vengono aggiunte.",
  noOtherSessions: "Nessun'altra sessione ha un posto libero al momento",
  seatStays: "Il tuo posto resta com'è.",
  sessionDetail: (minutes, left, seats) =>
    `${itLength(minutes)}${seats > 1 ? ` · ${left} ${plural(left, "posto libero", "posti liberi")} su ${seats}` : ""}`,
  moveSeat: "Sposta il mio posto in questa sessione",
  seatNoCharge: "Non viene addebitato nulla. Il tuo vecchio posto si libera per qualcun altro.",
  seatKept: "Il tuo posto resta riservato a te per 30 minuti mentre paghi.",

  unreadable: "Non è stato possibile leggere la tua prenotazione in questo momento",
  unreadableBody: "Non è cambiato nulla. Riprova il link tra un momento.",
  notFound: "Non abbiamo trovato questa prenotazione",
  notFoundBody: "Controlla il link nella tua email di conferma. Una prenotazione il cui orario è passato non si può spostare.",
  movedLabel: "Spostata",
  yourBooking: "La tua prenotazione",
  movedTitle: "La tua prenotazione è stata spostata",
  moveTitle: (title) => `Sposta ${title}`,
  newTime: "Il tuo nuovo orario",
  bookedFor: "Prenotata per",
  bookedLine: (zone, minutes, title) => `${zone} · ${minutes} minuti · ${title}`,
  addNewTime: "Aggiungi il nuovo orario al tuo calendario",
  movedNote: (store) =>
    `${store} è stato avvisato, e un'email con il nuovo orario e un file del calendario sta arrivando. Il vecchio orario è di nuovo libero per qualcun altro.`,
  moveAgain: (left) => ` Puoi spostarla ancora ${itTimes(left)} da questa pagina.`,
  noOtherSession: "Non c'è un'altra sessione in cui spostarla",
  staysAsIs: (store) => `La tua prenotazione resta com'è. Per chiedere a ${store}, rispondi alla tua email di conferma.`,
  canMoveUntil: (left, hasMoved, until, zone) =>
    `Puoi spostarla ${left === 1 || hasMoved ? "ancora " : ""}${itTimes(left)}, fino a ${until} (${zone}). Non viene addebitato né rimborsato nulla.`,

  roomLabels: {
    room: "Entra nella stanza video",
    meet: "Partecipa su Google Meet",
    zoom: "Partecipa su Zoom",
    other: "Partecipa alla chiamata",
  },
  videoRoomNote:
    "È una stanza privata di Jitsi Meet (un servizio video gratuito gestito da terzi). Alla prima persona che la apre potrebbe essere chiesto di accedere a Jitsi (per esempio con un account Google) per avviare la riunione; tutti gli altri entrano senza account una volta iniziata.",

  bookedSubject: (title, store) => `Prenotato: ${title} con ${store}`,
  seatBooked: (store) => `Il tuo posto con ${store} è prenotato.`,
  groupBooked: (store) => `Il tuo posto nella chiamata di gruppo con ${store} è prenotato.`,
  callBooked: (store) => `La tua chiamata con ${store} è prenotata.`,
  timeBooked: (store) => `Il tuo appuntamento con ${store} è prenotato.`,
  titleLength: (title, minutes) => `${title}, ${minutes} minuti`,
  joinAtThatTime: (room) => `Partecipa qui a quell'ora: ${room}`,
  willSendLink: (store) => `${store} ti invierà il link per partecipare prima della chiamata.`,
  calendarAttached: "Il file del calendario allegato la aggiunge al tuo calendario.",
  remindDayHour: " Riceverai un promemoria un giorno prima e uno un'ora prima.",
  remindHour: " Riceverai un promemoria un'ora prima.",
  moveYourself: (hours, link) =>
    `Per spostarla in autonomia a un altro orario, fino a ${hours} ${plural(hours, "ora", "ore")} prima dell'inizio: ${link}`,
  toCancel: (store) => `Per annullare, rispondi a questa email; la risposta arriva a ${store}.`,

  movedSubject: (title, store) => `Spostato: ${title} con ${store}`,
  movedHead: (store) => `La tua prenotazione con ${store} è stata spostata.`,
  nowAt: (when) => `Ora: ${when}`,
  wasAt: (when) => `Prima: ${when}`,
  joinAtNewTime: (room) => `Partecipa qui al nuovo orario: ${room}`,
  newTimeAttached: "Il file del calendario allegato ha il nuovo orario. Se il tuo calendario mostra ancora anche quello vecchio, elimina quello vecchio.",
  moveAgainLink: (link, count) => `Per spostarla di nuovo: ${link} (puoi spostare una prenotazione ${count} volte in tutto).`,
  cannotMoveAgain: (store) =>
    `Questa prenotazione non si può più spostare dal link. Per modificarla, rispondi a questa email; la risposta arriva a ${store}.`,

  newLinkSubject: (title, store) => `Nuovo link per partecipare: ${title} con ${store}`,
  newLinkHead: (title, store) => `Il link per partecipare a ${title} con ${store} è cambiato. L'orario no.`,
  joinOn: (meet, link) => `Partecipa qui a quell'ora, su ${meet}: ${link}`,
  oldLink: (previous) => `Il link che ti è stato inviato prima (${previous}) non è più quello da usare.`,
  replacesFile: "Il file del calendario allegato sostituisce quello inviato prima.",

  reminderSubject: (isDay, title, store) => `${isDay ? "Domani" : "Tra 1 ora"}: ${title} con ${store}`,
  reminderHead: (isDay, title, store) => `Un promemoria: ${title} con ${store} inizia ${isDay ? "tra un giorno" : "tra un'ora"}.`,
  whenLength: (when, minutes) => `${when}, ${minutes} minuti`,
  willSendOrReply: (store) => `${store} ti invierà il link per partecipare. Se non ti è arrivato, rispondi a questa email.`,
  addToCalendar: (link) => `Aggiungila al tuo calendario: ${link}`,
  moveToAnother: (link) => `Per spostarla a un altro orario: ${link}`,

  icsSummary: (title, store) => `${title} con ${store}`,
  icsAlarm: (title) => `${title} tra 15 minuti`,
  icsJoin: (room) => `Partecipa: ${room}`,
  icsWillSend: (store) => `${store} invierà il link per partecipare.`,
  whereAt: (address) => `Dove: ${address}`,
  depositRest: (amount, store) => `Un acconto per riservare il tuo orario. Il resto, ${amount}, si paga di persona a ${store}.`,
  codeLabel: "Codice sconto (facoltativo)",
  codeHelp: "Vale sul prezzo intero. Quanto resta dopo l'acconto si paga di persona.",
  codeOffPrice: (code, amount) => `Codice ${code}: ${amount} in meno sul prezzo intero.`,
  hostPick: "Con chi vuoi prenotare?",
  hostAny: "Chiunque sia disponibile",
  hostShow: "Mostra i suoi orari",
  lengthPick: "Quale durata preferisci?",
  lengthChosen: (what: string) => `Orari per ${what}.`,
  lengthOption: (minutes: number, price: string) => `${minutes} minuti, ${price}`,
  withHost: (name) => `Con ${name}`,
  cancelPolicy: (hours, store) =>
    `Annulla almeno ${hours} ore prima dell'inizio, rispondendo alla tua email di conferma, e ${store} ti rimborsa quanto pagato online. Se annulli oltre questo termine o non vieni, ${store} non è tenuto a rimborsarlo. Se ${store} annulla, ti viene restituito tutto. Questo non tocca i tuoi diritti di legge.`,
  cancelTooLate: (hours, store) =>
    `Questo orario inizia tra meno di ${hours} ore: se annulli o non vieni, ${store} non è tenuto a rimborsare quanto pagato online. Se ${store} annulla, ti viene restituito tutto. Questo non tocca i tuoi diritti di legge.`,

  packageName: (title, sessions) => `${title} — ${sessions} ${plural(sessions, "sessione", "sessioni")}`,
  packageDescription: (sessions, limit) =>
    `${sessions} ${plural(sessions, "sessione", "sessioni")}, ciascuna prenotata quando vuoi. ${limit}.`,
  packageCoupon: "Sessione da un pacchetto",
  packageSubject: (total, title) => `${plural(total, "La tua", "Le tue")} ${total} ${plural(total, "sessione", "sessioni")}: ${title}`,
  packageThanks: (store) => `Grazie per aver acquistato da ${store}. Questa è la tua conferma.`,
  packageWhat: (title, total) => `Cosa hai acquistato: ${title}, ${total} ${plural(total, "sessione", "sessioni")}`,
  packagePaid: (amount) => `Pagato: ${amount}`,
  packageReference: (reference) => `Riferimento dell'ordine: ${reference}`,
  packageBookByDate: (date) => `Scadenza per prenotarle: ${date}`,
  packageNoLimit: "Nessun limite di tempo per prenotarle.",
  packageBookHere: "Prenota ogni sessione, quando vuoi, qui:",
  packageKeep:
    "Conserva questa email: con quel link prenoti le altre. Ognuna riceve la propria conferma, i propri promemoria e il proprio link alla riunione, e si può spostare come qualsiasi prenotazione.",
  packageKeepPlace:
    "Conserva questa email: con quel link prenoti le altre. Ognuna riceve la propria conferma e i propri promemoria, con l'indirizzo, e si può spostare come qualsiasi prenotazione.",
  packageCharged: (store) =>
    `Addebitato da ${store} sul proprio conto Stripe. Per qualsiasi domanda, scrivi a ${store} rispondendo a questa email.`,
};

// ---- Dutch: "je/jij" -----------------------------------------------------------------

const nlLength = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return minutes < 60 ? `${minutes} min` : m ? `${h} u ${m} min` : `${h} uur`;
};
const nlTimes = (n: number) => (n === 1 ? "één keer" : `${n} keer`);
const nlStays = "Je boeking is niet gewijzigd. Wil je de maker er iets over vragen, beantwoord dan je bevestigingsmail.";

const nl: BookingWords = {
  colon: ": ",
  notices: {
    "pkg-used": { title: "Je pakket heeft geen sessies meer over", body: "Alle sessies ervan zijn geboekt of worden net geboekt. Er is niets afgeschreven." },
    "pkg-expired": {
      title: "De termijn om met je pakket te boeken is voorbij",
      body: "Er is niets afgeschreven. Beantwoord de e-mail van je pakket om het de maker te vragen.",
    },
    "pkg-refunded": { title: "Dit pakket is terugbetaald", body: "Er kan niets meer mee worden geboekt. Er is niets afgeschreven." },
    "pkg-gone": { title: "Die pakketlink werkt niet", body: "Gebruik de link in de e-mail van je pakket. Er is niets afgeschreven." },
    "pkg-error": { title: "We konden nu niet boeken met je pakket", body: "Er is niets afgeschreven. Probeer het zo meteen opnieuw." },
    taken: {
      title: "Die tijd is net bezet",
      body: "Iemand heeft hem vlak voor jou geboekt, of er wordt op dit moment voor betaald. Kies een andere; er is niets afgeschreven.",
    },
    invalid: { title: "Kies eerst een tijd", body: "Kies een van de tijden hieronder en ga dan verder." },
    error: { title: "Er ging bij ons iets mis", body: "Er is niets afgeschreven. Probeer het zo meteen opnieuw." },
    unavailable: { title: "Dit kan nu niet worden geboekt", body: "Er is niets afgeschreven." },
    "code-unknown": { title: "Die code werkt hier niet", body: "Er is niets afgeschreven. Controleer de code, of boek zonder." },
    "code-limited": { title: "Die code werkt niet met een aanbetaling", body: "Er is niets afgeschreven. Een code met voorwaarden (beperkt aantal keer gebruik, alleen een eerste aankoop of één klant, alleen sommige producten, of een einddatum) werkt niet als een deel van de prijs ter plaatse wordt betaald. Boek zonder." },
    "code-small": { title: "Met die code blijft er te weinig online te betalen", body: "Er is niets afgeschreven. Met die code ligt wat online te betalen overblijft onder het kleinste bedrag dat kan worden afgeschreven. Boek zonder." },
    "host-changed": { title: "Het team is veranderd sinds deze pagina openging", body: "Er is niets afgeschreven. Kies opnieuw bij wie je boekt." },
    slow: { title: "Veel pogingen in een paar minuten", body: "Er is niets afgeschreven. Wacht een paar minuten en kies dan opnieuw een tijd." },
  },
  moveNotices: {
    taken: { title: "Die tijd is net bezet", body: "Iemand heeft hem vlak voor jou geboekt. Je boeking is niet gewijzigd; kies een andere." },
    invalid: { title: "Kies eerst een tijd", body: "Kies een van de tijden hieronder en ga dan verder." },
    same: { title: "Dat is de tijd die je al hebt", body: "Kies een andere tijd om naartoe te verplaatsen." },
    late: { title: "Het begin is te dichtbij om nog te verplaatsen", body: nlStays },
    limit: { title: "Deze boeking is al zo vaak verplaatst als mogelijk is", body: nlStays },
    error: { title: "Er ging bij ons iets mis", body: "Je boeking is niet gewijzigd. Probeer het zo meteen opnieuw." },
    unavailable: { title: "Boekingen kunnen nu niet worden verplaatst", body: "Je boeking is niet gewijzigd." },
    slow: { title: "Veel pogingen in een paar minuten", body: "Je boeking is niet gewijzigd. Wacht een paar minuten en probeer het dan opnieuw." },
  },

  packageLeft: (left, total) => `Boeken met je pakket: nog ${left} van de ${total} over`,
  packageBookBy: (date) => ` · uiterlijk te boeken op ${date}`,
  packageLinkWrong: "Die pakketlink is niet voor deze boeking, of werkt niet meer. Gebruik de link in de e-mail van je pakket.",
  closedBody: (store) => `De winkel van ${store} neemt op dit moment geen betalingen aan. Hier kan geen kaart worden belast.`,
  timesUnread: "De tijden konden nu niet worden geladen",
  timesUnreadBody: "Er is niets afgeschreven. Vernieuw de pagina zo meteen.",
  timesUnreadMoveBody: "Je boeking is niet gewijzigd. Vernieuw de pagina zo meteen.",

  whereMeet: (meet) => `online, via ${meet}; je krijgt de link bij het boeken`,
  whereVideo: "online, in een privévideoruimte; je krijgt de link bij het boeken",
  whereLink: "online; je krijgt de link bij het boeken",
  liveLine: (where) => `Livesessie · ${where}`,
  liveOnline: "Livesessie · online",
  groupLine: (seats, minutes, where) => `Groepsgesprek, tot ${seats} personen · ${minutes} minuten · ${where}`,
  groupOnline: (seats, minutes) => `Groepsgesprek, tot ${seats} personen · ${minutes} minuten · online`,
  oneLine: (minutes, where) => `Gesprek van ${minutes} minuten · ${where}`,
  oneOnline: (minutes) => `Gesprek van ${minutes} minuten · online`,
  inPersonLine: (minutes, address) => `${minutes} minuten · ter plaatse, adres: ${address}`,
  inPersonGroupLine: (seats, minutes, address) => `Tot ${seats} personen · ${minutes} minuten · ter plaatse, adres: ${address}`,
  inPersonLiveLine: (address) => `Livesessie · ter plaatse, adres: ${address}`,

  pickDay: "Kies een dag",
  noTimes: "Er zijn nu geen vrije tijden",
  noTimesBody: "Elke tijd die geboekt kan worden, is bezet. Kom over een dag of twee terug: naarmate de dagen verstrijken, komen er nieuwe tijden vrij.",
  noOtherTimes: "Er zijn nu geen andere vrije tijden",
  noOtherTimesBody: "Je boeking blijft zoals hij is. Kom over een dag of twee terug: naarmate de dagen verstrijken, komen er nieuwe tijden vrij.",
  seatsLeft: (left) => `Nog ${left} ${plural(left, "plek", "plekken")} vrij`,
  timesInYours: (zone) => `De tijden staan in jouw tijdzone, ${zone}.`,
  timesInCreators: (zone) => `De tijden staan in de tijdzone van de maker, ${zone}.`,
  chosenLength: (minutes) => ` · ${minutes} minuten`,
  continueToPay: (price) => `Verder naar betalen — ${price}`,
  moveToTime: "Mijn boeking naar deze tijd verplaatsen",
  bookFromPackage: "Deze tijd boeken met mijn pakket",
  moveNoCharge: "Er wordt niets afgeschreven. Je oude tijd komt vrij voor iemand anders.",
  packageNoCharge: "Je bevestigt het op de volgende pagina; er wordt niets afgeschreven.",
  timeKept: "De tijd wordt 30 minuten voor je vastgehouden terwijl je betaalt.",

  noSessions: "Er zijn nu geen sessies te boeken",
  noSessionsBody: "Elke sessie is vol of begint te snel om nog te boeken. Nieuwe data verschijnen hier zodra ze worden toegevoegd.",
  noOtherSessions: "Geen andere sessie heeft nu een vrije plek",
  seatStays: "Je plek blijft zoals hij is.",
  sessionDetail: (minutes, left, seats) =>
    `${nlLength(minutes)}${seats > 1 ? ` · nog ${left} van de ${seats} plekken vrij` : ""}`,
  moveSeat: "Mijn plek naar deze sessie verplaatsen",
  seatNoCharge: "Er wordt niets afgeschreven. Je oude plek komt vrij voor iemand anders.",
  seatKept: "Je plek wordt 30 minuten voor je vastgehouden terwijl je betaalt.",

  unreadable: "Je boeking kon nu niet worden gelezen",
  unreadableBody: "Er is niets veranderd. Probeer de link zo meteen opnieuw.",
  notFound: "We konden deze boeking niet vinden",
  notFoundBody: "Controleer de link in je bevestigingsmail. Een boeking waarvan de tijd voorbij is, kan niet worden verplaatst.",
  movedLabel: "Verplaatst",
  yourBooking: "Je boeking",
  movedTitle: "Je boeking is verplaatst",
  moveTitle: (title) => `${title} verplaatsen`,
  newTime: "Je nieuwe tijd",
  bookedFor: "Geboekt voor",
  bookedLine: (zone, minutes, title) => `${zone} · ${minutes} minuten · ${title}`,
  addNewTime: "De nieuwe tijd aan je agenda toevoegen",
  movedNote: (store) =>
    `${store} is op de hoogte gebracht, en er is een e-mail met de nieuwe tijd en een agendabestand naar je onderweg. De oude tijd is weer vrij voor iemand anders.`,
  moveAgain: (left) => ` Je kunt hem vanaf deze pagina nog ${nlTimes(left)} verplaatsen.`,
  noOtherSession: "Er is geen andere sessie om naartoe te verplaatsen",
  staysAsIs: (store) => `Je boeking blijft zoals hij is. Wil je ${store} er iets over vragen, beantwoord dan je bevestigingsmail.`,
  canMoveUntil: (left, hasMoved, until, zone) =>
    `Je kunt hem ${left === 1 || hasMoved ? "nog " : ""}${nlTimes(left)} verplaatsen, tot ${until} (${zone}). Er wordt niets afgeschreven of terugbetaald.`,

  roomLabels: {
    room: "Naar de videoruimte",
    meet: "Deelnemen via Google Meet",
    zoom: "Deelnemen via Zoom",
    other: "Deelnemen aan het gesprek",
  },
  videoRoomNote:
    "Dit is een privéruimte in Jitsi Meet (een gratis videodienst van een derde partij). Wie hem als eerste opent, moet mogelijk inloggen bij Jitsi (bijvoorbeeld met een Google-account) om de vergadering te starten; alle anderen doen zonder account mee zodra die begonnen is.",

  bookedSubject: (title, store) => `Geboekt: ${title} met ${store}`,
  seatBooked: (store) => `Je plek bij ${store} is geboekt.`,
  groupBooked: (store) => `Je plek in het groepsgesprek met ${store} is geboekt.`,
  callBooked: (store) => `Je gesprek met ${store} is geboekt.`,
  timeBooked: (store) => `Je afspraak bij ${store} is geboekt.`,
  titleLength: (title, minutes) => `${title}, ${minutes} minuten`,
  joinAtThatTime: (room) => `Doe op dat moment hier mee: ${room}`,
  willSendLink: (store) => `${store} stuurt je vóór het gesprek de link om mee te doen.`,
  calendarAttached: "Met het bijgevoegde agendabestand zet je het in je agenda.",
  remindDayHour: " Je krijgt een dag van tevoren en een uur van tevoren een herinnering.",
  remindHour: " Je krijgt een uur van tevoren een herinnering.",
  moveYourself: (hours, link) => `Om het zelf naar een andere tijd te verplaatsen, tot ${hours} uur voor het begin: ${link}`,
  toCancel: (store) => `Om te annuleren beantwoord je deze e-mail; het antwoord gaat naar ${store}.`,

  movedSubject: (title, store) => `Verplaatst: ${title} met ${store}`,
  movedHead: (store) => `Je boeking bij ${store} is verplaatst.`,
  nowAt: (when) => `Nu: ${when}`,
  wasAt: (when) => `Eerder: ${when}`,
  joinAtNewTime: (room) => `Doe op de nieuwe tijd hier mee: ${room}`,
  newTimeAttached: "Het bijgevoegde agendabestand heeft de nieuwe tijd. Staat de oude ook nog in je agenda, verwijder dan de oude.",
  moveAgainLink: (link, count) => `Om opnieuw te verplaatsen: ${link} (je kunt een boeking in totaal ${count} keer verplaatsen).`,
  cannotMoveAgain: (store) =>
    `Deze boeking kan niet meer via de link worden verplaatst. Om hem te wijzigen, beantwoord je deze e-mail; het antwoord gaat naar ${store}.`,

  newLinkSubject: (title, store) => `Nieuwe link om mee te doen: ${title} met ${store}`,
  newLinkHead: (title, store) => `De link om mee te doen aan ${title} met ${store} is gewijzigd. De tijd niet.`,
  joinOn: (meet, link) => `Doe op dat moment hier mee, via ${meet}: ${link}`,
  oldLink: (previous) => `De link die je eerder kreeg (${previous}) is niet meer de juiste.`,
  replacesFile: "Het bijgevoegde agendabestand vervangt het eerder verstuurde.",

  reminderSubject: (isDay, title, store) => `${isDay ? "Morgen" : "Over 1 uur"}: ${title} met ${store}`,
  reminderHead: (isDay, title, store) => `Een herinnering: ${title} met ${store} begint ${isDay ? "over een dag" : "over een uur"}.`,
  whenLength: (when, minutes) => `${when}, ${minutes} minuten`,
  willSendOrReply: (store) => `${store} stuurt je de link om mee te doen. Heb je hem nog niet ontvangen, beantwoord dan deze e-mail.`,
  addToCalendar: (link) => `Zet het in je agenda: ${link}`,
  moveToAnother: (link) => `Naar een andere tijd verplaatsen: ${link}`,

  icsSummary: (title, store) => `${title} met ${store}`,
  icsAlarm: (title) => `${title} over 15 minuten`,
  icsJoin: (room) => `Meedoen: ${room}`,
  icsWillSend: (store) => `${store} stuurt de link om mee te doen.`,
  whereAt: (address) => `Waar: ${address}`,
  depositRest: (amount, store) => `Een aanbetaling om je tijd vast te leggen. De rest, ${amount}, betaal je ter plaatse aan ${store}.`,
  codeLabel: "Kortingscode (optioneel)",
  codeHelp: "Die gaat van de hele prijs af. Wat na de aanbetaling overblijft, betaal je ter plaatse.",
  codeOffPrice: (code, amount) => `Code ${code}: ${amount} korting op de hele prijs.`,
  hostPick: "Bij wie wil je boeken?",
  hostAny: "Wie er beschikbaar is",
  hostShow: "Toon de tijden",
  lengthPick: "Hoe lang wil je boeken?",
  lengthChosen: (what: string) => `Tijden voor ${what}.`,
  lengthOption: (minutes: number, price: string) => `${minutes} minuten, ${price}`,
  withHost: (name) => `Bij ${name}`,
  cancelPolicy: (hours, store) =>
    `Annuleer minstens ${hours} uur voor de start, door te antwoorden op je bevestigingsmail, en ${store} betaalt terug wat je online betaalde. Annuleer je later of kom je niet, dan hoeft ${store} het niet terug te betalen. Annuleert ${store}, dan krijg je alles terug. Dit doet niets af aan je wettelijke rechten.`,
  cancelTooLate: (hours, store) =>
    `Deze tijd begint over minder dan ${hours} uur: annuleer je of kom je niet, dan hoeft ${store} niet terug te betalen wat je online betaalde. Annuleert ${store}, dan krijg je alles terug. Dit doet niets af aan je wettelijke rechten.`,

  packageName: (title, sessions) => `${title} — ${sessions} ${plural(sessions, "sessie", "sessies")}`,
  packageDescription: (sessions, limit) =>
    `${sessions} ${plural(sessions, "sessie", "sessies")}, elk geboekt wanneer je wilt. ${limit}.`,
  packageCoupon: "Sessie uit een pakket",
  packageSubject: (total, title) => `Je ${total} ${plural(total, "sessie", "sessies")}: ${title}`,
  packageThanks: (store) => `Bedankt voor je aankoop bij ${store}. Dit is je bevestiging.`,
  packageWhat: (title, total) => `Wat je kocht: ${title}, ${total} ${plural(total, "sessie", "sessies")}`,
  packagePaid: (amount) => `Betaald: ${amount}`,
  packageReference: (reference) => `Bestelreferentie: ${reference}`,
  packageBookByDate: (date) => `Uiterlijk te boeken op: ${date}`,
  packageNoLimit: "Geen tijdslimiet om ze te boeken.",
  packageBookHere: "Boek elke sessie wanneer je wilt, hier:",
  packageKeep:
    "Bewaar deze e-mail: met die link boek je de rest. Elke sessie krijgt een eigen bevestiging, eigen herinneringen en een eigen vergaderlink, en kan worden verplaatst zoals elke boeking.",
  packageKeepPlace:
    "Bewaar deze e-mail: met die link boek je de rest. Elke afspraak krijgt een eigen bevestiging en eigen herinneringen, met het adres, en kan worden verplaatst zoals elke boeking.",
  packageCharged: (store) =>
    `In rekening gebracht door ${store} op de eigen Stripe-rekening. Vragen stel je aan ${store} door deze e-mail te beantwoorden.`,
};

// ---- European Portuguese: the courteous third person ("o seu", "pode") ----------------

const ptLength = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return minutes < 60 ? `${minutes} min` : m ? `${h} h ${m} min` : `${h} ${plural(h, "hora", "horas")}`;
};
const ptTimes = (n: number) => (n === 1 ? "uma vez" : `${n} vezes`);
const ptStays = "A sua marcação não foi alterada. Para perguntar ao criador, responda ao seu email de confirmação.";

const pt: BookingWords = {
  colon: ": ",
  notices: {
    "pkg-used": { title: "O seu pacote já não tem sessões disponíveis", body: "Todas as sessões estão marcadas ou a ser marcadas. Nada foi cobrado." },
    "pkg-expired": {
      title: "O prazo para marcar com o seu pacote terminou",
      body: "Nada foi cobrado. Responda ao email do seu pacote para perguntar ao criador.",
    },
    "pkg-refunded": { title: "Este pacote foi reembolsado", body: "Já não permite marcar mais nada. Nada foi cobrado." },
    "pkg-gone": { title: "Essa ligação do pacote não funciona", body: "Utilize a ligação do email do seu pacote. Nada foi cobrado." },
    "pkg-error": { title: "Não foi possível marcar com o seu pacote neste momento", body: "Nada foi cobrado. Tente novamente daqui a pouco." },
    taken: {
      title: "Esse horário acabou de ser ocupado",
      body: "Alguém o marcou momentos antes de si, ou está a ser pago neste momento. Escolha outro; nada foi cobrado.",
    },
    invalid: { title: "Escolha primeiro um horário", body: "Escolha um dos horários abaixo e depois continue." },
    error: { title: "Algo correu mal do nosso lado", body: "Nada foi cobrado. Tente novamente daqui a pouco." },
    unavailable: { title: "Neste momento não é possível marcar", body: "Nada foi cobrado." },
    "code-unknown": { title: "Esse código não funciona aqui", body: "Nada foi cobrado. Confirme o código, ou marque sem ele." },
    "code-limited": { title: "Esse código não pode ser usado com um sinal", body: "Nada foi cobrado. Um código com condições (utilizações limitadas, só primeira compra ou um único cliente, só alguns produtos, ou uma data de fim) não pode ser usado quando parte do preço é paga presencialmente. Marque sem ele." },
    "code-small": { title: "Com esse código fica muito pouco para pagar online", body: "Nada foi cobrado. Com esse código, o que fica para pagar online está abaixo do valor mínimo que pode ser cobrado. Marque sem ele." },
    "host-changed": { title: "A equipa mudou desde que esta página foi aberta", body: "Nada foi cobrado. Escolha de novo com quem quer marcar." },
    slow: { title: "Demasiadas tentativas em poucos minutos", body: "Nada foi cobrado. Aguarde alguns minutos e escolha novamente um horário." },
  },
  moveNotices: {
    taken: { title: "Esse horário acabou de ser ocupado", body: "Alguém o marcou momentos antes de si. A sua marcação não foi alterada; escolha outro." },
    invalid: { title: "Escolha primeiro um horário", body: "Escolha um dos horários abaixo e depois continue." },
    same: { title: "Esse é o horário que já tem", body: "Escolha outro para onde a mudar." },
    late: { title: "Falta muito pouco para o início para a mudar", body: ptStays },
    limit: { title: "Esta marcação já foi mudada todas as vezes possíveis", body: ptStays },
    error: { title: "Algo correu mal do nosso lado", body: "A sua marcação não foi alterada. Tente novamente daqui a pouco." },
    unavailable: { title: "Neste momento não é possível mudar marcações", body: "A sua marcação não foi alterada." },
    slow: { title: "Demasiadas tentativas em poucos minutos", body: "A sua marcação não foi alterada. Aguarde alguns minutos e tente novamente." },
  },

  packageLeft: (left, total) => `A marcar com o seu pacote: ${plural(left, "resta", "restam")} ${left} de ${total}`,
  packageBookBy: (date) => ` · marcar até ${date}`,
  packageLinkWrong: "Essa ligação do pacote não é para esta marcação ou já não funciona. Utilize a ligação do email do seu pacote.",
  closedBody: (store) => `A loja de ${store} não está a aceitar pagamentos de momento. Nada aqui pode cobrar um cartão.`,
  timesUnread: "Não foi possível ler os horários neste momento",
  timesUnreadBody: "Nada foi cobrado. Atualize a página daqui a pouco.",
  timesUnreadMoveBody: "A sua marcação não foi alterada. Atualize a página daqui a pouco.",

  whereMeet: (meet) => `online, no ${meet}; recebe a ligação ao marcar`,
  whereVideo: "online, numa sala de vídeo privada; recebe a ligação ao marcar",
  whereLink: "online; recebe a ligação ao marcar",
  liveLine: (where) => `Sessão em direto · ${where}`,
  liveOnline: "Sessão em direto · online",
  groupLine: (seats, minutes, where) => `Chamada de grupo, até ${seats} pessoas · ${minutes} minutos · ${where}`,
  groupOnline: (seats, minutes) => `Chamada de grupo, até ${seats} pessoas · ${minutes} minutos · online`,
  oneLine: (minutes, where) => `Chamada de ${minutes} minutos · ${where}`,
  oneOnline: (minutes) => `Chamada de ${minutes} minutos · online`,
  inPersonLine: (minutes, address) => `${minutes} minutos · presencial, morada: ${address}`,
  inPersonGroupLine: (seats, minutes, address) => `Até ${seats} pessoas · ${minutes} minutos · presencial, morada: ${address}`,
  inPersonLiveLine: (address) => `Sessão presencial, morada: ${address}`,

  pickDay: "Escolher um dia",
  noTimes: "Não há horários livres neste momento",
  noTimesBody: "Todos os horários que podem ser marcados estão ocupados. Volte daqui a um ou dois dias: abrem novos horários à medida que os dias passam.",
  noOtherTimes: "Não há outros horários livres neste momento",
  noOtherTimesBody: "A sua marcação mantém-se como está. Volte daqui a um ou dois dias: abrem novos horários à medida que os dias passam.",
  seatsLeft: (left) => `${plural(left, "Resta", "Restam")} ${left} ${plural(left, "lugar", "lugares")}`,
  timesInYours: (zone) => `Os horários estão no seu fuso horário, ${zone}.`,
  timesInCreators: (zone) => `Os horários estão no fuso horário do criador, ${zone}.`,
  chosenLength: (minutes) => ` · ${minutes} minutos`,
  continueToPay: (price) => `Continuar para o pagamento — ${price}`,
  moveToTime: "Mudar a minha marcação para este horário",
  bookFromPackage: "Marcar este horário com o meu pacote",
  moveNoCharge: "Nada é cobrado. O seu horário anterior fica livre para outra pessoa.",
  packageNoCharge: "Confirma na página seguinte; nada é cobrado.",
  timeKept: "O horário fica reservado para si durante 30 minutos enquanto paga.",

  noSessions: "Não há sessões para marcar neste momento",
  noSessionsBody: "Todas as sessões estão cheias ou demasiado próximas do início para serem marcadas. As novas datas aparecem aqui quando forem adicionadas.",
  noOtherSessions: "Nenhuma outra sessão tem lugares livres neste momento",
  seatStays: "O seu lugar mantém-se como está.",
  sessionDetail: (minutes, left, seats) =>
    `${ptLength(minutes)}${seats > 1 ? ` · ${plural(left, "resta", "restam")} ${left} de ${seats} lugares` : ""}`,
  moveSeat: "Mudar o meu lugar para esta sessão",
  seatNoCharge: "Nada é cobrado. O seu lugar anterior fica livre para outra pessoa.",
  seatKept: "O seu lugar fica reservado para si durante 30 minutos enquanto paga.",

  unreadable: "Não foi possível ler a sua marcação neste momento",
  unreadableBody: "Nada mudou. Tente a ligação novamente daqui a pouco.",
  notFound: "Não encontrámos esta marcação",
  notFoundBody: "Verifique a ligação no seu email de confirmação. Uma marcação cujo horário já passou não pode ser mudada.",
  movedLabel: "Remarcada",
  yourBooking: "A sua marcação",
  movedTitle: "A sua marcação mudou de horário",
  moveTitle: (title) => `Mudar ${title} de horário`,
  newTime: "O seu novo horário",
  bookedFor: "Marcada para",
  bookedLine: (zone, minutes, title) => `${zone} · ${minutes} minutos · ${title}`,
  addNewTime: "Adicionar o novo horário ao seu calendário",
  movedNote: (store) =>
    `${store} já foi avisado, e vai receber um email com o novo horário e um ficheiro de calendário. O horário anterior fica livre para outra pessoa.`,
  moveAgain: (left) => ` Pode mudá-la mais ${ptTimes(left)} a partir desta página.`,
  noOtherSession: "Não há outra sessão para onde a mudar",
  staysAsIs: (store) => `A sua marcação mantém-se como está. Para perguntar a ${store}, responda ao seu email de confirmação.`,
  canMoveUntil: (left, hasMoved, until, zone) =>
    `Pode mudá-la ${left === 1 || hasMoved ? "mais " : ""}${ptTimes(left)}, até ${until} (${zone}). Nada é cobrado nem reembolsado.`,

  roomLabels: {
    room: "Entrar na sala de vídeo",
    meet: "Entrar no Google Meet",
    zoom: "Entrar no Zoom",
    other: "Entrar na chamada",
  },
  videoRoomNote:
    "Trata-se de uma sala privada do Jitsi Meet (um serviço de vídeo gratuito gerido por terceiros). A primeira pessoa a abri-la pode ter de iniciar sessão no Jitsi (com uma conta Google, por exemplo) para começar a reunião; todas as outras entram sem conta depois de a reunião ter começado.",

  bookedSubject: (title, store) => `Marcado: ${title} com ${store}`,
  seatBooked: (store) => `O seu lugar com ${store} está marcado.`,
  groupBooked: (store) => `O seu lugar na chamada de grupo com ${store} está marcado.`,
  callBooked: (store) => `A sua chamada com ${store} está marcada.`,
  timeBooked: (store) => `A sua marcação com ${store} está confirmada.`,
  titleLength: (title, minutes) => `${title}, ${minutes} minutos`,
  joinAtThatTime: (room) => `Entre aqui a essa hora: ${room}`,
  willSendLink: (store) => `${store} vai enviar-lhe a ligação para entrar antes da chamada.`,
  calendarAttached: "O ficheiro de calendário em anexo adiciona-a ao seu calendário.",
  remindDayHour: " Vai receber um lembrete um dia antes e outro uma hora antes.",
  remindHour: " Vai receber um lembrete uma hora antes.",
  moveYourself: (hours, link) =>
    `Para a mudar por si para outro horário, até ${hours} ${plural(hours, "hora", "horas")} antes do início: ${link}`,
  toCancel: (store) => `Para cancelar, responda a este email; a resposta chega a ${store}.`,

  movedSubject: (title, store) => `Remarcado: ${title} com ${store}`,
  movedHead: (store) => `A sua marcação com ${store} mudou de horário.`,
  nowAt: (when) => `Agora: ${when}`,
  wasAt: (when) => `Antes: ${when}`,
  joinAtNewTime: (room) => `Entre aqui no novo horário: ${room}`,
  newTimeAttached: "O ficheiro de calendário em anexo tem o novo horário. Se o seu calendário ainda mostrar também o anterior, apague o anterior.",
  moveAgainLink: (link, count) => `Para a mudar novamente: ${link} (pode mudar uma marcação ${count} vezes no total).`,
  cannotMoveAgain: (store) =>
    `Esta marcação já não pode ser mudada a partir da ligação. Para a alterar, responda a este email; a resposta chega a ${store}.`,

  newLinkSubject: (title, store) => `Nova ligação para entrar: ${title} com ${store}`,
  newLinkHead: (title, store) => `A ligação para entrar em ${title} com ${store} mudou. O horário não.`,
  joinOn: (meet, link) => `Entre aqui a essa hora, no ${meet}: ${link}`,
  oldLink: (previous) => `A ligação que recebeu antes (${previous}) já não é a que deve usar.`,
  replacesFile: "O ficheiro de calendário em anexo substitui o que foi enviado antes.",

  reminderSubject: (isDay, title, store) => `${isDay ? "Amanhã" : "Daqui a 1 hora"}: ${title} com ${store}`,
  reminderHead: (isDay, title, store) => `Um lembrete: ${title} com ${store} começa ${isDay ? "daqui a um dia" : "daqui a uma hora"}.`,
  whenLength: (when, minutes) => `${when}, ${minutes} minutos`,
  willSendOrReply: (store) => `${store} vai enviar-lhe a ligação para entrar. Se ainda não a recebeu, responda a este email.`,
  addToCalendar: (link) => `Adicione-a ao seu calendário: ${link}`,
  moveToAnother: (link) => `Para a mudar para outro horário: ${link}`,

  icsSummary: (title, store) => `${title} com ${store}`,
  icsAlarm: (title) => `${title} daqui a 15 minutos`,
  icsJoin: (room) => `Entrar: ${room}`,
  icsWillSend: (store) => `${store} vai enviar a ligação para entrar.`,
  whereAt: (address) => `Onde: ${address}`,
  depositRest: (amount, store) => `Um sinal para reservar a sua hora. O resto, ${amount}, é pago presencialmente a ${store}.`,
  codeLabel: "Código de desconto (opcional)",
  codeHelp: "É descontado do preço total. O que resta depois do sinal é pago presencialmente.",
  codeOffPrice: (code, amount) => `Código ${code}: menos ${amount} no preço total.`,
  hostPick: "Com quem quer marcar?",
  hostAny: "Qualquer pessoa disponível",
  hostShow: "Ver os horários",
  lengthPick: "Que duração prefere?",
  lengthChosen: (what: string) => `Horários para ${what}.`,
  lengthOption: (minutes: number, price: string) => `${minutes} minutos, ${price}`,
  withHost: (name) => `Com ${name}`,
  cancelPolicy: (hours, store) =>
    `Cancele com pelo menos ${hours} horas de antecedência, respondendo ao seu e-mail de confirmação, e ${store} reembolsa o que pagou online. Se cancelar mais tarde ou faltar, ${store} não tem de o reembolsar. Se ${store} cancelar, recebe tudo de volta. Isto não afeta os seus direitos previstos na lei.`,
  cancelTooLate: (hours, store) =>
    `Esta hora começa daqui a menos de ${hours} horas: se cancelar ou faltar, ${store} não tem de reembolsar o que pagou online. Se ${store} cancelar, recebe tudo de volta. Isto não afeta os seus direitos previstos na lei.`,

  packageName: (title, sessions) => `${title} — ${sessions} ${plural(sessions, "sessão", "sessões")}`,
  packageDescription: (sessions, limit) =>
    `${sessions} ${plural(sessions, "sessão", "sessões")}, cada uma marcada quando quiser. ${limit}.`,
  packageCoupon: "Sessão de um pacote",
  packageSubject: (total, title) => `${plural(total, "A sua", "As suas")} ${total} ${plural(total, "sessão", "sessões")}: ${title}`,
  packageThanks: (store) => `Obrigado por comprar a ${store}. Esta é a sua confirmação.`,
  packageWhat: (title, total) => `O que comprou: ${title}, ${total} ${plural(total, "sessão", "sessões")}`,
  packagePaid: (amount) => `Pago: ${amount}`,
  packageReference: (reference) => `Referência da encomenda: ${reference}`,
  packageBookByDate: (date) => `Marque-as até: ${date}`,
  packageNoLimit: "Sem prazo para as marcar.",
  packageBookHere: "Marque cada sessão, quando quiser, aqui:",
  packageKeep:
    "Guarde este email: é com essa ligação que marca as restantes. Cada uma recebe a sua própria confirmação, os seus lembretes e a sua ligação para a reunião, e pode ser mudada como qualquer marcação.",
  packageKeepPlace:
    "Guarde este email: é com essa ligação que marca as restantes. Cada uma recebe a sua própria confirmação e os seus lembretes, com a morada, e pode ser mudada como qualquer marcação.",
  packageCharged: (store) =>
    `Cobrado por ${store} na sua própria conta Stripe. Para qualquer pergunta, escreva a ${store} respondendo a este email.`,
};

export const BOOKING_WORDS: Record<LanguageCode, BookingWords> = { en, es, fr, de, it, nl, pt };

/** A store's booking words, in its language; English for anything not a language. */
export function bookingWords(language: unknown): BookingWords {
  return BOOKING_WORDS[parseLanguage(language)];
}
