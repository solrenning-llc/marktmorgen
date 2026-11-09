/**
 * Every word a member meets that the creator did not write, in the store's
 * language (lib/store-language.ts): the page where they manage, switch or
 * cancel a membership, the page that says a membership has ended, the page
 * after leaving a checkout unpaid, and the emails about all of these — the
 * link to manage a membership, the receipt of a switch, and the note that a
 * renewal did not go through.
 *
 * Prices and dates arrive already written in the store's language
 * (lib/buyer-words/index.ts, speech); a sentence here only places them.
 */
import { type LanguageCode, parseLanguage } from "@/lib/store-language";
import type { AskWhen } from "@/lib/ask-when";

type Interval = "day" | "week" | "month" | "year";
type Notice = { title: string; body: string };

/** A space that never breaks, before French ":", "?", "!", ";" and every "%". */
const S = " ";

const en = {
  // ---- Page titles (the browser tab, before "— Marktmorgen") ------------------
  yourMembership: "Your membership",
  switchTitle: "Switch your membership",
  endedTitle: "Your membership has ended",
  nothingCharged: "Nothing was charged",

  // ---- Managing a membership: asking for the link --------------------------------
  manageNotices: {
    email: {
      title: "That does not look like an email address",
      body: "Check it and try again. Use the address you pay with: the one you typed when you joined.",
    },
    limited: {
      title: "Too many requests for now",
      body: "To keep this form from being used to flood somebody's inbox, it takes a limited number of requests an hour. Try again in an hour.",
    },
    unavailable: {
      title: "This store cannot open memberships right now",
      body: "Its payments are not connected to Stripe right now, so there is no membership to open from this page. Reply to your order confirmation email and it reaches the store.",
    },
    error: {
      title: "Something went wrong on our side",
      body: "Nothing was changed. Try again in a moment.",
    },
    unconfirmed: {
      title: "We could not confirm the switch",
      body: "Stripe's answer did not say whether it went through. Look at your membership below before you try again: it shows the plan you are on now.",
    },
    expired: {
      title: "This link has expired",
      body: "A link to your membership works for one hour. Ask for a new one below; it takes a few seconds.",
    },
    used: {
      title: "This link has been used too many times",
      body: "Ask for a new one below; it takes a few seconds.",
    },
    switched: {
      title: "Your membership was switched",
      body: "What the new plan includes is open to you now, and a receipt is on its way to your inbox.",
    },
    yearly: {
      title: "You now pay yearly",
      body: "What your membership includes stays the same, and a receipt is on its way to your inbox.",
    },
    declined: {
      title: "The card was not charged, so nothing changed",
      body: "Your bank declined the payment or asked for a step we could not show here. Update your card with “Change card or see receipts” below, then try the switch again.",
    },
    stale: {
      title: "That price was more than 15 minutes old",
      body: "Nothing was changed. Pick the plan again to see the price as it stands now.",
    },
    busy: {
      title: "A switch was already under way",
      body: "Wait a moment and look at your membership below before trying again.",
    },
    currency: { title: "This membership stays on its plan", body: "It is paid in a different currency from the one the store's plans use now, so it stays on its current plan. Nothing was changed, and you can still cancel it on your membership page." },
    "cannot-switch": {
      title: "That switch cannot be made",
      body: "The plan may no longer be offered, or the membership may be canceled or waiting on a payment. Nothing was changed.",
    },
  } as Record<string, Notice>,
  manageHead: "Manage or cancel your membership",
  manageIntro: (store: string) =>
    `Type the email you pay ${store} with, and we will email you a link to your membership. No account and no password: you cancel it yourself, on Stripe's own page.`,
  manageUnavailable: (store: string) =>
    `${store} cannot take payments through Stripe right now, so there is no membership to open from here. Reply to your order confirmation email and it reaches them.`,
  payEmailLabel: "The email you pay with",
  emailMeLink: "Email me a link to my membership",
  linkNote: (store: string, hours: number) =>
    `If that address has a membership with ${store}, we try to email a link to it. It works for ${hours === 1 ? "one hour" : `${hours} hours`}. We say the same thing whether or not it does, so nobody can use this page to find out who is a member.`,
  checkInbox: "Check your inbox",
  sentBody: (store: string) =>
    `If that address has a membership with ${store}, the link is on its way. It comes from ${store} via Marktmorgen. If it is not there, look in spam.`,
  tryOther: "Nothing arrived? You may pay with a different address: the one you typed when you joined. Try that one below.",

  // ---- Managing: the memberships behind the link -----------------------------------
  yourMemberships: "Your memberships",
  /** "a month", "every 3 months": how often a membership is paid for. */
  every: (interval: Interval, count: number) => (count === 1 ? `a ${interval}` : `every ${count} ${interval}s`),
  ends: (date: string) => `Ends ${date}`,
  cancel: "Cancel",
  switchPlan: "Switch plan",
  switchCurrencyNote: "Switching plans is not offered on this membership: it is paid in a different currency from the one the store's plans use now.",
  upgrade: " · upgrade",
  downgrade: " · downgrade",
  exactFirst: "You see the exact amount before anything is charged.",
  cannotList:
    "Stripe could not list your memberships just now. The button below opens them all on Stripe's own page, where you can cancel.",
  changeCard: "Change card or see receipts",
  openMembership: "Open my membership",
  pause: {
    button: "Pause instead",
    choose: "Pause for",
    months: (n: number) => (n === 1 ? "1 month" : `${n} months`),
    confirm: "Pause my membership",
    note: (date: string) =>
      `What you have paid for stays open until ${date}. Then nothing is charged and the membership is closed while it is paused; it starts again by itself, with a payment, on the day the pause ends.`,
    pausedUntil: (date: string) => `Paused until ${date}`,
    startsPause: (date: string, until: string) => `Pauses on ${date}, back on ${until}`,
    resume: "Resume now",
    resumeNote: "Resuming takes a payment today, and the membership is open again at once.",
    emailSubject: (title: string) => `Your ${title} membership is paused`,
    emailBody: (title: string, store: string, from: string, until: string) =>
      `${title}: what you have paid for stays open until ${from}. From then until ${until}, nothing is charged and the membership is paused. On ${until} it starts again by itself, with the usual payment.\n\nTo come back sooner, or to cancel, open your membership from ${store}'s page.`,
  },
  pauseNotices: {
    paused: { title: "Your membership is paused", body: "An email with the dates is on its way to your inbox." },
    resumed: { title: "Your membership is on again", body: "The payment went through, and everything it includes is open to you again." },
    cannot: {
      title: "That membership cannot be paused right now",
      body: "Nothing was changed. A membership can be paused once a year, when it is paid monthly and running normally.",
    },
    declined: {
      title: "The card was not charged, so the membership is still paused",
      body: "Update your card with the button below, then press Resume now again.",
    },
  } as Record<string, Notice>,
  cancelNote:
    "If you cancel, the membership stays on until the end of the period you have already paid for, and nothing more is charged.",

  // ---- Asking why before a member cancels (added 12 October 2026) --------------------------
  leaveTitle: "Before you go",
  leaveHead: (title: string) => `Cancel ${title}?`,
  leaveHeadPlain: "Cancel your membership?",
  leaveIntro: (store: string) =>
    `If you tell ${store} why, there may be a better way for you below. Answering is up to you: you can cancel right away.`,
  leaveAsk: "Why are you leaving?",
  leaveReasons: {
    too_expensive: "It costs too much",
    unused: "I don't use it enough",
    missing_features: "Something I need is missing",
    switched_service: "I moved to something else",
    too_complex: "It's too hard to use",
    low_quality: "The quality isn't good enough",
    customer_service: "I wasn't helped when I asked",
    other: "Another reason",
  } as Record<string, string>,
  leaveContinue: "Continue",
  leaveThanks: "Thank you for saying why.",
  leaveCheaper: "A plan that costs less:",
  leavePause: "Or keep your place and pause instead:",
  leavePauseOnly: "Keep your place and pause instead:",
  leaveContact: (store: string) => `${store} would like to know. Write to them, and they can put it right:`,
  leaveWrite: (store: string) => `Write to ${store}`,
  leaveStill: "Still want to leave?",
  leaveCancel: "Cancel my membership",
  leaveConfirm: "Stripe's page opens, where you confirm it.",
  leaveGone: "This membership cannot be canceled from here: it has ended, or it is already set to end.",

  // ---- The come-back email to a member who stopped coming (added 12 October 2026) ---------
  nudgeSubject: (title: string) => `${title} is still here for you`,
  nudgeLead: (title: string) =>
    `It has been a while since you last came back to ${title}. Everything that comes with it is still there for you, and you can pick up where you left off.`,
  nudgeCourse: "Open the course:",
  nudgeCommunity: "Come into the community:",
  nudgeReply: (store: string) => `If something is in the way, reply to this email and it reaches ${store}.`,

  // ---- Paying yearly instead of monthly (added 12 October 2026) ------------------------------
  payYearly: (yearly: string, saving: string) => `Pay yearly: ${yearly}, saves ${saving}`,
  yearlyHead: (title: string) => `Pay yearly for ${title}`,
  yearlySaves: (amount: string) => `Saves ${amount} a year against twelve monthly payments.`,
  yearlyDueNote: "The year's price, less what is left of the month you already paid, to the card you pay with. Your next payment is in a year.",
  yearlyTrialNote: "You are in your free trial. Nothing is charged now; the yearly price is charged when the trial ends.",
  yearlyHolds: (store: string) => `This price holds for 15 minutes. Charged by ${store} on their own Stripe account. What your membership includes stays the same.`,
  yearlySubject: (title: string) => `You now pay yearly for ${title}`,
  yearlyNow: (store: string, title: string) => `Your ${title} membership with ${store} is now paid yearly. What it includes stays the same.`,
  yearlyPaidCharged: (amount: string) => `Charged today: ${amount}, the year less what was left of your last monthly payment.`,
  yearlyPaidTrial: "You are in your free trial, so nothing was charged. The yearly price is charged when the trial ends.",
  askSubject: (title: string, saving: string) => `${title}: pay yearly and save ${saving}`,
  askLead: (store: string, title: string, monthly: string, yearly: string, saving: string) =>
    `You pay ${monthly} for ${title}. ${store} also offers it yearly: ${yearly}. That is ${saving} less than twelve monthly payments, and what it includes stays the same.`,
  askSee: "See exactly what you would pay today, before anything is charged:",
  askWorks: "The link works for 14 days and opens only this change. Nothing changes unless you press the button on that page.",
  askReply: (store: string) => `Questions? Reply to this email and it reaches ${store}.`,

  // ---- Switching to another plan ------------------------------------------------------
  switchProblems: {
    expired: { title: "This link has expired", body: "A link to your membership works for one hour. Ask for a new one on your membership page." },
    gone: { title: "This membership cannot switch", body: "It may be canceled, set to end, waiting on a payment, or no longer yours on this link. Nothing was changed." },
    tier: { title: "That plan is not offered anymore", body: "Go back to your membership page to see the plans you can switch to now. Nothing was changed." },
    currency: { title: "This membership stays on its plan", body: "It is paid in a different currency from the one the store's plans use now, so it stays on its current plan. Nothing was changed, and you can still cancel it on your membership page." },
    error: { title: "Stripe could not work out the price just now", body: "Nothing was changed. Try again in a moment." },
    yearly: { title: "Paying yearly is not offered on this membership", body: "It may already be paid yearly, carry a discount, be canceled or waiting on a payment, or the yearly price may have changed. Nothing was changed." },
    yearlyExpired: { title: "This link has expired", body: "The link in the email works for 14 days. Ask for a link to your membership on its page; from there you can pay yearly." },
  } as Record<string, Notice>,
  switchTo: (title: string) => `Switch to ${title}`,
  nowLabel: "Now",
  afterLabel: "After the switch",
  nothingNow: "Nothing is charged now",
  chargedToday: (amount: string) => `${amount} charged today`,
  offNext: (amount: string) => `${amount} comes off your next payments`,
  nothingToday: "Nothing is charged today",
  switchTrialNote: "You are in your free trial. The new plan opens now, and its price starts when the trial ends.",
  dueNote: "The new price, less what was left of your last payment, to the card you pay with. The new plan opens as soon as it is paid.",
  creditNote: "What was left of your last payment becomes a credit with the store, taken off your next payments. The new plan opens now.",
  opensNow: "The new plan opens now.",
  switchAndPay: (amount: string) => `Switch and pay ${amount}`,
  switchNow: "Switch now",
  holdsNote: (store: string, title: string) =>
    `This price holds for 15 minutes. Charged by ${store} on their own Stripe account. Anything only ${title} includes closes when you switch.`,
  backToMembership: "Back to your membership",

  // ---- A membership that has ended ----------------------------------------------------------
  offerNotices: {
    /** A membership of this product that has not ended was found: the come-back checkout is not opened (lib/winback-send.ts). */
    member: "You already have a membership to this that is still running, so the offer was not used. Nothing was charged.",
    price: "The store no longer offers the price this offer was for, so it cannot be used. Nothing was charged.",
    expired: "This offer has ended. You can still come back at the usual price below.",
    unavailable: "This offer cannot be used for this membership any more. You can still come back at the usual price below, if it is offered.",
    refused: "The offer could not be applied just now. You can come back at the usual price below, or reply to the email it came in.",
    limited: "Too many tries for now. Wait a few minutes and press the button again.",
  } as Record<string, string>,
  membershipLabel: "Membership",
  endedBody: (title: string) =>
    `Your membership for ${title} is no longer running, so what it gave you access to is closed now. Renew it and everything opens again right away.`,
  /** The same without the promise that renewing opens it again: said when the price the offer named is gone. */
  endedClosed: (title: string) =>
    `Your membership for ${title} is no longer running, so what it gave you access to is closed now.`,
  endedGone: (store: string) => `This membership is no longer running, and ${store} no longer lists it.`,
  comeBackOffer: "Your come-back offer",
  /** "25% off your first payment", "25% off your first 3 payments". */
  offerWords: (percent: number, months: number) =>
    months === 1 ? `${percent}% off your first payment` : `${percent}% off your first ${months} payments`,
  offerFor: (email: string, until: string) =>
    `For ${email}, until ${until}. Applied on Stripe's page before you pay; no free trial this time.`,
  comeBackWith: "Come back with this offer",
  renewTitle: (title: string) => `Renew ${title}`,
  renewPrice: (price: string) => `Renew · ${price}`,
  renew: "Renew",
  notTaking: (store: string) =>
    `${store} is not taking new members for this right now. Reply to your order confirmation email and it reaches them.`,
  see: (title: string) => `See ${title}`,
  seePrices: (title: string) => `See today's prices for ${title}`,
  /** A sentence with a link in it: before, the link, after. */
  failedBefore: "Did it end because a payment failed, not because you canceled? Updating the card may bring it back without renewing: ",
  failedLink: "manage your membership",
  failedAfter: " with the email you paid with.",
  boughtBefore: "Anything you bought outright stays yours: ",
  boughtLink: "get what you bought again",
  boughtAfter: ".",

  // ---- After leaving a checkout unpaid ----------------------------------------------------------
  leftNotices: {
    email: {
      title: "That does not look like an email address",
      body: "Check it and try again. The reminder goes to the address you type, so it has to be one you can open.",
    },
    limited: {
      title: "Too many reminders asked for just now",
      body: "To keep this form from being used to fill somebody's inbox, it takes a limited number an hour. Nothing was kept. The product is still here whenever you want it.",
    },
    closed: {
      title: "No reminder can be sent for this",
      body: "It may have sold out or been taken off sale. Nothing was kept.",
    },
    error: {
      title: "We could not keep that just now",
      body: "Nothing was kept. Try again in a moment.",
    },
  } as Record<string, Notice>,
  done: "Done",
  oneReminder: "One reminder, in about an hour",
  willEmail: (store: string, title: string) =>
    `${store} will email you once, with the link to ${title}. If you buy it before then, no reminder is sent.`,
  onlyEmail:
    "That is the only email this sends. It does not add you to any list, and it has a link that stops reminders from this store for good.",
  leftBefore: (title: string) => `You left before paying for ${title}`,
  notCharged: "Your card was not charged. If you still want it, it is one press away.",
  notReady: "Not ready yet?",
  remindNote: (store: string) =>
    `Leave your email and ${store} sends you one reminder with the link, in about an hour. One email. It does not add you to any list.`,
  remindMe: "Remind me once",
  addressUse: (store: string) =>
    `Your address is used for this one reminder and for the link in it that stops reminders from ${store}, and for nothing else.`,
  // ---- A reminder asked for on a product's page (lib/ask-when.ts) -------------------------------
  askWhen: "When",
  askTimes: { hour: "In about an hour", day: "Tomorrow", days: "In three days" } as Record<AskWhen, string>,
  pageRemindNote: (store: string) =>
    `Leave your email and ${store} sends you one reminder with the link, when you choose. One email. It does not add you to any list.`,
  /** When the reminder goes, as said in the middle of a sentence (pageAsked). */
  askSaid: { hour: "in about an hour", day: "tomorrow", days: "in three days" } as Record<AskWhen, string>,
  pageAsked: (store: string, title: string, when: string) => `${store} will email you once, with the link to ${title}, ${when}. If you buy it before then, no reminder is sent.`,

  // ---- The email with the link to a membership ---------------------------------------------------
  /** The name an email is sent under. */
  fromName: (store: string) => `${store} via Marktmorgen`,
  /** The email's subject, and the heading of Stripe's page for the membership. */
  membershipWith: (store: string) => `Your membership with ${store}`,
  linkIntro: (store: string) => `You asked to manage your membership with ${store}. Here is the way in:`,
  linkTiers:
    "Open the link to see your membership. From there you can switch to another plan, seeing the exact amount before anything is charged, or cancel it, change the card it is paid with, or see your receipts. If you cancel, it stays on until the end of the period you have already paid for, and nothing more is charged.",
  linkNoTiers:
    "Open the link and press the button. Stripe then shows your membership: you can cancel it, change the card it is paid with, or see your receipts. If you cancel, it stays on until the end of the period you have already paid for, and nothing more is charged.",
  linkWorks: "The link works for one hour. If you did not ask for this, ignore this email; nothing happens unless the link is used.",
  linkFooter: (store: string) =>
    `Sent by Marktmorgen on behalf of ${store}. The membership is charged by ${store} on their own Stripe account.`,

  // ---- The receipt of a switch -----------------------------------------------------------------------
  switchedSubject: (title: string) => `You switched to ${title}`,
  switchedNow: (store: string, title: string, from: string) =>
    `Your membership with ${store} is now ${title}, in place of ${from}.`,
  paidTrial: "You are in your free trial, so nothing was charged. The new price starts when the trial ends.",
  paidCharged: (amount: string) => `Charged today: ${amount}, the new price less what was left of your last payment.`,
  paidCredit: (amount: string) => `A credit of ${amount}, for what was left of your last payment, comes off your next payments.`,
  paidNothing: "Nothing was charged today.",
  fromNow: (price: string) => `From now on: ${price}.`,
  switchedOpen:
    "What it includes is open to you now. Your receipts are on your membership page, from the link on the store's page.",
  switchedFooter: (store: string) =>
    `Charged by ${store} on their own Stripe account. Questions go to ${store} by replying to this email.`,

  // ---- A renewal that did not go through --------------------------------------------------------------
  failedSubject: (store: string) => `Your payment to ${store} didn't go through`,
  hi: "Hi,",
  failedFor: (amount: string, title: string) =>
    `The latest payment of ${amount} for ${title} didn't go through. This happens when a card expires, is replaced, or is declined by the bank.`,
  failedTo: (amount: string, store: string) =>
    `The latest payment of ${amount} to ${store} didn't go through. This happens when a card expires, is replaced, or is declined by the bank.`,
  payHere: "Pay it here, with the same card or a new one:",
  cardKept: "The card you pay with is used for your next payments too, so this only has to be done once.",
  /** `date` is a day and month: "October 3". */
  triedAgainPlan: (date: string) => `If you do nothing, the card on file is tried again on ${date}.`,
  triedAgain: (date: string) =>
    `If you do nothing, the card on file is tried again on ${date}, and your access stays on in the meantime.`,
  notTriedAgain: "The card on file won't be tried again, so this payment stays unpaid until it is paid from the link above.",
  receiptsPlan: (url: string) => `To see your receipts, or change the card: ${url}`,
  cancelInstead: (url: string) => `To cancel instead, or see your receipts: ${url}`,
  // ---- Reminders, and a card about to stop working (added 12 October 2026) ----
  reminderSubject: (store: string) => `Reminder: your payment to ${store} still hasn't gone through`,
  reminderLead: "A short reminder, in case the first email was missed.",
  /** "Visa ending in 4242". */
  cardName: (brand: string, last4: string) => `${brand} ending in ${last4}`,
  cardSubject: (store: string) => `Your card for ${store} expires before your next payment`,
  cardFor: (card: string, title: string, date: string) =>
    `The card you pay for ${title} with, ${card}, expires before your next payment, on ${date}.`,
  cardTo: (card: string, store: string, date: string) =>
    `The card you pay ${store} with, ${card}, expires before your next payment, on ${date}.`,
  cardHere: "Add your new card here, so that payment goes through:",
  cardHow: "It takes a minute on Stripe's secure page. Nothing is charged now, and the new card is used for these payments from then on.",
  cardBank: "If your bank has already sent you a new card, Stripe may pick it up on its own; adding it here makes sure.",
  cardTitle: "Update your card",
  cardHead: (title: string) => `Update the card for ${title}`,
  cardHeadStore: (store: string) => `Update the card you pay ${store} with`,
  cardIntro: "Nothing is charged now. The card you add is used for these payments from then on.",
  cardPayNow: "Your latest payment didn't go through, so it is charged to the new card straight away.",
  cardButton: "Add a new card",
  cardNote: "On Stripe's own secure page. The store never sees your card number.",
  cardEnded: "This membership has ended, so there is no card to update.",
  cardNotices: {
    updated: { title: "Your card is updated", body: "Your next payments use the new card." },
    paid: { title: "Your card is updated and your payment went through", body: "Your next payments use the new card too." },
    declined: {
      title: "Your new card is saved, but the payment was declined",
      body: "Your next payments use the new card. Stripe tries the one that failed again, or you can pay it from the link in the email about it.",
    },
    canceled: { title: "Nothing was changed", body: "You left Stripe's page before saving a card. Press the button to try again." },
    expired: { title: "This link has expired", body: "Ask for a link to your membership on its page; from there you can change your card." },
    error: { title: "Something went wrong on our side", body: "Nothing was changed. Try again in a moment." },
  } as Record<string, Notice>,
};

export type MembershipWords = typeof en;

const es: MembershipWords = {
  yourMembership: "Tu membresía",
  switchTitle: "Cambia tu membresía",
  endedTitle: "Tu membresía ha terminado",
  nothingCharged: "No se cobró nada",

  manageNotices: {
    email: {
      title: "Eso no parece una dirección de email",
      body: "Revísala y vuelve a intentarlo. Usa la dirección con la que pagas: la que escribiste al hacerte miembro.",
    },
    limited: {
      title: "Demasiadas solicitudes por ahora",
      body: "Para que nadie use este formulario para llenar de mensajes la bandeja de entrada de otra persona, acepta un número limitado de solicitudes por hora. Vuelve a intentarlo dentro de una hora.",
    },
    unavailable: {
      title: "Esta tienda no puede abrir membresías en este momento",
      body: "Sus pagos no están conectados a Stripe en este momento, así que no hay ninguna membresía que abrir desde esta página. Responde al email de confirmación de tu pedido y le llegará a la tienda.",
    },
    error: {
      title: "Algo salió mal por nuestra parte",
      body: "No se cambió nada. Vuelve a intentarlo en un momento.",
    },
    unconfirmed: {
      title: "No pudimos confirmar el cambio",
      body: "La respuesta de Stripe no dijo si se hizo. Mira tu membresía abajo antes de intentarlo de nuevo: muestra el plan que tienes ahora.",
    },
    expired: {
      title: "Este enlace ha expirado",
      body: "Un enlace a tu membresía funciona durante una hora. Pide uno nuevo abajo; tarda unos segundos.",
    },
    used: {
      title: "Este enlace se ha usado demasiadas veces",
      body: "Pide uno nuevo abajo; tarda unos segundos.",
    },
    switched: {
      title: "Tu membresía se cambió",
      body: "Ya tienes acceso a lo que incluye el nuevo plan, y un recibo va de camino a tu bandeja de entrada.",
    },
    yearly: {
      title: "Ahora pagas al año",
      body: "Lo que incluye tu membresía sigue igual, y un recibo va de camino a tu bandeja de entrada.",
    },
    declined: {
      title: "No se cobró la tarjeta, así que no cambió nada",
      body: "Tu banco rechazó el pago o pidió un paso que no podíamos mostrar aquí. Actualiza tu tarjeta con “Cambiar tarjeta o ver recibos”, abajo, y vuelve a intentar el cambio.",
    },
    stale: {
      title: "Ese precio tenía más de 15 minutos",
      body: "No se cambió nada. Vuelve a elegir el plan para ver el precio tal como está ahora.",
    },
    busy: {
      title: "Ya había un cambio en curso",
      body: "Espera un momento y revisa tu membresía abajo antes de volver a intentarlo.",
    },
    currency: { title: "Esta membresía se queda en su plan", body: "Se paga en una moneda distinta de la que usan ahora los planes de la tienda, así que se queda en su plan actual. No se cambió nada, y aún puedes cancelarla en la página de tu membresía." },
    "cannot-switch": {
      title: "Ese cambio no se puede hacer",
      body: "Puede que el plan ya no se ofrezca, o que la membresía esté cancelada o pendiente de un pago. No se cambió nada.",
    },
  },
  manageHead: "Gestiona o cancela tu membresía",
  manageIntro: (store) =>
    `Escribe el email con el que pagas a ${store} y te enviaremos por email un enlace a tu membresía. Sin cuenta y sin contraseña: la cancelas por tu cuenta, en la propia página de Stripe.`,
  manageUnavailable: (store) =>
    `${store} no puede aceptar pagos a través de Stripe en este momento, así que no hay ninguna membresía que abrir desde aquí. Responde al email de confirmación de tu pedido y le llegará.`,
  payEmailLabel: "El email con el que pagas",
  emailMeLink: "Envíame un enlace a mi membresía",
  linkNote: (store, hours) =>
    `Si esa dirección tiene una membresía en ${store}, intentamos enviarle un enlace por email. Funciona durante ${hours === 1 ? "una hora" : `${hours} horas`}. Decimos lo mismo tanto si la tiene como si no, para que nadie pueda usar esta página para averiguar quién es miembro.`,
  checkInbox: "Revisa tu bandeja de entrada",
  sentBody: (store) =>
    `Si esa dirección tiene una membresía en ${store}, el enlace va de camino. Lo envía ${store} a través de Marktmorgen. Si no está, mira en la carpeta de spam.`,
  tryOther: "¿No llegó nada? Puede que pagues con otra dirección: la que escribiste al hacerte miembro. Prueba con esa abajo.",

  yourMemberships: "Tus membresías",
  every: (interval, count) =>
    count === 1
      ? { day: "al día", week: "a la semana", month: "al mes", year: "al año" }[interval]
      : `cada ${count} ${{ day: "días", week: "semanas", month: "meses", year: "años" }[interval]}`,
  ends: (date) => `Termina el ${date}`,
  cancel: "Cancelar",
  switchPlan: "Cambiar de plan",
  switchCurrencyNote: "Esta membresía no ofrece cambiar de plan: se paga en una moneda distinta de la que usan ahora los planes de la tienda.",
  upgrade: " · plan superior",
  downgrade: " · plan inferior",
  exactFirst: "Ves el importe exacto antes de que se cobre nada.",
  cannotList:
    "Stripe no pudo mostrar tus membresías en este momento. El botón de abajo las abre todas en la propia página de Stripe, donde puedes cancelar.",
  changeCard: "Cambiar tarjeta o ver recibos",
  openMembership: "Abrir mi membresía",
  pause: {
    button: "Pausar en su lugar",
    choose: "Pausar durante",
    months: (n) => (n === 1 ? "1 mes" : `${n} meses`),
    confirm: "Pausar mi membresía",
    note: (date) =>
      `Lo que ya pagaste sigue abierto hasta el ${date}. Después no se cobra nada y la membresía queda cerrada mientras está en pausa; vuelve sola, con un pago, el día en que termina la pausa.`,
    pausedUntil: (date) => `En pausa hasta el ${date}`,
    startsPause: (date, until) => `Se pausa el ${date} y vuelve el ${until}`,
    resume: "Reanudar ahora",
    resumeNote: "Al reanudar se cobra un pago hoy, y la membresía vuelve a abrirse al instante.",
    emailSubject: (title) => `Tu membresía ${title} está en pausa`,
    emailBody: (title, store, from, until) =>
      `${title}: lo que ya pagaste sigue abierto hasta el ${from}. Desde ese día hasta el ${until} no se cobra nada y la membresía está en pausa. El ${until} vuelve sola, con el pago de siempre.\n\nPara volver antes, o para cancelar, abre tu membresía desde la página de ${store}.`,
  },
  pauseNotices: {
    paused: { title: "Tu membresía está en pausa", body: "Te llega un correo con las fechas." },
    resumed: { title: "Tu membresía está activa de nuevo", body: "El pago se hizo, y todo lo que incluye vuelve a estar abierto para ti." },
    cannot: {
      title: "Esa membresía no se puede pausar ahora",
      body: "No se cambió nada. Una membresía se puede pausar una vez al año, si se paga cada mes y funciona con normalidad.",
    },
    declined: {
      title: "No se cobró la tarjeta, así que la membresía sigue en pausa",
      body: "Actualiza tu tarjeta con el botón de abajo y vuelve a pulsar Reanudar ahora.",
    },
  } as Record<string, Notice>,
  cancelNote: "Si cancelas, la membresía sigue activa hasta el final del periodo que ya pagaste, y no se cobra nada más.",

  leaveTitle: "Antes de irte",
  leaveHead: (title) => `¿Cancelar ${title}?`,
  leaveHeadPlain: "¿Cancelar tu membresía?",
  leaveIntro: (store) =>
    `Si le cuentas a ${store} por qué, puede que haya una opción mejor para ti más abajo. Responder es opcional: puedes cancelar ahora mismo.`,
  leaveAsk: "¿Por qué te vas?",
  leaveReasons: {
    too_expensive: "Cuesta demasiado",
    unused: "No lo uso lo suficiente",
    missing_features: "Falta algo que necesito",
    switched_service: "Me cambié a otra cosa",
    too_complex: "Es demasiado difícil de usar",
    low_quality: "La calidad no es suficiente",
    customer_service: "No me ayudaron cuando lo pedí",
    other: "Otro motivo",
  },
  leaveContinue: "Continuar",
  leaveThanks: "Gracias por contarnos el motivo.",
  leaveCheaper: "Un plan que cuesta menos:",
  leavePause: "O conserva tu lugar y haz una pausa:",
  leavePauseOnly: "Conserva tu lugar y haz una pausa:",
  leaveContact: (store) => `A ${store} le gustaría saberlo. Escríbele, y podrá solucionarlo:`,
  leaveWrite: (store) => `Escribir a ${store}`,
  leaveStill: "¿Aún quieres irte?",
  leaveCancel: "Cancelar mi membresía",
  leaveConfirm: "Se abre la página de Stripe, donde lo confirmas.",
  leaveGone: "Esta membresía no se puede cancelar desde aquí: ya terminó o ya está programada para terminar.",

  nudgeSubject: (title) => `${title} sigue aquí para ti`,
  nudgeLead: (title) =>
    `Hace un tiempo que no vuelves a ${title}. Todo lo que incluye sigue ahí para ti, y puedes retomarlo donde lo dejaste.`,
  nudgeCourse: "Abre el curso:",
  nudgeCommunity: "Entra en la comunidad:",
  nudgeReply: (store) => `Si algo te lo impide, responde a este correo y le llegará a ${store}.`,

  // ---- Pagar al año en vez de al mes ----------------------------------------------------------
  payYearly: (yearly, saving) => `Paga al año: ${yearly}, ahorras ${saving}`,
  yearlyHead: (title) => `Paga al año ${title}`,
  yearlySaves: (amount) => `Ahorras ${amount} al año frente a doce pagos mensuales.`,
  yearlyDueNote: "Se cobra a la tarjeta con la que pagas el precio del año, menos lo que queda del mes que ya pagaste. Tu próximo pago será dentro de un año.",
  yearlyTrialNote: "Estás en tu prueba gratis. No se cobra nada ahora; el precio anual se cobra cuando termine la prueba.",
  yearlyHolds: (store) => `Este precio se mantiene 15 minutos. Lo cobra ${store} en su propia cuenta de Stripe. Lo que incluye tu membresía sigue igual.`,
  yearlySubject: (title) => `Ahora pagas al año ${title}`,
  yearlyNow: (store, title) => `Tu membresía ${title} con ${store} ahora se paga al año. Lo que incluye sigue igual.`,
  yearlyPaidCharged: (amount) => `Cobrado hoy: ${amount}, el año menos lo que quedaba de tu último pago mensual.`,
  yearlyPaidTrial: "Estás en tu prueba gratis, así que no se cobró nada. El precio anual se cobra cuando termine la prueba.",
  askSubject: (title, saving) => `${title}: paga al año y ahorra ${saving}`,
  askLead: (store, title, monthly, yearly, saving) =>
    `Pagas ${monthly} por ${title}. ${store} también lo ofrece al año: ${yearly}. Son ${saving} menos que doce pagos mensuales, y lo que incluye sigue igual.`,
  askSee: "Mira exactamente lo que pagarías hoy, antes de que se cobre nada:",
  askWorks: "El enlace funciona 14 días y solo abre este cambio. No cambia nada a menos que pulses el botón de esa página.",
  askReply: (store) => `¿Dudas? Responde a este correo y le llegará a ${store}.`,

  switchProblems: {
    expired: { title: "Este enlace ha expirado", body: "Un enlace a tu membresía funciona durante una hora. Pide uno nuevo en la página de tu membresía." },
    gone: {
      title: "Esta membresía no se puede cambiar",
      body: "Puede que esté cancelada, programada para terminar, pendiente de un pago o que ya no sea tuya con este enlace. No se cambió nada.",
    },
    tier: { title: "Ese plan ya no se ofrece", body: "Vuelve a la página de tu membresía para ver los planes a los que puedes cambiar ahora. No se cambió nada." },
    currency: { title: "Esta membresía se queda en su plan", body: "Se paga en una moneda distinta de la que usan ahora los planes de la tienda, así que se queda en su plan actual. No se cambió nada, y aún puedes cancelarla en la página de tu membresía." },
    error: { title: "Stripe no pudo calcular el precio en este momento", body: "No se cambió nada. Vuelve a intentarlo en un momento." },
    yearly: { title: "Esta membresía no ofrece el pago anual", body: "Puede que ya se pague al año, tenga un descuento, esté cancelada o pendiente de un pago, o que el precio anual haya cambiado. No se cambió nada." },
    yearlyExpired: { title: "Este enlace ha caducado", body: "El enlace del correo funciona 14 días. Pide un enlace a tu membresía en su página; desde allí puedes pagar al año." },
  },
  switchTo: (title) => `Cambiar a ${title}`,
  nowLabel: "Ahora",
  afterLabel: "Después del cambio",
  nothingNow: "No se cobra nada ahora",
  chargedToday: (amount) => `Hoy se cobra ${amount}`,
  offNext: (amount) => `Se descuenta ${amount} de tus próximos pagos`,
  nothingToday: "Hoy no se cobra nada",
  switchTrialNote: "Estás en tu prueba gratis. El nuevo plan se abre ahora, y su precio empieza cuando termine la prueba.",
  dueNote: "Se cobra a la tarjeta con la que pagas el nuevo precio, menos lo que quedaba de tu último pago. El nuevo plan se abre en cuanto se paga.",
  creditNote: "Lo que quedaba de tu último pago pasa a ser un crédito con la tienda, que se descuenta de tus próximos pagos. El nuevo plan se abre ahora.",
  opensNow: "El nuevo plan se abre ahora.",
  switchAndPay: (amount) => `Cambiar y pagar ${amount}`,
  switchNow: "Cambiar ahora",
  holdsNote: (store, title) =>
    `Este precio se mantiene durante 15 minutos. Lo cobra ${store} en su propia cuenta de Stripe. Todo lo que solo incluye ${title} se cierra al cambiar.`,
  backToMembership: "Volver a tu membresía",

  offerNotices: {
    member: "Ya tienes una membresía de esto que sigue activa, así que la oferta no se usó. No se cobró nada.",
    price: "La tienda ya no ofrece el precio para el que era esta oferta, así que no se puede usar. No se cobró nada.",
    expired: "Esta oferta ha terminado. Todavía puedes volver al precio habitual, abajo.",
    unavailable: "Esta oferta ya no se puede usar para esta membresía. Todavía puedes volver al precio habitual, abajo, si se ofrece.",
    refused: "No se pudo aplicar la oferta en este momento. Puedes volver al precio habitual, abajo, o responder al email en el que llegó.",
    limited: "Demasiados intentos por ahora. Espera unos minutos y vuelve a pulsar el botón.",
  },
  membershipLabel: "Membresía",
  endedBody: (title) =>
    `Tu membresía de ${title} ya no está activa, así que aquello a lo que te daba acceso está cerrado ahora. Renuévala y todo se vuelve a abrir al instante.`,
  endedClosed: (title) =>
    `Tu membresía de ${title} ya no está activa, así que aquello a lo que te daba acceso está cerrado ahora.`,
  endedGone: (store) => `Esta membresía ya no está activa, y ${store} ya no la ofrece.`,
  comeBackOffer: "Tu oferta para volver",
  offerWords: (percent, months) =>
    months === 1 ? `${percent}${S}% de descuento en tu primer pago` : `${percent}${S}% de descuento en tus primeros ${months} pagos`,
  offerFor: (email, until) =>
    `Para ${email}, hasta el ${until}. Se aplica en la página de Stripe antes de pagar; esta vez sin prueba gratis.`,
  comeBackWith: "Volver con esta oferta",
  renewTitle: (title) => `Renovar ${title}`,
  renewPrice: (price) => `Renovar · ${price}`,
  renew: "Renovar",
  notTaking: (store) =>
    `${store} no está aceptando nuevos miembros para esto en este momento. Responde al email de confirmación de tu pedido y le llegará.`,
  see: (title) => `Ver ${title}`,
  seePrices: (title) => `Ver los precios de hoy de ${title}`,
  failedBefore: "¿Terminó porque falló un pago, no porque cancelaras? Actualizar la tarjeta puede reactivarla sin renovar: ",
  failedLink: "gestiona tu membresía",
  failedAfter: " con el email con el que pagaste.",
  boughtBefore: "Lo que compraste aparte sigue siendo tuyo: ",
  boughtLink: "vuelve a obtener lo que compraste",
  boughtAfter: ".",

  leftNotices: {
    email: {
      title: "Eso no parece una dirección de email",
      body: "Revísala y vuelve a intentarlo. El recordatorio va a la dirección que escribas, así que tiene que ser una que puedas abrir.",
    },
    limited: {
      title: "Se han pedido demasiados recordatorios ahora mismo",
      body: "Para que nadie use este formulario para llenar de mensajes la bandeja de entrada de otra persona, acepta un número limitado por hora. No se guardó nada. El producto sigue aquí cuando lo quieras.",
    },
    closed: {
      title: "No se puede enviar un recordatorio para esto",
      body: "Puede que se haya agotado o que se haya retirado de la venta. No se guardó nada.",
    },
    error: {
      title: "No pudimos guardarlo en este momento",
      body: "No se guardó nada. Vuelve a intentarlo en un momento.",
    },
  },
  done: "Hecho",
  oneReminder: "Un recordatorio, dentro de una hora aproximadamente",
  willEmail: (store, title) =>
    `${store} te escribirá una sola vez, con el enlace a ${title}. Si lo compras antes, no se envía ningún recordatorio.`,
  onlyEmail:
    "Es el único email que se envía. No te añade a ninguna lista, y tiene un enlace que detiene para siempre los recordatorios de esta tienda.",
  leftBefore: (title) => `Te fuiste antes de pagar ${title}`,
  notCharged: "No se cobró nada en tu tarjeta. Si todavía lo quieres, está a un solo clic.",
  notReady: "¿Todavía no te decides?",
  remindNote: (store) =>
    `Deja tu email y ${store} te envía un recordatorio con el enlace, dentro de una hora aproximadamente. Un solo email. No te añade a ninguna lista.`,
  remindMe: "Recuérdamelo una vez",
  addressUse: (store) =>
    `Tu dirección se usa para este único recordatorio y para el enlace que contiene para detener los recordatorios de ${store}, y para nada más.`,
  // ---- A reminder asked for on a product's page (lib/ask-when.ts) -------------------------------
  askWhen: "Cuándo",
  askTimes: { hour: "Dentro de una hora", day: "Mañana", days: "Dentro de tres días" },
  pageRemindNote: (store) =>
    `Deja tu email y ${store} te envía un recordatorio con el enlace, cuando elijas. Un solo email. No te añade a ninguna lista.`,
  /** When the reminder goes, as said in the middle of a sentence (pageAsked). */
  askSaid: { hour: "dentro de una hora aproximadamente", day: "mañana", days: "dentro de tres días" },
  pageAsked: (store, title, when) => `${store} te enviará un único email con el enlace a ${title} ${when}. Si lo compras antes, no se envía ningún recordatorio.`,

  fromName: (store) => `${store} vía Marktmorgen`,
  membershipWith: (store) => `Tu membresía en ${store}`,
  linkIntro: (store) => `Pediste gestionar tu membresía en ${store}. Este es el acceso:`,
  linkTiers:
    "Abre el enlace para ver tu membresía. Desde ahí puedes cambiar a otro plan, viendo el importe exacto antes de que se cobre nada, o cancelarla, cambiar la tarjeta con la que se paga o ver tus recibos. Si cancelas, sigue activa hasta el final del periodo que ya pagaste, y no se cobra nada más.",
  linkNoTiers:
    "Abre el enlace y pulsa el botón. Stripe te muestra entonces tu membresía: puedes cancelarla, cambiar la tarjeta con la que se paga o ver tus recibos. Si cancelas, sigue activa hasta el final del periodo que ya pagaste, y no se cobra nada más.",
  linkWorks: "El enlace funciona durante una hora. Si no lo pediste, ignora este email; no pasa nada a menos que se use el enlace.",
  linkFooter: (store) =>
    `Enviado por Marktmorgen en nombre de ${store}. La membresía la cobra ${store} en su propia cuenta de Stripe.`,

  switchedSubject: (title) => `Cambiaste a ${title}`,
  switchedNow: (store, title, from) => `Tu membresía en ${store} ahora es ${title}, en lugar de ${from}.`,
  paidTrial: "Estás en tu prueba gratis, así que no se cobró nada. El nuevo precio empieza cuando termine la prueba.",
  paidCharged: (amount) => `Cobrado hoy: ${amount}, el nuevo precio menos lo que quedaba de tu último pago.`,
  paidCredit: (amount) => `Un crédito de ${amount}, por lo que quedaba de tu último pago, se descuenta de tus próximos pagos.`,
  paidNothing: "Hoy no se cobró nada.",
  fromNow: (price) => `A partir de ahora: ${price}.`,
  switchedOpen:
    "Ya tienes acceso a lo que incluye. Tus recibos están en la página de tu membresía, desde el enlace de la página de la tienda.",
  switchedFooter: (store) =>
    `Lo cobra ${store} en su propia cuenta de Stripe. Si tienes preguntas, responde a este email y le llegarán a ${store}.`,

  failedSubject: (store) => `Tu pago a ${store} no se completó`,
  hi: "Hola,",
  failedFor: (amount, title) =>
    `El último pago de ${amount} por ${title} no se completó. Esto pasa cuando una tarjeta expira, se sustituye o el banco la rechaza.`,
  failedTo: (amount, store) =>
    `El último pago de ${amount} a ${store} no se completó. Esto pasa cuando una tarjeta expira, se sustituye o el banco la rechaza.`,
  payHere: "Págalo aquí, con la misma tarjeta o con una nueva:",
  cardKept: "La tarjeta con la que pagues se usa también para tus próximos pagos, así que solo tienes que hacerlo una vez.",
  triedAgainPlan: (date) => `Si no haces nada, se vuelve a intentar el cobro en la tarjeta registrada el ${date}.`,
  triedAgain: (date) =>
    `Si no haces nada, se vuelve a intentar el cobro en la tarjeta registrada el ${date}, y mientras tanto sigues teniendo acceso.`,
  notTriedAgain:
    "No se volverá a intentar el cobro en la tarjeta registrada, así que este pago seguirá pendiente hasta que se pague desde el enlace de arriba.",
  receiptsPlan: (url) => `Para ver tus recibos o cambiar la tarjeta: ${url}`,
  cancelInstead: (url) => `Si prefieres cancelar, o ver tus recibos: ${url}`,
  reminderSubject: (store) => `Recordatorio: tu pago a ${store} aún no se ha completado`,
  reminderLead: "Un breve recordatorio, por si no viste el primer correo.",
  cardName: (brand, last4) => `${brand} terminada en ${last4}`,
  cardSubject: (store) => `Tu tarjeta para ${store} caduca antes de tu próximo pago`,
  cardFor: (card, title, date) =>
    `La tarjeta con la que pagas ${title}, ${card}, caduca antes de tu próximo pago, el ${date}.`,
  cardTo: (card, store, date) =>
    `La tarjeta con la que pagas a ${store}, ${card}, caduca antes de tu próximo pago, el ${date}.`,
  cardHere: "Añade tu nueva tarjeta aquí, para que ese pago se complete:",
  cardHow: "Lleva un minuto en la página segura de Stripe. No se cobra nada ahora, y la nueva tarjeta se usa para estos pagos a partir de entonces.",
  cardBank: "Si tu banco ya te ha enviado una tarjeta nueva, puede que Stripe la reciba por su cuenta; añadirla aquí lo asegura.",
  cardTitle: "Actualiza tu tarjeta",
  cardHead: (title) => `Actualiza la tarjeta de ${title}`,
  cardHeadStore: (store) => `Actualiza la tarjeta con la que pagas a ${store}`,
  cardIntro: "No se cobra nada ahora. La tarjeta que añadas se usa para estos pagos a partir de entonces.",
  cardPayNow: "Tu último pago no se completó, así que se cobra en la nueva tarjeta en ese mismo momento.",
  cardButton: "Añadir una tarjeta nueva",
  cardNote: "En la propia página segura de Stripe. La tienda nunca ve el número de tu tarjeta.",
  cardEnded: "Esta membresía ha terminado, así que no hay tarjeta que actualizar.",
  cardNotices: {
    updated: { title: "Tu tarjeta está actualizada", body: "Tus próximos pagos usan la nueva tarjeta." },
    paid: { title: "Tu tarjeta está actualizada y tu pago se completó", body: "Tus próximos pagos también usan la nueva tarjeta." },
    declined: {
      title: "Tu nueva tarjeta está guardada, pero el pago fue rechazado",
      body: "Tus próximos pagos usan la nueva tarjeta. Stripe vuelve a intentar el que falló, o puedes pagarlo desde el enlace del correo que te avisó.",
    },
    canceled: { title: "No se ha cambiado nada", body: "Saliste de la página de Stripe antes de guardar una tarjeta. Pulsa el botón para intentarlo de nuevo." },
    expired: { title: "Este enlace ha caducado", body: "Pide un enlace a tu membresía en su página; desde allí puedes cambiar tu tarjeta." },
    error: { title: "Algo salió mal por nuestra parte", body: "No se ha cambiado nada. Inténtalo de nuevo en un momento." },
  },
};

const fr: MembershipWords = {
  yourMembership: "Votre abonnement",
  switchTitle: "Modifier votre abonnement",
  endedTitle: "Votre abonnement est terminé",
  nothingCharged: "Rien n'a été débité",

  manageNotices: {
    email: {
      title: "Cela ne ressemble pas à une adresse e-mail",
      body: `Vérifiez-la et réessayez. Utilisez l'adresse avec laquelle vous payez${S}: celle que vous avez saisie lors de votre inscription.`,
    },
    limited: {
      title: "Trop de demandes pour le moment",
      body: "Pour éviter que ce formulaire serve à inonder la boîte de réception de quelqu'un, il accepte un nombre limité de demandes par heure. Réessayez dans une heure.",
    },
    unavailable: {
      title: "Cette boutique ne peut pas ouvrir d'abonnements pour le moment",
      body: "Ses paiements ne sont pas reliés à Stripe pour le moment, il n'y a donc aucun abonnement à ouvrir depuis cette page. Répondez à l'e-mail de confirmation de votre commande et il parviendra à la boutique.",
    },
    error: {
      title: "Un problème est survenu de notre côté",
      body: "Rien n'a été modifié. Réessayez dans un instant.",
    },
    unconfirmed: {
      title: "Nous n'avons pas pu confirmer le changement",
      body: `La réponse de Stripe ne disait pas s'il a été fait. Regardez votre abonnement ci-dessous avant de réessayer${S}: il montre la formule que vous avez maintenant.`,
    },
    expired: {
      title: "Ce lien a expiré",
      body: `Un lien vers votre abonnement fonctionne pendant une heure. Demandez-en un nouveau ci-dessous${S}; cela prend quelques secondes.`,
    },
    used: {
      title: "Ce lien a été utilisé trop de fois",
      body: `Demandez-en un nouveau ci-dessous${S}; cela prend quelques secondes.`,
    },
    switched: {
      title: "Votre abonnement a été modifié",
      body: "Ce que comprend la nouvelle formule vous est accessible dès maintenant, et un reçu arrive dans votre boîte de réception.",
    },
    yearly: {
      title: "Vous payez désormais à l'année",
      body: "Ce que comprend votre abonnement reste identique, et un reçu arrive dans votre boîte de réception.",
    },
    declined: {
      title: "La carte n'a pas été débitée, donc rien n'a changé",
      body: `Votre banque a refusé le paiement ou demandé une étape que nous ne pouvions pas afficher ici. Mettez à jour votre carte avec «${S}Changer de carte ou voir les reçus${S}» ci-dessous, puis réessayez le changement.`,
    },
    stale: {
      title: `Ce prix datait de plus de 15${S}minutes`,
      body: "Rien n'a été modifié. Choisissez à nouveau la formule pour voir le prix actuel.",
    },
    busy: {
      title: "Un changement était déjà en cours",
      body: "Patientez un instant et consultez votre abonnement ci-dessous avant de réessayer.",
    },
    currency: { title: "Cet abonnement garde sa formule", body: "Il est payé dans une autre devise que celle des formules actuelles de la boutique, il garde donc sa formule actuelle. Rien n'a été modifié, et vous pouvez toujours l'annuler sur la page de votre abonnement." },
    "cannot-switch": {
      title: "Ce changement est impossible",
      body: "La formule n'est peut-être plus proposée, ou l'abonnement est peut-être annulé ou en attente d'un paiement. Rien n'a été modifié.",
    },
  },
  manageHead: "Gérer ou annuler votre abonnement",
  manageIntro: (store) =>
    `Saisissez l'e-mail avec lequel vous payez ${store}, et nous vous enverrons par e-mail un lien vers votre abonnement. Ni compte ni mot de passe${S}: vous l'annulez vous-même, directement sur la page de Stripe.`,
  manageUnavailable: (store) =>
    `${store} ne peut pas accepter de paiements via Stripe pour le moment, il n'y a donc aucun abonnement à ouvrir ici. Répondez à l'e-mail de confirmation de votre commande et il lui parviendra.`,
  payEmailLabel: "L'e-mail avec lequel vous payez",
  emailMeLink: "M'envoyer un lien vers mon abonnement",
  linkNote: (store, hours) =>
    `Si cette adresse a un abonnement chez ${store}, nous essayons de lui envoyer un lien par e-mail. Il fonctionne pendant ${hours < 2 ? "une heure" : `${hours}${S}heures`}. Nous affichons le même message dans tous les cas, pour que personne ne puisse utiliser cette page pour savoir qui est membre.`,
  checkInbox: "Consultez votre boîte de réception",
  sentBody: (store) =>
    `Si cette adresse a un abonnement chez ${store}, le lien est en route. Il vient de ${store} via Marktmorgen. S'il n'y est pas, regardez dans les spams.`,
  tryOther: `Rien reçu${S}? Vous payez peut-être avec une autre adresse${S}: celle que vous avez saisie lors de votre inscription. Essayez-la ci-dessous.`,

  yourMemberships: "Vos abonnements",
  every: (interval, count) =>
    count < 2
      ? { day: "par jour", week: "par semaine", month: "par mois", year: "par an" }[interval]
      : {
          day: `tous les ${count}${S}jours`,
          week: `toutes les ${count}${S}semaines`,
          month: `tous les ${count}${S}mois`,
          year: `tous les ${count}${S}ans`,
        }[interval],
  ends: (date) => `Se termine le ${date}`,
  cancel: "Annuler",
  switchPlan: "Changer de formule",
  switchCurrencyNote: "Cet abonnement ne propose pas de changer de formule, car il est payé dans une autre devise que celle des formules actuelles de la boutique.",
  upgrade: " · formule supérieure",
  downgrade: " · formule inférieure",
  exactFirst: "Vous voyez le montant exact avant tout débit.",
  cannotList:
    "Stripe n'a pas pu afficher vos abonnements pour le moment. Le bouton ci-dessous les ouvre tous sur la page de Stripe, où vous pouvez annuler.",
  changeCard: "Changer de carte ou voir les reçus",
  openMembership: "Ouvrir mon abonnement",
  pause: {
    button: "Mettre en pause plutôt",
    choose: "Mettre en pause pour",
    months: (n) => `${n} mois`,
    confirm: "Mettre mon abonnement en pause",
    note: (date) =>
      `Ce que vous avez payé reste ouvert jusqu'au ${date}. Ensuite, rien n'est débité et l'abonnement est fermé pendant la pause${S}; il reprend tout seul, avec un paiement, le jour où elle se termine.`,
    pausedUntil: (date) => `En pause jusqu'au ${date}`,
    startsPause: (date, until) => `En pause à partir du ${date}, de retour le ${until}`,
    resume: "Reprendre maintenant",
    resumeNote: "Reprendre prélève un paiement aujourd'hui, et l'abonnement est rouvert aussitôt.",
    emailSubject: (title) => `Votre abonnement ${title} est en pause`,
    emailBody: (title, store, from, until) =>
      `${title}${S}: ce que vous avez payé reste ouvert jusqu'au ${from}. De ce jour au ${until}, rien n'est débité et l'abonnement est en pause. Le ${until}, il reprend tout seul, avec le paiement habituel.\n\nPour revenir plus tôt, ou pour annuler, ouvrez votre abonnement depuis la page de ${store}.`,
  },
  pauseNotices: {
    paused: { title: "Votre abonnement est en pause", body: "Un e-mail avec les dates arrive dans votre boîte." },
    resumed: { title: "Votre abonnement a repris", body: "Le paiement est passé, et tout ce qu'il comprend vous est de nouveau ouvert." },
    cannot: {
      title: "Cet abonnement ne peut pas être mis en pause pour l'instant",
      body: "Rien n'a été modifié. Un abonnement peut être mis en pause une fois par an, s'il est payé chaque mois et fonctionne normalement.",
    },
    declined: {
      title: "La carte n'a pas été débitée, l'abonnement reste donc en pause",
      body: "Mettez à jour votre carte avec le bouton ci-dessous, puis appuyez de nouveau sur Reprendre maintenant.",
    },
  } as Record<string, Notice>,
  cancelNote: "Si vous annulez, l'abonnement reste actif jusqu'à la fin de la période déjà payée, et plus rien n'est débité.",

  leaveTitle: "Avant de partir",
  leaveHead: (title) => `Annuler ${title}${S}?`,
  leaveHeadPlain: `Annuler votre abonnement${S}?`,
  leaveIntro: (store) =>
    `Si vous dites à ${store} pourquoi, il existe peut-être une meilleure solution pour vous ci-dessous. Répondre est facultatif${S}: vous pouvez annuler tout de suite.`,
  leaveAsk: `Pourquoi partez-vous${S}?`,
  leaveReasons: {
    too_expensive: "C'est trop cher",
    unused: "Je ne m'en sers pas assez",
    missing_features: "Il manque quelque chose dont j'ai besoin",
    switched_service: "J'utilise autre chose maintenant",
    too_complex: "C'est trop difficile à utiliser",
    low_quality: "La qualité n'est pas suffisante",
    customer_service: "Je n'ai pas eu d'aide quand j'en ai demandé",
    other: "Une autre raison",
  },
  leaveContinue: "Continuer",
  leaveThanks: "Merci d'avoir donné la raison.",
  leaveCheaper: `Une formule moins chère${S}:`,
  leavePause: `Ou gardez votre place et faites une pause${S}:`,
  leavePauseOnly: `Gardez votre place et faites une pause${S}:`,
  leaveContact: (store) => `${store} aimerait le savoir. Écrivez-lui, et le problème pourra être réglé${S}:`,
  leaveWrite: (store) => `Écrire à ${store}`,
  leaveStill: `Vous voulez toujours partir${S}?`,
  leaveCancel: "Annuler mon abonnement",
  leaveConfirm: "La page de Stripe s'ouvre, et vous y confirmez.",
  leaveGone: `Cet abonnement ne peut pas être annulé ici${S}: il est terminé, ou sa fin est déjà prévue.`,

  nudgeSubject: (title) => `${title} est toujours là pour vous`,
  nudgeLead: (title) =>
    `Cela fait un moment que vous n'avez pas ouvert ${title}. Tout ce qui en fait partie est toujours là pour vous, et vous pouvez reprendre là où vous en étiez.`,
  nudgeCourse: `Ouvrir la formation${S}:`,
  nudgeCommunity: `Entrer dans la communauté${S}:`,
  nudgeReply: (store) => `Si quelque chose vous en empêche, répondez à cet e-mail et ${store} le recevra.`,

  // ---- Payer à l'année plutôt qu'au mois ------------------------------------------------------
  payYearly: (yearly, saving) => `Payer à l'année : ${yearly}, soit ${saving} d'économie`,
  yearlyHead: (title) => `Payer ${title} à l'année`,
  yearlySaves: (amount) => `${amount} d'économie par an par rapport à douze paiements mensuels.`,
  yearlyDueNote: "Le prix de l'année, moins ce qui reste du mois déjà payé, sur la carte avec laquelle vous payez. Votre prochain paiement aura lieu dans un an.",
  yearlyTrialNote: "Vous êtes dans votre essai gratuit. Rien n'est débité maintenant ; le prix annuel est débité à la fin de l'essai.",
  yearlyHolds: (store) => `Ce prix est valable 15 minutes. Débité par ${store} sur son propre compte Stripe. Ce que comprend votre abonnement reste identique.`,
  yearlySubject: (title) => `Vous payez désormais ${title} à l'année`,
  yearlyNow: (store, title) => `Votre abonnement ${title} chez ${store} est désormais payé à l'année. Ce qu'il comprend reste identique.`,
  yearlyPaidCharged: (amount) => `Débité aujourd'hui : ${amount}, l'année moins ce qui restait de votre dernier paiement mensuel.`,
  yearlyPaidTrial: "Vous êtes dans votre essai gratuit, donc rien n'a été débité. Le prix annuel est débité à la fin de l'essai.",
  askSubject: (title, saving) => `${title} : payez à l'année et économisez ${saving}`,
  askLead: (store, title, monthly, yearly, saving) =>
    `Vous payez ${monthly} pour ${title}. ${store} le propose aussi à l'année : ${yearly}. C'est ${saving} de moins que douze paiements mensuels, et ce qu'il comprend reste identique.`,
  askSee: "Voyez exactement ce que vous paieriez aujourd'hui, avant que rien ne soit débité :",
  askWorks: "Le lien fonctionne 14 jours et n'ouvre que ce changement. Rien ne change tant que vous n'appuyez pas sur le bouton de cette page.",
  askReply: (store) => `Des questions ? Répondez à cet e-mail et ${store} le recevra.`,

  switchProblems: {
    expired: { title: "Ce lien a expiré", body: "Un lien vers votre abonnement fonctionne pendant une heure. Demandez-en un nouveau sur la page de votre abonnement." },
    gone: {
      title: "Cet abonnement ne peut pas changer de formule",
      body: "Il est peut-être annulé, programmé pour se terminer, en attente d'un paiement, ou il n'est plus le vôtre avec ce lien. Rien n'a été modifié.",
    },
    tier: {
      title: "Cette formule n'est plus proposée",
      body: "Revenez à la page de votre abonnement pour voir les formules vers lesquelles vous pouvez passer maintenant. Rien n'a été modifié.",
    },
    currency: { title: "Cet abonnement garde sa formule", body: "Il est payé dans une autre devise que celle des formules actuelles de la boutique, il garde donc sa formule actuelle. Rien n'a été modifié, et vous pouvez toujours l'annuler sur la page de votre abonnement." },
    error: { title: "Stripe n'a pas pu calculer le prix pour le moment", body: "Rien n'a été modifié. Réessayez dans un instant." },
    yearly: { title: "Le paiement annuel n'est pas proposé pour cet abonnement", body: "Il est peut-être déjà payé à l'année, bénéficie d'une réduction, est résilié ou en attente d'un paiement, ou le prix annuel a changé. Rien n'a été modifié." },
    yearlyExpired: { title: "Ce lien a expiré", body: "Le lien de l'e-mail fonctionne 14 jours. Demandez un lien vers votre abonnement sur sa page ; de là, vous pouvez payer à l'année." },
  },
  switchTo: (title) => `Passer à ${title}`,
  nowLabel: "Actuellement",
  afterLabel: "Après le changement",
  nothingNow: "Rien n'est débité maintenant",
  chargedToday: (amount) => `Débité aujourd'hui${S}: ${amount}`,
  offNext: (amount) => `Déduit de vos prochains paiements${S}: ${amount}`,
  nothingToday: "Rien n'est débité aujourd'hui",
  switchTrialNote: "Vous êtes dans votre essai gratuit. La nouvelle formule s'ouvre maintenant, et son prix commence à la fin de l'essai.",
  dueNote: "Le nouveau prix, moins ce qui restait de votre dernier paiement, sur la carte avec laquelle vous payez. La nouvelle formule s'ouvre dès que c'est payé.",
  creditNote: "Ce qui restait de votre dernier paiement devient un avoir auprès de la boutique, déduit de vos prochains paiements. La nouvelle formule s'ouvre maintenant.",
  opensNow: "La nouvelle formule s'ouvre maintenant.",
  switchAndPay: (amount) => `Changer et payer ${amount}`,
  switchNow: "Changer maintenant",
  holdsNote: (store, title) =>
    `Ce prix est garanti pendant 15${S}minutes. Débité par ${store} sur son propre compte Stripe. Tout ce qui n'est compris que dans ${title} se ferme lorsque vous changez.`,
  backToMembership: "Retour à votre abonnement",

  offerNotices: {
    member: "Vous avez déjà un abonnement à ceci qui est toujours en cours, donc l'offre n'a pas été utilisée. Rien n'a été débité.",
    price: "La boutique ne propose plus le prix auquel cette offre correspondait, elle ne peut donc pas être utilisée. Rien n'a été débité.",
    expired: "Cette offre est terminée. Vous pouvez toujours revenir au prix habituel ci-dessous.",
    unavailable: "Cette offre ne peut plus être utilisée pour cet abonnement. Vous pouvez toujours revenir au prix habituel ci-dessous, s'il est proposé.",
    refused: "L'offre n'a pas pu être appliquée pour le moment. Vous pouvez revenir au prix habituel ci-dessous, ou répondre à l'e-mail dans lequel elle est arrivée.",
    limited: "Trop de tentatives pour le moment. Attendez quelques minutes et appuyez à nouveau sur le bouton.",
  },
  membershipLabel: "Abonnement",
  endedBody: (title) =>
    `Votre abonnement à ${title} n'est plus actif, donc ce à quoi il vous donnait accès est désormais fermé. Renouvelez-le et tout se rouvre immédiatement.`,
  endedClosed: (title) =>
    `Votre abonnement à ${title} n'est plus actif, donc ce à quoi il vous donnait accès est désormais fermé.`,
  endedGone: (store) => `Cet abonnement n'est plus actif, et ${store} ne le propose plus.`,
  comeBackOffer: "Votre offre de retour",
  offerWords: (percent, months) =>
    months < 2
      ? `${percent}${S}% de réduction sur votre premier paiement`
      : `${percent}${S}% de réduction sur vos ${months} premiers paiements`,
  offerFor: (email, until) =>
    `Pour ${email}, jusqu'au ${until}. Appliquée sur la page de Stripe avant de payer${S}; pas d'essai gratuit cette fois.`,
  comeBackWith: "Revenir avec cette offre",
  renewTitle: (title) => `Renouveler ${title}`,
  renewPrice: (price) => `Renouveler · ${price}`,
  renew: "Renouveler",
  notTaking: (store) =>
    `${store} n'accepte pas de nouveaux membres pour cela en ce moment. Répondez à l'e-mail de confirmation de votre commande et il lui parviendra.`,
  see: (title) => `Voir ${title}`,
  seePrices: (title) => `Voir les prix actuels de ${title}`,
  failedBefore: `Il s'est terminé parce qu'un paiement a échoué, et non parce que vous avez annulé${S}? Mettre à jour la carte peut le rétablir sans le renouveler${S}: `,
  failedLink: "gérez votre abonnement",
  failedAfter: " avec l'e-mail avec lequel vous avez payé.",
  boughtBefore: `Ce que vous avez acheté séparément reste à vous${S}: `,
  boughtLink: "récupérez vos achats",
  boughtAfter: ".",

  leftNotices: {
    email: {
      title: "Cela ne ressemble pas à une adresse e-mail",
      body: "Vérifiez-la et réessayez. Le rappel est envoyé à l'adresse que vous saisissez, elle doit donc être une adresse que vous pouvez consulter.",
    },
    limited: {
      title: "Trop de rappels demandés à l'instant",
      body: "Pour éviter que ce formulaire serve à remplir la boîte de réception de quelqu'un, il accepte un nombre limité de demandes par heure. Rien n'a été enregistré. Le produit est toujours là quand vous le voulez.",
    },
    closed: {
      title: "Aucun rappel ne peut être envoyé pour cela",
      body: "Il est peut-être épuisé ou retiré de la vente. Rien n'a été enregistré.",
    },
    error: {
      title: "Nous n'avons pas pu l'enregistrer pour le moment",
      body: "Rien n'a été enregistré. Réessayez dans un instant.",
    },
  },
  done: "C'est fait",
  oneReminder: "Un rappel, dans une heure environ",
  willEmail: (store, title) =>
    `${store} vous enverra un seul e-mail, avec le lien vers ${title}. Si vous l'achetez d'ici là, aucun rappel n'est envoyé.`,
  onlyEmail:
    "C'est le seul e-mail envoyé. Il ne vous inscrit à aucune liste, et il contient un lien qui arrête définitivement les rappels de cette boutique.",
  leftBefore: (title) => `Vous avez quitté la page avant de payer ${title}`,
  notCharged: "Votre carte n'a pas été débitée. Si vous le voulez toujours, il est à un clic.",
  notReady: `Vous hésitez encore${S}?`,
  remindNote: (store) =>
    `Laissez votre e-mail et ${store} vous envoie un rappel avec le lien, dans une heure environ. Un seul e-mail. Il ne vous inscrit à aucune liste.`,
  remindMe: "Me le rappeler une fois",
  addressUse: (store) =>
    `Votre adresse sert à ce seul rappel et au lien qu'il contient pour arrêter les rappels de ${store}, et à rien d'autre.`,
  // ---- A reminder asked for on a product's page (lib/ask-when.ts) -------------------------------
  askWhen: "Quand",
  askTimes: { hour: "Dans une heure environ", day: "Demain", days: "Dans trois jours" },
  pageRemindNote: (store) =>
    `Laissez votre e-mail et ${store} vous envoie un seul rappel avec le lien, au moment choisi. Un seul e-mail. Il ne vous ajoute à aucune liste.`,
  /** When the reminder goes, as said in the middle of a sentence (pageAsked). */
  askSaid: { hour: "dans une heure environ", day: "demain", days: "dans trois jours" },
  pageAsked: (store, title, when) => `${store} vous enverra un seul e-mail avec le lien vers ${title} ${when}. Si vous l'achetez avant, aucun rappel n'est envoyé.`,

  fromName: (store) => `${store} via Marktmorgen`,
  membershipWith: (store) => `Votre abonnement chez ${store}`,
  linkIntro: (store) => `Vous avez demandé à gérer votre abonnement chez ${store}. Voici le lien d'accès${S}:`,
  linkTiers:
    "Ouvrez le lien pour voir votre abonnement. De là, vous pouvez passer à une autre formule, en voyant le montant exact avant tout débit, ou l'annuler, changer la carte avec laquelle il est payé, ou voir vos reçus. Si vous annulez, il reste actif jusqu'à la fin de la période déjà payée, et plus rien n'est débité.",
  linkNoTiers: `Ouvrez le lien et appuyez sur le bouton. Stripe affiche alors votre abonnement${S}: vous pouvez l'annuler, changer la carte avec laquelle il est payé, ou voir vos reçus. Si vous annulez, il reste actif jusqu'à la fin de la période déjà payée, et plus rien n'est débité.`,
  linkWorks: `Le lien fonctionne pendant une heure. Si vous n'avez rien demandé, ignorez cet e-mail${S}; rien ne se passe tant que le lien n'est pas utilisé.`,
  linkFooter: (store) =>
    `Envoyé par Marktmorgen pour le compte de ${store}. L'abonnement est débité par ${store} sur son propre compte Stripe.`,

  switchedSubject: (title) => `Votre abonnement est passé à ${title}`,
  switchedNow: (store, title, from) => `Votre abonnement chez ${store} est désormais ${title}, à la place de ${from}.`,
  paidTrial: "Vous êtes dans votre essai gratuit, donc rien n'a été débité. Le nouveau prix commence à la fin de l'essai.",
  paidCharged: (amount) => `Débité aujourd'hui${S}: ${amount}, le nouveau prix moins ce qui restait de votre dernier paiement.`,
  paidCredit: (amount) =>
    `Un avoir de ${amount}, pour ce qui restait de votre dernier paiement, est déduit de vos prochains paiements.`,
  paidNothing: "Rien n'a été débité aujourd'hui.",
  fromNow: (price) => `Désormais${S}: ${price}.`,
  switchedOpen:
    "Ce qu'il comprend vous est accessible dès maintenant. Vos reçus se trouvent sur la page de votre abonnement, via le lien sur la page de la boutique.",
  switchedFooter: (store) =>
    `Débité par ${store} sur son propre compte Stripe. Pour toute question, répondez à cet e-mail et elle parviendra à ${store}.`,

  failedSubject: (store) => `Votre paiement à ${store} n'a pas abouti`,
  hi: "Bonjour,",
  failedFor: (amount, title) =>
    `Le dernier paiement de ${amount} pour ${title} n'a pas abouti. Cela arrive quand une carte expire, est remplacée ou est refusée par la banque.`,
  failedTo: (amount, store) =>
    `Le dernier paiement de ${amount} à ${store} n'a pas abouti. Cela arrive quand une carte expire, est remplacée ou est refusée par la banque.`,
  payHere: `Réglez-le ici, avec la même carte ou une nouvelle${S}:`,
  cardKept: "La carte avec laquelle vous payez sert aussi pour vos prochains paiements, vous n'avez donc à le faire qu'une fois.",
  triedAgainPlan: (date) => `Si vous ne faites rien, une nouvelle tentative sera faite sur la carte enregistrée le ${date}.`,
  triedAgain: (date) =>
    `Si vous ne faites rien, une nouvelle tentative sera faite sur la carte enregistrée le ${date}, et votre accès reste ouvert en attendant.`,
  notTriedAgain:
    "Aucune nouvelle tentative ne sera faite sur la carte enregistrée, donc ce paiement reste impayé tant qu'il n'est pas réglé depuis le lien ci-dessus.",
  receiptsPlan: (url) => `Pour voir vos reçus, ou changer de carte${S}: ${url}`,
  cancelInstead: (url) => `Pour annuler plutôt, ou voir vos reçus${S}: ${url}`,
  reminderSubject: (store) => `Rappel${S}: votre paiement à ${store} n'a toujours pas abouti`,
  reminderLead: "Un court rappel, au cas où le premier e-mail vous aurait échappé.",
  cardName: (brand, last4) => `${brand} se terminant par ${last4}`,
  cardSubject: (store) => `Votre carte pour ${store} expire avant votre prochain paiement`,
  cardFor: (card, title, date) =>
    `La carte avec laquelle vous payez ${title}, ${card}, expire avant votre prochain paiement, le ${date}.`,
  cardTo: (card, store, date) =>
    `La carte avec laquelle vous payez ${store}, ${card}, expire avant votre prochain paiement, le ${date}.`,
  cardHere: `Ajoutez votre nouvelle carte ici, pour que ce paiement aboutisse${S}:`,
  cardHow: "Cela prend une minute sur la page sécurisée de Stripe. Rien n'est débité maintenant, et la nouvelle carte sert pour ces paiements à partir de là.",
  cardBank: `Si votre banque vous a déjà envoyé une nouvelle carte, Stripe peut la recevoir de lui-même${S}; l'ajouter ici vous en assure.`,
  cardTitle: "Mettez à jour votre carte",
  cardHead: (title) => `Mettez à jour la carte pour ${title}`,
  cardHeadStore: (store) => `Mettez à jour la carte avec laquelle vous payez ${store}`,
  cardIntro: "Rien n'est débité maintenant. La carte que vous ajoutez sert pour ces paiements à partir de là.",
  cardPayNow: "Votre dernier paiement n'a pas abouti, il est donc débité tout de suite sur la nouvelle carte.",
  cardButton: "Ajouter une nouvelle carte",
  cardNote: "Sur la page sécurisée de Stripe. La boutique ne voit jamais le numéro de votre carte.",
  cardEnded: "Cet abonnement est terminé, il n'y a donc pas de carte à mettre à jour.",
  cardNotices: {
    updated: { title: "Votre carte est à jour", body: "Vos prochains paiements utilisent la nouvelle carte." },
    paid: { title: "Votre carte est à jour et votre paiement a abouti", body: "Vos prochains paiements utilisent aussi la nouvelle carte." },
    declined: {
      title: "Votre nouvelle carte est enregistrée, mais le paiement a été refusé",
      body: "Vos prochains paiements utilisent la nouvelle carte. Stripe retente celui qui a échoué, ou vous pouvez le payer depuis le lien de l'e-mail qui vous en a parlé.",
    },
    canceled: { title: "Rien n'a été modifié", body: "Vous avez quitté la page de Stripe avant d'enregistrer une carte. Appuyez sur le bouton pour réessayer." },
    expired: { title: "Ce lien a expiré", body: `Demandez un lien vers votre abonnement sur sa page${S}; de là, vous pouvez changer de carte.` },
    error: { title: "Un problème est survenu de notre côté", body: "Rien n'a été modifié. Réessayez dans un instant." },
  },
};

const de: MembershipWords = {
  yourMembership: "Ihre Mitgliedschaft",
  switchTitle: "Mitgliedschaft wechseln",
  endedTitle: "Ihre Mitgliedschaft ist beendet",
  nothingCharged: "Es wurde nichts berechnet",

  manageNotices: {
    email: {
      title: "Das sieht nicht nach einer E-Mail-Adresse aus",
      body: "Prüfen Sie sie und versuchen Sie es erneut. Verwenden Sie die Adresse, mit der Sie bezahlen: die, die Sie beim Beitritt eingegeben haben.",
    },
    limited: {
      title: "Vorerst zu viele Anfragen",
      body: "Damit dieses Formular nicht dazu benutzt wird, jemandes Posteingang zu überfluten, nimmt es nur eine begrenzte Zahl von Anfragen pro Stunde an. Versuchen Sie es in einer Stunde erneut.",
    },
    unavailable: {
      title: "Dieser Shop kann gerade keine Mitgliedschaften öffnen",
      body: "Seine Zahlungen sind gerade nicht mit Stripe verbunden, daher gibt es auf dieser Seite keine Mitgliedschaft zu öffnen. Antworten Sie auf die E-Mail mit Ihrer Bestellbestätigung, dann erreicht Ihre Nachricht den Shop.",
    },
    error: {
      title: "Bei uns ist etwas schiefgelaufen",
      body: "Es wurde nichts geändert. Versuchen Sie es gleich noch einmal.",
    },
    unconfirmed: {
      title: "Wir konnten den Wechsel nicht bestätigen",
      body: "Die Antwort von Stripe sagte nicht, ob er durchging. Sehen Sie sich Ihre Mitgliedschaft unten an, bevor Sie es noch einmal versuchen: Dort steht Ihr aktueller Tarif.",
    },
    expired: {
      title: "Dieser Link ist abgelaufen",
      body: "Ein Link zu Ihrer Mitgliedschaft funktioniert eine Stunde lang. Fordern Sie unten einen neuen an; das dauert nur ein paar Sekunden.",
    },
    used: {
      title: "Dieser Link wurde zu oft verwendet",
      body: "Fordern Sie unten einen neuen an; das dauert nur ein paar Sekunden.",
    },
    switched: {
      title: "Ihre Mitgliedschaft wurde gewechselt",
      body: "Was der neue Tarif umfasst, steht Ihnen jetzt offen, und eine Quittung ist auf dem Weg in Ihren Posteingang.",
    },
    yearly: {
      title: "Sie zahlen jetzt jährlich",
      body: "Was Ihre Mitgliedschaft umfasst, bleibt gleich, und eine Quittung ist auf dem Weg in Ihren Posteingang.",
    },
    declined: {
      title: "Die Karte wurde nicht belastet, daher hat sich nichts geändert",
      body: "Ihre Bank hat die Zahlung abgelehnt oder einen Schritt verlangt, den wir hier nicht anzeigen konnten. Aktualisieren Sie Ihre Karte unten über „Karte ändern oder Quittungen ansehen“ und versuchen Sie den Wechsel dann erneut.",
    },
    stale: {
      title: "Dieser Preis war älter als 15 Minuten",
      body: "Es wurde nichts geändert. Wählen Sie den Tarif erneut, um den aktuellen Preis zu sehen.",
    },
    busy: {
      title: "Ein Wechsel war bereits im Gange",
      body: "Warten Sie einen Moment und sehen Sie sich unten Ihre Mitgliedschaft an, bevor Sie es erneut versuchen.",
    },
    currency: { title: "Diese Mitgliedschaft bleibt bei ihrem Tarif", body: "Sie wird in einer anderen Währung bezahlt als der, in der die Tarife des Shops jetzt angeboten werden, und bleibt deshalb bei ihrem Tarif. Es wurde nichts geändert, und Sie können sie weiterhin auf der Seite Ihrer Mitgliedschaft kündigen." },
    "cannot-switch": {
      title: "Dieser Wechsel ist nicht möglich",
      body: "Der Tarif wird möglicherweise nicht mehr angeboten, oder die Mitgliedschaft ist gekündigt oder wartet auf eine Zahlung. Es wurde nichts geändert.",
    },
  },
  manageHead: "Mitgliedschaft verwalten oder kündigen",
  manageIntro: (store) =>
    `Geben Sie die E-Mail-Adresse ein, mit der Sie bei ${store} bezahlen, und wir schicken Ihnen per E-Mail einen Link zu Ihrer Mitgliedschaft. Kein Konto und kein Passwort: Sie kündigen selbst, direkt auf der Seite von Stripe.`,
  manageUnavailable: (store) =>
    `${store} kann gerade keine Zahlungen über Stripe annehmen, daher gibt es hier keine Mitgliedschaft zu öffnen. Antworten Sie auf die E-Mail mit Ihrer Bestellbestätigung, dann erreicht Ihre Nachricht ${store}.`,
  payEmailLabel: "Die E-Mail-Adresse, mit der Sie bezahlen",
  emailMeLink: "Link zu meiner Mitgliedschaft per E-Mail senden",
  linkNote: (store, hours) =>
    `Wenn diese Adresse eine Mitgliedschaft bei ${store} hat, versuchen wir, einen Link dorthin per E-Mail zu senden. Er funktioniert ${hours === 1 ? "eine Stunde" : `${hours} Stunden`} lang. Wir sagen dasselbe, ob das der Fall ist oder nicht, damit niemand mit dieser Seite herausfinden kann, wer Mitglied ist.`,
  checkInbox: "Sehen Sie in Ihrem Posteingang nach",
  sentBody: (store) =>
    `Wenn diese Adresse eine Mitgliedschaft bei ${store} hat, ist der Link unterwegs. Er kommt von ${store} über Marktmorgen. Falls er nicht da ist, sehen Sie im Spam-Ordner nach.`,
  tryOther:
    "Nichts angekommen? Vielleicht bezahlen Sie mit einer anderen Adresse: der, die Sie beim Beitritt eingegeben haben. Versuchen Sie es unten mit dieser.",

  yourMemberships: "Ihre Mitgliedschaften",
  every: (interval, count) =>
    count === 1
      ? { day: "pro Tag", week: "pro Woche", month: "pro Monat", year: "pro Jahr" }[interval]
      : `alle ${count} ${{ day: "Tage", week: "Wochen", month: "Monate", year: "Jahre" }[interval]}`,
  ends: (date) => `Endet am ${date}`,
  cancel: "Kündigen",
  switchPlan: "Tarif wechseln",
  switchCurrencyNote: "Bei dieser Mitgliedschaft ist kein Tarifwechsel möglich: Sie wird in einer anderen Währung bezahlt als der, in der die Tarife des Shops jetzt angeboten werden.",
  upgrade: " · höherer Tarif",
  downgrade: " · niedrigerer Tarif",
  exactFirst: "Sie sehen den genauen Betrag, bevor etwas berechnet wird.",
  cannotList:
    "Stripe konnte Ihre Mitgliedschaften gerade nicht auflisten. Die Schaltfläche unten öffnet sie alle auf der Seite von Stripe, wo Sie kündigen können.",
  changeCard: "Karte ändern oder Quittungen ansehen",
  openMembership: "Meine Mitgliedschaft öffnen",
  pause: {
    button: "Stattdessen pausieren",
    choose: "Pausieren für",
    months: (n) => (n === 1 ? "1 Monat" : `${n} Monate`),
    confirm: "Meine Mitgliedschaft pausieren",
    note: (date) =>
      `Was Sie bezahlt haben, bleibt bis zum ${date} offen. Danach wird nichts abgebucht und die Mitgliedschaft ist während der Pause geschlossen; sie beginnt am Tag, an dem die Pause endet, von selbst wieder, mit einer Zahlung.`,
    pausedUntil: (date) => `Pausiert bis ${date}`,
    startsPause: (date, until) => `Pausiert ab ${date}, zurück am ${until}`,
    resume: "Jetzt fortsetzen",
    resumeNote: "Beim Fortsetzen wird heute eine Zahlung abgebucht, und die Mitgliedschaft ist sofort wieder offen.",
    emailSubject: (title) => `Ihre Mitgliedschaft ${title} ist pausiert`,
    emailBody: (title, store, from, until) =>
      `${title}: Was Sie bezahlt haben, bleibt bis zum ${from} offen. Von da an bis zum ${until} wird nichts abgebucht und die Mitgliedschaft ist pausiert. Am ${until} beginnt sie von selbst wieder, mit der üblichen Zahlung.\n\nUm früher zurückzukommen oder zu kündigen, öffnen Sie Ihre Mitgliedschaft über die Seite von ${store}.`,
  },
  pauseNotices: {
    paused: { title: "Ihre Mitgliedschaft ist pausiert", body: "Eine E-Mail mit den Daten ist unterwegs." },
    resumed: { title: "Ihre Mitgliedschaft läuft wieder", body: "Die Zahlung ist durchgegangen, und alles, was dazugehört, ist wieder für Sie offen." },
    cannot: {
      title: "Diese Mitgliedschaft kann gerade nicht pausiert werden",
      body: "Es wurde nichts geändert. Eine Mitgliedschaft kann einmal im Jahr pausiert werden, wenn sie monatlich bezahlt wird und normal läuft.",
    },
    declined: {
      title: "Die Karte wurde nicht belastet, daher bleibt die Mitgliedschaft pausiert",
      body: "Aktualisieren Sie Ihre Karte über die Schaltfläche unten und drücken Sie dann erneut auf Jetzt fortsetzen.",
    },
  } as Record<string, Notice>,
  cancelNote:
    "Wenn Sie kündigen, läuft die Mitgliedschaft bis zum Ende des bereits bezahlten Zeitraums weiter, und es wird nichts mehr berechnet.",

  leaveTitle: "Bevor Sie gehen",
  leaveHead: (title) => `${title} kündigen?`,
  leaveHeadPlain: "Ihre Mitgliedschaft kündigen?",
  leaveIntro: (store) =>
    `Wenn Sie ${store} sagen, warum, gibt es unten vielleicht einen besseren Weg für Sie. Antworten ist freiwillig: Sie können sofort kündigen.`,
  leaveAsk: "Warum gehen Sie?",
  leaveReasons: {
    too_expensive: "Es kostet zu viel",
    unused: "Ich nutze es zu wenig",
    missing_features: "Mir fehlt etwas, das ich brauche",
    switched_service: "Ich bin zu etwas anderem gewechselt",
    too_complex: "Es ist zu schwer zu benutzen",
    low_quality: "Die Qualität reicht nicht",
    customer_service: "Mir wurde nicht geholfen, als ich gefragt habe",
    other: "Ein anderer Grund",
  },
  leaveContinue: "Weiter",
  leaveThanks: "Danke, dass Sie den Grund nennen.",
  leaveCheaper: "Ein günstigerer Plan:",
  leavePause: "Oder behalten Sie Ihren Platz und pausieren Sie stattdessen:",
  leavePauseOnly: "Behalten Sie Ihren Platz und pausieren Sie stattdessen:",
  leaveContact: (store) => `${store} möchte es wissen. Schreiben Sie, damit es behoben werden kann:`,
  leaveWrite: (store) => `An ${store} schreiben`,
  leaveStill: "Möchten Sie trotzdem gehen?",
  leaveCancel: "Meine Mitgliedschaft kündigen",
  leaveConfirm: "Die Seite von Stripe öffnet sich, dort bestätigen Sie es.",
  leaveGone: "Diese Mitgliedschaft kann hier nicht gekündigt werden: Sie ist beendet oder endet bereits zu einem festen Datum.",

  nudgeSubject: (title) => `${title} ist weiter für Sie da`,
  nudgeLead: (title) =>
    `Sie waren eine Weile nicht mehr bei ${title}. Alles, was dazugehört, ist weiter für Sie da, und Sie können dort weitermachen, wo Sie aufgehört haben.`,
  nudgeCourse: "Zum Kurs:",
  nudgeCommunity: "Zur Community:",
  nudgeReply: (store) => `Wenn Ihnen etwas im Weg steht, antworten Sie auf diese E-Mail, sie erreicht ${store}.`,

  // ---- Jährlich statt monatlich zahlen --------------------------------------------------------
  payYearly: (yearly, saving) => `Jährlich zahlen: ${yearly}, Sie sparen ${saving}`,
  yearlyHead: (title) => `${title} jährlich zahlen`,
  yearlySaves: (amount) => `Sie sparen ${amount} im Jahr gegenüber zwölf Monatszahlungen.`,
  yearlyDueNote: "Der Jahrespreis, abzüglich dessen, was vom bereits bezahlten Monat übrig ist, von der Karte, mit der Sie zahlen. Ihre nächste Zahlung ist in einem Jahr.",
  yearlyTrialNote: "Sie sind in Ihrer kostenlosen Testphase. Jetzt wird nichts berechnet; der Jahrespreis wird berechnet, wenn die Testphase endet.",
  yearlyHolds: (store) => `Dieser Preis gilt 15 Minuten. Berechnet von ${store} über das eigene Stripe-Konto. Was Ihre Mitgliedschaft umfasst, bleibt gleich.`,
  yearlySubject: (title) => `Sie zahlen ${title} jetzt jährlich`,
  yearlyNow: (store, title) => `Ihre Mitgliedschaft ${title} bei ${store} wird jetzt jährlich bezahlt. Was sie umfasst, bleibt gleich.`,
  yearlyPaidCharged: (amount) => `Heute berechnet: ${amount}, das Jahr abzüglich dessen, was von Ihrer letzten Monatszahlung übrig war.`,
  yearlyPaidTrial: "Sie sind in Ihrer kostenlosen Testphase, daher wurde nichts berechnet. Der Jahrespreis wird berechnet, wenn die Testphase endet.",
  askSubject: (title, saving) => `${title}: jährlich zahlen und ${saving} sparen`,
  askLead: (store, title, monthly, yearly, saving) =>
    `Sie zahlen ${monthly} für ${title}. ${store} bietet es auch jährlich an: ${yearly}. Das sind ${saving} weniger als zwölf Monatszahlungen, und was es umfasst, bleibt gleich.`,
  askSee: "Sehen Sie genau, was Sie heute zahlen würden, bevor etwas berechnet wird:",
  askWorks: "Der Link gilt 14 Tage und öffnet nur diese Änderung. Es ändert sich nichts, solange Sie nicht auf den Knopf auf dieser Seite drücken.",
  askReply: (store) => `Fragen? Antworten Sie auf diese E-Mail, sie erreicht ${store}.`,

  switchProblems: {
    expired: {
      title: "Dieser Link ist abgelaufen",
      body: "Ein Link zu Ihrer Mitgliedschaft funktioniert eine Stunde lang. Fordern Sie auf der Seite Ihrer Mitgliedschaft einen neuen an.",
    },
    gone: {
      title: "Diese Mitgliedschaft kann nicht wechseln",
      body: "Sie ist möglicherweise gekündigt, auf ein Ende gesetzt, wartet auf eine Zahlung oder gehört über diesen Link nicht mehr Ihnen. Es wurde nichts geändert.",
    },
    tier: {
      title: "Dieser Tarif wird nicht mehr angeboten",
      body: "Gehen Sie zurück zur Seite Ihrer Mitgliedschaft, um die Tarife zu sehen, zu denen Sie jetzt wechseln können. Es wurde nichts geändert.",
    },
    currency: { title: "Diese Mitgliedschaft bleibt bei ihrem Tarif", body: "Sie wird in einer anderen Währung bezahlt als der, in der die Tarife des Shops jetzt angeboten werden, und bleibt deshalb bei ihrem Tarif. Es wurde nichts geändert, und Sie können sie weiterhin auf der Seite Ihrer Mitgliedschaft kündigen." },
    error: { title: "Stripe konnte den Preis gerade nicht berechnen", body: "Es wurde nichts geändert. Versuchen Sie es gleich noch einmal." },
    yearly: { title: "Für diese Mitgliedschaft gibt es keine jährliche Zahlung", body: "Sie wird vielleicht schon jährlich bezahlt, hat einen Rabatt, ist gekündigt oder wartet auf eine Zahlung, oder der Jahrespreis hat sich geändert. Es wurde nichts geändert." },
    yearlyExpired: { title: "Dieser Link ist abgelaufen", body: "Der Link in der E-Mail gilt 14 Tage. Fordern Sie auf der Seite Ihrer Mitgliedschaft einen Link an; von dort können Sie jährlich zahlen." },
  },
  switchTo: (title) => `Zu ${title} wechseln`,
  nowLabel: "Jetzt",
  afterLabel: "Nach dem Wechsel",
  nothingNow: "Jetzt wird nichts berechnet",
  chargedToday: (amount) => `Heute berechnet: ${amount}`,
  offNext: (amount) => `Von Ihren nächsten Zahlungen abgezogen: ${amount}`,
  nothingToday: "Heute wird nichts berechnet",
  switchTrialNote:
    "Sie sind in Ihrem kostenlosen Testzeitraum. Der neue Tarif öffnet sich jetzt, und sein Preis gilt ab dem Ende des Testzeitraums.",
  dueNote:
    "Der neue Preis, abzüglich dessen, was von Ihrer letzten Zahlung übrig war, auf die Karte, mit der Sie bezahlen. Der neue Tarif öffnet sich, sobald bezahlt ist.",
  creditNote:
    "Was von Ihrer letzten Zahlung übrig war, wird zu einem Guthaben beim Shop und von Ihren nächsten Zahlungen abgezogen. Der neue Tarif öffnet sich jetzt.",
  opensNow: "Der neue Tarif öffnet sich jetzt.",
  switchAndPay: (amount) => `Wechseln und ${amount} bezahlen`,
  switchNow: "Jetzt wechseln",
  holdsNote: (store, title) =>
    `Dieser Preis gilt 15 Minuten lang. Berechnet von ${store} über das eigene Stripe-Konto. Alles, was nur ${title} umfasst, wird mit dem Wechsel geschlossen.`,
  backToMembership: "Zurück zu Ihrer Mitgliedschaft",

  offerNotices: {
    member: "Sie haben hierfür bereits eine Mitgliedschaft, die noch läuft, deshalb wurde das Angebot nicht genutzt. Es wurde nichts berechnet.",
    price: "Der Shop bietet den Preis, für den dieses Angebot galt, nicht mehr an, deshalb kann es nicht genutzt werden. Es wurde nichts berechnet.",
    expired: "Dieses Angebot ist abgelaufen. Sie können unten weiterhin zum normalen Preis zurückkehren.",
    unavailable:
      "Dieses Angebot kann für diese Mitgliedschaft nicht mehr genutzt werden. Sie können unten weiterhin zum normalen Preis zurückkehren, falls er angeboten wird.",
    refused:
      "Das Angebot konnte gerade nicht angewendet werden. Sie können unten zum normalen Preis zurückkehren oder auf die E-Mail antworten, mit der es kam.",
    limited: "Vorerst zu viele Versuche. Warten Sie ein paar Minuten und drücken Sie die Schaltfläche erneut.",
  },
  membershipLabel: "Mitgliedschaft",
  endedBody: (title) =>
    `Ihre Mitgliedschaft für ${title} läuft nicht mehr, daher ist das, wozu sie Ihnen Zugang gab, jetzt geschlossen. Erneuern Sie sie, und alles öffnet sich sofort wieder.`,
  endedClosed: (title) =>
    `Ihre Mitgliedschaft für ${title} läuft nicht mehr, daher ist das, wozu sie Ihnen Zugang gab, jetzt geschlossen.`,
  endedGone: (store) => `Diese Mitgliedschaft läuft nicht mehr, und ${store} bietet sie nicht mehr an.`,
  comeBackOffer: "Ihr Rückkehrangebot",
  offerWords: (percent, months) =>
    months === 1 ? `${percent}${S}% Rabatt auf Ihre erste Zahlung` : `${percent}${S}% Rabatt auf Ihre ersten ${months} Zahlungen`,
  offerFor: (email, until) =>
    `Für ${email}, bis zum ${until}. Wird auf der Seite von Stripe vor dem Bezahlen angewendet; diesmal ohne kostenlosen Testzeitraum.`,
  comeBackWith: "Mit diesem Angebot zurückkehren",
  renewTitle: (title) => `${title} erneuern`,
  renewPrice: (price) => `Erneuern · ${price}`,
  renew: "Erneuern",
  notTaking: (store) =>
    `${store} nimmt hierfür gerade keine neuen Mitglieder auf. Antworten Sie auf die E-Mail mit Ihrer Bestellbestätigung, dann erreicht Ihre Nachricht ${store}.`,
  see: (title) => `${title} ansehen`,
  seePrices: (title) => `Heutige Preise für ${title} ansehen`,
  failedBefore:
    "Endete sie, weil eine Zahlung fehlgeschlagen ist, und nicht, weil Sie gekündigt haben? Eine aktualisierte Karte kann sie ohne Erneuerung zurückbringen: ",
  failedLink: "verwalten Sie Ihre Mitgliedschaft",
  failedAfter: " mit der E-Mail-Adresse, mit der Sie bezahlt haben.",
  boughtBefore: "Was Sie einzeln gekauft haben, gehört weiterhin Ihnen: ",
  boughtLink: "Ihre Käufe erneut abrufen",
  boughtAfter: ".",

  leftNotices: {
    email: {
      title: "Das sieht nicht nach einer E-Mail-Adresse aus",
      body: "Prüfen Sie sie und versuchen Sie es erneut. Die Erinnerung geht an die Adresse, die Sie eingeben, also muss es eine sein, die Sie abrufen können.",
    },
    limited: {
      title: "Gerade zu viele Erinnerungen angefordert",
      body: "Damit dieses Formular nicht dazu benutzt wird, jemandes Posteingang zu füllen, nimmt es nur eine begrenzte Zahl pro Stunde an. Es wurde nichts gespeichert. Das Produkt ist weiterhin hier, wann immer Sie es möchten.",
    },
    closed: {
      title: "Hierfür kann keine Erinnerung gesendet werden",
      body: "Es ist möglicherweise ausverkauft oder nicht mehr im Verkauf. Es wurde nichts gespeichert.",
    },
    error: {
      title: "Das konnten wir gerade nicht speichern",
      body: "Es wurde nichts gespeichert. Versuchen Sie es gleich noch einmal.",
    },
  },
  done: "Erledigt",
  oneReminder: "Eine Erinnerung, in etwa einer Stunde",
  willEmail: (store, title) =>
    `${store} schickt Ihnen einmalig eine E-Mail mit dem Link zu ${title}. Wenn Sie es vorher kaufen, wird keine Erinnerung gesendet.`,
  onlyEmail:
    "Das ist die einzige E-Mail, die hierdurch gesendet wird. Sie werden in keine Liste aufgenommen, und sie enthält einen Link, der Erinnerungen von diesem Shop dauerhaft beendet.",
  leftBefore: (title) => `Sie haben die Seite verlassen, bevor Sie ${title} bezahlt haben`,
  notCharged: "Ihre Karte wurde nicht belastet. Wenn Sie es noch möchten, ist es nur einen Klick entfernt.",
  notReady: "Noch nicht so weit?",
  remindNote: (store) =>
    `Hinterlassen Sie Ihre E-Mail-Adresse, und ${store} schickt Ihnen in etwa einer Stunde eine Erinnerung mit dem Link. Eine E-Mail. Sie werden in keine Liste aufgenommen.`,
  remindMe: "Einmal erinnern",
  addressUse: (store) =>
    `Ihre Adresse wird für diese eine Erinnerung und den darin enthaltenen Link verwendet, der Erinnerungen von ${store} beendet, und für nichts anderes.`,
  // ---- A reminder asked for on a product's page (lib/ask-when.ts) -------------------------------
  askWhen: "Wann",
  askTimes: { hour: "In etwa einer Stunde", day: "Morgen", days: "In drei Tagen" },
  pageRemindNote: (store) =>
    `Hinterlassen Sie Ihre E-Mail-Adresse, und ${store} schickt Ihnen zum gewählten Zeitpunkt eine Erinnerung mit dem Link. Eine einzige E-Mail. Sie werden in keine Liste aufgenommen.`,
  /** When the reminder goes, as said in the middle of a sentence (pageAsked). */
  askSaid: { hour: "in etwa einer Stunde", day: "morgen", days: "in drei Tagen" },
  pageAsked: (store, title, when) => `${store} schickt Ihnen ${when} eine einzige E-Mail mit dem Link zu ${title}. Wenn Sie es vorher kaufen, wird keine Erinnerung gesendet.`,

  fromName: (store) => `${store} über Marktmorgen`,
  membershipWith: (store) => `Ihre Mitgliedschaft bei ${store}`,
  linkIntro: (store) => `Sie wollten Ihre Mitgliedschaft bei ${store} verwalten. Hier ist Ihr Zugang:`,
  linkTiers:
    "Öffnen Sie den Link, um Ihre Mitgliedschaft zu sehen. Dort können Sie zu einem anderen Tarif wechseln und sehen dabei den genauen Betrag, bevor etwas berechnet wird, oder sie kündigen, die Karte ändern, mit der sie bezahlt wird, oder Ihre Quittungen ansehen. Wenn Sie kündigen, läuft sie bis zum Ende des bereits bezahlten Zeitraums weiter, und es wird nichts mehr berechnet.",
  linkNoTiers:
    "Öffnen Sie den Link und drücken Sie die Schaltfläche. Stripe zeigt Ihnen dann Ihre Mitgliedschaft: Sie können sie kündigen, die Karte ändern, mit der sie bezahlt wird, oder Ihre Quittungen ansehen. Wenn Sie kündigen, läuft sie bis zum Ende des bereits bezahlten Zeitraums weiter, und es wird nichts mehr berechnet.",
  linkWorks:
    "Der Link funktioniert eine Stunde lang. Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail; es passiert nichts, solange der Link nicht verwendet wird.",
  linkFooter: (store) =>
    `Gesendet von Marktmorgen im Auftrag von ${store}. Die Mitgliedschaft wird von ${store} über das eigene Stripe-Konto berechnet.`,

  switchedSubject: (title) => `Sie haben zu ${title} gewechselt`,
  switchedNow: (store, title, from) => `Ihre Mitgliedschaft bei ${store} ist jetzt ${title}, anstelle von ${from}.`,
  paidTrial: "Sie sind in Ihrem kostenlosen Testzeitraum, daher wurde nichts berechnet. Der neue Preis gilt ab dem Ende des Testzeitraums.",
  paidCharged: (amount) => `Heute berechnet: ${amount}, der neue Preis abzüglich dessen, was von Ihrer letzten Zahlung übrig war.`,
  paidCredit: (amount) =>
    `Ein Guthaben von ${amount} für das, was von Ihrer letzten Zahlung übrig war, wird von Ihren nächsten Zahlungen abgezogen.`,
  paidNothing: "Heute wurde nichts berechnet.",
  fromNow: (price) => `Ab jetzt: ${price}.`,
  switchedOpen:
    "Was er umfasst, steht Ihnen jetzt offen. Ihre Quittungen finden Sie auf der Seite Ihrer Mitgliedschaft, über den Link auf der Seite des Shops.",
  switchedFooter: (store) =>
    `Berechnet von ${store} über das eigene Stripe-Konto. Fragen erreichen ${store}, wenn Sie auf diese E-Mail antworten.`,

  failedSubject: (store) => `Ihre Zahlung an ${store} ist nicht durchgegangen`,
  hi: "Hallo,",
  failedFor: (amount, title) =>
    `Die letzte Zahlung von ${amount} für ${title} ist nicht durchgegangen. Das passiert, wenn eine Karte abläuft, ersetzt wird oder von der Bank abgelehnt wird.`,
  failedTo: (amount, store) =>
    `Die letzte Zahlung von ${amount} an ${store} ist nicht durchgegangen. Das passiert, wenn eine Karte abläuft, ersetzt wird oder von der Bank abgelehnt wird.`,
  payHere: "Bezahlen Sie sie hier, mit derselben oder einer neuen Karte:",
  cardKept: "Die Karte, mit der Sie bezahlen, wird auch für Ihre nächsten Zahlungen verwendet, Sie müssen das also nur einmal tun.",
  triedAgainPlan: (date) => `Wenn Sie nichts tun, wird am ${date} erneut versucht, die hinterlegte Karte zu belasten.`,
  triedAgain: (date) =>
    `Wenn Sie nichts tun, wird am ${date} erneut versucht, die hinterlegte Karte zu belasten, und Ihr Zugang bleibt bis dahin bestehen.`,
  notTriedAgain:
    "Es wird kein weiterer Versuch unternommen, die hinterlegte Karte zu belasten, daher bleibt diese Zahlung offen, bis sie über den Link oben bezahlt wird.",
  receiptsPlan: (url) => `Um Ihre Quittungen zu sehen oder die Karte zu ändern: ${url}`,
  cancelInstead: (url) => `Um stattdessen zu kündigen oder Ihre Quittungen zu sehen: ${url}`,
  reminderSubject: (store) => `Erinnerung: Ihre Zahlung an ${store} ist noch nicht durchgegangen`,
  reminderLead: "Eine kurze Erinnerung, falls Sie die erste E-Mail übersehen haben.",
  cardName: (brand, last4) => `${brand} mit Endziffern ${last4}`,
  cardSubject: (store) => `Ihre Karte für ${store} läuft vor Ihrer nächsten Zahlung ab`,
  cardFor: (card, title, date) =>
    `Die Karte, mit der Sie ${title} bezahlen (${card}), läuft vor Ihrer nächsten Zahlung am ${date} ab.`,
  cardTo: (card, store, date) =>
    `Die Karte, mit der Sie ${store} bezahlen (${card}), läuft vor Ihrer nächsten Zahlung am ${date} ab.`,
  cardHere: "Fügen Sie Ihre neue Karte hier hinzu, damit diese Zahlung durchgeht:",
  cardHow: "Das dauert eine Minute auf der sicheren Seite von Stripe. Jetzt wird nichts abgebucht, und die neue Karte wird ab dann für diese Zahlungen verwendet.",
  cardBank: "Wenn Ihre Bank Ihnen schon eine neue Karte geschickt hat, übernimmt Stripe sie vielleicht von selbst; sie hier hinzuzufügen, stellt es sicher.",
  cardTitle: "Karte aktualisieren",
  cardHead: (title) => `Die Karte für ${title} aktualisieren`,
  cardHeadStore: (store) => `Die Karte aktualisieren, mit der Sie ${store} bezahlen`,
  cardIntro: "Jetzt wird nichts abgebucht. Die Karte, die Sie hinzufügen, wird ab dann für diese Zahlungen verwendet.",
  cardPayNow: "Ihre letzte Zahlung ist nicht durchgegangen, deshalb wird sie sofort von der neuen Karte abgebucht.",
  cardButton: "Neue Karte hinzufügen",
  cardNote: "Auf der eigenen sicheren Seite von Stripe. Der Shop sieht Ihre Kartennummer nie.",
  cardEnded: "Diese Mitgliedschaft ist beendet, deshalb gibt es keine Karte zu aktualisieren.",
  cardNotices: {
    updated: { title: "Ihre Karte ist aktualisiert", body: "Ihre nächsten Zahlungen laufen über die neue Karte." },
    paid: { title: "Ihre Karte ist aktualisiert und Ihre Zahlung ist durchgegangen", body: "Auch Ihre nächsten Zahlungen laufen über die neue Karte." },
    declined: {
      title: "Ihre neue Karte ist gespeichert, aber die Zahlung wurde abgelehnt",
      body: "Ihre nächsten Zahlungen laufen über die neue Karte. Stripe versucht die fehlgeschlagene erneut, oder Sie bezahlen sie über den Link in der E-Mail dazu.",
    },
    canceled: { title: "Es wurde nichts geändert", body: "Sie haben die Seite von Stripe verlassen, bevor eine Karte gespeichert war. Drücken Sie den Knopf, um es erneut zu versuchen." },
    expired: { title: "Dieser Link ist abgelaufen", body: "Fordern Sie auf der Seite Ihrer Mitgliedschaft einen Link an; von dort können Sie Ihre Karte ändern." },
    error: { title: "Bei uns ist etwas schiefgegangen", body: "Es wurde nichts geändert. Versuchen Sie es gleich noch einmal." },
  },
};

/** Italian elides "il" and "al" before the 8th and the 11th: "l'8 ottobre", "all'11 ottobre". */
const elides = (date: string) => /^(8|11)\b/.test(date);
const il = (date: string) => (elides(date) ? `l'${date}` : `il ${date}`);
const al = (date: string) => (elides(date) ? `all'${date}` : `al ${date}`);

const it: MembershipWords = {
  yourMembership: "Il tuo abbonamento",
  switchTitle: "Cambia il tuo abbonamento",
  endedTitle: "Il tuo abbonamento è terminato",
  nothingCharged: "Non è stato addebitato nulla",

  manageNotices: {
    email: {
      title: "Non sembra un indirizzo email",
      body: "Controllalo e riprova. Usa l'indirizzo con cui paghi: quello che hai inserito al momento dell'iscrizione.",
    },
    limited: {
      title: "Troppe richieste per ora",
      body: "Per evitare che questo modulo venga usato per intasare la casella di posta di qualcuno, accetta un numero limitato di richieste all'ora. Riprova tra un'ora.",
    },
    unavailable: {
      title: "Questo negozio non può aprire abbonamenti in questo momento",
      body: "I suoi pagamenti non sono collegati a Stripe in questo momento, quindi da questa pagina non c'è nessun abbonamento da aprire. Rispondi all'email di conferma del tuo ordine e arriverà al negozio.",
    },
    error: {
      title: "Qualcosa è andato storto da parte nostra",
      body: "Non è stato modificato nulla. Riprova tra un momento.",
    },
    unconfirmed: {
      title: "Non abbiamo potuto confermare il cambio",
      body: "La risposta di Stripe non diceva se è andato a buon fine. Guarda la tua iscrizione qui sotto prima di riprovare: mostra il piano che hai adesso.",
    },
    expired: {
      title: "Questo link è scaduto",
      body: "Un link al tuo abbonamento funziona per un'ora. Chiedine uno nuovo qui sotto; ci vogliono pochi secondi.",
    },
    used: {
      title: "Questo link è stato usato troppe volte",
      body: "Chiedine uno nuovo qui sotto; ci vogliono pochi secondi.",
    },
    switched: {
      title: "Il tuo abbonamento è stato cambiato",
      body: "Ciò che include il nuovo piano è già accessibile, e una ricevuta sta arrivando nella tua casella di posta.",
    },
    yearly: {
      title: "Ora paghi annualmente",
      body: "Ciò che include il tuo abbonamento resta uguale, e una ricevuta sta arrivando nella tua casella di posta.",
    },
    declined: {
      title: "La carta non è stata addebitata, quindi non è cambiato nulla",
      body: "La tua banca ha rifiutato il pagamento o ha chiesto un passaggio che non potevamo mostrare qui. Aggiorna la carta con “Cambia carta o vedi le ricevute” qui sotto, poi riprova il cambio.",
    },
    stale: {
      title: "Quel prezzo aveva più di 15 minuti",
      body: "Non è stato modificato nulla. Scegli di nuovo il piano per vedere il prezzo attuale.",
    },
    busy: {
      title: "Un cambio era già in corso",
      body: "Aspetta un momento e controlla il tuo abbonamento qui sotto prima di riprovare.",
    },
    currency: { title: "Questo abbonamento resta sul suo piano", body: "È pagato in una valuta diversa da quella dei piani attuali del negozio, quindi resta sul suo piano attuale. Non è stato modificato nulla, e puoi ancora annullarlo dalla pagina del tuo abbonamento." },
    "cannot-switch": {
      title: "Quel cambio non si può fare",
      body: "Il piano potrebbe non essere più offerto, oppure l'abbonamento potrebbe essere annullato o in attesa di un pagamento. Non è stato modificato nulla.",
    },
  },
  manageHead: "Gestisci o annulla il tuo abbonamento",
  manageIntro: (store) =>
    `Inserisci l'email con cui paghi ${store} e ti invieremo via email un link al tuo abbonamento. Nessun account e nessuna password: lo annulli in autonomia, direttamente sulla pagina di Stripe.`,
  manageUnavailable: (store) =>
    `${store} non può accettare pagamenti tramite Stripe in questo momento, quindi da qui non c'è nessun abbonamento da aprire. Rispondi all'email di conferma del tuo ordine e arriverà a ${store}.`,
  payEmailLabel: "L'email con cui paghi",
  emailMeLink: "Inviami un link al mio abbonamento",
  linkNote: (store, hours) =>
    `Se quell'indirizzo ha un abbonamento con ${store}, proviamo a inviare un link via email. Funziona per ${hours === 1 ? "un'ora" : `${hours} ore`}. Diciamo la stessa cosa in ogni caso, così nessuno può usare questa pagina per scoprire chi è membro.`,
  checkInbox: "Controlla la tua casella di posta",
  sentBody: (store) =>
    `Se quell'indirizzo ha un abbonamento con ${store}, il link è in arrivo. Lo invia ${store} tramite Marktmorgen. Se non c'è, guarda nella cartella spam.`,
  tryOther:
    "Non è arrivato nulla? Forse paghi con un altro indirizzo: quello che hai inserito al momento dell'iscrizione. Prova con quello qui sotto.",

  yourMemberships: "I tuoi abbonamenti",
  every: (interval, count) =>
    count === 1
      ? { day: "al giorno", week: "a settimana", month: "al mese", year: "all'anno" }[interval]
      : `ogni ${count} ${{ day: "giorni", week: "settimane", month: "mesi", year: "anni" }[interval]}`,
  ends: (date) => `Termina ${il(date)}`,
  cancel: "Annulla",
  switchPlan: "Cambia piano",
  switchCurrencyNote: "Questo abbonamento non può cambiare piano: è pagato in una valuta diversa da quella dei piani attuali del negozio.",
  upgrade: " · piano superiore",
  downgrade: " · piano inferiore",
  exactFirst: "Vedi l'importo esatto prima di qualsiasi addebito.",
  cannotList:
    "Stripe non è riuscito a elencare i tuoi abbonamenti in questo momento. Il pulsante qui sotto li apre tutti sulla pagina di Stripe, dove puoi annullarli.",
  changeCard: "Cambia carta o vedi le ricevute",
  openMembership: "Apri il mio abbonamento",
  pause: {
    button: "Metti in pausa invece",
    choose: "Metti in pausa per",
    months: (n) => (n === 1 ? "1 mese" : `${n} mesi`),
    confirm: "Metti in pausa il mio abbonamento",
    note: (date) =>
      `Ciò che hai già pagato resta aperto fino al ${date}. Poi non viene addebitato nulla e l'abbonamento resta chiuso durante la pausa; riparte da solo, con un pagamento, il giorno in cui la pausa finisce.`,
    pausedUntil: (date) => `In pausa fino al ${date}`,
    startsPause: (date, until) => `In pausa dal ${date}, di nuovo attivo il ${until}`,
    resume: "Riprendi ora",
    resumeNote: "Riprendendo, oggi viene addebitato un pagamento e l'abbonamento si riapre subito.",
    emailSubject: (title) => `Il tuo abbonamento ${title} è in pausa`,
    emailBody: (title, store, from, until) =>
      `${title}: ciò che hai già pagato resta aperto fino al ${from}. Da quel giorno al ${until} non viene addebitato nulla e l'abbonamento è in pausa. Il ${until} riparte da solo, con il pagamento di sempre.\n\nPer tornare prima, o per annullare, apri il tuo abbonamento dalla pagina di ${store}.`,
  },
  pauseNotices: {
    paused: { title: "Il tuo abbonamento è in pausa", body: "Ti arriva un'email con le date." },
    resumed: { title: "Il tuo abbonamento è di nuovo attivo", body: "Il pagamento è andato a buon fine, e tutto ciò che include è di nuovo aperto per te." },
    cannot: {
      title: "Questo abbonamento non può essere messo in pausa ora",
      body: "Non è stato cambiato nulla. Un abbonamento si può mettere in pausa una volta l'anno, se è pagato ogni mese e funziona normalmente.",
    },
    declined: {
      title: "La carta non è stata addebitata, quindi l'abbonamento resta in pausa",
      body: "Aggiorna la carta con il pulsante qui sotto, poi premi di nuovo Riprendi ora.",
    },
  } as Record<string, Notice>,
  cancelNote: "Se annulli, l'abbonamento resta attivo fino alla fine del periodo che hai già pagato, e non ti viene addebitato altro.",

  leaveTitle: "Prima di andare",
  leaveHead: (title) => `Annullare ${title}?`,
  leaveHeadPlain: "Annullare il tuo abbonamento?",
  leaveIntro: (store) =>
    `Se dici a ${store} perché, qui sotto potrebbe esserci una soluzione migliore per te. Rispondere è facoltativo: puoi annullare subito.`,
  leaveAsk: "Perché te ne vai?",
  leaveReasons: {
    too_expensive: "Costa troppo",
    unused: "Non lo uso abbastanza",
    missing_features: "Manca qualcosa che mi serve",
    switched_service: "Ora uso qualcos'altro",
    too_complex: "È troppo difficile da usare",
    low_quality: "La qualità non è sufficiente",
    customer_service: "Non ho ricevuto aiuto quando l'ho chiesto",
    other: "Un altro motivo",
  },
  leaveContinue: "Continua",
  leaveThanks: "Grazie per aver detto il motivo.",
  leaveCheaper: "Un piano che costa meno:",
  leavePause: "Oppure tieni il tuo posto e metti in pausa:",
  leavePauseOnly: "Tieni il tuo posto e metti in pausa:",
  leaveContact: (store) => `${store} vorrebbe saperlo. Scrivigli, e potrà rimediare:`,
  leaveWrite: (store) => `Scrivi a ${store}`,
  leaveStill: "Vuoi ancora andartene?",
  leaveCancel: "Annulla il mio abbonamento",
  leaveConfirm: "Si apre la pagina di Stripe, dove confermi.",
  leaveGone: "Questo abbonamento non può essere annullato da qui: è terminato, o la sua fine è già fissata.",

  nudgeSubject: (title) => `${title} è ancora qui per te`,
  nudgeLead: (title) =>
    `È passato un po' di tempo dalla tua ultima visita a ${title}. Tutto ciò che include è ancora lì per te, e puoi riprendere da dove avevi lasciato.`,
  nudgeCourse: "Apri il corso:",
  nudgeCommunity: "Entra nella community:",
  nudgeReply: (store) => `Se qualcosa te lo impedisce, rispondi a questa email e arriverà a ${store}.`,

  // ---- Pagare annualmente invece che mensilmente ---------------------------------------------
  payYearly: (yearly, saving) => `Paga annualmente: ${yearly}, risparmi ${saving}`,
  yearlyHead: (title) => `Paga ${title} annualmente`,
  yearlySaves: (amount) => `Risparmi ${amount} all'anno rispetto a dodici pagamenti mensili.`,
  yearlyDueNote: "Il prezzo dell'anno, meno ciò che resta del mese già pagato, sulla carta con cui paghi. Il prossimo pagamento sarà tra un anno.",
  yearlyTrialNote: "Sei nella prova gratuita. Ora non viene addebitato nulla; il prezzo annuale viene addebitato alla fine della prova.",
  yearlyHolds: (store) => `Questo prezzo vale per 15 minuti. Addebitato da ${store} sul proprio account Stripe. Ciò che include il tuo abbonamento resta uguale.`,
  yearlySubject: (title) => `Ora paghi ${title} annualmente`,
  yearlyNow: (store, title) => `Il tuo abbonamento ${title} con ${store} ora è pagato annualmente. Ciò che include resta uguale.`,
  yearlyPaidCharged: (amount) => `Addebitato oggi: ${amount}, l'anno meno ciò che restava del tuo ultimo pagamento mensile.`,
  yearlyPaidTrial: "Sei nella prova gratuita, quindi non è stato addebitato nulla. Il prezzo annuale viene addebitato alla fine della prova.",
  askSubject: (title, saving) => `${title}: paga annualmente e risparmia ${saving}`,
  askLead: (store, title, monthly, yearly, saving) =>
    `Paghi ${monthly} per ${title}. ${store} lo offre anche annualmente: ${yearly}. Sono ${saving} in meno di dodici pagamenti mensili, e ciò che include resta uguale.`,
  askSee: "Guarda esattamente quanto pagheresti oggi, prima che venga addebitato qualcosa:",
  askWorks: "Il link funziona per 14 giorni e apre solo questo cambio. Non cambia nulla finché non premi il pulsante su quella pagina.",
  askReply: (store) => `Domande? Rispondi a questa email e arriverà a ${store}.`,

  switchProblems: {
    expired: { title: "Questo link è scaduto", body: "Un link al tuo abbonamento funziona per un'ora. Chiedine uno nuovo dalla pagina del tuo abbonamento." },
    gone: {
      title: "Questo abbonamento non può cambiare piano",
      body: "Potrebbe essere annullato, impostato per terminare, in attesa di un pagamento o non più tuo con questo link. Non è stato modificato nulla.",
    },
    tier: {
      title: "Quel piano non è più offerto",
      body: "Torna alla pagina del tuo abbonamento per vedere i piani a cui puoi passare ora. Non è stato modificato nulla.",
    },
    currency: { title: "Questo abbonamento resta sul suo piano", body: "È pagato in una valuta diversa da quella dei piani attuali del negozio, quindi resta sul suo piano attuale. Non è stato modificato nulla, e puoi ancora annullarlo dalla pagina del tuo abbonamento." },
    error: { title: "Stripe non è riuscito a calcolare il prezzo in questo momento", body: "Non è stato modificato nulla. Riprova tra un momento." },
    yearly: { title: "Il pagamento annuale non è offerto per questo abbonamento", body: "Potrebbe essere già pagato annualmente, avere uno sconto, essere annullato o in attesa di un pagamento, oppure il prezzo annuale potrebbe essere cambiato. Non è stato cambiato nulla." },
    yearlyExpired: { title: "Questo link è scaduto", body: "Il link nell'email funziona per 14 giorni. Chiedi un link al tuo abbonamento sulla sua pagina; da lì puoi pagare annualmente." },
  },
  switchTo: (title) => `Passa a ${title}`,
  nowLabel: "Ora",
  afterLabel: "Dopo il cambio",
  nothingNow: "Ora non viene addebitato nulla",
  chargedToday: (amount) => `Addebito di oggi: ${amount}`,
  offNext: (amount) => `Da scalare dai tuoi prossimi pagamenti: ${amount}`,
  nothingToday: "Oggi non viene addebitato nulla",
  switchTrialNote: "Sei nella prova gratuita. Il nuovo piano si apre ora, e il suo prezzo parte alla fine della prova.",
  dueNote: "Il nuovo prezzo, meno ciò che restava del tuo ultimo pagamento, sulla carta con cui paghi. Il nuovo piano si apre appena è pagato.",
  creditNote: "Ciò che restava del tuo ultimo pagamento diventa un credito presso il negozio, scalato dai tuoi prossimi pagamenti. Il nuovo piano si apre ora.",
  opensNow: "Il nuovo piano si apre ora.",
  switchAndPay: (amount) => `Cambia e paga ${amount}`,
  switchNow: "Cambia ora",
  holdsNote: (store, title) =>
    `Questo prezzo è valido per 15 minuti. Addebitato da ${store} sul proprio conto Stripe. Tutto ciò che include solo ${title} si chiude quando cambi.`,
  backToMembership: "Torna al tuo abbonamento",

  offerNotices: {
    member: "Hai già un abbonamento a questo ancora attivo, quindi l'offerta non è stata usata. Non è stato addebitato nulla.",
    price: "Il negozio non offre più il prezzo a cui si riferiva questa offerta, quindi non può essere usata. Non è stato addebitato nulla.",
    expired: "Questa offerta è terminata. Puoi comunque tornare al prezzo normale qui sotto.",
    unavailable: "Questa offerta non può più essere usata per questo abbonamento. Puoi comunque tornare al prezzo normale qui sotto, se è offerto.",
    refused: "Non è stato possibile applicare l'offerta in questo momento. Puoi tornare al prezzo normale qui sotto, o rispondere all'email con cui è arrivata.",
    limited: "Troppi tentativi per ora. Aspetta qualche minuto e premi di nuovo il pulsante.",
  },
  membershipLabel: "Abbonamento",
  endedBody: (title) =>
    `Il tuo abbonamento a ${title} non è più attivo, quindi ciò a cui ti dava accesso ora è chiuso. Rinnovalo e tutto si riapre subito.`,
  endedClosed: (title) =>
    `Il tuo abbonamento a ${title} non è più attivo, quindi ciò a cui ti dava accesso ora è chiuso.`,
  endedGone: (store) => `Questo abbonamento non è più attivo, e ${store} non lo offre più.`,
  comeBackOffer: "La tua offerta per tornare",
  offerWords: (percent, months) =>
    months === 1 ? `${percent}${S}% di sconto sul tuo primo pagamento` : `${percent}${S}% di sconto sui tuoi primi ${months} pagamenti`,
  offerFor: (email, until) =>
    `Per ${email}, fino ${al(until)}. Applicata sulla pagina di Stripe prima di pagare; questa volta senza prova gratuita.`,
  comeBackWith: "Torna con questa offerta",
  renewTitle: (title) => `Rinnova ${title}`,
  renewPrice: (price) => `Rinnova · ${price}`,
  renew: "Rinnova",
  notTaking: (store) =>
    `${store} non accetta nuovi membri per questo al momento. Rispondi all'email di conferma del tuo ordine e arriverà a ${store}.`,
  see: (title) => `Vedi ${title}`,
  seePrices: (title) => `Vedi i prezzi di oggi per ${title}`,
  failedBefore:
    "È terminato perché un pagamento non è andato a buon fine, e non perché hai annullato? Aggiornare la carta può riattivarlo senza rinnovarlo: ",
  failedLink: "gestisci il tuo abbonamento",
  failedAfter: " con l'email con cui hai pagato.",
  boughtBefore: "Ciò che hai acquistato a parte resta tuo: ",
  boughtLink: "recupera i tuoi acquisti",
  boughtAfter: ".",

  leftNotices: {
    email: {
      title: "Non sembra un indirizzo email",
      body: "Controllalo e riprova. Il promemoria va all'indirizzo che inserisci, quindi deve essere uno che puoi aprire.",
    },
    limited: {
      title: "Troppi promemoria richiesti in questo momento",
      body: "Per evitare che questo modulo venga usato per riempire la casella di posta di qualcuno, ne accetta un numero limitato all'ora. Non è stato salvato nulla. Il prodotto è sempre qui, quando lo vuoi.",
    },
    closed: {
      title: "Non si può inviare un promemoria per questo",
      body: "Potrebbe essere esaurito o non più in vendita. Non è stato salvato nulla.",
    },
    error: {
      title: "Non siamo riusciti a salvarlo in questo momento",
      body: "Non è stato salvato nulla. Riprova tra un momento.",
    },
  },
  done: "Fatto",
  oneReminder: "Un promemoria, tra circa un'ora",
  willEmail: (store, title) =>
    `${store} ti scriverà una sola volta, con il link a ${title}. Se lo acquisti prima, non viene inviato nessun promemoria.`,
  onlyEmail:
    "È l'unica email che viene inviata. Non ti aggiunge a nessuna lista, e contiene un link che interrompe per sempre i promemoria di questo negozio.",
  leftBefore: (title) => `Hai lasciato la pagina prima di pagare ${title}`,
  notCharged: "La tua carta non è stata addebitata. Se lo vuoi ancora, è a un clic di distanza.",
  notReady: "Non hai ancora deciso?",
  remindNote: (store) =>
    `Lascia la tua email e ${store} ti invia un promemoria con il link, tra circa un'ora. Una sola email. Non ti aggiunge a nessuna lista.`,
  remindMe: "Ricordamelo una volta",
  addressUse: (store) =>
    `Il tuo indirizzo viene usato per questo unico promemoria e per il link che contiene per interrompere i promemoria di ${store}, e per nient'altro.`,
  // ---- A reminder asked for on a product's page (lib/ask-when.ts) -------------------------------
  askWhen: "Quando",
  askTimes: { hour: "Tra circa un'ora", day: "Domani", days: "Tra tre giorni" },
  pageRemindNote: (store) =>
    `Lascia la tua email e ${store} ti invia un solo promemoria con il link, quando scegli tu. Una sola email. Non ti aggiunge a nessuna lista.`,
  /** When the reminder goes, as said in the middle of a sentence (pageAsked). */
  askSaid: { hour: "tra circa un'ora", day: "domani", days: "tra tre giorni" },
  pageAsked: (store, title, when) => `${store} ti invierà una sola email con il link a ${title} ${when}. Se lo acquisti prima, non viene inviato nessun promemoria.`,

  fromName: (store) => `${store} tramite Marktmorgen`,
  membershipWith: (store) => `Il tuo abbonamento con ${store}`,
  linkIntro: (store) => `Hai chiesto di gestire il tuo abbonamento con ${store}. Ecco il link per accedere:`,
  linkTiers:
    "Apri il link per vedere il tuo abbonamento. Da lì puoi passare a un altro piano, vedendo l'importo esatto prima di qualsiasi addebito, oppure annullarlo, cambiare la carta con cui lo paghi o vedere le tue ricevute. Se annulli, resta attivo fino alla fine del periodo che hai già pagato, e non ti viene addebitato altro.",
  linkNoTiers:
    "Apri il link e premi il pulsante. Stripe ti mostra allora il tuo abbonamento: puoi annullarlo, cambiare la carta con cui lo paghi o vedere le tue ricevute. Se annulli, resta attivo fino alla fine del periodo che hai già pagato, e non ti viene addebitato altro.",
  linkWorks: "Il link funziona per un'ora. Se non l'hai chiesto tu, ignora questa email; non succede nulla se il link non viene usato.",
  linkFooter: (store) =>
    `Inviata da Marktmorgen per conto di ${store}. L'abbonamento è addebitato da ${store} sul proprio conto Stripe.`,

  switchedSubject: (title) => `Il tuo abbonamento è passato a ${title}`,
  switchedNow: (store, title, from) => `Il tuo abbonamento con ${store} ora è ${title}, al posto di ${from}.`,
  paidTrial: "Sei nella prova gratuita, quindi non è stato addebitato nulla. Il nuovo prezzo parte alla fine della prova.",
  paidCharged: (amount) => `Addebitato oggi: ${amount}, il nuovo prezzo meno ciò che restava del tuo ultimo pagamento.`,
  paidCredit: (amount) =>
    `Un credito di ${amount}, per ciò che restava del tuo ultimo pagamento, viene scalato dai tuoi prossimi pagamenti.`,
  paidNothing: "Oggi non è stato addebitato nulla.",
  fromNow: (price) => `D'ora in poi: ${price}.`,
  switchedOpen:
    "Ciò che include è già accessibile. Le tue ricevute sono nella pagina del tuo abbonamento, dal link sulla pagina del negozio.",
  switchedFooter: (store) =>
    `Addebitato da ${store} sul proprio conto Stripe. Per domande, rispondi a questa email e arriveranno a ${store}.`,

  failedSubject: (store) => `Il tuo pagamento a ${store} non è andato a buon fine`,
  hi: "Ciao,",
  failedFor: (amount, title) =>
    `L'ultimo pagamento di ${amount} per ${title} non è andato a buon fine. Succede quando una carta scade, viene sostituita o viene rifiutata dalla banca.`,
  failedTo: (amount, store) =>
    `L'ultimo pagamento di ${amount} a ${store} non è andato a buon fine. Succede quando una carta scade, viene sostituita o viene rifiutata dalla banca.`,
  payHere: "Pagalo qui, con la stessa carta o con una nuova:",
  cardKept: "La carta con cui paghi viene usata anche per i tuoi prossimi pagamenti, quindi basta farlo una volta.",
  triedAgainPlan: (date) => `Se non fai nulla, l'addebito sulla carta registrata verrà ritentato ${il(date)}.`,
  triedAgain: (date) =>
    `Se non fai nulla, l'addebito sulla carta registrata verrà ritentato ${il(date)}, e nel frattempo il tuo accesso resta attivo.`,
  notTriedAgain:
    "L'addebito sulla carta registrata non verrà ritentato, quindi questo pagamento resta in sospeso finché non viene saldato dal link qui sopra.",
  receiptsPlan: (url) => `Per vedere le tue ricevute o cambiare la carta: ${url}`,
  cancelInstead: (url) => `Se preferisci annullare, o vedere le tue ricevute: ${url}`,
  reminderSubject: (store) => `Promemoria: il tuo pagamento a ${store} non è ancora andato a buon fine`,
  reminderLead: "Un breve promemoria, nel caso ti fosse sfuggita la prima email.",
  cardName: (brand, last4) => `${brand} che termina con ${last4}`,
  cardSubject: (store) => `La tua carta per ${store} scade prima del prossimo pagamento`,
  cardFor: (card, title, date) =>
    `La carta con cui paghi ${title}, ${card}, scade prima del tuo prossimo pagamento, ${il(date)}.`,
  cardTo: (card, store, date) =>
    `La carta con cui paghi ${store}, ${card}, scade prima del tuo prossimo pagamento, ${il(date)}.`,
  cardHere: "Aggiungi qui la tua nuova carta, così quel pagamento va a buon fine:",
  cardHow: "Basta un minuto sulla pagina sicura di Stripe. Ora non viene addebitato nulla, e da quel momento la nuova carta viene usata per questi pagamenti.",
  cardBank: "Se la tua banca ti ha già inviato una nuova carta, Stripe potrebbe riceverla da sé; aggiungerla qui ti dà la certezza.",
  cardTitle: "Aggiorna la tua carta",
  cardHead: (title) => `Aggiorna la carta per ${title}`,
  cardHeadStore: (store) => `Aggiorna la carta con cui paghi ${store}`,
  cardIntro: "Ora non viene addebitato nulla. La carta che aggiungi viene usata per questi pagamenti da quel momento.",
  cardPayNow: "Il tuo ultimo pagamento non è andato a buon fine, quindi viene addebitato subito sulla nuova carta.",
  cardButton: "Aggiungi una nuova carta",
  cardNote: "Sulla pagina sicura di Stripe. Il negozio non vede mai il numero della tua carta.",
  cardEnded: "Questo abbonamento è terminato, quindi non c'è nessuna carta da aggiornare.",
  cardNotices: {
    updated: { title: "La tua carta è aggiornata", body: "I tuoi prossimi pagamenti usano la nuova carta." },
    paid: { title: "La tua carta è aggiornata e il pagamento è andato a buon fine", body: "Anche i tuoi prossimi pagamenti usano la nuova carta." },
    declined: {
      title: "La tua nuova carta è salvata, ma il pagamento è stato rifiutato",
      body: "I tuoi prossimi pagamenti usano la nuova carta. Stripe riprova quello non riuscito, oppure puoi pagarlo dal link nell'email che te lo segnalava.",
    },
    canceled: { title: "Non è cambiato nulla", body: "Hai lasciato la pagina di Stripe prima di salvare una carta. Premi il pulsante per riprovare." },
    expired: { title: "Questo link è scaduto", body: "Chiedi un link al tuo abbonamento dalla sua pagina; da lì puoi cambiare la carta." },
    error: { title: "Qualcosa è andato storto da parte nostra", body: "Non è cambiato nulla. Riprova tra un momento." },
  },
};

const nl: MembershipWords = {
  yourMembership: "Je lidmaatschap",
  switchTitle: "Je lidmaatschap wijzigen",
  endedTitle: "Je lidmaatschap is beëindigd",
  nothingCharged: "Er is niets afgeschreven",

  manageNotices: {
    email: {
      title: "Dat lijkt geen e-mailadres",
      body: "Controleer het en probeer het opnieuw. Gebruik het adres waarmee je betaalt: het adres dat je invulde toen je lid werd.",
    },
    limited: {
      title: "Even te veel aanvragen",
      body: "Om te voorkomen dat dit formulier wordt gebruikt om iemands inbox te overspoelen, neemt het maar een beperkt aantal aanvragen per uur aan. Probeer het over een uur opnieuw.",
    },
    unavailable: {
      title: "Deze winkel kan nu geen lidmaatschappen openen",
      body: "De betalingen zijn nu niet aan Stripe gekoppeld, dus er is via deze pagina geen lidmaatschap te openen. Beantwoord de bevestigingsmail van je bestelling, dan komt je bericht bij de winkel aan.",
    },
    error: {
      title: "Er ging bij ons iets mis",
      body: "Er is niets gewijzigd. Probeer het zo opnieuw.",
    },
    unconfirmed: {
      title: "We konden de wissel niet bevestigen",
      body: "Het antwoord van Stripe zei niet of die gelukt is. Kijk hieronder naar je lidmaatschap voordat je het opnieuw probeert: daar staat het abonnement dat je nu hebt.",
    },
    expired: {
      title: "Deze link is verlopen",
      body: "Een link naar je lidmaatschap werkt een uur. Vraag hieronder een nieuwe aan; dat duurt een paar seconden.",
    },
    used: {
      title: "Deze link is te vaak gebruikt",
      body: "Vraag hieronder een nieuwe aan; dat duurt een paar seconden.",
    },
    switched: {
      title: "Je lidmaatschap is gewijzigd",
      body: "Wat het nieuwe abonnement omvat, staat nu voor je open, en er is een ontvangstbewijs onderweg naar je inbox.",
    },
    yearly: {
      title: "Je betaalt nu per jaar",
      body: "Wat je lidmaatschap omvat, blijft hetzelfde, en er is een ontvangstbewijs onderweg naar je inbox.",
    },
    declined: {
      title: "De kaart is niet belast, dus er is niets veranderd",
      body: "Je bank heeft de betaling geweigerd of vroeg om een stap die we hier niet konden tonen. Werk je kaart bij via “Kaart wijzigen of ontvangstbewijzen bekijken” hieronder en probeer de overstap daarna opnieuw.",
    },
    stale: {
      title: "Die prijs was meer dan 15 minuten oud",
      body: "Er is niets gewijzigd. Kies het abonnement opnieuw om de prijs van dit moment te zien.",
    },
    busy: {
      title: "Er liep al een overstap",
      body: "Wacht even en bekijk hieronder je lidmaatschap voordat je het opnieuw probeert.",
    },
    currency: { title: "Dit lidmaatschap blijft bij zijn abonnement", body: "Het wordt betaald in een andere valuta dan die van de huidige abonnementen van de winkel, dus het blijft bij zijn huidige abonnement. Er is niets gewijzigd, en je kunt het nog steeds opzeggen op de pagina van je lidmaatschap." },
    "cannot-switch": {
      title: "Die overstap kan niet",
      body: "Het abonnement wordt misschien niet meer aangeboden, of het lidmaatschap is misschien opgezegd of wacht op een betaling. Er is niets gewijzigd.",
    },
  },
  manageHead: "Je lidmaatschap beheren of opzeggen",
  manageIntro: (store) =>
    `Vul het e-mailadres in waarmee je bij ${store} betaalt, dan mailen we je een link naar je lidmaatschap. Geen account en geen wachtwoord: je zegt het zelf op, op de pagina van Stripe zelf.`,
  manageUnavailable: (store) =>
    `${store} kan nu geen betalingen via Stripe ontvangen, dus er is hier geen lidmaatschap te openen. Beantwoord de bevestigingsmail van je bestelling, dan komt je bericht bij ${store} aan.`,
  payEmailLabel: "Het e-mailadres waarmee je betaalt",
  emailMeLink: "Mail me een link naar mijn lidmaatschap",
  linkNote: (store, hours) =>
    `Als dat adres een lidmaatschap bij ${store} heeft, proberen we er per e-mail een link naartoe te sturen. Die werkt ${hours === 1 ? "een uur" : `${hours} uur`}. We zeggen hetzelfde, of dat nu zo is of niet, zodat niemand via deze pagina kan uitzoeken wie lid is.`,
  checkInbox: "Kijk in je inbox",
  sentBody: (store) =>
    `Als dat adres een lidmaatschap bij ${store} heeft, is de link onderweg. Hij komt van ${store} via Marktmorgen. Staat hij er niet, kijk dan in je spam.`,
  tryOther: "Niets ontvangen? Misschien betaal je met een ander adres: het adres dat je invulde toen je lid werd. Probeer dat hieronder.",

  yourMemberships: "Je lidmaatschappen",
  every: (interval, count) =>
    count === 1
      ? { day: "per dag", week: "per week", month: "per maand", year: "per jaar" }[interval]
      : `elke ${count} ${{ day: "dagen", week: "weken", month: "maanden", year: "jaar" }[interval]}`,
  ends: (date) => `Eindigt op ${date}`,
  cancel: "Opzeggen",
  switchPlan: "Abonnement wijzigen",
  switchCurrencyNote: "Bij dit lidmaatschap kun je niet van abonnement wisselen: het wordt betaald in een andere valuta dan die van de huidige abonnementen van de winkel.",
  upgrade: " · hoger abonnement",
  downgrade: " · lager abonnement",
  exactFirst: "Je ziet het precieze bedrag voordat er iets wordt afgeschreven.",
  cannotList:
    "Stripe kon je lidmaatschappen nu niet tonen. De knop hieronder opent ze allemaal op de pagina van Stripe zelf, waar je kunt opzeggen.",
  changeCard: "Kaart wijzigen of ontvangstbewijzen bekijken",
  openMembership: "Mijn lidmaatschap openen",
  pause: {
    button: "Liever pauzeren",
    choose: "Pauzeren voor",
    months: (n) => (n === 1 ? "1 maand" : `${n} maanden`),
    confirm: "Mijn lidmaatschap pauzeren",
    note: (date) =>
      `Wat je hebt betaald, blijft open tot ${date}. Daarna wordt er niets afgeschreven en is het lidmaatschap dicht zolang het gepauzeerd is; het start vanzelf weer, met een betaling, op de dag dat de pauze eindigt.`,
    pausedUntil: (date) => `Gepauzeerd tot ${date}`,
    startsPause: (date, until) => `Pauzeert op ${date}, terug op ${until}`,
    resume: "Nu hervatten",
    resumeNote: "Hervatten schrijft vandaag een betaling af, en het lidmaatschap is meteen weer open.",
    emailSubject: (title) => `Je lidmaatschap ${title} is gepauzeerd`,
    emailBody: (title, store, from, until) =>
      `${title}: wat je hebt betaald, blijft open tot ${from}. Van dan tot ${until} wordt er niets afgeschreven en is het lidmaatschap gepauzeerd. Op ${until} start het vanzelf weer, met de gewone betaling.\n\nOm eerder terug te komen, of om op te zeggen, open je je lidmaatschap via de pagina van ${store}.`,
  },
  pauseNotices: {
    paused: { title: "Je lidmaatschap is gepauzeerd", body: "Er is een e-mail met de data onderweg." },
    resumed: { title: "Je lidmaatschap loopt weer", body: "De betaling is gelukt, en alles wat erbij hoort is weer open voor je." },
    cannot: {
      title: "Dat lidmaatschap kan nu niet worden gepauzeerd",
      body: "Er is niets veranderd. Een lidmaatschap kan één keer per jaar worden gepauzeerd, als het per maand wordt betaald en gewoon loopt.",
    },
    declined: {
      title: "De kaart is niet belast, dus het lidmaatschap blijft gepauzeerd",
      body: "Werk je kaart bij met de knop hieronder en druk dan opnieuw op Nu hervatten.",
    },
  } as Record<string, Notice>,
  cancelNote: "Als je opzegt, loopt het lidmaatschap door tot het einde van de periode die je al hebt betaald, en wordt er niets meer afgeschreven.",

  leaveTitle: "Voordat je gaat",
  leaveHead: (title) => `${title} opzeggen?`,
  leaveHeadPlain: "Je lidmaatschap opzeggen?",
  leaveIntro: (store) =>
    `Als je ${store} vertelt waarom, staat er hieronder misschien een betere oplossing voor je. Antwoorden hoeft niet: je kunt meteen opzeggen.`,
  leaveAsk: "Waarom ga je weg?",
  leaveReasons: {
    too_expensive: "Het kost te veel",
    unused: "Ik gebruik het te weinig",
    missing_features: "Er mist iets wat ik nodig heb",
    switched_service: "Ik ben overgestapt op iets anders",
    too_complex: "Het is te moeilijk in gebruik",
    low_quality: "De kwaliteit is niet goed genoeg",
    customer_service: "Ik werd niet geholpen toen ik het vroeg",
    other: "Een andere reden",
  },
  leaveContinue: "Verder",
  leaveThanks: "Bedankt dat je de reden geeft.",
  leaveCheaper: "Een abonnement dat minder kost:",
  leavePause: "Of houd je plek en pauzeer in plaats daarvan:",
  leavePauseOnly: "Houd je plek en pauzeer in plaats daarvan:",
  leaveContact: (store) => `${store} wil het graag weten. Schrijf ze, dan kunnen ze het oplossen:`,
  leaveWrite: (store) => `Schrijf ${store}`,
  leaveStill: "Wil je toch weg?",
  leaveCancel: "Mijn lidmaatschap opzeggen",
  leaveConfirm: "De pagina van Stripe opent, waar je het bevestigt.",
  leaveGone: "Dit lidmaatschap kan hier niet worden opgezegd: het is beëindigd, of het einde staat al vast.",

  nudgeSubject: (title) => `${title} is er nog steeds voor je`,
  nudgeLead: (title) =>
    `Het is een tijd geleden dat je terugkwam bij ${title}. Alles wat erbij hoort, is er nog voor je, en je kunt verdergaan waar je was gebleven.`,
  nudgeCourse: "Open de cursus:",
  nudgeCommunity: "Kom naar de community:",
  nudgeReply: (store) => `Als er iets in de weg zit, beantwoord deze e-mail en het komt bij ${store}.`,

  // ---- Per jaar betalen in plaats van per maand -----------------------------------------------
  payYearly: (yearly, saving) => `Betaal per jaar: ${yearly}, je bespaart ${saving}`,
  yearlyHead: (title) => `Betaal ${title} per jaar`,
  yearlySaves: (amount) => `Je bespaart ${amount} per jaar ten opzichte van twaalf maandbetalingen.`,
  yearlyDueNote: "De jaarprijs, min wat er over is van de maand die je al betaalde, van de kaart waarmee je betaalt. Je volgende betaling is over een jaar.",
  yearlyTrialNote: "Je zit in je gratis proefperiode. Er wordt nu niets afgeschreven; de jaarprijs wordt afgeschreven wanneer de proefperiode eindigt.",
  yearlyHolds: (store) => `Deze prijs geldt 15 minuten. Afgeschreven door ${store} via hun eigen Stripe-account. Wat je lidmaatschap omvat, blijft hetzelfde.`,
  yearlySubject: (title) => `Je betaalt ${title} nu per jaar`,
  yearlyNow: (store, title) => `Je lidmaatschap ${title} bij ${store} wordt nu per jaar betaald. Wat het omvat, blijft hetzelfde.`,
  yearlyPaidCharged: (amount) => `Vandaag afgeschreven: ${amount}, het jaar min wat er over was van je laatste maandbetaling.`,
  yearlyPaidTrial: "Je zit in je gratis proefperiode, dus er is niets afgeschreven. De jaarprijs wordt afgeschreven wanneer de proefperiode eindigt.",
  askSubject: (title, saving) => `${title}: betaal per jaar en bespaar ${saving}`,
  askLead: (store, title, monthly, yearly, saving) =>
    `Je betaalt ${monthly} voor ${title}. ${store} biedt het ook per jaar aan: ${yearly}. Dat is ${saving} minder dan twaalf maandbetalingen, en wat het omvat, blijft hetzelfde.`,
  askSee: "Zie precies wat je vandaag zou betalen, voordat er iets wordt afgeschreven:",
  askWorks: "De link werkt 14 dagen en opent alleen deze wijziging. Er verandert niets tenzij je op de knop op die pagina drukt.",
  askReply: (store) => `Vragen? Beantwoord deze e-mail en het komt bij ${store}.`,

  switchProblems: {
    expired: { title: "Deze link is verlopen", body: "Een link naar je lidmaatschap werkt een uur. Vraag een nieuwe aan op de pagina van je lidmaatschap." },
    gone: {
      title: "Dit lidmaatschap kan niet overstappen",
      body: "Het is misschien opgezegd, ingesteld om te stoppen, wacht op een betaling, of is via deze link niet meer van jou. Er is niets gewijzigd.",
    },
    tier: {
      title: "Dat abonnement wordt niet meer aangeboden",
      body: "Ga terug naar de pagina van je lidmaatschap om te zien naar welke abonnementen je nu kunt overstappen. Er is niets gewijzigd.",
    },
    currency: { title: "Dit lidmaatschap blijft bij zijn abonnement", body: "Het wordt betaald in een andere valuta dan die van de huidige abonnementen van de winkel, dus het blijft bij zijn huidige abonnement. Er is niets gewijzigd, en je kunt het nog steeds opzeggen op de pagina van je lidmaatschap." },
    error: { title: "Stripe kon de prijs nu niet berekenen", body: "Er is niets gewijzigd. Probeer het zo opnieuw." },
    yearly: { title: "Per jaar betalen kan niet voor dit lidmaatschap", body: "Misschien wordt het al per jaar betaald, heeft het een korting, is het opgezegd of wacht het op een betaling, of is de jaarprijs veranderd. Er is niets gewijzigd." },
    yearlyExpired: { title: "Deze link is verlopen", body: "De link in de e-mail werkt 14 dagen. Vraag op de pagina van je lidmaatschap een link aan; van daaruit kun je per jaar betalen." },
  },
  switchTo: (title) => `Overstappen naar ${title}`,
  nowLabel: "Nu",
  afterLabel: "Na de overstap",
  nothingNow: "Er wordt nu niets afgeschreven",
  chargedToday: (amount) => `Vandaag afgeschreven: ${amount}`,
  offNext: (amount) => `Gaat af van je volgende betalingen: ${amount}`,
  nothingToday: "Er wordt vandaag niets afgeschreven",
  switchTrialNote: "Je zit in je gratis proefperiode. Het nieuwe abonnement gaat nu open, en de prijs ervan gaat in wanneer de proefperiode eindigt.",
  dueNote: "De nieuwe prijs, min wat er over was van je laatste betaling, van de kaart waarmee je betaalt. Het nieuwe abonnement gaat open zodra het betaald is.",
  creditNote: "Wat er over was van je laatste betaling, wordt tegoed bij de winkel dat van je volgende betalingen afgaat. Het nieuwe abonnement gaat nu open.",
  opensNow: "Het nieuwe abonnement gaat nu open.",
  switchAndPay: (amount) => `Overstappen en ${amount} betalen`,
  switchNow: "Nu overstappen",
  holdsNote: (store, title) =>
    `Deze prijs geldt 15 minuten. Afgeschreven door ${store} via de eigen Stripe-rekening. Alles wat alleen ${title} omvat, sluit wanneer je overstapt.`,
  backToMembership: "Terug naar je lidmaatschap",

  offerNotices: {
    member: "Je hebt hier al een lidmaatschap voor dat nog loopt, dus het aanbod is niet gebruikt. Er is niets afgeschreven.",
    price: "De winkel biedt de prijs waarvoor dit aanbod gold niet meer aan, dus het kan niet worden gebruikt. Er is niets afgeschreven.",
    expired: "Dit aanbod is afgelopen. Je kunt hieronder nog steeds terugkomen tegen de gewone prijs.",
    unavailable: "Dit aanbod kan niet meer voor dit lidmaatschap worden gebruikt. Je kunt hieronder nog steeds terugkomen tegen de gewone prijs, als die wordt aangeboden.",
    refused: "Het aanbod kon nu niet worden toegepast. Je kunt hieronder terugkomen tegen de gewone prijs, of de e-mail beantwoorden waarin het kwam.",
    limited: "Even te veel pogingen. Wacht een paar minuten en druk dan opnieuw op de knop.",
  },
  membershipLabel: "Lidmaatschap",
  endedBody: (title) =>
    `Je lidmaatschap voor ${title} loopt niet meer, dus waar het je toegang toe gaf, is nu gesloten. Verleng het en alles gaat meteen weer open.`,
  endedClosed: (title) =>
    `Je lidmaatschap voor ${title} loopt niet meer, dus waar het je toegang toe gaf, is nu gesloten.`,
  endedGone: (store) => `Dit lidmaatschap loopt niet meer, en ${store} biedt het niet meer aan.`,
  comeBackOffer: "Je aanbod om terug te komen",
  offerWords: (percent, months) =>
    months === 1 ? `${percent}${S}% korting op je eerste betaling` : `${percent}${S}% korting op je eerste ${months} betalingen`,
  offerFor: (email, until) =>
    `Voor ${email}, tot ${until}. Wordt op de pagina van Stripe toegepast voordat je betaalt; deze keer zonder gratis proefperiode.`,
  comeBackWith: "Terugkomen met dit aanbod",
  renewTitle: (title) => `${title} verlengen`,
  renewPrice: (price) => `Verlengen · ${price}`,
  renew: "Verlengen",
  notTaking: (store) =>
    `${store} neemt hiervoor op dit moment geen nieuwe leden aan. Beantwoord de bevestigingsmail van je bestelling, dan komt je bericht bij ${store} aan.`,
  see: (title) => `${title} bekijken`,
  seePrices: (title) => `Bekijk de prijzen van vandaag voor ${title}`,
  failedBefore: "Is het gestopt omdat een betaling mislukte, en niet omdat je opzegde? Je kaart bijwerken kan het terugbrengen zonder te verlengen: ",
  failedLink: "beheer je lidmaatschap",
  failedAfter: " met het e-mailadres waarmee je betaalde.",
  boughtBefore: "Wat je los hebt gekocht, blijft van jou: ",
  boughtLink: "haal je aankopen opnieuw op",
  boughtAfter: ".",

  leftNotices: {
    email: {
      title: "Dat lijkt geen e-mailadres",
      body: "Controleer het en probeer het opnieuw. De herinnering gaat naar het adres dat je invult, dus het moet een adres zijn dat je kunt openen.",
    },
    limited: {
      title: "Net te veel herinneringen aangevraagd",
      body: "Om te voorkomen dat dit formulier wordt gebruikt om iemands inbox te vullen, neemt het er maar een beperkt aantal per uur aan. Er is niets bewaard. Het product staat hier nog wanneer je het wilt.",
    },
    closed: {
      title: "Hiervoor kan geen herinnering worden gestuurd",
      body: "Het is misschien uitverkocht of uit de verkoop gehaald. Er is niets bewaard.",
    },
    error: {
      title: "We konden dat nu niet bewaren",
      body: "Er is niets bewaard. Probeer het zo opnieuw.",
    },
  },
  done: "Klaar",
  oneReminder: "Eén herinnering, over ongeveer een uur",
  willEmail: (store, title) =>
    `${store} mailt je één keer, met de link naar ${title}. Koop je het voor die tijd, dan wordt er geen herinnering gestuurd.`,
  onlyEmail:
    "Dat is de enige e-mail die dit verstuurt. Je wordt aan geen enkele lijst toegevoegd, en er staat een link in waarmee je herinneringen van deze winkel voorgoed stopt.",
  leftBefore: (title) => `Je ging weg voordat je ${title} had betaald`,
  notCharged: "Je kaart is niet belast. Wil je het nog steeds, dan is het één klik verwijderd.",
  notReady: "Nog niet zover?",
  remindNote: (store) =>
    `Laat je e-mailadres achter en ${store} stuurt je over ongeveer een uur één herinnering met de link. Eén e-mail. Je wordt aan geen enkele lijst toegevoegd.`,
  remindMe: "Herinner me één keer",
  addressUse: (store) =>
    `Je adres wordt gebruikt voor deze ene herinnering en voor de link erin waarmee je herinneringen van ${store} stopt, en voor niets anders.`,
  // ---- A reminder asked for on a product's page (lib/ask-when.ts) -------------------------------
  askWhen: "Wanneer",
  askTimes: { hour: "Over ongeveer een uur", day: "Morgen", days: "Over drie dagen" },
  pageRemindNote: (store) =>
    `Laat je e-mailadres achter en ${store} stuurt je één herinnering met de link, wanneer jij kiest. Eén e-mail. Je komt op geen enkele lijst.`,
  /** When the reminder goes, as said in the middle of a sentence (pageAsked). */
  askSaid: { hour: "over ongeveer een uur", day: "morgen", days: "over drie dagen" },
  pageAsked: (store, title, when) => `${store} stuurt je ${when} één e-mail met de link naar ${title}. Koop je het eerder, dan wordt er geen herinnering gestuurd.`,

  fromName: (store) => `${store} via Marktmorgen`,
  membershipWith: (store) => `Je lidmaatschap bij ${store}`,
  linkIntro: (store) => `Je vroeg om je lidmaatschap bij ${store} te beheren. Hier is de link om binnen te komen:`,
  linkTiers:
    "Open de link om je lidmaatschap te zien. Daar kun je overstappen naar een ander abonnement, waarbij je het precieze bedrag ziet voordat er iets wordt afgeschreven, of het opzeggen, de kaart wijzigen waarmee je betaalt, of je ontvangstbewijzen bekijken. Als je opzegt, loopt het door tot het einde van de periode die je al hebt betaald, en wordt er niets meer afgeschreven.",
  linkNoTiers:
    "Open de link en druk op de knop. Stripe toont je dan je lidmaatschap: je kunt het opzeggen, de kaart wijzigen waarmee je betaalt, of je ontvangstbewijzen bekijken. Als je opzegt, loopt het door tot het einde van de periode die je al hebt betaald, en wordt er niets meer afgeschreven.",
  linkWorks: "De link werkt een uur. Heb je hier niet om gevraagd, negeer deze e-mail dan; er gebeurt niets zolang de link niet wordt gebruikt.",
  linkFooter: (store) =>
    `Verstuurd door Marktmorgen namens ${store}. Het lidmaatschap wordt door ${store} afgeschreven via de eigen Stripe-rekening.`,

  switchedSubject: (title) => `Je bent overgestapt naar ${title}`,
  switchedNow: (store, title, from) => `Je lidmaatschap bij ${store} is nu ${title}, in plaats van ${from}.`,
  paidTrial: "Je zit in je gratis proefperiode, dus er is niets afgeschreven. De nieuwe prijs gaat in wanneer de proefperiode eindigt.",
  paidCharged: (amount) => `Vandaag afgeschreven: ${amount}, de nieuwe prijs min wat er over was van je laatste betaling.`,
  paidCredit: (amount) => `Een tegoed van ${amount}, voor wat er over was van je laatste betaling, gaat af van je volgende betalingen.`,
  paidNothing: "Er is vandaag niets afgeschreven.",
  fromNow: (price) => `Vanaf nu: ${price}.`,
  switchedOpen:
    "Wat het omvat, staat nu voor je open. Je ontvangstbewijzen staan op de pagina van je lidmaatschap, via de link op de pagina van de winkel.",
  switchedFooter: (store) =>
    `Afgeschreven door ${store} via de eigen Stripe-rekening. Vragen komen bij ${store} terecht als je op deze e-mail antwoordt.`,

  failedSubject: (store) => `Je betaling aan ${store} is niet gelukt`,
  hi: "Hallo,",
  failedFor: (amount, title) =>
    `De laatste betaling van ${amount} voor ${title} is niet gelukt. Dat gebeurt als een kaart verloopt, wordt vervangen of door de bank wordt geweigerd.`,
  failedTo: (amount, store) =>
    `De laatste betaling van ${amount} aan ${store} is niet gelukt. Dat gebeurt als een kaart verloopt, wordt vervangen of door de bank wordt geweigerd.`,
  payHere: "Betaal hem hier, met dezelfde kaart of een nieuwe:",
  cardKept: "De kaart waarmee je betaalt, wordt ook voor je volgende betalingen gebruikt, dus dit hoeft maar één keer.",
  triedAgainPlan: (date) => `Als je niets doet, wordt op ${date} opnieuw geprobeerd de opgeslagen kaart te belasten.`,
  triedAgain: (date) =>
    `Als je niets doet, wordt op ${date} opnieuw geprobeerd de opgeslagen kaart te belasten, en blijft je toegang tot die tijd open.`,
  notTriedAgain:
    "Er wordt niet opnieuw geprobeerd de opgeslagen kaart te belasten, dus deze betaling blijft openstaan tot ze via de link hierboven is betaald.",
  receiptsPlan: (url) => `Om je ontvangstbewijzen te bekijken of de kaart te wijzigen: ${url}`,
  cancelInstead: (url) => `Om in plaats daarvan op te zeggen, of je ontvangstbewijzen te bekijken: ${url}`,
  reminderSubject: (store) => `Herinnering: je betaling aan ${store} is nog steeds niet gelukt`,
  reminderLead: "Een korte herinnering, voor het geval je de eerste e-mail hebt gemist.",
  cardName: (brand, last4) => `${brand} eindigend op ${last4}`,
  cardSubject: (store) => `Je kaart voor ${store} verloopt vóór je volgende betaling`,
  cardFor: (card, title, date) =>
    `De kaart waarmee je ${title} betaalt, ${card}, verloopt vóór je volgende betaling, op ${date}.`,
  cardTo: (card, store, date) =>
    `De kaart waarmee je ${store} betaalt, ${card}, verloopt vóór je volgende betaling, op ${date}.`,
  cardHere: "Voeg je nieuwe kaart hier toe, zodat die betaling lukt:",
  cardHow: "Het duurt een minuut op de beveiligde pagina van Stripe. Er wordt nu niets afgeschreven, en de nieuwe kaart wordt vanaf dan voor deze betalingen gebruikt.",
  cardBank: "Als je bank je al een nieuwe kaart heeft gestuurd, neemt Stripe die misschien zelf over; hem hier toevoegen maakt het zeker.",
  cardTitle: "Werk je kaart bij",
  cardHead: (title) => `Werk de kaart voor ${title} bij`,
  cardHeadStore: (store) => `Werk de kaart bij waarmee je ${store} betaalt`,
  cardIntro: "Er wordt nu niets afgeschreven. De kaart die je toevoegt, wordt vanaf dan voor deze betalingen gebruikt.",
  cardPayNow: "Je laatste betaling is niet gelukt, dus die wordt meteen van de nieuwe kaart afgeschreven.",
  cardButton: "Nieuwe kaart toevoegen",
  cardNote: "Op de eigen beveiligde pagina van Stripe. De winkel ziet je kaartnummer nooit.",
  cardEnded: "Dit lidmaatschap is beëindigd, dus er is geen kaart om bij te werken.",
  cardNotices: {
    updated: { title: "Je kaart is bijgewerkt", body: "Je volgende betalingen gaan via de nieuwe kaart." },
    paid: { title: "Je kaart is bijgewerkt en je betaling is gelukt", body: "Ook je volgende betalingen gaan via de nieuwe kaart." },
    declined: {
      title: "Je nieuwe kaart is opgeslagen, maar de betaling is geweigerd",
      body: "Je volgende betalingen gaan via de nieuwe kaart. Stripe probeert de mislukte opnieuw, of je betaalt hem via de link in de e-mail erover.",
    },
    canceled: { title: "Er is niets gewijzigd", body: "Je hebt de pagina van Stripe verlaten voordat er een kaart was opgeslagen. Druk op de knop om het opnieuw te proberen." },
    expired: { title: "Deze link is verlopen", body: "Vraag op de pagina van je lidmaatschap een link aan; van daaruit kun je je kaart wijzigen." },
    error: { title: "Er ging aan onze kant iets mis", body: "Er is niets gewijzigd. Probeer het zo opnieuw." },
  },
};

const pt: MembershipWords = {
  yourMembership: "A sua subscrição",
  switchTitle: "Mudar a sua subscrição",
  endedTitle: "A sua subscrição terminou",
  nothingCharged: "Nada foi cobrado",

  manageNotices: {
    email: {
      title: "Isso não parece um endereço de email",
      body: "Verifique-o e tente novamente. Utilize o endereço com que paga: o que introduziu quando aderiu.",
    },
    limited: {
      title: "Demasiados pedidos por agora",
      body: "Para evitar que este formulário seja usado para inundar a caixa de entrada de alguém, aceita um número limitado de pedidos por hora. Tente novamente dentro de uma hora.",
    },
    unavailable: {
      title: "Esta loja não pode abrir subscrições neste momento",
      body: "Os pagamentos da loja não estão ligados à Stripe neste momento, por isso não há nenhuma subscrição para abrir a partir desta página. Responda ao email de confirmação da sua encomenda e a mensagem chega à loja.",
    },
    error: {
      title: "Algo correu mal do nosso lado",
      body: "Nada foi alterado. Tente novamente daqui a pouco.",
    },
    unconfirmed: {
      title: "Não conseguimos confirmar a mudança",
      body: "A resposta do Stripe não disse se ela foi feita. Veja a sua subscrição abaixo antes de tentar de novo: mostra o plano que tem agora.",
    },
    expired: {
      title: "Esta ligação expirou",
      body: "Uma ligação para a sua subscrição funciona durante uma hora. Peça uma nova abaixo; demora poucos segundos.",
    },
    used: {
      title: "Esta ligação foi usada demasiadas vezes",
      body: "Peça uma nova abaixo; demora poucos segundos.",
    },
    switched: {
      title: "A sua subscrição foi alterada",
      body: "O que o novo plano inclui já está disponível para si, e um recibo está a caminho da sua caixa de entrada.",
    },
    yearly: {
      title: "Agora paga anualmente",
      body: "O que a sua subscrição inclui mantém-se igual, e um recibo está a caminho da sua caixa de entrada.",
    },
    declined: {
      title: "O cartão não foi cobrado, por isso nada mudou",
      body: "O seu banco recusou o pagamento ou pediu um passo que não podíamos mostrar aqui. Atualize o seu cartão em “Alterar cartão ou ver recibos”, abaixo, e depois tente novamente a mudança.",
    },
    stale: {
      title: "Esse preço tinha mais de 15 minutos",
      body: "Nada foi alterado. Escolha novamente o plano para ver o preço atual.",
    },
    busy: {
      title: "Já estava em curso uma mudança",
      body: "Aguarde um momento e veja a sua subscrição abaixo antes de tentar novamente.",
    },
    currency: { title: "Esta subscrição mantém o plano atual", body: "É paga numa moeda diferente da dos planos atuais da loja, por isso mantém o plano atual. Nada foi alterado, e pode ainda cancelá-la na página da sua subscrição." },
    "cannot-switch": {
      title: "Essa mudança não pode ser feita",
      body: "O plano pode já não estar disponível, ou a subscrição pode estar cancelada ou à espera de um pagamento. Nada foi alterado.",
    },
  },
  manageHead: "Gerir ou cancelar a sua subscrição",
  manageIntro: (store) =>
    `Introduza o email com que paga a ${store} e enviamos-lhe por email uma ligação para a sua subscrição. Sem conta e sem palavra-passe: cancela-a por si, na própria página da Stripe.`,
  manageUnavailable: (store) =>
    `${store} não pode receber pagamentos através da Stripe neste momento, por isso não há nenhuma subscrição para abrir aqui. Responda ao email de confirmação da sua encomenda e a mensagem chega a ${store}.`,
  payEmailLabel: "O email com que paga",
  emailMeLink: "Enviar-me uma ligação para a minha subscrição",
  linkNote: (store, hours) =>
    `Se esse endereço tiver uma subscrição com ${store}, tentamos enviar-lhe uma ligação por email. Funciona durante ${hours === 1 ? "uma hora" : `${hours} horas`}. Dizemos o mesmo quer tenha quer não, para que ninguém possa usar esta página para descobrir quem é membro.`,
  checkInbox: "Verifique a sua caixa de entrada",
  sentBody: (store) =>
    `Se esse endereço tiver uma subscrição com ${store}, a ligação está a caminho. É enviada por ${store} através da Marktmorgen. Se não estiver lá, veja na pasta de spam.`,
  tryOther: "Não chegou nada? Talvez pague com outro endereço: o que introduziu quando aderiu. Experimente esse abaixo.",

  yourMemberships: "As suas subscrições",
  every: (interval, count) =>
    count === 1
      ? { day: "por dia", week: "por semana", month: "por mês", year: "por ano" }[interval]
      : `a cada ${count} ${{ day: "dias", week: "semanas", month: "meses", year: "anos" }[interval]}`,
  ends: (date) => `Termina a ${date}`,
  cancel: "Cancelar",
  switchPlan: "Mudar de plano",
  switchCurrencyNote: "Esta subscrição não pode mudar de plano: é paga numa moeda diferente da dos planos atuais da loja.",
  upgrade: " · plano superior",
  downgrade: " · plano inferior",
  exactFirst: "Vê o valor exato antes de qualquer cobrança.",
  cannotList:
    "A Stripe não conseguiu listar as suas subscrições neste momento. O botão abaixo abre-as todas na própria página da Stripe, onde pode cancelar.",
  changeCard: "Alterar cartão ou ver recibos",
  openMembership: "Abrir a minha subscrição",
  pause: {
    button: "Pausar em vez disso",
    choose: "Pausar durante",
    months: (n) => (n === 1 ? "1 mês" : `${n} meses`),
    confirm: "Pausar a minha subscrição",
    note: (date) =>
      `O que já pagou continua disponível até ${date}. Depois disso nada é cobrado e a subscrição fica fechada durante a pausa; recomeça sozinha, com um pagamento, no dia em que a pausa termina.`,
    pausedUntil: (date) => `Em pausa até ${date}`,
    startsPause: (date, until) => `Entra em pausa a ${date} e regressa a ${until}`,
    resume: "Retomar agora",
    resumeNote: "Ao retomar, é cobrado um pagamento hoje e a subscrição volta a abrir de imediato.",
    emailSubject: (title) => `A sua subscrição ${title} está em pausa`,
    emailBody: (title, store, from, until) =>
      `${title}: o que já pagou continua disponível até ${from}. Desse dia até ${until}, nada é cobrado e a subscrição está em pausa. A ${until}, recomeça sozinha, com o pagamento habitual.\n\nPara voltar mais cedo, ou para cancelar, abra a sua subscrição a partir da página de ${store}.`,
  },
  pauseNotices: {
    paused: { title: "A sua subscrição está em pausa", body: "Vai receber um e-mail com as datas." },
    resumed: { title: "A sua subscrição voltou a estar ativa", body: "O pagamento foi efetuado, e tudo o que inclui está de novo disponível para si." },
    cannot: {
      title: "Essa subscrição não pode ser pausada agora",
      body: "Nada foi alterado. Uma subscrição pode ser pausada uma vez por ano, se for paga todos os meses e estiver a funcionar normalmente.",
    },
    declined: {
      title: "O cartão não foi cobrado, por isso a subscrição continua em pausa",
      body: "Atualize o seu cartão com o botão abaixo e carregue novamente em Retomar agora.",
    },
  } as Record<string, Notice>,
  cancelNote: "Se cancelar, a subscrição mantém-se ativa até ao fim do período que já pagou, e não é cobrado mais nada.",

  leaveTitle: "Antes de sair",
  leaveHead: (title) => `Cancelar ${title}?`,
  leaveHeadPlain: "Cancelar a sua subscrição?",
  leaveIntro: (store) =>
    `Se disser a ${store} porquê, pode haver uma opção melhor para si mais abaixo. Responder é opcional: pode cancelar já.`,
  leaveAsk: "Porque está a sair?",
  leaveReasons: {
    too_expensive: "Custa demasiado",
    unused: "Não o uso o suficiente",
    missing_features: "Falta algo de que preciso",
    switched_service: "Mudei para outra coisa",
    too_complex: "É demasiado difícil de usar",
    low_quality: "A qualidade não é suficiente",
    customer_service: "Não tive ajuda quando pedi",
    other: "Outro motivo",
  },
  leaveContinue: "Continuar",
  leaveThanks: "Agradecemos que tenha dito o motivo.",
  leaveCheaper: "Um plano que custa menos:",
  leavePause: "Ou mantenha o seu lugar e faça uma pausa:",
  leavePauseOnly: "Mantenha o seu lugar e faça uma pausa:",
  leaveContact: (store) => `${store} gostaria de saber. Escreva-lhe, e o problema pode ser resolvido:`,
  leaveWrite: (store) => `Escrever a ${store}`,
  leaveStill: "Ainda quer sair?",
  leaveCancel: "Cancelar a minha subscrição",
  leaveConfirm: "Abre-se a página da Stripe, onde confirma.",
  leaveGone: "Esta subscrição não pode ser cancelada aqui: já terminou, ou o fim já está marcado.",

  nudgeSubject: (title) => `${title} continua aqui para si`,
  nudgeLead: (title) =>
    `Já passou algum tempo desde a última vez que voltou a ${title}. Tudo o que inclui continua lá para si, e pode retomar onde parou.`,
  nudgeCourse: "Abrir o curso:",
  nudgeCommunity: "Entrar na comunidade:",
  nudgeReply: (store) => `Se algo está a impedir, responda a este email e chega a ${store}.`,

  // ---- Pagar anualmente em vez de mensalmente -------------------------------------------------
  payYearly: (yearly, saving) => `Pagar anualmente: ${yearly}, poupa ${saving}`,
  yearlyHead: (title) => `Pagar ${title} anualmente`,
  yearlySaves: (amount) => `Poupa ${amount} por ano face a doze pagamentos mensais.`,
  yearlyDueNote: "O preço do ano, menos o que resta do mês que já pagou, no cartão com que paga. O seu próximo pagamento será daqui a um ano.",
  yearlyTrialNote: "Está no seu período de teste grátis. Nada é cobrado agora; o preço anual é cobrado quando o teste terminar.",
  yearlyHolds: (store) => `Este preço mantém-se durante 15 minutos. Cobrado por ${store} na sua própria conta Stripe. O que a sua subscrição inclui mantém-se igual.`,
  yearlySubject: (title) => `Agora paga ${title} anualmente`,
  yearlyNow: (store, title) => `A sua subscrição ${title} com ${store} passa a ser paga anualmente. O que inclui mantém-se igual.`,
  yearlyPaidCharged: (amount) => `Cobrado hoje: ${amount}, o ano menos o que restava do seu último pagamento mensal.`,
  yearlyPaidTrial: "Está no seu período de teste grátis, por isso nada foi cobrado. O preço anual é cobrado quando o teste terminar.",
  askSubject: (title, saving) => `${title}: pague anualmente e poupe ${saving}`,
  askLead: (store, title, monthly, yearly, saving) =>
    `Paga ${monthly} por ${title}. ${store} também o oferece anualmente: ${yearly}. São ${saving} a menos do que doze pagamentos mensais, e o que inclui mantém-se igual.`,
  askSee: "Veja exatamente quanto pagaria hoje, antes de qualquer cobrança:",
  askWorks: "A ligação funciona durante 14 dias e abre apenas esta alteração. Nada muda a menos que carregue no botão dessa página.",
  askReply: (store) => `Dúvidas? Responda a este email e chega a ${store}.`,

  switchProblems: {
    expired: { title: "Esta ligação expirou", body: "Uma ligação para a sua subscrição funciona durante uma hora. Peça uma nova na página da sua subscrição." },
    gone: {
      title: "Esta subscrição não pode mudar de plano",
      body: "Pode estar cancelada, programada para terminar, à espera de um pagamento, ou já não ser sua nesta ligação. Nada foi alterado.",
    },
    tier: {
      title: "Esse plano já não está disponível",
      body: "Volte à página da sua subscrição para ver os planos para os quais pode mudar agora. Nada foi alterado.",
    },
    currency: { title: "Esta subscrição mantém o plano atual", body: "É paga numa moeda diferente da dos planos atuais da loja, por isso mantém o plano atual. Nada foi alterado, e pode ainda cancelá-la na página da sua subscrição." },
    error: { title: "A Stripe não conseguiu calcular o preço neste momento", body: "Nada foi alterado. Tente novamente daqui a pouco." },
    yearly: { title: "O pagamento anual não está disponível para esta subscrição", body: "Pode já ser paga anualmente, ter um desconto, estar cancelada ou à espera de um pagamento, ou o preço anual pode ter mudado. Nada foi alterado." },
    yearlyExpired: { title: "Esta ligação expirou", body: "A ligação do email funciona durante 14 dias. Peça uma ligação para a sua subscrição na respetiva página; a partir daí pode pagar anualmente." },
  },
  switchTo: (title) => `Mudar para ${title}`,
  nowLabel: "Agora",
  afterLabel: "Depois da mudança",
  nothingNow: "Não é cobrado nada agora",
  chargedToday: (amount) => `Cobrado hoje: ${amount}`,
  offNext: (amount) => `Descontado nos seus próximos pagamentos: ${amount}`,
  nothingToday: "Não é cobrado nada hoje",
  switchTrialNote: "Está no seu período de teste grátis. O novo plano abre agora, e o seu preço começa quando o teste terminar.",
  dueNote: "O novo preço, menos o que restava do seu último pagamento, no cartão com que paga. O novo plano abre assim que for pago.",
  creditNote: "O que restava do seu último pagamento passa a ser um crédito na loja, descontado nos seus próximos pagamentos. O novo plano abre agora.",
  opensNow: "O novo plano abre agora.",
  switchAndPay: (amount) => `Mudar e pagar ${amount}`,
  switchNow: "Mudar agora",
  holdsNote: (store, title) =>
    `Este preço mantém-se durante 15 minutos. Cobrado por ${store} na própria conta Stripe. Tudo o que só ${title} inclui fecha quando mudar.`,
  backToMembership: "Voltar à sua subscrição",

  offerNotices: {
    member: "Já tem uma subscrição disto que ainda está ativa, por isso a oferta não foi usada. Não foi cobrado nada.",
    price: "A loja já não oferece o preço a que esta oferta se referia, por isso não pode ser usada. Não foi cobrado nada.",
    expired: "Esta oferta terminou. Ainda pode voltar ao preço habitual, abaixo.",
    unavailable: "Esta oferta já não pode ser usada nesta subscrição. Ainda pode voltar ao preço habitual, abaixo, se estiver disponível.",
    refused: "Não foi possível aplicar a oferta neste momento. Pode voltar ao preço habitual, abaixo, ou responder ao email em que ela chegou.",
    limited: "Demasiadas tentativas por agora. Aguarde alguns minutos e carregue novamente no botão.",
  },
  membershipLabel: "Subscrição",
  endedBody: (title) =>
    `A sua subscrição de ${title} já não está ativa, por isso aquilo a que lhe dava acesso está agora fechado. Renove-a e tudo volta a abrir de imediato.`,
  endedClosed: (title) =>
    `A sua subscrição de ${title} já não está ativa, por isso aquilo a que lhe dava acesso está agora fechado.`,
  endedGone: (store) => `Esta subscrição já não está ativa, e ${store} já não a disponibiliza.`,
  comeBackOffer: "A sua oferta de regresso",
  offerWords: (percent, months) =>
    months === 1 ? `${percent}${S}% de desconto no seu primeiro pagamento` : `${percent}${S}% de desconto nos seus primeiros ${months} pagamentos`,
  offerFor: (email, until) =>
    `Para ${email}, até ${until}. Aplicada na página da Stripe antes de pagar; desta vez sem teste grátis.`,
  comeBackWith: "Voltar com esta oferta",
  renewTitle: (title) => `Renovar ${title}`,
  renewPrice: (price) => `Renovar · ${price}`,
  renew: "Renovar",
  notTaking: (store) =>
    `${store} não está a aceitar novos membros para isto neste momento. Responda ao email de confirmação da sua encomenda e a mensagem chega a ${store}.`,
  see: (title) => `Ver ${title}`,
  seePrices: (title) => `Ver os preços de hoje de ${title}`,
  failedBefore: "Terminou porque um pagamento falhou, e não porque cancelou? Atualizar o cartão pode reativá-la sem renovar: ",
  failedLink: "gira a sua subscrição",
  failedAfter: " com o email com que pagou.",
  boughtBefore: "O que comprou à parte continua a ser seu: ",
  boughtLink: "volte a obter as suas compras",
  boughtAfter: ".",

  leftNotices: {
    email: {
      title: "Isso não parece um endereço de email",
      body: "Verifique-o e tente novamente. O lembrete vai para o endereço que introduzir, por isso tem de ser um que consiga abrir.",
    },
    limited: {
      title: "Demasiados lembretes pedidos neste momento",
      body: "Para evitar que este formulário seja usado para encher a caixa de entrada de alguém, aceita um número limitado por hora. Nada foi guardado. O produto continua aqui sempre que o quiser.",
    },
    closed: {
      title: "Não é possível enviar um lembrete para isto",
      body: "Pode ter esgotado ou ter sido retirado de venda. Nada foi guardado.",
    },
    error: {
      title: "Não conseguimos guardar isso neste momento",
      body: "Nada foi guardado. Tente novamente daqui a pouco.",
    },
  },
  done: "Feito",
  oneReminder: "Um lembrete, dentro de cerca de uma hora",
  willEmail: (store, title) =>
    `${store} vai enviar-lhe um único email, com a ligação para ${title}. Se o comprar antes disso, não é enviado nenhum lembrete.`,
  onlyEmail:
    "É o único email que isto envia. Não o adiciona a nenhuma lista, e tem uma ligação que acaba de vez com os lembretes desta loja.",
  leftBefore: (title) => `Saiu antes de pagar ${title}`,
  notCharged: "O seu cartão não foi cobrado. Se ainda o quiser, está à distância de um clique.",
  notReady: "Ainda não se decidiu?",
  remindNote: (store) =>
    `Deixe o seu email e ${store} envia-lhe um lembrete com a ligação, dentro de cerca de uma hora. Um único email. Não o adiciona a nenhuma lista.`,
  remindMe: "Lembrar-me uma vez",
  addressUse: (store) =>
    `O seu endereço é usado para este único lembrete e para a ligação nele que acaba com os lembretes de ${store}, e para mais nada.`,
  // ---- A reminder asked for on a product's page (lib/ask-when.ts) -------------------------------
  askWhen: "Quando",
  askTimes: { hour: "Daqui a cerca de uma hora", day: "Amanhã", days: "Daqui a três dias" },
  pageRemindNote: (store) =>
    `Deixe o seu email e ${store} envia-lhe um único lembrete com a ligação, quando escolher. Um só email. Não o adiciona a nenhuma lista.`,
  /** When the reminder goes, as said in the middle of a sentence (pageAsked). */
  askSaid: { hour: "daqui a cerca de uma hora", day: "amanhã", days: "daqui a três dias" },
  pageAsked: (store, title, when) => `${store} vai enviar-lhe um único email com a ligação para ${title} ${when}. Se o comprar antes, não é enviado nenhum lembrete.`,

  fromName: (store) => `${store} via Marktmorgen`,
  membershipWith: (store) => `A sua subscrição com ${store}`,
  linkIntro: (store) => `Pediu para gerir a sua subscrição com ${store}. Eis a forma de entrar:`,
  linkTiers:
    "Abra a ligação para ver a sua subscrição. A partir daí, pode mudar para outro plano, vendo o valor exato antes de qualquer cobrança, ou cancelá-la, alterar o cartão com que é paga ou ver os seus recibos. Se cancelar, mantém-se ativa até ao fim do período que já pagou, e não é cobrado mais nada.",
  linkNoTiers:
    "Abra a ligação e carregue no botão. A Stripe mostra-lhe então a sua subscrição: pode cancelá-la, alterar o cartão com que é paga ou ver os seus recibos. Se cancelar, mantém-se ativa até ao fim do período que já pagou, e não é cobrado mais nada.",
  linkWorks: "A ligação funciona durante uma hora. Se não pediu isto, ignore este email; nada acontece a menos que a ligação seja usada.",
  linkFooter: (store) =>
    `Enviado pela Marktmorgen em nome de ${store}. A subscrição é cobrada por ${store} na própria conta Stripe.`,

  switchedSubject: (title) => `Mudou para ${title}`,
  switchedNow: (store, title, from) => `A sua subscrição com ${store} é agora ${title}, em vez de ${from}.`,
  paidTrial: "Está no seu período de teste grátis, por isso nada foi cobrado. O novo preço começa quando o teste terminar.",
  paidCharged: (amount) => `Cobrado hoje: ${amount}, o novo preço menos o que restava do seu último pagamento.`,
  paidCredit: (amount) => `Um crédito de ${amount}, pelo que restava do seu último pagamento, é descontado nos seus próximos pagamentos.`,
  paidNothing: "Nada foi cobrado hoje.",
  fromNow: (price) => `A partir de agora: ${price}.`,
  switchedOpen:
    "O que inclui já está disponível para si. Os seus recibos estão na página da sua subscrição, a partir da ligação na página da loja.",
  switchedFooter: (store) =>
    `Cobrado por ${store} na própria conta Stripe. As perguntas chegam a ${store} se responder a este email.`,

  failedSubject: (store) => `O seu pagamento a ${store} não foi concluído`,
  hi: "Olá,",
  failedFor: (amount, title) =>
    `O último pagamento de ${amount} por ${title} não foi concluído. Isto acontece quando um cartão expira, é substituído ou é recusado pelo banco.`,
  failedTo: (amount, store) =>
    `O último pagamento de ${amount} a ${store} não foi concluído. Isto acontece quando um cartão expira, é substituído ou é recusado pelo banco.`,
  payHere: "Pague-o aqui, com o mesmo cartão ou com um novo:",
  cardKept: "O cartão com que pagar é usado também nos seus próximos pagamentos, por isso só tem de fazer isto uma vez.",
  triedAgainPlan: (date) => `Se não fizer nada, a cobrança no cartão registado será tentada novamente a ${date}.`,
  triedAgain: (date) =>
    `Se não fizer nada, a cobrança no cartão registado será tentada novamente a ${date}, e o seu acesso mantém-se entretanto.`,
  notTriedAgain:
    "A cobrança no cartão registado não será tentada novamente, por isso este pagamento fica por pagar até ser pago a partir da ligação acima.",
  receiptsPlan: (url) => `Para ver os seus recibos ou alterar o cartão: ${url}`,
  cancelInstead: (url) => `Para cancelar, em alternativa, ou ver os seus recibos: ${url}`,
  reminderSubject: (store) => `Lembrete: o seu pagamento a ${store} ainda não foi concluído`,
  reminderLead: "Um breve lembrete, caso o primeiro email lhe tenha escapado.",
  cardName: (brand, last4) => `${brand} terminado em ${last4}`,
  cardSubject: (store) => `O seu cartão para ${store} expira antes do próximo pagamento`,
  cardFor: (card, title, date) =>
    `O cartão com que paga ${title}, ${card}, expira antes do seu próximo pagamento, a ${date}.`,
  cardTo: (card, store, date) =>
    `O cartão com que paga a ${store}, ${card}, expira antes do seu próximo pagamento, a ${date}.`,
  cardHere: "Adicione aqui o seu novo cartão, para que esse pagamento seja concluído:",
  cardHow: "Demora um minuto na página segura da Stripe. Nada é cobrado agora, e o novo cartão passa a ser usado nestes pagamentos a partir daí.",
  cardBank: "Se o seu banco já lhe enviou um cartão novo, a Stripe pode recebê-lo por si só; adicioná-lo aqui dá-lhe a certeza.",
  cardTitle: "Atualize o seu cartão",
  cardHead: (title) => `Atualize o cartão de ${title}`,
  cardHeadStore: (store) => `Atualize o cartão com que paga a ${store}`,
  cardIntro: "Nada é cobrado agora. O cartão que adicionar passa a ser usado nestes pagamentos a partir daí.",
  cardPayNow: "O seu último pagamento não foi concluído, por isso é cobrado de imediato no novo cartão.",
  cardButton: "Adicionar um cartão novo",
  cardNote: "Na própria página segura da Stripe. A loja nunca vê o número do seu cartão.",
  cardEnded: "Esta subscrição terminou, por isso não há cartão para atualizar.",
  cardNotices: {
    updated: { title: "O seu cartão está atualizado", body: "Os seus próximos pagamentos usam o novo cartão." },
    paid: { title: "O seu cartão está atualizado e o pagamento foi concluído", body: "Os seus próximos pagamentos também usam o novo cartão." },
    declined: {
      title: "O seu novo cartão está guardado, mas o pagamento foi recusado",
      body: "Os seus próximos pagamentos usam o novo cartão. A Stripe volta a tentar o que falhou, ou pode pagá-lo a partir do link no email sobre ele.",
    },
    canceled: { title: "Nada foi alterado", body: "Saiu da página da Stripe antes de guardar um cartão. Prima o botão para tentar de novo." },
    expired: { title: "Este link expirou", body: "Peça um link para a sua subscrição na página dela; a partir daí pode alterar o seu cartão." },
    error: { title: "Algo correu mal do nosso lado", body: "Nada foi alterado. Tente de novo dentro de momentos." },
  },
};

export const MEMBERSHIP_WORDS: Record<LanguageCode, MembershipWords> = { en, es, fr, de, it, nl, pt };

/** A store's words for its members, in its language; English for anything else. */
export function membershipWords(language: unknown): MembershipWords {
  return MEMBERSHIP_WORDS[parseLanguage(language)];
}
